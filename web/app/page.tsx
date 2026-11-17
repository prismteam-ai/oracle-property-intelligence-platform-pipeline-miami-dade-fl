import { headers } from "next/headers";
import { Agent } from "./components/Agent";
import { Entities } from "./components/Entities";
import { Explorer } from "./components/Explorer";
import { VerifyButton } from "./components/VerifyButton";
import { getChecks, getLatest, getPublications, getSnapshotJson, READ_GATEWAYS } from "@/lib/snapshot";
import { TOOLS } from "@/lib/tools";

// Always read the current publication record: a new snapshot shows up without a redeploy.
export const dynamic = "force-dynamic";

interface SourceRun {
  run_id: string;
  status: string;
  started_at: string;
  finished_at: string;
  source_key: string;
  source_last_edit_at: string | null;
  source_count: number;
  fetched_rows: number;
  distinct_keys: number;
  duplicate_rows: number;
  rows_without_key: number;
  added: number;
  changed: number;
  removed: number | null;
  unchanged: number;
  pages: number;
  seconds: number;
  partial: boolean;
}
interface Coverage {
  tables: Record<string, number>;
  facts: Record<string, number | string>;
  sources: { key: string; entity: string; publisher: string; url: string; limitations: string[]; last_full_run: SourceRun | null }[];
  not_loaded: { what: string; why: string }[];
}

const n = (value: number | string | null | undefined) => (value === null || value === undefined ? "—" : Number(value).toLocaleString("en-US"));
const when = (iso: string | null | undefined) => (iso ? `${iso.replace("T", " ").slice(0, 19)} UTC` : "—");
const bytes = (size: number) => (size >= 1e6 ? `${(size / 1e6).toFixed(1)} MB` : size >= 1e3 ? `${(size / 1e3).toFixed(1)} kB` : `${size} B`);
const gateway = READ_GATEWAYS[0];
// Publication records live on the branch the scheduled run writes to.
const REPO = "https://github.com/jacksonkr/oracle-property-intelligence-platform-pipeline-miami-dade-fl/blob/ingest-history";

const FACT_LABELS: Record<string, string> = {
  properties_with_coordinates: "Properties with coordinates",
  roof_year_from_permit: "Roof year from a completed roof permit",
  roof_year_from_year_built: "Roof year from year built (proxy)",
  roof_year_unknown: "Roof year unknown",
  properties_with_last_sale: "Properties with a last sale date",
  permits_matched_to_property: "Permits matched to a property",
  roofing_permits: "Roofing permits",
  open_roofing_permits: "Open roofing permits",
  contractors_with_state_licence: "Permit contractors matched to a state licence",
  contractors_linked_to_bbb_profile: "Permit contractors linked to a BBB profile by name",
  qualified_businesses_in_miami_dade: "Qualified businesses registered in Miami-Dade",
};

export default async function Page() {
  const [publications, { publication, manifest }, checks] = await Promise.all([getPublications(), getLatest(), getChecks()]);
  const [coverage, runs] = await Promise.all([
    getSnapshotJson<Coverage>(manifest.root.cid, "coverage.json"),
    getSnapshotJson<SourceRun[]>(manifest.root.cid, "runs.json"),
  ]);
  const history = [...publications].reverse();
  const host = (await headers()).get("host") ?? "miami-dade-oracle.vercel.app";
  const mcpUrl = `${host.startsWith("localhost") || host.startsWith("127.") ? "http" : "https"}://${host}/api/mcp`;

  return (
    <main>
      <header className="top">
        <h1>Miami-Dade County Oracle pipeline</h1>
        <p>
          Public property, permit and contractor records for Miami-Dade County, Florida. Ingested incrementally from county sources,
          published to IPFS as content-addressed snapshots, and queried with DuckDB. No database server is running: this page reads the
          published files.
        </p>
        <nav className="sections">
          <a href="#run">Run summary</a>
          <a href="#sources">Records by source</a>
          <a href="#query">Query layer</a>
          <a href="#manifest">Artifact manifest</a>
          <a href="#history">Publication history</a>
          <a href="#explore">Explore</a>
          <a href="#agent">Ask the agent</a>
          <a href="#mcp">MCP</a>
        </nav>
      </header>

      <section className="panel" id="run">
        <h2>Pipeline run summary</h2>
        <p className="lead">
          Live snapshot <span className="mono">{manifest.snapshot_id}</span>, published {when(manifest.created_at)}. County:{" "}
          {manifest.county.name}, {manifest.county.state} (FIPS {manifest.county.fips}).
        </p>
        <div className="stats">
          {Object.entries(coverage.tables).map(([table, count]) => (
            <div className="stat" key={table}>
              <b>{n(count)}</b>
              <span>{table} rows</span>
            </div>
          ))}
        </div>
        <h3>Coverage</h3>
        <div className="stats">
          {Object.entries(FACT_LABELS)
            .filter(([key]) => coverage.facts[key] !== undefined)
            .map(([key, label]) => (
            <div className="stat" key={key}>
              <b>{n(coverage.facts[key])}</b>
              <span>{label}</span>
            </div>
          ))}
          <div className="stat">
            <b>
              {String(coverage.facts.permits_from)} → {String(coverage.facts.permits_to)}
            </b>
            <span>Permit issue dates covered</span>
          </div>
        </div>
        <h3>Documented limits</h3>
        <ul className="plain">
          {coverage.sources.flatMap((s) => s.limitations.map((limit) => <li key={s.key + limit}><b>{s.key}:</b> {limit}</li>))}
          {coverage.not_loaded.map((item) => (
            <li key={item.what}>
              <b>Not loaded — {item.what}:</b> {item.why}
            </li>
          ))}
        </ul>
      </section>

      <section className="panel" id="sources">
        <h2>Records by source</h2>
        <p className="lead">Each row keeps the exact public request that returned it and the time it was fetched.</p>
        <div className="scroll">
          <table>
            <thead>
              <tr>
                <th>Source</th>
                <th>Publisher</th>
                <th className="num">Publisher reports</th>
                <th className="num">Fetched</th>
                <th className="num">Loaded</th>
                <th className="num">Excluded</th>
                <th>Collected</th>
                <th>Publisher last edit</th>
                <th>Endpoint</th>
              </tr>
            </thead>
            <tbody>
              {coverage.sources.map((s) => {
                const run = s.last_full_run;
                return (
                  <tr key={s.key}>
                    <td>
                      <b>{s.key}</b>
                      <div className="muted">{s.entity}</div>
                    </td>
                    <td>{s.publisher}</td>
                    <td className="num">{n(run?.source_count)}</td>
                    <td className="num">{n(run?.fetched_rows)}</td>
                    <td className="num">{n(run?.distinct_keys)}</td>
                    <td className="num">
                      {run ? n(run.rows_without_key + run.duplicate_rows) : "—"}
                      {run && run.rows_without_key + run.duplicate_rows > 0 && (
                        <div className="muted">
                          {n(run.rows_without_key)} no key, {n(run.duplicate_rows)} duplicate
                        </div>
                      )}
                    </td>
                    <td>{when(run?.finished_at)}</td>
                    <td>{when(run?.source_last_edit_at)}</td>
                    <td>
                      <a href={s.url} target="_blank" rel="noreferrer">
                        {s.url.endsWith(".csv") ? "published file" : "ArcGIS layer"}
                      </a>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <h3>Run history</h3>
        <div className="scroll">
          <table>
            <thead>
              <tr>
                <th>Run</th>
                <th>Source</th>
                <th>Status</th>
                <th className="num">Added</th>
                <th className="num">Changed</th>
                <th className="num">Removed</th>
                <th className="num">Unchanged</th>
                <th className="num">Requests</th>
                <th className="num">Seconds</th>
              </tr>
            </thead>
            <tbody>
              {runs.map((run) => (
                <tr key={run.run_id + run.source_key}>
                  <td className="mono">{run.run_id}</td>
                  <td>{run.source_key}</td>
                  <td>
                    <span className={`tag ${run.status === "COMPLETE" ? "ok" : "warn"}`}>{run.status}</span>
                  </td>
                  <td className="num">{n(run.added)}</td>
                  <td className="num">{n(run.changed)}</td>
                  <td className="num">{n(run.removed)}</td>
                  <td className="num">{n(run.unchanged)}</td>
                  <td className="num">{n(run.pages)}</td>
                  <td className="num">{run.seconds.toFixed(1)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="panel" id="query">
        <h2>DuckDB query layer</h2>
        <p className="lead">
          The tables are Parquet files on IPFS. The server function downloads them by content ID, refuses any file whose SHA-256 differs
          from the manifest, and lets DuckDB read them in place. There is no hosted database, so nothing runs or bills between requests.
        </p>
        <ul className="plain">
          <li>
            Query the same files yourself with DuckDB:
            <code className="block">
              {`SELECT count(*) FROM read_parquet('${gateway}/${manifest.root.cid}/tables/property.parquet') WHERE roof_basis = 'roof_permit';`}
            </code>
          </li>
          <li>Every result on this page reports the SQL that produced it, how long it took, and the snapshot it came from.</li>
        </ul>
      </section>

      <section className="panel" id="manifest">
        <h2>Published artifact manifest</h2>
        <p className="lead">
          The content ID is the identity of each artifact. Gateway links below are derived from the IDs and are only a convenience. Each ID
          was fetched from two independent public gateways at publish time (
          <a href={`${REPO}/publications/${manifest.snapshot_id}/retrieval.json`}>retrieval record</a>); “Verify now” repeats the check live.
        </p>
        <table>
          <tbody>
            <tr>
              <th>Manifest</th>
              <td className="mono cid">
                <a href={`${gateway}/${publication.manifest_cid}`}>{publication.manifest_cid}</a>
              </td>
            </tr>
            <tr>
              <th>Snapshot directory</th>
              <td className="mono cid">
                <a href={`${gateway}/${manifest.root.cid}/`}>{manifest.root.cid}</a>
              </td>
            </tr>
            <tr>
              <th>CAR of the directory</th>
              <td className="mono cid">
                <a href={`${gateway}/${manifest.car.cid}`}>{manifest.car.cid}</a>{" "}
                <span className="muted">
                  ({bytes(manifest.car.size)}, {n(manifest.car.blocks)} blocks, SHA-256 {manifest.car.sha256})
                </span>
              </td>
            </tr>
          </tbody>
        </table>
        <div className="scroll" style={{ marginTop: 12 }}>
          <table>
            <thead>
              <tr>
                <th>Name</th>
                <th>Codec</th>
                <th className="num">Size</th>
                <th>CID</th>
                <th>SHA-256</th>
                <th>Independent retrieval</th>
              </tr>
            </thead>
            <tbody>
              {manifest.artifacts.map((artifact) => (
                <tr key={artifact.cid}>
                  <td>{artifact.name}</td>
                  <td>{artifact.codec}</td>
                  <td className="num">{bytes(artifact.size)}</td>
                  <td className="mono cid">
                    <a href={`${gateway}/${artifact.cid}${artifact.codec === "directory" ? "/" : ""}`}>{artifact.cid}</a>
                  </td>
                  <td className="mono cid">{artifact.sha256 ?? <span className="muted">directory</span>}</td>
                  <td>
                    <VerifyButton cid={artifact.cid} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="panel" id="history">
        <h2>Publication history</h2>
        <p className="lead">
          A new publication never changes an old one. Each snapshot has its own content IDs and names the snapshot before it, and earlier
          IDs keep resolving.
        </p>
        <div className="scroll">
          <table>
            <thead>
              <tr>
                <th>Snapshot</th>
                <th>Published</th>
                <th>Manifest CID</th>
                <th>Directory CID</th>
                <th>Previous manifest</th>
              </tr>
            </thead>
            <tbody>
              {history.map((entry, index) => (
                <tr key={entry.snapshot_id}>
                  <td className="mono">
                    {entry.snapshot_id} {index === 0 && <span className="tag ok">live</span>}
                  </td>
                  <td>{when(entry.created_at)}</td>
                  <td className="mono cid">
                    <a href={`${gateway}/${entry.manifest_cid}`}>{entry.manifest_cid}</a>
                  </td>
                  <td className="mono cid">
                    <a href={`${gateway}/${entry.root_cid}/`}>{entry.root_cid}</a>
                  </td>
                  <td className="mono cid">{entry.previous_manifest_cid ?? <span className="muted">first snapshot</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="panel" id="checks">
        <h2>Re-reads that found no change</h2>
        <p className="lead">
          The sources are re-read on a schedule. When no record was added, changed or removed, nothing is published: identical data keeps
          its content IDs, and the check is recorded here.
        </p>
        {checks.length === 0 ? (
          <p className="muted">None recorded yet.</p>
        ) : (
          <div className="scroll">
            <table>
              <thead>
                <tr>
                  <th>Checked</th>
                  <th>Compared with snapshot</th>
                  <th>Result</th>
                  <th className="num">Records re-read and unchanged</th>
                </tr>
              </thead>
              <tbody>
                {[...checks].reverse().map((check) => {
                  const latestBySource = new Map(check.runs.map((run) => [run.source_key, run.unchanged]));
                  return (
                    <tr key={check.checked_at}>
                      <td>{when(check.checked_at)}</td>
                      <td className="mono">{check.against_snapshot}</td>
                      <td>
                        <span className="tag ok">{check.result}</span>
                      </td>
                      <td className="num">{n([...latestBySource.values()].reduce((sum, value) => sum + value, 0))}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="panel" id="explore">
        <h2>Explore the data</h2>
        <p className="lead">
          Pick a point and a radius. Roof age comes from a completed roof permit where one exists, otherwise from year built, and the basis
          is shown on every row.
        </p>
        <div className="note">
          The county publishes no permit status. “Open” here means the permit has no certificate and its last inspection was not approved,
          or it was never inspected. County permits are available from 2020 onward.
        </div>
        <Explorer />
      </section>

      <section className="panel" id="entities">
        <h2>Browse entities and relationships</h2>
        <p className="lead">
          The reconciled contractors, owners and businesses. Open a contractor to see every permit filed under its licence number, or an
          owner to see every property held under that name and mailing address.
        </p>
        <Entities />
      </section>

      <section className="panel" id="agent">
        <h2>Ask the agent</h2>
        <p className="lead">
          Ask a roofing-lead question in plain language. The model only chooses which tools to call and words the answer; every count and
          record comes from SQL over the published snapshot, and the tool calls are shown under the answer so it can be checked.
        </p>
        <Agent />
      </section>

      <section className="panel" id="mcp">
        <h2>MCP endpoint</h2>
        <p className="lead">
          The same tools the agent uses are served over the Model Context Protocol (Streamable HTTP), so another agent or the roofing CRM
          can query this dataset without any change to the data model.
        </p>
        <code className="block">{mcpUrl}</code>
        <h3>Connect a client</h3>
        <code className="block">{`{ "mcpServers": { "miami-dade-oracle": { "type": "http", "url": "${mcpUrl}" } } }`}</code>
        <h3>Tools</h3>
        <div className="scroll">
          <table>
            <thead>
              <tr>
                <th>Tool</th>
                <th>What it does</th>
              </tr>
            </thead>
            <tbody>
              {TOOLS.map((tool) => (
                <tr key={tool.name}>
                  <td className="mono">{tool.name}</td>
                  <td>{tool.description}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <h3>Try it from a terminal</h3>
        <code className="block">
          {`curl -s ${mcpUrl} -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"query_sql","arguments":{"sql":"SELECT roof_basis, count(*) AS n FROM property GROUP BY 1"}}}'`}
        </code>
        <p className="muted" style={{ fontSize: 13.5 }}>
          <span className="mono">query_sql</span> accepts a single SELECT, checked by DuckDB&apos;s parser. The engine can read only the snapshot
          files: it cannot fetch URLs, load extensions or change its own settings.
        </p>
      </section>
    </main>
  );
}
