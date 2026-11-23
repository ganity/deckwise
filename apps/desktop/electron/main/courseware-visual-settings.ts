import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { link, mkdir, open, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { nativeImage } from "electron";
import type { MessageAttachment } from "@pi-desktop/shared";

type Host = { call<T>(method: string, params: unknown): Promise<T> };
export type SettingImage = { id: string; name: string; bytes: Buffer };
const digest = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const hash = /^[a-f0-9]{64}$/u;

// An image ID is usable only if the owning chat actually contains that user attachment.
export async function chatSettingAttachments(host: Host, sessionId: string, ids: string[] | undefined, check: () => void) {
  if (!/^[A-Za-z0-9_-]{1,128}$/u.test(sessionId) || (ids !== undefined && (!ids.every(id => hash.test(id)) || new Set(ids).size !== ids.length)))
    throw new Error("Invalid visual setting IDs; use the image IDs attached to this chat");
  const found = new Map<string, MessageAttachment>();
  let before: number | undefined;
  do {
    const { session } = await host.call<{ session: { messages: { role: string; attachments?: MessageAttachment[] }[];
      hasMoreBefore?: boolean; messageStart?: number } }>("session.get", { id: sessionId, messageLimit: 100, contentLimit: 1, messageBefore: before });
    check();
    for (const message of session.messages) {
      if (message.role !== "user") continue;
      for (const image of message.attachments ?? []) {
        const id = image.ref.slice("attachments/".length);
        if (image.kind === "image" && image.ref === "attachments/" + id && hash.test(id) && (!ids || ids.includes(id)) && !found.has(id)) found.set(id, image);
      }
    }
    if (ids && found.size === ids.length) break;
    if (!session.hasMoreBefore || !session.messageStart || before !== undefined && session.messageStart >= before) {
      if (!ids) break;
      throw new Error("Visual setting image missing from this chat. Attach it again and update the draft before generating images.");
    }
    before = session.messageStart;
  } while (true);
  return found;
}

export async function resolveChatSettingImages(dataDir: string, host: Host, sessionId: string, ids: string[], check: () => void) {
  if (!ids.length) return [];
  const found = await chatSettingAttachments(host, sessionId, ids, check);
  const images: SettingImage[] = [];
  for (const id of ids) {
    const file = await open(join(dataDir, "attachments", id), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const stat = await file.stat();
      if (!stat.isFile() || !stat.size || stat.size > 30 * 1024 * 1024) throw new Error("Invalid visual setting file size");
      const bytes = await file.readFile();
      if (digest(bytes) !== id) throw new Error("Visual setting bytes changed; attach the original again");
      images.push({ id, name: found.get(id)!.name, bytes });
    } finally { await file.close(); }
    check();
  }
  return images;
}

// An option has one pinned request across worker restarts, even when a refresh omits the original IDs.
export async function quizSettingReference(dataDir: string, principal: string, host: Host, sessionId: string,
  target: string[], ids: string[] | undefined, check: () => void) {
  const dir = join(dataDir, "visual-settings", principal);
  const path = join(dir, digest(Buffer.from(JSON.stringify([sessionId, ...target]))) + ".json");
  const read = async () => {
    const row = JSON.parse(await readFile(path, "utf8")) as { ids: string[]; guide: string; jpeg: string; sha256: string };
    if (ids && JSON.stringify(row.ids) !== JSON.stringify(ids)) throw new Error("Quiz option already has a different pinned visual setting");
    const bytes = Buffer.from(row.jpeg, "base64");
    if (!row.guide || !bytes.length || bytes.length > 8 * 1024 * 1024 || digest(bytes) !== row.sha256) throw new Error("Invalid saved quiz visual setting");
    check();
    return { guide: row.guide, referenceImage: { sha256: row.sha256, byteLength: bytes.length, mimeType: "image/jpeg" as const, bytesBase64: row.jpeg } };
  };
  try { return await read(); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  if (!ids?.length) return undefined;
  const images = await resolveChatSettingImages(dataDir, host, sessionId, ids, check);
  const sheet = sceneSettingSheet(images);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const temp = path + "." + randomUUID();
  try {
    await writeFile(temp, JSON.stringify({ ids, guide: sheet.instruction, sha256: digest(sheet.bytes), jpeg: sheet.bytes.toString("base64") }), { flag: "wx", mode: 0o600 });
    check();
    try { await link(temp, path); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  } finally { await rm(temp, { force: true }); }
  return read();
}

// Give the official PPT image manifest a stable filename with a real format extension.
export async function materializePptSettings(dataDir: string, sessionId: string, images: SettingImage[]) {
  const root = join(dataDir, "scratch", sessionId, "visual-settings");
  await mkdir(root, { recursive: true });
  if (await realpath(root) !== join(await realpath(dataDir), "scratch", sessionId, "visual-settings")) throw new Error("Visual setting directory changed");
  const result = [];
  for (const image of images) {
    const decoded = nativeImage.createFromBuffer(image.bytes);
    if (decoded.isEmpty()) throw new Error("Unreadable visual setting: " + image.name);
    const png = image.bytes.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex"));
    const jpeg = image.bytes.subarray(0, 3).equals(Buffer.from([255, 216, 255]));
    const bytes = png || jpeg ? image.bytes : decoded.toPNG();
    const path = join(root, digest(bytes) + (jpeg ? ".jpg" : ".png"));
    const temp = join(root, randomUUID());
    try {
      await writeFile(temp, bytes, { flag: "wx", mode: 0o600 });
      try { await link(temp, path); } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
        try {
          const stat = await file.stat();
          if (!stat.isFile() || stat.size !== bytes.length || !(await file.readFile()).equals(bytes))
            throw new Error("Pinned visual setting changed: " + image.name);
        } finally { await file.close(); }
      }
    } finally { await rm(temp, { force: true }); }
    result.push({ id: image.id, name: image.name, path });
  }
  return result;
}

// The scene image service accepts one reference. Tile images without cropping, in prompt order.
export function sceneSettingSheet(images: SettingImage[], cover?: Buffer) {
  const inputs = [...(cover ? [cover] : []), ...images.map(item => item.bytes)];
  const columns = Math.ceil(Math.sqrt(inputs.length)), rows = Math.ceil(inputs.length / columns);
  const cell = Math.min(1024, Math.floor(3072 / Math.max(columns, rows)));
  const width = columns * cell, height = rows * cell;
  const bitmap = Buffer.alloc(width * height * 4, 255);
  inputs.forEach((bytes, index) => {
    const source = nativeImage.createFromBuffer(bytes);
    if (source.isEmpty()) throw new Error("Unreadable visual setting image");
    const size = source.getSize(), scale = Math.min(cell / size.width, cell / size.height);
    const w = Math.max(1, Math.round(size.width * scale)), h = Math.max(1, Math.round(size.height * scale));
    const x = index % columns * cell + Math.floor((cell - w) / 2), y = Math.floor(index / columns) * cell + Math.floor((cell - h) / 2);
    const pixels = source.resize({ width: w, height: h, quality: "best" }).toBitmap();
    if (pixels.length !== w * h * 4) throw new Error("Invalid visual setting bitmap");
    // NativeImage stores premultiplied pixels. Flatten transparent artwork on white before JPEG encoding.
    for (let offset = 0; offset < pixels.length; offset += 4) {
      const white = 255 - pixels[offset + 3];
      pixels[offset] = Math.min(255, pixels[offset] + white);
      pixels[offset + 1] = Math.min(255, pixels[offset + 1] + white);
      pixels[offset + 2] = Math.min(255, pixels[offset + 2] + white);
      pixels[offset + 3] = 255;
    }
    for (let row = 0; row < h; row++) {
      pixels.copy(bitmap, ((y + row) * width + x) * 4, row * w * 4, (row + 1) * w * 4);
    }
  });
  const bytes = nativeImage.createFromBitmap(bitmap, { width, height, scaleFactor: 1 }).toJPEG(90);
  if (!bytes.length || bytes.length > 8 * 1024 * 1024) throw new Error("Visual setting sheet exceeds the image service limit");
  const labels = [...(cover ? ["approved cover style"] : []), ...images.map(item => item.name)];
  return { bytes, instruction: "Reference panels, left to right then top to bottom: " + JSON.stringify(labels) +
    ". Preserve the depicted subjects' identities in one new teaching scene. Omit panel borders, sheet layouts and reference labels." };
}
