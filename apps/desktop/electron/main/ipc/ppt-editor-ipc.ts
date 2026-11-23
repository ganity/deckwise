import { coursewareWorkerPath } from "../courseware-runtime";
import { createQuizImageReview } from "../courseware-quiz-image-review";
import { CoursewareDocumentTools } from "../courseware-document-tools";
import { createCoursewareDocumentRuntime, createBackgroundCoursewareEditor } from "../courseware-document-runtime";
import { ContentReviewTurns } from '../courseware-content-review';
import { createNativeAssessmentMedia } from "../courseware-native-assessment-media";
import { routeNativeMediaLibrary } from "../courseware-native-library";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { app } from "electron";
import { CoursewareDelivery } from "../courseware-delivery";
import { coursewareDeliveryFingerprint, exportNativeDelivery } from "../courseware-delivery-export";
import { readNativeTeachingPackage } from "../courseware-native-package";
import { CoursewareNativeMusic } from "../courseware-native-music";
import { CoursewareNativeVideo } from "../courseware-native-video";
import { decodeCoursewareVideo } from "../courseware-audio-decode";
import type { CoursewareNativeTools } from "../courseware-native-tools";
import { captureNativeTeachingSnapshot, copyNativeTeaching } from "../courseware-native-snapshot";
import { CoursewareNativeAudio } from "../courseware-native-audio";
import { CoursewareNativeSave } from "../courseware-native-save";
import { CoursewareNativeMedia } from "../courseware-native-media";
import { createNativeTeachingHandler } from "../courseware-native-sidebar";
import { CoursewareNativeFadeCoordinator } from "../courseware-native-fade";
import type { BrowserWindow } from "electron";
import { IPC } from "@pi-desktop/shared";
import { PptEditorController, type PptEditorState } from "../ppt-editor";
import type { IpcRegistrar } from "./types";
import type { HostProcess } from "../host-process";
import { CoursewareTeachingCoordinator } from "../courseware-teaching";
import { CoursewareAssetLockCoordinator } from "../courseware-asset-locks";
import { CoursewareCandidateCoordinator } from "../courseware-candidates";
import { PptEditorChatBridge } from "../ppt-editor-chat";
import { PptxCandidatePreview } from "../pptx-candidate-preview";
import { CoursewareSourceAdoption } from "../courseware-source-adoption";
import { CoursewareTtsCoordinator } from "../courseware-tts";
import { decodeCoursewareAudio, decodeCoursewarePortableMedia } from "../courseware-audio-decode";
import { CoursewarePortableMedia } from "../courseware-portable-media";
import type { DesktopAuthSession } from "../auth-session";
import { CoursewareImageReview } from "../courseware-image-review";
import { CoursewareVisualReview } from "../courseware-visual-review";
import { renderCoursewareSourceVisuals } from "../courseware-source-visuals";
import { CoursewareStyleReviewCoordinator } from "../courseware-style-review";
import { registerCoursewareCanvasMusicIpc } from "./courseware-canvas-music-ipc";
import { CoursewareOnlinePreparation } from "../courseware-online-prepare";
import { registerCoursewareOnlinePreparationIpc } from "./courseware-online-prepare-ipc";
import { coursewareOnlineDeployment } from "../courseware-online-deployment";
import { CoursewareClassroomCoordinator } from "../courseware-classroom";
import { refreshNativeMaicClassroom } from "../courseware-classroom-native";
import { createClassroomNativeWriter } from "../courseware-classroom-save";
import { CoursewareAssessmentMedia } from "../courseware-assessment-media";
import { executeSavedAssessmentMedia } from "../courseware-assessment-saved";
import { assessmentPageIds } from "../courseware-scene-object-view";

export function registerPptEditorIpc(input: {
  registrar: IpcRegistrar;
  savedNarration?: import("../courseware-saved-narration").CoursewareSavedNarration;
  completeNarration: import("../courseware-candidates").NarrationComplete;
  completeScene: import("../courseware-candidates").SceneComplete;
  resolveModel?: import("../courseware-candidates").CandidateModelResolver;
  authSession: DesktopAuthSession;
  activeTurns: ReadonlyMap<string, string>;
  getMainWindow: () => BrowserWindow | null;
  getHost: () => HostProcess | null;
  getViewingSessionId: () => string | null;
  onChatBridgeReady: (bridge: PptEditorChatBridge) => void;
  onOnlinePreparationReady?: (preparation: CoursewareOnlinePreparation) => void;
  onClassroomReady?: (classroom: CoursewareClassroomCoordinator) => void;
  onNativeTeachingReady?: (tools: Pick<CoursewareNativeTools, "execute">) => void;
  onAssessmentMediaReady?: (media: Pick<CoursewareAssessmentMedia, "execute">) => void;
  onDeactivate?: () => void;
  getWorkspaceRoot: () => Promise<string | null>;
  getExtraRoots: (workspaceRoot: string | null) => Promise<string[]>;
  sendToRenderer: (channel: string, payload: unknown) => void;
}): void {
  const { registrar, getMainWindow, getHost, getWorkspaceRoot, getExtraRoots, sendToRenderer } = input;
  const editor = new PptEditorController(registrar.ipcMain, (state: PptEditorState) => {
    sendToRenderer(IPC.event.pptEditorState, state);
  });
  const chat = new PptEditorChatBridge(editor, getHost, getWorkspaceRoot, input.getViewingSessionId);
  input.onChatBridgeReady(chat);
  let documentOwner: { sessionId: string; workspace: string; path: string } | undefined;
  const setDocumentOwner = (sessionId: string) => {
    const target = editor.documentTarget();
    documentOwner = target ? { sessionId, workspace: target.workspaceRoot, path: target.sourcePath } : undefined;
    chat.setOwner(sessionId);
  };
  const onlinePreparation = new CoursewareOnlinePreparation({ editor, auth: input.authSession, getHost, getWorkspace: getWorkspaceRoot,
    getSessionId: input.getViewingSessionId, assertOwned: sessionId => chat.assertOwned(sessionId) });
  input.onOnlinePreparationReady?.(onlinePreparation);
  registerCoursewareOnlinePreparationIpc(registrar, onlinePreparation, () => {
    try { return coursewareOnlineDeployment() !== null; } catch { return false; }
  });
  const teaching = new CoursewareTeachingCoordinator(editor, getHost, getWorkspaceRoot, input.getViewingSessionId,
    sessionId => chat.assertActive(sessionId), sessionId => chat.assertOwned(sessionId));
  const images = new CoursewareImageReview(editor, input.authSession, getWorkspaceRoot, sessionId => chat.assertActive(sessionId), getHost,
    async sessionId => (await teaching.native("open"))?.value as import("@pi-desktop/shared").CoursewareTeachingView | undefined);
  editor.imageAssets = images;
  for (const [channel, method] of [[IPC.invoke.pptEditorImagePrepare, "prepare"], [IPC.invoke.pptEditorImageApprove, "approve"], [IPC.invoke.pptEditorImageClear, "clear"]] as const) {
    registrar.handleWithEvent(channel, async (event, payload: unknown, ...extra: unknown[]) => {
      registrar.assertMainWindowSender(event);
      if (extra.length) throw new Error("Unexpected image review parameters");
      if (method === "clear") { images.clear(); return { ok: true }; }
      if (method === "approve") {
        if (!payload || typeof payload !== "object" || Array.isArray(payload) || Object.keys(payload).length !== 1) throw new Error("Invalid image approval request");
        return images.approve(Reflect.get(payload, "reviewId"));
      }
      return images.prepare(payload);
    });
  }
  const assertSender = (event: Electron.IpcMainInvokeEvent) => {
    registrar.assertMainWindowSender(event);
  };
  const assertClassroomOwner = (sessionId: string) => {
    if (!getHost() || input.getViewingSessionId() !== sessionId) throw new Error("Classroom is no longer active in this Chat");
  };
  const classroom = new CoursewareClassroomCoordinator({ native: (operation, args) => teaching.native(operation, args, typeof args.pageNumber === "number" ? args.pageNumber : undefined), getHost, getWorkspace: getWorkspaceRoot,
    getSessionId: input.getViewingSessionId, assertOwned: assertClassroomOwner,
    openProject: async sessionId => { await editor.ensureSaved(await getWorkspaceRoot()); return teaching.open(sessionId); },
    writeNative: createClassroomNativeWriter({ teaching, editor, getWorkspace: getWorkspaceRoot, assertOwned: assertClassroomOwner,
      reopen: async (path, sessionId) => {
        const window = getMainWindow(), workspace = await getWorkspaceRoot();
        assertClassroomOwner(sessionId);
        if (!window || !workspace) throw new Error("Classroom window is unavailable");
        await editor.open(window, workspace, path);
        assertClassroomOwner(sessionId); setDocumentOwner(sessionId);
      } }),
    refreshNative: (sessionId, projectId) => teaching.withSaved(sessionId, async (host, jobId, snapshot, context) => {
      const workspace = await getWorkspaceRoot();
      if (!workspace) throw new Error("Classroom workspace is unavailable");
      return refreshNativeMaicClassroom({ host, sessionId, projectId, jobId, workspace,
        assertCurrent: () => teaching.assertCurrent(snapshot, context, sessionId, host) });
    }),
    completeReference: async (sessionId, data, signal) => {
      if (!input.resolveModel) throw new Error("Select a model before generating a reference");
      const model = await input.resolveModel(sessionId);
      assertClassroomOwner(sessionId);
      const result = await input.completeNarration({ sessionId, ...model, signal, maxOutputTokens: 2048, includeSessionContext: false,
        system: "为课堂互动问题生成参考答案与评价提示。仅输出 JSON 对象，字段 summary（字符串）、keyPoints（字符串数组）、constraintPrompt（可选字符串）。保留题意，答案根据给定上下文，不要编造背景事实。", messages: [{ role: "user", content: data }] });
      assertClassroomOwner(sessionId);
      if (JSON.stringify(await input.resolveModel(sessionId)) !== JSON.stringify(model)) throw new Error("Reference model changed");
      return result.text;
    } });
  input.onClassroomReady?.(classroom);
  const deliveryCurrent = async (sessionId: string) => {
    assertClassroomOwner(sessionId);
    const workspace = await getWorkspaceRoot(), host = getHost();
    if (!workspace || !host) throw new Error("Courseware workspace is unavailable");
    const { task } = await host.call<{ task?: { canonicalProjectId?: string } }>("courseware.task.get", { sessionId });
    assertClassroomOwner(sessionId);
    if (task?.canonicalProjectId) {
      const view = await classroom.open({ sessionId });
      if (!view.classroom || !view.revision) throw new Error("Complete the classroom before synchronizing");
      return { documentId: view.projectId, fingerprint: createHash("sha256").update(JSON.stringify([view.revision, view.sourceRevision])).digest("hex") };
    }
    await editor.ensureSaved(workspace); assertClassroomOwner(sessionId);
    const source = editor.teachingSnapshot(workspace), bytes = await readFile(source.path);
    const carrier = await readNativeTeachingPackage(bytes); assertClassroomOwner(sessionId);
    if (!carrier || createHash("sha256").update(bytes).digest("hex") !== source.sha256) throw new Error("Saved native courseware is unavailable");
    const worker = coursewareWorkerPath();
    const converterHash = createHash("sha256").update(await readFile(join(dirname(worker), "manifest.json"))).digest("hex");
    return { documentId: carrier.documentId, fingerprint: coursewareDeliveryFingerprint(source.sha256, converterHash) };
  };
  const delivery = new CoursewareDelivery({ assertOwned: assertClassroomOwner, principal: () => input.authSession.getCoursewarePrincipal(),
    host: () => { const host = getHost(); if (!host) throw new Error("Courseware Host is unavailable"); return host; }, current: deliveryCurrent,
    archive: async (sessionId, reviewedWarningCodes) => {
      const current = await deliveryCurrent(sessionId), host = getHost(), workspace = await getWorkspaceRoot();
      if (!host || !workspace) throw new Error("Courseware Host is unavailable");
      const { task } = await host.call<{ task?: { canonicalProjectId?: string } }>("courseware.task.get", { sessionId });
      if (task?.canonicalProjectId) {
        const view = await classroom.open({ sessionId });
        if (!view.classroom || !view.revision) throw new Error("Complete the classroom before synchronizing");
        if (view.classroom.scenes.some(scene => scene.actions?.some(action => action.type === "speech" && action.text.trim() && !action.audioUrl))) throw new Error("Complete narration audio before synchronizing");
        const result = await classroom.export({ sessionId, projectId: view.projectId, expectedRevision: view.revision, expectedSourceRevision: view.sourceRevision });
        return { bytes: Buffer.from(result.bytes), source: current };
      }
      const result = await exportNativeDelivery({ sessionId, workspace, host, editor, teaching,
        reviewedWarningCodes, outputDirectory: join(app.getPath("userData"), "courseware-builds"), assertOwner: () => assertClassroomOwner(sessionId) });
      return { bytes: result.bytes, source: { documentId: result.documentId, fingerprint: result.fingerprint } };
    },
    upload: bytes => input.authSession.uploadCoursewareDelivery(bytes),
    request: (action, payload) => input.authSession.coursewareDeliveryRequest(action, payload),
  });
  registrar.handleWithEvent(IPC.invoke.coursewareDelivery, async (event, payload: unknown, ...extra: unknown[]) => {
    registrar.assertMainWindowSender(event);
    if (extra.length) throw new Error("Unexpected delivery parameters");
    return delivery.execute(payload);
  });

  const reviewQuizImage = createQuizImageReview(input.completeScene, input.resolveModel);
  const { tts: classroomTts, images: classroomImages, assessments: assessmentMedia } = createNativeAssessmentMedia({
    teaching, classroom, auth: input.authSession, getHost, getWorkspace: getWorkspaceRoot, assertOwned: assertClassroomOwner, review: reviewQuizImage });
  input.onAssessmentMediaReady?.({ execute: async (sessionId, args, canDispatch) => {
    const native = await documentTools.execute(sessionId, "courseware_media_assessments", args, canDispatch);
    if (native) return native.value as Awaited<ReturnType<CoursewareAssessmentMedia["execute"]>>;
    let live = false;
    if (input.getViewingSessionId() === sessionId) {
      try {
        const workspace = await getWorkspaceRoot();
        const snapshot = editor.teachingSnapshot(workspace);
        const { task } = await getHost()!.call<{ task?: { importPath?: string; generatedPath?: string } }>("courseware.task.get", { sessionId });
        live = snapshot.sourcePath === (task?.importPath ?? task?.generatedPath);
      } catch { /* A saved course does not require an open native editor. */ }
    }
    if ((live && (!args || typeof args !== "object" || Reflect.get(args, "mode") !== "context")) || !input.savedNarration)
      return assessmentMedia.execute(sessionId, args, canDispatch);
    return executeSavedAssessmentMedia({ sessionId, args, canDispatch, getHost, saved: input.savedNarration,
      auth: input.authSession, decodeAudio: decodeCoursewareAudio, review: reviewQuizImage });
  } });
  for (const [channel, method] of [[IPC.invoke.coursewareClassroomImageModels, "models"], [IPC.invoke.coursewareClassroomImageQuote, "quote"],
    [IPC.invoke.coursewareClassroomImageSubmit, "submit"], [IPC.invoke.coursewareClassroomImageRefresh, "refresh"]] as const) {
    registrar.handleWithEvent(channel, async (event, payload: unknown, ...extra: unknown[]) => {
      registrar.assertMainWindowSender(event);
      if (extra.length) throw new Error("Unexpected classroom image parameters");
      return classroomImages[method](payload);
    });
  }
  for (const [channel, method] of [[IPC.invoke.coursewareClassroomTtsModels, "models"], [IPC.invoke.coursewareClassroomTtsQuote, "quote"],
    [IPC.invoke.coursewareClassroomTtsSubmit, "submit"], [IPC.invoke.coursewareClassroomTtsRefresh, "refresh"]] as const) {
    registrar.handleWithEvent(channel, async (event, payload: unknown, ...extra: unknown[]) => {
      registrar.assertMainWindowSender(event);
      if (extra.length) throw new Error("Unexpected classroom TTS parameters");
      return classroomTts[method](payload);
    });
  }
  for (const [channel, method] of [[IPC.invoke.coursewareClassroomOpen, "open"], [IPC.invoke.coursewareClassroomCreate, "create"], [IPC.invoke.coursewareClassroomWrite, "write"],
    [IPC.invoke.coursewareClassroomImage, "image"], [IPC.invoke.coursewareClassroomExport, "export"], [IPC.invoke.coursewareClassroomReference, "reference"]] as const) {
    registrar.handleWithEvent(channel, async (event, payload: unknown, ...extra: unknown[]) => {
      registrar.assertMainWindowSender(event);
      if (extra.length) throw new Error("Unexpected classroom parameters");
      return classroom[method](payload);
    });
  }
  const nativeSave = new CoursewareNativeSave(getHost, input.getViewingSessionId, getWorkspaceRoot,
    sessionId => chat.assertOwned(sessionId), operation => teaching.duringNativeSave(operation));
  const documentSave = new CoursewareNativeSave(getHost, () => documentOwner?.sessionId ?? null,
    async () => documentOwner?.workspace ?? null, sessionId => {
      const target = editor.documentTarget();
      if (documentOwner?.sessionId !== sessionId || target?.sourcePath !== documentOwner.path || target.workspaceRoot !== documentOwner.workspace)
        throw new Error("PPT save document owner changed");
    }, operation => teaching.duringNativeSave(operation));
  editor.nativeSave = value => documentOwner ? documentSave.prepare(value) : Promise.resolve(undefined);
  registrar.handleWithEvent(IPC.invoke.pptEditorProjectCopy, async (event, payload: unknown, ...extra: unknown[]) => {
    assertSender(event);
    if (extra.length || !payload || typeof payload !== "object" || Array.isArray(payload) ||
        Object.keys(payload).length !== 1 || !("sessionId" in payload)) throw new Error("Invalid project copy request");
    if (payload.sessionId !== input.getViewingSessionId() || typeof payload.sessionId !== "string") throw new Error("Teaching session changed");
    const workspace = await getWorkspaceRoot();
    if (workspace) {
      const copied = await copyNativeTeaching({ editor, teaching, workspace, sessionId: payload.sessionId,
        assertOwner: () => chat.assertActive(payload.sessionId as string) });
      if (copied) return copied;
    }
    return teaching.copyProject(payload.sessionId);
  });
  const music = registerCoursewareCanvasMusicIpc({ registrar, getHost, getViewingSessionId: input.getViewingSessionId,
    activeTurns: input.activeTurns, authSession: input.authSession, teaching });
  const assetLocks = new CoursewareAssetLockCoordinator(teaching);
  for (const [channel, method] of [[IPC.invoke.pptEditorAssetLocksRead, "read"], [IPC.invoke.pptEditorAssetLockSet, "set"]] as const) {
    registrar.handleWithEvent(channel, async (event, payload: unknown, ...extra: unknown[]) => {
      assertSender(event);
      if (extra.length) throw new Error("Unexpected asset lock parameters");
      return assetLocks[method](payload);
    });
  }
  const visuals = new CoursewareVisualReview(teaching, editor, getWorkspaceRoot, sessionId => chat.assertActive(sessionId),
    request => renderCoursewareSourceVisuals({ ...request, ipcMain: registrar.ipcMain }));
  for (const [channel, method] of [[IPC.invoke.pptEditorVisualPrepare, "prepare"], [IPC.invoke.pptEditorVisualApprove, "approve"], [IPC.invoke.pptEditorVisualClear, "clear"]] as const) {
    registrar.handleWithEvent(channel, async (event, payload: unknown, ...extra: unknown[]) => {
      assertSender(event);
      if (extra.length) throw new Error("Unexpected source visual review parameters");
      if (method === "clear") { if (payload !== undefined) throw new Error("Visual clear does not accept parameters"); visuals.clear(); return { ok: true }; }
      return visuals[method](payload);
    });
  }
  const style = new CoursewareStyleReviewCoordinator(teaching, getWorkspaceRoot, sessionId => chat.assertActive(sessionId),
    request => renderCoursewareSourceVisuals({ ...request, ipcMain: registrar.ipcMain }));
  for (const [channel, method] of [[IPC.invoke.pptEditorStylePrepare, "prepare"], [IPC.invoke.pptEditorStyleApprove, "approve"], [IPC.invoke.pptEditorStyleClear, "clearReview"]] as const) {
    registrar.handleWithEvent(channel, async (event, payload: unknown, ...extra: unknown[]) => {
      assertSender(event);
      if (extra.length) throw new Error("Unexpected style review parameters");
      if (method === "clearReview") { if (payload !== undefined) throw new Error("Style clear does not accept parameters"); style.clearReview(); return { ok: true }; }
      return style[method](payload);
    });
  }
  const candidates = new CoursewareCandidateCoordinator(teaching, input.completeNarration, { visuals, style, completeScene: input.completeScene,
    render: request => renderCoursewareSourceVisuals({ ...request, ipcMain: registrar.ipcMain }) }, input.resolveModel, sessionId => input.activeTurns.get(sessionId));
  const localMedia = new CoursewarePortableMedia(teaching, decodeCoursewarePortableMedia);
  const tts = new CoursewareTtsCoordinator(teaching, input.authSession, decodeCoursewareAudio, localMedia);
  const nativeAudio = new CoursewareNativeAudio(input.authSession, getHost, input.getViewingSessionId,
    async (operation, args, page) => editor.routeNativeTeaching(await getWorkspaceRoot(), operation, args, page), decodeCoursewareAudio);
  const routeNative = async (operation: string, args: Record<string, unknown>, page: number) => {
    const result = await editor.routeNativeTeaching(await getWorkspaceRoot(), operation, args, page);
    const library = await routeNativeMediaLibrary({ operation, args, page, result, music: nativeMusic, video: nativeVideo,
      open: async () => editor.routeNativeTeaching(await getWorkspaceRoot(), "open", {}, page) });
    if (library) return library;
    if (result && result.value && typeof result.value === "object" && Reflect.get(result.value, "nativeService") === true) {
      if (operation.startsWith("classroom:")) return undefined;
      const current = await editor.routeNativeTeaching(await getWorkspaceRoot(), "open", {}, page);
      return { value: await nativeAudio.execute(operation, args, page, current!.value as import("@pi-desktop/shared").CoursewareTeachingView) };
    }
    return result;
  };
  const nativeMusic = new CoursewareNativeMusic(input.authSession, getHost, input.getViewingSessionId,
    async (operation, args, page) => editor.routeNativeTeaching(await getWorkspaceRoot(), operation, args, page), decodeCoursewareAudio);
  const nativeVideo = new CoursewareNativeVideo(input.authSession, getHost, input.getViewingSessionId,
    async (operation, args, page) => editor.routeNativeTeaching(await getWorkspaceRoot(), operation, args, page), decodeCoursewareVideo);
  const reviewTurns = new ContentReviewTurns(id => input.activeTurns.get(id));
  const documentTools = new CoursewareDocumentTools({ getHost, editor,
    createBackground: () => createBackgroundCoursewareEditor(registrar.ipcMain),
    createTools: (targetEditor, scope) => createCoursewareDocumentRuntime({ editor: targetEditor, scope,
      background: targetEditor !== editor, review: reviewQuizImage, auth: input.authSession, complete: input.completeNarration, completeVision: input.completeScene,
      resolveModel: input.resolveModel, activeTurns: input.activeTurns, reviewTurns, getHost }) });
  input.onNativeTeachingReady?.(documentTools);
  editor.nativeTeaching = createNativeTeachingHandler({ teaching, tts, classroom, classroomTts, classroomImages,
    nativeRoute: routeNative,
    assessmentContext: async view => {
      const host = getHost(), sessionId = input.getViewingSessionId();
      if (!host || !sessionId) throw new Error("Teaching owner changed");
      const context = await host.call("courseware.project.context", { sessionId, projectId: view.project.projectId });
      assertClassroomOwner(sessionId);
      const ids = assessmentPageIds(context, view.project);
      return { current: ids.has(view.pageId), embedded: !ids.has(view.pageId) && view.project.pages
        .find(page => page.pageId === view.pageId)?.actions.some(action => action.type === "interaction_checkpoint" && action.checkpointKind === "chapter_summary") };
    },
    media: new CoursewareNativeMedia(teaching, input.authSession, music, localMedia), sessionId: input.getViewingSessionId,
    context: async () => editor.getContext(await getWorkspaceRoot()),
    ensureSaved: async () => editor.ensureSaved(await getWorkspaceRoot()) });
  for (const [channel, method] of [[IPC.invoke.pptEditorTtsModels, "models"], [IPC.invoke.pptEditorTtsQuote, "quote"],
    [IPC.invoke.pptEditorTtsSubmitConfirmed, "submitConfirmed"], [IPC.invoke.pptEditorTtsPrepare, "prepare"], [IPC.invoke.pptEditorTtsSubmit, "submit"],
    [IPC.invoke.pptEditorTtsStatus, "status"], [IPC.invoke.pptEditorTtsList, "list"], [IPC.invoke.pptEditorTtsArchive, "archive"],
    [IPC.invoke.pptEditorTtsAdopt, "adopt"]] as const) {
    registrar.handleWithEvent(channel, async (event, payload: unknown, ...extra: unknown[]) => {
      assertSender(event);
      if (extra.length) throw new Error("Unexpected TTS parameters");
      const context = await editor.getContext(await getWorkspaceRoot());
      const native = await routeNative("tts:" + (method === "submitConfirmed" ? "submit" : method), payload as Record<string, unknown>, context.page ?? 1);
      if (native) return native.value;
      return tts[method](payload);
    });
  }
  const candidatePreview = new PptxCandidatePreview(registrar.ipcMain, getMainWindow);
  const adoption = new CoursewareSourceAdoption(editor, teaching, getHost, getWorkspaceRoot, input.getViewingSessionId, () => chat.clear());
  registrar.handleWithEvent(IPC.invoke.pptEditorSnapshotCapture, async (event, payload: unknown, ...extra: unknown[]) => {
    assertSender(event);
    if (extra.length) throw new Error("Unexpected snapshot parameters");
    const workspace = await getWorkspaceRoot(), sessionId = input.getViewingSessionId();
    if (workspace && sessionId) {
      const native = await captureNativeTeachingSnapshot({ editor, teaching, workspace, sessionId, payload, assertOwner: () => chat.assertActive(sessionId) });
      if (native) return native.value;
    }
    return tts.captureSnapshot(payload);
  });
  chat.nativeFade = new CoursewareNativeFadeCoordinator(teaching, editor, getWorkspaceRoot);
  chat.candidates = (sessionId, toolName, args, canDispatch) => candidates.execute(sessionId, toolName, args, canDispatch);
  for (const [channel, review] of [[IPC.invoke.pptEditorTeachingOpen, false], [IPC.invoke.pptEditorTeachingReview, true]] as const) registrar.handleWithEvent(channel, async (event, payload: unknown, ...extra: unknown[]) => {
    assertSender(event);
    if (extra.length || !payload || typeof payload !== "object" || Array.isArray(payload) ||
        Object.keys(payload).length !== 1 || !("sessionId" in payload)) throw new Error("Invalid teaching request");
    if (payload.sessionId !== input.getViewingSessionId()) throw new Error("Teaching session changed");
    const workspace = await getWorkspaceRoot();
    const context = await editor.getContext(workspace);
    const native = await editor.routeNativeTeaching(workspace, "open", {}, context.page ?? 1);
    if (native) {
      if (review) throw new Error("Native teaching review uses the live document");
      return native.value;
    }
    return review ? teaching.prepareReview(payload.sessionId) : teaching.open(payload.sessionId);
  });
  registrar.handleWithEvent(IPC.invoke.pptEditorImportNotesPreview, async (event, payload: unknown, ...extra: unknown[]) => {
    assertSender(event);
    if (extra.length || !payload || typeof payload !== "object" || Array.isArray(payload) ||
        Object.keys(payload).length !== 1 || !("sessionId" in payload)) throw new Error("Invalid import notes request");
    return teaching.importCurrentPageNotes(payload.sessionId);
  });
  registrar.handleWithEvent(IPC.invoke.pptEditorTeachingHistory, async (event, payload: unknown, ...extra: unknown[]) => {
    assertSender(event);
    if (extra.length) throw new Error("Unexpected teaching history parameters");
    return teaching.history(payload);
  });
  for (const [channel, changing] of [[IPC.invoke.pptEditorTeachingDraftGet, false], [IPC.invoke.pptEditorTeachingDraftSet, true]] as const) {
    registrar.handleWithEvent(channel, async (event, payload: unknown, ...extra: unknown[]) => {
      assertSender(event);
      if (extra.length) throw new Error("Unexpected teaching draft parameters");
      if (!changing && input.savedNarration?.ownsView(payload)) return input.savedNarration.draft(payload);
      return teaching.draft(payload, changing);
    });
  }
  registrar.handleWithEvent(IPC.invoke.pptEditorTeachingAdopt, async (event, payload: unknown, ...extra: unknown[]) => {
    assertSender(event);
    if (extra.length) throw new Error("Unexpected review parameters");
    return teaching.adoptReview(payload);
  });
  for (const [channel, lock] of [[IPC.invoke.pptEditorTeachingWrite, false], [IPC.invoke.pptEditorTeachingLock, true], [IPC.invoke.pptEditorTeachingConfirm, "confirm"]] as const) {
    registrar.handleWithEvent(channel, async (event, payload: unknown, ...extra: unknown[]) => {
      assertSender(event);
      if (extra.length) throw new Error("Unexpected teaching parameters");
      const workspace = await getWorkspaceRoot();
      const context = await editor.getContext(workspace);
      const native = await editor.routeNativeTeaching(workspace, lock === false ? "write" : lock === true ? "lock" : "confirm", payload as Record<string, unknown>, context.page ?? 1);
      if (native) return native.value;
      return teaching.update(payload, lock);
    });
  }

  for (const [channel, decide] of [[IPC.invoke.pptEditorNarrationReview, false], [IPC.invoke.pptEditorNarrationDecide, true]] as const) registrar.handleWithEvent(channel, async (event, payload: unknown, ...extra: unknown[]) => {
    assertSender(event);
    if (extra.length) throw new Error("Unexpected narration parameters");
    if (input.savedNarration?.ownsReview(payload, decide))
      return decide ? input.savedNarration.decide(payload) : input.savedNarration.review(payload);
    return decide ? teaching.decideNarration(payload) : teaching.reviewNarration(payload);
  });

  registrar.handleWithEvent(IPC.invoke.pptEditorPptxCandidateReview, async (event, payload: unknown, ...extra: unknown[]) => {
    assertSender(event);
    if (extra.length) throw new Error("Unexpected PPTX candidate parameters");
    return teaching.reviewPptxCandidate(payload);
  });
  registrar.handleWithEvent(IPC.invoke.pptEditorPptxCandidatePreview, async (event, payload: unknown, ...extra: unknown[]) => {
    assertSender(event);
    if (extra.length || !payload || typeof payload !== "object" || Array.isArray(payload) || Object.keys(payload).length !== 1 || typeof Reflect.get(payload, "reviewId") !== "string") throw new Error("Invalid PPTX candidate preview request");
    const preview = await teaching.previewPptxCandidate(Reflect.get(payload, "reviewId"));
    const workspaceRoot = await getWorkspaceRoot();
    if (!workspaceRoot) throw new Error("Workspace is unavailable");
    await candidatePreview.open(workspaceRoot, preview.path, preview.candidateId, preview.sha256);
    return { ok: true };
  });
  registrar.handleWithEvent(IPC.invoke.pptEditorPptxCandidateReject, async (event, payload: unknown, ...extra: unknown[]) => {
    assertSender(event);
    if (extra.length || !payload || typeof payload !== "object" || Array.isArray(payload) || Object.keys(payload).length !== 1 || typeof Reflect.get(payload, "reviewId") !== "string") throw new Error("Invalid PPTX candidate reject request");
    await teaching.rejectPptxCandidate(Reflect.get(payload, "reviewId"));
    candidatePreview.close();
    return { ok: true };
  });

  registrar.handleWithEvent(IPC.invoke.pptEditorPptxCandidateAdopt, async (event, payload: unknown, ...extra: unknown[]) => {
    assertSender(event);
    if (extra.length || !payload || typeof payload !== "object" || Array.isArray(payload) ||
        Object.keys(payload).some(key => !["reviewId", "effectBindings"].includes(key)) || typeof Reflect.get(payload, "reviewId") !== "string" ||
        (Reflect.get(payload, "effectBindings") !== undefined && (!Array.isArray(Reflect.get(payload, "effectBindings")) || Reflect.get(payload, "effectBindings").length > 20000))) throw new Error("Invalid PPTX candidate adoption request");
    const owner = input.getViewingSessionId();
    return documentTools.transition(async () => {
      if (input.getViewingSessionId() !== owner) throw new Error("Source adoption owner changed while waiting");
      candidatePreview.close();
      await adoption.adopt(Reflect.get(payload, "reviewId"), async (path) => {
        const window = getMainWindow(); const workspace = await getWorkspaceRoot();
        if (!window || !workspace || input.getViewingSessionId() !== owner) throw new Error("Source adoption owner changed before reopen");
        await editor.open(window, workspace, path);
        if (owner && input.getViewingSessionId() === owner) setDocumentOwner(owner);
        else documentOwner = undefined;
      }, Reflect.get(payload, "effectBindings"));
      return { ok: true };
    });
  });

  registrar.handleWithEvent(IPC.invoke.pptEditorGetContext, async (event) => {
    assertSender(event);
    return editor.getContext(await getWorkspaceRoot());
  });
  registrar.handleWithEvent(IPC.invoke.pptEditorExecute, async (event, command: unknown) => {
    assertSender(event);
    return editor.execute(command, await getWorkspaceRoot());
  });

  registrar.handleWithEvent(
    IPC.invoke.pptEditorOpen,
    async (event, payload: { path?: string; mimeType?: string } = {}) => {
      assertSender(event);
      const owner = input.getViewingSessionId();
      const requestedWorkspace = getWorkspaceRoot();
      return documentTools.transition(async () => {
        const window = getMainWindow();
        const workspaceRoot = await requestedWorkspace;
        const path = String(payload.path ?? "").trim();
        if (!window || !workspaceRoot || !path) throw new Error("No document is available in the current workspace");
        if (input.getViewingSessionId() !== owner || await getWorkspaceRoot() !== workspaceRoot) throw new Error("Document open owner changed while waiting");
        adoption.assertIdle();
        const previous = editor.documentTarget();
        if (previous && !previous.readOnly) await editor.ensureSaved(previous.workspaceRoot);
        input.onDeactivate?.();
        chat.clear();
        images.clear();
        visuals.clear();
        style.clear();
        candidatePreview.close();
        await nativeSave.recover(workspaceRoot, path, owner);
        await adoption.beforeOpen(workspaceRoot, path, owner, payload.mimeType);
        if (await getWorkspaceRoot() !== workspaceRoot || input.getViewingSessionId() !== owner) throw new Error("Source adoption owner changed before opening");
        const state = await editor.open(window, workspaceRoot, path, payload.mimeType, await getExtraRoots(workspaceRoot));
        if (owner && input.getViewingSessionId() === owner) setDocumentOwner(owner);
        else documentOwner = undefined;
        return state;
      });
    },
  );
  registrar.handleWithEvent(IPC.invoke.pptEditorSave, async (event) => {
    assertSender(event);
    adoption.assertIdle();
    editor.save();
    return { ok: true };
  });
  registrar.handleWithEvent(IPC.invoke.pptEditorInspectStart, async (event, ...args: unknown[]) => {
    assertSender(event);
    if (args.length) throw new Error("Inspection start does not accept parameters");
    const host = getHost();
    if (!host) throw new Error("Host is unavailable");
    return editor.inspector.start(host, editor.savedPptxSnapshot());
  });
  registrar.handleWithEvent(IPC.invoke.pptEditorInspectStatus, async (event, payload: unknown, ...extra: unknown[]) => {
    assertSender(event);
    if (extra.length) throw new Error("Unexpected inspection parameters");
    return editor.inspector.status(payload);
  });
  registrar.handleWithEvent(IPC.invoke.pptEditorInspectCancel, async (event, payload: unknown, ...extra: unknown[]) => {
    assertSender(event);
    if (extra.length) throw new Error("Unexpected inspection parameters");
    return editor.inspector.cancel(payload);
  });
  registrar.handleWithEvent(IPC.invoke.pptEditorClose, async (event) => {
    assertSender(event);
    return documentTools.transition(async () => {
      adoption.assertIdle();
      const target = editor.documentTarget();
      if (target && !target.readOnly) await editor.ensureSaved(target.workspaceRoot);
      editor.close();
      documentOwner = undefined;
      input.onDeactivate?.();
      chat.clear();
      images.clear();
      visuals.clear();
      style.clear();
      candidatePreview.close();
      return { ok: true };
    });
  });
  registrar.handleWithEvent(
    IPC.invoke.pptEditorSetBounds,
    async (event, bounds: { x: number; y: number; width: number; height: number }) => {
      assertSender(event);
      editor.setBounds(bounds);
      return { ok: true };
    },
  );
  registrar.handleWithEvent(IPC.invoke.pptEditorConfigureUi, async (event, payload: unknown) => {
    assertSender(event);
    editor.configureUi(payload);
    return { ok: true };
  });
  registrar.handleWithEvent(
    IPC.invoke.pptEditorSetVisible,
    async (event, payload: { visible?: boolean } = {}) => {
      assertSender(event);
      if (payload.visible !== true) input.onDeactivate?.();
      chat.setVisible(payload.visible === true);
      if (payload.visible !== true) visuals.clear();
      if (payload.visible !== true) style.clearReview();
      editor.setVisible(payload.visible === true);
      return { ok: true };
    },
  );
}
