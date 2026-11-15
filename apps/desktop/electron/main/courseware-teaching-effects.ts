import { isCoursewareAttentionCue, isCoursewareAttentionIntent, type CoursewareTeachingView, type CoursewarePptxCandidateReview, type CoursewareSourceReview } from "@pi-desktop/shared";

export function sourceEffectTargets(review: Pick<CoursewareSourceReview, "project" | "pageCount" | "effectTargets" | "targetPages">, pageIds?: string[]): Set<string> {
  const expected = new Set<string>();
  for (const page of review.project.pages.filter(page => !pageIds || pageIds.includes(page.pageId))) for (const action of page.actions) {
    if (action.attention !== undefined) {
      if (action.type !== "speech" || !isCoursewareAttentionIntent(action.attention)) throw new Error("Unsupported speech attention");
      for (const objectId of action.attention.objectIds) expected.add(JSON.stringify([page.pageId, objectId]));
    }
    if (action.visualCues === undefined) continue;
    if (action.type !== "speech" || !Array.isArray(action.visualCues) || action.visualCues.length > 200)
      throw new Error("Unsupported source-review effect cues");
    for (const cue of action.visualCues) {
      if (!isCoursewareAttentionCue(cue)) throw new Error("Unsupported source-review effect cue");
      const targets = cue.effect.type === "highlight" ? cue.effect.elementIds : [cue.effect.elementId, ...(cue.effect.elementIds ?? [])];
      for (const objectId of targets) expected.add(JSON.stringify([page.pageId, objectId]));
    }
  }
  if (!expected.size && review.effectTargets === undefined && review.targetPages === undefined) return expected;
  if (!Array.isArray(review.targetPages) || review.targetPages.length !== review.pageCount ||
      !review.targetPages.every(page => page && Array.isArray(page.objects) && page.objects.length <= 10000 &&
        page.objects.every((object, index) => object && object.index === index + 1 && typeof object.kind === "string" && object.kind.length > 0 && object.kind.length <= 200)) ||
      !Array.isArray(review.effectTargets) || review.effectTargets.length !== expected.size)
    throw new Error("Invalid source-review saved objects");
  const seen = new Set<string>();
  for (const target of review.effectTargets) {
    const key = JSON.stringify([target?.pageId, target?.objectId]);
    if (!target || !expected.has(key) || seen.has(key) || !["text", "shape", "image"].includes(target.kind) ||
        !Number.isInteger(target.index) || target.index < 1 || target.index > 10000)
      throw new Error("Invalid previous source-review effect target");
    seen.add(key);
  }
  return expected;
}

export function validateEffectBindings(expected: Set<string>, pages: CoursewareSourceReview["targetPages"], pageIds: Array<string | null>, input: unknown) {
  if (!Array.isArray(input) || input.length !== expected.size) throw new Error("Every effect target requires explicit association");
  const used = new Set<string>(), seen = new Set<string>();
  for (const value of input) {
    if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length !== 3 ||
        !["pageIndex", "objectId", "targetIndex"].every(key => Object.hasOwn(value, key))) throw new Error("Invalid effect associations");
    const { pageIndex, objectId, targetIndex } = value;
    if (!Number.isInteger(pageIndex) || pageIndex < 0 || pageIndex >= pageIds.length || pageIds[pageIndex] === null ||
        !Number.isInteger(targetIndex) || targetIndex < 1 || typeof objectId !== "string") throw new Error("Invalid effect association indexes");
    const key = JSON.stringify([pageIds[pageIndex], objectId]), current = JSON.stringify([pageIndex, targetIndex]);
    const destination = pages?.[pageIndex]?.objects[targetIndex - 1];
    if (!expected.has(key) || seen.has(key) || used.has(current) || !destination || !["text", "shape", "image"].includes(destination.kind))
      throw new Error("Stale, unsupported, duplicate or cross-page effect association");
    seen.add(key); used.add(current);
  }
  return structuredClone(input);
}

export function candidateEffects(project: CoursewareTeachingView["project"], candidate: Record<string, unknown>): Pick<CoursewarePptxCandidateReview, "effectTargets" | "effectPages" | "effectCues"> {
  const scope = candidate.kind === "page-fade" ? [] : candidate.targetPageIds as string[];
  const review = { project, pageCount: project.pages.length, effectTargets: candidate.effectTargets as CoursewareSourceReview["effectTargets"],
    targetPages: candidate.effectPages as CoursewareSourceReview["targetPages"] };
  const expected = sourceEffectTargets(review, scope);
  if (!expected.size) return {};
  const effectCues: NonNullable<CoursewarePptxCandidateReview["effectCues"]> = [];
  for (const [index, page] of project.pages.entries()) if (scope.includes(page.pageId)) for (const action of page.actions)
    if (Array.isArray(action.visualCues)) for (const cue of action.visualCues) if (isCoursewareAttentionCue(cue))
      effectCues.push({ pageNumber: index + 1, effect: cue.effect.type === "element_animation" ? cue.effect.effect : cue.effect.type, atMs: cue.atMs, endMs: cue.endMs });
  return { effectTargets: review.effectTargets!.map(target => ({ ...target, pageIndex: project.pages.findIndex(page => page.pageId === target.pageId) })),
    effectPages: structuredClone(review.targetPages), effectCues };
}

export function changedTeachingEffects(page: CoursewareTeachingView["project"]["pages"][number], actions: Array<Record<string, unknown>>) {
  return actions.filter(action => {
    const old = page.actions.find(entry => entry.id === action.id);
    // Removing saved semantic bindings needs no audio; adding or changing one still does.
    const next = action.visualCues === undefined ? [] : action.visualCues;
    const previous = old?.visualCues;
    const removedOnly = !page.locked && action.text === old?.text && action.audioAssetId === old?.audioAssetId &&
      Array.isArray(next) && Array.isArray(previous) && next.every(cue => previous.some(saved => JSON.stringify(saved) === JSON.stringify(cue))) &&
      previous.every(saved => next.some(cue => JSON.stringify(cue) === JSON.stringify(saved)) || isCoursewareAttentionCue(saved) && !!saved.trigger);
    return !removedOnly && action.type === "speech" && JSON.stringify(action.visualCues) !== JSON.stringify(old?.visualCues) &&
      !((action.text !== old?.text || action.audioAssetId !== old?.audioAssetId) &&
        (action.visualCues === undefined || Array.isArray(action.visualCues) && action.visualCues.every(cue =>
          isCoursewareAttentionCue(cue) && cue.trigger && (cue.trigger.kind !== "text" || cue.trigger.stale === true) &&
          Array.isArray(old?.visualCues) && old.visualCues.some(saved => isCoursewareAttentionCue(saved) && saved.id === cue.id &&
            JSON.stringify(saved.effect) === JSON.stringify(cue.effect) && saved.nativeAnimation === cue.nativeAnimation))));
  });
}
