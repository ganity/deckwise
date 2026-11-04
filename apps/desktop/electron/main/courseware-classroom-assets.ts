import { constants } from "node:fs";
import { open, realpath } from "node:fs/promises";
import { createHash } from "node:crypto";
import { resolveRealOpenablePath } from "./fs-panel";

/** Only canonical manifests may select resources; untrusted URLs never initiate network requests. */
export async function readClassroomAsset(workspace: string, asset: { assetId: string; url: string; mimeType: string }): Promise<Uint8Array> {
  if (asset.url.startsWith("data:")) {
    const match = /^data:((?:image|audio|video)\/[\w.+-]+);base64,([A-Za-z0-9+/]+={0,2})$/.exec(asset.url);
    if (!match || (asset.mimeType !== "image/*" && match[1] !== asset.mimeType) || match[2].length > 180 * 1024 * 1024) throw new Error("Invalid canonical resource data");
    const bytes = Buffer.from(match[2], "base64");
    if (!bytes.length || bytes.toString("base64") !== match[2]) throw new Error("Invalid canonical resource encoding");
    return bytes;
  }
  if (!/^(?:\.deckwise-ppt\/|assets\/)/.test(asset.url)) throw new Error("MAIC asset is not archived locally");
  const path = await resolveRealOpenablePath(asset.url, workspace);
  if (!path) throw new Error("MAIC asset escapes the workspace");
  const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    if (process.platform === "linux" && await realpath(`/proc/self/fd/${file.fd}`) !== path) throw new Error("MAIC asset changed while opening");
    const info = await file.stat();
    if (!info.isFile() || !info.size || info.size > 128 * 1024 * 1024) throw new Error("MAIC asset exceeds export limit");
    const bytes = await file.readFile(), after = await file.stat();
    if (after.size !== info.size || after.mtimeMs !== info.mtimeMs) throw new Error("MAIC asset changed while reading");
    const digest = /(?:^|[/-])([a-f0-9]{64})(?:\.[a-z0-9]+)?$/.exec(asset.url)?.[1];
    if (digest && createHash("sha256").update(bytes).digest("hex") !== digest) throw new Error("MAIC asset hash mismatch");
    return bytes;
  } finally { await file.close(); }
}
