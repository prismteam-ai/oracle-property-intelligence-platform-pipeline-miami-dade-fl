import { z } from "zod";
import { query, queryReadOnly } from "./engine";
import { getEntity, searchEntities } from "./entities";
import { findPlace, getProperty, permitSearchInput, placeInput, propertyDetailInput, propertySearchInput, searchPermits, searchProperties } from "./queries";
import { getLatest, getSnapshotJson } from "./snapshot";

/**
 * The tool catalogue: one definition per capability, used unchanged by the
 * page's agent (Vercel AI SDK) and by the MCP endpoint. A tool has a name, a
 * description written for a model, a Zod input schema and a `run` function.
 *
 * Every result carries `evidence`: the SQL that ran and the snapshot it ran
 * against, so an answer can always be traced to published records.
 */
export interface ToolSpec<Schema extends z.ZodType = z.ZodType> {
  name: string;
  title: string;
  description: string;
  inputSchema: Schema;
  run: (input: z.output<Schema>) => Promise<unknown>;
}

const define = <Schema extends z.ZodType>(spec: ToolSpec<Schema>) => spec;

/** Keep tool output small enough for a model to read, without hiding how much matched. */
const agentLimit = z.number().int().min(1).max(50).default(15).describe("Maximum rows to return (the total match count is always reported)");

const pick = <T extends Record<string, unknown>>(row: T, keys: string[]) => Object.fromEntries(keys.map((k) => [k, row[k] ?? null]));

export const TOOLS = [
  define({
    name: "find_place",
    title: "Find a place",
    description:
      "Resolve a city or place name in Miami-Dade County (for example Hialeah, Coral Gables, Miami Beach) to coordinates. " +
      "Call this first when a question names a place rather than coordinates. The coordinates are the centre of that city's properties.",
    inputSchema: placeInput,
    run: async (input) => {
      const result = await findPlace(input);
      return { places: result.rows, evidence: { sql: result.sql, snapshot: result.snapshot } };
    },
  }),
  define({
    name: "search_properties",
    title: "Search properties in a radius",
    description:
      "Find properties within a radius of a point, optionally only those with a roof at least N years old, a last sale at least N years ago, " +
      "or an owner whose mailing address is out of the area. Returns the total match count and the oldest roofs first. " +
      "roof_basis says whether the roof year comes from a completed roof permit or from year built (a proxy).",
    inputSchema: propertySearchInput.extend({ limit: agentLimit }),
    run: async (input) => {
      const result = await searchProperties(input);
      return {
        total_matching_properties: Number(result.summary?.matches ?? 0),
        distinct_street_addresses: Number(result.summary?.addresses ?? 0),
        note: "Rows are one per street address; matches_at_address counts the matching units (for example condo units) at it.",
        roof_year_basis_counts: {
          roof_permit: Number(result.summary?.roof_from_permit ?? 0),
          year_built: Number(result.summary?.roof_from_year_built ?? 0),
          unknown: Number(result.summary?.roof_unknown ?? 0),
        },
        shown: result.shown,
        properties: result.rows.map((row) =>
          pick(row, [
            "folio", "site_address", "site_city", "site_zip", "owner_1", "owner_location", "mailing_city", "mailing_state",
            "year_built", "roof_year", "roof_basis", "roof_age_years", "roof_permit_number", "last_sale_date", "years_since_sale",
            "matches_at_address", "lat", "lon", "miles", "source_url",
          ]),
        ),
        evidence: { sql: result.sql, snapshot: result.snapshot },
      };
    },
  }),
  define({
    name: "search_permits",
    title: "Search permits in a radius",
    description:
      "Find building permits within a radius of a point, longest-open first, with the contractor printed on the permit. " +
      "By default only open roofing permits. The county publishes no status: a permit is 'open' when it has no certificate and its last " +
      "inspection was not approved or it was never inspected. County permits start in 2020. Where the licence number printed on " +
      "the permit is in Florida's DBPR licence file, the licensee, business name, standing (Current, Probation, Suspended), " +
      "activity and expiry are returned. bbb_profile_url links to the one BBB profile whose name equals the contractor's " +
      "(a name match, not a confirmed identity). BBB ratings themselves are not loaded.",
    inputSchema: permitSearchInput.extend({ limit: agentLimit }),
    run: async (input) => {
      const result = await searchPermits(input);
      return {
        total_matches: Number(result.summary?.matches ?? 0),
        shown: result.shown,
        permits: result.rows.map((row) =>
          pick(row, [
            "permit_number", "folio", "address", "roofing_kind", "application_type", "issued_date", "days_since_issued", "status",
            "contractor_name", "contractor_number", "state_licence_class", "contractor_county_status",
            "state_licence_found", "state_licensee_name", "state_business_name", "state_licence_standing",
            "state_licence_activity", "state_licence_expires", "bbb_profile_url", "bbb_profile_matched_on",
            "contractor_roofing_permits", "contractor_open_roofing_permits", "lat", "lon", "miles", "source_url",
          ]),
        ),
        bbb_rating: "not loaded for any contractor: BBB profile pages refuse automated requests. bbb_profile_url is where a person can read it.",
        evidence: { sql: result.sql, snapshot: result.snapshot },
      };
    },
  }),
  define({
    name: "get_property",
    title: "Get one property",
    description: "Return one property by its 13-digit folio number, with every county permit filed against it.",
    inputSchema: propertyDetailInput,
    run: async (input) => {
      const result = await getProperty(input);
      return { property: result.property, permits: result.permits, evidence: { sql: result.sql, snapshot: result.snapshot } };
    },
  }),
  define({
    name: "search_contractors",
    title: "Search contractors",
    description:
      "Find contractors named on county permits by part of their name or licence number. Ranked by roofing permits unless sort says otherwise: " +
      "use sort=open_roofing_permits for 'most open roofing permits'. Returns permit counts, " +
      "open roofing permits, Florida state licence standing where the licence number matched, and a BBB profile link where one matched by name.",
    inputSchema: z.object({
      q: z.string().max(80).default("").describe("Part of the contractor name or licence number; empty lists all contractors in rank order"),
      sort: z.enum(["roofing_permits", "open_roofing_permits", "permits"]).default("roofing_permits").describe("Which count to rank by, largest first"),
      limit: agentLimit,
    }),
    run: async (input) => {
      const result = await searchEntities({ kind: "contractor", ...input });
      return { total_matches: result.total, contractors: result.rows, evidence: { sql: result.sql, snapshot: result.snapshot } };
    },
  }),
  define({
    name: "get_contractor",
    title: "Get one contractor",
    description:
      "Return one contractor by the licence number printed on its permits, with the spellings of its name and its permits (open roofing permits first).",
    inputSchema: z.object({ contractorNumber: z.string().min(1).max(40) }),
    run: async (input) => {
      const result = await getEntity({ kind: "contractor", id: input.contractorNumber });
      return { contractor: result.entity, name_spellings: result.names, permits: result.related.slice(0, 40), evidence: { sql: result.sql, snapshot: result.snapshot } };
    },
  }),
  define({
    name: "search_owners",
    title: "Search owners",
    description:
      "Find property owners by part of their name, largest holdings first. An owner is one exact name and mailing address; different spellings stay separate. " +
      "Returns the mailing address, whether it is in or out of the county, and how many properties are held.",
    inputSchema: z.object({ q: z.string().max(80).default("").describe("Part of the owner name; empty lists the largest owners"), limit: agentLimit }),
    run: async (input) => {
      const result = await searchEntities({ kind: "owner", ...input });
      return { total_matches: result.total, owners: result.rows, evidence: { sql: result.sql, snapshot: result.snapshot } };
    },
  }),
  define({
    name: "dataset_info",
    title: "Dataset information",
    description:
      "Describe the published dataset: snapshot and manifest content IDs, row counts, coverage facts, sources with their limitations, " +
      "what is not loaded, and the columns of each table. Call this before writing SQL or when asked what the data covers.",
    inputSchema: z.object({}),
    run: async () => {
      const { publication, manifest } = await getLatest();
      const coverage = await getSnapshotJson<Record<string, unknown>>(manifest.root.cid, "coverage.json");
      const columns = await query<{ table_name: string; column_name: string; data_type: string }>(
        `SELECT table_name, column_name, data_type FROM information_schema.columns
         WHERE table_name IN ('property', 'permit', 'contractor', 'business', 'place') ORDER BY table_name, ordinal_position`,
      );
      const tables: Record<string, string[]> = {};
      for (const c of columns.rows) (tables[c.table_name] ??= []).push(`${c.column_name} ${c.data_type}`);
      return {
        county: manifest.county,
        snapshot: publication,
        row_counts: coverage.tables,
        coverage: coverage.facts,
        sources: coverage.sources,
        not_loaded: coverage.not_loaded,
        tables,
        notes: [
          "roof age = year(current_date) - roof_year; roof_basis is roof_permit, year_built or unknown.",
          "permit.is_open and permit.status are derived from inspection and certificate dates.",
          "contractor.state_licence_* come from Florida DBPR by exact licence number. business holds DBPR qualified-business registrations (name and address only).",
          "Distances: use lat/lon (WGS84 degrees). Every row has source_url, the public request it came from.",
        ],
      };
    },
  }),
  define({
    name: "query_sql",
    title: "Run a read-only SQL query",
    description:
      "Run one DuckDB SELECT over the tables property, permit, contractor, business and place for questions the other tools do not cover " +
      "(counts, groupings, rankings). Call dataset_info first for the columns. Only a single SELECT is accepted; at most 200 rows return.",
    inputSchema: z.object({ sql: z.string().min(8).max(4000).describe("One DuckDB SELECT statement") }),
    run: async ({ sql }) => {
      const result = await queryReadOnly(sql);
      return { rows: result.rows, row_count: result.rows.length, truncated: result.truncated, evidence: { sql: result.sql, ms: result.ms, snapshot: result.snapshot } };
    },
  }),
] as const;
