import { z } from "zod";
import { query, type QueryResult } from "./engine";

/**
 * Entity browsing: the reconciled contractors, owners and businesses, and what
 * each is linked to. Owners are grouped from the property table by `owner_id`
 * (exact name and mailing address), so no extra file is downloaded for them.
 */
export const entitySearchInput = z.object({
  kind: z.enum(["contractor", "owner", "business"]).describe("Which entity to list"),
  q: z.string().trim().max(80).default("").describe("Part of a name (or a contractor licence number). Empty lists the largest first"),
  limit: z.number().int().min(1).max(200).default(50),
  sort: z
    .enum(["roofing_permits", "open_roofing_permits", "permits"])
    .default("roofing_permits")
    .describe("Contractors only: which count to rank by, largest first"),
});
export type EntitySearchInput = z.input<typeof entitySearchInput>;

const LIKE = `'%' || $q || '%'`;

export async function searchEntities(raw: EntitySearchInput): Promise<QueryResult & { total: number }> {
  const { kind, q, limit, sort } = entitySearchInput.parse(raw);
  const count = async (sql: string) => Number((await query<{ n: string }>(sql, { q })).rows[0]?.n ?? 0);

  if (kind === "contractor") {
    const where = `($q = '' OR name ILIKE ${LIKE} OR contractor_number ILIKE ${LIKE} OR state_business_name ILIKE ${LIKE})`;
    const result = await query(
      `SELECT contractor_number, name, name_variants, permits, roofing_permits, open_roofing_permits,
              first_permit_date, last_permit_date, state_licence_class, county_status,
              state_licence_found, state_licensee_name, state_business_name, state_licence_standing,
              state_licence_activity, state_licence_expires, bbb_profile_url, bbb_profile_matched_on, source_url
       FROM contractor WHERE ${where}
       -- sort is one of three column names checked by Zod above; safe to inline.
       ORDER BY ${sort} DESC, roofing_permits DESC, permits DESC, contractor_number LIMIT ${limit}`,
      { q },
    );
    return { ...result, total: await count(`SELECT count(*) AS n FROM contractor WHERE ${where}`) };
  }

  if (kind === "owner") {
    const where = `owner_1 IS NOT NULL AND ($q = '' OR owner_1 ILIKE ${LIKE})`;
    const result = await query(
      `SELECT owner_id, min(owner_1) AS name, min(mailing_address) AS mailing_address, min(mailing_city) AS mailing_city,
              min(mailing_state) AS mailing_state, min(mailing_zip) AS mailing_zip, min(owner_location) AS owner_location,
              count(*) AS properties, count(DISTINCT site_city) AS cities, min(source_url) AS source_url
       FROM property WHERE ${where}
       GROUP BY owner_id ORDER BY properties DESC, name LIMIT ${limit}`,
      { q },
    );
    return { ...result, total: await count(`SELECT count(DISTINCT owner_id) AS n FROM property WHERE ${where}`) };
  }

  const where = `($q = '' OR name ILIKE ${LIKE} OR dba_name ILIKE ${LIKE})`;
  const result = await query(
    `SELECT business_key, name, dba_name, address_1, city, state, zip, in_miami_dade, standing, activity, registered_date, source_url
     FROM business WHERE ${where}
     ORDER BY in_miami_dade DESC, name, business_key LIMIT ${limit}`,
    { q },
  );
  return { ...result, total: await count(`SELECT count(*) AS n FROM business WHERE ${where}`) };
}

export const entityDetailInput = z.object({
  kind: z.enum(["contractor", "owner"]),
  id: z.string().trim().min(1).max(120).describe("contractor_number, or owner_id"),
});

/** One contractor with its permits and name spellings, or one owner with its properties. */
export async function getEntity(raw: z.input<typeof entityDetailInput>) {
  const { kind, id } = entityDetailInput.parse(raw);
  if (kind === "contractor") {
    const entity = await query(`SELECT * FROM contractor WHERE contractor_number = $id`, { id });
    const names = await query(
      `SELECT contractor_name AS name, count(*) AS permits FROM permit WHERE contractor_number = $id GROUP BY 1 ORDER BY 2 DESC, 1`,
      { id },
    );
    const related = await query(
      `SELECT permit_number, folio, address, application_type, roofing_kind, is_roofing, issued_date, status, is_open,
              date_diff('day', issued_date, current_date) AS days_since_issued, source_url
       FROM permit WHERE contractor_number = $id
       ORDER BY (is_roofing AND is_open) DESC, is_roofing DESC, issued_date, permit_number LIMIT 100`,
      { id },
    );
    return { kind, entity: entity.rows[0] ?? null, names: names.rows, related: related.rows, sql: [entity.sql, names.sql, related.sql], snapshot: entity.snapshot };
  }
  const related = await query(
    `SELECT folio, site_address, site_unit, site_city, site_zip, land_use, owner_1, owner_2, mailing_address, mailing_city, mailing_state,
            owner_location, year_built, roof_year, roof_basis, last_sale_date, lat, lon, source_url
     FROM property WHERE owner_id = $id ORDER BY site_city, site_address, folio LIMIT 200`,
    { id },
  );
  const first = related.rows[0];
  const entity = first
    ? { owner_id: id, name: first.owner_1, mailing_address: first.mailing_address, mailing_city: first.mailing_city, mailing_state: first.mailing_state, owner_location: first.owner_location }
    : null;
  return { kind, entity, names: [], related: related.rows, sql: [related.sql], snapshot: related.snapshot };
}
