import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { isCoursewareSnapshot } from "@pi-desktop/shared";
import { readNativeTeachingPackage } from "./courseware-native-package";
import type { PptEditorController } from "./ppt-editor";
import type { CoursewareTeachingCoordinator } from "./courseware-teaching";

/** Capture a fixed build from the saved native file, without a mutable Host teaching mirror. */
export async function captureNativeTeachingSnapshot(input: { editor: PptEditorController; teaching: CoursewareTeachingCoordinator;
  workspace: string; sessionId: string; payload: unknown; assertOwner(): void }) {
  const { editor, teaching, workspace, sessionId } = input;
  const current = await teaching.native("open");
  if (!current) return;
  if (!input.payload || typeof input.payload !== "object" || Array.isArray(input.payload) || Object.keys(input.payload).length !== 2) throw new Error("Invalid native snapshot request");
  const view = current.value as import("@pi-desktop/shared").CoursewareTeachingView;
  if (Reflect.get(input.payload, "viewId") !== view.viewId || Reflect.get(input.payload, "expectedTeachingRevision") !== view.project.teachingRevision) throw new Error("Native teaching view changed");
  for (const [index, page] of view.project.pages.entries()) if (page.actions.some(action => action.type === "native_animation")) {
    await teaching.native("validate-animations", { viewId: view.project.projectId + "." + page.pageId, expectedTeachingRevision: view.project.teachingRevision }, index + 1);
    input.assertOwner();
  }
  input.assertOwner(); await editor.ensureSaved(workspace); input.assertOwner();
  const source = editor.teachingSnapshot(workspace);
  const carrier = await readNativeTeachingPackage(await fs.readFile(source.path));
  if (!carrier || carrier.documentId !== view.project.projectId || carrier.revision !== view.project.teachingRevision) throw new Error("Native teaching changed during save");
  const directory = await fs.mkdtemp(join(workspace, ".deckwise-native-snapshot-"));
  await fs.chmod(directory, 0o700);
  try {
    const assets: Array<{ asset: { id: string; sha256: string; mimeType: string }; path: string }> = [];
    const used = new Set(carrier.pages.flatMap(p => p.actions).flatMap(a => [a.audioAssetId, a.videoAssetId]).filter(v => typeof v === "string"));
    for (const media of carrier.media.filter(m => used.has(m.id))) {
      const path = join(directory, media.sha256 + ".bin");
      try { await fs.writeFile(path, Buffer.from(media.data, "base64"), { flag: "wx", mode: 0o600 }); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
      assets.push({ asset: { id: media.id, sha256: media.sha256, mimeType: media.mimeType }, path });
    }
    return await teaching.withSaved(sessionId, async (host, jobId, snapshot, context) => {
      input.assertOwner();
      if (snapshot.sha256 !== source.sha256 || snapshot.path !== source.path || context.page !== view.pageNumber) throw new Error("Native snapshot source changed");
      const snapshotId = randomUUID();
      for (const page of carrier.pages) for (const action of page.actions) if (action.type === "native_animation") action.sourceSha256 = source.sha256;
      const project = { ...view.project, source: { revision: carrier.revision, sha256: source.sha256 }, pages: carrier.pages };
      const result = await host.call<{ snapshot: unknown }>("courseware.snapshot.importNative", { sessionId, jobId, snapshotId, project,
        identity: carrier.identity, assets });
      input.assertOwner(); await teaching.assertCurrent(snapshot, context, sessionId, host);
      if (!isCoursewareSnapshot(result.snapshot) || result.snapshot.snapshotId !== snapshotId || result.snapshot.projectId !== project.projectId ||
          result.snapshot.teachingRevision !== carrier.revision || result.snapshot.source.sha256 !== source.sha256) throw new Error("Invalid native snapshot receipt");
      return { value: result.snapshot };
    });
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
}

/** A native copy is a complete PPTX, including every embedded adopted asset. */
export async function copyNativeTeaching(input: { editor: PptEditorController; teaching: CoursewareTeachingCoordinator;
  workspace: string; sessionId: string; assertOwner(): void }) {
  const current = await input.teaching.native("open");
  if (!current) return;
  input.assertOwner(); await input.editor.ensureSaved(input.workspace); input.assertOwner();
  const source = input.editor.teachingSnapshot(input.workspace), bytes = await fs.readFile(source.path);
  if (createHash("sha256").update(bytes).digest("hex") !== source.sha256) throw new Error("Native copy source changed");
  const carrier = await readNativeTeachingPackage(bytes);
  if (!carrier || carrier.documentId !== (current.value as import("@pi-desktop/shared").CoursewareTeachingView).project.projectId) throw new Error("Native copy identity changed");
  const path = join(input.workspace, `courseware-copy-${randomUUID()}.pptx`);
  input.assertOwner(); await input.editor.verifyTeachingSource(input.workspace); input.assertOwner();
  await fs.writeFile(path, bytes, { mode: 0o600, flag: "wx" });
  return { path, mediaCount: carrier.media.length };
}
