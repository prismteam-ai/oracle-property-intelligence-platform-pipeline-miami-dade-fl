import { describe, expect, it } from "vitest";
import { parseCsv } from "../src/csv.js";

describe("parseCsv", () => {
  it("keeps commas inside quoted fields", () => {
    expect(parseCsv('"06","CCC","DEL SOL, ISAIAS","A & B"\n')).toEqual([["06", "CCC", "DEL SOL, ISAIAS", "A & B"]]);
  });
  it("reads doubled quotes as one quote", () => {
    expect(parseCsv('"a ""quoted"" word","b"')).toEqual([['a "quoted" word', "b"]]);
  });
  it("handles CRLF line ends, empty fields and a missing final newline", () => {
    expect(parseCsv('"a","","c"\r\n"d","e",""')).toEqual([
      ["a", "", "c"],
      ["d", "e", ""],
    ]);
  });
  it("skips blank lines", () => {
    expect(parseCsv('"a"\n\n"b"\n')).toEqual([["a"], ["b"]]);
  });
});
