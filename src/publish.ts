import { createReadStream, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HeadObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { Upload } from "@aws-sdk/lib-storage";
import { verifyRetrieval, type Attempt } from "./gateways.js";
import { buildFileCar, buildSnapshotCar, fileCid, sha256File } from "./ipfs.js";

/**
 * Publish a built snapshot to IPFS and prove it is publicly retrievable.
 *
 *   npm run publish-snapshot            publish the newest snapshot under data/publish/
 *   npm run publish-snapshot -- <id>    publish a specific one
 *
 * Steps:
 *  1. Upload the snapshot CAR. The pinning node imports it and must report the
 *     same root CID that was computed locally.
 *  2. Upload every file as its own CAR too, so each listed CID is a pinned root
 *     that the public network can find by itself, not only by path.
 *  3. Fetch every listed CID from independent public gateways and compare size
 *     and SHA-256 with the manifest.
 *  4. Record the manifest and the retrieval evidence under publications/ in Git.
 *
 * Nothing is recorded as published unless step 3 passes.
 */

function loadEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const file of [join("..", ".env"), ".env"]) {
    if (!existsSync(file)) continue;
    for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
      const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line.trim());
      if (match) env[match[1] as string] = (match[2] as string).replace(/^(['"])(.*)\1$/, "$2");
    }
  }
  return { ...env, ...(process.env as Record<string, string>) };
}

const env = loadEnv();
for (const name of ["FILEBASE_ACCESS_KEY", "FILEBASE_SECRET_KEY", "FILEBASE_BUCKET"]) {
  if (!env[name]) throw new Error(`${name} is not set (environment or .env)`);
}
const bucket = env.FILEBASE_BUCKET as string;
const s3 = new S3Client({
  endpoint: "https://s3.filebase.com",
  region: "us-east-1",
  forcePathStyle: true,
  credentials: { accessKeyId: env.FILEBASE_ACCESS_KEY as string, secretAccessKey: env.FILEBASE_SECRET_KEY as string },
});

async function pinnedCid(key: string): Promise<string | null> {
  try {
    const head = await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
    return head.Metadata?.cid ?? null;
  } catch (error: any) {
    if (error?.$metadata?.httpStatusCode === 404 || error?.name === "NotFound") return null;
    throw error;
  }
}

/** Upload a CAR for import and require the node to pin the CID we computed. */
async function pinCar(carPath: string, expectedCid: string): Promise<"uploaded" | "already pinned"> {
  // Keyed by CID: an unchanged artifact is never uploaded twice.
  const key = `cars/${expectedCid}.car`;
  if ((await pinnedCid(key)) === expectedCid) return "already pinned";
  await new Upload({
    client: s3,
    params: { Bucket: bucket, Key: key, Body: createReadStream(carPath), Metadata: { import: "car" } },
  }).done();
  for (let attempt = 0; attempt < 60; attempt++) {
    const cid = await pinnedCid(key);
    if (cid === expectedCid) return "uploaded";
    if (cid) throw new Error(`Node pinned ${cid} but the manifest says ${expectedCid}`);
    await new Promise((resolve) => setTimeout(resolve, 5_000));
  }
  throw new Error(`Timed out waiting for ${expectedCid} to be pinned`);
}

const publishRoot = join("data", "publish");
const snapshotId = process.argv[2] ?? readdirSync(publishRoot).sort().at(-1);
if (!snapshotId) throw new Error("No snapshot found. Run `npm run snapshot` first.");
const dir = join(publishRoot, snapshotId);
const manifestPath = join(dir, "manifest.json");
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
const manifestCid = await fileCid(manifestPath);
const scratch = join(tmpdir(), `oracle-publish-${snapshotId}`);
mkdirSync(scratch, { recursive: true });

console.log(`Publishing snapshot ${snapshotId}\n  root     ${manifest.root.cid}\n  manifest ${manifestCid}`);

// 1. The whole snapshot.
console.log(`snapshot.car -> ${await pinCar(join(dir, "snapshot.car"), manifest.root.cid)}`);

// 2. Each file, the CAR file itself, and the manifest, each as its own pinned root.
const files: { name: string; cid: string; local: string }[] = [
  ...manifest.artifacts
    .filter((a: any) => a.codec === "file")
    .map((a: any) => ({ name: a.name, cid: a.cid, local: join(dir, "root", a.name) })),
  { name: "snapshot.car", cid: manifest.car.cid, local: join(dir, "snapshot.car") },
  { name: "manifest.json", cid: manifestCid, local: manifestPath },
];
for (const file of files) {
  const car = join(scratch, "artifact.car");
  const cid = await buildFileCar(file.local, car);
  if (cid !== file.cid) throw new Error(`${file.name}: local CID ${cid} differs from the manifest ${file.cid}`);
  console.log(`${file.name} -> ${await pinCar(car, cid)}`);
}
// Sub-directories are roots too: rebuild each from its files and pin it.
for (const folder of manifest.artifacts.filter((a: any) => a.codec === "directory" && a.name !== "/")) {
  const members = Object.fromEntries(
    manifest.artifacts
      .filter((a: any) => a.codec === "file" && a.name.startsWith(`${folder.name}/`))
      .map((a: any) => [a.name.slice(folder.name.length + 1), join(dir, "root", a.name)]),
  );
  const car = join(scratch, "folder.car");
  const { root } = await buildSnapshotCar(members, car);
  if (root !== folder.cid) throw new Error(`${folder.name}/: local CID ${root} differs from the manifest ${folder.cid}`);
  console.log(`${folder.name}/ -> ${await pinCar(car, root)}`);
}
rmSync(scratch, { recursive: true, force: true });

// 3. Independent retrieval of every listed CID.
interface Check { name: string; cid: string; codec: string; fetched: string; independentMatches: number; attempts: Attempt[] }
const checks: Check[] = [];
const manifestSize = readFileSync(manifestPath).length;
const targets = [
  ...manifest.artifacts.map((a: any) => {
    if (a.codec === "file") return { name: a.name, cid: a.cid, codec: a.codec, path: a.cid, size: a.size, sha256: a.sha256 };
    // A directory has no byte digest: prove its CID resolves by fetching a file through it.
    const prefix = a.name === "/" ? "" : `${a.name}/`;
    const child = manifest.artifacts.find((c: any) => c.codec === "file" && c.name.startsWith(prefix));
    return { name: a.name, cid: a.cid, codec: a.codec, path: `${a.cid}/${child.name.slice(prefix.length)}`, size: child.size, sha256: child.sha256 };
  }),
  { name: "snapshot.car", cid: manifest.car.cid, codec: "file", path: manifest.car.cid, size: manifest.car.size, sha256: manifest.car.sha256 },
  { name: "manifest.json", cid: manifestCid, codec: "file", path: manifestCid, size: manifestSize, sha256: await sha256File(manifestPath) },
];
const retrievalPath = join("publications", snapshotId, "retrieval.json");
// A CID names fixed bytes, so a match recorded for an earlier snapshot still holds:
// an unchanged table is not downloaded again through public gateways.
const earlier: Check[] = (existsSync("publications") ? readdirSync("publications") : [])
  .map((id) => join("publications", id, "retrieval.json"))
  .filter((path) => existsSync(path))
  .flatMap((path) => JSON.parse(readFileSync(path, "utf8")).checks as Check[]);
for (const target of targets) {
  const passed = earlier.find((c) => c.cid === target.cid && c.independentMatches >= 2);
  if (passed) {
    checks.push(passed);
    console.log(`ok   ${target.name}  (verified earlier)`);
    continue;
  }
  const result = await verifyRetrieval(target.path, { size: target.size, sha256: target.sha256 });
  checks.push({ name: target.name, cid: target.cid, codec: target.codec, fetched: target.path, ...result });
  const who = result.attempts.filter((a) => a.ok).map((a) => a.gateway).join(", ") || "none";
  console.log(`${result.independentMatches >= 2 ? "ok  " : "FAIL"} ${target.name}  (${who})`);
}
const failed = checks.filter((c) => c.independentMatches < 2);

// 4. Record it.
const outDir = join("publications", snapshotId);
mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, "manifest.json"), readFileSync(manifestPath));
writeFileSync(
  retrievalPath,
  JSON.stringify({ snapshot_id: snapshotId, manifest_cid: manifestCid, checked_at: new Date().toISOString(), required_independent_gateways: 2, passed: failed.length === 0, checks }, null, 2) + "\n",
);
if (failed.length > 0) {
  console.error(`\n${failed.length} artifact(s) not yet retrievable from two independent gateways: ${failed.map((c) => c.name).join(", ")}`);
  console.error("Evidence saved; the snapshot is NOT added to publications/index.json. Re-run to retry.");
  process.exit(1);
}
const indexPath = join("publications", "index.json");
const index: any[] = existsSync(indexPath) ? JSON.parse(readFileSync(indexPath, "utf8")) : [];
if (!index.some((entry) => entry.snapshot_id === snapshotId)) {
  index.push({
    snapshot_id: snapshotId,
    created_at: manifest.created_at,
    manifest_cid: manifestCid,
    root_cid: manifest.root.cid,
    car_cid: manifest.car.cid,
    previous_manifest_cid: manifest.previous?.manifest_cid ?? null,
  });
  writeFileSync(indexPath, JSON.stringify(index, null, 2) + "\n");
}
console.log(`\nPublished. Manifest CID ${manifestCid}; ${checks.length} artifacts retrievable from two independent gateways.`);
