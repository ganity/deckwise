import type { CoursewareClassroomCoordinator, ClassroomView } from "./courseware-classroom";
import type { CoursewareClassroomTts } from "./courseware-classroom-tts";
import type { CoursewareClassroomImages } from "./courseware-classroom-images";
import { prepareMaicAssessmentSpeech } from "@pi-desktop/courseware-runtime/node";

/** Import, scene and PPT-master finish assessment media through the same saved classroom. */
export class CoursewareAssessmentMedia {
  constructor(private classroom: Pick<CoursewareClassroomCoordinator, "open" | "write">,
    private tts: Pick<CoursewareClassroomTts, "models" | "quote" | "submit" | "refresh">,
    private images: Pick<CoursewareClassroomImages, "models" | "quote" | "submit" | "refresh">) {}

  private status(view: ClassroomView) {
    const targets: Array<Record<string, unknown>> = [];
    for (const scene of view.classroom?.scenes ?? []) {
      const ids = Object.values(scene.metadata?.assessmentSpeechIds ?? {});
      for (const action of scene.actions ?? []) if (action.type === "speech" && ids.includes(action.id)) {
        const audioReady = !!action.audioId && !!view.classroom?.audioManifest?.some(entry =>
          entry.sceneId === scene.id && entry.actionId === action.id && entry.audioId === action.audioId);
        if (!audioReady) targets.push({ kind: "tts", sceneId: scene.id, actionId: action.id });
      }
      if (scene.content.type === "quiz") for (const question of scene.content.questions) {
        if (!["single", "multiple"].includes(question.type)) continue;
        for (const option of question.options ?? []) if (!option.image?.src)
          targets.push({ kind: "image", sceneId: scene.id, questionId: question.id, optionValue: option.value });
      }
    }
    return { projectId: view.projectId, expectedRevision: view.revision, expectedSourceRevision: view.sourceRevision,
      ready: targets.length === 0, targets };
  }

  async execute(sessionId: string, args: unknown, canDispatch: () => boolean) {
    if (!args || typeof args !== "object" || Array.isArray(args)) throw new Error("Invalid assessment media request");
    const input = args as Record<string, unknown>, mode = input.mode;
    const check = () => { if (!canDispatch()) throw new Error("Assessment media turn ended"); };
    check();
    if (mode === "context") {
      if (Object.keys(input).some(key => !["mode", "kind"].includes(key)) || input.kind !== undefined && !["tts", "image"].includes(String(input.kind)))
        throw new Error("Invalid assessment context");
      const view = await this.classroom.open({ sessionId }); check();
      const models = input.kind === "tts" ? await this.tts.models({ sessionId }) : input.kind === "image" ? await this.images.models({ sessionId }) : undefined;
      check(); return { ...this.status({ ...view, classroom: view.classroom ? prepareMaicAssessmentSpeech(view.classroom) : null }), ...(models ? { models } : {}) };
    }
    if (!["prepare", "refresh"].includes(String(mode)) || !["tts", "image"].includes(String(input.kind)) ||
        Object.keys(input).some(key => !["mode", "kind", "projectId", "expectedRevision", "expectedSourceRevision", "sceneId", "actionId", "questionId", "optionValue", "model", "voice"].includes(key)))
      throw new Error("Invalid assessment generation request");
    const { mode: _mode, kind, ...selection } = input;
    const request: Record<string, unknown> = { ...selection, sessionId };
    if (mode === "prepare") {
      const view = await this.classroom.open({ sessionId }); check();
      if (view.projectId !== input.projectId || view.revision !== input.expectedRevision || view.sourceRevision !== input.expectedSourceRevision)
        throw new Error("Assessment classroom changed; read context again");
      if (view.classroom) {
        const prepared = prepareMaicAssessmentSpeech(view.classroom);
        if (JSON.stringify(prepared) !== JSON.stringify(view.classroom)) {
          const saved = await this.classroom.write({ sessionId, projectId: view.projectId, expectedRevision: view.revision,
            expectedSourceRevision: view.sourceRevision, classroom: prepared }); check();
          request.expectedRevision = saved.revision; request.expectedSourceRevision = saved.sourceRevision;
        }
      }
    }
    const service = kind === "tts" ? this.tts : this.images;
    if (mode === "refresh") {
      const result = await service.refresh(request); check();
      if ("view" in result && result.view) return { ...result, view: { projectId: result.view.projectId,
        revision: result.view.revision, sourceRevision: result.view.sourceRevision } };
      return result;
    }
    // Agent generation is already authorized by the complete-course request; UI keeps explicit quoted confirmation.
    const quote = await service.quote(request); check();
    const result = await service.submit({ ...request, quoteId: quote.quote.quoteId }); check();
    return result;
  }
}
