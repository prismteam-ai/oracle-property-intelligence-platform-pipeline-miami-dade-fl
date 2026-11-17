# Miami-Dade Oracle pipeline: submission

**Live runtime:** https://pkvjvwftv5xgocgck3akhh4qmq0ufdpe.lambda-url.us-east-2.on.aws/ (AWS Lambda in us-east-2, public, no login)

A second copy of the same build runs at https://miami-dade-oracle.vercel.app.

**Demo video:** https://github.com/jacksonkr/oracle-property-intelligence-platform-pipeline-miami-dade-fl/releases/download/demo-video-2026-11-17/miami-dade-pipeline-demo.mp4 (4 min 29 s; on-screen captions, no narration; recorded by script against the live site on 2026-11-17, played at 1.2x)

The assignment is in [`README.md`](./README.md). This file explains what was built, how to
check it, and where it falls short. Decisions and their reasons are in
[`docs/decisions.md`](./docs/decisions.md).

## What it does

It reads Miami-Dade County's public property, permit and contractor records, loads them into
DuckDB, derives a roofing-lead model, and publishes each snapshot to IPFS as content-addressed
Parquet files with a manifest. A hosted page, an agent and an MCP endpoint all query those
published files. The runtime is a single AWS Lambda function defined in CDK. Nothing runs
between requests: no database server, no queue, no VM.

```
County ArcGIS layers ──▶ ingest (hash per record, deltas per run) ──▶ DuckDB working store
                                                                          │
                              snapshot: Parquet tables + state + manifest + CAR  (CIDs computed locally)
                                                                          │
                              publish: pin on IPFS, fetch every CID from two independent gateways
                                                                          │
                 publications/ in Git  ◀── manifest + retrieval evidence ──┘
                          │
   Lambda function ── reads the record from Git, the tables from IPFS by CID ──▶ DuckDB in the function
        ├── map and radius search        ┐
        ├── agent (Vercel AI SDK)        ├── one query layer, one tool catalogue
        └── MCP endpoint /api/mcp        ┘
```

`publications/` in this branch holds the manifests and retrieval records as they stood at
submission. The daily run keeps recording later snapshots and checks on the
[`ingest-history`](https://github.com/jacksonkr/oracle-property-intelligence-platform-pipeline-miami-dade-fl/tree/ingest-history/publications)
branch, which is what the live page shows (decision 26).

## What is loaded

Counts in this file are from snapshot `20261117T151031Z`. The live page shows the current
snapshot's counts, which move by a small amount with each run (for example 491,387 permits in
snapshot `20261117T152027Z`).

| Table | Rows | Source |
|---|---|---|
| property | 938,567 | Property Appraiser roll: site address, owner, mailing address, year built, last sale, coordinates |
| permit | 489,896 | County building permits, 2020-01-01 onward: type, dates, folio, contractor, inspections |
| contractor | 17,166 | One per licence number printed on permits, joined to the county contractor table and to Florida DBPR state licences (11,304 matched by exact number), with a link to the one BBB profile of the same name where there is exactly one (6,575) |
| business | 128,906 | Florida DBPR qualified-business registrations (12,885 in Miami-Dade): name, address, standing |
| owner | 797,385 | Distinct owner name and mailing address |
| place | 34 | City centres derived from the roll, for "near a city" questions |

Every row carries `source_url` (the exact public request that returned it) and `fetched_at`.

## Acceptance criteria: where each one stands

| Criterion | Status | Where to see it |
|---|---|---|
| Miami-Dade as the default county | Met | Live page; `src/catalog.ts` |
| Property records | Met: 938,567 | Run summary |
| Permit records, roofing emphasis | Partly: county building department only, from 2020. 85,385 roofing permits | Run summary, documented limits |
| Permit status, dates, open duration | Met, with a caveat: the county publishes no status, so it is derived from inspection and certificate dates and labelled as derived | Explorer, decision 7 |
| Ownership records | Met: owner and mailing address on every property; 797,385 distinct owners | Explorer |
| Contractor records | Met for contractors named on permits. State licence standing, activity and expiry are joined by exact licence number: 1,917 of 2,237 roofing contractors, covering 74,124 of 85,385 roofing permits | Explorer, permits tab; decision 23 |
| BBB ratings | **Ratings not loaded; profile links only.** BBB's profile pages answer automated requests with a 403 challenge, so they are not read. From BBB's published sitemaps, 914 of 2,237 roofing contractors (36,484 of 85,385 roofing permits) are linked by name to their BBB profile page, where a person can read the rating | Explorer, permits tab, BBB column; decision 24 |
| Business records | Met in part: 128,906 DBPR qualified-business registrations. The Sunbiz corporate registry is not loaded | `business` table through MCP `query_sql` |
| Coordinates | Met: 100% of properties | Run summary |
| Roof age or proxy, configurable threshold | Met: completed roof permit, else year built, else unknown; basis shown on every row | Explorer, decision 8 |
| Reconcile duplicates | Met by official identifier only (folio, permit number, licence number); near-matches are not merged. The entity browser shows the result: one contractor per licence number with its name spellings counted, one owner per exact name and mailing address | "Browse entities and relationships"; decision 10 |
| Source provenance | Met: per row | Any result row, "county record" link |
| Incremental ingestion | Met: per-record content hash, added/changed/removed per run, state restored from the last snapshot on a clean machine | Run history; `.github/workflows/ingest.yml` |
| Visible run history | Met | "Records by source" on the live page |
| Ingestion over time | In progress: a daily scheduled run. Runs so far found no change, which is recorded without publishing a new snapshot | `publications/checks.json` |
| Slow or constrained sources documented | Met | "Sources and their limits" below |
| No standing infrastructure cost | Met: one on-demand Lambda function, free pinning tier, free CI minutes. The only thing running while idle is an optional five-minute keep-warm schedule, inside the free allowance and removable with one setting | "Cost" below |
| IPFS for artifacts, CIDv1 | Met | Manifest on the live page |
| DuckDB for querying | Met | Query layer section; every result shows its SQL |
| MCP access | Met: `/api/mcp`, nine tools (place lookup, property and permit search, one property, contractor search, one contractor, owner search, dataset description, read-only SQL) | MCP section |
| Agent access | Met | "Ask the agent" |
| UI | Met | Live page |
| Manifest per run with CID, name, size, codec, digest | Met | `publications/<snapshot>/manifest.json` |
| IPNS | Not used; the Git record names each snapshot's CIDs | Decision 12 |
| Prior CIDs immutable, history retained | Met | Publication history |
| CAR for directory artifacts | Met: one CAR per snapshot, pinned and listed in the manifest | Manifest |
| Each CID from two independent public gateways | Met at publish time and re-checkable live. `ipfs.io` and `dweb.link` no longer serve plain downloads, so other gateways are used | `publications/<snapshot>/retrieval.json`, decision 15 |
| Radius queries, roofs over N years, open roofing permits, contractor | Met, including a filter on the contractor's state licence standing | Explorer, agent |
| Not sold in 10+ years; out-of-area owners | Met in the UI ("Not sold for at least" and "Owner's mailing address is outside the county"), the agent, MCP and API | Explorer filters; agent example 3 |

## Demo walkthrough

Each step of the assignment's demo transcript, on the live page:

1. **Pipeline run summary:** top of the page: snapshot, counts, coverage, documented limits.
2. **Records by source:** the sources table and run history, with collection times and endpoints.
3. **DuckDB query layer:** the "DuckDB query layer" section; any search shows its SQL and timing.
4. **Artifact manifest:** the manifest table with CID, size, codec and SHA-256 for every artifact.
5. **Retrieve by CID from two gateways:** press "Verify now" on any artifact, or run the command below.
6. **A later publish has a new CID:** "Publication history": each snapshot, its CIDs and its predecessor.
7. **Roofs older than 15 years in a radius:** "Explore the data": pick a city or click the map, then search.
8. **Open roofing permits, longest open first, with contractor:** the second tab of the same search.
9. **Agent questions:** "Ask the agent": the first two examples are the transcript's prompts.
10. **MCP-ready:** the "MCP endpoint" section, with a copyable command.

## Check it yourself

Fetch an artifact by CID from two gateways and compare it with the manifest:

```bash
# CIDs for the latest snapshot are in publications/index.json and its manifest.json
CID=<any file CID from the manifest>
curl -sL https://gateway.pinata.cloud/ipfs/$CID | sha256sum
curl -sL https://eu.orbitor.dev/ipfs/$CID       | sha256sum
```

Import the whole snapshot into any IPFS node, with no gateway and no re-encoding:

```bash
ipfs dag import snapshot.car     # pins the snapshot root named in the manifest
```

Query the published Parquet directly with DuckDB:

```sql
SELECT roof_basis, count(*) FROM read_parquet('https://ipfs.filebase.io/ipfs/<root cid>/tables/property.parquet') GROUP BY 1;
```

Call the MCP endpoint:

```bash
curl -s https://pkvjvwftv5xgocgck3akhh4qmq0ufdpe.lambda-url.us-east-2.on.aws/api/mcp \
  -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"query_sql","arguments":{"sql":"SELECT count(*) FROM permit WHERE is_roofing AND is_open"}}}'
```

## Run the pipeline

Requires Node 22.18 or later. No account is needed to ingest or build a snapshot.

```bash
npm ci
npm test                     # 33 tests
npm run ingest:all           # read all five sources (about 3 minutes, about 1,010 requests)
npm run runs                 # run history with added / changed / removed per source
npm run snapshot             # Parquet tables, state, manifest and CAR under data/publish/<id>/
```

Publishing needs an IPFS pinning account (Filebase free tier). Put `FILEBASE_ACCESS_KEY`,
`FILEBASE_SECRET_KEY` and `FILEBASE_BUCKET` in `.env`, then:

```bash
npm run publish-snapshot     # pin, verify every CID on two gateways, record in publications/
```

To continue from the last published snapshot on a clean machine:

```bash
npm run restore              # key state and run history, read from IPFS
npm run ingest:all
npm run record-check         # changed=true means a new snapshot is due
```

The web app is in `web/` (`npm ci && npm run dev`). The agent needs `GOOGLE_GENERATIVE_AI_API_KEY`.

## Deploy the runtime to AWS

The runtime is one CDK stack in `infra/`: a Lambda function built from `web/Dockerfile`, with
a public function URL, a one-week log group, and permission to read exactly one SSM parameter.
Requires Docker and AWS credentials for your own account.

```bash
aws ssm put-parameter --name /miami-dade-oracle/gemini-api-key --type SecureString --value <key> --region us-east-2
cd infra && npm ci
npx cdk bootstrap            # once per account and Region
npx cdk deploy               # prints the public URL
```

## Cost

| Part | Service | Standing cost |
|---|---|---|
| Storage and retrieval | IPFS, pinned on Filebase's free tier | None |
| Query engine and hosting | One AWS Lambda function (2 GB, container image) with a function URL | Requests fall inside Lambda's monthly free allowance. A five-minute schedule keeps four instances ready during the review period (under 5% of the free allowance); set `keepWarmInstances` to 0 in `infra/bin/app.ts` for no idle activity at all |
| Function image | Amazon ECR, about 550 MB | A few cents a month |
| Model key | SSM Parameter Store, encrypted | None |
| Scheduled ingestion | GitHub Actions on a public repository | None |
| Language model | Gemini API free tier | None |

A published snapshot uses about 320 MB of the 5 GB free pinning quota. A run that finds no
change publishes nothing, so only real changes consume it.

## Sources and their limits

| Source | Speed observed | Limits |
|---|---|---|
| Property Appraiser roll (ArcGIS) | 944,398 rows in 25 to 65 s over 473 requests | Only the most recent sale. No per-row change time, so changes are found by content hash. 5,830 rows have no folio and are excluded. |
| County building permits (ArcGIS) | 489,896 rows in about 35 s over 490 requests | Starts 2020-01-01. County building department only: municipalities such as Miami and Hialeah keep their own systems. No status column. |
| County contractor table (ArcGIS) | 22,281 rows in about 4 s | One row per contractor, tradesman and trade class. County-held licences only. **The county emptied this layer during a reload on 2026-11-17**; snapshot `20261117T152027Z` was published while it was empty and so carries no county licence status. The pipeline now refuses an empty or half-size read for that source only and records the refusal in the run history (decision 25); county status returns when the county refills the layer. State licence standing from DBPR is unaffected. |
| Florida DBPR licensee file (CSV) | 263,664 rows in about 6 s, one request | Statewide. Omits null and void, delinquent and involuntarily inactive licences, so a miss is not proof of no licence. About half the rows are qualified businesses with no licence number. |
| BBB business-profile sitemaps | 127,172 Florida profile listings in about 33 s, 22 requests | Says a profile exists, with its name, city and category. No rating. Profile pages are permitted by robots.txt but return HTTP 403 to automated requests, so the pipeline stops there. |
| Sunbiz | Not ingested | Bulk files are offered over SFTP; not yet loaded. |

Year built is missing for 69,096 properties and is a proxy for roof age wherever no completed
roof permit exists.

## Engineering standards followed

TypeScript throughout, Zod for every input, the Vercel AI SDK for all model calls, Vitest,
AWS Lambda in us-east-2 defined with CDK, and GitHub Actions for checks. Two deliberate
departures from the team kit:

- **Scheduled ingestion runs on GitHub Actions, not on AWS.** It needs about 1.5 GB of
  scratch disk for two minutes a day, which a free CI runner provides at no cost.
- **Publication follows this repository's README** (a manifest of query tables retrievable by
  CID), not the kit's Atlas registry, which needs a maintainer merge. See decision 5.

Every kit rule followed and every departure, with reasons, is in
[`docs/kit-usage.md`](./docs/kit-usage.md).

## Repository layout

```
src/            ingestion, model, snapshot, publish, restore (the pipeline)
tests/          unit tests for paging, hashing and the derivation rules
web/            the hosted page, API routes, agent and MCP endpoint (and the Dockerfile for Lambda)
infra/          AWS CDK app: the Lambda function and its public URL
publications/   one folder per published snapshot: manifest.json, retrieval.json; index.json; checks.json
docs/           decisions.md
.github/        check.yml (types, tests, build), ingest.yml (daily scheduled run)
```
