import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { SOURCES } from "./catalog.js";
import { ensureStateTable, lit, openStore, rows, stateTable } from "./store.js";

/**
 * Restore pipeline state from a published snapshot into a fresh working store,
 * so the next run can compute deltas without the machine that made the last one.
 *
 *   npm run restore                 the latest snapshot in publications/index.json, read from IPFS
 *   npm run restore -- <root> [dir] a local snapshot directory, or https://<gateway>/ipfs/<root cid>
 *
 * Only state is restored (keys, hashes, run history). Source rows are re-read
 * from the publisher on the next run.
 */
function latestPublished(): string {
  const indexPath = join("publications", "index.json");
  const latest = existsSync(indexPath) ? JSON.parse(readFileSync(indexPath, "utf8")).at(-1) : null;
  if (!latest) throw new Error("No published snapshot yet. Pass a snapshot root, or run the first ingest without restoring.");
  console.log(`Restoring from snapshot ${latest.snapshot_id} (${latest.root_cid})`);
  return `https://ipfs.filebase.io/ipfs/${latest.root_cid}`;
}
const base = process.argv[2] ?? latestPublished();
const con = await openStore(join(process.argv[3] ?? "data", "oracle.duckdb"));
const file = (name: string) => lit(`${base.replace(/[\/]+$/, "").replaceAll("\\", "/")}/state/${name}.parquet`);

const [existing] = await rows(con, `SELECT count(*) AS n FROM pipeline_run`);
if (Number(existing?.n) > 0) throw new Error("This store already has run history; restore only into an empty store");

for (const table of ["pipeline_run", "pipeline_run_source", "pipeline_change"]) {
  await con.run(`INSERT INTO ${table} SELECT * FROM read_parquet(${file(table)})`);
}
for (const source of SOURCES) {
  await ensureStateTable(con, source.key);
  // BY NAME: snapshots written before a state column existed restore with NULL in it.
  try {
    await con.run(`INSERT INTO ${stateTable(source.key)} BY NAME SELECT * FROM read_parquet(${file(`key_state_${source.key}`)})`);
  } catch {
    // A source added after that snapshot was published has no state yet: its next run is its first.
    console.log(`${source.key}: no state in this snapshot (new source)`);
    continue;
  }
  const [row] = await rows(con, `SELECT count(*) AS n FROM ${stateTable(source.key)}`);
  console.log(`${source.key}: ${row?.n} keys restored`);
}
const [runs] = await rows(con, `SELECT count(*) AS n FROM pipeline_run`);
console.log(`run history: ${runs?.n} runs restored`);
