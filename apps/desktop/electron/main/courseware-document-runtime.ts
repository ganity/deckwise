import { nativeRepairStore } from "./courseware-native-repairs";
import type { IpcMain } from "electron";
import { BrowserWindow } from "electron";
import { PptEditorController } from "./ppt-editor";
import { CoursewareTeachingCoordinator } from "./courseware-teaching";
import { CoursewareCandidateCoordinator, type NarrationComplete, type SceneComplete, type CandidateModelResolver } from "./courseware-candidates";
import { CoursewareNativeTools } from "./courseware-native-tools";
import { CoursewareNativeAudio } from "./courseware-native-audio";
import { CoursewareNativeVideo } from "./courseware-native-video";
import { CoursewareNativeMusic } from "./courseware-native-music";
import { CoursewareNativeSave } from "./courseware-native-save";
import { CoursewareSourceAdoption } from "./courseware-source-adoption";
import { CoursewareClassroomCoordinator } from "./courseware-classroom";
import { createNativeAssessmentMedia } from "./courseware-native-assessment-media";
import { NativePlaybackPreflight } from "./courseware-native-preflight";
import { CoursewareContentReview, type ContentReviewTurns } from "./courseware-content-review";
import { decodeCoursewareAudio, decodeCoursewareVideo } from "./courseware-audio-decode";
import type { DesktopAuthSession } from "./auth-session";
import type { CoursewareDocumentScope } from "./courseware-document-tools";

export function createBackgroundCoursewareEditor(ipcMain: IpcMain) {
  const window = new BrowserWindow({ show: false, webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true } });
  const editor = new PptEditorController(ipcMain, () => {}, undefined, true);
  editor.setBounds({ x: 0, y: 0, width: 1280, height: 720 });
  editor.setVisible(true);
  editor.configureUi({ teachingOpen: false });
  // The hidden module needs the native readiness handshake, but exposes no interactive sidebar.
  editor.nativeTeaching = async () => { throw new Error("Background editor has no interactive teaching sidebar"); };
  return { editor, window, dispose() { editor.dispose(); if (!window.isDestroyed()) window.destroy(); } };
}

/** Only execution context varies; native mutation, media jobs, CAS and playback checks stay shared. */
export function createCoursewareDocumentRuntime(input: {
  editor: PptEditorController; scope: CoursewareDocumentScope; background: boolean;
  review: import("./courseware-classroom-images").QuizImageReview;
  auth: DesktopAuthSession; complete: NarrationComplete; completeVision: SceneComplete; resolveModel?: CandidateModelResolver;
  activeTurns: ReadonlyMap<string, string>; reviewTurns: ContentReviewTurns; getHost: () => CoursewareDocumentScope["host"] | null;
}) {
  const { editor, scope } = input;
  const getSession = () => scope.sessionId;
  const getWorkspace = async () => { await scope.assertCurrent(); return scope.workspace; };
  const assertOwned = (sessionId: string) => {
    const target = editor.documentTarget();
    if (sessionId !== scope.sessionId || input.getHost() !== scope.host ||
        target?.sourcePath !== scope.path || target.workspaceRoot !== scope.workspace)
      throw new Error("Native teaching document lease changed");
  };
  const teaching = new CoursewareTeachingCoordinator(editor, input.getHost, getWorkspace, getSession, assertOwned);
  const repairs = nativeRepairStore(scope.host, scope.path, () => scope.assertCurrent());
  const candidates = new CoursewareCandidateCoordinator(teaching, input.complete, undefined, input.resolveModel, id => input.activeTurns.get(id), input.completeVision, repairs);
  const route = async (operation: string, args: Record<string, unknown>, page: number) => {
    await scope.assertCurrent();
    return editor.routeNativeTeaching(scope.workspace, operation, args, page);
  };
  const audio = new CoursewareNativeAudio(input.auth, input.getHost, getSession, route, decodeCoursewareAudio);
  const video = new CoursewareNativeVideo(input.auth, input.getHost, getSession, route, decodeCoursewareVideo);
  const music = new CoursewareNativeMusic(input.auth, input.getHost, getSession, route, decodeCoursewareAudio);
  const classroom = new CoursewareClassroomCoordinator({ native: (operation, args) => teaching.native(operation, args, typeof args.pageNumber === "number" ? args.pageNumber : undefined),
    getHost: input.getHost, getSessionId: getSession, getWorkspace, assertOwned,
    openProject: sessionId => teaching.open(sessionId) });
  const { assessments } = createNativeAssessmentMedia({ teaching, classroom, auth: input.auth, getHost: input.getHost, getWorkspace, assertOwned, review: input.review });
  const preflight = new NativePlaybackPreflight();
  const contentReview = input.resolveModel ? new CoursewareContentReview({ teaching, classroom,
    taskRoute: async () => {
      await scope.assertCurrent();
      const { task } = await scope.host.call<{ task?: { taskType?: string; generatedPath?: string } }>("courseware.task.get", { sessionId: scope.sessionId });
      await scope.assertCurrent();
      return task?.taskType === "import" ? "import" : task?.generatedPath && (task.taskType === "plain" || task.taskType === "scene") ? task.taskType : "unknown";
    },
    complete: input.completeVision, checkSpeech: input.complete, resolveModel: input.resolveModel, getTurnId: id => input.activeTurns.get(id),
    save: async () => { assertOwned(scope.sessionId); await editor.ensureSaved(scope.workspace); assertOwned(scope.sessionId); } }, input.reviewTurns) : undefined;
  const save = new CoursewareNativeSave(input.getHost, getSession, async () => scope.workspace, assertOwned,
    operation => teaching.duringNativeSave(operation));
  if (input.background) editor.nativeSave = value => save.prepare(value);
  const tools = new CoursewareNativeTools(teaching, candidates, audio, route, getSession, video, music, undefined,
    async (_sessionId, canDispatch) => {
      if (!canDispatch()) throw new Error("Native teaching turn ended before save");
      assertOwned(scope.sessionId); await editor.ensureSaved(scope.workspace); assertOwned(scope.sessionId);
    }, assessments, {
      verifyInline: async (sessionId, text) => (await scope.host.call<{supplied: boolean}>("courseware.material.verifyInline", { sessionId, text })).supplied,
      record: (sessionId, name, text) => scope.host.call("courseware.material.record", { sessionId, name, text, parser: "utf8/1" }),
      read: (sessionId, sourceId) => scope.host.call("courseware.material.read", { sessionId, sourceId }),
      list: sessionId => scope.host.call("courseware.material.list", { sessionId }),
    }, (view, check) => preflight.inspect(editor, scope.workspace, view, check),
    contentReview ? (sessionId, canDispatch, repairSpeech) => contentReview.run(sessionId, canDispatch, repairSpeech) : undefined,
    repairs, input.reviewTurns);
  return { execute: tools.execute.bind(tools), beforeOpen: async () => {
    await save.recover(scope.workspace, scope.path, scope.sessionId);
    const adoption = new CoursewareSourceAdoption(editor, teaching, input.getHost, async () => scope.workspace, getSession, () => {});
    await adoption.beforeOpen(scope.workspace, scope.path, scope.sessionId);
  } };
}
