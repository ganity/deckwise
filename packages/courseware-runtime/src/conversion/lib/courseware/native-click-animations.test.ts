import { expect, it } from "vitest";
import type { SlidePageIR } from "../import/types";
import { projectNativeClicks, detachLinkedSpeechAnimations } from "./native-click-animations";

function page(): SlidePageIR {
  return { id: "page", width: 960, height: 540,
    elements: [{ id: "target", sourceShapeId: "42", type: "image", left: 10, top: 10, width: 100, height: 50 }],
    pptxAnimation: { steps: [{ id: "click-1", trigger: "click", items: [{ id: "item", target: { shapeId: "42" },
      nativePreset: { version: 1, class: "entr", id: 10 }, animationType: "in", effect: "fade", startAtMs: 0, durationMs: 500 }] }] } };
}
it("projects native entrance fade and appear in source click order without editing the IR", () => {
  const source = page(); const first = source.pptxAnimation!.steps[0];
  source.pptxAnimation!.steps.push({ id: "click-2", trigger: "click", items: [{ ...first.items[0], id: "item-2",
    effect: "appear", durationMs: 1, nativePreset: { version: 1, class: "entr", id: 1 } }] });
  const before = structuredClone(source);
  expect(projectNativeClicks(source)).toEqual({ version: 1, sequence: "before-narration", steps: [
    { id: "click-1", trigger: "click", elementId: "target", effect: "fade", durationMs: 500 },
    { id: "click-2", trigger: "click", elementId: "target", effect: "appear", durationMs: 1 },
  ] });
  expect(source).toEqual(before);
  expect(projectNativeClicks({ ...source, pptxAnimation: undefined })).toBeUndefined();
});
it.each(["auto", "preset", "no-provenance", "delayed", "paragraph", "group", "media", "duplicate-target", "duration", "parallel"])(
  "rejects the entire native projection for unsupported %s", kind => {
    const source = page(), step = source.pptxAnimation!.steps[0], item = step.items[0];
    if (kind === "auto") step.trigger = "auto";
    if (kind === "preset") item.nativePreset!.id = 16;
    if (kind === "no-provenance") delete item.nativePreset;
    if (kind === "delayed") item.startAtMs = 100;
    if (kind === "paragraph") item.target!.paragraphIndexes = [0];
    if (kind === "group") source.elements[0].sourceGroupShapeIds = ["group"];
    if (kind === "media") source.elements[0].type = "video";
    if (kind === "duplicate-target") source.elements.push({ ...source.elements[0], id: "other" });
    if (kind === "duration") item.durationMs = 5001;
    if (kind === "parallel") step.items.push({ ...item, id: "other" });
    expect(() => projectNativeClicks(source)).toThrow("NATIVE_ANIMATION_UNSUPPORTED");
  });

it("claims linked native effects once and follows native preset and duration edits", () => {
  const source = page(), before = structuredClone(source);
  const actions = [{ type: "speech", visualCues: [{ id: "linked", nativeAnimation: "logical", atMs: 200, endMs: 800,
    trigger: { version: 1, kind: "start" }, effect: { type: "element_animation", elementId: "logical", effect: "fadeOut" } }] }];
  const mapping = [{ objectId: "logical", importElementId: "target" }];
  const detached = detachLinkedSpeechAnimations(source, actions, mapping);
  expect(detached.pptxAnimation?.steps).toEqual([]);
  expect(actions[0].visualCues[0]).toMatchObject({ atMs: 200, endMs: 700, effect: { effect: "fadeIn" } });
  expect(source).toEqual(before);
  const item = source.pptxAnimation!.steps[0].items[0];
  item.nativePreset!.class = "exit"; item.durationMs = 900;
  detachLinkedSpeechAnimations(source, actions, mapping);
  expect(actions[0].visualCues[0]).toMatchObject({ endMs: 1100, effect: { effect: "fadeOut" } });
  expect(() => detachLinkedSpeechAnimations(source, [...actions, ...structuredClone(actions)], mapping)).toThrow("NATIVE_ANIMATION_LINK_STALE");
  source.pptxAnimation!.steps[0].items.push({ ...item, id: "another" });
  expect(() => detachLinkedSpeechAnimations(source, actions, mapping)).toThrow("NATIVE_ANIMATION_LINK_STALE");
});

it('gives persisted speech cues one animation owner across separate native groups and audio triggers', () => {
  const source = page(), first = source.pptxAnimation!.steps[0];
  first.items[0].nativePreset!.verifiedSpeechMotion = true;
  const second = structuredClone(first); second.id = 'click-2'; second.items[0].id = 'second';
  second.items[0].nativePreset = { version: 1, class: 'emph', id: 26, verifiedSpeechMotion: true };
  second.items[0].durationMs = 400;
  const unrelated = structuredClone(first); unrelated.id = 'click-3'; unrelated.items[0].id = 'unrelated';
  unrelated.items[0].target!.shapeId = '99';
  source.pptxAnimation!.steps.push(second, unrelated);
  const before = structuredClone(source);
  const actions = [{ type: 'speech', visualCues: [
    { atMs: 0, endMs: 500, effect: { type: 'element_animation', elementId: 'logical', effect: 'fadeIn' } },
    { atMs: 100, endMs: 500, trigger: { version: 1, kind: 'end' }, effect: { type: 'element_animation', elementId: 'logical', effect: 'pulse' } },
  ] }];
  const mapping = [{ objectId: 'logical', importElementId: 'target' }];
  expect(detachLinkedSpeechAnimations(source, actions, mapping).pptxAnimation?.steps).toEqual([unrelated]);
  expect(source).toEqual(before);
  expect(detachLinkedSpeechAnimations(source, [...actions, { type: 'native_animation', visualCues: [] }], mapping)).toBe(source);
  first.items[0].nativePreset!.verifiedSpeechMotion = false;
  expect(detachLinkedSpeechAnimations(source, actions, mapping).pptxAnimation?.steps).toEqual([first, unrelated]);
});
