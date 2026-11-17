import { z } from "zod";
import { query, type QueryResult } from "./engine";

/**
 * The one query layer. The page, the agent's tools and the MCP endpoint all
 * call these functions, so they cannot disagree about what the data says.
 *
 * Inputs are validated with Zod. Values reach SQL only as bound parameters.
 * Ages and durations are computed here, at query time, never stored.
 */

const MILES_PER_DEGREE_LAT = 69.0;

/** Great-circle distance in miles from ($lat, $lon). */
const DISTANCE = `3958.8 * 2 * asin(sqrt(
  pow(sin(radians(lat - $lat) / 2), 2) +
  cos(radians($lat)) * cos(radians(lat)) * pow(sin(radians(lon - $lon) / 2), 2)))`;
/** Cheap bounding box first, so DuckDB can skip Parquet row groups. */
const IN_BOX = `lat BETWEEN $lat - $dlat AND $lat + $dlat AND lon BETWEEN $lon - $dlon AND $lon + $dlon`;

const area = z.object({
  lat: z.number().min(25.0).max(26.1).describe("Latitude of the search centre (Miami-Dade County)"),
  lon: z.number().min(-81.0).max(-80.0).describe("Longitude of the search centre"),
  miles: z.number().positive().max(25).default(1).describe("Search radius in miles"),
});

function areaParams(input: { lat: number; lon: number; miles: number }) {
  return {
    lat: input.lat,
    lon: input.lon,
    miles: input.miles,
    dlat: input.miles / MILES_PER_DEGREE_LAT,
    dlon: input.miles / (MILES_PER_DEGREE_LAT * Math.cos((input.lat * Math.PI) / 180)),
  };
}

export const propertySearchInput = area.extend({
  minRoofAge: z.number().int().min(0).max(150).optional().describe("Only roofs at least this many years old (15 is the usual lead threshold)"),
  roofBasis: z.enum(["roof_permit", "year_built"]).optional().describe("Only roofs dated by a completed roof permit, or only by year built"),
  minYearsSinceSale: z.number().int().min(0).max(150).optional().describe("Only properties whose last recorded sale is at least this many years ago"),
  ownerLocation: z
    .array(z.enum(["at_property", "in_county", "florida_outside_county", "out_of_state", "foreign", "unknown"]))
    .optional()
    .describe("Where the owner's mailing address is"),
  limit: z.number().int().min(1).max(500).default(100),
});
export type PropertySearchInput = z.input<typeof propertySearchInput>;

export async function searchProperties(raw: PropertySearchInput) {
  const input = propertySearchInput.parse(raw);
  const where = [IN_BOX, `${DISTANCE} <= $miles`];
  const params: Record<string, string | number> = areaParams(input);
  if (input.minRoofAge !== undefined) {
    where.push(`roof_year IS NOT NULL AND year(current_date) - roof_year >= $minRoofAge`);
    params.minRoofAge = input.minRoofAge;
  }
  if (input.roofBasis) {
    where.push(`roof_basis = $roofBasis`);
    params.roofBasis = input.roofBasis;
  }
  if (input.minYearsSinceSale !== undefined) {
    where.push(`last_sale_date IS NOT NULL AND date_sub('year', last_sale_date, current_date) >= $minYearsSinceSale`);
    params.minYearsSinceSale = input.minYearsSinceSale;
  }
  if (input.ownerLocation?.length) {
    // Enum values validated by Zod above; safe to inline.
    where.push(`owner_location IN (${input.ownerLocation.map((v) => `'${v}'`).join(", ")})`);
  }
  const filter = where.join("\n    AND ");

  const total = await query<{ matches: string; roof_from_permit: string; roof_from_year_built: string; roof_unknown: string; addresses: string }>(
    `SELECT count(*) AS matches,
            count(*) FILTER (roof_basis = 'roof_permit') AS roof_from_permit,
            count(*) FILTER (roof_basis = 'year_built') AS roof_from_year_built,
            count(*) FILTER (roof_basis = 'unknown') AS roof_unknown,
            count(DISTINCT (site_address, site_zip)) AS addresses
     FROM property WHERE ${filter}`,
    params,
  );
  const result = await query(
    `SELECT folio, site_address, site_unit, site_city, site_zip, land_use,
            owner_1, owner_location, mailing_city, mailing_state,
            year_built, roof_year, roof_basis, roof_permit_number, roof_permit_date,
            year(current_date) - roof_year AS roof_age_years,
            last_sale_date, date_sub('year', last_sale_date, current_date) AS years_since_sale,
            lat, lon, round(${DISTANCE}, 2) AS miles, source_url, fetched_at,
            count(*) OVER (PARTITION BY site_address, site_zip) AS matches_at_address
     FROM property WHERE ${filter}
     -- One row per street address: a condo building is one roof, not one lead per unit.
     QUALIFY row_number() OVER (PARTITION BY site_address, site_zip ORDER BY folio) = 1
     ORDER BY roof_age_years DESC NULLS LAST, miles, folio
     LIMIT ${input.limit}`,
    params,
  );
  return { ...result, summary: total.rows[0], shown: result.rows.length };
}

export const permitSearchInput = area.extend({
  roofingOnly: z.boolean().default(true).describe("Only roofing permits (re-roof, roof maintenance, new-construction roof, other roof work)"),
  openOnly: z.boolean().default(true).describe("Only permits with no approved last inspection and no certificate"),
  minDaysOpen: z.number().int().min(0).optional().describe("Only permits issued at least this many days ago"),
  contractorLicence: z
    .enum(["current_active", "problem", "not_in_state_file"])
    .optional()
    .describe(
      "Filter by the contractor's Florida state licence: current_active = standing Current and activity Active; " +
        "problem = found but on Probation, Suspended or Inactive; not_in_state_file = a contractor number is printed but is not in DBPR's licence file",
    ),
  limit: z.number().int().min(1).max(500).default(100),
});
export type PermitSearchInput = z.input<typeof permitSearchInput>;

export async function searchPermits(raw: PermitSearchInput) {
  const input = permitSearchInput.parse(raw);
  // `lat` and `lon` exist only on permit (taken from its property), so they need no alias.
  const where = [IN_BOX, `${DISTANCE} <= $miles`];
  const params: Record<string, string | number> = areaParams(input);
  if (input.roofingOnly) where.push(`m.is_roofing`);
  if (input.openOnly) where.push(`m.is_open`);
  if (input.minDaysOpen !== undefined) {
    where.push(`date_diff('day', m.issued_date, current_date) >= $minDaysOpen`);
    params.minDaysOpen = input.minDaysOpen;
  }
  // Licence filters read the contractor table, so the count joins it too.
  if (input.contractorLicence === "current_active") {
    where.push(`c.state_licence_found AND c.state_licence_standing = 'Current' AND c.state_licence_activity = 'Active'`);
  } else if (input.contractorLicence === "problem") {
    where.push(`c.state_licence_found AND NOT (c.state_licence_standing = 'Current' AND coalesce(c.state_licence_activity, '') = 'Active')`);
  } else if (input.contractorLicence === "not_in_state_file") {
    where.push(`m.contractor_number IS NOT NULL AND NOT coalesce(c.state_licence_found, false)`);
  }
  const filter = where.join("\n    AND ");

  const total = await query<{ matches: string }>(
    `SELECT count(*) AS matches FROM permit m LEFT JOIN contractor c ON c.contractor_number = m.contractor_number WHERE ${filter}`,
    params,
  );
  const result = await query(
    `SELECT m.permit_number, m.folio, m.address, m.application_type, m.roofing_kind, m.category, m.description,
            m.issued_date, m.status, m.is_open, date_diff('day', m.issued_date, current_date) AS days_since_issued,
            m.last_inspection_date, m.last_approved_inspection_date, m.certificate_date,
            m.contractor_name, m.contractor_number,
            c.state_licence_class, c.county_status AS contractor_county_status,
            c.roofing_permits AS contractor_roofing_permits, c.open_roofing_permits AS contractor_open_roofing_permits,
            c.* EXCLUDE (contractor_number, name, name_variants, permits, roofing_permits, open_roofing_permits,
                         first_permit_date, last_permit_date, state_licence_class, county_status, county_source_url, source_url),
            m.lat, m.lon, round(${DISTANCE}, 2) AS miles, m.source_url, m.fetched_at
     FROM permit m LEFT JOIN contractor c ON c.contractor_number = m.contractor_number
     WHERE ${filter}
     ORDER BY m.issued_date, m.permit_number
     LIMIT ${input.limit}`,
    params,
  );
  return { ...result, summary: total.rows[0], shown: result.rows.length };
}

export const propertyDetailInput = z.object({ folio: z.string().regex(/^[0-9]{13}$/).describe("13-digit Miami-Dade folio number") });

export async function getProperty(raw: z.input<typeof propertyDetailInput>) {
  const { folio } = propertyDetailInput.parse(raw);
  const property = await query(`SELECT *, year(current_date) - roof_year AS roof_age_years FROM property WHERE folio = $folio`, { folio });
  const permits = await query(
    `SELECT m.*, date_diff('day', m.issued_date, current_date) AS days_since_issued,
            c.state_licence_class, c.county_status AS contractor_county_status,
            c.state_licence_found, c.state_licence_standing, c.state_licence_activity,
            c.bbb_profile_url, c.bbb_profile_matched_on
     FROM permit m LEFT JOIN contractor c ON c.contractor_number = m.contractor_number
     WHERE m.folio = $folio ORDER BY m.issued_date DESC`,
    { folio },
  );
  return { property: property.rows[0] ?? null, permits: permits.rows, sql: [property.sql, permits.sql], snapshot: property.snapshot };
}

export const placeInput = z.object({ name: z.string().min(2).max(60).describe("City or place name in Miami-Dade County, for example Hialeah") });

/** Resolve a place name to coordinates, using the centre of that city's properties. */
export async function findPlace(raw: z.input<typeof placeInput>): Promise<QueryResult> {
  const { name } = placeInput.parse(raw);
  return query(
    `SELECT name, properties, lat, lon FROM place
     WHERE name ILIKE $exact OR name ILIKE $partial
     ORDER BY (name ILIKE $exact) DESC, properties DESC LIMIT 5`,
    { exact: name.trim(), partial: `%${name.trim()}%` },
  );
}
