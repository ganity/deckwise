import { nativeImage } from "electron";
import { createHash } from "node:crypto";
import { crc32 } from "node:zlib";
import type { Context, ImageContent, TextContent } from "@earendil-works/pi-ai";

export type CoursewareSceneImage = {
  assetIds: readonly string[];
  sha256: string;
  width: number;
  height: number;
  bytes: Uint8Array;
};
export type CoursewareSceneCompleteInput = {
  sessionId: string;
  modelKey: string;
  thinkingLevel?: string;
  signal?: AbortSignal;
  system: string;
  data: string;
  images: readonly CoursewareSceneImage[];
};

const invalid = () => new Error("COURSEWARE_SCENE_INVALID_INPUT");
const id = (value: unknown): value is string =>
  typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(value);

function checkPng(bytes: Buffer, width: number, height: number) {
  if (
    bytes.length < 45 ||
    !bytes.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex")) ||
    bytes.readUInt32BE(8) !== 13 ||
    bytes.toString("ascii", 12, 16) !== "IHDR" ||
    bytes.readUInt32BE(16) !== width ||
    bytes.readUInt32BE(20) !== height
  )
    throw invalid();
  let offset = 8,
    data = false,
    end = false;
  while (offset + 12 <= bytes.length) {
    const length = bytes.readUInt32BE(offset),
      next = offset + length + 12;
    const type = bytes.toString("ascii", offset + 4, offset + 8);
    if (next > bytes.length || crc32(bytes.subarray(offset + 4, next - 4)) !== bytes.readUInt32BE(next - 4) || ["acTL", "fcTL", "fdAT"].includes(type) || (offset !== 8 && type === "IHDR"))
      throw invalid();
    if (type === "IDAT") data = true;
    if (type === "IEND") {
      end = length === 0 && next === bytes.length;
      break;
    }
    offset = next;
  }
  if (!data || !end) throw invalid();
  const image = nativeImage.createFromBuffer(bytes);
  const size = image.getSize();
  if (
    image.isEmpty() ||
    size.width !== width ||
    size.height !== height ||
    image.toBitmap().length !== width * height * 4
  )
    throw invalid();
}

/** Copy and validate before any async model work or retained scene buffers. */
export function captureCoursewareSceneImages(input: readonly CoursewareSceneImage[], signal?: AbortSignal) {
  signal?.throwIfAborted();
  if (!Array.isArray(input) || !input.length || input.length > 202) throw invalid();
  const ids = new Set<string>();
  const images = new Map<string, { assetIds: string[]; bytes: Buffer; width: number; height: number }>();
  let budget = 0,
    pixels = 0;
  for (const asset of input) {
    signal?.throwIfAborted();
    if (
      !asset ||
      !Array.isArray(asset.assetIds) ||
      !asset.assetIds.length ||
      !(asset.bytes instanceof Uint8Array) ||
      asset.bytes.length > 32 * 1024 * 1024 ||
      typeof asset.sha256 !== "string" ||
      !/^[a-f0-9]{64}$/u.test(asset.sha256) ||
      !Number.isInteger(asset.width) ||
      !Number.isInteger(asset.height) ||
      asset.width < 1 ||
      asset.height < 1 ||
      asset.width > 4096 ||
      asset.height > 4096
    )
      throw invalid();
    for (const assetId of asset.assetIds) {
      if (!id(assetId) || ids.has(assetId) || ids.size >= 202) throw invalid();
      ids.add(assetId);
    }
    const bytes = Buffer.from(asset.bytes);
    if (createHash("sha256").update(bytes).digest("hex") !== asset.sha256) throw invalid();
    const same = images.get(asset.sha256);
    if (same) {
      if (same.width !== asset.width || same.height !== asset.height) throw invalid();
      same.assetIds.push(...asset.assetIds);
      continue;
    }
    budget += bytes.length;
    pixels += asset.width * asset.height;
    if (budget > 32 * 1024 * 1024 || pixels > 32 * 1024 * 1024) throw invalid();
    checkPng(bytes, asset.width, asset.height);
    images.set(asset.sha256, {
      assetIds: [...asset.assetIds],
      bytes,
      width: asset.width,
      height: asset.height,
    });
  }
  return [...images].map(([sha256, image]) => ({ ...image, sha256 }));
}

/** Resolved Main-owned PNGs only. No path/URL, session history or tool enters this context. */
export function coursewareSceneContext(input: CoursewareSceneCompleteInput): Context {
  input.signal?.throwIfAborted();
  if (
    !id(input.sessionId) ||
    typeof input.modelKey !== "string" ||
    !input.modelKey.trim() ||
    input.modelKey.length > 512 ||
    typeof input.system !== "string" ||
    !input.system.trim() ||
    Buffer.byteLength(input.system) > 65536 ||
    typeof input.data !== "string" ||
    !input.data.trim() ||
    Buffer.byteLength(input.data) > 1024 * 1024
  )
    throw invalid();
  const images = captureCoursewareSceneImages(input.images, input.signal);
  const content: (TextContent | ImageContent)[] = [{ type: "text", text: input.data }];
  for (const image of images)
    content.push(
      {
        type: "text",
        text: JSON.stringify({
          assetIds: image.assetIds,
          sha256: image.sha256,
          width: image.width,
          height: image.height,
        }),
      },
      { type: "image", mimeType: "image/png", data: image.bytes.toString("base64") },
    );
  return { systemPrompt: input.system, messages: [{ role: "user", content, timestamp: Date.now() }] };
}
