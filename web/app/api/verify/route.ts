import { respond } from "@/lib/http";
import { getLatest } from "@/lib/snapshot";
import { MAX_LIVE_VERIFY_BYTES, verifyLive } from "@/lib/verify";

export const maxDuration = 60;

/**
 * Fetch one artifact of the live snapshot by CID from public gateways, right now,
 * and compare it with the manifest. Only CIDs listed in the manifest are accepted.
 */
export async function GET(request: Request) {
  return respond(async () => {
    const cid = new URL(request.url).searchParams.get("cid") ?? "";
    const { manifest } = await getLatest();
    const artifact = manifest.artifacts.find((a) => a.cid === cid);
    if (!artifact) throw new Error("That CID is not listed in the live manifest");

    // A directory has no byte digest: prove its CID resolves by fetching a file through it.
    let path = artifact.cid;
    let want = { size: artifact.size, sha256: artifact.sha256 ?? "" };
    let via: string | null = null;
    if (artifact.codec === "directory") {
      const prefix = artifact.name === "/" ? "" : `${artifact.name}/`;
      const child = manifest.artifacts
        .filter((a) => a.codec === "file" && a.name.startsWith(prefix))
        .sort((a, b) => a.size - b.size)[0];
      if (!child) throw new Error("Directory has no files");
      via = child.name.slice(prefix.length);
      path = `${artifact.cid}/${via}`;
      want = { size: child.size, sha256: child.sha256 ?? "" };
    }
    if (want.size > MAX_LIVE_VERIFY_BYTES) {
      return { artifact, tooLarge: true, limitBytes: MAX_LIVE_VERIFY_BYTES, attempts: [] };
    }
    const attempts = await verifyLive(path, want);
    const independentMatches = attempts.filter((a) => a.ok && a.independent).length;
    return { artifact, via, expected: want, independentMatches, passed: independentMatches >= 2, attempts, checkedAt: new Date().toISOString() };
  });
}
