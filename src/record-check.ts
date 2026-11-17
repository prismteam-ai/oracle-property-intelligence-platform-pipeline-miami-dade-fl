import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { openStore, rows } from "./store.js";

/**
 * Decide whether the runs just completed changed anything.
 *
 *   npm run record-check
 *
 * If any source added, changed or removed a record, a new snapshot is due and
 * this prints `changed=true`. If nothing changed, no snapshot is published
 * (identical data must not get a new CID) and the check is recorded in
 * publications/checks.json, so the history still shows that the sources were re-read.
 */
const con = await openStore(join(process.argv[2] ?? "data", "oracle.duckdb"));

// "Just completed" = full runs newer than the newest run inside the latest published snapshot.
const indexPath = join("publications", "index.json");
const latest = existsSync(indexPath) ? JSON.parse(readFileSync(indexPath, "utf8")).at(-1) : null;
const since: string = latest?.snapshot_id ?? "";
const runs = (
  await rows(
    con,
    `SELECT s.run_id, s.source_key, s.source_count, s.distinct_keys, s.added, s.changed, s.removed, s.unchanged, r.finished_at
     FROM pipeline_run_source s JOIN pipeline_run r USING (run_id)
     WHERE NOT s.partial AND r.status = 'COMPLETE' AND s.run_id > '${since.replaceAll("'", "")}'
     ORDER BY s.run_id`,
  )
).map((r) => ({
  run_id: String(r.run_id),
  source_key: String(r.source_key),
  finished_at: String(r.finished_at),
  source_count: Number(r.source_count),
  distinct_keys: Number(r.distinct_keys),
  added: Number(r.added),
  changed: Number(r.changed),
  removed: Number(r.removed),
  unchanged: Number(r.unchanged),
}));
if (runs.length === 0) throw new Error("No completed full runs since the latest published snapshot");

const delta = runs.reduce((sum, r) => sum + r.added + r.changed + r.removed, 0);
const changed = delta > 0 || !latest;
console.table(runs.map(({ run_id, source_key, added, changed, removed, unchanged }) => ({ run_id, source_key, added, changed, removed, unchanged })));
console.log(`changed=${changed} (${delta} records added, changed or removed)`);
if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `changed=${changed}\n`);

if (!changed) {
  const checksPath = join("publications", "checks.json");
  const checks: unknown[] = existsSync(checksPath) ? JSON.parse(readFileSync(checksPath, "utf8")) : [];
  checks.push({ checked_at: new Date().toISOString(), against_snapshot: latest.snapshot_id, result: "no change", runs });
  mkdirSync("publications", { recursive: true });
  writeFileSync(checksPath, JSON.stringify(checks, null, 2) + "\n");
  console.log(`Recorded a no-change check against snapshot ${latest.snapshot_id}`);
}
