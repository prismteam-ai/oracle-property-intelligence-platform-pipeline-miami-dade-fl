import { createHash } from "node:crypto";

/**
 * Independent retrieval check: fetch an artifact by CID from public IPFS
 * gateways and compare the bytes with the manifest's size and SHA-256.
 *
 * `independent: false` marks the pinning vendor's own gateway. It is recorded
 * but never counts toward the two independent retrievals the check requires.
 */
export interface Gateway {
  name: string;
  independent: boolean;
  url: (cidAndPath: string) => string;
}

export const GATEWAYS: Gateway[] = [
  { name: "gateway.pinata.cloud", independent: true, url: (p) => `https://gateway.pinata.cloud/ipfs/${p}` },
  { name: "dget.top", independent: true, url: (p) => `https://dget.top/ipfs/${p}` },
  { name: "eu.orbitor.dev", independent: true, url: (p) => `https://eu.orbitor.dev/ipfs/${p}` },
  { name: "w3s.link", independent: true, url: (p) => `https://w3s.link/ipfs/${p}` },
  { name: "4everland.io", independent: true, url: (p) => `https://4everland.io/ipfs/${p}` },
  { name: "ipfs.filebase.io", independent: false, url: (p) => `https://ipfs.filebase.io/ipfs/${p}` },
];

export interface Attempt {
  gateway: string;
  independent: boolean;
  url: string;
  ok: boolean;
  status: number | null;
  size: number | null;
  sha256: string | null;
  ms: number;
  error: string | null;
}

async function fetchOnce(gateway: Gateway, cidAndPath: string, want: { size: number; sha256: string }): Promise<Attempt> {
  const url = gateway.url(cidAndPath);
  const started = Date.now();
  const base = { gateway: gateway.name, independent: gateway.independent, url };
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(300_000), redirect: "follow" });
    const hash = createHash("sha256");
    let size = 0;
    if (response.ok && response.body) {
      for await (const chunk of response.body) {
        hash.update(chunk);
        size += chunk.length;
      }
    }
    const sha256 = response.ok ? hash.digest("hex") : null;
    const ok = response.ok && size === want.size && sha256 === want.sha256;
    return {
      ...base, ok, status: response.status, size: response.ok ? size : null, sha256, ms: Date.now() - started,
      error: ok ? null : response.ok ? "bytes do not match the manifest" : `HTTP ${response.status}`,
    };
  } catch (error: any) {
    return {
      ...base, ok: false, status: null, size: null, sha256: null, ms: Date.now() - started,
      error: String(error?.cause?.code ?? error?.name ?? error),
    };
  }
}

/**
 * Try gateways in order until `need` independent ones return matching bytes.
 * Every attempt is returned, including failures, so the record is honest.
 */
export async function verifyRetrieval(
  cidAndPath: string,
  want: { size: number; sha256: string },
  need = 2,
  gateways: Gateway[] = GATEWAYS,
): Promise<{ independentMatches: number; attempts: Attempt[] }> {
  const attempts: Attempt[] = [];
  let independentMatches = 0;
  for (const gateway of gateways) {
    if (gateway.independent && independentMatches >= need) continue;
    let attempt = await fetchOnce(gateway, cidAndPath, want);
    // One retry after a pause: a freshly pinned CID can take a moment to be found.
    if (!attempt.ok && (attempt.status === null || attempt.status >= 429)) {
      await new Promise((resolve) => setTimeout(resolve, 15_000));
      attempt = await fetchOnce(gateway, cidAndPath, want);
    }
    attempts.push(attempt);
    if (attempt.ok && gateway.independent) independentMatches++;
  }
  return { independentMatches, attempts };
}
