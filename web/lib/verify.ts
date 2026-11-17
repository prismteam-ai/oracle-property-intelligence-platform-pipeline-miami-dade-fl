import { createHash } from "node:crypto";

/**
 * Live retrieval check, run from the server so the visitor's network does not
 * matter: fetch an artifact by CID from public gateways and compare the bytes
 * with the manifest. The pipeline runs the same check at publish time
 * (`src/gateways.ts`) and stores the evidence in Git; this one proves it still
 * holds right now.
 */
export const VERIFY_GATEWAYS = [
  // Chosen by measurement from this host's network: these answer server-side requests.
  { name: "gateway.pinata.cloud", independent: true, base: "https://gateway.pinata.cloud/ipfs" },
  { name: "eu.orbitor.dev", independent: true, base: "https://eu.orbitor.dev/ipfs" },
  // These often refuse or rate-limit data-centre traffic; kept so the record shows it.
  { name: "4everland.io", independent: true, base: "https://4everland.io/ipfs" },
  { name: "w3s.link", independent: true, base: "https://w3s.link/ipfs" },
  { name: "dget.top", independent: true, base: "https://dget.top/ipfs" },
  { name: "ipfs.filebase.io", independent: false, base: "https://ipfs.filebase.io/ipfs" },
];

/** Large artifacts are checked at publish time; a page click should not pull 150 MB through public gateways. */
export const MAX_LIVE_VERIFY_BYTES = 25 * 1024 * 1024;

export interface LiveAttempt {
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

export async function verifyLive(cidAndPath: string, want: { size: number; sha256: string }): Promise<LiveAttempt[]> {
  return Promise.all(
    VERIFY_GATEWAYS.map(async (gateway): Promise<LiveAttempt> => {
      const url = `${gateway.base}/${cidAndPath}`;
      const started = Date.now();
      const base = { gateway: gateway.name, independent: gateway.independent, url };
      try {
        const response = await fetch(url, { cache: "no-store", signal: AbortSignal.timeout(20_000) });
        if (!response.ok || !response.body) {
          return { ...base, ok: false, status: response.status, size: null, sha256: null, ms: Date.now() - started, error: `HTTP ${response.status}` };
        }
        const hash = createHash("sha256");
        let size = 0;
        for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
          hash.update(chunk);
          size += chunk.length;
        }
        const sha256 = hash.digest("hex");
        const ok = size === want.size && sha256 === want.sha256;
        return { ...base, ok, status: response.status, size, sha256, ms: Date.now() - started, error: ok ? null : "bytes do not match the manifest" };
      } catch (error) {
        const cause = (error as { cause?: { code?: string }; name?: string })?.cause?.code ?? (error as Error)?.name;
        return { ...base, ok: false, status: null, size: null, sha256: null, ms: Date.now() - started, error: String(cause ?? error) };
      }
    }),
  );
}
