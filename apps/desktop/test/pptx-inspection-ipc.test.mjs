import * as coursewareRuntime from "../electron/main/courseware-runtime.ts";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
import { PptxInspector } from "../electron/main/pptx-inspection.ts";

const source = await readFile(new URL("../electron/main/ipc/ppt-editor-ipc.ts", import.meta.url), "utf8");
const { outputText } = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } });
const IPC = { invoke: { pptEditorInspectStart: "start", pptEditorInspectStatus: "status", pptEditorInspectCancel: "cancel", pptEditorNarrationReview: "candidate-review", pptEditorNarrationDecide: "candidate-decide", pptEditorSnapshotCapture: "snapshot-capture", pptEditorTeachingOpen: "teaching-open", pptEditorTeachingWrite: "teaching-write", pptEditorTeachingLock: "teaching-lock", pptEditorTeachingConfirm: "teaching-confirm", pptEditorTeachingReview: "teaching-review", pptEditorTeachingAdopt: "teaching-adopt" }, event: {} };
Object.assign(IPC.invoke, { pptEditorTtsPrepare: "tts-prepare", pptEditorTtsSubmit: "tts-submit", pptEditorTtsStatus: "tts-status", pptEditorTtsList: "tts-list", pptEditorTtsArchive: "tts-archive", pptEditorTtsAdopt: "tts-adopt" });
Object.assign(IPC.invoke, { pptEditorImagePrepare: "image-prepare", pptEditorImageApprove: "image-approve", pptEditorImageClear: "image-clear" });
Object.assign(IPC.invoke, { pptEditorVisualPrepare: "visual-prepare", pptEditorVisualApprove: "visual-approve", pptEditorVisualClear: "visual-clear" });
Object.assign(IPC.invoke, { pptEditorStylePrepare: "style-prepare", pptEditorStyleApprove: "style-approve", pptEditorStyleClear: "style-clear" });
Object.assign(IPC.invoke, { pptEditorAssetLocksRead: "asset-locks-read", pptEditorAssetLockSet: "asset-lock-set" });
Object.assign(IPC.invoke, { pptEditorPptxCandidateAdopt: "pptx-adopt" });

test("inspection IPC authenticates sender and accepts only a host-selected saved revision", async () => {
  const handlers = new Map();
  const assetCalls = [];
  const adoptionCalls = [];
  let snapshotReads = 0;
  class Editor {
    inspector = new PptxInspector();
    savedPptxSnapshot() { snapshotReads++; return { path: "/workspace/saved.pptx", revision: 1, sha256: "a".repeat(64) }; }
  }
  const module = { exports: {} };
  new Function("require", "exports", "module", outputText)((id) => {
    if (id === "../courseware-runtime") return coursewareRuntime;
    if (id.startsWith("node:")) return require(id);
    if (id === "electron") return { app: { getPath: () => "/unused-inspection-profile" } };
    if (id === "../courseware-document-tools") return { CoursewareDocumentTools: class { transition(operation) { return operation(); } } };
    if (id === "../courseware-document-runtime") return { createCoursewareDocumentRuntime() { throw new Error("Inspection must not open a document"); }, createBackgroundCoursewareEditor() { throw new Error("Inspection must not open a window"); } };
    if (id === "../courseware-native-assessment-media") return { createNativeAssessmentMedia: () => ({ tts: {}, images: {}, assessments: {} }) };
    if (id === "../courseware-native-library") return { routeNativeMediaLibrary() {} };
    if (id === "../courseware-delivery") return { CoursewareDelivery: class {} };
    if (id === "../courseware-delivery-export") return { coursewareDeliveryFingerprint() {}, exportNativeDelivery() {} };
    if (id === "../courseware-native-package") return { readNativeTeachingPackage() {} };
    if (id === "../courseware-native-music") return { CoursewareNativeMusic: class {} };
    if (id === "../courseware-native-video") return { CoursewareNativeVideo: class {} };
    if (id === "../courseware-native-audio") return { CoursewareNativeAudio: class {} };
    if (id === "../courseware-native-save") return { CoursewareNativeSave: class {} };
    if (id === "../courseware-native-snapshot") return { captureNativeTeachingSnapshot() {}, copyNativeTeaching() {} };
    if (id === "../courseware-classroom") return { CoursewareClassroomCoordinator: class {} };
    if (id === "../courseware-classroom-native") return { refreshNativeMaicClassroom() {} };
    if (id === "../courseware-classroom-save") return { createClassroomNativeWriter() {} };
    if (id === "../courseware-assessment-media") return { CoursewareAssessmentMedia: class {} };
    if (id === "../courseware-assessment-saved") return { executeSavedAssessmentMedia() {} };
    if (id === "../courseware-scene-object-view") return { assessmentPageIds() {} };
    if (id === "../courseware-native-media") return { CoursewareNativeMedia: class {} };
    if (id === "../courseware-native-sidebar") return { createNativeTeachingHandler() {} };
    if (id === "@pi-desktop/shared") return { IPC };
    if (id === "../ppt-editor") return { PptEditorController: Editor };
    if (id === "../courseware-teaching") return { CoursewareTeachingCoordinator: class {} };
    if (id === "./courseware-canvas-music-ipc") return { registerCoursewareCanvasMusicIpc() {} };
    if (id === "../courseware-online-prepare") return { CoursewareOnlinePreparation: class {} };
    if (id === "./courseware-online-prepare-ipc") return { registerCoursewareOnlinePreparationIpc() {} };
    if (id === "../courseware-online-deployment") return { coursewareOnlineDeployment: () => null };
    if (id === "../courseware-native-fade") return { CoursewareNativeFadeCoordinator: class {} };
    if (id === "../courseware-asset-locks") return { CoursewareAssetLockCoordinator: class {
      read(payload) { assetCalls.push(["read", payload]); return { result: "read" }; }
      set(payload) { assetCalls.push(["set", payload]); return { result: "set" }; }
    } };
    if (id === "../ppt-editor-chat") return { PptEditorChatBridge: class {} };
    if (id === "../courseware-content-review") return { ContentReviewTurns: class {} };
    if (id === "../courseware-candidates") return { CoursewareCandidateCoordinator: class {} };
    if (id === "../pptx-candidate-preview") return { PptxCandidatePreview: class { close() {} } };
    if (id === "../courseware-source-adoption") return { CoursewareSourceAdoption: class { async adopt(reviewId, _reopen, bindings) { adoptionCalls.push([reviewId, bindings]); } } };
    if (id === "../courseware-audio-decode") return { decodeCoursewareAudio() {}, decodeCoursewarePortableMedia() {} };
    if (id === "../courseware-portable-media") return { CoursewarePortableMedia: class {} };
    if (id === "../courseware-tts") return { CoursewareTtsCoordinator: class {} };
    if (id === "../courseware-quiz-image-review") return { createQuizImageReview: () => async () => { throw new Error("Inspection must not call a model"); } };
    if (id === "../courseware-image-review") return { CoursewareImageReview: class { clear() {} } };
    if (id === "../courseware-visual-review") return { CoursewareVisualReview: class { clear() {} } };
    if (id === "../courseware-style-review") return { CoursewareStyleReviewCoordinator: class { clearReview() {} clear() {} } };
    if (id === "../courseware-source-visuals") return { renderCoursewareSourceVisuals() {} };
    throw new Error(id);
  }, module.exports, module);
  const calls = [];
  module.exports.registerPptEditorIpc({
    registrar: {
      ipcMain: {}, handleWithEvent: (channel, handler) => handlers.set(channel, handler),
      assertMainWindowSender(event) { if (event.sender.id !== 1) throw new Error("PERMISSION_DENIED"); },
    },
    getViewingSessionId: () => null, onChatBridgeReady() {},
    getMainWindow: () => null, getWorkspaceRoot: async () => null, getExtraRoots: async () => [], sendToRenderer() {},
    getHost: () => ({ async call(method, params) { calls.push([method, params]); throw new Error("Worker missing"); } }),
  });
  for (const channel of ["start", "status", "cancel", "snapshot-capture", "teaching-open", "teaching-write", "teaching-lock", "teaching-confirm", "teaching-review", "teaching-adopt", "candidate-review", "candidate-decide"]) {
    await assert.rejects(handlers.get(channel)({ sender: { id: 2 } }, { checkId: "anything" }), /PERMISSION_DENIED/);
  }
  const event = { sender: { id: 1 } };
  await assert.rejects(handlers.get("pptx-adopt")({ sender: { id: 2 } }, { reviewId: "review" }), /PERMISSION_DENIED/);
  for (const request of [{}, { reviewId: "review", path: "/foreign" }, { reviewId: "review", effectBindings: {} },
    { reviewId: "review", effectBindings: Array(20001).fill({}) }])
    await assert.rejects(handlers.get("pptx-adopt")(event, request), /Invalid PPTX candidate adoption/);
  await assert.rejects(handlers.get("pptx-adopt")(event, { reviewId: "review" }, "extra"), /Invalid PPTX candidate adoption/);
  assert.deepEqual(adoptionCalls, []);
  const bindings = [{ pageIndex: 0, objectId: "old-object", targetIndex: 2 }];
  assert.deepEqual(await handlers.get("pptx-adopt")(event, { reviewId: "review", effectBindings: bindings }), { ok: true });
  assert.deepEqual(adoptionCalls, [["review", bindings]]);
  for (const channel of ["asset-locks-read", "asset-lock-set"]) {
    await assert.rejects(handlers.get(channel)({ sender: { id: 2 } }, {}), /PERMISSION_DENIED/);
    await assert.rejects(handlers.get(channel)(event, {}, "extra"), /Unexpected asset lock/);
  }
  assert.deepEqual(assetCalls, []);
  const lockRequest = { viewId: "current-view", expectedTeachingRevision: "current-revision", expectedLockRevision: null,
    objectId: "current-image", locked: true };
  assert.deepEqual(await handlers.get("asset-lock-set")(event, lockRequest), { result: "set" });
  assert.deepEqual(assetCalls, [["set", lockRequest]]);
  for (const channel of ["visual-prepare", "visual-approve", "visual-clear"]) {
    await assert.rejects(handlers.get(channel)({ sender: { id: 2 } }, {}), /PERMISSION_DENIED/);
    await assert.rejects(handlers.get(channel)(event, {}, "extra"), /Unexpected source visual/);
  }
  await assert.rejects(handlers.get("visual-clear")(event, {}), /does not accept parameters/);
  for (const channel of ["style-prepare", "style-approve", "style-clear"]) {
    await assert.rejects(handlers.get(channel)({ sender: { id: 2 } }, {}), /PERMISSION_DENIED/);
    await assert.rejects(handlers.get(channel)(event, {}, "extra"), /Unexpected style/);
  }
  await assert.rejects(handlers.get("style-clear")(event, {}), /does not accept parameters/);
  for (const channel of ["tts-prepare", "tts-submit", "tts-status", "tts-list", "tts-archive", "tts-adopt"]) {
    await assert.rejects(handlers.get(channel)({ sender: { id: 2 } }, {}), /PERMISSION_DENIED/);
    await assert.rejects(handlers.get(channel)(event, {}, "extra"), /Unexpected TTS/);
  }
  for (const channel of ["image-prepare", "image-approve", "image-clear"]) {
    await assert.rejects(handlers.get(channel)({ sender: { id: 2 } }, {}), /PERMISSION_DENIED/);
    await assert.rejects(handlers.get(channel)(event, {}, "extra"), /Unexpected image/);
  }
  await assert.rejects(handlers.get("image-approve")(event, { reviewId: "id", token: "invalid" }), /Invalid image approval/);
  await assert.rejects(handlers.get("snapshot-capture")(event, {}, "extra"), /Unexpected snapshot/);
  await assert.rejects(handlers.get("teaching-open")(event, { sessionId: "chat", path: "/etc/passwd" }), /Invalid teaching/);
  await assert.rejects(handlers.get("teaching-write")(event, {}, "extra"), /Unexpected teaching/);
  await assert.rejects(handlers.get("teaching-confirm")(event, {}, "extra"), /Unexpected teaching/);
  await assert.rejects(handlers.get("candidate-review")(event, {}, "extra"), /Unexpected narration/);
  await assert.rejects(handlers.get("candidate-decide")(event, {}, "extra"), /Unexpected narration/);
  await assert.rejects(handlers.get("start")(event, { path: "/etc/passwd" }), /does not accept parameters/);
  await assert.rejects(handlers.get("start")(event, undefined), /does not accept parameters/);
  assert.equal(snapshotReads, 0);
  assert.equal(calls.length, 0);
  const state = await handlers.get("start")(event);
  await assert.rejects(handlers.get("status")(event, { checkId: state.checkId }, "extra"), /Unexpected/);
  await assert.rejects(handlers.get("cancel")(event, { checkId: state.checkId, path: "/etc/passwd" }), /Unknown inspection/);
  assert.deepEqual(calls, [["courseware.parseStart", { path: "/workspace/saved.pptx" }]]);
});
