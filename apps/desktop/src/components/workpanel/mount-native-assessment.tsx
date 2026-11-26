import { createRoot } from "react-dom/client";
import { createInstance } from "i18next";
import { I18nextProvider } from "react-i18next";
import { zhCN } from "@pi-desktop/i18n";
import { parseMaicClassroom, prepareMaicAssessmentSpeech } from "@pi-desktop/courseware-runtime/player";
import { CoursewareClassroomEditor, type ClassroomEditorToolbar } from "./CoursewareClassroomEditor";
import type { ClassroomEditorView } from "../../lib/courseware-classroom";
import styles from "./courseware-classroom-editor.css?inline";
export { speechGenerationError } from "../../lib/courseware-speech-error";
export { mountNativeTeachingQuestion } from "./mount-native-teaching-question";

const i18n = createInstance();
export const nativeSpeechLabels = zhCN.panel.pptEditor;
void i18n.init({ lng: "zh-CN", initAsync: false, resources: { "zh-CN": { translation: zhCN } } });

export async function saveOnlineAssessment(request: (operation: string, args?: object) => Promise<any>, args: {
  projectId: string; expectedRevision: string; expectedSourceRevision: string; classroom: unknown;
}, page: number) {
  const current = await request("assessment-context");
  if (args.projectId !== current.projectId || args.expectedRevision !== current.revision || args.expectedSourceRevision !== current.sourceRevision)
    throw new Error("课件已更新，请重新加载后再编辑课堂互动。");
  const classroom = prepareMaicAssessmentSpeech(parseMaicClassroom(args.classroom));
  const old = current.classroom.scenes[page - 1], next = classroom.scenes[page - 1];
  if (!old || old.id !== next?.id || old.content.type !== next.content.type ||
      !(old.content.type === "quiz" || (old.content.type === "slide" &&
        old.actions?.some((action: { type: string; checkpointKind?: string }) => action.type === "interaction_checkpoint" && action.checkpointKind === "chapter_summary"))))
    throw new Error("此题需要在桌面本地编辑后再同步。");
  return request("assessment-write", { ...args, changedPageIds: [old.id], classroom: {
    ...current.classroom, scenes: current.classroom.scenes.map((scene: { id: string }) => scene.id === old.id ? next : scene),
  } });
}

/** The native iframe owns the panel; all operations retain its document binding. */
export function mountNativeAssessment(container: HTMLElement, request: (operation: string, args?: object) => Promise<any>, onToolbarChange: () => void) {
  const sheet = container.ownerDocument.createElement("style");
  sheet.textContent = styles;
  const content = container.ownerDocument.createElement("div");
  content.style.cssText = "height:100%;min-height:0;--ds-text-primary:var(--text-normal,#172033);--ds-bg-primary:var(--background-normal,#fff);--ds-bg-secondary:var(--background-toolbar,#f7f8fa);--ds-border-default:var(--border-regular-control,#ddd);--ds-accent:#267c72;--ds-error:#c33";
  container.append(sheet, content);
  const root = createRoot(content);
  let toolbar: ClassroomEditorToolbar | undefined;
  let selection = "";
  const transport: NonNullable<Parameters<typeof CoursewareClassroomEditor>[0]["transport"]> = {
    coursewareClassroomOpen: () => request("classroom:open"),
    coursewareClassroomWrite: (_, projectId, expectedRevision, expectedSourceRevision, classroom) => request("classroom:write", { projectId, expectedRevision, expectedSourceRevision, classroom }),
    coursewareClassroomImage: (_, projectId, expectedRevision, expectedSourceRevision, target) => request("classroom:image", { projectId, expectedRevision, expectedSourceRevision, ...target }),
    coursewareClassroomReference: (_, projectId, expectedRevision, expectedSourceRevision, sceneId, actionId) => request("classroom:reference", { projectId, expectedRevision, expectedSourceRevision, sceneId, actionId }),
    coursewareClassroomTtsModels: () => request("classroom:tts:models"),
    coursewareClassroomTtsQuote: ({ sessionId: _sessionId, ...args }) => request("classroom:tts:quote", args),
    coursewareClassroomTtsSubmit: ({ sessionId: _sessionId, ...args }) => request("classroom:tts:submit", args),
    coursewareClassroomTtsRefresh: ({ sessionId: _sessionId, ...args }) => request("classroom:tts:refresh", args),
    coursewareClassroomImageModels: () => request("classroom:image:models"),
    coursewareClassroomImageQuote: ({ sessionId: _sessionId, ...args }) => request("classroom:image:quote", args),
    coursewareClassroomImageSubmit: ({ sessionId: _sessionId, ...args }) => request("classroom:image:submit", args),
    coursewareClassroomImageRefresh: ({ sessionId: _sessionId, ...args }) => request("classroom:image:refresh", args),
    coursewareClassroomPlay: (_, projectId, expectedRevision, expectedSourceRevision, locale) => request("classroom:play", { projectId, expectedRevision, expectedSourceRevision, locale }),
    // These operations belong to the standalone course editor, never the native panel.
    coursewareClassroomCreate: async () => { throw new Error("Create a course from Chat"); },
    coursewareClassroomExport: async () => { throw new Error("Export from the course workspace"); },
  };
  return {
    get toolbar() { return toolbar; },
    update(view: ClassroomEditorView, page: number) {
      const nextSelection = `${view.projectId}:${view.sourceRevision}:${view.revision}:${page}`;
      if (nextSelection !== selection) { toolbar = undefined; selection = nextSelection; }
      root.render(<I18nextProvider i18n={i18n}><CoursewareClassroomEditor
        key={`${view.projectId}:${view.sourceRevision}:${view.revision}`} sessionId={view.projectId}
        sidebar initialView={view} initialPageIndex={page - 1} transport={transport}
        onToolbarChange={next => { toolbar = next; onToolbarChange(); }} /></I18nextProvider>);
    },
    dispose() { root.unmount(); container.replaceChildren(); },
  };
}
