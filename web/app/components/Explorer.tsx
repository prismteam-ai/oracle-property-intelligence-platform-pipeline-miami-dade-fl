"use client";

import type { Map as LeafletMap, LayerGroup, Circle, Marker } from "leaflet";
import { useCallback, useEffect, useRef, useState } from "react";

type Row = Record<string, string | number | boolean | null>;
interface Result {
  rows: Row[];
  sql: string;
  ms: number;
  shown: number;
  summary: Record<string, string>;
  snapshot: { id: string; root_cid: string };
  error?: string;
}

const DOWNTOWN = { lat: 25.7743, lon: -80.1937 };
const STATUS_LABEL: Record<string, string> = {
  no_inspection: "No inspection recorded",
  last_inspection_not_approved: "Last inspection not approved",
  last_inspection_approved: "Last inspection approved",
  closed_certificate: "Certificate issued",
};
const BASIS_LABEL: Record<string, string> = { roof_permit: "roof permit", year_built: "year built", unknown: "unknown" };
const num = (value: unknown) => (value === null || value === undefined ? "—" : Number(value).toLocaleString());
const years = (days: unknown) => (days === null ? "—" : `${(Number(days) / 365.25).toFixed(1)} yr`);

export function Explorer() {
  const mapEl = useRef<HTMLDivElement>(null);
  const map = useRef<LeafletMap | null>(null);
  const layers = useRef<{ L: typeof import("leaflet"); results: LayerGroup; pin: Marker; ring: Circle } | null>(null);

  const [centre, setCentre] = useState(DOWNTOWN);
  // Kept as typed text so the box can be cleared and retyped; the radius used is always 0.1 to 25 miles.
  const [milesText, setMilesText] = useState("1");
  const miles = Math.min(25, Math.max(0.1, Number(milesText) || 1));
  const [minRoofAge, setMinRoofAge] = useState(15);
  const [minYearsOpen, setMinYearsOpen] = useState(0);
  const [minYearsSinceSale, setMinYearsSinceSale] = useState(0);
  const [ownerAway, setOwnerAway] = useState(false);
  const [licence, setLicence] = useState("");
  const [tab, setTab] = useState<"roofs" | "permits">("roofs");
  const [place, setPlace] = useState("");
  const [busy, setBusy] = useState(false);
  const [roofs, setRoofs] = useState<Result | null>(null);
  const [permits, setPermits] = useState<Result | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  // Create the map once.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const L = (await import("leaflet")).default;
      if (cancelled || !mapEl.current || map.current) return;
      const m = L.map(mapEl.current, { preferCanvas: true }).setView([DOWNTOWN.lat, DOWNTOWN.lon], 14);
      L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
        maxZoom: 19,
        attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
      }).addTo(m);
      const icon = L.divIcon({ html: "📍", className: "", iconSize: [24, 24], iconAnchor: [12, 22] });
      const pin = L.marker([DOWNTOWN.lat, DOWNTOWN.lon], { icon }).addTo(m);
      const ring = L.circle([DOWNTOWN.lat, DOWNTOWN.lon], { radius: 1609.34, color: "#0b6bcb", fillOpacity: 0.05 }).addTo(m);
      const results = L.layerGroup().addTo(m);
      m.on("click", (event) => setCentre({ lat: event.latlng.lat, lon: event.latlng.lng }));
      map.current = m;
      layers.current = { L, results, pin, ring };
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Keep the pin and radius ring in step with the controls.
  useEffect(() => {
    const l = layers.current;
    if (!l) return;
    l.pin.setLatLng([centre.lat, centre.lon]);
    l.ring.setLatLng([centre.lat, centre.lon]).setRadius(miles * 1609.34);
  }, [centre, miles]);

  const draw = useCallback((rows: Row[], colour: (row: Row) => string, label: (row: Row) => string) => {
    const l = layers.current;
    if (!l || !map.current) return;
    l.results.clearLayers();
    for (const row of rows) {
      if (row.lat === null || row.lon === null) continue;
      l.L.circleMarker([Number(row.lat), Number(row.lon)], { radius: 5, color: colour(row), weight: 1, fillOpacity: 0.7 })
        .bindPopup(label(row))
        .addTo(l.results);
    }
    map.current.fitBounds(l.ring.getBounds(), { padding: [10, 10] });
  }, []);

  const search = useCallback(async () => {
    setBusy(true);
    setMessage(null);
    const base = `lat=${centre.lat}&lon=${centre.lon}&miles=${miles}`;
    try {
      const [a, b] = await Promise.all([
        fetch(
          `/api/properties?${base}&minRoofAge=${minRoofAge}&limit=300` +
            (minYearsSinceSale > 0 ? `&minYearsSinceSale=${minYearsSinceSale}` : "") +
            (ownerAway ? `&ownerLocation=florida_outside_county,out_of_state,foreign` : ""),
        ).then((r) => r.json()),
        fetch(
          `/api/permits?${base}&minDaysOpen=${Math.round(minYearsOpen * 365.25)}&limit=300` + (licence ? `&contractorLicence=${licence}` : ""),
        ).then((r) => r.json()),
      ]);
      if (a.error || b.error) setMessage(a.error ?? b.error);
      setRoofs(a.error ? null : a);
      setPermits(b.error ? null : b);
    } catch (error) {
      setMessage(String(error));
    } finally {
      setBusy(false);
    }
  }, [centre, miles, minRoofAge, minYearsOpen, minYearsSinceSale, ownerAway, licence]);

  // Redraw markers when results or the visible tab change.
  useEffect(() => {
    if (tab === "roofs" && roofs) {
      draw(
        roofs.rows,
        (row) => (row.roof_basis === "roof_permit" ? "#17803d" : "#b25a00"),
        (row) => `${row.site_address ?? row.folio}<br>Roof ${row.roof_year} (${BASIS_LABEL[String(row.roof_basis)]}), ${row.roof_age_years} yr`,
      );
    }
    if (tab === "permits" && permits) {
      draw(
        permits.rows,
        () => "#b3261e",
        (row) => `${row.address}<br>Permit ${row.permit_number}, issued ${row.issued_date}<br>${row.contractor_name ?? "No contractor printed"}`,
      );
    }
  }, [tab, roofs, permits, draw]);

  async function goToPlace() {
    if (!place.trim()) return;
    const result = await fetch(`/api/places?name=${encodeURIComponent(place)}`).then((r) => r.json());
    const hit = result.rows?.[0];
    if (!hit) return setMessage(`No place named "${place}" in the property roll.`);
    setMessage(null);
    setCentre({ lat: Number(hit.lat), lon: Number(hit.lon) });
    map.current?.setView([Number(hit.lat), Number(hit.lon)], 13);
  }

  function useMyLocation() {
    navigator.geolocation?.getCurrentPosition(
      (position) => {
        const next = { lat: position.coords.latitude, lon: position.coords.longitude };
        setCentre(next);
        map.current?.setView([next.lat, next.lon], 14);
      },
      () => setMessage("Location was not shared. Click the map to drop a pin instead."),
    );
  }

  const active = tab === "roofs" ? roofs : permits;

  return (
    <div>
      <div className="controls">
        <label>
          Go to a city
          <span style={{ display: "flex", gap: 6 }}>
            <input value={place} onChange={(e) => setPlace(e.target.value)} onKeyDown={(e) => e.key === "Enter" && goToPlace()} placeholder="Hialeah" />
            <button onClick={goToPlace}>Go</button>
          </span>
        </label>
        <button onClick={useMyLocation}>Use my location</button>
        <label>
          Radius (miles)
          <input type="number" min={0.1} max={25} step={0.1} value={milesText} onChange={(e) => setMilesText(e.target.value)} onBlur={() => setMilesText(String(miles))} />
        </label>
        <label>
          Roof older than (years)
          <input type="number" min={0} max={150} value={minRoofAge} onChange={(e) => setMinRoofAge(Number(e.target.value) || 0)} />
        </label>
        <label>
          Permit open at least (years)
          <input type="number" min={0} max={50} step={0.5} value={minYearsOpen} onChange={(e) => setMinYearsOpen(Number(e.target.value) || 0)} />
        </label>
        <label>
          Not sold for at least (years)
          <input type="number" min={0} max={100} value={minYearsSinceSale} onChange={(e) => setMinYearsSinceSale(Number(e.target.value) || 0)} />
        </label>
        <label>
          Permit contractor&apos;s state licence
          <select value={licence} onChange={(e) => setLicence(e.target.value)}>
            <option value="">Any</option>
            <option value="problem">Probation, suspended or inactive</option>
            <option value="not_in_state_file">Not in the state licence file</option>
            <option value="current_active">Current and active</option>
          </select>
        </label>
        <label style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
          <input type="checkbox" checked={ownerAway} onChange={(e) => setOwnerAway(e.target.checked)} />
          Owner&apos;s mailing address is outside the county
        </label>
        <button className="primary" onClick={search} disabled={busy}>
          {busy ? "Searching…" : "Search this area"}
        </button>
      </div>
      <div className="muted" style={{ fontSize: 13 }}>
        Click the map to move the pin. Centre {centre.lat.toFixed(5)}, {centre.lon.toFixed(5)}.
      </div>
      <div ref={mapEl} className="map" style={{ marginTop: 8 }} />
      {message && <div className="note">{message}</div>}

      <div className="tabs">
        <button className={tab === "roofs" ? "active" : ""} onClick={() => setTab("roofs")}>
          Older roofs {roofs ? `(${num(roofs.summary.matches)})` : ""}
        </button>
        <button className={tab === "permits" ? "active" : ""} onClick={() => setTab("permits")}>
          Open roofing permits {permits ? `(${num(permits.summary.matches)})` : ""}
        </button>
      </div>

      {!active && <p className="muted">Search an area to see results. The first search after idle loads the tables from IPFS and takes a few seconds.</p>}

      {active && (
        <p className="muted" style={{ margin: "4px 0" }}>
          Showing {num(active.shown)} {tab === "roofs" ? "addresses" : "permits"} of {num(active.summary.matches)} matching{" "}
          {tab === "roofs" ? "properties" : "permits"} · answered in {active.ms} ms by DuckDB over snapshot{" "}
          <span className="mono">{active.snapshot.id}</span>
          {tab === "roofs" && roofs && (
            <>
              {" "}
              · roof year dated by a completed roof permit: {num(roofs.summary.roof_from_permit)}, by year built: {num(roofs.summary.roof_from_year_built)}{" "}
              (county permits start in 2020, so a roof older than 6 years can only be dated by year built)
            </>
          )}
        </p>
      )}

      {tab === "roofs" && roofs && (
        <div className="scroll">
          <table>
            <thead>
              <tr>
                <th>Property</th>
                <th className="num">Roof year</th>
                <th>Basis</th>
                <th className="num">Roof age</th>
                <th>Owner</th>
                <th>Owner is</th>
                <th>Last sale</th>
                <th className="num">Miles</th>
                <th>Coordinates</th>
                <th>Source</th>
              </tr>
            </thead>
            <tbody>
              {roofs.rows.map((row) => (
                <tr key={String(row.folio)}>
                  <td>
                    {row.site_address ?? "No site address"}
                    <div className="muted mono">{row.folio}</div>
                    {Number(row.matches_at_address) > 1 && <div className="muted">{num(row.matches_at_address)} matching units at this address</div>}
                  </td>
                  <td className="num">{row.roof_year}</td>
                  <td>
                    <span className={`tag ${row.roof_basis === "roof_permit" ? "ok" : "warn"}`}>{BASIS_LABEL[String(row.roof_basis)]}</span>
                    {row.roof_permit_number && <div className="muted mono">{row.roof_permit_number}</div>}
                  </td>
                  <td className="num">{row.roof_age_years} yr</td>
                  <td>{row.owner_1 ?? "—"}</td>
                  <td>{String(row.owner_location).replaceAll("_", " ")}</td>
                  <td>{row.last_sale_date ? `${row.last_sale_date} (${row.years_since_sale} yr)` : "—"}</td>
                  <td className="num">{row.miles}</td>
                  <td className="mono">
                    {Number(row.lat).toFixed(5)}, {Number(row.lon).toFixed(5)}
                  </td>
                  <td>
                    <a href={String(row.source_url)} target="_blank" rel="noreferrer">
                      county record
                    </a>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {tab === "permits" && permits && (
        <div className="scroll">
          <table>
            <thead>
              <tr>
                <th>Permit</th>
                <th>Address</th>
                <th>Work</th>
                <th>Issued</th>
                <th className="num">Open for</th>
                <th>Status (derived)</th>
                <th>Contractor</th>
                <th>Licence (Florida DBPR)</th>
                <th>BBB</th>
                <th className="num">Miles</th>
                <th>Source</th>
              </tr>
            </thead>
            <tbody>
              {permits.rows.map((row) => (
                <tr key={String(row.permit_number)}>
                  <td className="mono">{row.permit_number}</td>
                  <td>
                    {row.address}
                    <div className="muted mono">{row.folio}</div>
                  </td>
                  <td>
                    {String(row.roofing_kind ?? row.application_type).replaceAll("_", " ")}
                    <div className="muted">{row.category ?? row.description ?? ""}</div>
                  </td>
                  <td>{row.issued_date}</td>
                  <td className="num">{years(row.days_since_issued)}</td>
                  <td>
                    <span className="tag bad">{STATUS_LABEL[String(row.status)] ?? row.status}</span>
                  </td>
                  <td>
                    {row.contractor_name ?? "None printed"}
                    {row.contractor_roofing_permits !== null && (
                      <div className="muted">
                        {num(row.contractor_roofing_permits)} roofing permits, {num(row.contractor_open_roofing_permits)} open
                      </div>
                    )}
                  </td>
                  <td>
                    <span className="mono">{row.contractor_number ?? "—"}</span>
                    {row.state_licence_found === true && (
                      <div>
                        <span className={`tag ${row.state_licence_standing === "Current" && row.state_licence_activity === "Active" ? "ok" : "bad"}`}>
                          {row.state_licence_standing}
                          {row.state_licence_activity ? `, ${row.state_licence_activity}` : ""}
                        </span>
                        <div className="muted">
                          {row.state_licensee_name}
                          {row.state_licence_expires ? `, expires ${row.state_licence_expires}` : ""}
                        </div>
                      </div>
                    )}
                    {row.state_licence_found === false && row.contractor_number && <div className="muted">not in the state licence file</div>}
                  </td>
                  <td>
                    {row.bbb_profile_url ? (
                      <a href={String(row.bbb_profile_url)} target="_blank" rel="noreferrer" title="The one BBB profile whose name equals this contractor's. A name match, not a confirmed identity.">
                        profile
                      </a>
                    ) : (
                      <span className="muted">no profile matched</span>
                    )}
                    <div className="muted">rating not loaded</div>
                  </td>
                  <td className="num">{row.miles}</td>
                  <td>
                    <a href={String(row.source_url)} target="_blank" rel="noreferrer">
                      county record
                    </a>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {active && (
        <details style={{ marginTop: 8 }}>
          <summary>SQL that produced this result</summary>
          <code className="block">{active.sql}</code>
        </details>
      )}
    </div>
  );
}
