import { describe, expect, it } from "vitest";
import { filesForChapter, parseLocs, parseProfileUrl } from "../src/sitemap.js";

const url = (chapter: string, id: number) => `https://www.bbb.org/us/fl/miami/profile/roofing-contractors/a-b-roofing-inc-${chapter}-${id}`;

describe("BBB profile sitemap", () => {
  it("reads the profile address into its parts", () => {
    expect(parseProfileUrl(url("0633", 42))).toEqual({
      bbb_id: "0633-42", chapter: "0633", state: "fl", city: "miami",
      category: "roofing-contractors", name_slug: "a-b-roofing-inc", profile_url: url("0633", 42),
    });
    expect(parseProfileUrl("https://www.bbb.org/us/fl/miami/category/roofing-contractors")).toBeNull();
  });

  it("extracts every loc from a sitemap", () => {
    expect(parseLocs("<urlset><url><loc> https://a.test/1 </loc></url><url><loc>https://a.test/2</loc></url></urlset>")).toEqual([
      "https://a.test/1", "https://a.test/2",
    ]);
  });

  it("finds exactly the files that hold a chapter, reading only a few", async () => {
    // 40 files ordered by chapter; chapter 0633 starts inside file 20 and ends inside file 23.
    const chapters = Array.from({ length: 40 }, (_, i) => (i < 20 ? ["0100", "0200"] : i === 20 ? ["0613", "0633"] : i < 23 ? ["0633", "0633"] : i === 23 ? ["0633", "0653"] : ["0700", "0900"]));
    const reads = new Set<number>();
    const read = async (i: number) => {
      reads.add(i);
      const [first, last] = chapters[i] as [string, string];
      return [url(first, 1), url(last, 2)];
    };
    expect(await filesForChapter(40, "0633", read)).toEqual([20, 21, 22, 23]);
    expect(reads.size).toBeLessThan(12);
  });

  it("stops if the files are not ordered by chapter", async () => {
    await expect(filesForChapter(4, "0633", async () => [url("0700", 1), url("0100", 2)])).rejects.toThrow(/not ordered/);
  });
});
