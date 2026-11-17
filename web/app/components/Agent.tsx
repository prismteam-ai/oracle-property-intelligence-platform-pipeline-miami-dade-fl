"use client";

import { Fragment, useState } from "react";

interface Step {
  tool: string;
  input: Record<string, unknown>;
  output: Record<string, unknown>;
}
interface Reply {
  answer?: string;
  steps?: Step[];
  model?: string;
  error?: string;
}

const EXAMPLES = [
  "Which properties in Miami-Dade County within five miles of Hialeah have roofs older than 15 years?",
  "Which properties near Hialeah have open roofing permits that have been open for many years, and who is the listed contractor?",
  "Within 2 miles of Coral Gables, which properties with roofs over 20 years old have an out-of-state owner and have not sold in more than 10 years?",
];

/** Render the model's light Markdown (bold and line breaks) without a Markdown library. */
function Prose({ text }: { text: string }) {
  return (
    <div style={{ whiteSpace: "pre-wrap" }}>
      {text.split(/(\*\*[^*]+\*\*|\[[^\]]+\]\(https?:\/\/[^)\s]+\))/g).map((part, index) => {
        if (part.startsWith("**") && part.endsWith("**")) return <b key={index}>{part.slice(2, -2)}</b>;
        // A Markdown link, [label](https://...), becomes a real link. Only http(s) addresses are linked.
        const link = /^\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)$/.exec(part);
        if (link) {
          return (
            <a key={index} href={link[2]} target="_blank" rel="noreferrer">
              {link[1]}
            </a>
          );
        }
        return <Fragment key={index}>{part.replaceAll("`", "")}</Fragment>;
      })}
    </div>
  );
}

function rowsOf(output: Record<string, unknown>): Record<string, unknown>[] {
  for (const key of ["properties", "permits", "places", "rows"]) {
    const value = output[key];
    if (Array.isArray(value) && value.length) return value as Record<string, unknown>[];
  }
  return [];
}

function Evidence({ step }: { step: Step }) {
  const rows = rowsOf(step.output);
  const columns = rows[0] ? Object.keys(rows[0]) : [];
  const evidence = (step.output.evidence ?? {}) as { sql?: string | string[]; snapshot?: { id: string; root_cid: string } };
  const total = step.output.total_matching_properties ?? step.output.total_matches;
  return (
    <details style={{ margin: "6px 0" }}>
      <summary>
        <b>{step.tool}</b> {JSON.stringify(step.input)}
        {total !== undefined && <> → {Number(total).toLocaleString("en-US")} matches</>}
        {rows.length > 0 && <>, {rows.length} rows returned</>}
      </summary>
      {evidence.sql && <code className="block">{Array.isArray(evidence.sql) ? evidence.sql.join("\n\n") : evidence.sql}</code>}
      {evidence.snapshot && (
        <div className="muted" style={{ fontSize: 13 }}>
          Snapshot <span className="mono">{evidence.snapshot.id}</span>, directory <span className="mono cid">{evidence.snapshot.root_cid}</span>
        </div>
      )}
      {rows.length > 0 && (
        <div className="scroll">
          <table>
            <thead>
              <tr>
                {columns.map((c) => (
                  <th key={c}>{c}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row, index) => (
                <tr key={index}>
                  {columns.map((c) => (
                    <td key={c}>
                      {c === "source_url" && row[c] ? (
                        <a href={String(row[c])} target="_blank" rel="noreferrer">
                          county record
                        </a>
                      ) : (
                        String(row[c] ?? "—")
                      )}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </details>
  );
}

export function Agent() {
  const [question, setQuestion] = useState(EXAMPLES[0]);
  const [busy, setBusy] = useState(false);
  const [reply, setReply] = useState<Reply | null>(null);

  async function ask(text = question) {
    setQuestion(text);
    setBusy(true);
    setReply(null);
    try {
      const response = await fetch("/api/agent", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ question: text }) });
      setReply(await response.json());
    } catch (error) {
      setReply({ error: String(error) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <div className="controls" style={{ alignItems: "stretch" }}>
        <textarea
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          rows={2}
          style={{ flex: 1, minWidth: 260, font: "inherit", padding: 8, borderRadius: 6, border: "1px solid var(--line)", background: "var(--panel)", color: "var(--text)" }}
        />
        <button className="primary" onClick={() => ask()} disabled={busy || question.trim().length < 5}>
          {busy ? "Working…" : "Ask"}
        </button>
      </div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
        {EXAMPLES.map((example, index) => (
          <button key={index} onClick={() => ask(example)} disabled={busy} style={{ fontSize: 13, textAlign: "left" }}>
            {example}
          </button>
        ))}
      </div>
      {reply?.error && <div className="note">{reply.error}</div>}
      {reply?.answer && (
        <div style={{ marginTop: 12 }}>
          <Prose text={reply.answer} />
          <h3>Evidence: the tool calls behind this answer</h3>
          <p className="muted" style={{ margin: "0 0 4px", fontSize: 13 }}>
            The model ({reply.model}) chose the tools and wrote the text above. The numbers and rows below came from SQL over the published
            snapshot; open a call to see the query and the records.
          </p>
          {reply.steps?.map((step, index) => <Evidence key={index} step={step} />)}
        </div>
      )}
    </div>
  );
}
