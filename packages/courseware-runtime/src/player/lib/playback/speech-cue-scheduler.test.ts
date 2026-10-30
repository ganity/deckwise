import { afterEach, describe, expect, it, vi } from "vitest";

import { SpeechCueScheduler } from "./speech-cue-scheduler";
import type { ElementAnimationAction } from "../types/action";

describe("SpeechCueScheduler", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("fires once when audio time crosses the provider cue", () => {
    let frame: FrameRequestCallback | undefined;
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      frame = callback;
      return 1;
    });
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
    let time = 0;
    const cue = {
      id: "cue-1",
      type: "element_animation",
      elementId: "apple",
      effect: "zoomIn",
      animationType: "in",
      duration: 700,
      pptistTrigger: "auto",
      speechCue: {
        version: 1,
        speechActionId: "speech-1",
        timingTrackId: "audio-1",
        anchorText: "apple",
        occurrence: 1,
        targetElementId: "apple",
        motionIntent: "scale_in",
        atMs: 500,
      },
    } satisfies ElementAnimationAction;
    const onCue = vi.fn();
    const scheduler = new SpeechCueScheduler([cue], () => time, onCue);

    scheduler.start();
    time = 600;
    frame?.(600);
    time = 900;
    frame?.(900);

    expect(onCue).toHaveBeenCalledTimes(1);
    expect(onCue).toHaveBeenCalledWith(cue);
  });

  it("rebuilds reveal state when playback starts or seeks after a cue", () => {
    vi.stubGlobal(
      "requestAnimationFrame",
      vi.fn(() => 1),
    );
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
    let time = 900;
    const reveal = {
      id: "cue-reveal",
      type: "element_animation",
      elementId: "apple",
      effect: "zoomIn",
      animationType: "in",
      duration: 700,
      pptistTrigger: "auto",
      speechCue: {
        version: 1,
        speechActionId: "speech-1",
        timingTrackId: "audio-1",
        anchorText: "apple",
        occurrence: 1,
        targetElementId: "apple",
        motionIntent: "scale_in",
        atMs: 500,
      },
    } satisfies ElementAnimationAction;
    const onReconcile = vi.fn();
    const scheduler = new SpeechCueScheduler(
      [reveal],
      () => time,
      vi.fn(),
      onReconcile,
    );

    scheduler.start();
    time = 100;
    scheduler.seek();

    expect(onReconcile).toHaveBeenNthCalledWith(1, [reveal], [reveal]);
    expect(onReconcile).toHaveBeenNthCalledWith(2, [], [reveal]);
  });

  it("keeps completed entrance text visible when the next speech only has attention cues", () => {
    vi.stubGlobal(
      "requestAnimationFrame",
      vi.fn(() => 1),
    );
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
    const entrance = {
      id: "entrance",
      type: "element_animation",
      elementId: "hello",
      effect: "zoomIn",
      animationType: "in",
      duration: 700,
      pptistTrigger: "auto",
      speechCue: {
        version: 1,
        speechActionId: "speech-1",
        timingTrackId: "audio-1",
        anchorText: "Hello",
        occurrence: 1,
        targetElementId: "hello",
        motionIntent: "scale_in",
        atMs: 500,
      },
    } satisfies ElementAnimationAction;
    const attention = {
      ...entrance,
      id: "attention",
      effect: "pulse",
      animationType: "attention",
      speechCue: {
        ...entrance.speechCue,
        speechActionId: "speech-2",
        timingTrackId: "audio-2",
      },
    } satisfies ElementAnimationAction;
    const sceneActions = [entrance, attention];
    let visible = false;
    const reconcile = (
      completed: ElementAnimationAction[],
      scope: ElementAnimationAction[] = sceneActions,
    ) => {
      for (const action of scope) {
        if (action.animationType === "in") visible = false;
      }
      for (const action of completed) {
        if (action.animationType === "in") visible = true;
      }
    };

    new SpeechCueScheduler([entrance], () => 900, vi.fn(), reconcile).start();
    expect(visible).toBe(true);

    new SpeechCueScheduler([attention], () => 0, vi.fn(), reconcile).start();
    expect(visible).toBe(true);
  });
});

it("samples native time on the existing frame, paused seek and resume without another clock", () => {
  let frame: FrameRequestCallback | undefined;
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    frame = callback;
    return 1;
  });
  const cancel = vi.fn();
  vi.stubGlobal("cancelAnimationFrame", cancel);
  let time = 0;
  const sample = vi.fn();
  const scheduler = new SpeechCueScheduler(
    [],
    () => time,
    vi.fn(),
    undefined,
    sample,
  );
  scheduler.start();
  expect(sample).toHaveBeenLastCalledWith(0);
  time = 800;
  frame?.(800);
  expect(sample).toHaveBeenLastCalledWith(800);
  time = 810;
  scheduler.pause();
  expect(cancel).toHaveBeenCalled();
  time = 100;
  scheduler.seek();
  expect(sample).toHaveBeenLastCalledWith(100);
  scheduler.resume();
  time = 160;
  frame?.(160);
  expect(sample).toHaveBeenLastCalledWith(160);
  scheduler.stop();
  vi.unstubAllGlobals();
});


it("plays a segment-start pulse on every speech instead of consuming it during reconciliation", () => {
  let frame: FrameRequestCallback | undefined;
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => { frame = callback; return 1; });
  vi.stubGlobal("cancelAnimationFrame", vi.fn());
  let time = 0;
  const onCue = vi.fn();
  for (const speechActionId of ["first", "again"]) {
    const cue: ElementAnimationAction = { id: speechActionId + "-pulse", type: "element_animation", elementId: "monkey", effect: "pulse", animationType: "attention", duration: 600,
      speechCue: { version: 1, speechActionId, timingTrackId: "audio", anchorText: "小猴", occurrence: 1, targetElementId: "monkey", motionIntent: "pulse", atMs: 0 } };
    time = 0;
    const scheduler = new SpeechCueScheduler([cue], () => time, onCue);
    scheduler.start();
    frame?.(0);
    time = 100;
    frame?.(100);
    scheduler.stop();
  }
  expect(onCue.mock.calls.map(call => call[0].id)).toEqual(["first-pulse", "again-pulse"]);
  vi.unstubAllGlobals();
});
