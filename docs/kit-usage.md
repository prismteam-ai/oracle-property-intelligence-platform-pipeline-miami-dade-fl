# Kit usage and deviations

The [Soofi XYZ Team Kit](https://github.com/soofi-xyz/soofi-xyz-team-kit) was used as
reference documentation: its agent and skill files were read and their rules applied by
hand. The plugin itself was not installed. For a county pipeline the kit routes to the
`oracle` agent (`use-oracle` and the county skills), with `donphan` / `use-elephant-mcp`
for consumers and `apply-engineering-guidelines` as the baseline.

## Followed

| Kit rule | Where |
|---|---|
| TypeScript for every workload (`stack-typescript-for-apis`) | Whole repository; no Python |
| Vercel AI SDK for all model calls, Zod tool schemas, no provider SDK (`stack-ai-sdk-for-llm`) | `web/lib/agent.ts`, `web/lib/tools.ts` |
| AWS in `us-east-2`, CDK as the only infrastructure tool, cost tags (`cloud-aws-primary`) | `infra/` |
| Vitest, type check and lint in GitHub Actions (`testing-strategy`) | `tests/`, `.github/workflows/check.yml` |
| No secrets in logs or the repository | Model key in an encrypted SSM parameter; publish keys in Actions secrets |
| Join only on official identifiers; never on name or address (`oracle`) | Folio, permit number, licence number. Decisions 10 and 23 |
| A contractor's legal identity comes only from an exact DBPR licence match; the name on a permit is a search key (`oracle`) | `state_licence_found`, `state_licensee_name`; unmatched contractors are labelled "not in the state licence file" |
| Every record carries the source request that returned it (`build-county-transform`) | `source_url` and `fetched_at` on every row |
| Idempotent loads keyed by parcel; re-reading identical data changes nothing (`use-oracle`) | `src/store.ts`; decisions 2, 16 and 25 |
| BBB is enrichment, not identity; treat HTTP 403 as a boundary, stop, and record the reason (`bbb-harvest`) | Decision 24: one refused request, no further profile requests, coverage says why |
| Never solve a CAPTCHA or change network identity to pass a block | Decision 24 |
| No fabricated records or provenance | Unknown stays unknown: roof basis, derived status and name-only matches are labelled |
| Captures, CARs and Parquet are not committed | Only manifests and retrieval reports are in `publications/` |
| MCP surface in the shape of `use-elephant-mcp`: dataset description, schema, read-only SELECT with a row cap, record lookup, snapshot identity on every answer | `web/lib/tools.ts`: `dataset_info`, `query_sql`, `get_property`; every result carries `evidence.snapshot` |

## Deviations, and why

| Kit rule | What this repository does | Reason |
|---|---|---|
| Publish only through the Elephant CLI: lexicon archives, `export-tables`, an Atlas pull request and the global IPNS name | Publishes its own CID-addressed snapshot: Parquet tables, a JSON manifest and a CAR | This assignment's README asks for a manifest of query tables fetched by CID from two independent gateways. Atlas registration needs a code-owner merge that a candidate cannot perform. Decision 5 |
| Never hand-build public tables from the query database | The published tables are built with DuckDB from the source snapshots | Same reason. Each row keeps its source request, so conversion to lexicon format would not need re-mining |
| Write no contractor when DBPR has no match | Contractors named on permits are kept and flagged as unmatched | The CRM must show the contractor printed on an open permit. The row is labelled as a permit name, not a licensed identity |
| Powertools logger, tracer and metrics; PagerDuty; a dead-letter queue alarm | Plain logs to CloudWatch with one-week retention; a failed scheduled run fails visibly in GitHub Actions | One function and no queue. Not built in the time available; this is a real gap for production use |
| Queue external calls | Source reads run in a scheduled batch job with bounded concurrency, timeouts and a stop on refusal | Nothing consumes them interactively, and a queue would be standing infrastructure |
| Scheduling on AWS | GitHub Actions cron | The README requires no ongoing infrastructure cost by default |
| Bedrock models | Gemini through the Vercel AI SDK | Free tier. The provider is one line in `web/lib/agent.ts` |
| Frontend on Amplify, API on API Gateway | One Next.js app in one Lambda function with a function URL | The smallest runtime that serves the page, API, agent and MCP endpoint at no idle cost |
