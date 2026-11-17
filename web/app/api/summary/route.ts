import { respond } from "@/lib/http";
import { getLatest, getPublications, getSnapshotJson } from "@/lib/snapshot";

/** The run summary: what is published, from which sources, and the publication history. */
export async function GET() {
  return respond(async () => {
    const [publications, { publication, manifest }] = await Promise.all([getPublications(), getLatest()]);
    const [coverage, runs] = await Promise.all([
      getSnapshotJson(manifest.root.cid, "coverage.json"),
      getSnapshotJson(manifest.root.cid, "runs.json"),
    ]);
    return { publication, publications, manifest, coverage, runs };
  });
}
