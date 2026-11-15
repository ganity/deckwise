import { parseMaicClassroom, type MaicClassroom } from "@pi-desktop/courseware-runtime/node";
import type { CoursewareEnrichment, CoursewareProject } from "@pi-desktop/shared";

/** Preserve the PPTist question page, then use MAIC's standard Quiz for objective grading. */
export function projectDeliveryAssessments(
  classroom: MaicClassroom,
  pages: CoursewareProject["pages"],
  assessments: Record<string, unknown> = {},
  enrichment?: CoursewareEnrichment,
  assetPaths: ReadonlyMap<string, { url: string; mimeType: string }> = new Map(),
): MaicClassroom {
  type QuizContent = Extract<MaicClassroom["scenes"][number]["content"], { type: "quiz" }>;
  const next = structuredClone(classroom);
  const scenes: MaicClassroom["scenes"] = [];
  for (const scene of next.scenes) {
    scenes.push(scene);
    const page = pages.find(page => page.pageId === scene.id);
    const checkpoints = page?.actions.filter(action => action.type === "interaction_checkpoint" && action.checkpointKind === "chapter_summary") ?? [];
    const storedQuiz = assessments[scene.id];
    const plannedQuiz = enrichment?.plan?.units.some(unit => unit.kind === "quiz" && unit.pageIds.includes(scene.id));
    const plannedCheckpoint = enrichment?.plan?.units.some(unit => unit.kind === "checkpoint" && unit.pageIds.includes(scene.id));
    const checkpoint = checkpoints.find(action => {
      const response = action.response as { kind?: string } | undefined;
      return !!response && (["single", "multiple", "judge"].includes(response.kind ?? "") || plannedQuiz && response.kind === "short_answer");
    });
    if (storedQuiz !== undefined || checkpoint && !plannedCheckpoint) {
      const parsedContent = storedQuiz !== undefined
        ? parseMaicClassroom({ id: next.id, stage: next.stage, createdAt: next.createdAt,
            scenes: [{ id: scene.id, stageId: scene.stageId, title: scene.title, order: scene.order, type: "quiz", content: storedQuiz, actions: [] }] }).scenes[0].content
        : undefined;
      if (storedQuiz !== undefined && parsedContent?.type !== "quiz") throw new Error("Invalid embedded native Quiz");
      const storedQuizContent = parsedContent?.type === "quiz" ? parsedContent as QuizContent : undefined;
      const question = checkpoint?.response as { kind?: "single" | "multiple" | "judge" | "short_answer"; options?: string[]; answerIndices?: number[] } | undefined;
      const reference = checkpoint?.referenceAnswer as { summary?: string; keyPoints?: string[] } | undefined;
      const id = scene.id + "-quiz-" + String(checkpoint?.id ?? "embedded");
      if (next.scenes.some(other => other.id === id) || scenes.some(other => other.id === id)) throw new Error("Assessment scene identity collision");
      scene.metadata = { ...scene.metadata, assessmentSceneId: id };
      scene.actions = scene.actions?.filter(action => !checkpoints.some(item => item.id === action.id));
      const content: QuizContent = storedQuizContent ?? { type: "quiz", questions: [{ id: String(checkpoint!.checkpointId), type: question!.kind!,
        question: String(checkpoint!.question), options: question!.kind === "short_answer" ? undefined : (question!.options ?? []).map((label, index) => ({
          value: question!.kind === "judge" ? index ? "F" : "T" : String.fromCharCode(65 + index), label })),
        answer: question!.kind === "short_answer" ? undefined : (question!.answerIndices ?? []).map(index => {
          const options = question!.options ?? [];
          if (!options[index]) throw new Error("Native answer references a missing option");
          return question!.kind === "judge" ? index ? "F" : "T" : String.fromCharCode(65 + index);
        }), referenceAnswer: reference?.summary, keyPoints: reference?.keyPoints }] };
      const imageAssets = new Map<string, { url: string; mimeType: string }>();
      for (const q of content.questions) for (const image of [q.image, ...(q.options ?? []).map(option => option.image)]) if (image) {
        const asset = assetPaths.get(image.src);
        if (!asset) throw new Error("Unarchived native assessment image");
        imageAssets.set(image.src, asset);
        image.src = asset.url;
        image.assetId = image.assetId ?? asset.url;
        image.mimeType = image.mimeType ?? asset.mimeType;
      }
      for (const [source, asset] of imageAssets) if (!next.mediaManifest?.some(entry => entry.src === asset.url)) {
        next.mediaManifest = [...(next.mediaManifest ?? []), { sceneId: id, elementId: source, assetId: source,
          assetType: "image", mimeType: asset.mimeType, src: asset.url, originalSrc: asset.url }];
      }
      scenes.push({ id, stageId: scene.stageId, type: "quiz", title: scene.title, order: 0, content, actions: [] });
      continue;
    }
  }
  next.scenes = scenes.map((scene, order) => ({ ...scene, order }));
  return parseMaicClassroom(next);
}
