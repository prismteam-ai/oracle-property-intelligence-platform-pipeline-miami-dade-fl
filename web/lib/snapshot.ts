/**
 * Which snapshot is live, and what it contains.
 *
 * The pipeline records each publication in Git under `publications/`. The site
 * reads that record at request time, so a new publication appears without a
 * redeploy. Everything else comes from IPFS by CID.
 */
const PUBLICATIONS_URL =
  process.env.PUBLICATIONS_URL ??
  "https://raw.githubusercontent.com/jacksonkr/oracle-property-intelligence-platform-pipeline-miami-dade-fl/ingest-history/publications";

/** Gateways tried in order for server-side reads. Bytes are checked against the manifest. */
export const READ_GATEWAYS = ["https://ipfs.filebase.io/ipfs", "https://gateway.pinata.cloud/ipfs"];

export interface Publication {
  snapshot_id: string;
  created_at: string;
  manifest_cid: string;
  root_cid: string;
  car_cid: string;
  previous_manifest_cid: string | null;
}

export interface Artifact {
  name: string;
  cid: string;
  codec: "file" | "directory";
  size: number;
  sha256: string | null;
}

export interface Manifest {
  schema: string;
  county: { name: string; state: string; fips: string; slug: string };
  snapshot_id: string;
  created_at: string;
  root: { cid: string; codec: "directory" };
  previous: { snapshot_id: string; manifest_cid: string; root_cid: string } | null;
  artifacts: Artifact[];
  car: Artifact & { roots: string[]; blocks: number };
}

// A small in-memory cache, five minutes per URL. It replaces the framework's fetch
// cache, which writes to disk and so cannot work on a read-only filesystem (Lambda).
const TTL_MS = 5 * 60_000;
const cached = new Map<string, { at: number; value: Promise<unknown> }>();

async function getJson<T>(url: string): Promise<T> {
  const hit = cached.get(url);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.value as Promise<T>;
  const value = (async () => {
    const response = await fetch(url, { cache: "no-store" });
    if (!response.ok) throw new Error(`${url} returned HTTP ${response.status}`);
    return (await response.json()) as T;
  })();
  cached.set(url, { at: Date.now(), value });
  value.catch(() => cached.delete(url));
  return value;
}

export async function getPublications(): Promise<Publication[]> {
  return getJson<Publication[]>(`${PUBLICATIONS_URL}/index.json`);
}

export interface NoChangeCheck {
  checked_at: string;
  against_snapshot: string;
  result: string;
  runs: { run_id: string; source_key: string; unchanged: number }[];
}

/** Scheduled runs that re-read the sources and found nothing to publish. */
export async function getChecks(): Promise<NoChangeCheck[]> {
  try {
    return await getJson<NoChangeCheck[]>(`${PUBLICATIONS_URL}/checks.json`);
  } catch {
    return [];
  }
}

export async function getManifest(snapshotId: string): Promise<Manifest> {
  return getJson<Manifest>(`${PUBLICATIONS_URL}/${snapshotId}/manifest.json`);
}

export async function getLatest(): Promise<{ publication: Publication; manifest: Manifest }> {
  const publications = await getPublications();
  const publication = publications.at(-1);
  if (!publication) throw new Error("No snapshot has been published yet");
  return { publication, manifest: await getManifest(publication.snapshot_id) };
}

/** Fetch a small JSON artifact from the snapshot directory by path. */
export async function getSnapshotJson<T>(rootCid: string, path: string): Promise<T> {
  let lastError: unknown;
  for (const gateway of READ_GATEWAYS) {
    try {
      return await getJson<T>(`${gateway}/${rootCid}/${path}`);
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}
