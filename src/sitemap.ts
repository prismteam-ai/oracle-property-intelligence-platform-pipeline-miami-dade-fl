import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { rowHash } from "./arcgis.js";
import type { BbbSitemapSource } from "./catalog.js";
import { LINE_FIELD, type Capture } from "./csv.js";

/**
 * Reader for BBB's published business-profile sitemaps.
 *
 * What this is and is not: BBB's robots.txt lists these sitemaps and permits
 * profile pages, but the profile pages themselves answer automated requests with
 * a 403 challenge, so they are not fetched. The sitemaps alone say that a profile
 * exists, where, in which category, and under what name. No rating is read.
 *
 * The index lists about 580 files of 10,000 URLs, ordered by BBB chapter number.
 * A binary search finds the files that hold one chapter, so a run reads about 25
 * files instead of all of them.
 */

const USER_AGENT = "oracle-pipeline-miami-dade/0.1 (public-records ingestion; respects robots.txt)";
const PAUSE_MS = 1000;

export const parseLocs = (xml: string): string[] => [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => (m[1] as string).trim());

export interface Profile {
  bbb_id: string;
  chapter: string;
  state: string;
  city: string;
  category: string;
  name_slug: string;
  profile_url: string;
}

/** `https://www.bbb.org/us/fl/miami/profile/roofing-contractors/victor-roofing-0633-11004556` */
export function parseProfileUrl(url: string): Profile | null {
  const m = /^https:\/\/www\.bbb\.org\/us\/([a-z]{2})\/([^/]+)\/profile\/([^/]+)\/(.*)-(\d{4})-(\d+)$/.exec(url);
  if (!m) return null;
  const [, state, city, category, slug, chapter, id] = m as unknown as [string, string, string, string, string, string, string];
  return { bbb_id: `${chapter}-${id}`, chapter, state, city, category, name_slug: slug, profile_url: url };
}

const chapterOf = (url: string | undefined): string | null => (url ? (/-(\d{4})-\d+$/.exec(url)?.[1] ?? null) : null);

/**
 * Indexes of the files that can hold `chapter`, given that files are ordered by
 * chapter. `read(i)` returns the URLs in file i. Stops with an error if a file
 * read along the way is out of order, because the search would then be wrong.
 */
export async function filesForChapter(count: number, chapter: string, read: (index: number) => Promise<string[]>): Promise<number[]> {
  const bounds = async (index: number) => {
    const urls = await read(index);
    const first = chapterOf(urls[0]);
    const last = chapterOf(urls.at(-1));
    if (!first || !last || first > last) throw new Error(`sitemap file ${index + 1} is not ordered by chapter (${first}..${last})`);
    return { first, last };
  };
  // Lowest file whose last URL is at or past the chapter.
  let lo = 0;
  let hi = count - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if ((await bounds(mid)).last >= chapter) hi = mid;
    else lo = mid + 1;
  }
  const found: number[] = [];
  for (let i = lo; i < count; i++) {
    const { first, last } = await bounds(i);
    if (first > chapter) break;
    if (last >= chapter) found.push(i);
  }
  return found;
}

export async function captureBbbSitemap(source: BbbSitemapSource, rawDir: string, maxPages: number | null): Promise<Capture> {
  let requests = 0;
  const get = async (url: string): Promise<string> => {
    if (requests++ > 0) await new Promise((resolve) => setTimeout(resolve, PAUSE_MS));
    const response = await fetch(url, { headers: { "user-agent": USER_AGENT }, signal: AbortSignal.timeout(120_000) });
    // A refusal is an answer: stop rather than retry or work around it.
    if (!response.ok) throw new Error(`${url} returned HTTP ${response.status}; stopping`);
    return response.text();
  };

  const files = parseLocs(await get(source.url));
  if (files.length === 0) throw new Error(`${source.url} lists no sitemap files`);
  const cache = new Map<number, string[]>();
  const read = async (index: number) => {
    if (!cache.has(index)) cache.set(index, parseLocs(await get(files[index] as string)));
    return cache.get(index) as string[];
  };

  const wanted = await filesForChapter(files.length, source.chapter, read);
  const used = maxPages ? wanted.slice(0, maxPages) : wanted;
  const fetchedAt = new Date().toISOString();
  let line = 0;
  let total = 0;
  for (const [page, index] of used.entries()) {
    const lines: string[] = [];
    for (const url of await read(index)) {
      const profile = parseProfileUrl(url);
      if (!profile || profile.chapter !== source.chapter || profile.state !== source.state) continue;
      const { chapter: _chapter, ...attributes } = profile;
      const row: Record<string, unknown> = { [LINE_FIELD]: ++line, ...attributes };
      lines.push(JSON.stringify({
        ...row,
        _lon: null,
        _lat: null,
        _row_hash: rowHash(row, LINE_FIELD),
        _source_url: files[index],
        _fetched_at: fetchedAt,
      }));
    }
    total += lines.length;
    writeFileSync(join(rawDir, `part-${String(page).padStart(6, "0")}.ndjson`), lines.length ? lines.join("\n") + "\n" : "");
  }
  if (total === 0) throw new Error(`${source.key}: no profiles found for chapter ${source.chapter}`);
  console.log(`${source.key}: ${requests} requests, sitemap files ${used.map((i) => i + 1).join(", ")}`);

  return {
    fields: [
      { name: LINE_FIELD, type: "esriFieldTypeInteger" },
      ...["bbb_id", "state", "city", "category", "name_slug", "profile_url"].map((name) => ({ name, type: "esriFieldTypeString" })),
    ],
    oidField: LINE_FIELD,
    sourceCount: total,
    lastEditAt: null,
    pages: used.length,
    partial: used.length < wanted.length,
  };
}
