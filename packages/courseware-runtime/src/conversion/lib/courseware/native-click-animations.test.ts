import { expect, it } from "vitest";
import type { SlidePageIR } from "../import/types";
import { projectNativeClicks } from "./native-click-animations";

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
