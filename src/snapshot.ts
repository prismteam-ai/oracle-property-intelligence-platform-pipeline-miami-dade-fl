import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { COUNTY, SOURCES } from "./catalog.js";
import { buildSnapshotCar, fileCid, sha256File } from "./ipfs.js";
import { buildModel } from "./model.js";
import { ensureStateTable, lit, openStore, rows, stateTable } from "./store.js";

/**
 * Build a publishable snapshot from the working store. Offline: nothing is uploaded.
 *
 *   npm run snapshot
 *
 * Writes, under data/publish/<snapshotId>/:
 *   root/tables/*.parquet   the query tables
 *   root/coverage.json      what was loaded, from where, and the known limits
 *   root/runs.json          run history with per-source deltas
 *   root/samples/*.json     small extracts for a quick look without DuckDB
 *   root/state/*.parquet    key + content hash per source, change log and run history:
 *                           what the next run needs to compute deltas on a clean machine
 *   snapshot.car            the whole root directory DAG, importable by any IPFS node
 *   manifest.json           every artifact with CID, size, codec and SHA-256
 *
 * The publish step uploads these and records the manifest under publications/ in Git.
 */

const dataDir = process.argv[2] ?? "data";
const con = await openStore(join(dataDir, "oracle.duckdb"));
await buildModel(con);

const createdAt = new Date();
const snapshotId = createdAt.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
const outDir = join(dataDir, "publish", snapshotId);
const rootDir = join(outDir, "root");
mkdirSync(join(rootDir, "tables"), { recursive: true });
mkdirSync(join(rootDir, "samples"), { recursive: true });
mkdirSync(join(rootDir, "state"), { recursive: true });
const posix = (path: string) => path.replaceAll("\\", "/");

// Sort orders are part of the contract: they make the files reproducible and let
// DuckDB skip row groups (property and permit by map cell).
const TABLES: Record<string, string> = {
  property: "floor(lat * 50), floor(lon * 50), folio",
  permit: "floor(lat * 50) NULLS LAST, floor(lon * 50), permit_number",
  contractor: "contractor_number",
  business: "name, business_key",
  owner: "owner_id",
  place: "name",
};
const tableCounts: Record<string, number> = {};
for (const [table, order] of Object.entries(TABLES)) {
  const file = posix(join(rootDir, "tables", `${table}.parquet`));
  await con.run(`COPY (SELECT * FROM ${table} ORDER BY ${order})
    TO ${lit(file)} (FORMAT parquet, COMPRESSION zstd, ROW_GROUP_SIZE 20000)`);
  tableCounts[table] = Number((await rows(con, `SELECT count(*) AS n FROM ${table}`))[0]?.n);
}

// Pipeline state: small, and enough to resume incremental runs anywhere.
const STATE: Record<string, string> = {
  pipeline_run: "SELECT * FROM pipeline_run ORDER BY run_id",
  pipeline_run_source: "SELECT * FROM pipeline_run_source ORDER BY run_id, source_key",
  pipeline_change: "SELECT * FROM pipeline_change ORDER BY run_id, source_key, record_key",
};
for (const source of SOURCES) {
  await ensureStateTable(con, source.key);
  STATE[`key_state_${source.key}`] = `SELECT * FROM ${stateTable(source.key)} ORDER BY _key`;
}
for (const [name, sql] of Object.entries(STATE)) {
  const file = posix(join(rootDir, "state", `${name}.parquet`));
  await con.run(`COPY (${sql}) TO ${lit(file)} (FORMAT parquet, COMPRESSION zstd)`);
}

const num = (value: unknown) => (value === null || value === undefined ? null : Number(value));
const runHistory = (
  await rows(
    con,
    `SELECT r.run_id, r.status, r.started_at, r.finished_at, s.source_key, s.layer_url,
            s.source_last_edit_at, s.source_count, s.fetched_rows, s.distinct_keys, s.duplicate_rows,
            s.rows_without_key, s.added, s.changed, s.removed, s.unchanged, s.pages, s.seconds, s.partial
     FROM pipeline_run r JOIN pipeline_run_source s USING (run_id) ORDER BY r.started_at`,
  )
).map((r) => ({
  ...r,
  ...Object.fromEntries(
    ["source_count", "fetched_rows", "distinct_keys", "duplicate_rows", "rows_without_key",
     "added", "changed", "removed", "unchanged", "pages"].map((k) => [k, num(r[k])]),
  ),
}));
writeFileSync(join(rootDir, "runs.json"), JSON.stringify(runHistory, null, 2));

const [facts] = await rows(
  con,
  `SELECT
     (SELECT count(*) FROM property WHERE lon IS NOT NULL) AS properties_with_coordinates,
     (SELECT count(*) FROM property WHERE roof_basis = 'roof_permit') AS roof_year_from_permit,
     (SELECT count(*) FROM property WHERE roof_basis = 'year_built') AS roof_year_from_year_built,
     (SELECT count(*) FROM property WHERE roof_basis = 'unknown') AS roof_year_unknown,
     (SELECT count(*) FROM property WHERE last_sale_date IS NOT NULL) AS properties_with_last_sale,
     (SELECT count(*) FROM permit WHERE property_matched) AS permits_matched_to_property,
     (SELECT count(*) FROM permit WHERE is_roofing) AS roofing_permits,
     (SELECT count(*) FROM permit WHERE is_roofing AND is_open) AS open_roofing_permits,
     (SELECT count(*) FROM contractor WHERE state_licence_found) AS contractors_with_state_licence,
     (SELECT count(*) FROM contractor WHERE state_licence_class IS NOT NULL AND NOT state_licence_found) AS state_format_numbers_not_in_licence_file,
     (SELECT count(*) FROM business WHERE in_miami_dade) AS qualified_businesses_in_miami_dade,
     (SELECT count(*) FROM contractor WHERE bbb_profile_url IS NOT NULL) AS contractors_linked_to_bbb_profile,
     (SELECT min(issued_date) FROM permit) AS permits_from,
     (SELECT max(issued_date) FROM permit) AS permits_to`,
);
const latestBySource = new Map(runHistory.filter((r) => !r.partial).map((r) => [r.source_key, r]));
const coverage = {
  county: COUNTY,
  snapshot_id: snapshotId,
  created_at: createdAt.toISOString(),
  tables: tableCounts,
  facts: Object.fromEntries(Object.entries(facts ?? {}).map(([k, v]) => [k, /^\d+$/.test(String(v)) ? Number(v) : v])),
  sources: SOURCES.map((s) => ({
    key: s.key,
    entity: s.entity,
    publisher: s.publisher,
    url: s.url,
    limitations: s.limitations,
    last_full_run: latestBySource.get(s.key) ?? null,
  })),
  not_loaded: [
    { what: "BBB ratings", why: "BBB's profile pages refuse automated requests (HTTP 403 challenge), so ratings are not read. Contractors are linked to their BBB profile page by name instead, from BBB's published sitemaps." },
    { what: "Municipal building permits", why: "Each municipality keeps its own permit system; only the county building department is loaded." },
    { what: "Sunbiz corporate registry", why: "Not yet ingested. Business records come from DBPR qualified-business registrations instead." },
  ],
};
writeFileSync(join(rootDir, "coverage.json"), JSON.stringify(coverage, null, 2));

const SAMPLES: Record<string, string> = {
  "property.json": `SELECT * FROM property ORDER BY folio LIMIT 100`,
  "open_roofing_permits.json": `SELECT * FROM permit WHERE is_roofing AND is_open ORDER BY issued_date, permit_number LIMIT 100`,
  "contractor.json": `SELECT * FROM contractor ORDER BY roofing_permits DESC, contractor_number LIMIT 100`,
};
for (const [name, sql] of Object.entries(SAMPLES)) {
  writeFileSync(join(rootDir, "samples", name), JSON.stringify(await rows(con, sql), null, 2));
}

const files: Record<string, string> = {
  "coverage.json": join(rootDir, "coverage.json"),
  "runs.json": join(rootDir, "runs.json"),
  ...Object.fromEntries(Object.keys(TABLES).map((t) => [`tables/${t}.parquet`, join(rootDir, "tables", `${t}.parquet`)])),
  ...Object.fromEntries(Object.keys(SAMPLES).map((s) => [`samples/${s}`, join(rootDir, "samples", s)])),
  ...Object.fromEntries(Object.keys(STATE).map((s) => [`state/${s}.parquet`, join(rootDir, "state", `${s}.parquet`)])),
};
const carPath = join(outDir, "snapshot.car");
const { root, entries, blocks } = await buildSnapshotCar(files, carPath);

const indexPath = join("publications", "index.json");
const history: any[] = existsSync(indexPath) ? JSON.parse(readFileSync(indexPath, "utf8")) : [];
const previous = history.at(-1) ?? null;

const manifest = {
  schema: "oracle-snapshot-manifest/1",
  county: COUNTY,
  snapshot_id: snapshotId,
  created_at: createdAt.toISOString(),
  /** The snapshot directory. Fetch any artifact as <gateway>/ipfs/<root>/<name>. */
  root: { cid: root, codec: "directory" },
  /** The previous snapshot stays valid: a new run never changes an old CID. */
  previous: previous ? { snapshot_id: previous.snapshot_id, manifest_cid: previous.manifest_cid, root_cid: previous.root_cid } : null,
  artifacts: entries.map((e) => ({
    name: e.path === "" ? "/" : e.path,
    cid: e.cid,
    codec: e.codec,
    size: e.size,
    sha256: e.sha256,
  })),
  /** The full DAG under `root` as one CARv1 file, importable without re-encoding. */
  car: {
    name: "snapshot.car",
    cid: await fileCid(carPath),
    codec: "file",
    size: statSync(carPath).size,
    sha256: await sha256File(carPath),
    roots: [root],
    blocks,
  },
};
const manifestJson = JSON.stringify(manifest, null, 2) + "\n";
writeFileSync(join(outDir, "manifest.json"), manifestJson);
const manifestCid = await fileCid(join(outDir, "manifest.json"));

console.log(JSON.stringify({ snapshotId, root, manifestCid, car: manifest.car, tables: tableCounts }, null, 2));
console.table(manifest.artifacts.map((a) => ({ name: a.name, codec: a.codec, size: a.size, cid: a.cid })));
