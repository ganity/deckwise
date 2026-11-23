import { createHash } from "node:crypto";

/** Only current, pixel-bound native objects can supply isolated images to a reviewer. */
export function nativeLayerImages(value: unknown, objectIds: string[]) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 32) throw new Error("Invalid native layer bindings");
  const seen = new Set<string>();
  let total = 0;
  return value.map(layer => {
    if (!layer || typeof layer.objectId !== "string" || seen.has(layer.objectId) || !objectIds.includes(layer.objectId) ||
        typeof layer.dataUrl !== "string" || layer.dataUrl.length > 44 * 1024 * 1024 ||
        !/^data:image\/png;base64,[A-Za-z0-9+/]+=*$/.test(layer.dataUrl)) throw new Error("Invalid native layer preview");
    seen.add(layer.objectId);
    const bytes = Buffer.from(layer.dataUrl.split(",")[1], "base64");
    total += bytes.length;
    if (bytes.length < 33 || total > 48 * 1024 * 1024 || bytes.readUInt32BE(0) !== 0x89504e47) throw new Error("Invalid native layer PNG");
    const width = bytes.readUInt32BE(16), height = bytes.readUInt32BE(20);
    if (width < 1 || height < 1 || width > 4096 || height > 4096) throw new Error("Invalid native layer dimensions");
    return { objectId: layer.objectId, bytes, width, height,
      sha256: createHash("sha256").update(bytes).digest("hex"), assetIds: [`native-layer-${layer.objectId}`] };
  });
}
