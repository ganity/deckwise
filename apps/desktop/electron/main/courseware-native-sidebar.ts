import { samePptEditorBinding, type PptEditorContext, type CoursewareTeachingView } from "@pi-desktop/shared";
import type { CoursewareClassroomCoordinator } from "./courseware-classroom";
import type { CoursewareClassroomTts } from "./courseware-classroom-tts";
import type { CoursewareClassroomImages } from "./courseware-classroom-images";
import type { CoursewareTeachingCoordinator } from "./courseware-teaching";
import type { CoursewareNativeMedia } from "./courseware-native-media";
import type { CoursewareTtsCoordinator } from "./courseware-tts";

/** Native teaching uses the same authority and validation as the outer tools. */
export function createNativeTeachingHandler(input: {
  teaching: CoursewareTeachingCoordinator;
  tts: CoursewareTtsCoordinator;
  media: CoursewareNativeMedia;
  sessionId(): string | null;
  context(): Promise<PptEditorContext>;
  ensureSaved?(): Promise<void>;
  nativeRoute?(operation: string, args: Record<string, unknown>, page: number): Promise<{ value: unknown } | undefined>;
  editorImages?(operation: string, args: Record<string, unknown>, target: PptEditorContext): Promise<unknown>;
  classroom?: CoursewareClassroomCoordinator;
  classroomTts?: CoursewareClassroomTts;
  classroomImages?: CoursewareClassroomImages;
  assessmentContext?(view: CoursewareTeachingView): Promise<{ current: boolean; embedded?: boolean }>;
}) {
  const execute = async (payload: unknown): Promise<unknown> => {
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new Error("Invalid teaching request");
    const request = payload as Record<string, unknown>;
    if (Object.keys(request).some(key => !["operation", "context", "args"].includes(key)) ||
        typeof request.operation !== "string" || !request.context || typeof request.context !== "object" ||
        !request.args || typeof request.args !== "object" || Array.isArray(request.args) ||
        JSON.stringify(request).length > (request.operation?.startsWith("classroom:") ? 24_000_000 : 2_000_000))
      throw new Error("Invalid teaching request");

    const context = await input.context();
    const expected = request.context as PptEditorContext;
    if (!samePptEditorBinding(context, expected) || context.readOnly || (request.operation !== "draft:set" && (context.page !== expected.page ||
        request.operation !== "open" && context.editGeneration !== expected.editGeneration))) throw new Error("Teaching target changed; return to the original page before saving");
    const native = await input.nativeRoute?.(request.operation, request.args as Record<string, unknown>, context.page ?? 1);
    if (native) return native.value;
    if (request.operation === "open") await input.ensureSaved?.();
    const sessionId = input.sessionId();
    if (!sessionId) throw new Error("Open a courseware conversation before editing teaching");
    const args = request.args;
    if (request.operation.startsWith("classroom:")) {
      if (!input.classroom || Object.hasOwn(args, "sessionId")) throw new Error("Invalid assessment request");
      const payload = { ...args, sessionId };
      switch (request.operation) {
        case "classroom:open": return input.classroom.open(payload);
        case "classroom:write": return input.classroom.write(payload);
        case "classroom:image": return input.classroom.image(payload);
        case "classroom:image:models": if (input.classroomImages) return input.classroomImages.models(payload); break;
        case "classroom:image:quote": if (input.classroomImages) return input.classroomImages.quote(payload); break;
        case "classroom:image:submit": if (input.classroomImages) return input.classroomImages.submit(payload); break;
        case "classroom:image:refresh": if (input.classroomImages) return input.classroomImages.refresh(payload); break;
        case "classroom:reference": return input.classroom.reference(payload);
        case "classroom:audio:preview": return input.classroom.previewAudio(payload);
        case "classroom:tts:models": if (input.classroomTts) return input.classroomTts.models(payload); break;
        case "classroom:tts:quote": if (input.classroomTts) return input.classroomTts.quote(payload); break;
        case "classroom:tts:submit": if (input.classroomTts) return input.classroomTts.submit(payload); break;
        case "classroom:tts:refresh": if (input.classroomTts) return input.classroomTts.refresh(payload); break;
        default: throw new Error("Unsupported assessment operation");
      }
    }
    switch (request.operation) {
      case "open": {
        const view = await input.teaching.open(sessionId);
        const assessment = await input.assessmentContext?.(view);
        if (!assessment) return view;
        return { ...view, ...(input.classroom && assessment.current
            ? { assessment: await input.classroom.openNative(sessionId, view) }
            : { nativeDraft: await input.teaching.draft({ viewId: view.viewId }, false),
                ...(input.classroom && assessment.embedded ? { embeddedAssessment: await input.classroom.openNative(sessionId, view) } : {}) }) };
      }
      case "write": return input.teaching.update(args, false);
      case "draft:get": return input.teaching.draft(args, false);
      case "draft:set": return input.teaching.draft(args, true);
      case "tts:models": return input.tts.models(args);
      case "tts:list": return input.tts.list(args);
      case "tts:prepare": return input.tts.prepare(args);
      case "tts:quote": return input.tts.quote(args);
      case "tts:submit": return input.tts.submitConfirmed(args);
      case "tts:status": return input.tts.status(args);
      case "media:list": return input.media.list(args);
      case "media:adopt": return input.media.adopt(args);
      case "media:preview": return input.media.preview(args);
      case "tts:preview": return input.tts.preview(args);
      case "tts:archive": return input.tts.archive(args);
      case "tts:adopt": return input.tts.adopt(args);
      default: throw new Error("Unsupported native teaching operation");
    }
  };
  // Content mutations and reopening must remain ordered. Read-only media work
  // waits for preceding mutations, but must not hold the next page or draft.
  const independentReads = new Set(["tts:models", "tts:list", "tts:preview", "media:list", "media:preview"]);
  let reads = 0;
  let queue: Promise<unknown> = Promise.resolve();
  return (payload: unknown): Promise<unknown> => {
    if (payload && typeof payload === "object" && !Array.isArray(payload) &&
        typeof (payload as Record<string, unknown>).operation === "string" &&
        independentReads.has((payload as Record<string, unknown>).operation as string)) {
      if (reads >= 4) return Promise.reject(new Error("COURSEWARE_TEACHING_READ_BUSY: retry after pending reads finish"));
      reads++;
      return queue.then(() => execute(payload)).finally(() => { reads--; });
    }
    if (input.editorImages && payload && typeof payload === "object" && !Array.isArray(payload)) {
      const { operation, context, args } = payload as Record<string, unknown>;
      if (typeof operation === "string" && operation.startsWith("editor-image:")) {
        if (!context || typeof context !== "object" || Array.isArray(context) || !args ||
            typeof args !== "object" || Array.isArray(args) || Object.keys(payload).length !== 3)
          return Promise.reject(new Error("Invalid image request"));
        return input.editorImages(operation, args as Record<string, unknown>, context as PptEditorContext);
      }
    }
    const result = queue.then(() => execute(payload));
    queue = result.catch(() => {});
    return result;
  };
}
