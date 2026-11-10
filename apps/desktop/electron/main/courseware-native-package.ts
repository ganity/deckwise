import { parseMaicClassroom } from "@pi-desktop/courseware-runtime/node";
import { createHash } from "node:crypto";
import JSZip from "jszip";
import { isCoursewareProject, type CoursewareProject } from "@pi-desktop/shared";

type Media = { id: string; sha256: string; mimeType: string; byteLength: number; durationMs: number; data: string };
export type NativeTeachingPackage = { schemaVersion: "deckwise-native-teaching/1"; documentId: string; revision: string;
  assessments?: Record<string, unknown>;
  generation?: { pages?: Array<{ pageId: string; quiz?: unknown }> };
  pages: CoursewareProject["pages"]; media: Media[]; identity: { pages: Array<{ pageId: string; objects: unknown[] }> } };
const namespace = "urn:deckwise:native-teaching:1";
const invalid = () => new Error("Invalid native teaching package");

/** Validate the actual saved carrier and every embedded asset, independently of renderer receipts. */
export async function readNativeTeachingPackage(bytes: Uint8Array): Promise<NativeTeachingPackage | undefined> {
  if (bytes.byteLength > 256 * 1024 * 1024) throw invalid();
  const zip = await JSZip.loadAsync(bytes);
  const entries = Object.values(zip.files);
  if (entries.length > 20000) throw invalid();
  let expanded = 0;
  for (const entry of entries) {
    const size: unknown = Reflect.get(Reflect.get(entry, "_data") ?? {}, "uncompressedSize");
    if (!entry.dir && (!Number.isSafeInteger(size) || Number(size) < 0 || (expanded += Number(size)) > 512 * 1024 * 1024)) throw invalid();
  }
  let native: NativeTeachingPackage | undefined;
  const mediaParts = new Map<string, { sha256: string; data: string }>();
  const xmlEntries = entries.filter(e => /^customXml\/[^/]+\.xml$/.test(e.name));
  for (const entry of xmlEntries) {
    const size = Reflect.get(Reflect.get(entry, "_data") ?? {}, "uncompressedSize");
    if (size > 80 * 1024 * 1024) throw invalid();
    const xml = await entry.async("string");
    const mediaNamespace = "urn:deckwise:native-teaching-media:1";
    if (!xml.slice(0, 512).includes(mediaNamespace) || /<(?:\w+:)?datastoreItem\b/.test(xml.slice(0, 512))) continue;
    const match = /^\s*(?:<\?xml[^?]*\?>\s*)?<((?:[\w]+:)?media)\s+([^>]*)>([\s\S]*)<\/\1>\s*$/.exec(xml);
    if (!match || /<!DOCTYPE|<!ENTITY/i.test(xml) || match[3].includes("<") || /&(?!(?:amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);)/.test(match[3])) throw invalid();
    const declaration = match[1].includes(":") ? "xmlns:" + match[1].split(":")[0] : "xmlns";
    const attributes = Array.from(match[2].matchAll(/([\w:.-]+)\s*=\s*(["'])(.*?)\2/g));
    if (attributes.filter(a => a[1] === declaration && a[3] === mediaNamespace).length !== 1) throw invalid();
    const text = match[3].replace(/&(?:amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);/g, entity => {
      const names: Record<string, string> = { "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&apos;": "'" };
      return names[entity] ?? String.fromCodePoint(entity.startsWith("&#x") ? parseInt(entity.slice(3, -1), 16) : Number(entity.slice(2, -1)));
    });
    const asset = JSON.parse(text);
    if (!asset || typeof asset.id !== "string" || mediaParts.has(asset.id) || typeof asset.data !== "string" || !/^[a-f0-9]{64}$/.test(asset.sha256)) throw invalid();
    mediaParts.set(asset.id, asset);
  }
  for (const entry of xmlEntries) {
    const size = Reflect.get(Reflect.get(entry, "_data") ?? {}, "uncompressedSize");
    if (size > 80 * 1024 * 1024) throw invalid();
    const xml = await entry.async("string");
    if (!xml.includes(namespace)) continue;
    const rootName = /^\s*(?:<\?xml[^?]*\?>\s*)?<([\w:.-]+)/.exec(xml)?.[1];
    if (rootName && rootName.split(":").at(-1) !== "teaching") continue;
    if (native || /<!DOCTYPE|<!ENTITY/i.test(xml)) throw invalid();
    const match = /^\s*(?:<\?xml[^?]*\?>\s*)?<((?:[\w]+:)?teaching)\s+([^>]*)>([\s\S]*)<\/\1>\s*$/.exec(xml);
    if (!match) throw invalid();
    const prefix = match[1].includes(":") ? match[1].split(":")[0] : undefined;
    const declaration = prefix ? "xmlns:" + prefix : "xmlns";
    const attributes = Array.from(match[2].matchAll(/([\w:.-]+)\s*=\s*(["'])(.*?)\2/g));
    if (attributes.filter(a => a[1] === declaration && a[3] === namespace).length !== 1 ||
        match[3].includes("<") || /&(?!(?:amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);)/.test(match[3])) throw invalid();
    const text = match[3].replace(/&(?:amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);/g, entity => {
      const names: Record<string, string> = { "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&apos;": "'" };
      return names[entity] ?? String.fromCodePoint(entity.startsWith("&#x") ? parseInt(entity.slice(3, -1), 16) : Number(entity.slice(2, -1)));
    });
    const value = JSON.parse(text) as NativeTeachingPackage;
    if (!value || value.schemaVersion !== "deckwise-native-teaching/1" || typeof value.documentId !== "string" ||
        typeof value.revision !== "string" || !isCoursewareProject({ schemaVersion: "deckwise-courseware/1", projectId: value.documentId,
          taskType: "plain", title: "Native teaching", source: { revision: value.revision, sha256: value.pages?.flatMap(p => p.actions ?? []).find(a => a.type === "native_animation")?.sourceSha256 ?? "0".repeat(64) },
          teachingRevision: value.revision, pages: value.pages }) || !Array.isArray(value.media) || value.media.length > 1000 ||
        new Set(value.media.map(m => m?.id)).size !== value.media.length || !value.identity || !Array.isArray(value.identity.pages) ||
        value.identity.pages.length !== value.pages.length) throw invalid();
    // Older generated carriers kept full Quiz content in generation evidence only.
    const generatedQuizzes = (Array.isArray(value.generation?.pages) ? value.generation.pages : []).filter(p =>
      p && typeof p.pageId === "string" && p.quiz !== undefined && value.pages.some(page => page.pageId === p.pageId));
    if (generatedQuizzes.length) value.assessments = { ...Object.fromEntries(generatedQuizzes.map(p => [p.pageId, p.quiz])), ...value.assessments };
    if (value.assessments !== undefined) {
      if (!value.assessments || typeof value.assessments !== "object" || Array.isArray(value.assessments) ||
          Object.keys(value.assessments).some(id => !value.pages.some(page => page.pageId === id))) throw invalid();
      const scenes = Object.entries(value.assessments).map(([id, content], order) => ({ id, stageId: value.documentId, type: "quiz", title: id, order, content, actions: [] }));
      parseMaicClassroom({ id: value.documentId, stage: { id: value.documentId, name: "Teaching", createdAt: 0, updatedAt: 0 }, createdAt: new Date(0).toISOString(), scenes });
    }
    let total = 0;
    for (const media of value.media) {
      if (media && media.data === undefined) {
        const part = mediaParts.get(media.id);
        if (!part || part.sha256 !== media.sha256) throw invalid();
        media.data = part.data;
      }
      if (!media || typeof media.id !== "string" || !/^[\w.-]{1,128}$/.test(media.id) || !/^[a-f0-9]{64}$/.test(media.sha256) ||
          !["audio/mpeg", "audio/wav", "audio/ogg", "audio/mp4", "video/mp4"].includes(media.mimeType) || !Number.isSafeInteger(media.byteLength) ||
          media.byteLength < 1 || media.byteLength > 50 * 1024 * 1024 || !Number.isSafeInteger(media.durationMs) || media.durationMs < 1 || media.durationMs > 86400000 ||
          typeof media.data !== "string" || media.data.length > 70 * 1024 * 1024 || (total += media.byteLength) > 60 * 1024 * 1024) throw invalid();
      const data = Buffer.from(media.data, "base64");
      if (data.length !== media.byteLength || data.toString("base64") !== media.data || createHash("sha256").update(data).digest("hex") !== media.sha256) throw invalid();
    }
    const objectIds = new Set<string>();
    for (const [index, page] of value.pages.entries()) {
      if (value.identity.pages[index]?.pageId !== page.pageId || !Array.isArray(value.identity.pages[index]?.objects)) throw invalid();
      const sourceIds = new Set<string>();
      for (const object of value.identity.pages[index].objects) {
        if (!object || typeof object !== "object" || Array.isArray(object)) throw invalid();
        const id = Reflect.get(object, "logicalId"), sourceId = Reflect.get(object, "sourceShapeId");
        if (typeof id !== "string" || !/^[\w.-]{1,128}$/.test(id) || objectIds.has(id) ||
            typeof sourceId !== "string" || !/^\d{1,10}$/.test(sourceId) || sourceIds.has(sourceId)) throw invalid();
        objectIds.add(id); sourceIds.add(sourceId);
      }
      for (const action of page.actions) for (const key of ["audioAssetId", "videoAssetId"]) {
        if (action[key] !== undefined && !value.media.some(m => m.id === action[key])) throw invalid();
      }
    }
    native = value;
  }
  return native;
}
