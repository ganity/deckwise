import { readFile } from "fs/promises";
import { describe, expect, it } from "vitest";
import type { Action } from "../types/action";
import {
  normalizeGeneratedEntryTimelineActions,
  validatePptxTimeline,
} from "./pptx-timeline";

const animation = (overrides: Partial<Action> = {}): Action =>
  ({
    id: "animation",
    type: "element_animation",
    elementId: "title",
    effect: "fadeIn",
    animationType: "in",
    duration: 300,
    pptistTrigger: "click",
    pptxTimeline: { version: 1, stepId: "step_1" },
    ...overrides,
  }) as Action;

async function readFixture() {
  return JSON.parse(
    await readFile(
      `${process.cwd()}/tests/fixtures/contracts/pptx-timeline-v1.json`,
      "utf8",
    ),
  ) as { actions: Action[]; unsupportedActions: Action[] };
}

describe("validatePptxTimeline", () => {
  it("repairs stale generated entry triggers without relaxing other timelines", () => {
    const actions = [
      animation({
        id: "kindergarten_entry_3_dog",
        pptistAnimationId: "kindergarten_entry_3_dog",
        pptistTrigger: "meantime",
        pptxTimeline: { version: 1, stepId: "generated_entry_scene_1" },
      }),
      {
        id: "speech",
        type: "speech",
        text: "Dog",
        pptxTimeline: {
          version: 1,
          stepId: "generated_entry_scene_1",
          phase: "with",
        },
      },
    ] as Action[];

    const normalized = normalizeGeneratedEntryTimelineActions(actions);
    expect(normalized[0]).toMatchObject({ pptistTrigger: "auto" });
    expect(validatePptxTimeline(normalized)).toEqual({ status: "valid" });
    expect(
      validatePptxTimeline([
        animation({
          id: "ordinary-animation",
          pptistTrigger: "meantime",
          pptxTimeline: { version: 1, stepId: "ordinary-step" },
        }),
      ]),
    ).toEqual({ status: "invalid", reason: "invalid animation trigger" });
  });

  it("accepts the shared v1 fixture and rejects its unknown-version case", async () => {
    const fixture = await readFixture();
    expect(validatePptxTimeline(fixture.actions)).toEqual({ status: "valid" });
    expect(validatePptxTimeline(fixture.unsupportedActions)).toEqual({
      status: "unsupported",
    });
  });

  it("accepts explicit before, with, and after narration phases", () => {
    expect(
      validatePptxTimeline([
        {
          id: "before",
          type: "speech",
          text: "先提示",
          pptxTimeline: { version: 1, stepId: "step_1", phase: "before" },
        },
        animation(),
        {
          id: "with",
          type: "speech",
          text: "同步讲解",
          pptxTimeline: { version: 1, stepId: "step_1", phase: "with" },
        },
        {
          id: "after",
          type: "speech",
          text: "最后总结",
          pptxTimeline: { version: 1, stepId: "step_1", phase: "after" },
        },
      ]),
    ).toEqual({ status: "valid" });
  });

  it("accepts one contiguous animation range per synchronized narration", () => {
    expect(
      validatePptxTimeline([
        animation({ pptistAnimationId: "pptx_1" }),
        animation({
          id: "animation-2",
          elementId: "body",
          startAtMs: 300,
          pptistTrigger: "meantime",
          pptistAnimationId: "pptx_2",
        }),
        {
          id: "speech",
          type: "speech",
          text: "同步两段动画",
          pptxTimeline: {
            version: 1,
            stepId: "step_1",
            phase: "with",
            animationIds: ["pptx_1", "pptx_2"],
          },
        },
      ]),
    ).toEqual({ status: "valid" });
  });

  it("rejects timeline speech without a phase", () => {
    expect(
      validatePptxTimeline([
        animation(),
        {
          id: "speech",
          type: "speech",
          text: "讲解",
          pptxTimeline: { version: 1, stepId: "step_1" },
        },
      ]),
    ).toEqual({ status: "invalid", reason: "missing speech phase" });
  });

  it("rejects narration that overlaps a media step", () => {
    expect(
      validatePptxTimeline([
        animation(),
        {
          id: "media",
          type: "play_audio",
          elementId: "audio",
          pptxTimeline: { version: 1, stepId: "step_1" },
        },
        {
          id: "speech",
          type: "speech",
          text: "不要和课件音频抢声道",
          pptxTimeline: { version: 1, stepId: "step_1", phase: "with" },
        },
      ]),
    ).toEqual({ status: "invalid", reason: "speech overlaps media" });
  });

  it("rejects a repeated step and overlapping target animation", () => {
    expect(
      validatePptxTimeline([
        animation(),
        animation({
          id: "again",
          startAtMs: 100,
          pptistTrigger: "meantime",
        }),
      ]),
    ).toEqual({ status: "invalid", reason: "overlapping animation" });
    expect(
      validatePptxTimeline([
        animation(),
        animation({
          id: "next",
          pptxTimeline: { version: 1, stepId: "step_2" },
        }),
        animation({ id: "back" }),
      ]),
    ).toEqual({ status: "invalid", reason: "non-contiguous step" });
  });

  it("keeps unknown versions out of the player", () => {
    expect(
      validatePptxTimeline([
        animation({ pptxTimeline: { version: 2, stepId: "step_1" } as never }),
      ]),
    ).toEqual({ status: "unsupported" });
  });

  it("requires one click or auto anchor followed by simultaneous animations", () => {
    expect(
      validatePptxTimeline([animation({ pptistTrigger: "meantime" })]),
    ).toEqual({ status: "invalid", reason: "invalid animation trigger" });
    expect(
      validatePptxTimeline([
        animation(),
        animation({ id: "second", pptistTrigger: "auto" }),
      ]),
    ).toEqual({ status: "invalid", reason: "invalid animation trigger" });
  });

  it("rejects unsupported step actions and unsafe timing windows", () => {
    expect(
      validatePptxTimeline([
        {
          id: "discussion",
          type: "discussion",
          topic: "讨论",
          pptxTimeline: { version: 1, stepId: "step_1" },
        },
      ]),
    ).toEqual({ status: "invalid", reason: "unsupported timeline action" });

    expect(validatePptxTimeline([animation({ startAtMs: 60_001 })])).toEqual({
      status: "invalid",
      reason: "animation time exceeds limit",
    });
    expect(
      validatePptxTimeline([
        animation({
          effect: "pptxMotion",
          motion: { fromX: Infinity, fromY: 0 },
        }),
      ]),
    ).toEqual({ status: "invalid", reason: "invalid animation motion" });
  });

  it("accepts a bounded held rotation and rejects an unsafe angle", () => {
    expect(
      validatePptxTimeline([
        animation({
          effect: "pptxRotation",
          animationType: "attention",
          rotation: { fromDeg: 0, toDeg: 1224 },
        } as Partial<Action>),
      ]),
    ).toEqual({ status: "valid" });
    expect(
      validatePptxTimeline([
        animation({
          effect: "pptxRotation",
          animationType: "attention",
          rotation: { fromDeg: 0, toDeg: Infinity },
        } as Partial<Action>),
      ]),
    ).toEqual({ status: "invalid", reason: "invalid animation rotation" });
  });

  it("rejects timeline actions whose target no longer exists", () => {
    expect(validatePptxTimeline([animation()], new Set(["body"]))).toEqual({
      status: "invalid",
      reason: "missing action target",
    });
  });
});
