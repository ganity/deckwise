import { expect, it } from "vitest";
import type { FixedVisualCue } from "./load-fixed-build";
import { fixedAnimationStyle } from "./fixed-animation-style";
const cue = (effect: "fadeIn" | "fadeOut" | "pulse"): FixedVisualCue => ({
  id: effect,
  atMs: 1000,
  endMs: 2000,
  effect: {
    kind: "element_animation",
    action: {
      id: effect,
      type: "element_animation",
      elementId: "object",
      effect,
      animationType:
        effect === "fadeIn" ? "in" : effect === "fadeOut" ? "out" : "attention",
      duration: 1000,
      pptistTrigger: "auto",
    },
  },
});
it("rebuilds entrance and exit before, within and after fixed audio intervals", () => {
  expect(fixedAnimationStyle(cue("fadeIn"), -1)).toEqual({
    opacity: 0,
    scale: 1,
    hidden: true,
  });
  expect(fixedAnimationStyle(cue("fadeIn"), 1500)).toEqual({
    opacity: 0.5,
    scale: 1,
    hidden: false,
  });
  expect(fixedAnimationStyle(cue("fadeIn"), Infinity)).toEqual({
    opacity: 1,
    scale: 1,
    hidden: false,
  });
  expect(fixedAnimationStyle(cue("fadeOut"), -1)).toEqual({
    opacity: 1,
    scale: 1,
    hidden: false,
  });
  expect(fixedAnimationStyle(cue("fadeOut"), 1500)).toEqual({
    opacity: 0.5,
    scale: 1,
    hidden: false,
  });
  expect(fixedAnimationStyle(cue("fadeOut"), Infinity)).toEqual({
    opacity: 0,
    scale: 1,
    hidden: true,
  });
  expect(fixedAnimationStyle(cue("fadeOut"), 500)).toEqual({
    opacity: 1,
    scale: 1,
    hidden: false,
  });
});
it("samples a bounded emphasis from audio time and restores geometry after its interval", () => {
  expect(fixedAnimationStyle(cue("pulse"), -1).scale).toBe(1);
  expect(fixedAnimationStyle(cue("pulse"), 1500).scale).toBeCloseTo(1.1);
  expect(fixedAnimationStyle(cue("pulse"), 2000).scale).toBe(1);
  expect(fixedAnimationStyle(cue("pulse"), Infinity).scale).toBe(1);
});
