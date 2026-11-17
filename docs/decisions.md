# Decisions

Short record of the choices that shape this pipeline, newest last.

## 1. Read the county's public ArcGIS layers, paged by ObjectID range

Each page is an independent request (`OBJECTID >= a AND OBJECTID < b`). Pages run in
parallel, can be retried alone, and the request URL is stored on every row as its
provenance. Result offsets were rejected: a page's content would depend on the pages
before it.

## 2. Change detection by content hash, per record key

The source layers carry no per-row change timestamp. Each row is hashed over its source
attributes (ObjectID excluded, since the publisher may renumber it). A run compares hashes
against the previous snapshot and records added, changed and removed keys.

A partial run (bounded pilot) only upserts. It never reports removals, because a record
missing from a partial capture proves nothing.

## 3. DuckDB as a local working store; nothing hosted

The store is one file. It holds the latest snapshot per source and the run history.
Published artifacts will be Parquet on IPFS, so no database server is needed to query them.

## 4. Record keys

| Source | Key | Why |
|---|---|---|
| properties | `FOLIO` | The county's parcel identifier, kept as text. 5,830 source rows have none and are excluded and counted. |
| permits | `PermitNumber` | Unique across all 489,896 rows. |
| contractors | `CONTRACTOR_NUMBER`, `TRADESMEN_NAME`, `TRADE_CLASS` | The table has one row per contractor, tradesman and trade class. The licence number alone collapsed 278 rows; this key collapses 2. |

## 5. Follow the assignment README where it differs from the team kit

The kit's Oracle skills publish only lexicon archives registered in Atlas, which needs a
Prism code-owner merge. The README asks for a manifest of query tables, coverage and
indexes retrievable by CID from public gateways. This pipeline implements the README.
Lexicon-format output is a possible later addition, not the publication path.

## 6. Source access rules are hard limits

Sources are read only through public, documented endpoints, within robots.txt. A 403 or a
challenge page stops that source and is recorded as a limitation. No block is evaded.

## 7. Permit status is derived, and named for what the dates support

The county table has no status column. `status` is one of `closed_certificate`,
`last_inspection_approved`, `last_inspection_not_approved`, `no_inspection`. A permit is
treated as open in the last two cases. "Last inspection approved" is not proof of a final
inspection, so the UI and agent show the derived label, not the word "closed".

## 8. Roof year: a completed roof permit beats year built; otherwise unknown

`roof_basis` records which was used. A roof permit counts only when it is a re-roof or a
new-construction roof and its status is approved or certified; an open permit never sets
the roof year. Year built of 0 or a placeholder such as 9999 is treated as not recorded.
Because county permits start in 2020, most roof years rest on year built: that is a proxy
and is labelled as one.

## 9. No column depends on today's date

Roof age and days open are computed at query time from `roof_year` and `issued_date`.
Identical source data therefore produces byte-identical tables, and a new published CID
always means the data changed.

## 10. Reconciliation is by official identifier or exact match only

Properties by folio, permits by permit number, contractors by the licence number printed
on the permit (name variants are counted, not merged), owners by exact name plus mailing
address. Near-matches such as "USA" and "U S A" stay separate: merging them would be a guess.

## 11. Content IDs are computed locally, before any upload

`npm run snapshot` builds the IPFS directory DAG itself (CIDv1, raw leaves, the same
settings as `ipfs add --cid-version=1`) and writes it to one CAR file. The upload is then
a block transfer that any node can check. Verified against a reference Kubo 0.43.1 node
running offline: it imported the CAR, pinned the same root, and independently computed the
same CID for every file, the directory, the CAR and the manifest.

A table that did not change keeps its CID from one snapshot to the next; only `coverage.json`
(which carries the snapshot time) and the directory root differ. This required replacing
`any_value()` in the model with `min()`: the arbitrary pick made two builds of identical
data produce different Parquet files.

## 12. The manifest is published beside the snapshot, not inside it

The manifest names the root directory's CID, so it cannot live under that root. It is its
own file with its own CID, recorded in `publications/` in Git along with the previous
snapshot's manifest and root CIDs.

## 13. Pipeline state is published, so a run needs no machine of ours

Deltas are computed against `key_state_<source>` (record key and content hash), not the
previous full rows. Each snapshot carries those tables plus the change log and run history
under `state/`. `npm run restore` loads them into an empty store, and the next run reports
the same deltas it would have on the original machine. This is what lets a scheduled job on
a fresh runner be incremental with no hosted database.

## 14. Every listed CID is pinned as its own root

A pinning node announces the root of each upload, not the blocks inside it. A file reachable
only by path under the snapshot directory may not be found by its own CID on the public
network. So each file, the CAR file and the manifest are also uploaded as single-root CARs,
keyed by CID (an unchanged artifact is never uploaded twice).

## 15. Which gateways count as independent retrieval

The README's example gateways, `ipfs.io` and `dweb.link`, now answer plain HTTP requests
with 429 and a notice that they serve only through an in-browser service worker, so they
cannot be used for a scripted byte check. Retrieval is verified against a configurable list
of other public gateways not operated by us or by the pinning vendor (`src/gateways.ts`).
The pinning vendor's own gateway is recorded but never counts toward the required two.
Every attempt, including failures, is saved in `publications/<snapshot>/retrieval.json`.

A snapshot is added to `publications/index.json` only when every listed CID was fetched
from two independent gateways with matching size and SHA-256.

## 16. `fetched_at` is when this version of a record was captured

A record that did not change keeps the capture time of the run that first saw its current
content. Stamping every row with the latest run's time made a re-read of identical data
produce different files and a new CID for every table. When each source was last re-read
is in the run history, not on the rows. Verified with two full back-to-back ingests: every
data table kept its CID; only the run history and coverage files changed.

## 17. One tool catalogue for the page's agent and the MCP endpoint

`web/lib/tools.ts` defines each capability once: name, description, Zod input schema and a
`run` function that calls the shared query layer. The agent (Vercel AI SDK) and `/api/mcp`
(Streamable HTTP) both register that same list, so they cannot give different answers.

The model decides which tools to call and words the reply. Every count and record comes from
SQL over the snapshot, and the tool calls (input, SQL, snapshot ID, rows) are returned beside
the answer so it can be checked against the records.

## 18. Outside SQL is guarded twice

`query_sql` lets an agent or MCP client run its own query. Two independent guards:
DuckDB's parser must report exactly one statement of type SELECT, and the engine is locked
before any request reaches it (`allowed_directories` = the snapshot folder,
`enable_external_access = false`, `lock_configuration = true`). Tested: reading other
files, fetching URLs, loading extensions, attaching databases and changing settings are all
refused. A write into the snapshot folder would pass the engine lock, which is why the
statement-type check is not optional.

## 19. Agent model: the one that answers on the free tier

Measured against the Gemini API with a free key: the newest flash models timed out or
returned "high demand" errors, `gemini-3.5-flash` took 8 to 16 seconds per call and
`gemini-3.5-flash-lite` about one second. The agent tries flash-lite, then flash, each with
a 50-second limit and no silent retries, and returns a plain error if both fail. The model
list is an environment variable (`AGENT_MODELS`).

Revised on 2026-11-17 after repeated failures during testing: flash-lite reported "high
demand" and `gemini-3.5-flash` hung until its limit. Every free model the key can call was
timed on a real tool-calling question. The chain is now flash-lite, `gemini-3-flash-preview`,
then `gemini-3.5-flash`; an attempt is abandoned after 40 seconds; and the list is tried up
to twice inside a 100-second budget, so the function's 120-second limit is never hit. A free
tier can still be busy on every model at once; the page then says so and the search tools
keep working.

## 20. Property results are one row per street address

A condo building is one roof. Listing each unit put 88 rows for one address at the top of an
"oldest roofs" search. Results now return one row per address with the number of matching
units; the total still counts properties.

## 21. A run that finds no change publishes nothing

Identical data must not get a new CID, and each published snapshot costs about 320 MB of a
5 GB free quota. After the sources are re-read, `npm run record-check` sums the added,
changed and removed records since the latest published snapshot. If the sum is zero, the
check is appended to `publications/checks.json` and no snapshot is built. Only a real change
produces a new snapshot. The page shows both: publications and no-change checks.

The one exception so far is the third snapshot. It carries no source change; it was
published because the pipeline's own state format changed (decision 16 added a capture time
to the key state), and scheduled runs need to restore from a snapshot that has it.

## 22. The runtime is one Lambda function, defined in CDK

`infra/` holds a single CDK stack: a Lambda function built from `web/Dockerfile` (2 GB,
x86_64, 120-second timeout, 1 GB of scratch space), a public function URL, a log group kept
for one week, and an IAM policy with one statement, `ssm:GetParameter` on one parameter.
There is no API Gateway, VPC, database or queue, so nothing runs or bills while idle.

- **Container image with the Lambda Web Adapter.** The Next.js server runs unchanged; the
  adapter translates Lambda invocations to HTTP. The image is built on Linux, so DuckDB's
  Linux binary and shared library are the ones packaged.
- **Standard Lambda, not Lambda Web Functions.** The newer service is arm64-only and allows
  10 seconds to start; a cold start here downloads about 110 MB of tables from IPFS.
- **The model key is an encrypted SSM parameter**, read once per warm instance. It is not in
  the function's environment, the template or the repository.
- **The framework's disk cache is replaced by a five-minute in-memory cache**, because
  Lambda's filesystem is read-only outside `/tmp`.
- **Public by design.** The assignment needs a runtime anyone can open. The data is public
  record, inputs are validated, and outside SQL is limited as in decision 18.

Tested before deploying by running the image locally with a read-only filesystem and a
non-root user, then on the deployed function: page, API, MCP, live verification and agent.

## 23. State licences come from DBPR's published file, joined by exact licence number

Florida DBPR publishes its construction licensee file as public record with a documented
column layout. It is a second kind of source (`kind: "csv"`): one request for the whole
file, rows hashed and compared like any other source. If a row does not have the documented
number of columns the run stops, because shifted columns would corrupt every field.

- **Join:** the licence number printed on a permit equals DBPR's "Alternate Lic#". Only an
  exact match counts. 1,917 of 2,237 roofing contractors match, covering 74,124 of 85,385
  roofing permits.
- **What a miss means:** the file omits null and void, delinquent and involuntarily inactive
  licences. "Not in the state licence file" is shown as exactly that, not as "unlicensed".
- **Business records:** about half the file is qualified-business registrations with a name
  and address but no licence number. They are published as the `business` table. A contractor
  whose name equals a qualified business's name is flagged as a name match only.
- **Key:** licences have a number; qualified businesses do not, so name, address and original
  date are part of the key. The first attempt keyed on the number alone and collapsed 128,990
  business rows into one.

## 24. BBB: profile links from the published sitemaps, no ratings

BBB's robots.txt permits profile pages and lists sitemaps of them. A test request for one
profile page came back HTTP 403 with a Cloudflare challenge. The rule for this pipeline is
to stop on a refusal and not work around it, so profile pages are not read and **no rating,
accreditation or complaint data is loaded**. Archived copies were not used either.

What the sitemaps do give, with no refusal, is the list of profiles that exist: name (as
spelled in the address), city, category and the profile address. That is a third kind of
source (`kind: "bbb_sitemap"`).

- **Reading:** the index lists about 580 files ordered by BBB chapter number. A binary search
  finds the files holding the Southeast Florida chapter (0633), so a run makes about 22
  requests, one second apart. If a file is out of order the run stops.
- **Link:** a contractor is linked to a profile when exactly one profile's name equals the
  name on its permits or its state business name, ignoring punctuation and a trailing Inc,
  LLC or Corp. Two or more profiles with the name link nothing. `bbb_profile_matched_on`
  says which name matched.
- **Result:** 6,575 of 17,166 contractors linked; 914 of 2,237 roofing contractors, covering
  36,484 of 85,385 roofing permits. 74 contractors have an ambiguous name and are left unlinked.
- **What it is called:** "BBB profile (name match)", never a rating. A user opens the link
  to read the rating on BBB's own page.
- **Trade-off:** a name match can be wrong (two firms with one name, one of them without a
  profile). The state licence join, by exact number, stays the contractor-quality signal.

## 25. A publisher reload is not a change, and an empty read is not a removal

Found on 2026-11-17, the first time the scheduled run met a county reload. The county had
reloaded its permit table and was part-way through reloading its contractor table. The run
did two wrong things, and snapshot `20261117T152027Z` records both:

- **All 489,896 permits were reported as changed.** Their content was identical. The reload
  had given every row a new `GlobalID`, and that field was part of the content hash.
  Fix: fields of ArcGIS type GlobalID are left out of the hash, as ObjectID already was.
  Cost: the next run reports every permit as changed once more, because the hash rule itself
  changed. After that a reload with no content change produces no deltas and no new CID.
- **22,279 contractor records were reported as removed**, because the layer was empty at
  that moment. Fix: a full read that returns nothing, or under half the records already
  known, is refused for that source only. The refusal is written to the run history, the
  source's previous rows and state are kept, and the other sources are still read, so one
  publisher's maintenance does not stop the pipeline. The threshold is a
  judgement: a licence table does not lose half its rows overnight.

The snapshot was left in the history, not withdrawn. Publication history is append-only, and
its run table shows exactly what the publisher returned. Until the county finishes its
reload, that snapshot has no county licence status on contractors; state licence standing
from DBPR is unaffected.

## 26. Publication history after submission is kept on its own branch

The scheduled run records every publication and every no-change check in `publications/`.
Writing those to the code branch would add a bot commit to this pull request every day. From
this commit on, the run reads and writes `publications/` on the `ingest-history` branch of the
same repository, and the live page reads the history from there. `publications/` on the code
branch is the record as it stood at submission (seven snapshots); later snapshots and checks
appear on the live page and on that branch.

