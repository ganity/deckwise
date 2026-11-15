import type { Action, ElementAnimationAction } from "../types/action";

export type ManualPptxRotationAction = ElementAnimationAction & {
  effect: "pptxRotation";
  pptxTimeline?: undefined;
  pptistTrigger: "click" | "meantime";
};

export function isManualPptxRotation(
  action: Action,
): action is ManualPptxRotationAction {
  return (
    action.type === "element_animation" &&
    action.effect === "pptxRotation" &&
    !action.pptxTimeline &&
    action.pptistTrigger !== "auto"
  );
}

export function getElementAnimationPresentation(
  action: ElementAnimationAction,
) {
  return {
    classNames: ["animate__animated", `animate__${action.effect}`],
    durationMs: Number.isFinite(action.duration)
      ? Math.max(0, action.duration)
      : 0,
    hideBefore: action.animationType === "in",
    hideAfter: action.animationType === "out",
    ...(action.effect === "pptxMotion" && action.animationType === "attention"
      ? { holdMotionOrigin: true }
      : {}),
    ...(action.motion ? { motion: action.motion } : {}),
    ...(action.rotation ? { rotation: action.rotation } : {}),
  };
}
