import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DuckDBInstance, type DuckDBConnection } from "@duckdb/node-api";
import type { LayerField } from "./arcgis.js";
import type { Source } from "./catalog.js";

/**
 * The DuckDB working store. It holds the latest snapshot of every source
 * (`src_<key>`) plus the run history. It is a local file: nothing is hosted.
 */

export const lit = (value: string | null): string =>
  value === null ? "NULL" : `'${value.replaceAll("'", "''")}'`;
export const ident = (name: string): string => `"${name.replaceAll('"', '""')}"`;

const DDL = `
CREATE TABLE IF NOT EXISTS pipeline_run (
  run_id       VARCHAR PRIMARY KEY,
  county       VARCHAR NOT NULL,
  started_at   TIMESTAMP NOT NULL,
  finished_at  TIMESTAMP,
  status       VARCHAR NOT NULL
);
CREATE TABLE IF NOT EXISTS pipeline_run_source (
  run_id              VARCHAR NOT NULL,
  source_key          VARCHAR NOT NULL,
  layer_url           VARCHAR NOT NULL,
  source_last_edit_at TIMESTAMP,
  source_count        BIGINT,   -- rows the publisher reports
  fetched_rows        BIGINT,   -- rows captured this run
  distinct_keys       BIGINT,
  duplicate_rows      BIGINT,   -- extra rows sharing a key (latest ObjectID kept)
  rows_without_key    BIGINT,
  added               BIGINT,
  changed             BIGINT,
  removed             BIGINT,   -- NULL on a partial run: absence proves nothing
  unchanged           BIGINT,
  pages               BIGINT,
  seconds             DOUBLE,
  partial             BOOLEAN NOT NULL,
  limitations         VARCHAR,
  PRIMARY KEY (run_id, source_key)
);
CREATE TABLE IF NOT EXISTS pipeline_change (
  run_id     VARCHAR NOT NULL,
  source_key VARCHAR NOT NULL,
  record_key VARCHAR NOT NULL,
  change     VARCHAR NOT NULL  -- added | changed | removed
);
`;

export async function openStore(path: string): Promise<DuckDBConnection> {
  mkdirSync(dirname(path), { recursive: true });
  const instance = await DuckDBInstance.create(path);
  const con = await instance.connect();
  await con.run(DDL);
  return con;
}

export async function rows(con: DuckDBConnection, sql: string): Promise<Record<string, any>[]> {
  return (await con.runAndReadAll(sql)).getRowObjectsJson() as Record<string, any>[];
}

async function scalar(con: DuckDBConnection, sql: string): Promise<number> {
  const [row] = await rows(con, sql);
  return Number(Object.values(row ?? { n: 0 })[0]);
}

export function duckType(esriType: string): string {
  switch (esriType) {
    case "esriFieldTypeOID":
    case "esriFieldTypeInteger":
    case "esriFieldTypeSmallInteger":
    case "esriFieldTypeBigInteger":
    case "esriFieldTypeDate": // epoch milliseconds, kept exactly as published
      return "BIGINT";
    case "esriFieldTypeDouble":
    case "esriFieldTypeSingle":
      return "DOUBLE";
    default:
      return "VARCHAR";
  }
}

export interface LoadResult {
  fetchedRows: number;
  distinctKeys: number;
  duplicateRows: number;
  rowsWithoutKey: number;
  added: number;
  changed: number;
  removed: number | null;
  unchanged: number;
}

/** Per-source record of which keys exist and what their content hash was. */
export const stateTable = (sourceKey: string) => ident(`key_state_${sourceKey}`);
const STATE_COLUMNS = `_key VARCHAR, _row_hash VARCHAR, _first_seen_run VARCHAR, _last_changed_run VARCHAR, _captured_at TIMESTAMP`;

/**
 * Refuse a full read that looks incomplete. A publisher that reloads a table can be
 * read while it is empty or half filled; recording that as thousands of removals
 * would publish a moment of the publisher's maintenance as if it were fact.
 */
export const MIN_SHARE_OF_KNOWN = 0.5;
/** A full read that was refused as incomplete. Only that source stops; the others carry on. */
export class IncompleteRead extends Error {}
export function checkComplete(sourceKey: string, reported: number, known: number): void {
  if (reported === 0) throw new IncompleteRead(`${sourceKey}: the publisher returned no records, so its previous state was kept`);
  if (reported < known * MIN_SHARE_OF_KNOWN) {
    throw new IncompleteRead(
      `${sourceKey}: the publisher returned ${reported} records where ${known} were known. ` +
        `That is less than ${MIN_SHARE_OF_KNOWN * 100}%, so the read is treated as incomplete and its previous state was kept`,
    );
  }
}

export async function knownKeys(con: DuckDBConnection, sourceKey: string): Promise<number> {
  await ensureStateTable(con, sourceKey);
  return scalar(con, `SELECT count(*) FROM ${stateTable(sourceKey)}`);
}

export async function ensureStateTable(con: DuckDBConnection, sourceKey: string): Promise<void> {
  await con.run(`CREATE TABLE IF NOT EXISTS ${stateTable(sourceKey)} (${STATE_COLUMNS})`);
  // Stores created before `_captured_at` existed gain the column; NULL means "not known".
  await con.run(`ALTER TABLE ${stateTable(sourceKey)} ADD COLUMN IF NOT EXISTS _captured_at TIMESTAMP`);
}

/**
 * Merge one run's captured pages into `src_<key>` and return the deltas.
 *
 * Deltas are computed against `key_state_<key>` (key + content hash), not the
 * full previous rows. That small table is published with every snapshot, so a
 * run on a clean machine restores it and reports the same deltas.
 *
 * A full run replaces the snapshot, so a key missing from the capture is a
 * removal. A partial run only upserts: it never infers removals.
 */
export async function loadSource(
  con: DuckDBConnection,
  source: Source,
  fields: LayerField[],
  oidField: string,
  ndjsonGlob: string,
  runId: string,
  partial: boolean,
): Promise<LoadResult> {
  const table = ident(`src_${source.key}`);
  const state = stateTable(source.key);
  await ensureStateTable(con, source.key);
  // `_key` is the record's identity: the key fields joined, NULL when the first is missing.
  const key = `"_key"`;
  const [firstKey, ...restKeys] = source.keyFields.map(ident) as [string, ...string[]];
  const keyExpr = restKeys.length
    ? `CASE WHEN ${firstKey} IS NULL THEN NULL
       ELSE concat_ws('|', ${firstKey}, ${restKeys.map((k) => `coalesce(${k}::VARCHAR, '')`).join(", ")}) END`
    : `${firstKey}::VARCHAR`;
  const columns = [
    ...fields.map((f) => `${lit(f.name)}: ${lit(duckType(f.type))}`),
    `'_lon': 'DOUBLE'`,
    `'_lat': 'DOUBLE'`,
    `'_row_hash': 'VARCHAR'`,
    `'_source_url': 'VARCHAR'`,
    `'_fetched_at': 'TIMESTAMP'`,
  ].join(", ");

  await con.run(`CREATE OR REPLACE TEMP TABLE stage_all AS
    SELECT ${keyExpr} AS _key, *
    FROM read_json(${lit(ndjsonGlob)}, format = 'newline_delimited', columns = {${columns}})`);
  await con.run(`CREATE OR REPLACE TEMP TABLE stage AS
    SELECT * FROM stage_all WHERE ${key} IS NOT NULL
    QUALIFY row_number() OVER (PARTITION BY ${key} ORDER BY ${ident(oidField)} DESC) = 1`);
  await con.run(`CREATE TABLE IF NOT EXISTS ${table} AS
    SELECT *, NULL::VARCHAR AS _first_seen_run, NULL::VARCHAR AS _last_changed_run FROM stage LIMIT 0`);

  const fetchedRows = await scalar(con, `SELECT count(*) FROM stage_all`);
  const distinctKeys = await scalar(con, `SELECT count(*) FROM stage`);
  const rowsWithoutKey = await scalar(con, `SELECT count(*) FROM stage_all WHERE ${key} IS NULL`);
  const hadSnapshot = (await scalar(con, `SELECT count(*) FROM ${state}`)) > 0;

  const run = lit(runId);
  const src = lit(source.key);
  await con.run("BEGIN");
  try {
    await con.run(`CREATE OR REPLACE TEMP TABLE delta AS
      SELECT s.${key} AS record_key,
             CASE WHEN t.${key} IS NULL THEN 'added'
                  WHEN t._row_hash <> s._row_hash THEN 'changed'
                  ELSE 'unchanged' END AS change
      FROM stage s LEFT JOIN ${state} t ON t.${key} = s.${key}
      ${partial ? "" : `UNION ALL
      SELECT t.${key}, 'removed' FROM ${state} t ANTI JOIN stage s ON s.${key} = t.${key}`}`);

    // The first load of a source is all "added"; logging every key adds no information.
    await con.run(`INSERT INTO pipeline_change
      SELECT ${run}, ${src}, record_key, change FROM delta
      WHERE change IN ('changed', 'removed') ${hadSnapshot ? "OR change = 'added'" : ""}`);

    // `_fetched_at` is when this version of the record was captured. An unchanged
    // record keeps its earlier time, so re-reading identical data yields identical
    // rows, files and CIDs. When a source was last re-read is in the run history.
    await con.run(`CREATE OR REPLACE TABLE src_next AS
      SELECT s.* REPLACE (
               CASE WHEN t._row_hash = s._row_hash AND t._captured_at IS NOT NULL
                    THEN t._captured_at ELSE s._fetched_at END AS _fetched_at),
             coalesce(t._first_seen_run, ${run}) AS _first_seen_run,
             CASE WHEN t.${key} IS NULL OR t._row_hash <> s._row_hash THEN ${run}
                  ELSE t._last_changed_run END AS _last_changed_run
      FROM stage s LEFT JOIN ${state} t ON t.${key} = s.${key}
      ${partial ? `UNION ALL BY NAME
      SELECT t.* FROM ${table} t ANTI JOIN stage s ON s.${key} = t.${key}` : ""}`);
    await con.run(`DROP TABLE ${table}`);
    await con.run(`ALTER TABLE src_next RENAME TO ${table}`);
    // A partial run keeps the state of keys it did not capture.
    await con.run(`CREATE OR REPLACE TABLE state_next AS
      SELECT _key, _row_hash, _first_seen_run, _last_changed_run, _fetched_at AS _captured_at FROM ${table}
      ${partial ? `UNION ALL BY NAME
      SELECT t.* FROM ${state} t ANTI JOIN ${table} s ON s.${key} = t.${key}` : ""}`);
    await con.run(`DROP TABLE ${state}`);
    await con.run(`ALTER TABLE state_next RENAME TO ${state}`);
    await con.run("COMMIT");
  } catch (error) {
    await con.run("ROLLBACK");
    throw error;
  }

  const count = (change: string) =>
    scalar(con, `SELECT count(*) FROM delta WHERE change = ${lit(change)}`);
  return {
    fetchedRows,
    distinctKeys,
    duplicateRows: fetchedRows - rowsWithoutKey - distinctKeys,
    rowsWithoutKey,
    added: await count("added"),
    changed: await count("changed"),
    removed: partial ? null : await count("removed"),
    unchanged: await count("unchanged"),
  };
}
