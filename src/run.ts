import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { captureArcgis } from "./arcgis.js";
import { COUNTY, getSource } from "./catalog.js";
import { captureCsv } from "./csv.js";
import { captureBbbSitemap } from "./sitemap.js";
import { checkComplete, IncompleteRead, knownKeys, lit, loadSource, openStore } from "./store.js";

/**
 * One pipeline run for one source: capture -> load -> record deltas.
 *
 *   npm run ingest -- --source properties            full refresh
 *   npm run ingest -- --source properties --max-pages 5   bounded pilot (partial)
 */

const { values } = parseArgs({
  options: {
    source: { type: "string" },
    "max-pages": { type: "string" },
    concurrency: { type: "string", default: "4" },
    "data-dir": { type: "string", default: "data" },
  },
});
if (!values.source) throw new Error("--source is required");

const source = getSource(values.source);
const dataDir = values["data-dir"];
const concurrency = Number(values.concurrency);
const maxPages = values["max-pages"] ? Number(values["max-pages"]) : null;

const startedAt = new Date();
const runId = startedAt.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
const rawDir = join(dataDir, "raw", runId, source.key);
mkdirSync(rawDir, { recursive: true });

const con = await openStore(join(dataDir, "oracle.duckdb"));
await con.run(`INSERT INTO pipeline_run VALUES
  (${lit(runId)}, ${lit(COUNTY.slug)}, ${lit(startedAt.toISOString())}, NULL, 'RUNNING')`);

try {
  // Each source kind has its own reader; everything after capture is shared.
  const capture =
    source.kind === "arcgis"
      ? await captureArcgis(source, rawDir, { concurrency, maxPages })
      : source.kind === "csv"
        ? await captureCsv(source, rawDir, maxPages)
        : await captureBbbSitemap(source, rawDir, maxPages);
  const partial = capture.partial;
  if (!partial) {
    try {
      checkComplete(source.key, capture.sourceCount, await knownKeys(con, source.key));
    } catch (error) {
      if (!(error instanceof IncompleteRead)) throw error;
      // Record the refusal in the run history and leave this source's rows and state untouched.
      // The run ends without an error so the other sources are still read.
      const seconds = (Date.now() - startedAt.getTime()) / 1000;
      await con.run(`INSERT INTO pipeline_run_source VALUES (
        ${lit(runId)}, ${lit(source.key)}, ${lit(source.url)}, ${lit(capture.lastEditAt)},
        ${capture.sourceCount}, 0, 0, 0, 0, 0, 0, NULL, 0, ${capture.pages}, ${seconds}, TRUE,
        ${lit(`REFUSED: ${error.message}`)})`);
      await con.run(`UPDATE pipeline_run SET status = 'REFUSED',
        finished_at = ${lit(new Date().toISOString())} WHERE run_id = ${lit(runId)}`);
      console.warn(`[${runId}] ${error.message}`);
      process.exit(0);
    }
  }
  console.log(`[${runId}] ${source.key}: ${capture.sourceCount} rows reported, ${capture.pages} pages` + (partial ? " (partial run)" : ""));

  const glob = join(rawDir, "*.ndjson").replaceAll("\\", "/");
  const result = await loadSource(con, source, capture.fields, capture.oidField, glob, runId, partial);
  const seconds = (Date.now() - startedAt.getTime()) / 1000;

  await con.run(`INSERT INTO pipeline_run_source VALUES (
    ${lit(runId)}, ${lit(source.key)}, ${lit(source.url)}, ${lit(capture.lastEditAt)},
    ${capture.sourceCount}, ${result.fetchedRows}, ${result.distinctKeys}, ${result.duplicateRows},
    ${result.rowsWithoutKey}, ${result.added}, ${result.changed}, ${result.removed ?? "NULL"},
    ${result.unchanged}, ${capture.pages}, ${seconds}, ${partial}, ${lit(source.limitations.join(" | "))})`);
  await con.run(`UPDATE pipeline_run SET status = ${lit(partial ? "PARTIAL" : "COMPLETE")},
    finished_at = ${lit(new Date().toISOString())} WHERE run_id = ${lit(runId)}`);
  console.log(JSON.stringify({ runId, source: source.key, partial, seconds, ...result }, null, 2));
} catch (error) {
  await con.run(`UPDATE pipeline_run SET status = 'FAILED',
    finished_at = ${lit(new Date().toISOString())} WHERE run_id = ${lit(runId)}`);
  throw error;
}
