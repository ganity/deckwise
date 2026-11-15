import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open, realpath } from "node:fs/promises";
import { join, relative, sep } from "node:path";

const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

/** Read a finite member from Main's selected immutable build, never a renderer path. */
async function readMember(directory: string, member: string, digest: string | null, limit: number): Promise<Uint8Array> {
  const root = await realpath(directory);
  const path = join(root, member);
  const inside = (value: string) => {
    const name = relative(root, value).split(sep).join("/");
    return name !== "" && name !== ".." && !name.startsWith("../") && !name.startsWith("..\\") && name === member;
  };
  if (!inside(await realpath(path))) throw new Error("Build member escaped its selected directory");
  const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    if (process.platform === "linux" && !inside(await realpath(`/proc/self/fd/${file.fd}`))) throw new Error("Opened build member escaped its directory");
    const info = await file.stat();
    if (!info.isFile() || info.size < 1 || info.size > limit) throw new Error("Build member missing or oversized");
    const bytes = Buffer.alloc(info.size);
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await file.read(bytes, offset, bytes.length - offset, offset);
      if (!bytesRead) throw new Error("Build member changed while reading");
      offset += bytesRead;
    }
    const after = await file.stat();
    if (after.size !== info.size || after.mtimeMs !== info.mtimeMs || (digest && sha256(bytes) !== digest)) throw new Error("Build member hash changed");
    return Uint8Array.from(bytes);
  } finally { await file.close(); }
}

export async function openCoursewareBuildFiles(directory: string, buildId: string) {
  if (!/^[a-f0-9]{64}$/u.test(buildId)) throw new Error("Invalid selected build identity");
  const bytes = await readMember(directory, "package.json", buildId, 64 * 1024 * 1024);
  const pkg: unknown = JSON.parse(Buffer.from(bytes).toString("utf8"));
  const entries: unknown = pkg && typeof pkg === "object" ? Reflect.get(pkg, "assets") : null;
  if (!Array.isArray(entries) || entries.length > 1000) throw new Error("Invalid fixed build asset list");
  const assets = new Map<string, { path: string; sha256: string }>();
  for (const entry of entries) {
    if (!entry || typeof entry.id !== "string" || !entry.id || assets.has(entry.id) ||
        typeof entry.path !== "string" || !/^assets\/[a-f0-9]{64}\.[a-z0-9]+$/u.test(entry.path) ||
        typeof entry.sha256 !== "string" || !/^[a-f0-9]{64}$/u.test(entry.sha256) ||
        !entry.path.startsWith(`assets/${entry.sha256}.`)) throw new Error("Invalid fixed build asset");
    assets.set(entry.id, { path: entry.path, sha256: entry.sha256 });
  }
  return {
    packageBytes: () => Uint8Array.from(bytes),
    async assetBytes(id: unknown): Promise<Uint8Array> {
      const asset = typeof id === "string" ? assets.get(id) : undefined;
      if (!asset) throw new Error("Asset is not in the selected build");
      return readMember(directory, asset.path, asset.sha256, 128 * 1024 * 1024);
    },
  };
}

/** Read the complete, hash-pinned package that Platform accepts for team sharing. */
export async function openCoursewareBuildUpload(directory: string, buildId: string) {
  const manifestBytes = await readMember(directory, "manifest.json", null, 1024 * 1024);
  const manifestHash = sha256(manifestBytes);
  const manifest: unknown = JSON.parse(Buffer.from(manifestBytes).toString("utf8"));
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest) ||
      Object.keys(manifest).length !== 4 || Reflect.get(manifest, "schemaVersion") !== "deckwise-build-manifest/1" ||
      Reflect.get(manifest, "buildId") !== buildId || Reflect.get(manifest, "packageHash") !== buildId ||
      !Array.isArray(Reflect.get(manifest, "files"))) throw new Error("Invalid fixed build manifest");
  const entries: unknown[] = Reflect.get(manifest, "files");
  if (entries.length < 3 || entries.length > 4096) throw new Error("Invalid fixed build file list");
  const files = [];
  const seen = new Set<string>();
  let total = manifestBytes.byteLength;
  for (const entry of entries) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry) || Object.keys(entry).length !== 2 ||
        typeof Reflect.get(entry, "path") !== "string" || typeof Reflect.get(entry, "sha256") !== "string") throw new Error("Invalid fixed build file");
    const path = Reflect.get(entry, "path") as string;
    const digest = Reflect.get(entry, "sha256") as string;
    if (!( ["package.json", "report.json", "source.pptx"].includes(path) || /^assets\/[a-f0-9]{64}\.[a-z0-9]{1,16}$/u.test(path)) ||
        seen.has(path) || !/^[a-f0-9]{64}$/u.test(digest)) throw new Error("Invalid fixed build file");
    const limit = path === "package.json" ? 64 * 1024 * 1024 : path === "report.json" ? 2 * 1024 * 1024 : path === "source.pptx" ? 20 * 1024 * 1024 : 256 * 1024 * 1024;
    const bytes = await readMember(directory, path, digest, limit);
    total += bytes.byteLength;
    if (total > 343 * 1024 * 1024) throw new Error("Fixed build exceeds upload limit");
    seen.add(path);
    files.push({ path, sha256: digest, bytes });
  }
  if (!["package.json", "report.json", "source.pptx"].every((path) => seen.has(path)) ||
      files.find((file) => file.path === "package.json")?.sha256 !== buildId) throw new Error("Incomplete fixed build");
  return { manifestHash, manifestBytes: Uint8Array.from(manifestBytes), files };
}
