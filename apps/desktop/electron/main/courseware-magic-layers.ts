import { createHash } from "node:crypto";
import JSZip from "jszip";
import type { CoursewareScenePlanPage } from "@pi-desktop/shared";
import type { CoursewareSceneCompleteInput } from "./courseware-scene-context";

type Box = [number, number, number, number];
export type MagicLayersManifest = { pipelineRevision: 2; failurePolicy: "best_effort"; repairPolicy: "extract_only";
  generateCleanPlate: true; objects: Array<{ id: string; role: string; bbox: Box; zIndex: number; positivePoints: number[][] }> };
export type MagicLayersPlanningInput = { sessionId: string; page: CoursewareScenePlanPage;
  bytes: Buffer; width: number; height: number; signal: AbortSignal };
export type MagicLayersFallback = (input: MagicLayersPlanningInput & { key: string; requestHash: string;
  sourceSha256: string; projectId?: string; check(): Promise<void> }) => Promise<Buffer>;
const record = (v: unknown): v is Record<string, any> => !!v && typeof v === "object" && !Array.isArray(v);
const invalid = () => new Error("COURSEWARE_MAGICLAYERS_INVALID_RESULT");
const box = (v: unknown, width: number, height: number): v is Box => Array.isArray(v) && v.length === 4 &&
  v.every(Number.isSafeInteger) && v[0] >= 0 && v[1] >= 0 && v[2] > 0 && v[3] > 0 && v[0] + v[2] <= width && v[1] + v[3] <= height;

export function magicLayersManifest(raw: string, width: number, height: number): MagicLayersManifest {
  if (raw.length > 64 * 1024) throw invalid();
  const value: unknown = JSON.parse(raw);
  if (!record(value) || !Array.isArray(value.objects) || !value.objects.length || value.objects.length > 31) throw invalid();
  return { pipelineRevision: 2, failurePolicy: "best_effort", repairPolicy: "extract_only", generateCleanPlate: true,
    objects: value.objects.map((item: unknown, index: number) => {
      if (!record(item) || typeof item.role !== "string" || !item.role.trim() || item.role.length > 60 ||
          /\p{Cc}/u.test(item.role) || !box(item.bbox, width, height) || !Array.isArray(item.positivePoints) ||
          !item.positivePoints.length || item.positivePoints.length > 6 || item.positivePoints.some((p: unknown) =>
            !Array.isArray(p) || p.length !== 2 || !p.every(Number.isFinite) || p[0] < item.bbox[0] || p[1] < item.bbox[1] ||
            p[0] >= item.bbox[0] + item.bbox[2] || p[1] >= item.bbox[1] + item.bbox[3])) throw invalid();
      return { id: `object-${index + 1}`, role: item.role.trim(), bbox: item.bbox,
        zIndex: index + 1, positivePoints: item.positivePoints };
    }) };
}

export async function planMagicLayers(input: MagicLayersPlanningInput, model: { modelKey: string; thinkingLevel?: string },
  complete: (input: CoursewareSceneCompleteInput) => Promise<{ text: string }>): Promise<MagicLayersManifest> {
  input.signal.throwIfAborted();
  const result = await complete({ sessionId: input.sessionId, ...model, signal: input.signal,
    system: 'Inspect the supplied slide pixels and return strict JSON only: {"objects":[{"role":"short descriptive name","bbox":[x,y,width,height],"positivePoints":[[x,y]]}]}. Use integer pixel boxes in the stated canvas, and 1-6 interior foreground points per object, never points on background. Extract all visible teaching characters, independently movable teaching objects, title/question banners, names, and answer controls. Preserve the exact source pixels; do not redraw or invent objects. Keep touching or overlapping action participants together as one object. Group lettering with its own carrier. Extract connecting arrows and flow lines with their related diagram or as verified foreground objects; never leave them in the background. When the requested effect covers a whole diagram, include its subjects, connecting relationships and labels in the extracted targets. Do not include classroom scenery or the whole slide as a foreground object. At most 31 objects. Order objects from back to front.',
    data: JSON.stringify({ canvas: { width: input.width, height: input.height }, page: input.page }),
    images: [{ assetIds: ["visual-master"], sha256: createHash("sha256").update(input.bytes).digest("hex"),
      width: input.width, height: input.height, bytes: input.bytes }] });
  input.signal.throwIfAborted();
  return magicLayersManifest(result.text, input.width, input.height);
}

/** Read only flat in-memory ZIP entries; incomplete/flagged backgrounds cannot enter the compiler. */
export async function magicLayersBundle(bytes: Buffer, requested: MagicLayersManifest, width: number, height: number): Promise<Buffer> {
  if (!bytes.length || bytes.length > 64 * 1024 * 1024) throw invalid();
  const zip = await JSZip.loadAsync(bytes);
  const entries = Object.values(zip.files);
  if (!entries.length || entries.length > 160) throw invalid();
  let total = 0;
  for (const entry of entries) {
    if (entry.dir || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(entry.name) || entry.name.includes("..") ||
        entry.unsafeOriginalName && entry.unsafeOriginalName !== entry.name) throw invalid();
    const metadata = Reflect.get(entry, "_data");
    const length = metadata?.uncompressedSize;
    if (!Number.isSafeInteger(length) || length < 0 || length > 8 * 1024 * 1024) throw invalid();
    total += length;
    if (total > 64 * 1024 * 1024) throw invalid();
  }
  const manifestFile = zip.file("manifest.json");
  if (!manifestFile || Reflect.get(manifestFile, "_data").uncompressedSize > 128 * 1024) throw invalid();
  const manifest: unknown = JSON.parse(await manifestFile.async("string"));
  if (!record(manifest) || manifest.canvas?.width !== width || manifest.canvas?.height !== height ||
      !Array.isArray(manifest.layers) ||
      manifest.layers.some((layer: unknown) => !record(layer)) ||
      !Array.isArray(manifest.targets) || manifest.targets.some((target: unknown) => !record(target)) ||
      manifest.targets.length !== requested.objects.length) throw invalid();
  if (manifest.resultStatus !== "complete" || manifest.layers.length !== requested.objects.length)
    throw new Error(`COURSEWARE_MAGICLAYERS_INCOMPLETE: ${JSON.stringify({ targets: manifest.targets.filter((target: Record<string, unknown>) => target.status !== "succeeded"), cleanPlate: manifest.cleanPlate }).slice(0, 8000)}`);
  const plate = manifest.cleanPlate;
  if (!record(plate) || plate.status !== "generated" || plate.reviewRequired === true || plate.confidence === "low" ||
      plate.method === "source_unchanged" || manifest.layers.some((layer: unknown) => !record(layer) || layer.placeholder === true))
    throw new Error("COURSEWARE_MAGICLAYERS_REVIEW_REQUIRED: incomplete or low-confidence clean plate/layers");
  const used = new Set<string>();
  const png = async (name: unknown, w: number, h: number) => {
    if (typeof name !== "string" || !name.endsWith(".png") || used.has(name)) throw invalid();
    const entry = zip.file(name);
    if (!entry) throw invalid();
    used.add(name);
    const image = await entry.async("nodebuffer");
    if (image.length < 33 || image.toString("hex", 0, 8) !== "89504e470d0a1a0a" ||
        image.readUInt32BE(16) !== w || image.readUInt32BE(20) !== h) throw invalid();
    return image.toString("base64");
  };
  const data: Record<string, unknown>[] = [{ z_index: 0, b64_json: await png(plate.file, width, height) }];
  for (const object of requested.objects) {
    const layers = manifest.layers.filter((layer: Record<string, unknown>) => layer.id === object.id);
    const targets = manifest.targets.filter((target: Record<string, unknown>) => target.id === object.id && target.status === "succeeded");
    if (layers.length !== 1 || targets.length !== 1 || !box(layers[0].bbox, width, height) || layers[0].zIndex !== object.zIndex) throw invalid();
    const [x, y, w, h] = layers[0].bbox;
    data.push({ z_index: object.zIndex, name: object.role, b64_json: await png(layers[0].file, w, h),
      bounding_box: { normalized: [x / width * 1000, y / height * 1000, (x + w) / width * 1000, (y + h) / height * 1000] } });
  }
  return Buffer.from(JSON.stringify({ data }));
}
