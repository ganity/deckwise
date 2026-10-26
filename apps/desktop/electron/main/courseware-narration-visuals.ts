import { nativeImage } from "electron";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { narrationPreviewSource } from "@pi-desktop/agent-runtime";
import type { CoursewareSceneImage } from "./courseware-scene-context";

const execute = promisify(execFile);
export type NarrationEvidence = { text: string; notes: string; width: number; height: number;
  elements: Array<{ id: string; kind: string; text: string; bbox: number[]; imageBase64?: string }> };

function image(bytes: Buffer, assetId: string): CoursewareSceneImage {
  let decoded = nativeImage.createFromBuffer(bytes);
  if (decoded.isEmpty()) throw new Error("Narration image could not be decoded");
  const size = decoded.getSize();
  if (size.width * size.height > 32 * 1024 * 1024) throw new Error("Narration image exceeds pixel limit");
  if (Math.max(size.width, size.height) > 1600) decoded = decoded.resize(size.width >= size.height ? { width: 1600 } : { height: 1600 });
  const png = decoded.toPNG(), dimensions = decoded.getSize();
  return { assetIds: [assetId], bytes: png, ...dimensions, sha256: createHash("sha256").update(png).digest("hex") };
}

/** Offline saved-byte rendering. No editor window, native selection or renderer IPC. */
export async function createNarrationVisuals(bytes: Uint8Array, signal: AbortSignal) {
  const directory = await mkdtemp(join(tmpdir(), "deckwise-narration-"));
  let diagnostic: string | undefined;
  try {
    const profile = join(directory, "profile");
    await mkdir(join(profile, "user"), { recursive: true });
    await writeFile(join(profile, "user/registrymodifications.xcu"), '<?xml version="1.0"?><oor:items xmlns:oor="http://openoffice.org/2001/registry"><item oor:path="/org.openoffice.Office.Common/Security/Scripting"><prop oor:name="MacroSecurityLevel" oor:op="fuse"><value>3</value></prop></item><item oor:path="/org.openoffice.Office.Common/Load"><prop oor:name="UpdateDocMode" oor:op="fuse"><value>0</value></prop></item></oor:items>');
    await writeFile(join(directory, "source.pptx"), await narrationPreviewSource(bytes));
    await execute("libreoffice", [`-env:UserInstallation=${pathToFileURL(profile).href}`, "--headless", "--nologo", "--nodefault", "--norestore", "--convert-to", "pdf:impress_pdf_Export", "--outdir", directory, join(directory, "source.pptx")], { signal, timeout: 90_000, maxBuffer: 65536 });
    const pdf = await readFile(join(directory, "source.pdf"));
    if (!pdf.length || pdf.length > 64 * 1024 * 1024) throw new Error("Narration PDF exceeds rendering limit");
  } catch (error) {
    if (signal.aborted) { await rm(directory, { recursive: true, force: true }); signal.throwIfAborted(); }
    diagnostic = `Page rasterization unavailable; using embedded page images: ${String(error).slice(0, 300)}`;
  }
  return {
    diagnostic,
    async page(pageNumber: number, evidence: NarrationEvidence): Promise<{ images: CoursewareSceneImage[]; imageBindings: Array<{ assetId: string; importElementId: string }>; diagnostic?: string }> {
      signal.throwIfAborted();
      let fallback = diagnostic;
      if (!fallback) {
        const prefix = join(directory, `page-${pageNumber}`);
        try {
          await execute("pdftoppm", ["-f", String(pageNumber), "-l", String(pageNumber), "-singlefile", "-scale-to", "1280", "-png", join(directory, "source.pdf"), prefix], { signal, timeout: 30_000, maxBuffer: 65536 });
          const png = await readFile(`${prefix}.png`);
          await rm(`${prefix}.png`);
          if (png.length > 8 * 1024 * 1024) throw new Error("Page raster exceeds limit");
          return { images: [image(png, `page-${pageNumber}-preview`)], imageBindings: [] };
        } catch (error) { signal.throwIfAborted(); fallback = `Page raster failed; using embedded images: ${String(error).slice(0, 300)}`; }
      }
      const selected = evidence.elements.filter(e => e.imageBase64).slice(0, 8);
      const images = selected.map((e, index) => image(Buffer.from(e.imageBase64!, "base64"), `page-${pageNumber}-image-${index + 1}`));
      return { images, imageBindings: selected.map((e, index) => ({ assetId: images[index].assetIds[0], importElementId: e.id })), diagnostic: fallback };
    },
    dispose: () => rm(directory, { recursive: true, force: true }),
  };
}
