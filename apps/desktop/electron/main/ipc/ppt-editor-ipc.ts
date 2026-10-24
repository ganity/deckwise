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
import { decodeCoursewareAudio } from "../courseware-audio-decode";
import type { DesktopAuthSession } from "../auth-session";
import { CoursewareImageReview } from "../courseware-image-review";
import { CoursewareVisualReview } from "../courseware-visual-review";
import { renderCoursewareSourceVisuals } from "../courseware-source-visuals";
import { CoursewareStyleReviewCoordinator } from "../courseware-style-review";
import { registerCoursewareCanvasMusicIpc } from "./courseware-canvas-music-ipc";
import { CoursewareOnlinePreparation } from "../courseware-online-prepare";
import { registerCoursewareOnlinePreparationIpc } from "./courseware-online-prepare-ipc";
import { coursewareOnlineDeployment } from "../courseware-online-deployment";

export function registerPptEditorIpc(input: {
  registrar: IpcRegistrar;
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
  const onlinePreparation = new CoursewareOnlinePreparation({ editor, auth: input.authSession, getHost, getWorkspace: getWorkspaceRoot,
    getSessionId: input.getViewingSessionId, assertOwned: sessionId => chat.assertOwned(sessionId) });
  input.onOnlinePreparationReady?.(onlinePreparation);
  registerCoursewareOnlinePreparationIpc(registrar, onlinePreparation, () => {
    try { return coursewareOnlineDeployment() !== null; } catch { return false; }
  });
  const images = new CoursewareImageReview(editor, input.authSession, getWorkspaceRoot, sessionId => chat.assertActive(sessionId), getHost);
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
  const teaching = new CoursewareTeachingCoordinator(editor, getHost, getWorkspaceRoot, input.getViewingSessionId,
    sessionId => chat.assertActive(sessionId), sessionId => chat.assertOwned(sessionId));
  registerCoursewareCanvasMusicIpc({ registrar, getHost, getViewingSessionId: input.getViewingSessionId,
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
    render: request => renderCoursewareSourceVisuals({ ...request, ipcMain: registrar.ipcMain }) }, input.resolveModel);
  const tts = new CoursewareTtsCoordinator(teaching, input.authSession, decodeCoursewareAudio);
  for (const [channel, method] of [[IPC.invoke.pptEditorTtsModels, "models"], [IPC.invoke.pptEditorTtsQuote, "quote"],
    [IPC.invoke.pptEditorTtsSubmitConfirmed, "submitConfirmed"], [IPC.invoke.pptEditorTtsPrepare, "prepare"], [IPC.invoke.pptEditorTtsSubmit, "submit"],
    [IPC.invoke.pptEditorTtsStatus, "status"], [IPC.invoke.pptEditorTtsList, "list"], [IPC.invoke.pptEditorTtsArchive, "archive"],
    [IPC.invoke.pptEditorTtsAdopt, "adopt"]] as const) {
    registrar.handleWithEvent(channel, async (event, payload: unknown, ...extra: unknown[]) => {
      assertSender(event);
      if (extra.length) throw new Error("Unexpected TTS parameters");
      return tts[method](payload);
    });
  }
  const candidatePreview = new PptxCandidatePreview(registrar.ipcMain, getMainWindow);
  const adoption = new CoursewareSourceAdoption(editor, teaching, getHost, getWorkspaceRoot, input.getViewingSessionId, () => chat.clear());
  registrar.handleWithEvent(IPC.invoke.pptEditorSnapshotCapture, async (event, payload: unknown, ...extra: unknown[]) => {
    assertSender(event);
    if (extra.length) throw new Error("Unexpected snapshot parameters");
    return tts.captureSnapshot(payload);
  });
  chat.nativeFade = new CoursewareNativeFadeCoordinator(teaching, editor, getWorkspaceRoot);
  chat.candidates = (sessionId, toolName, args, canDispatch) => candidates.execute(sessionId, toolName, args, canDispatch);
  for (const [channel, review] of [[IPC.invoke.pptEditorTeachingOpen, false], [IPC.invoke.pptEditorTeachingReview, true]] as const) registrar.handleWithEvent(channel, async (event, payload: unknown, ...extra: unknown[]) => {
    assertSender(event);
    if (extra.length || !payload || typeof payload !== "object" || Array.isArray(payload) ||
        Object.keys(payload).length !== 1 || !("sessionId" in payload)) throw new Error("Invalid teaching request");
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
      return teaching.update(payload, lock);
    });
  }

  for (const [channel, decide] of [[IPC.invoke.pptEditorNarrationReview, false], [IPC.invoke.pptEditorNarrationDecide, true]] as const) registrar.handleWithEvent(channel, async (event, payload: unknown, ...extra: unknown[]) => {
    assertSender(event);
    if (extra.length) throw new Error("Unexpected narration parameters");
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
    candidatePreview.close();
    const owner = input.getViewingSessionId();
    await adoption.adopt(Reflect.get(payload, "reviewId"), async (path) => {
      const window = getMainWindow(); const workspace = await getWorkspaceRoot();
      if (!window || !workspace || input.getViewingSessionId() !== owner) throw new Error("Source adoption owner changed before reopen");
      await editor.open(window, workspace, path);
      if (owner && input.getViewingSessionId() === owner) chat.setOwner(owner);
    }, Reflect.get(payload, "effectBindings"));
    return { ok: true };
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
      const window = getMainWindow();
      const workspaceRoot = await getWorkspaceRoot();
      const path = String(payload.path ?? "").trim();
      if (!window || !workspaceRoot || !path) throw new Error("No document is available in the current workspace");
      adoption.assertIdle();
      input.onDeactivate?.();
      chat.clear();
      images.clear();
      visuals.clear();
      style.clear();
      candidatePreview.close();
      const owner = input.getViewingSessionId();
      await adoption.beforeOpen(workspaceRoot, path, owner, payload.mimeType);
      if (await getWorkspaceRoot() !== workspaceRoot || input.getViewingSessionId() !== owner) throw new Error("Source adoption owner changed before opening");
      const state = await editor.open(window, workspaceRoot, path, payload.mimeType, await getExtraRoots(workspaceRoot));
      if (owner && input.getViewingSessionId() === owner) chat.setOwner(owner);
      return state;
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
    adoption.assertIdle();
    input.onDeactivate?.();
    chat.clear();
    images.clear();
    visuals.clear();
    style.clear();
    candidatePreview.close();
    editor.close();
    return { ok: true };
  });
  registrar.handleWithEvent(
    IPC.invoke.pptEditorSetBounds,
    async (event, bounds: { x: number; y: number; width: number; height: number }) => {
      assertSender(event);
      editor.setBounds(bounds);
      return { ok: true };
    },
  );
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
