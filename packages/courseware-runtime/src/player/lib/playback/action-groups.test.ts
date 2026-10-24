import { describe, expect, it } from "vitest";
import { buildActionExecutionGroups } from "./action-groups";
import type { Action, ElementAnimationAction } from "../types/action";

const animation = (
  id: string,
  trigger: "click" | "auto" | "meantime",
): ElementAnimationAction => ({
  id,
  type: "element_animation",
  elementId: "el",
  effect: "fadeIn",
  animationType: "in",
  duration: 100,
  pptistTrigger: trigger,
});

describe("buildActionExecutionGroups", () => {
  it("groups each anchor with contiguous meantime animations", () => {
    const groups = buildActionExecutionGroups([
      animation("one", "click"),
      animation("two", "meantime"),
      animation("three", "meantime"),
      animation("four", "auto"),
    ]);
    expect(
      groups.map((group) => group.actions.map((action) => action.id)),
    ).toEqual([["one", "two", "three"], ["four"]]);
  });

  it("keeps a leading meantime animation as its own automatic group", () => {
    const groups = buildActionExecutionGroups([
      animation("orphan", "meantime"),
      animation("next", "click"),
    ]);
    expect(groups.map((group) => group.anchor.id)).toEqual(["orphan", "next"]);
  });

  it("groups contiguous valid timeline animations by step ID", () => {
    const groups = buildActionExecutionGroups([
      {
        ...animation("one", "click"),
        pptxTimeline: { version: 1, stepId: "step_1" },
      },
      {
        ...animation("two", "meantime"),
        startAtMs: 120,
        pptxTimeline: { version: 1, stepId: "step_1" },
      },
      {
        ...animation("three", "click"),
        pptxTimeline: { version: 1, stepId: "step_2" },
      },
    ]);

    expect(
      groups.map((group) => group.actions.map((action) => action.id)),
    ).toEqual([["one", "two"], ["three"]]);
  });

  it("groups every contiguous action in one PPTX timeline step", () => {
    const timeline = { version: 1 as const, stepId: "step_1" };
    const groups = buildActionExecutionGroups([
      { ...animation("visual", "click"), pptxTimeline: timeline },
      {
        id: "media",
        type: "play_audio",
        elementId: "audio",
        pptxTimeline: timeline,
      },
      {
        id: "speech",
        type: "speech",
        text: "讲解",
        pptxTimeline: { ...timeline, phase: "after" },
      },
    ]);

    expect(
      groups.map((group) => group.actions.map((action) => action.id)),
    ).toEqual([["visual", "media", "speech"]]);
  });
});
