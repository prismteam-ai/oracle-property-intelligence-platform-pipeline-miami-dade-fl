import { DuckDBInstance, type DuckDBConnection } from "@duckdb/node-api";
import { beforeAll, describe, expect, it } from "vitest";
import { buildModel } from "../src/model.js";

/** Tiny hand-written source rows that exercise each derivation rule. */
const day = (iso: string) => Date.parse(`${iso}T05:00:00Z`);

let con: DuckDBConnection;
const one = async (sql: string) =>
  ((await con.runAndReadAll(sql)).getRowObjectsJson() as Record<string, any>[])[0] ?? {};

beforeAll(async () => {
  con = await (await DuckDBInstance.create(":memory:")).connect();
  await con.run(`
    CREATE TABLE src_properties AS SELECT * FROM (VALUES
      ('F1', '1 MAIN ST', NULL, 'MIAMI', '33101-0000', 'ANN OWNER', NULL, '1 MAIN ST', 'MIAMI', 'FL', '33101', 'USA', 'SINGLE FAMILY', 'N', 1990, 1500.0, 5000.0, 300000.0, ${day("2010-06-01")}, 250000.0, -80.2, 25.77),
      ('F2', '2 MAIN ST', NULL, 'MIAMI', '33101-0000', 'BOB LLC',   NULL, '9 ELM ST',  'AUSTIN', 'TX', '78701', 'USA', 'SINGLE FAMILY', 'N', 9999, 0.0, 0.0, 100000.0, NULL, 0.0, -80.21, 25.78),
      ('F3', '3 MAIN ST', NULL, 'MIAMI', '33101-0000', 'CAT OWNER', NULL, '5 OAK AVE', 'TAMPA', 'FL', '33602', 'USA', 'SINGLE FAMILY', 'N', 0, 0.0, 0.0, 100000.0, NULL, 0.0, -80.22, 25.79)
    ) t(FOLIO, TRUE_SITE_ADDR_NO_UNIT, TRUE_SITE_UNIT, TRUE_SITE_CITY, TRUE_SITE_ZIP_CODE, TRUE_OWNER1, TRUE_OWNER2,
        TRUE_MAILING_ADDR1, TRUE_MAILING_CITY, TRUE_MAILING_STATE, TRUE_MAILING_ZIP_CODE, TRUE_MAILING_COUNTRY,
        DOR_DESC, CONDO_FLAG, YEAR_BUILT, BUILDING_HEATED_AREA, LOT_SIZE, ASSESSED_VAL_CUR, DATEOFSALE_UTC, PRICE_1, _lon, _lat);
    ALTER TABLE src_properties ADD COLUMN _source_url VARCHAR DEFAULT 'https://example.test/p';
    ALTER TABLE src_properties ADD COLUMN _fetched_at TIMESTAMP DEFAULT TIMESTAMP '2026-11-17 00:00:00';

    CREATE TABLE src_permits AS SELECT * FROM (VALUES
      ('P1', 'W1', 'F1', 'BLDG', 'RE-ROOF/REPAIR', 'R', 'TILE TO TILE', 'TILE ROOF', '1 MAIN ST', '2021-03-01', ${day("2021-02-20")}, ${day("2021-05-10")}, ${day("2021-05-10")}, NULL, '12000', 'CCC111', 'ACME ROOFING'),
      ('P2', 'W2', 'F1', 'BLDG', 'RE-ROOF/REPAIR', 'R', NULL, 'TILE ROOF', '1 MAIN ST', '2024-01-15', ${day("2024-01-10")}, NULL, NULL, '   ', '9000', 'CCC111', 'ACME ROOFING INC'),
      ('P3', 'W3', 'F2', 'BLDG', 'RE-ROOF/REPAIR', 'R', NULL, 'TILE ROOF', '2 MAIN ST', '2022-07-01', ${day("2022-06-20")}, ${day("2022-09-01")}, ${day("2022-08-01")}, NULL, '5000', 'CCC222', 'BEST ROOFS'),
      ('P4', 'W4', 'F9', 'ELEC', 'ROOF MOUNTED INSTAL', 'R', NULL, 'RAISE EXISTING ROOF MOUNTED EQUIP', '9 X ST', '2023-01-01', ${day("2023-01-01")}, ${day("2023-02-01")}, ${day("2023-02-01")}, '03/01/2023', '100', NULL, 'SOLAR CO')
    ) t(PermitNumber, ProcessNumber, FolioNumber, PermitType, ApplicationTypeDescription, ResidentialCommercial,
        DetailDescriptionComments, CategoryDescription1, PropertyAddress, PermitIssuedDate, ApplicationDate,
        LastInspectionDate, LastApprovedInspDate, CoCcDate, EstimatedValue, ContractorNumber, ContractorName);
    ALTER TABLE src_permits ADD COLUMN _source_url VARCHAR DEFAULT 'https://example.test/m';
    ALTER TABLE src_permits ADD COLUMN _fetched_at TIMESTAMP DEFAULT TIMESTAMP '2026-11-17 00:00:00';

    CREATE TABLE src_contractors AS SELECT 'CCC111' AS CONTRACTOR_NUMBER, 'A' AS CONTRACTOR_STATUS, 'https://example.test/c' AS _source_url;

    CREATE TABLE src_state_licences AS SELECT * FROM (VALUES
      ('k1', 'CCC', '111', 'DOE, JANE', 'ACME ROOFING', 'C', 'A', '08/31/2028', '06/12/2006', 'CCC111', '1 A ST', NULL, 'MIAMI', 'FL', '33101', '23'),
      ('k2', 'CCC', '111', 'DOE, JANE', 'ACME ROOFING', 'C', 'I', '08/31/2024', '06/12/2006', 'CCC111', '1 A ST', NULL, 'MIAMI', 'FL', '33101', '23'),
      ('k3', 'QB',  NULL,  'BEST ROOFS', NULL,          'C', 'A', NULL,         '01/02/2010', NULL,     '2 B ST', NULL, 'TAMPA', 'FL', '33602', '39')
    ) t(_key, occupation_code, license_number, licensee_name, dba_name, primary_status, secondary_status,
        expiration_date, original_licensure_date, alternate_license_number, address_1, address_2, city, state, zip, county_code);
    ALTER TABLE src_state_licences ADD COLUMN _source_url VARCHAR DEFAULT 'https://example.test/dbpr.csv';
    ALTER TABLE src_state_licences ADD COLUMN _fetched_at TIMESTAMP DEFAULT TIMESTAMP '2026-11-17 00:00:00';
  `);
  await con.run(`
    CREATE TABLE src_bbb_profiles AS SELECT * FROM (VALUES
      ('0633-1', 'fl', 'miami', 'roofing-contractors', 'acme-roofing-inc', 'https://www.bbb.org/us/fl/miami/profile/roofing-contractors/acme-roofing-inc-0633-1'),
      ('0633-2', 'fl', 'doral', 'roofing-contractors', 'best-roofs', 'https://www.bbb.org/us/fl/doral/profile/roofing-contractors/best-roofs-0633-2'),
      ('0633-3', 'fl', 'miami', 'general-contractor', 'best-roofs-llc', 'https://www.bbb.org/us/fl/miami/profile/general-contractor/best-roofs-llc-0633-3')
    ) t(bbb_id, state, city, category, name_slug, profile_url);
    ALTER TABLE src_bbb_profiles ADD COLUMN _source_url VARCHAR DEFAULT 'https://example.test/sitemap-1.xml';
  `);
  await buildModel(con);
});

describe("permit status", () => {
  const status = async (id: string) => one(`SELECT status, is_open, is_roofing, roofing_kind FROM permit WHERE permit_number = '${id}'`);

  it("is closed when the last inspection was approved", async () => {
    expect(await status("P1")).toMatchObject({ status: "last_inspection_approved", is_open: false, roofing_kind: "reroof" });
  });
  it("is open when it was never inspected, and a blank certificate is not a certificate", async () => {
    expect(await status("P2")).toMatchObject({ status: "no_inspection", is_open: true });
  });
  it("is open when a later inspection was not approved", async () => {
    expect(await status("P3")).toMatchObject({ status: "last_inspection_not_approved", is_open: true });
  });
  it("does not count roof-mounted equipment as roofing work", async () => {
    expect(await status("P4")).toMatchObject({ status: "closed_certificate", is_roofing: false, roofing_kind: null });
  });
  it("flags permits whose folio is not in the property roll", async () => {
    expect(await one(`SELECT property_matched FROM permit WHERE permit_number = 'P4'`)).toEqual({ property_matched: false });
  });
});

describe("roof year", () => {
  const roof = async (folio: string) => one(`SELECT roof_year, roof_basis, roof_permit_number, year_built FROM property WHERE folio = '${folio}'`);

  it("uses a completed roof permit over year built, and ignores the open one", async () => {
    expect(await roof("F1")).toEqual({ roof_year: 2021, roof_basis: "roof_permit", roof_permit_number: "P1", year_built: 1990 });
  });
  it("is unknown when year built is a placeholder and the only roof permit is open", async () => {
    expect(await roof("F2")).toEqual({ roof_year: null, roof_basis: "unknown", roof_permit_number: null, year_built: null });
  });
  it("treats year 0 as not recorded", async () => {
    expect(await roof("F3")).toMatchObject({ roof_year: null, roof_basis: "unknown" });
  });
});

describe("owner location", () => {
  const where = async (folio: string) => (await one(`SELECT owner_location FROM property WHERE folio = '${folio}'`)).owner_location;

  it("classifies by mailing address", async () => {
    expect(await where("F1")).toBe("at_property");
    expect(await where("F2")).toBe("out_of_state");
    expect(await where("F3")).toBe("florida_outside_county");
  });
});

describe("permit location", () => {
  it("comes from the matched property, and stays empty without one", async () => {
    expect(await one(`SELECT lon, lat FROM permit WHERE permit_number = 'P1'`)).toEqual({ lon: -80.2, lat: 25.77 });
    expect(await one(`SELECT lon, lat FROM permit WHERE permit_number = 'P4'`)).toEqual({ lon: null, lat: null });
  });
});

describe("state licence", () => {
  const licence = async (number: string) =>
    one(`SELECT state_licence_found, state_licensee_name, state_business_name, state_licence_standing, state_licence_activity,
                state_licence_expires, qualified_business_name_match FROM contractor WHERE contractor_number = '${number}'`);

  it("joins on the exact licence number and takes the row with the latest expiry", async () => {
    expect(await licence("CCC111")).toEqual({
      state_licence_found: true, state_licensee_name: "DOE, JANE", state_business_name: "ACME ROOFING",
      state_licence_standing: "Current", state_licence_activity: "Active", state_licence_expires: "2028-08-31",
      qualified_business_name_match: false,
    });
  });
  it("leaves the licence empty when the number is not in the file, and flags a name-only business match", async () => {
    expect(await licence("CCC222")).toMatchObject({ state_licence_found: false, state_licensee_name: null, qualified_business_name_match: true });
  });
  it("lists qualified businesses as business records", async () => {
    expect(await one(`SELECT name, in_miami_dade, standing, registered_date FROM business`)).toEqual({
      name: "BEST ROOFS", in_miami_dade: false, standing: "Current", registered_date: "2010-01-02",
    });
  });
});

describe("contractor", () => {
  it("is one row per number, with name variants counted and county status joined", async () => {
    expect(await one(`SELECT name_variants, permits, roofing_permits, open_roofing_permits, state_licence_class, county_status
                      FROM contractor WHERE contractor_number = 'CCC111'`)).toEqual({
      name_variants: "2", permits: "2", roofing_permits: "2", open_roofing_permits: "1",
      state_licence_class: "CCC", county_status: "A",
    });
  });
});

describe("BBB profile link", () => {
  const bbb = async (n: string) => one(`SELECT bbb_profiles_with_name, bbb_profile_url, bbb_profile_category FROM contractor WHERE contractor_number = '${n}'`);

  it("links a contractor to the single profile with its name, ignoring Inc and LLC", async () => {
    expect(await bbb("CCC111")).toMatchObject({ bbb_profiles_with_name: 1, bbb_profile_category: "roofing-contractors" });
  });
  it("links nothing when two profiles share the name", async () => {
    expect(await bbb("CCC222")).toMatchObject({ bbb_profiles_with_name: 2, bbb_profile_url: null });
  });
});
