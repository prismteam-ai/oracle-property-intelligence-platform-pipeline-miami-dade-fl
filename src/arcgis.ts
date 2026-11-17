import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Deterministic ArcGIS FeatureServer reader.
 *
 * Pages by ObjectID range rather than result offset: every page is an
 * independent, repeatable request, so pages can run in parallel, be retried
 * alone, and be cited as the exact source request for the rows they returned.
 */

const USER_AGENT = "oracle-pipeline-miami-dade/0.1 (public-records ingestion)";

export interface LayerField {
  name: string;
  type: string;
}

export interface LayerInfo {
  name: string;
  oidField: string;
  maxRecordCount: number;
  fields: LayerField[];
  /** When the publisher last changed the data, if the service reports it. */
  dataLastEditAt: string | null;
}

export interface OidRange {
  from: number;
  /** Exclusive upper bound. */
  to: number;
}

export interface CapturedRow {
  [column: string]: unknown;
}

async function getJson(url: string, params: Record<string, string>, attempts = 5): Promise<any> {
  const query = new URLSearchParams({ ...params, f: "json" }).toString();
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const response = await fetch(`${url}?${query}`, {
        headers: { "user-agent": USER_AGENT },
        signal: AbortSignal.timeout(90_000),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const body = await response.json();
      // ArcGIS reports failures as HTTP 200 with an `error` object.
      if (body?.error) throw new Error(`ArcGIS ${body.error.code}: ${body.error.message}`);
      return body;
    } catch (error) {
      lastError = error;
      if (attempt < attempts) {
        await new Promise((resolve) => setTimeout(resolve, 1000 * 2 ** (attempt - 1)));
      }
    }
  }
  throw new Error(`Request failed after ${attempts} attempts: ${url} (${String(lastError)})`);
}

export async function getLayerInfo(layerUrl: string): Promise<LayerInfo> {
  const body = await getJson(layerUrl, {});
  const edited = body.editingInfo?.dataLastEditDate ?? body.editingInfo?.lastEditDate;
  return {
    name: body.name,
    oidField: body.objectIdField ?? "OBJECTID",
    maxRecordCount: body.maxRecordCount ?? 1000,
    fields: (body.fields ?? []).map((f: any) => ({ name: f.name, type: f.type })),
    dataLastEditAt: typeof edited === "number" ? new Date(edited).toISOString() : null,
  };
}

export async function getOidBounds(
  layerUrl: string,
  oidField: string,
): Promise<{ min: number; max: number; count: number }> {
  const stats = await getJson(`${layerUrl}/query`, {
    where: "1=1",
    outStatistics: JSON.stringify([
      { statisticType: "min", onStatisticField: oidField, outStatisticFieldName: "lo" },
      { statisticType: "max", onStatisticField: oidField, outStatisticFieldName: "hi" },
    ]),
  });
  const counted = await getJson(`${layerUrl}/query`, { where: "1=1", returnCountOnly: "true" });
  const attrs = stats.features?.[0]?.attributes ?? {};
  return { min: Number(attrs.lo), max: Number(attrs.hi), count: Number(counted.count) };
}

/** Split [min, max] into windows no wider than the service's page limit. */
export function planRanges(min: number, max: number, size: number): OidRange[] {
  if (!Number.isInteger(size) || size < 1) throw new Error("size must be a positive integer");
  const ranges: OidRange[] = [];
  for (let from = min; from <= max; from += size) {
    ranges.push({ from, to: Math.min(from + size, max + 1) });
  }
  return ranges;
}

/** The public request that returns exactly the rows of one range. */
export function rangeRequestUrl(layerUrl: string, oidField: string, range: OidRange): string {
  const where = `${oidField}>=${range.from} AND ${oidField}<${range.to}`;
  return `${layerUrl}/query?${new URLSearchParams({ where, outFields: "*", outSR: "4326", f: "json" })}`;
}

/**
 * Content hash of a record's source attributes. The ObjectID is excluded: it is
 * a storage detail the publisher may renumber without the record changing.
 */
/**
 * Content hash of one record. `ignore` names the publisher's row identifiers
 * (ObjectID, GlobalID): they are reassigned whenever the publisher reloads its
 * table, so including them would report every record as changed when nothing did.
 */
export function rowHash(attributes: Record<string, unknown>, ignore: string | string[]): string {
  const skip = new Set(typeof ignore === "string" ? [ignore] : ignore);
  const keys = Object.keys(attributes)
    .filter((k) => !skip.has(k))
    .sort();
  const canonical = JSON.stringify(keys.map((k) => [k, attributes[k] ?? null]));
  return createHash("sha256").update(canonical).digest("hex");
}

export async function fetchRange(
  layerUrl: string,
  oidField: string,
  range: OidRange,
  hasGeometry: boolean,
  /** Other publisher-assigned row identifiers to leave out of the content hash. */
  surrogateFields: string[] = [],
): Promise<CapturedRow[]> {
  const sourceUrl = rangeRequestUrl(layerUrl, oidField, range);
  const body = await getJson(`${layerUrl}/query`, {
    where: `${oidField}>=${range.from} AND ${oidField}<${range.to}`,
    outFields: "*",
    outSR: "4326",
    returnGeometry: String(hasGeometry),
  });
  if (body.exceededTransferLimit) {
    // A range can never hold more rows than its width, so this means the plan is wrong.
    throw new Error(`Range ${range.from}-${range.to} exceeded the transfer limit`);
  }
  const fetchedAt = new Date().toISOString();
  return (body.features ?? []).map((feature: any) => ({
    ...feature.attributes,
    _lon: feature.geometry?.x ?? null,
    _lat: feature.geometry?.y ?? null,
    _row_hash: rowHash(feature.attributes, [oidField, ...surrogateFields]),
    _source_url: sourceUrl,
    _fetched_at: fetchedAt,
  }));
}

/** Run `worker` over `items` with a fixed number of concurrent workers, preserving order. */
export async function mapConcurrent<T, R>(
  items: T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, async () => {
      while (next < items.length) {
        const index = next++;
        results[index] = await worker(items[index] as T, index);
      }
    }),
  );
  return results;
}

/** Capture a whole ArcGIS layer (or its first `maxPages` ranges) as NDJSON pages under `rawDir`. */
export async function captureArcgis(
  source: { key: string; url: string; hasGeometry: boolean },
  rawDir: string,
  options: { concurrency: number; maxPages: number | null },
): Promise<{ fields: LayerField[]; oidField: string; sourceCount: number; lastEditAt: string | null; pages: number; partial: boolean }> {
  const info = await getLayerInfo(source.url);
  const bounds = await getOidBounds(source.url, info.oidField);
  const allRanges = planRanges(bounds.min, bounds.max, info.maxRecordCount);
  const ranges = options.maxPages ? allRanges.slice(0, options.maxPages) : allRanges;
  const surrogates = info.fields.filter((f) => f.type === "esriFieldTypeGlobalID").map((f) => f.name);
  let done = 0;
  await mapConcurrent(ranges, options.concurrency, async (range, index) => {
    const captured = await fetchRange(source.url, info.oidField, range, source.hasGeometry, surrogates);
    const file = join(rawDir, `part-${String(index).padStart(6, "0")}.ndjson`);
    writeFileSync(file, captured.map((row) => JSON.stringify(row)).join("\n") + "\n");
    if (++done % 50 === 0 || done === ranges.length) console.log(`  ${done}/${ranges.length} pages`);
  });
  return {
    fields: info.fields,
    oidField: info.oidField,
    sourceCount: bounds.count,
    lastEditAt: info.dataLastEditAt,
    pages: ranges.length,
    partial: ranges.length < allRanges.length,
  };
}
