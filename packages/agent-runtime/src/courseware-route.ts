export type CoursewareEntry = "presentation" | "scene" | "import";
export type CoursewarePhase = "plan" | "generate" | "edit";

/** Entry/phase policy only; education settings never choose the task or runtime format. */
export function resolveCoursewareRoute(entry: CoursewareEntry, phase: CoursewarePhase, sceneReady = false) {
  if (!["presentation", "scene", "import"].includes(entry) || !["plan", "generate", "edit"].includes(phase)) {
    throw new Error("Unknown courseware entry or phase");
  }
  if (phase === "plan") {
    if (entry !== "scene") throw new Error("Scene planning requires the scene entry");
    return {
      available: true, skill: "deckwise/scene-courseware", authority: "scene-generation-draft" as const,
      instruction: "Plan or revise only the current Chat's scene JSON draft. Separate page text, visual intent and narration. Layered asset generation and PPTX compilation are not available in this phase; do not invoke PPT Master or claim a produced deck.",
    };
  }
  if (phase === "edit") return {
    available: true, skill: "deckwise/ppt-edit", authority: "latest-clean-pptx-and-teaching" as const,
    instruction: "Read fresh Office context. Prefer advertised native tools. Unsupported edits create a candidate from the latest clean PPTX copy; never restore an older SVG over Office edits. Saving and candidate adoption require Host confirmation.",
  };
  const routes = {
    presentation: { skill: "deckwise/ppt-master", authority: "generation-candidate" as const, instruction: "Use the complete PPT Master generation workflow, including SVG intermediates, editable PPTX and page narration. SVG is a generation candidate only." },
    scene: { skill: "deckwise/scene-courseware", authority: "generation-candidate" as const, instruction: "Generate a validated editable scene candidate with resolved assets. Report unavailable if the scene generator is not installed; do not fall back to a theme-only presentation." },
    import: { skill: "deckwise/ppt-import", authority: "imported-pptx-and-teaching" as const, instruction: "Preserve the imported PPTX. Offer original notes, external narration or newly generated page narration as explicit choices; do not regenerate the deck from a topic." },
  };
  return { available: entry !== "scene" || sceneReady, ...routes[entry] };
}
