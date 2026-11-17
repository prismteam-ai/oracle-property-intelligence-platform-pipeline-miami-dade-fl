import { createHash } from "node:crypto";
import { createReadStream, createWriteStream, statSync } from "node:fs";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { CarWriter } from "@ipld/car";
import { importer } from "ipfs-unixfs-importer";
import type { CID } from "multiformats/cid";

/**
 * Content addressing, done locally and deterministically.
 *
 * Files are chunked into an IPFS UnixFS DAG here, so every CID is known before
 * anything is uploaded. The upload is then a plain block transfer: any node
 * that imports the CAR must arrive at the same CIDs, or the import is wrong.
 */

export interface AddedEntry {
  /** Path inside the snapshot; "" is the snapshot root directory. */
  path: string;
  cid: string;
  codec: "file" | "directory";
  /** File: raw byte length. Directory: cumulative size of the DAG beneath it. */
  size: number;
  /** SHA-256 of the raw bytes. Files only. */
  sha256: string | null;
}

export async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  await pipeline(createReadStream(path), hash);
  return hash.digest("hex");
}

/**
 * Build one UnixFS directory from files on disk and write its whole DAG to a CAR.
 * `files` maps snapshot paths ("tables/property.parquet") to local paths.
 */
export async function buildSnapshotCar(
  files: Record<string, string>,
  carPath: string,
): Promise<{ root: string; entries: AddedEntry[]; blocks: number }> {
  const blocks = new Map<string, { cid: CID; bytes: Uint8Array }>();
  const blockstore = {
    async put(cid: CID, bytes: Uint8Array) {
      blocks.set(cid.toString(), { cid, bytes });
      return cid;
    },
  };

  const names = Object.keys(files).sort();
  const candidates = names.map((path) => ({ path, content: createReadStream(files[path] as string) }));
  const entries: AddedEntry[] = [];
  let rootCid: CID | null = null;

  // CIDv1 with raw leaves: the same settings as `ipfs add --cid-version=1`.
  for await (const entry of importer(candidates, blockstore as any, {
    cidVersion: 1,
    rawLeaves: true,
    wrapWithDirectory: true,
  })) {
    const path = entry.path ?? "";
    const local = files[path];
    if (path === "") rootCid = entry.cid;
    entries.push({
      path,
      cid: entry.cid.toString(),
      codec: local ? "file" : "directory",
      size: local ? statSync(local).size : Number(entry.size),
      sha256: local ? await sha256File(local) : null,
    });
  }
  if (!rootCid) throw new Error("Importer returned no root directory");

  // Root first, then every other block in CID order: the CAR bytes are reproducible.
  const { writer, out } = CarWriter.create([rootCid]);
  const written = pipeline(Readable.from(out), createWriteStream(carPath));
  const rootKey = rootCid.toString();
  await writer.put(blocks.get(rootKey)!);
  for (const key of [...blocks.keys()].sort()) {
    if (key !== rootKey) await writer.put(blocks.get(key)!);
  }
  await writer.close();
  await written;

  entries.sort((a, b) => a.path.localeCompare(b.path));
  return { root: rootKey, entries, blocks: blocks.size };
}

/**
 * Write one file's DAG to its own CAR, rooted at the file's CID. Uploading this
 * makes the file retrievable by its own CID, not only by path under a directory.
 */
export async function buildFileCar(path: string, carPath: string): Promise<string> {
  const blocks = new Map<string, { cid: CID; bytes: Uint8Array }>();
  const blockstore = {
    async put(cid: CID, bytes: Uint8Array) {
      blocks.set(cid.toString(), { cid, bytes });
      return cid;
    },
  };
  let root: CID | null = null;
  for await (const entry of importer([{ content: createReadStream(path) }], blockstore as any, {
    cidVersion: 1,
    rawLeaves: true,
  })) {
    root = entry.cid;
  }
  if (!root) throw new Error(`Could not address ${path}`);
  const { writer, out } = CarWriter.create([root]);
  const written = pipeline(Readable.from(out), createWriteStream(carPath));
  const rootKey = root.toString();
  await writer.put(blocks.get(rootKey)!);
  for (const key of [...blocks.keys()].sort()) {
    if (key !== rootKey) await writer.put(blocks.get(key)!);
  }
  await writer.close();
  await written;
  return rootKey;
}

/** CID of a single file added on its own (used for the manifest and the CAR file). */
export async function fileCid(path: string): Promise<string> {
  let cid: CID | null = null;
  const sink = { async put(c: CID) { return c; } };
  for await (const entry of importer([{ content: createReadStream(path) }], sink as any, {
    cidVersion: 1,
    rawLeaves: true,
  })) {
    cid = entry.cid;
  }
  if (!cid) throw new Error(`Could not address ${path}`);
  return cid.toString();
}
