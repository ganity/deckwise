import { expect, it } from "vitest";
import type { FixedVisualCue } from "./load-fixed-build";
import { fixedAnimationStyle, fixedAnimationStyles } from "./fixed-animation-style";
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
    hidden: true, translateX: 0, rotate: 0,
  });
  expect(fixedAnimationStyle(cue("fadeIn"), 1500)).toEqual({
    opacity: 0.5,
    scale: 1,
    hidden: false, translateX: 0, rotate: 0,
  });
  expect(fixedAnimationStyle(cue("fadeIn"), Infinity)).toEqual({
    opacity: 1,
    scale: 1,
    hidden: false, translateX: 0, rotate: 0,
  });
  expect(fixedAnimationStyle(cue("fadeOut"), -1)).toEqual({
    opacity: 1,
    scale: 1,
    hidden: false, translateX: 0, rotate: 0,
  });
  expect(fixedAnimationStyle(cue("fadeOut"), 1500)).toEqual({
    opacity: 0.5,
    scale: 1,
    hidden: false, translateX: 0, rotate: 0,
  });
  expect(fixedAnimationStyle(cue("fadeOut"), Infinity)).toEqual({
    opacity: 0,
    scale: 1,
    hidden: true, translateX: 0, rotate: 0,
  });
  expect(fixedAnimationStyle(cue("fadeOut"), 500)).toEqual({
    opacity: 1,
    scale: 1,
    hidden: false, translateX: 0, rotate: 0,
  });
});
it("samples a bounded emphasis from audio time and restores geometry after its interval", () => {
  expect(fixedAnimationStyle(cue("pulse"), -1).scale).toBe(1);
  expect(fixedAnimationStyle(cue("pulse"), 1500).scale).toBeCloseTo(1.1);
  expect(fixedAnimationStyle(cue("pulse"), 2000).scale).toBe(1);
  expect(fixedAnimationStyle(cue("pulse"), Infinity).scale).toBe(1);
});


it("keeps an entrance hidden until its speech, then samples each later pulse without future cues overriding it", () => {
  const entrance = cue("fadeIn"), first = { ...cue("pulse"), id: "pulse-1" }, again = { ...cue("pulse"), id: "pulse-2" };
  expect(fixedAnimationStyles([{ cue: entrance, timeMs: -1 }, { cue: first, timeMs: -1 }, { cue: again, timeMs: -1 }]).get("object")?.hidden).toBe(true);
  expect(fixedAnimationStyles([{ cue: entrance, timeMs: 1500 }, { cue: first, timeMs: -1 }, { cue: again, timeMs: -1 }]).get("object")?.opacity).toBe(.5);
  for (const times of [[Infinity, 1500, -1], [Infinity, Infinity, 1500]]) {
    const style = fixedAnimationStyles([{ cue: entrance, timeMs: times[0] }, { cue: first, timeMs: times[1] }, { cue: again, timeMs: times[2] }]).get("object");
    expect(style?.scale).toBeCloseTo(1.1);
    expect(style?.hidden).toBe(false);
  }
});

it('renders scale, directional entrances and gentle rotation on the speech clock', () => {
  const motion = (effect: string, timeMs: number) => fixedAnimationStyle({ ...cue('fadeIn'), atMs: 0, endMs: 600, effect: {
    kind: 'element_animation', action: { type: 'element_animation', id: 'motion', elementId: 'object',
      effect, duration: 600, animationType: effect === 'gentleRotate' ? 'attention' : 'in' },
  } } as FixedVisualCue, timeMs);
  expect(motion('zoomIn', -1).hidden).toBe(true);
  expect(motion('zoomIn', 300).scale).toBeCloseTo(0.8);
  expect(motion('slideInLeft', 300).translateX).toBeCloseTo(-12);
  expect(motion('slideInRight', 300).translateX).toBeCloseTo(12);
  expect(motion('gentleRotate', 150).rotate).toBeCloseTo(6);
  expect(motion('gentleRotate', 600).rotate).toBeCloseTo(0);
});

it("does not apply a future exit over an entrance within the same narration", () => {
  const entrance = { ...cue("fadeIn"), atMs: 0, endMs: 1000 };
  const exit = { ...cue("fadeOut"), atMs: 2000, endMs: 3000 };
  const at = (timeMs: number) => fixedAnimationStyles([{ cue: entrance, timeMs }, { cue: exit, timeMs }]).get("object");
  expect(at(-1)?.hidden).toBe(true);
  expect(at(500)?.opacity).toBe(.5);
  expect(at(1500)?.opacity).toBe(1);
  expect(at(2500)?.opacity).toBe(.5);
  expect(at(3000)?.hidden).toBe(true);
});
