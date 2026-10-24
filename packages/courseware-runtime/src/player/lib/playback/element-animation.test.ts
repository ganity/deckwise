import { describe, expect, it } from "vitest";
import { getElementAnimationPresentation } from "./element-animation";
import type { ElementAnimationAction } from "../types/action";

const action = (
  animationType: ElementAnimationAction["animationType"],
  duration: number,
): ElementAnimationAction => ({
  id: "animation-1",
  type: "element_animation",
  elementId: "element-1",
  effect: "fadeIn",
  animationType,
  duration,
  pptistTrigger: "click",
});

describe("getElementAnimationPresentation", () => {
  it("maps entrance animations to animate.css classes and initial hiding", () => {
    expect(getElementAnimationPresentation(action("in", 240))).toEqual({
      classNames: ["animate__animated", "animate__fadeIn"],
      durationMs: 240,
      hideBefore: true,
      hideAfter: false,
    });
  });

  it("normalizes invalid durations and hides after exits", () => {
    expect(getElementAnimationPresentation(action("out", -1))).toEqual({
      classNames: ["animate__animated", "animate__fadeIn"],
      durationMs: 0,
      hideBefore: false,
      hideAfter: true,
    });
  });

  it("preserves an imported motion origin for the player", () => {
    expect(
      getElementAnimationPresentation({
        ...action("in", 2000),
        effect: "pptxMotion",
        motion: { fromX: -400, fromY: 0 },
      }),
    ).toEqual({
      classNames: ["animate__animated", "animate__pptxMotion"],
      durationMs: 2000,
      hideBefore: true,
      hideAfter: false,
      motion: { fromX: -400, fromY: 0 },
    });
  });

  it("holds a visible motion at its source position and preserves its path", () => {
    const motion = {
      fromX: 400,
      fromY: -112.5,
      path: [
        { x: 400, y: -112.5 },
        { x: 200, y: -168.75 },
        { x: 0, y: 0 },
      ],
    };
    expect(
      getElementAnimationPresentation({
        ...action("attention", 2000),
        effect: "pptxMotion",
        motion,
      }),
    ).toEqual({
      classNames: ["animate__animated", "animate__pptxMotion"],
      durationMs: 2000,
      hideBefore: false,
      hideAfter: false,
      holdMotionOrigin: true,
      motion,
    });
  });

  it("preserves the original full-turn rotation for the player", () => {
    expect(
      getElementAnimationPresentation({
        ...action("attention", 2500),
        effect: "pptxRotation",
        rotation: { fromDeg: 0, toDeg: 1224 },
      }),
    ).toEqual({
      classNames: ["animate__animated", "animate__pptxRotation"],
      durationMs: 2500,
      hideBefore: false,
      hideAfter: false,
      rotation: { fromDeg: 0, toDeg: 1224 },
    });
  });
});
