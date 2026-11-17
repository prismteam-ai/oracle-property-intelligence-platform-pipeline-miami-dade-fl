import type { DuckDBConnection } from "@duckdb/node-api";

/**
 * The query model: four tables derived from the source snapshots.
 *
 *   property    one row per folio, with the roof-age basis and owner location
 *   permit      one row per permit, with a derived status and a roofing flag
 *   contractor  one row per contractor number seen on permits, with its state licence
 *               and a link to a BBB profile of the same name where exactly one exists
 *   business    one row per Florida qualified-business registration
 *   owner       one row per distinct owner name + mailing address
 *   place       one row per site city, with the centre of its properties
 *
 * Rules that matter:
 * - Nothing here depends on today's date. Ages and open durations are computed
 *   at query time, so identical source data always produces identical tables.
 * - Every row keeps the source request it came from (`source_url`).
 * - Derived values say what they are derived from (`roof_basis`, `status`).
 * - Aggregates must be deterministic: use min/max, never any_value, or two
 *   builds of the same data produce different files and different CIDs.
 */

const ms = (column: string) => `make_timestamp(${column} * 1000)::DATE`;
const text = (column: string) => `nullif(trim(${column}), '')`;
const zip5 = (column: string) => `nullif(regexp_extract(${column}, '^[0-9]{5}'), '')`;

/** Trailing company-form words, ignored when comparing a contractor name with a BBB profile name. */
const COMPANY_FORM = `'(-(inc|llc|corp|co|incorporated|corporation|company|ltd|lc|pa))+$'`;
/** A name spelled the way BBB spells it in a profile URL: lower case, punctuation dropped, words joined by hyphens. */
const nameKey = (column: string) =>
  `regexp_replace(regexp_replace(trim(regexp_replace(replace(lower(${column}), '&', ' '), '[^a-z0-9 ]', '', 'g')), ' +', '-', 'g'), ${COMPANY_FORM}, '')`;

/** A roof covering category, excluding equipment mounted on a roof. */
const ROOF_CATEGORY = `(CategoryDescription1 ILIKE '%ROOF%' AND CategoryDescription1 NOT ILIKE '%ROOF MOUNTED%')`;

const PERMIT = `
CREATE OR REPLACE TABLE permit AS
SELECT
  PermitNumber                          AS permit_number,
  ${text("ProcessNumber")}              AS process_number,
  ${text("FolioNumber")}                AS folio,
  PermitType                            AS permit_type,
  ApplicationTypeDescription            AS application_type,
  ResidentialCommercial                 AS residential_commercial,
  ${text("DetailDescriptionComments")}  AS description,
  ${text("CategoryDescription1")}       AS category,
  ${text("PropertyAddress")}            AS address,
  try_cast(PermitIssuedDate AS DATE)    AS issued_date,
  ${ms("ApplicationDate")}              AS application_date,
  ${ms("LastInspectionDate")}           AS last_inspection_date,
  ${ms("LastApprovedInspDate")}         AS last_approved_inspection_date,
  try_strptime(${text("CoCcDate")}, '%m/%d/%Y')::DATE AS certificate_date,
  try_cast(EstimatedValue AS DOUBLE)    AS estimated_value,
  ${text("ContractorNumber")}           AS contractor_number,
  ${text("ContractorName")}             AS contractor_name,
  CASE
    WHEN ApplicationTypeDescription = 'RE-ROOF/REPAIR' THEN 'reroof'
    WHEN ApplicationTypeDescription = 'ROOF MAINTENANCE' THEN 'roof_maintenance'
    WHEN ApplicationTypeDescription = 'NEW' AND ${ROOF_CATEGORY} THEN 'new_construction_roof'
    WHEN ${ROOF_CATEGORY} THEN 'other_roof_work'
  END                                   AS roofing_kind,
  -- The county publishes no status column. This is what its dates support, no more.
  CASE
    WHEN ${text("CoCcDate")} IS NOT NULL THEN 'closed_certificate'
    WHEN LastInspectionDate IS NULL THEN 'no_inspection'
    WHEN LastApprovedInspDate IS NOT NULL AND LastApprovedInspDate >= LastInspectionDate
      THEN 'last_inspection_approved'
    ELSE 'last_inspection_not_approved'
  END                                   AS status,
  _source_url                           AS source_url,
  _fetched_at                           AS fetched_at
FROM src_permits;

ALTER TABLE permit ADD COLUMN is_roofing BOOLEAN;
ALTER TABLE permit ADD COLUMN is_open BOOLEAN;
UPDATE permit SET
  is_roofing = roofing_kind IS NOT NULL,
  is_open = status IN ('no_inspection', 'last_inspection_not_approved');
`;

const PROPERTY = `
CREATE OR REPLACE TEMP TABLE county_zip AS
SELECT DISTINCT ${zip5("TRUE_SITE_ZIP_CODE")} AS zip FROM src_properties
WHERE ${zip5("TRUE_SITE_ZIP_CODE")} IS NOT NULL;

-- The roof date a permit supports: the latest re-roof or new-construction roof
-- permit whose last inspection was approved or that has a certificate.
CREATE OR REPLACE TEMP TABLE roof_permit AS
SELECT folio, permit_number, contractor_number, contractor_name,
       coalesce(certificate_date, last_approved_inspection_date) AS roof_date
FROM permit
WHERE roofing_kind IN ('reroof', 'new_construction_roof')
  AND status IN ('closed_certificate', 'last_inspection_approved')
  AND folio IS NOT NULL
QUALIFY row_number() OVER (
  PARTITION BY folio
  ORDER BY coalesce(certificate_date, last_approved_inspection_date) DESC, permit_number DESC) = 1;

CREATE OR REPLACE TABLE property AS
WITH base AS (
  SELECT
    FOLIO                                 AS folio,
    ${text("TRUE_SITE_ADDR_NO_UNIT")}     AS site_address,
    ${text("TRUE_SITE_UNIT")}             AS site_unit,
    ${text("TRUE_SITE_CITY")}             AS site_city,
    ${zip5("TRUE_SITE_ZIP_CODE")}         AS site_zip,
    ${text("TRUE_OWNER1")}                AS owner_1,
    ${text("TRUE_OWNER2")}                AS owner_2,
    ${text("TRUE_MAILING_ADDR1")}         AS mailing_address,
    ${text("TRUE_MAILING_CITY")}          AS mailing_city,
    ${text("TRUE_MAILING_STATE")}         AS mailing_state,
    ${zip5("TRUE_MAILING_ZIP_CODE")}      AS mailing_zip,
    ${text("TRUE_MAILING_COUNTRY")}       AS mailing_country,
    ${text("DOR_DESC")}                   AS land_use,
    CONDO_FLAG = 'Y'                      AS is_condo,
    -- 0 and placeholder years (for example 9999) mean "not recorded".
    CASE WHEN YEAR_BUILT BETWEEN 1800 AND year(_fetched_at) + 1 THEN YEAR_BUILT END::INTEGER AS year_built,
    nullif(BUILDING_HEATED_AREA, 0)       AS building_area,
    nullif(LOT_SIZE, 0)                   AS lot_size,
    ASSESSED_VAL_CUR                      AS assessed_value,
    ${ms("DATEOFSALE_UTC")}               AS last_sale_date,
    nullif(PRICE_1, 0)                    AS last_sale_price,
    _lon AS lon, _lat AS lat,
    _source_url AS source_url, _fetched_at AS fetched_at
  FROM src_properties
)
SELECT
  b.*,
  -- Roof year: a completed roof permit beats year built; otherwise unknown.
  coalesce(year(r.roof_date), b.year_built)::INTEGER AS roof_year,
  CASE WHEN r.roof_date IS NOT NULL THEN 'roof_permit'
       WHEN b.year_built IS NOT NULL THEN 'year_built'
       ELSE 'unknown' END                 AS roof_basis,
  r.roof_date                             AS roof_permit_date,
  r.permit_number                         AS roof_permit_number,
  r.contractor_number                     AS roof_contractor_number,
  CASE
    WHEN b.mailing_address IS NULL THEN 'unknown'
    WHEN b.mailing_country IS NOT NULL AND upper(b.mailing_country) NOT IN ('USA', 'US', 'UNITED STATES') THEN 'foreign'
    WHEN b.mailing_state IS NOT NULL AND b.mailing_state <> 'FL' THEN 'out_of_state'
    WHEN z.zip IS NULL THEN 'florida_outside_county'
    WHEN b.mailing_zip = b.site_zip AND b.mailing_address = b.site_address THEN 'at_property'
    ELSE 'in_county'
  END                                     AS owner_location,
  md5(upper(coalesce(b.owner_1, '')) || '|' || upper(coalesce(b.mailing_address, '')) || '|' || coalesce(b.mailing_zip, ''))
                                          AS owner_id
FROM base b
LEFT JOIN roof_permit r ON r.folio = b.folio
LEFT JOIN county_zip z ON z.zip = b.mailing_zip;

-- A permit takes its location from the property it is filed against.
ALTER TABLE permit ADD COLUMN property_matched BOOLEAN;
ALTER TABLE permit ADD COLUMN lon DOUBLE;
ALTER TABLE permit ADD COLUMN lat DOUBLE;
UPDATE permit SET property_matched = false;
UPDATE permit SET property_matched = true, lon = p.lon, lat = p.lat
FROM property p WHERE p.folio = permit.folio;
`;

const CONTRACTOR = `
-- One row per contractor number printed on permits. Name variants are counted,
-- not merged: the number is the identity, the most-used name is the label.
CREATE OR REPLACE TABLE contractor AS
WITH state AS (
  -- The state licence whose number is printed on the permit. Where the file lists a
  -- number twice, the row with the latest expiry is used.
  SELECT alternate_license_number AS contractor_number,
         licensee_name, dba_name, primary_status, secondary_status,
         try_strptime(expiration_date, '%m/%d/%Y')::DATE AS expires,
         _source_url AS state_source_url
  FROM src_state_licences
  WHERE alternate_license_number IS NOT NULL
  QUALIFY row_number() OVER (
    PARTITION BY alternate_license_number
    ORDER BY try_strptime(expiration_date, '%m/%d/%Y') DESC NULLS LAST, _key) = 1
),
qualified AS (
  SELECT DISTINCT upper(trim(licensee_name)) AS name FROM src_state_licences
  WHERE occupation_code = 'QB' AND licensee_name IS NOT NULL
),
names AS (
  SELECT contractor_number, contractor_name, count(*) AS n
  FROM permit WHERE contractor_number IS NOT NULL GROUP BY ALL
),
county AS (
  SELECT CONTRACTOR_NUMBER AS contractor_number,
         min(CONTRACTOR_STATUS) AS county_status,
         min(_source_url) AS county_source_url
  FROM src_contractors GROUP BY 1
),
bbb AS (
  -- BBB profiles grouped by name. Only a name held by exactly one profile is linked.
  SELECT name_key, count(*) AS profiles, min(profile_url) AS profile_url,
         min(category) AS category, min(city) AS city, min(_source_url) AS bbb_source_url
  FROM (SELECT *, regexp_replace(name_slug, ${COMPANY_FORM}, '') AS name_key FROM src_bbb_profiles)
  WHERE length(name_key) >= 6
  GROUP BY name_key
),
base AS (
SELECT
  p.contractor_number,
  (SELECT contractor_name FROM names n WHERE n.contractor_number = p.contractor_number
   ORDER BY n DESC, contractor_name LIMIT 1) AS name,
  count(DISTINCT p.contractor_name)        AS name_variants,
  count(*)                                 AS permits,
  count(*) FILTER (p.is_roofing)           AS roofing_permits,
  count(*) FILTER (p.is_roofing AND p.is_open) AS open_roofing_permits,
  min(p.issued_date)                       AS first_permit_date,
  max(p.issued_date)                       AS last_permit_date,
  -- Florida state licence numbers start with a class prefix such as CCC (roofing) or CGC.
  nullif(regexp_extract(p.contractor_number, '^(C[A-Z]C)[A-Z]?[0-9]+$', 1), '') AS state_licence_class,
  c.county_status,
  c.county_source_url,
  min(p.source_url)                  AS source_url
FROM permit p LEFT JOIN county c USING (contractor_number)
WHERE p.contractor_number IS NOT NULL
GROUP BY p.contractor_number, c.county_status, c.county_source_url
)
SELECT
  b.*,
  -- Official identity: the state licence with exactly this number.
  s.contractor_number IS NOT NULL          AS state_licence_found,
  s.licensee_name                          AS state_licensee_name,
  s.dba_name                               AS state_business_name,
  CASE s.primary_status WHEN 'C' THEN 'Current' WHEN 'P' THEN 'Probation' WHEN 'S' THEN 'Suspended' END AS state_licence_standing,
  CASE s.secondary_status WHEN 'A' THEN 'Active' WHEN 'I' THEN 'Inactive' END AS state_licence_activity,
  s.expires                                AS state_licence_expires,
  s.state_source_url,
  -- A name match only: a qualified business with exactly this name exists. Not proof it is the same firm.
  q.name IS NOT NULL                       AS qualified_business_name_match,
  -- BBB: profiles whose name equals the permit name or the state business name. A name match only.
  coalesce(b1.profiles, b2.profiles, 0)::INTEGER AS bbb_profiles_with_name,
  CASE WHEN coalesce(b1.profiles, b2.profiles) = 1 THEN coalesce(b1.profile_url, b2.profile_url) END AS bbb_profile_url,
  -- Which of the contractor's names the profile name equals.
  CASE WHEN coalesce(b1.profiles, b2.profiles) = 1
       THEN CASE WHEN b1.profiles IS NOT NULL THEN 'permit_name' ELSE 'state_business_name' END END AS bbb_profile_matched_on,
  CASE WHEN coalesce(b1.profiles, b2.profiles) = 1 THEN coalesce(b1.category, b2.category) END AS bbb_profile_category,
  CASE WHEN coalesce(b1.profiles, b2.profiles) = 1 THEN coalesce(b1.city, b2.city) END AS bbb_profile_city,
  CASE WHEN coalesce(b1.profiles, b2.profiles) = 1 THEN coalesce(b1.bbb_source_url, b2.bbb_source_url) END AS bbb_source_url
FROM base b
LEFT JOIN state s USING (contractor_number)
LEFT JOIN qualified q ON q.name = upper(trim(b.name))
LEFT JOIN bbb b1 ON b1.name_key = ${nameKey("b.name")}
LEFT JOIN bbb b2 ON b2.name_key = ${nameKey("s.dba_name")};

-- Business records: Florida qualified-business registrations (name and address, no licence number).
CREATE OR REPLACE TABLE business AS
SELECT _key AS business_key,
       licensee_name AS name, dba_name,
       address_1, address_2, city, state, zip, county_code,
       coalesce(county_code = '23', false) AS in_miami_dade,
       CASE primary_status WHEN 'C' THEN 'Current' WHEN 'P' THEN 'Probation' WHEN 'S' THEN 'Suspended' END AS standing,
       CASE secondary_status WHEN 'A' THEN 'Active' WHEN 'I' THEN 'Inactive' END AS activity,
       try_strptime(original_licensure_date, '%m/%d/%Y')::DATE AS registered_date,
       _source_url AS source_url, _fetched_at AS fetched_at
FROM src_state_licences WHERE occupation_code = 'QB';
`;

const PLACE = `
-- Named places for "near <city>" questions: the centre of each site city's
-- properties. Derived from the roll itself, so no outside geocoder is needed.
CREATE OR REPLACE TABLE place AS
SELECT site_city AS name,
       count(*) AS properties,
       median(lat) AS lat,
       median(lon) AS lon
FROM property
WHERE site_city IS NOT NULL AND lat IS NOT NULL
GROUP BY site_city
HAVING count(*) >= 50;
`;

const OWNER = `
-- Owners reconciled by exact name and mailing address. Different spellings of
-- one owner stay separate: merging them would be a guess.
CREATE OR REPLACE TABLE owner AS
SELECT owner_id,
       min(owner_1) AS name,
       min(mailing_address) AS mailing_address,
       min(mailing_city) AS mailing_city,
       min(mailing_state) AS mailing_state,
       min(mailing_zip) AS mailing_zip,
       min(owner_location) AS owner_location,
       count(*) AS properties
FROM property WHERE owner_1 IS NOT NULL
GROUP BY owner_id;
`;

export async function buildModel(con: DuckDBConnection): Promise<void> {
  // County licence status is enrichment. If the county's contractor layer has never been read
  // into this store (it was empty when read), the model is built without it and says so by
  // leaving county_status empty.
  await con.run(`CREATE TABLE IF NOT EXISTS src_contractors (CONTRACTOR_NUMBER VARCHAR, CONTRACTOR_STATUS VARCHAR, _source_url VARCHAR)`);
  for (const sql of [PERMIT, PROPERTY, CONTRACTOR, OWNER, PLACE]) await con.run(sql);
}
