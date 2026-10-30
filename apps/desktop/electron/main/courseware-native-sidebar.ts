import { samePptEditorBinding, type PptEditorContext } from "@pi-desktop/shared";
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
}) {
  return async (payload: unknown): Promise<unknown> => {
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new Error("Invalid teaching request");
    const request = payload as Record<string, unknown>;
    if (Object.keys(request).some(key => !["operation", "context", "args"].includes(key)) ||
        typeof request.operation !== "string" || !request.context || typeof request.context !== "object" ||
        !request.args || typeof request.args !== "object" || Array.isArray(request.args) || JSON.stringify(request).length > 2_000_000)
      throw new Error("Invalid teaching request");
    if (request.operation === "open") await input.ensureSaved?.();
    const context = await input.context();
    const expected = request.context as PptEditorContext;
    if (!samePptEditorBinding(context, expected) || context.readOnly || (request.operation !== "draft:set" && (context.page !== expected.page ||
        request.operation !== "open" && context.editGeneration !== expected.editGeneration))) throw new Error("Teaching target changed; return to the original page before saving");
    const sessionId = input.sessionId();
    if (!sessionId) throw new Error("Open a courseware conversation before editing teaching");
    const args = request.args;
    switch (request.operation) {
      case "open": return input.teaching.open(sessionId);
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
}
