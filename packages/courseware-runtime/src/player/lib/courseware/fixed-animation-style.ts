import type { FixedVisualCue } from "./load-fixed-build";
import { getElementAnimationPresentation } from "../playback/element-animation";

/** A bounded player cue; sampled from narration, never an animation clock. */
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
      ["fadeIn", "zoomIn", "slideInLeft", "slideInRight"].includes(action.effect)
        ? position
        : action.effect === "fadeOut"
          ? 1 - position
          : 1,
    scale:
      action.effect === "pulse" ? 1 + 0.1 * Math.sin(Math.PI * position) : action.effect === "zoomIn" ? 0.6 + 0.4 * position : 1,
    translateX: action.effect === "slideInLeft" ? -24 * (1 - position) : action.effect === "slideInRight" ? 24 * (1 - position) : 0,
    rotate: action.effect === "gentleRotate" ? 6 * Math.sin(2 * Math.PI * position) : 0,
    hidden:
      (presentation.hideBefore && timeMs < cue.atMs) ||
      (presentation.hideAfter && timeMs >= cue.endMs),
  };
}


export function fixedAnimationStyles(animations: readonly { cue: FixedVisualCue; timeMs: number }[]) {
  const styles = new Map<string, ReturnType<typeof fixedAnimationStyle>>();
  for (const { cue, timeMs } of animations) {
    if (cue.effect.kind !== "element_animation") continue;
    const id = cue.effect.action.elementId;
    // Future emphasis must not overwrite an earlier entrance or the current speech's motion.
    if (!styles.has(id) || timeMs >= 0) styles.set(id, fixedAnimationStyle(cue, timeMs));
  }
  return styles;
}
