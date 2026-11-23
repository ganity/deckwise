import { describe, expect, it } from "vitest";
import { resolveCoursewareRoute } from "./courseware-route.js";

describe("courseware entry and phase routing", () => {
  it("keeps full PPT Master for ordinary generation and distinguishes scene/import", () => {
    expect(resolveCoursewareRoute("presentation", "generate")).toMatchObject({ available: true, skill: "deckwise/ppt-master" });
    expect(resolveCoursewareRoute("scene", "generate").available).toBe(false);
    expect(resolveCoursewareRoute("scene", "generate", true).available).toBe(true);
    const imported = resolveCoursewareRoute("import", "generate");
    expect(imported.skill).toBe("deckwise/ppt-import");
    expect(imported.instruction).toContain("without asking for another narration-source choice");
    expect(imported.instruction).toContain("ask before replacing conflicting existing narration");
  });
  it("uses the latest PPTX for editing all three entries", () => {
    for (const entry of ["presentation", "scene", "import"] as const) {
      expect(resolveCoursewareRoute(entry, "edit")).toMatchObject({ available: true, skill: "deckwise/ppt-edit", authority: "latest-clean-pptx-and-teaching" });
    }
    expect(resolveCoursewareRoute("presentation", "edit").instruction).toContain("Read saved teaching context for narration and media");
    expect(() => Reflect.apply(resolveCoursewareRoute, null, ["kindergarten", "generate"])).toThrow();
  });
  it("opens scene planning while keeping unimplemented asset/deck generation unavailable", () => {
    expect(resolveCoursewareRoute("scene", "plan")).toMatchObject({
      available: true, skill: "deckwise/scene-courseware", authority: "scene-generation-draft",
    });
    expect(resolveCoursewareRoute("scene", "generate").available).toBe(false);
    for (const entry of ["presentation", "import"] as const)
      expect(() => resolveCoursewareRoute(entry, "plan")).toThrow("Scene planning requires");
  });
});
