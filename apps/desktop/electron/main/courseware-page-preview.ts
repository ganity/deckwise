import { createHash } from "node:crypto";
import { captureCoursewareSceneImages } from "./courseware-scene-context";

/** Native page tokens remain private to this newly opened readonly source. */
export function sourcePreviewTarget(context: unknown, sourceSha256: string, page: number) {
  const value = context as { readOnly?: unknown; pageLineage?: { sourceSha256?: unknown; pageTokens?: unknown; openedPageTokens?: unknown } } | null;
  const lineage = value?.pageLineage;
  const tokens = lineage?.pageTokens, opened = lineage?.openedPageTokens;
  if (!/^[a-f0-9]{64}$/u.test(sourceSha256) || value?.readOnly !== true ||
      !Number.isSafeInteger(page) || page < 1 || page > 5000 || lineage?.sourceSha256 !== sourceSha256 ||
      !Array.isArray(tokens) || !Array.isArray(opened) || tokens.length === 0 || tokens.length > 5000 || tokens.length !== opened.length ||
      page > tokens.length || new Set(tokens).size !== tokens.length ||
      tokens.some((token, i) => typeof token !== "string" || !/^[\w-]{1,128}$/u.test(token) || token !== opened[i]))
    throw new Error("A fresh readonly source/page identity is required for preview");
  return { sourceSha256, page, pageToken: tokens[page - 1] as string };
}

export function captureSourcePagePreview(value: unknown, expected: ReturnType<typeof sourcePreviewTarget>, omitNativeText: boolean, signal?: AbortSignal) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid page preview");
  const reply = value as Record<string, unknown>;
  if (Object.keys(reply).some(key => !["sourceSha256", "pageToken", "page", "mime", "png", "nativeTextOmitted"].includes(key)) ||
      reply.sourceSha256 !== expected.sourceSha256 || reply.pageToken !== expected.pageToken || reply.page !== expected.page || reply.mime !== "image/png" ||
      !(reply.png instanceof Uint8Array) || reply.png.length < 45 || reply.png.length > 8 * 1024 * 1024 ||
      (omitNativeText ? reply.nativeTextOmitted !== true : reply.nativeTextOmitted !== undefined)) throw new Error("Page preview differs from the requested source/page");
  const bytes = Buffer.from(reply.png);
  const width = bytes.readUInt32BE(16), height = bytes.readUInt32BE(20);
  if (Math.max(width, height) !== 1600 || Math.min(width, height) < 64) throw new Error("Page preview resolution exceeds its contract");
  const [image] = captureCoursewareSceneImages([{ assetIds: [`source-${expected.sourceSha256}-${expected.page}-${omitNativeText ? "textless" : "visual"}`],
    sha256: createHash("sha256").update(bytes).digest("hex"), bytes, width, height }], signal);
  // shortcut: pictures can retain raster text; explicit clean-plate review is required before model compilation.
  return { ...expected, nativeTextOmitted: omitNativeText, image };
}
