import type { MaicClassroom } from "@pi-desktop/courseware-runtime/player";

type MaicQuizContent = Extract<MaicClassroom["scenes"][number]["content"], { type: "quiz" }>;
export type QuizQuestion = MaicQuizContent["questions"][number];
export type QuizOption = NonNullable<QuizQuestion["options"]>[number];
export type QuizImage = NonNullable<QuizQuestion["image"]>;
export interface ClassroomScene {
  id: string; stageId: string; type: string; title: string; order: number;
  content: { type: string; questions?: QuizQuestion[]; interactionMode?: string; playbackConfig?: Record<string, unknown>; canvas?: Record<string, unknown> };
  actions?: Array<Record<string, unknown>>; metadata?: Record<string, unknown>;
}
export interface ClassroomDocument {
  id: string; stage: Record<string, unknown>; scenes: ClassroomScene[]; createdAt: string;
  mediaManifest?: Array<Record<string, unknown>>; audioManifest?: Array<Record<string, unknown>>;
}
export interface ClassroomEditorView { projectId: string; revision: string | null; sourceRevision: string; classroom: ClassroomDocument | null; resourceUrls?: Record<string, string> }

export const initialPlayback = { introSpeechMode: "page_enter_only", attemptPolicy: "until_correct", successSpeechText: "回答正确！非常棒！", failureSpeechText: "很遗憾，你选错了，再试一次吧！", cueUserOnEnter: true, cueUserOnRetry: false };
export const question = (): QuizQuestion => ({ id: crypto.randomUUID(), type: "single", question: "新题目", options: [{ value: "A", label: "选项一" }, { value: "B", label: "选项二" }], answer: [], hasAnswer: true, points: 1 });
export const clone = <T,>(value: T): T => structuredClone(value);

/** Stable option values are the MAIC answer and image identity, independent of display order. */
export function removeQuestionOption(q: QuizQuestion, value: string): QuizQuestion {
  return { ...q, options: q.options?.filter(option => option.value !== value), answer: q.answer?.filter(answer => answer !== value) };
}
export function newOptionValue(q: QuizQuestion): string | undefined {
  return ["A", "B", "C", "D"].find(value => !q.options?.some(option => option.value === value));
}

export function recoverClassroomDraft(current: ClassroomEditorView, candidate: ClassroomEditorView): ClassroomDocument | null {
  return candidate.projectId === current.projectId && candidate.revision === current.revision &&
    candidate.sourceRevision === current.sourceRevision ? candidate.classroom : null;
}

export function updateCheckpointQuestion(scene: ClassroomScene, actionId: string, questionText: string, elementId: string): ClassroomScene {
  const elements = scene.content.canvas?.elements;
  if (!Array.isArray(elements) || !elements.some(element => element.id === elementId && element.type === "text"))
    throw new Error("请重新选择问题对应的画布文本框");
  if (!scene.actions?.some(action => action.id === actionId && action.type === "interaction_checkpoint" && action.checkpointKind === "chapter_summary"))
    throw new Error("课堂互动动作已改变");
  const escaped = questionText.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
  return { ...scene,
    metadata: { ...scene.metadata, nativeQuestionElementId: elementId },
    actions: scene.actions.map(action => action.id === actionId ? { ...action, question: questionText } : action),
    content: { ...scene.content, canvas: { ...scene.content.canvas, elements: elements.map(element => element.id === elementId ? { ...element, content: `<p>${escaped}</p>` } : element) } },
  };
}

/** Only the image owner entry is removed; assets shared by another question remain bound. */
export function pruneQuizImageBindings(document: ClassroomDocument): ClassroomDocument {
  if (!document.mediaManifest) return document;
  const bindings = new Set<string>();
  for (const scene of document.scenes) for (const q of scene.content.questions ?? []) {
    if (q.image) bindings.add(`${scene.id}:quiz-question:${q.id}`);
    for (const option of q.options ?? []) if (option.image) bindings.add(`${scene.id}:quiz-option:${q.id}:${option.value}`);
  }
  return { ...document, mediaManifest: document.mediaManifest.filter(entry =>
    !(typeof entry.sceneId === "string" && typeof entry.elementId === "string" &&
      (entry.elementId.startsWith("quiz-question:") || entry.elementId.startsWith("quiz-option:"))) ||
      bindings.has(`${entry.sceneId}:${entry.elementId}`)) };
}

export async function saveBeforeImageAttachment(input: {
  save(): Promise<ClassroomEditorView>; attach(saved: ClassroomEditorView): Promise<ClassroomEditorView>;
  current(): boolean; saved(view: ClassroomEditorView): void;
}): Promise<ClassroomEditorView | null> {
  const saved = await input.save();
  if (!input.current()) return null;
  // The content write already advanced the CAS fence even when asset attachment later fails.
  input.saved(saved);
  return input.attach(saved);
}

type MaicSlideCanvas = Extract<MaicClassroom["scenes"][number]["content"], { type: "slide" }>["canvas"];
/** New interaction pages inherit course dimensions, including kindergarten 16:10. */
export function createInteractionCanvas(document: ClassroomDocument, id: string): MaicSlideCanvas {
  const stageCanvas = document.stage.canvas as { viewportSize?: number; viewportRatio?: number } | undefined;
  const existing = document.scenes.find(scene => scene.content.type === "slide")?.content.canvas;
  return {
    id, viewportSize: Number(stageCanvas?.viewportSize ?? existing?.viewportSize ?? 1000),
    viewportRatio: Number(stageCanvas?.viewportRatio ?? existing?.viewportRatio ?? 9 / 16),
    theme: { backgroundColor: "#FFFFFF", themeColors: ["#3B82F6"], fontColor: "#111827", fontName: "Arial" },
    elements: [],
  };
}

/** cloud-web reads the short-answer reference from answer[0]; MAIC grading also accepts referenceAnswer. */
export function shortAnswerReferencePatch(text: string): Partial<QuizQuestion> {
  return { answer: text.trim() ? [text] : [], referenceAnswer: text, hasAnswer: false };
}

export function pruneRemovedSceneBindings(next: ClassroomDocument, previous: ClassroomDocument): ClassroomDocument {
  const ids = new Set(next.scenes.map(scene => scene.id));
  const removed = new Set(previous.scenes.filter(scene => !ids.has(scene.id)).map(scene => scene.id));
  const nextActions = new Set(next.scenes.flatMap(scene => (scene.actions ?? []).map(action => `${scene.id}:${String(action.id)}`)));
  const removedActions = new Set(previous.scenes.flatMap(scene => (scene.actions ?? [])
    .filter(action => !nextActions.has(`${scene.id}:${String(action.id)}`)).map(action => `${scene.id}:${String(action.id)}`)));
  if (!removed.size && !removedActions.size) return next;
  const pruneIds = (value: unknown) => Array.isArray(value) ? value.filter(id => !removed.has(id)) : value;
  return { ...next,
    mediaManifest: next.mediaManifest?.filter(entry => !removed.has(String(entry.sceneId))),
    audioManifest: next.audioManifest?.filter(entry => !removed.has(String(entry.sceneId)) && !removedActions.has(`${entry.sceneId}:${entry.actionId}`)),
    scenes: next.scenes.map(scene => ({ ...scene,
      actions: scene.actions?.map(action => {
        if (action.type !== "interaction_checkpoint" || action.checkpointKind !== "chapter_summary" || !action.context) return action;
        const context = action.context as Record<string, unknown>;
        return { ...action, context: { ...context, sourceSceneIds: pruneIds(context.sourceSceneIds) } };
      }),
      metadata: scene.metadata?.interaction ? { ...scene.metadata, interaction: {
        ...scene.metadata.interaction as Record<string, unknown>, sourceSceneIds: pruneIds((scene.metadata.interaction as Record<string, unknown>).sourceSceneIds),
      } } : scene.metadata,
    })),
  };
}

export interface ClassroomTtsSelection {
  sessionId: string; projectId: string; expectedRevision: string; expectedSourceRevision: string;
  sceneId: string; actionId: string; model: string; voice: string | null;
}
export interface ClassroomTtsResult {
  key: string; state: string; task?: { state: string; errorCode?: string; feeState?: string };
  quote?: { quoteId: string; maxPoints: number; expiresAt: string }; view?: ClassroomEditorView;
}
