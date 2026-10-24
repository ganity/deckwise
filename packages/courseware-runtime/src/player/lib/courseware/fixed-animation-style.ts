import type { FixedVisualCue } from "./load-fixed-build";
import { getElementAnimationPresentation } from "../playback/element-animation";

/** One bounded player cue per static object; sampled from narration, never an animation clock. */
export function fixedAnimationStyle(cue: FixedVisualCue, timeMs: number) {
  if (cue.effect.kind !== "element_animation")
    return { opacity: 1, scale: 1, hidden: false };
  const action = cue.effect.action;
  const presentation = getElementAnimationPresentation(action);
  const position = Math.max(
    0,
    Math.min(1, (timeMs - cue.atMs) / presentation.durationMs),
  );
  return {
    opacity:
      action.effect === "fadeIn"
        ? position
        : action.effect === "fadeOut"
          ? 1 - position
          : 1,
    scale:
      action.effect === "pulse" ? 1 + 0.1 * Math.sin(Math.PI * position) : 1,
    hidden:
      (presentation.hideBefore && timeMs < cue.atMs) ||
      (presentation.hideAfter && timeMs >= cue.endMs),
  };
}
