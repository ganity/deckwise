import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { MaicClassroom } from "@pi-desktop/courseware-runtime/node";
import type { CoursewareTeachingCoordinator } from "./courseware-teaching";
import type { PptEditorController } from "./ppt-editor";
import type { ClassroomView } from "./courseware-classroom";
import type { NativeClassroomSeed } from "./courseware-classroom-native";
import { adoptionRevision, sourceHash } from "./courseware-source-files";
import { jobIdFor, replaceSourceFile } from "./ppt-editor-files";
import { CoursewareNativeSave } from "./courseware-native-save";
import type { SavedCourseware } from "./courseware-saved-narration";
import { coursewareAuthoringUrl } from "./courseware-runtime";
import { readClassroomAsset } from "./courseware-classroom-assets";

type Request = { sessionId: string; projectId: string; expectedRevision: string | null; expectedSourceRevision: string; classroom: MaicClassroom };
const projection = (classroom: MaicClassroom) => JSON.stringify(classroom.scenes.map(scene => ({
  id: scene.id, page: scene.metadata?.nativePageId, copy: scene.metadata?.copiedFromNativePageId,
  quiz: scene.content.type === "quiz" ? [scene.title, scene.content] : undefined,
  question: scene.actions?.filter(a => a.type === "interaction_checkpoint" && a.checkpointKind === "chapter_summary").map(a => a.question),
  speeches: scene.actions?.filter(a => a.type === "speech").filter(a => !Object.values(scene.metadata?.assessmentSpeechIds ?? {}).includes(a.id)).map(a => a.text),
})));

/** Agent media updates use the same compiler and durable native-save receipt with Office closed. */
export async function writeSavedAssessmentClassroom(input: {
  args: Request; saved: SavedCourseware; workspace: string; sourcePath: string; assertCurrent(): void;
}): Promise<ClassroomView> {
  const { args, saved, workspace, sourcePath } = input, { host } = saved;
  const check = async () => { input.assertCurrent(); await saved.check(); input.assertCurrent(); };
  await check();
  const seed = await host.call<NativeClassroomSeed>("courseware.classroom.source", { sessionId: args.sessionId, projectId: args.projectId, jobId: saved.jobId });
  if (!seed.classroom || seed.revision !== args.expectedRevision || seed.currentSourceRevision !== args.expectedSourceRevision || seed.sourceRevision !== seed.currentSourceRevision)
    throw new Error("Saved assessment classroom changed; read context again");
  // Managed question narration lives in canonical teaching data, without changing the slide projection.
  const canvasProjection = (document: MaicClassroom) => JSON.stringify(document.scenes.map(scene => ({ id: scene.id, title: scene.title, content: scene.content })));
  if (canvasProjection(seed.classroom) === canvasProjection(args.classroom)) {
    await check(); return host.call<ClassroomView>("courseware.classroom.write", args);
  }
  if (args.classroom.scenes.length !== seed.classroom.scenes.length || args.classroom.scenes.some((scene, index) =>
      scene.id !== seed.classroom!.scenes[index].id || scene.metadata?.nativePageId !== seed.classroom!.scenes[index].metadata?.nativePageId))
    throw new Error("Assessment media cannot reorder or replace saved pages");
  const authoring = coursewareAuthoringUrl();
  if (!authoring) throw new Error("Installed courseware compiler is unavailable");
  const { syncClassroomPptx } = await import(/* @vite-ignore */ authoring) as typeof import("@pi-desktop/courseware-runtime/authoring");
  const pages = seed.project.pages.map((page, index) => ({ pageId: page.pageId, objects: seed.ir.pages[index].elements.map(element => ({
    id: seed.mapping.pages[index].objects?.find(object => object.importElementId === element.id)?.objectId ?? element.id,
    objectName: element.sourceObjectName ?? element.id,
  })) }));
  const result = await syncClassroomPptx({ source: saved.bytes, sourceHash: `sha256:${saved.project.source.sha256}`,
    previous: seed.classroom, classroom: args.classroom, pages,
    readImage: src => {
      const image = args.classroom.scenes.flatMap(scene => scene.content.type === "quiz"
        ? scene.content.questions.flatMap(question => [question.image, ...(question.options ?? []).map(option => option.image)]) : []).find(image => image?.src === src);
      if (!image) throw new Error("Image is not part of the saved assessment");
      return readClassroomAsset(workspace, { url: src, assetId: image.assetId ?? src, mimeType: image.mimeType ?? "image/*" });
    } });
  await check();
  const bytes = Buffer.from(result.pptx);
  await commitSavedPptx({ saved, workspace, sourcePath, sessionId: args.sessionId, assertCurrent: input.assertCurrent,
    bytes, lineage: {
      pageTokens: result.pages.map((page, index) => {
        const id = args.classroom.scenes[index].metadata?.nativePageId;
        return typeof id === 'string' ? id : `scene-${page.sceneId}`;
      }),
      objects: result.pages.map(page => page.objectNames.map(name => ({ name,
        ...(page.sourcePageId && page.animationUnchanged ? { sourceName: name, sourcePageToken: page.sourcePageId } : {}),
      }))), animationUnchanged: result.pages.map(page => page.animationUnchanged),
    }, classroomSave: { expectedRevision: args.expectedRevision, classroom: args.classroom } });
  return host.call<ClassroomView>("courseware.classroom.get", { sessionId: args.sessionId, projectId: args.projectId });
}

/** Shared durable transaction for compiler writes, including teaching-only native timing. */
export async function commitSavedPptx(input: {
  saved: SavedCourseware; workspace: string; sourcePath: string; sessionId: string; bytes: Buffer;
  lineage: { pageTokens: string[]; objects: Array<Array<{ name: string; sourceName?: string; sourcePageToken?: string }>>; animationUnchanged: boolean[] };
  classroomSave?: { expectedRevision: string | null; classroom: MaicClassroom }; assertCurrent(): void;
}): Promise<void> {
  const { saved, workspace, sourcePath, sessionId, bytes } = input, { host } = saved;
  const outputSha256 = sourceHash(bytes);
  const check = async () => { input.assertCurrent(); await saved.check(); input.assertCurrent(); };
  await check();
  const original = await adoptionRevision(workspace, sourcePath, Buffer.from(saved.bytes));
  const output = await adoptionRevision(workspace, sourcePath, bytes);
  const binding = { projectId: createHash("sha256").update(workspace).digest("hex"), documentId: jobIdFor(workspace, sourcePath), sessionId: `saved-${sessionId}` };
  const saveRequestId = randomUUID();
  const lineage = { protocol: "deckwise-office-page-lineage/1", ...binding, saveRequestId,
    sourceSha256: saved.project.source.sha256, outputSha256, openedPageTokens: saved.project.pages.map(page => page.pageId), ...input.lineage };
  const saves = new CoursewareNativeSave(() => host, () => sessionId, async () => workspace,
    () => input.assertCurrent(), operation => operation());
  await saved.release();
  const receipt = await saves.prepare({ workspace, sourcePath, sourceRevisionPath: original.documentPath,
    sourceSha256: saved.project.source.sha256, outputPath: output.documentPath, outputSha256, binding, saveRequestId, lineage,
    ...(input.classroomSave ? { classroomSave: input.classroomSave } : {}) });
  try {
    await check();
    await replaceSourceFile(sourcePath, bytes, "pptx", saved.project.source.sha256);
    await receipt.commit();
  } catch (error) {
    // Resolve an uncertain replacement from actual bytes before allowing any later write.
    const pending = await host.call<{ save: { saveId: string } | null }>("courseware.nativeSave.forPath", { sessionId, sourcePath });
    if (pending.save) await host.call("courseware.nativeSave.resolve", { sessionId, saveId: pending.save.saveId });
    throw error;
  }
  input.assertCurrent();
}

/** A single Host save receipt commits the PPT identity and canonical classroom together. */
export function createClassroomNativeWriter(input: {
  teaching: CoursewareTeachingCoordinator; editor: PptEditorController;
  getWorkspace(): Promise<string | null>;
  assertOwned(sessionId: string): void;
  reopen(path: string, sessionId: string): Promise<void>;
}) {
  // Undo can restore a deleted body page from an immutable, previously verified native
  // revision. Keep paths rather than PPT bytes, scoped to this editor process/project.
  const archives = new Map<string, Map<string, { path: string; sha256: string; index: number; scene: MaicClassroom["scenes"][number]; objects: Array<{ id: string; objectName: string }> }>>();
  return async (args: Request): Promise<ClassroomView> => {
    if (args.classroom.scenes.some(scene => scene.content.type === "quiz" && scene.content.questions.length !== 1))
      throw new Error("每个 Quiz 页面必须且只能包含一道题，请将多道题拆为独立页面");
    const workspace = await input.getWorkspace();
    if (!workspace) throw new Error("Classroom workspace is unavailable");
    await input.editor.ensureSaved(workspace);
    const selectedPage = typeof input.editor.getContext === "function" ? (await input.editor.getContext(workspace)).page : undefined;
    let saveLive: (() => Promise<ClassroomView>) | undefined;
    const saved = await input.teaching.withSaved(args.sessionId, async (host, jobId, snapshot, context, sessionId, parseOutput) => {
      const seed = await host.call<NativeClassroomSeed>("courseware.classroom.source", { sessionId, projectId: args.projectId, jobId });
      if (!seed.classroom || seed.revision !== args.expectedRevision || seed.currentSourceRevision !== args.expectedSourceRevision || seed.sourceRevision !== seed.currentSourceRevision)
        throw new Error("Classroom or source changed; reopen before saving");
      if (projection(seed.classroom) === projection(args.classroom)) {
        await input.teaching.assertCurrent(snapshot, context, sessionId, host);
        return host.call<ClassroomView>("courseware.classroom.write", args);
      }
      const index = Number(selectedPage) - 1;
      const scene = args.classroom.scenes[index], previous = seed.classroom.scenes[index];
      const onlyCurrentQuiz = scene?.content.type === "quiz" && previous?.content.type === "quiz" &&
        args.classroom.scenes.length === seed.classroom.scenes.length && args.classroom.scenes.every((item, position) =>
          item.id === seed.classroom!.scenes[position].id && item.metadata?.nativePageId === seed.classroom!.scenes[position].metadata?.nativePageId &&
          (position === index || projection({ ...args.classroom, scenes: [item] }) === projection({ ...seed.classroom!, scenes: [seed.classroom!.scenes[position]] })));
      if (onlyCurrentQuiz && projection({ ...args.classroom, scenes: [{ ...scene, title: previous.title, content: previous.content }] }) ===
          projection({ ...seed.classroom, scenes: [previous] })) {
        const authoring = coursewareAuthoringUrl();
        if (!authoring) throw new Error("Installed courseware compiler is unavailable");
        const { prepareAssessmentPage, assessmentPptxScene } = await import(/* @vite-ignore */ authoring) as typeof import("@pi-desktop/courseware-runtime/authoring");
        const canvas = { width: seed.ir.pages[index].width, height: seed.ir.pages[index].height };
        const { projected, assets } = await prepareAssessmentPage(scene, `sha256:${snapshot.sha256}`, canvas, src => {
          const image = scene.content.type === "quiz" ? scene.content.questions.flatMap(q => [q.image, ...(q.options ?? []).map(o => o.image)]).find(image => image?.src === src) : undefined;
          if (!image) throw new Error("Quiz image is not part of the canonical classroom");
          return readClassroomAsset(workspace, { url: src, assetId: image.assetId ?? src, mimeType: image.mimeType ?? "image/*" });
        });
        await input.teaching.assertCurrent(snapshot, context, sessionId, host);
        const payload = { binding: { projectId: snapshot.projectId, documentId: snapshot.documentId, sessionId: snapshot.sessionId },
          page: index + 1, editGeneration: context.editGeneration,
          previous: assessmentPptxScene(previous, `sha256:${snapshot.sha256}`, canvas), next: projected, assets };
        // Native save takes the same teaching lock: release the read before dispatch/export.
        saveLive = async () => {
          input.assertOwned(sessionId);
          await input.editor.applyClassroomPage(workspace, snapshot, payload, { expectedRevision: args.expectedRevision, classroom: args.classroom });
          input.assertOwned(sessionId);
          return host.call<ClassroomView>("courseware.classroom.get", { sessionId, projectId: args.projectId });
        };
        return undefined;
      }
      const pages = seed.project.pages.map((page, index) => ({ pageId: page.pageId,
        objects: seed.ir.pages[index].elements.map(element => ({
          id: seed.mapping.pages[index].objects?.find(o => o.importElementId === element.id)?.objectId ?? element.id,
          objectName: element.sourceObjectName ?? element.id,
        })),
      }));
      const scope = `${workspace}:${args.projectId}`;
      const archive = archives.get(scope) ?? new Map(); archives.set(scope, archive);
      for (const [index, page] of pages.entries()) {
        const scene = seed.classroom.scenes.find(scene => scene.metadata?.nativePageId === page.pageId);
        if (scene) archive.set(page.pageId, { path: snapshot.path, sha256: snapshot.sha256, index, scene, objects: page.objects });
      }
      const restoredPages = [];
      for (const scene of args.classroom.scenes) {
        const pageId = scene.metadata?.nativePageId ?? scene.metadata?.copiedFromNativePageId;
        if (typeof pageId !== "string" || pages.some(page => page.pageId === pageId)) continue;
        const old = archive.get(pageId);
        if (!old) continue;
        const source = await readFile(old.path);
        if (sourceHash(source) !== old.sha256) throw new Error("Archived undo source changed");
        restoredPages.push({ ...old, pageId, source });
      }
      // Native dependencies must resolve beside the staged worker, outside Main's bundle.
      const authoring = coursewareAuthoringUrl();
      if (!authoring) throw new Error("Installed courseware compiler is unavailable");
      const { syncClassroomPptx } = await import(/* @vite-ignore */ authoring) as typeof import("@pi-desktop/courseware-runtime/authoring");
      const result = await syncClassroomPptx({ source: await readFile(snapshot.path), sourceHash: `sha256:${snapshot.sha256}`,
        previous: seed.classroom, classroom: args.classroom, pages, restoredPages,
        readImage: async src => {
          const image = args.classroom.scenes.flatMap(scene => scene.content.type === "quiz"
            ? scene.content.questions.flatMap(q => [q.image, ...(q.options ?? []).map(o => o.image)]) : []).find(image => image?.src === src);
          if (!image) throw new Error("Quiz image is not part of the canonical classroom");
          return readClassroomAsset(workspace, { url: src, assetId: image.assetId ?? src, mimeType: image.mimeType ?? "image/*" });
        } });
      const bytes = Buffer.from(result.pptx), outputSha256 = sourceHash(bytes);
      const revision = await adoptionRevision(workspace, snapshot.sourcePath, bytes);
      const outputJob = await parseOutput(revision.documentPath, outputSha256);
      const lineage = { protocol: "deckwise-office-page-lineage/1", projectId: snapshot.projectId,
        documentId: snapshot.documentId, sessionId: snapshot.sessionId, saveRequestId: randomUUID(),
        sourceSha256: snapshot.sha256, outputSha256, openedPageTokens: seed.project.pages.map(page => page.pageId),
        pageTokens: result.pages.map((page, index) => args.classroom.scenes[index].metadata?.nativePageId ?? `scene-${page.sceneId}`),
        objects: result.pages.map(page => page.objectNames.map(name => ({ name,
          ...(page.sourcePageId && page.animationUnchanged ? { sourceName: name, sourcePageToken: page.sourcePageId } : {}),
        }))), animationUnchanged: result.pages.map(page => page.animationUnchanged) };
      const receipt = await host.call<{ saveId: string; status: string }>("courseware.nativeSave.prepare", {
        sessionId, jobId: outputJob, sourcePath: snapshot.sourcePath, lineage,
        classroomSave: { expectedRevision: args.expectedRevision, classroom: args.classroom },
      });
      if (!receipt.saveId || receipt.status !== "pending") throw new Error("Invalid classroom save receipt");
      let closed = false;
      try {
        await input.teaching.assertCurrent(snapshot, context, sessionId, host);
        input.editor.freezeForSourceAdoption(workspace, snapshot); closed = true;
        input.assertOwned(sessionId);
        await replaceSourceFile(snapshot.sourcePath, bytes, "pptx", snapshot.sha256);
        const saved = await host.call<{ status: string }>("courseware.nativeSave.resolve", { sessionId, saveId: receipt.saveId });
        if (saved.status !== "committed") throw new Error("Classroom save requires recovery");
      } catch (error) {
        // Resolve against actual live bytes, including replacement that completed before an interruption.
        await host.call("courseware.nativeSave.resolve", { sessionId, saveId: receipt.saveId });
        throw error;
      } finally {
        if (closed) {
          input.assertOwned(sessionId); await input.reopen(snapshot.sourcePath, sessionId);
          if (selectedPage) input.editor.configureUi({ page: Math.min(selectedPage, args.classroom.scenes.length) });
        }
      }
      input.assertOwned(sessionId);
      return host.call<ClassroomView>("courseware.classroom.get", { sessionId, projectId: args.projectId });
    });
    if (saveLive) return saveLive();
    if (!saved) throw new Error("Missing classroom save result");
    return saved;
  };
}
