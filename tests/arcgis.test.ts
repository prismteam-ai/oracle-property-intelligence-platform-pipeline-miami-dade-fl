import { describe, expect, it } from "vitest";
import { planRanges, rangeRequestUrl, rowHash } from "../src/arcgis.js";
import { checkComplete } from "../src/store.js";

describe("planRanges", () => {
  it("covers every ObjectID exactly once", () => {
    const ranges = planRanges(1, 4500, 2000);
    expect(ranges).toEqual([
      { from: 1, to: 2001 },
      { from: 2001, to: 4001 },
      { from: 4001, to: 4501 },
    ]);
    const covered = ranges.reduce((n, r) => n + (r.to - r.from), 0);
    expect(covered).toBe(4500);
  });

  it("never plans a window wider than the page limit", () => {
    for (const r of planRanges(7, 99_999, 1000)) expect(r.to - r.from).toBeLessThanOrEqual(1000);
  });

  it("handles a single-row layer", () => {
    expect(planRanges(5, 5, 2000)).toEqual([{ from: 5, to: 6 }]);
  });
});

describe("rowHash", () => {
  const row = { OBJECTID: 1, FOLIO: "0101", YEAR_BUILT: 1990, OWNER: null };

  it("ignores the ObjectID and key order", () => {
    expect(rowHash(row, "OBJECTID")).toBe(
      rowHash({ OWNER: null, YEAR_BUILT: 1990, FOLIO: "0101", OBJECTID: 999 }, "OBJECTID"),
    );
  });

  it("changes when a source value changes", () => {
    expect(rowHash(row, "OBJECTID")).not.toBe(rowHash({ ...row, YEAR_BUILT: 1991 }, "OBJECTID"));
  });

  it("treats a missing value and an explicit null the same", () => {
    expect(rowHash({ OBJECTID: 1, A: undefined }, "OBJECTID")).toBe(rowHash({ OBJECTID: 2, A: null }, "OBJECTID"));
  });
});

describe("publisher reloads", () => {
  it("ignores row identifiers the publisher reassigns when it reloads a table", () => {
    const before = { ObjectId: 865, GlobalID: "afaeb234", PermitNumber: "P1", Folio: "0101" };
    const after = { ObjectId: 804, GlobalID: "a354fcac", PermitNumber: "P1", Folio: "0101" };
    expect(rowHash(before, ["ObjectId", "GlobalID"])).toBe(rowHash(after, ["ObjectId", "GlobalID"]));
  });

  it("refuses a read that returns nothing, or under half of what was known", () => {
    expect(() => checkComplete("contractors", 0, 22279)).toThrow(/no records/);
    expect(() => checkComplete("contractors", 9000, 22279)).toThrow(/incomplete/);
    expect(() => checkComplete("contractors", 22100, 22279)).not.toThrow();
    expect(() => checkComplete("contractors", 500, 0)).not.toThrow();
  });
});

describe("rangeRequestUrl", () => {
  it("is a replayable public request for exactly that range", () => {
    const url = new URL(rangeRequestUrl("https://example.test/FeatureServer/0", "OBJECTID", { from: 1, to: 2001 }));
    expect(url.pathname).toBe("/FeatureServer/0/query");
    expect(url.searchParams.get("where")).toBe("OBJECTID>=1 AND OBJECTID<2001");
    expect(url.searchParams.get("outSR")).toBe("4326");
  });
});
