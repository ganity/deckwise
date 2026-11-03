import type { CoursewareScenePlanPage, CoursewareScenePlanSnapshot } from "@pi-desktop/shared";
import type { NarrationComplete } from "./courseware-candidates";
import { MAIC_VISUAL_MASTER_SYSTEM, MAIC_EXTRACTION, MAIC_BACKGROUND } from "./courseware-visual-master-prompts";

export type VisualMasterPlanningInput = {
  sessionId: string;
  plan: Pick<CoursewareScenePlanSnapshot, "title" | "visualBible">;
  page: CoursewareScenePlanPage;
  instructions: string;
  courseStyleReferenceSupplied: boolean;
  signal: AbortSignal;
};
export type VisualMasterPlanner = (input: VisualMasterPlanningInput) => Promise<string>;
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const ORIGINAL_CHARACTERS = "Original character design: use distinct silhouettes, proportions, faces and color/outfit combinations, not recognizable commercial mascots or their signature feature combinations. Preserve required names, species, count, explicit user appearance requirements and approved identities, applying requested corrections consistently across pages. For unspecified traits, describe concrete original features without franchise references.";

/** MAIC prompt-only art direction; the approved page keeps authoritative text and subjects. */
export async function planSceneVisualMaster(input: VisualMasterPlanningInput,
  model: { modelKey: string; thinkingLevel?: string }, complete: NarrationComplete): Promise<string> {
  const { page, plan, signal } = input;
  const suffix = `\n${MAIC_EXTRACTION}\n${MAIC_BACKGROUND}\n${ORIGINAL_CHARACTERS}${input.courseStyleReferenceSupplied ? "\nCourse consistency: use the supplied accepted course-style reference for palette, linework, lighting, material treatment, typography style, and recurring character identity only. Do not copy its page-specific objects, words, layout, or location; the authoritative story location takes priority." : ""}`;
  const data = {
    canvas: "16:10 / 1280x800",
    slide: { title: page.title, description: page.visualIntent, keyPoints: page.visibleText, pageRole: page.teaching?.phase },
    visualGoal: page.teaching?.objective,
    visualBible: plan.visualBible,
    sceneContinuity: page.visualIntent,
    additionalRequirements: input.instructions,
    displayTextSuggestions: page.visibleText,
    mustPreserveDisplayText: page.visibleText,
    mandatoryTeachingObjects: (page.teaching?.requiredObjects ?? []).map((semanticRole, i) => ({ id: `object-${i + 1}`, semanticRole, spokenAliases: [] })),
    optionalActionContexts: [],
    courseStyleReferenceSupplied: input.courseStyleReferenceSupplied,
  };
  const system = `${MAIC_VISUAL_MASTER_SYSTEM}\n${ORIGINAL_CHARACTERS}\nStrict output requirement: return one valid JSON object only, with no markdown or commentary. Copy every required display text exactly into selectedDisplayText and into prompt. The approved page text is authoritative; do not add or paraphrase text. Follow the supplied art direction and character identities. Do not copy teacher narration into the image. Keep prompt within ${4000 - suffix.length} UTF-16 units for the existing media transport. Render one complete 1280x800, 16:10 teaching slide.`;
  let failure: unknown;
  for (let attempt = 0; attempt < 2; attempt++) {
    signal.throwIfAborted();
    const result = await complete({ ...model, thinkingLevel: "off", maxOutputTokens: 3000, sessionId: input.sessionId, signal, system,
      messages: [{ role: "user", content: JSON.stringify(data) }, ...(attempt ? [{ role: "user" as const,
        content: "Correction: the previous response failed validation. Return only strict JSON. Copy every required text exactly into selectedDisplayText and into prompt; do not omit or paraphrase any required token. Respect the prompt length limit." }] : [])] });
    signal.throwIfAborted();
    try {
      if (typeof result.text !== "string" || result.text.length > 65_536) throw new Error("Visual-master plan exceeds response limits");
      const value: unknown = JSON.parse(result.text);
      const selected = record(value) ? value.selectedDisplayText : undefined;
      if (!record(value) || typeof value.prompt !== "string" || !value.prompt.trim() ||
          !Array.isArray(selected) || selected.some(t => typeof t !== "string" || !page.visibleText.includes(t)) ||
          page.visibleText.some(t => !selected.includes(t)) ||
          !Array.isArray(value.selectedOptionalObjectIds) || value.selectedOptionalObjectIds.length)
        throw new Error("Invalid visual-master plan text or objects");
      let prompt = value.prompt.trim();
      const missing = page.visibleText.filter(text => !prompt.includes(text));
      if (missing.length) prompt += `\nRender these exact readable strings verbatim, each exactly once: ${missing.map(text => JSON.stringify(text)).join(", ")}.`;
      prompt += suffix;
      if (prompt.length > 4000 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u.test(prompt))
        throw new Error("Visual-master prompt exceeds transport limits");
      return prompt;
    } catch (error) { failure = error; }
  }
  throw failure;
}
