import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { rowHash, type LayerField } from "./arcgis.js";
import type { CsvSource } from "./catalog.js";

/**
 * Reader for a published delimited file with no header row.
 *
 * The whole file is one public request, so every row cites the file URL as its
 * source. Rows are written in the same shape the ArcGIS reader produces, so
 * loading, hashing and delta detection are shared.
 */

const USER_AGENT = "oracle-pipeline-miami-dade/0.1 (public-records ingestion)";
/** Row position in the file. Used only to choose between rows that share a key; never hashed. */
export const LINE_FIELD = "_line";

/** Parse quote/comma-delimited text. Handles quoted commas and doubled quotes. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i] as string;
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      field = "";
      if (row.length > 1 || row[0] !== "") rows.push(row);
      row = [];
    } else field += c;
  }
  if (field !== "" || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

export interface Capture {
  fields: LayerField[];
  oidField: string;
  /** Rows the publisher's file or service reports. */
  sourceCount: number;
  lastEditAt: string | null;
  pages: number;
  partial: boolean;
}

export async function captureCsv(source: CsvSource, rawDir: string, maxPages: number | null): Promise<Capture> {
  const response = await fetch(source.url, { headers: { "user-agent": USER_AGENT }, signal: AbortSignal.timeout(600_000) });
  if (!response.ok) throw new Error(`${source.url} returned HTTP ${response.status}`);
  const text = new TextDecoder(source.encoding === "latin1" ? "latin1" : "utf-8").decode(await response.arrayBuffer());
  const modified = response.headers.get("last-modified");
  const fetchedAt = new Date().toISOString();

  const rows = parseCsv(text);
  const wrong = rows.findIndex((r) => r.length !== source.columns.length);
  if (wrong !== -1) {
    // A changed layout must stop the run: silently shifted columns would corrupt every field.
    throw new Error(`${source.key}: line ${wrong + 1} has ${rows[wrong]?.length} columns, the documented layout has ${source.columns.length}`);
  }

  const pageSize = 20_000;
  const allPages = Math.ceil(rows.length / pageSize);
  const pages = maxPages ? Math.min(maxPages, allPages) : allPages;
  for (let page = 0; page < pages; page++) {
    const lines = rows.slice(page * pageSize, (page + 1) * pageSize).map((values, offset) => {
      const attributes: Record<string, unknown> = { [LINE_FIELD]: page * pageSize + offset + 1 };
      source.columns.forEach((column, index) => {
        const value = (values[index] as string).trim();
        attributes[column] = value === "" ? null : value;
      });
      return JSON.stringify({
        ...attributes,
        _lon: null,
        _lat: null,
        _row_hash: rowHash(attributes, LINE_FIELD),
        _source_url: source.url,
        _fetched_at: fetchedAt,
      });
    });
    writeFileSync(join(rawDir, `part-${String(page).padStart(6, "0")}.ndjson`), lines.join("\n") + "\n");
  }

  return {
    fields: [
      { name: LINE_FIELD, type: "esriFieldTypeInteger" },
      ...source.columns.map((name) => ({ name, type: "esriFieldTypeString" })),
    ],
    oidField: LINE_FIELD,
    sourceCount: rows.length,
    lastEditAt: modified ? new Date(modified).toISOString() : null,
    pages,
    partial: pages < allPages,
  };
}
