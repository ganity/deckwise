import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { basename, isAbsolute } from "node:path";
import { nativeImage, net, session } from "electron";
import { createPublicHttpsClient } from "./public-https-fetch";
import type { CoursewareSceneImageAsset, CoursewareSceneImageTarget, CoursewareTaskRef } from "@pi-desktop/shared";
import { captureCoursewareSceneImages } from "./courseware-scene-context";

// Keep Base64 plus metadata below the existing 64 MiB Host RPC frame.
const MAX_LAYER_BYTES = 44 * 1024 * 1024;
const MAX_LAYER_JSON_BYTES = 60 * 1024 * 1024;

const invalid = () => new Error("COURSEWARE_SCENE_IMAGE_INVALID_ASSET");

export function sceneDecompositionReference(bytes: Buffer, asset: CoursewareSceneImageAsset): Buffer {
  verifySceneImageAsset(bytes, asset, { kind: "visualMaster" });
  const jpeg = nativeImage.createFromBuffer(bytes).toJPEG(95);
  if (!jpeg.length || jpeg.length > 8 * 1024 * 1024) throw invalid();
  return jpeg;
}

function jpegSize(bytes: Buffer): [number, number] {
  let offset = 2;
  while (offset + 4 <= bytes.length) {
    if (bytes[offset++] !== 255) throw invalid();
    while (bytes[offset] === 255) offset++;
    const marker = bytes[offset++];
    if (marker === 217 || marker === 218) break;
    if (marker === 1 || (marker >= 208 && marker <= 215)) continue;
    if (offset + 2 > bytes.length) throw invalid();
    const length = bytes.readUInt16BE(offset);
    if (length < 2 || offset + length > bytes.length) throw invalid();
    if ([192, 193, 194, 195, 197, 198, 199, 201, 202, 203, 205, 206, 207].includes(marker)) {
      if (length < 8) throw invalid();
      return [bytes.readUInt16BE(offset + 5), bytes.readUInt16BE(offset + 3)];
    }
    offset += length;
  }
  throw invalid();
}

function webpSize(bytes: Buffer): [number, number] {
  let offset = 12, size: [number, number] | undefined;
  while (offset + 8 <= bytes.length) {
    const type = bytes.toString("ascii", offset, offset + 4), length = bytes.readUInt32LE(offset + 4);
    const start = offset + 8, end = start + length;
    if (end > bytes.length || type === "ANIM" || type === "ANMF") throw invalid();
    let dimensions: [number, number] | undefined;
    if (type === "VP8X") {
      if (length !== 10 || (bytes[start] & 2)) throw invalid();
      dimensions = [bytes.readUIntLE(start + 4, 3) + 1, bytes.readUIntLE(start + 7, 3) + 1];
    } else if (type === "VP8 ") {
      if (length < 10 || bytes.toString("hex", start + 3, start + 6) !== "9d012a") throw invalid();
      dimensions = [bytes.readUInt16LE(start + 6) & 16383, bytes.readUInt16LE(start + 8) & 16383];
    } else if (type === "VP8L") {
      if (length < 5 || bytes[start] !== 47) throw invalid();
      const bits = bytes.readUInt32LE(start + 1);
      dimensions = [(bits & 16383) + 1, ((bits >>> 14) & 16383) + 1];
    }
    if (dimensions) {
      if (size && (size[0] !== dimensions[0] || size[1] !== dimensions[1])) throw invalid();
      size = dimensions;
    }
    offset = end + (length % 2);
  }
  if (offset !== bytes.length || !size) throw invalid();
  return size;
}
export function isSceneImageAsset(value: unknown): value is CoursewareSceneImageAsset {
  if (!value || typeof value !== "object") return false;
  const v = value as CoursewareSceneImageAsset;
  return typeof v.sha256 === "string" && /^[a-f0-9]{64}$/u.test(v.sha256) &&
    ["image/png", "image/jpeg", "image/webp"].includes(v.mimeType) &&
    Number.isSafeInteger(v.byteLength) && v.byteLength > 0 && v.byteLength <= 8 * 1024 * 1024 &&
    Number.isSafeInteger(v.width) && Number.isSafeInteger(v.height) &&
    v.width > 0 && v.width <= 4096 && v.height > 0 && v.height <= 4096 &&
    (v.sourceZIndex === undefined || (Number.isSafeInteger(v.sourceZIndex) && v.sourceZIndex >= 1 && v.sourceZIndex <= 1_000_000)) &&
    (v.normalizedBoundingBox === undefined || (Array.isArray(v.normalizedBoundingBox) && v.normalizedBoundingBox.length === 4 &&
      v.normalizedBoundingBox.every(n => Number.isFinite(n) && n >= 0 && n <= 1000) &&
      v.normalizedBoundingBox[0] < v.normalizedBoundingBox[2] && v.normalizedBoundingBox[1] < v.normalizedBoundingBox[3]));
}

/** Download supplier layers in Desktop without forwarding platform/provider credentials. */
export async function downloadSceneImageBundle(bytes: Buffer, taskRef: CoursewareTaskRef,
  stageImage?: (image: ReturnType<typeof decodeSceneImageBundle>[number]) => Promise<void>) {
  if (bytes.length < 1 || bytes.length > MAX_LAYER_JSON_BYTES) throw invalid();
  const value = JSON.parse(bytes.toString("utf8"));
  if (!Array.isArray(value?.data) || value.data.length < 2 || value.data.length > 32) throw invalid();
  const indexes = value.data.map((item: { z_index?: unknown }) => item?.z_index);
  if (!indexes.includes(0) || new Set(indexes).size !== indexes.length || indexes.some((z: unknown) =>
      !Number.isSafeInteger(z) || Number(z) < 0 || Number(z) > 1_000_000)) throw invalid();
  value.data.sort((a: { z_index: number }, b: { z_index: number }) => a.z_index - b.z_index);
  const client = createPublicHttpsClient({
    fetchImpl: (url, init) => net.fetch(url, init),
    lookupImpl: async host => (await session.defaultSession.resolveHost(host)).endpoints,
    routeImpl: url => session.defaultSession.resolveProxy(url),
  });
  let total = 0;
  const staged = [];
  for (const item of value.data) {
    if (typeof item?.url === "string") {
      if (item.b64_json !== undefined) throw invalid();
      await client.assertPublicUrl(item.url);
      const response = await net.fetch(item.url, { method: "GET", credentials: "omit", redirect: "error",
        cache: "no-store", signal: AbortSignal.timeout(60_000) });
      const reader = response.body?.getReader();
      try {
        if (!response.ok || !reader || !["image/png", "image/jpeg"].includes(response.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase() ?? "")) throw invalid();
        const chunks: Buffer[] = [];
        let size = 0;
        while (true) {
          const next = await reader.read();
          if (next.done) break;
          size += next.value.byteLength;
          total += next.value.byteLength;
          if (size > 8 * 1024 * 1024 || !stageImage && total > MAX_LAYER_BYTES) throw new Error("COURSEWARE_SCENE_IMAGE_LAYER_BUNDLE_TOO_LARGE");
          chunks.push(Buffer.from(next.value));
        }
        item.b64_json = Buffer.concat(chunks, size).toString("base64");
        delete item.url;
      } finally {
        if (reader) {
          try { await reader.cancel(); } catch { /* Preserve the download failure. */ }
          reader.releaseLock();
        }
      }
    }
    if (stageImage) {
      const image = decodeSceneImageItems([item], taskRef)[0];
      await stageImage(image);
      const { bytesBase64: _, ...metadata } = image;
      staged.push(metadata);
      delete item.b64_json;
    }
  }
  if (stageImage) return staged;
  return decodeSceneImageBundle(Buffer.from(JSON.stringify(value)), taskRef);
}

/** One authenticated decomposition receipt becomes private, separately reviewable scene assets. */
export function decodeSceneImageBundle(bytes: Buffer, taskRef: CoursewareTaskRef) {
  if (bytes.length < 1 || bytes.length > MAX_LAYER_JSON_BYTES) throw invalid();
  const value = JSON.parse(bytes.toString("utf8"));
  if (!Array.isArray(value?.data) || value.data.length < 2 || value.data.length > 32) throw invalid();
  if (!value.data.some((item: { z_index?: number }) => item?.z_index === 0)) throw invalid();
  return decodeSceneImageItems(value.data, taskRef);
}

function decodeSceneImageItems(data: Record<string, unknown>[], taskRef: CoursewareTaskRef) {
  const indexes = new Set<number>();
  let total = 0;
  const images = data.map((item: Record<string, unknown>) => {
    if (!item || !Number.isSafeInteger(item.z_index) || Number(item.z_index) < 0 || indexes.has(Number(item.z_index)) ||
        Number(item.z_index) > 1_000_000 || typeof item.b64_json !== "string" || item.url !== undefined) throw invalid();
    indexes.add(Number(item.z_index));
    let png: Buffer = Buffer.from(item.b64_json, "base64");
    if (png.length < 33 || png.length > 8 * 1024 * 1024 || png.toString("base64") !== item.b64_json) throw invalid();
    total += png.length;
    if (total > MAX_LAYER_BYTES) throw new Error("COURSEWARE_SCENE_IMAGE_LAYER_BUNDLE_TOO_LARGE");
    // MAIC normalizes the base to PNG; native Seedream may return a JPEG base and PNG foregrounds.
    if (item.z_index === 0 && png.subarray(0, 3).equals(Buffer.from([255, 216, 255]))) {
      const [width, height] = jpegSize(png);
      if (width < 1 || width > 4096 || height < 1 || height > 4096) throw invalid();
      const image = nativeImage.createFromBuffer(png);
      if (image.isEmpty() || image.getSize().width !== width || image.getSize().height !== height) throw invalid();
      png = image.toPNG();
      if (png.length < 33) throw invalid();
    }
    const bounds = item.bounding_box && typeof item.bounding_box === "object" ? Reflect.get(item.bounding_box, "normalized") : undefined;
    const asset = { taskRef, mimeType: "image/png" as const, byteLength: png.length,
      sha256: createHash("sha256").update(png).digest("hex"), width: png.readUInt32BE(16), height: png.readUInt32BE(20),
      ...(item.z_index === 0 ? {} : { normalizedBoundingBox: bounds as [number, number, number, number], sourceZIndex: Number(item.z_index) }) };
    if (item.z_index !== 0 && !asset.normalizedBoundingBox) throw invalid();
    const label = typeof item.name === "string" ? item.name.replace(/[\u0000-\u001f\u007f-\u009f]/gu, " ").trim().slice(0, 60) : "Foreground";
    const target: CoursewareSceneImageTarget = item.z_index === 0 ? { kind: "cleanPlate" } : { kind: "layer", name: `${item.z_index} - ${label || "Foreground"}` };
    verifySceneImageAsset(png, asset, target);
    return { zIndex: Number(item.z_index), target, asset, bytesBase64: png.toString("base64") };
  });
  return images.sort((a: { zIndex: number }, b: { zIndex: number }) => a.zIndex - b.zIndex)
    .map(({ zIndex: _, ...image }: { zIndex: number; target: CoursewareSceneImageTarget; asset: CoursewareSceneImageAsset & { taskRef: CoursewareTaskRef }; bytesBase64: string }) => image);
}

/** Keep the original authenticated bytes; validate actual decoding before archive or display. */
export function verifySceneImageAsset(bytes: Buffer, asset: CoursewareSceneImageAsset, target?: CoursewareSceneImageTarget): Buffer {
  if (!isSceneImageAsset(asset) || bytes.length !== asset.byteLength ||
      createHash("sha256").update(bytes).digest("hex") !== asset.sha256) throw invalid();
  if (asset.mimeType === "image/png") {
    captureCoursewareSceneImages([{ assetIds: ["scene-reference"], ...asset, bytes }]);
  } else {
    const signature = asset.mimeType === "image/jpeg"
      ? bytes.length >= 5 && bytes.subarray(0, 3).equals(Buffer.from([255, 216, 255])) && bytes.subarray(-2).equals(Buffer.from([255, 217]))
      : bytes.length >= 20 && bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP" && bytes.readUInt32LE(4) + 8 === bytes.length;
    if (!signature) throw invalid();
    // Check encoded dimensions before asking the native decoder to allocate pixels.
    const [width, height] = asset.mimeType === "image/jpeg" ? jpegSize(bytes) : webpSize(bytes);
    if (width !== asset.width || height !== asset.height) throw invalid();
    const image = nativeImage.createFromBuffer(bytes), size = image.getSize();
    if (image.isEmpty() || size.width !== asset.width || size.height !== asset.height ||
        image.toBitmap().length !== asset.width * asset.height * 4) throw invalid();
  }
  if (target?.kind === "layer") {
    if (asset.mimeType !== "image/png") throw new Error("COURSEWARE_SCENE_IMAGE_LAYER_REQUIRES_TRANSPARENT_PNG");
    const pixels = nativeImage.createFromBuffer(bytes).toBitmap();
    let transparent = false, visible = false;
    if (pixels.length !== asset.width * asset.height * 4) throw invalid();
    for (let i = 3; i < pixels.length && !(transparent && visible); i += 4) {
      transparent ||= pixels[i] === 0;
      visible ||= pixels[i] > 0;
    }
    // Native text carriers can fill their crop; preserve provider pixels at their pinned bounds.
    const nativeCrop = asset.sourceZIndex !== undefined && asset.normalizedBoundingBox !== undefined;
    if (!visible || !transparent && !nativeCrop) throw new Error("COURSEWARE_SCENE_IMAGE_LAYER_REQUIRES_TRANSPARENT_PNG");
  }
  return bytes;
}

/** Host supplies the private archive path; no Renderer/model path is accepted. */
export async function readSceneImageAsset(path: unknown, asset: CoursewareSceneImageAsset, target?: CoursewareSceneImageTarget): Promise<Buffer> {
  if (!isSceneImageAsset(asset) || typeof path !== "string" || !isAbsolute(path) || basename(path) !== `${asset.sha256}.bin`) throw invalid();
  const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size !== asset.byteLength) throw invalid();
    const bytes = Buffer.alloc(asset.byteLength + 1);
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await file.read(bytes, offset, bytes.length - offset, offset);
      if (!bytesRead) break;
      offset += bytesRead;
    }
    return verifySceneImageAsset(bytes.subarray(0, offset), asset, target);
  } finally { await file.close(); }
}

/** Fit references/backgrounds without cropping or stretching; foreground PNGs stay independent. */
export function sceneImageForCompiler(input: {
  intentId: string; target: CoursewareSceneImageTarget; asset: CoursewareSceneImageAsset; bytes: Buffer;
}, canvas: { width: number; height: number }, layerBounds?: { width: number; height: number }) {
  verifySceneImageAsset(input.bytes, input.asset, input.target);
  let bytes: Buffer = Buffer.from(input.bytes), width = input.asset.width, height = input.asset.height;
  if (input.target.kind !== "layer") {
    const scale = Math.min(canvas.width / width, canvas.height / height);
    const fitWidth = Math.max(1, Math.round(width * scale)), fitHeight = Math.max(1, Math.round(height * scale));
    const pixels = nativeImage.createFromBuffer(bytes).resize({ width: fitWidth, height: fitHeight, quality: "best" }).toBitmap();
    if (pixels.length !== fitWidth * fitHeight * 4) throw invalid();
    const fitted = Buffer.alloc(canvas.width * canvas.height * 4, 255);
    const x = Math.floor((canvas.width - fitWidth) / 2), y = Math.floor((canvas.height - fitHeight) / 2);
    for (let row = 0; row < fitHeight; row++) pixels.copy(fitted, ((row + y) * canvas.width + x) * 4, row * fitWidth * 4, (row + 1) * fitWidth * 4);
    bytes = nativeImage.createFromBitmap(fitted, { ...canvas, scaleFactor: 1 }).toPNG();
    width = canvas.width; height = canvas.height;
  }
  if (input.target.kind === "layer" && layerBounds && (width > layerBounds.width || height > layerBounds.height)) {
    const scale = Math.min(1, layerBounds.width / width, layerBounds.height / height);
    width = Math.max(1, Math.round(width * scale));
    height = Math.max(1, Math.round(height * scale));
    bytes = nativeImage.createFromBuffer(bytes).resize({ width, height, quality: "best" }).toPNG();
  }
  return { assetIds: [`scene-image-${input.intentId}`], bytes, width, height,
    sha256: createHash("sha256").update(bytes).digest("hex") };
}
