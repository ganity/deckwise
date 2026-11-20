import { publishNativeGeneratedCourse, type NativeGenerationPage } from "./courseware-native-generation";
import type { SceneTeachingCorrection } from "./courseware-visual-master";

/** Generated local courses have one editable authority: the complete native PPTX. */
export async function stageGeneratedSceneCourse(input: {
  workspace: string; sessionId: string; title: string; pptx: Uint8Array;
  canonicalClassroom?: unknown;
  teaching: NativeGenerationPage[];
  sceneMapping?: Awaited<ReturnType<typeof import("@pi-desktop/courseware-runtime/authoring").compileScenesToPptx>>["mapping"];
  host: { call<T>(method: string, params: unknown): Promise<T> };
  signal?: AbortSignal;
  sceneProof?: { planSha256: string; principalKey: string; selectedIntentIds: string[];
    teachingCorrections?: SceneTeachingCorrection[] };
  assertCurrent?: () => Promise<void>;
}) {
  if (input.sceneProof && !input.sceneMapping) throw new Error("Generated scene object mapping is required");
  return publishNativeGeneratedCourse({ ...input, pages: input.teaching });
}
