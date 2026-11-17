import { z } from "zod";

/**
 * Source catalog: the single place that says where Miami-Dade data comes from.
 * Every ingested row carries its source key and the exact request that returns it,
 * so each answer downstream can be traced back to a public record.
 */
const common = {
  /** Stable identifier; also the DuckDB table suffix (`src_<key>`). */
  key: z.string().regex(/^[a-z][a-z0-9_]*$/),
  /** What one row represents. */
  entity: z.string().min(1),
  publisher: z.string().min(1),
  /** Fields that together identify the real-world record across runs. */
  keyFields: z.array(z.string().min(1)).min(1),
  /** Known limits of this source, shown in run history. */
  limitations: z.array(z.string()),
};

/** An ArcGIS FeatureServer layer, read in ObjectID ranges. */
const arcgisSource = z.object({
  ...common,
  kind: z.literal("arcgis"),
  /** Layer URL (no trailing slash, no `/query`). */
  url: z.string().url(),
  /** True when the layer has point geometry to capture as WGS84 lon/lat. */
  hasGeometry: z.boolean(),
});

/** A published delimited file with no header row, read whole. */
const csvSource = z.object({
  ...common,
  kind: z.literal("csv"),
  url: z.string().url(),
  /** Column names in file order, from the publisher's documented layout. */
  columns: z.array(z.string().regex(/^[a-z][a-z0-9_]*$/)).min(1),
  /** Where the publisher documents that layout. */
  layoutUrl: z.string().url(),
  encoding: z.enum(["latin1", "utf8"]),
});

/** BBB's business-profile sitemaps for one BBB chapter and state: which profiles exist, not their ratings. */
const bbbSitemapSource = z.object({
  ...common,
  kind: z.literal("bbb_sitemap"),
  /** The sitemap index named in BBB's robots.txt. */
  url: z.string().url(),
  /** BBB chapter number, the four digits before the business number in a profile URL. */
  chapter: z.string().regex(/^\d{4}$/),
  state: z.string().regex(/^[a-z]{2}$/),
});

export const sourceSchema = z.discriminatedUnion("kind", [arcgisSource, csvSource, bbbSitemapSource]);
export type Source = z.infer<typeof sourceSchema>;
export type ArcgisSource = z.infer<typeof arcgisSource>;
export type CsvSource = z.infer<typeof csvSource>;
export type BbbSitemapSource = z.infer<typeof bbbSitemapSource>;

const MDC = "https://services.arcgis.com/8Pc9XBTAsYuxx9Ny/arcgis/rest/services";

export const COUNTY = {
  name: "Miami-Dade",
  state: "FL",
  fips: "12086",
  slug: "miami-dade",
} as const;

export const SOURCES: Source[] = z.array(sourceSchema).parse([
  {
    key: "properties",
    entity: "property (one row per folio: site address, owner, mailing address, year built, last sale, coordinates)",
    publisher: "Miami-Dade County Property Appraiser (PaGISView)",
    kind: "arcgis",
    url: `${MDC}/PaGISView_gdb/FeatureServer/0`,
    keyFields: ["FOLIO"],
    hasGeometry: true,
    limitations: [
      "Carries only the most recent sale (DOS_1 / PRICE_1), not full sale history.",
      "The layer has no per-row change timestamp, so change detection is a full-snapshot hash comparison.",
    ],
  },
  {
    key: "permits",
    entity: "building permit (one row per permit number: type, dates, folio, contractor, last inspection)",
    publisher: "Miami-Dade County Building Department (miamidade_permit_data)",
    kind: "arcgis",
    url: `${MDC}/miamidade_permit_data/FeatureServer/0`,
    keyFields: ["PermitNumber"],
    hasGeometry: false,
    limitations: [
      "Covers permits issued by the county building department from 2020-01-01; municipal building departments keep their own systems.",
      "The table has no status column: open or closed is derived from inspection and certificate dates.",
    ],
  },
  {
    key: "contractors",
    entity: "county contractor licence record (one row per contractor, tradesman and trade class)",
    publisher: "Miami-Dade County Building Department (Contractor)",
    kind: "arcgis",
    url: `${MDC}/Contractor/FeatureServer/0`,
    // One contractor number has a row per qualifying tradesman and trade class.
    keyFields: ["CONTRACTOR_NUMBER", "TRADESMEN_NAME", "TRADE_CLASS"],
    hasGeometry: false,
    limitations: [
      "County-held licence records only; state licence standing comes from DBPR.",
      "One row per contractor, tradesman and trade class, so a contractor number can repeat.",
    ],
  },
  {
    key: "state_licences",
    entity: "Florida construction licence or qualified business (licensee, business name, status, expiry)",
    publisher: "Florida DBPR, Construction Industry Licensing Board (licensee file)",
    kind: "csv",
    url: "https://www2.myfloridalicense.com/sto/file_download/extracts/CONSTRUCTIONLICENSE_1.csv",
    layoutUrl: "https://www2.myfloridalicense.com/construction-industry/public-records/",
    encoding: "latin1",
    // DBPR's "File Layout Information" lists 21 fields; the file carries one further empty column.
    columns: [
      "board_number", "occupation_code", "licensee_name", "dba_name", "class_code",
      "address_1", "address_2", "address_3", "city", "state", "zip", "county_code",
      "license_number", "primary_status", "secondary_status", "original_licensure_date",
      "effective_date", "expiration_date", "blank", "renewal_period", "alternate_license_number", "trailing",
    ],
    // Licences have a number. Qualified-business rows (occupation QB) have none, so the
    // name, address and original date are part of the key to keep them apart.
    keyFields: ["occupation_code", "license_number", "licensee_name", "address_1", "zip", "original_licensure_date"],
    limitations: [
      "Statewide file. It lists active, inactive and voluntarily inactive licensees only: null and void, delinquent and involuntarily inactive records are left out, so a contractor missing from it is not thereby unlicensed.",
      "Matched to permits by the licence number printed on the permit; a permit with no state-format number cannot be matched.",
      "About half the rows are qualified-business records, which carry a name and address but no licence number.",
    ],
  },
  {
    key: "bbb_profiles",
    entity: "BBB business profile listing (one row per profile: name as spelled in the URL, city, category, profile address)",
    publisher: "Better Business Bureau (business-profile sitemaps, Southeast Florida chapter 0633)",
    kind: "bbb_sitemap",
    url: "https://www.bbb.org/sitemap-business-profiles-index.xml",
    chapter: "0633",
    state: "fl",
    keyFields: ["bbb_id"],
    limitations: [
      "Lists which BBB profiles exist. It carries no rating, accreditation or complaint data: BBB's profile pages refuse automated requests (HTTP 403 challenge), so they are not read.",
      "A contractor is linked to a profile by name only, and only when exactly one profile in the chapter has that name. A link is a lead to check, not a confirmed identity.",
      "Covers the BBB chapter serving Southeast Florida; a contractor based elsewhere will not be found.",
    ],
  },
]);

export function getSource(key: string): Source {
  const source = SOURCES.find((s) => s.key === key);
  if (!source) {
    throw new Error(`Unknown source "${key}". Known: ${SOURCES.map((s) => s.key).join(", ")}`);
  }
  return source;
}
