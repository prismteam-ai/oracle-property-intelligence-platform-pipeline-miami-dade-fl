"use client";

import { useState } from "react";

interface Attempt {
  gateway: string;
  independent: boolean;
  url: string;
  ok: boolean;
  status: number | null;
  ms: number;
  error: string | null;
}
interface Result {
  passed?: boolean;
  tooLarge?: boolean;
  via?: string | null;
  independentMatches?: number;
  attempts: Attempt[];
  error?: string;
}

/** Fetch this artifact from public gateways now and compare it with the manifest. */
export function VerifyButton({ cid }: { cid: string }) {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<Result | null>(null);

  async function run() {
    setBusy(true);
    setResult(null);
    try {
      const response = await fetch(`/api/verify?cid=${cid}`);
      setResult(await response.json());
    } catch (error) {
      setResult({ attempts: [], error: String(error) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <button onClick={run} disabled={busy}>
        {busy ? "Fetching…" : "Verify now"}
      </button>
      {result?.error && <div className="tag bad">{result.error}</div>}
      {result?.tooLarge && <div className="muted">Over 25 MB: verified at publish time, see the retrieval record.</div>}
      {result && !result.tooLarge && !result.error && (
        <div style={{ marginTop: 6 }}>
          <span className={`tag ${result.passed ? "ok" : "bad"}`}>
            {result.passed ? "Bytes match" : "Not matched"} on {result.independentMatches} independent gateway
            {result.independentMatches === 1 ? "" : "s"}
          </span>
          {result.via && <div className="muted">Checked by fetching {result.via} through this directory CID.</div>}
          <ul className="plain">
            {result.attempts.map((a) => (
              <li key={a.gateway}>
                <a href={a.url} target="_blank" rel="noreferrer">
                  {a.gateway}
                </a>{" "}
                {a.ok ? <span className="tag ok">match, {a.ms} ms</span> : <span className="tag warn">{a.error}</span>}
                {!a.independent && <span className="muted"> (pinning provider, not counted)</span>}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
