import type { Action, ElementAnimationAction } from "../types/action";

export type PptxTimelineValidation =
  | { status: "valid" }
  | { status: "unsupported" }
  | { status: "invalid"; reason: string };

/** Repair stale generated page-entry triggers after earlier entry elements were removed. */
export function normalizeGeneratedEntryTimelineActions(
  actions: readonly Action[],
): Action[] {
  const generatedEntrySteps = new Set(
    actions.flatMap((action) => {
      const stepId = action.pptxTimeline?.stepId;
      return action.type === "element_animation" &&
        action.pptistAnimationId?.startsWith("kindergarten_entry_") &&
        stepId?.startsWith("generated_entry_")
        ? [stepId]
        : [];
    }),
  );
  const animationCounts = new Map<string, number>();
  return actions.map((action) => {
    const stepId = action.pptxTimeline?.stepId;
    if (!stepId || !generatedEntrySteps.has(stepId)) return action;
    if (action.type !== "element_animation") return action;
    const index = animationCounts.get(stepId) ?? 0;
    animationCounts.set(stepId, index + 1);
    if (!action.pptistAnimationId?.startsWith("kindergarten_entry_")) {
      return action;
    }
    const pptistTrigger = index === 0 ? "auto" : "meantime";
    return action.pptistTrigger === pptistTrigger
      ? action
      : { ...action, pptistTrigger };
  });
}

export function validatePptxTimeline(
  actions: readonly Action[],
  existingElementIds?: ReadonlySet<string>,
): PptxTimelineValidation {
  const timelineActions = actions.filter((action) => action.pptxTimeline);
  if (timelineActions.length === 0) return { status: "valid" };
  if (timelineActions.some((action) => action.pptxTimeline?.version !== 1)) {
    return { status: "unsupported" };
  }

  const closedSteps = new Set<string>();
  let currentStep: string | undefined;
  const phases = new Map<string, number>();
  const animationCounts = new Map<string, number>();
  const intervals = new Map<string, Array<[number, number]>>();
  const mediaSteps = new Set<string>();
  const concurrentSpeechSteps = new Set<string>();
  const animationIds = new Map<string, string[]>();
  for (const action of timelineActions) {
    if (action.type !== "element_animation" || !action.pptistAnimationId) {
      continue;
    }
    const stepId = action.pptxTimeline?.stepId ?? "";
    const ids = animationIds.get(stepId) ?? [];
    ids.push(action.pptistAnimationId);
    animationIds.set(stepId, ids);
  }
  const claimedAnimationIds = new Map<string, Set<string>>();
  const lastBoundAnimationIndex = new Map<string, number>();
  const boundSpeechSteps = new Set<string>();
  for (const action of timelineActions) {
    if (!isSupportedTimelineAction(action)) {
      return invalid("unsupported timeline action");
    }
    if (existingElementIds && hasMissingTarget(action, existingElementIds)) {
      return invalid("missing action target");
    }
    const stepId = action.pptxTimeline?.stepId;
    if (!stepId?.trim()) return invalid("missing step id");
    if (stepId !== currentStep) {
      if (currentStep) closedSteps.add(currentStep);
      if (closedSteps.has(stepId)) return invalid("non-contiguous step");
      currentStep = stepId;
    }
    let phase: number;
    if (action.type === "speech") {
      const speechPhase = action.pptxTimeline?.phase;
      if (!speechPhase) return invalid("missing speech phase");
      if (!["before", "with", "after"].includes(speechPhase)) {
        return invalid("invalid speech phase");
      }
      phase = speechPhase === "before" ? 0 : speechPhase === "with" ? 3 : 4;
      if (speechPhase === "with") concurrentSpeechSteps.add(stepId);
      const boundIds = action.pptxTimeline?.animationIds;
      if (boundIds !== undefined) {
        const stepAnimationIds = animationIds.get(stepId) ?? [];
        const indexes = boundIds.map((id) => stepAnimationIds.indexOf(id));
        const claimed = claimedAnimationIds.get(stepId) ?? new Set<string>();
        if (
          boundIds.length === 0 ||
          new Set(boundIds).size !== boundIds.length ||
          indexes.some((index) => index < 0) ||
          indexes.some((index, position) =>
            position === 0 ? false : index !== indexes[position - 1] + 1,
          ) ||
          indexes[0] <= (lastBoundAnimationIndex.get(stepId) ?? -1) ||
          boundIds.some((id) => claimed.has(id))
        ) {
          return invalid("invalid narration animation binding");
        }
        boundIds.forEach((id) => claimed.add(id));
        claimedAnimationIds.set(stepId, claimed);
        lastBoundAnimationIndex.set(stepId, indexes.at(-1) ?? -1);
        boundSpeechSteps.add(stepId);
      }
    } else {
      if (
        action.pptxTimeline?.phase !== undefined ||
        action.pptxTimeline?.animationIds !== undefined
      ) {
        return invalid("unexpected action phase");
      }
      phase = action.type === "element_animation" ? 1 : 2;
      if (action.type !== "element_animation") mediaSteps.add(stepId);
    }
    if (phase < (phases.get(stepId) ?? 0))
      return invalid("invalid action order");
    phases.set(stepId, phase);
    if (action.type === "element_animation") {
      const animationIndex = animationCounts.get(stepId) ?? 0;
      if (
        (animationIndex === 0 && action.pptistTrigger === "meantime") ||
        (animationIndex > 0 && action.pptistTrigger !== "meantime")
      ) {
        return invalid("invalid animation trigger");
      }
      animationCounts.set(stepId, animationIndex + 1);
      const result = validateAnimation(action, stepId, intervals);
      if (result) return result;
    }
  }
  if ([...concurrentSpeechSteps].some((stepId) => mediaSteps.has(stepId))) {
    return invalid("speech overlaps media");
  }
  if ([...boundSpeechSteps].some((stepId) => mediaSteps.has(stepId))) {
    return invalid("narration animation binding overlaps media");
  }
  return { status: "valid" };
}

function validateAnimation(
  action: ElementAnimationAction,
  stepId: string,
  intervals: Map<string, Array<[number, number]>>,
): PptxTimelineValidation | undefined {
  const start = action.startAtMs ?? 0;
  if (
    !Number.isFinite(start) ||
    start < 0 ||
    !Number.isFinite(action.duration) ||
    action.duration < 0
  ) {
    return invalid("invalid animation time");
  }
  if (
    start > 30_000 ||
    action.duration > 30_000 ||
    start + action.duration > 60_000
  ) {
    return invalid("animation time exceeds limit");
  }
  if (
    action.paragraphIndexes &&
    (new Set(action.paragraphIndexes).size !== action.paragraphIndexes.length ||
      action.paragraphIndexes.some(
        (index) => !Number.isInteger(index) || index < 0,
      ))
  ) {
    return invalid("invalid paragraph indexes");
  }
  if (
    (["pptxMotion", "bounceInBottom"].includes(action.effect)) !== Boolean(action.motion) ||
    (action.motion &&
      (![action.motion.fromX, action.motion.fromY].every(Number.isFinite) ||
        Math.abs(action.motion.fromX) > 10_000 ||
        Math.abs(action.motion.fromY) > 10_000 ||
        (action.motion.path !== undefined &&
          (action.motion.path.length < 2 ||
            action.motion.path.length > 200 ||
            action.motion.path.some(
              (point) =>
                ![point.x, point.y].every(Number.isFinite) ||
                Math.abs(point.x) > 10_000 ||
                Math.abs(point.y) > 10_000,
            )))))
  ) {
    return invalid("invalid animation motion");
  }
  if (
    (action.effect === "pptxRotation") !== Boolean(action.rotation) ||
    Boolean(action.motion && action.rotation) ||
    (action.rotation &&
      (action.animationType !== "attention" ||
        ![action.rotation.fromDeg, action.rotation.toDeg].every(
          Number.isFinite,
        ) ||
        Math.abs(action.rotation.fromDeg) > 10_000 ||
        Math.abs(action.rotation.toDeg) > 10_000 ||
        action.rotation.fromDeg === action.rotation.toDeg))
  ) {
    return invalid("invalid animation rotation");
  }
  const target = `${stepId}:${action.elementId}:${action.paragraphIndexes?.join(",") ?? "all"}`;
  const next: [number, number] = [start, start + action.duration];
  const existing = intervals.get(target) ?? [];
  if (existing.some(([from, to]) => next[0] < to && from < next[1]))
    return invalid("overlapping animation");
  existing.push(next);
  intervals.set(target, existing);
  return undefined;
}

function isSupportedTimelineAction(action: Action): boolean {
  return (
    action.type === "element_animation" ||
    action.type === "play_audio" ||
    action.type === "play_video" ||
    action.type === "speech" ||
    (action.type === "interaction_checkpoint" &&
      action.checkpointKind === "media_playback")
  );
}

function hasMissingTarget(
  action: Action,
  existingElementIds: ReadonlySet<string>,
): boolean {
  return (
    (action.type === "element_animation" ||
      action.type === "play_audio" ||
      action.type === "play_video" ||
      (action.type === "interaction_checkpoint" &&
        action.checkpointKind === "media_playback")) &&
    (!action.elementId || !existingElementIds.has(action.elementId))
  );
}

function invalid(reason: string): PptxTimelineValidation {
  return { status: "invalid", reason };
}
