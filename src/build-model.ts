import { join } from "node:path";
import { buildModel } from "./model.js";
import { openStore, rows } from "./store.js";

/** Rebuild the query model from the current source snapshots: `npm run model`. */
const con = await openStore(join(process.argv[2] ?? "data", "oracle.duckdb"));
await buildModel(con);
for (const table of ["property", "permit", "contractor", "business", "owner", "place"]) {
  const [row] = await rows(con, `SELECT count(*) AS n FROM ${table}`);
  console.log(`${table}: ${row?.n} rows`);
}
