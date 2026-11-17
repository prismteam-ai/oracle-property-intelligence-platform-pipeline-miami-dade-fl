import { join } from "node:path";
import { openStore, rows } from "./store.js";

/** Print the run history: `npm run runs`. */
const con = await openStore(join(process.argv[2] ?? "data", "oracle.duckdb"));
console.table(
  await rows(
    con,
    `SELECT r.run_id, r.status, s.source_key, s.source_count, s.fetched_rows, s.distinct_keys,
            s.added, s.changed, s.removed, s.unchanged, round(s.seconds, 1) AS seconds
     FROM pipeline_run r LEFT JOIN pipeline_run_source s USING (run_id)
     ORDER BY r.started_at`,
  ),
);
