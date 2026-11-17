"use client";

import { useCallback, useEffect, useState } from "react";

type Row = Record<string, string | number | boolean | null>;
type Kind = "contractor" | "owner" | "business";
interface List {
  rows: Row[];
  total: number;
  ms: number;
  snapshot: { id: string };
  error?: string;
}
interface Detail {
  kind: "contractor" | "owner";
  entity: Row | null;
  names: Row[];
  related: Row[];
  error?: string;
}

const LABEL: Record<Kind, string> = { contractor: "Contractors", owner: "Owners", business: "Businesses" };
const HINT: Record<Kind, string> = {
  contractor: "One row per licence number printed on county permits. Name spellings are counted, not merged; the state licence is joined by exact number.",
  owner: "One row per exact owner name and mailing address. Different spellings stay separate: merging them would be a guess.",
  business: "Florida DBPR qualified-business registrations: name, address and standing. Miami-Dade businesses first.",
};
const OWNER_IS: Record<string, string> = {
  at_property: "at the property",
  in_county: "elsewhere in the county",
  florida_outside_county: "Florida, outside the county",
  out_of_state: "out of state",
  foreign: "outside the US",
  unknown: "unknown",
};
const num = (value: unknown) => (value === null || value === undefined ? "—" : Number(value).toLocaleString());
const years = (days: unknown) => (days === null ? "—" : `${(Number(days) / 365.25).toFixed(1)} yr`);
const Source = ({ url, label }: { url: unknown; label: string }) =>
  url ? (
    <a href={String(url)} target="_blank" rel="noreferrer">
      {label}
    </a>
  ) : null;

function Licence({ row }: { row: Row }) {
  if (row.state_licence_found !== true) return <span className="muted">{row.contractor_number ? "not in the state licence file" : "—"}</span>;
  const good = row.state_licence_standing === "Current" && row.state_licence_activity === "Active";
  return (
    <span className={`tag ${good ? "ok" : "bad"}`}>
      {row.state_licence_standing}
      {row.state_licence_activity ? `, ${row.state_licence_activity}` : ""}
    </span>
  );
}

/** Browse the reconciled entities and follow each to the records it is linked to. */
export function Entities() {
  const [kind, setKind] = useState<Kind>("contractor");
  const [q, setQ] = useState("");
  const [list, setList] = useState<List | null>(null);
  const [detail, setDetail] = useState<Detail | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async (nextKind: Kind, text: string) => {
    setBusy(true);
    setDetail(null);
    try {
      setList(await fetch(`/api/entities?kind=${nextKind}&q=${encodeURIComponent(text)}`).then((r) => r.json()));
    } catch (error) {
      setList({ rows: [], total: 0, ms: 0, snapshot: { id: "" }, error: String(error) });
    } finally {
      setBusy(false);
    }
  }, []);

  // Initial list: the busiest roofing contractors.
  useEffect(() => {
    let live = true;
    fetch(`/api/entities?kind=contractor&q=`)
      .then((r) => r.json())
      .then((result) => live && setList(result))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, []);

  async function open(detailKind: "contractor" | "owner", id: unknown) {
    setBusy(true);
    try {
      setDetail(await fetch(`/api/entity?kind=${detailKind}&id=${encodeURIComponent(String(id))}`).then((r) => r.json()));
    } finally {
      setBusy(false);
    }
  }

  function choose(next: Kind) {
    setKind(next);
    setQ("");
    setList(null);
    void load(next, "");
  }

  return (
    <div>
      <div className="tabs">
        {(Object.keys(LABEL) as Kind[]).map((k) => (
          <button key={k} className={kind === k ? "active" : ""} onClick={() => choose(k)}>
            {LABEL[k]}
          </button>
        ))}
      </div>
      <p className="muted" style={{ fontSize: 13, margin: "0 0 6px" }}>
        {HINT[kind]}
      </p>
      <div className="controls">
        <label>
          Name contains
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && load(kind, q)}
            placeholder={kind === "contractor" ? "roofing, or a licence number" : kind === "owner" ? "for example LLC" : "for example roofing"}
            style={{ width: 240 }}
          />
        </label>
        <button className="primary" onClick={() => load(kind, q)} disabled={busy}>
          {busy ? "Searching…" : "Search"}
        </button>
      </div>
      {list?.error && <div className="note">{list.error}</div>}
      {list && !list.error && (
        <p className="muted" style={{ fontSize: 13 }}>
          {num(list.total)} {LABEL[kind].toLowerCase()} match; showing {list.rows.length} · answered in {list.ms} ms by DuckDB over snapshot{" "}
          <span className="mono">{list.snapshot.id}</span>
        </p>
      )}

      {list && !list.error && kind === "contractor" && (
        <div className="scroll" style={{ maxHeight: 420, overflowY: "auto" }}>
          <table>
            <thead>
              <tr>
                <th>Contractor</th>
                <th>Licence no.</th>
                <th className="num">Permits</th>
                <th className="num">Roofing</th>
                <th className="num">Open roofing</th>
                <th>State licence (DBPR)</th>
                <th>BBB</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {list.rows.map((row) => (
                <tr key={String(row.contractor_number)}>
                  <td>
                    {row.name}
                    {Number(row.name_variants) > 1 && <div className="muted">{num(row.name_variants)} spellings on permits</div>}
                  </td>
                  <td className="mono">{row.contractor_number}</td>
                  <td className="num">{num(row.permits)}</td>
                  <td className="num">{num(row.roofing_permits)}</td>
                  <td className="num">{num(row.open_roofing_permits)}</td>
                  <td>
                    <Licence row={row} />
                  </td>
                  <td>{row.bbb_profile_url ? <Source url={row.bbb_profile_url} label="profile (name match)" /> : <span className="muted">no profile matched</span>}</td>
                  <td>
                    <button onClick={() => open("contractor", row.contractor_number)}>Permits</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {list && !list.error && kind === "owner" && (
        <div className="scroll" style={{ maxHeight: 420, overflowY: "auto" }}>
          <table>
            <thead>
              <tr>
                <th>Owner</th>
                <th>Mailing address</th>
                <th>Owner is</th>
                <th className="num">Properties</th>
                <th>Source</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {list.rows.map((row) => (
                <tr key={String(row.owner_id)}>
                  <td>{row.name}</td>
                  <td>
                    {row.mailing_address ?? "—"}
                    <div className="muted">
                      {[row.mailing_city, row.mailing_state, row.mailing_zip].filter(Boolean).join(", ")}
                    </div>
                  </td>
                  <td>{OWNER_IS[String(row.owner_location)] ?? row.owner_location}</td>
                  <td className="num">{num(row.properties)}</td>
                  <td>
                    <Source url={row.source_url} label="county record" />
                  </td>
                  <td>
                    <button onClick={() => open("owner", row.owner_id)}>Properties</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {list && !list.error && kind === "business" && (
        <div className="scroll" style={{ maxHeight: 420, overflowY: "auto" }}>
          <table>
            <thead>
              <tr>
                <th>Business</th>
                <th>Address</th>
                <th>In Miami-Dade</th>
                <th>Standing</th>
                <th>Registered</th>
                <th>Source</th>
              </tr>
            </thead>
            <tbody>
              {list.rows.map((row) => (
                <tr key={String(row.business_key)}>
                  <td>
                    {row.name}
                    {row.dba_name && <div className="muted">doing business as {row.dba_name}</div>}
                  </td>
                  <td>
                    {row.address_1 ?? "—"}
                    <div className="muted">{[row.city, row.state, row.zip].filter(Boolean).join(", ")}</div>
                  </td>
                  <td>{row.in_miami_dade ? "yes" : "no"}</td>
                  <td>
                    <span className={`tag ${row.standing === "Current" && row.activity !== "Inactive" ? "ok" : "bad"}`}>
                      {row.standing ?? "—"}
                      {row.activity ? `, ${row.activity}` : ""}
                    </span>
                  </td>
                  <td>{row.registered_date ?? "—"}</td>
                  <td>
                    <Source url={row.source_url} label="DBPR file" />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {detail?.error && <div className="note">{detail.error}</div>}
      {detail && !detail.error && detail.entity && (
        <div style={{ marginTop: 14 }}>
          <h3 style={{ marginBottom: 4 }}>
            {detail.entity.name} {detail.kind === "contractor" && <span className="mono muted">{detail.entity.contractor_number}</span>}
          </h3>
          {detail.kind === "contractor" && (
            <p className="muted" style={{ fontSize: 13, margin: "0 0 6px" }}>
              {num(detail.entity.permits)} permits, {num(detail.entity.roofing_permits)} roofing, {num(detail.entity.open_roofing_permits)} open roofing ·{" "}
              {detail.entity.state_licence_found === true
                ? `state licensee ${detail.entity.state_licensee_name}, ${detail.entity.state_licence_standing}${detail.entity.state_licence_activity ? `, ${detail.entity.state_licence_activity}` : ""}${detail.entity.state_licence_expires ? `, expires ${detail.entity.state_licence_expires}` : ""}`
                : "not in the state licence file"}
              {detail.names.length > 1 && <> · spelled on permits as: {detail.names.map((n) => `${n.name} (${num(n.permits)})`).join("; ")}</>}
              {detail.entity.bbb_profile_url && (
                <>
                  {" · "}
                  <Source url={detail.entity.bbb_profile_url} label="BBB profile (name match)" />
                </>
              )}
            </p>
          )}
          {detail.kind === "owner" && (
            <p className="muted" style={{ fontSize: 13, margin: "0 0 6px" }}>
              Mailing address {detail.entity.mailing_address ?? "not recorded"}, {detail.entity.mailing_city} {detail.entity.mailing_state} ·{" "}
              {OWNER_IS[String(detail.entity.owner_location)]} · {detail.related.length}
              {detail.related.length === 200 ? "+" : ""} properties
            </p>
          )}
          <div className="scroll" style={{ maxHeight: 360, overflowY: "auto" }}>
            {detail.kind === "contractor" ? (
              <table>
                <thead>
                  <tr>
                    <th>Permit</th>
                    <th>Address</th>
                    <th>Work</th>
                    <th>Issued</th>
                    <th>Status (derived)</th>
                    <th className="num">Since issue</th>
                    <th>Source</th>
                  </tr>
                </thead>
                <tbody>
                  {detail.related.map((row) => (
                    <tr key={String(row.permit_number)}>
                      <td className="mono">{row.permit_number}</td>
                      <td>
                        {row.address}
                        <div className="muted mono">{row.folio}</div>
                      </td>
                      <td>{String(row.roofing_kind ?? row.application_type ?? "").replaceAll("_", " ")}</td>
                      <td>{row.issued_date}</td>
                      <td>
                        <span className={`tag ${row.is_open ? "bad" : "ok"}`}>{String(row.status).replaceAll("_", " ")}</span>
                      </td>
                      <td className="num">{years(row.days_since_issued)}</td>
                      <td>
                        <Source url={row.source_url} label="county record" />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <table>
                <thead>
                  <tr>
                    <th>Property</th>
                    <th>City</th>
                    <th>Use</th>
                    <th className="num">Year built</th>
                    <th className="num">Roof year</th>
                    <th>Last sale</th>
                    <th>Source</th>
                  </tr>
                </thead>
                <tbody>
                  {detail.related.map((row) => (
                    <tr key={String(row.folio)}>
                      <td>
                        {row.site_address ?? "—"} {row.site_unit ?? ""}
                        <div className="muted mono">{row.folio}</div>
                      </td>
                      <td>{row.site_city}</td>
                      <td>{row.land_use}</td>
                      <td className="num">{row.year_built ?? "—"}</td>
                      <td className="num">
                        {row.roof_year ?? "—"} <span className="muted">({String(row.roof_basis).replaceAll("_", " ")})</span>
                      </td>
                      <td>{row.last_sale_date ?? "—"}</td>
                      <td>
                        <Source url={row.source_url} label="county record" />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
