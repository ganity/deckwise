import type { createSceneCoursePlan } from "./courseware-scene-plan";
import type { resolveSceneCourseVisuals } from "./courseware-scene-assets";
import type { buildSceneCourseDeck } from "./courseware-scene-deck";
import type { stageGeneratedSceneCourse } from "./courseware-scene-staging";

type Services = {
  resolve: (input: Parameters<typeof resolveSceneCourseVisuals>[0]) => ReturnType<typeof resolveSceneCourseVisuals>;
  build: (input: Parameters<typeof buildSceneCourseDeck>[0]) => ReturnType<typeof buildSceneCourseDeck>;
  stage: (input: Omit<Parameters<typeof stageGeneratedSceneCourse>[0], "host">) => ReturnType<typeof stageGeneratedSceneCourse>;
};

/** Assemble the approved plan without regenerating its narration or existing assets. */
export async function assembleSceneCourse(input: {
  workspace: string;
  sessionId: string;
  modelKey: string;
  thinkingLevel?: string;
  plan: Awaited<ReturnType<typeof createSceneCoursePlan>>;
  assignments: Parameters<typeof resolveSceneCourseVisuals>[0]["assignments"];
  canvas: { width: number; height: number };
  sceneProof?: Parameters<typeof stageGeneratedSceneCourse>[0]["sceneProof"];
  signal?: AbortSignal;
}, services: Services, assertCurrent: () => Promise<void>) {
  const { signal } = input;
  const captured = structuredClone({ ...input, signal: undefined });
  if (!captured.plan || typeof captured.plan.title !== "string" || !captured.plan.title.trim() ||
      captured.plan.title.length > 200 || !Array.isArray(captured.plan.pages) ||
      captured.plan.pages.length < 1 || captured.plan.pages.length > 30)
    throw new Error("Invalid approved scene course plan");
  const check = async () => { signal?.throwIfAborted(); await assertCurrent(); signal?.throwIfAborted(); };
  await check();
  const visuals = await services.resolve({ pages: captured.plan.pages, assignments: captured.assignments, canvas: captured.canvas, signal });
  await check();
  const deck = await services.build({ sessionId: captured.sessionId, modelKey: captured.modelKey,
    thinkingLevel: captured.thinkingLevel, pages: captured.plan.pages, visuals, canvas: captured.canvas, signal });
  await check();
  return services.stage({ workspace: captured.workspace, sessionId: captured.sessionId,
    title: captured.plan.title, pptx: deck.pptx, teaching: deck.teaching,
    ...(captured.sceneProof ? { sceneMapping: deck.mapping, sceneProof: captured.sceneProof } : {}), signal });
}
