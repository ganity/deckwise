/** Teacher-led response formats; answer keys never imply an observed student response. */
export type CoursewareQuestionResponse = {
  kind: "single" | "multiple" | "judge" | "short_answer" | "discussion" | "practice" | "pbl";
  options: string[];
  answerIndices: number[];
};
export function isCoursewareQuestionResponse(value: unknown): value is CoursewareQuestionResponse {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  if (Object.keys(v).sort().join(",") !== "answerIndices,kind,options" ||
      !["single", "multiple", "judge", "short_answer", "discussion", "practice", "pbl"].includes(String(v.kind)) ||
      !Array.isArray(v.options) || v.options.length > 8 || v.options.some(o => typeof o !== "string" || !o.trim() || o.length > 500) ||
      new Set(v.options).size !== v.options.length || !Array.isArray(v.answerIndices) ||
      new Set(v.answerIndices).size !== v.answerIndices.length || v.answerIndices.some(i => !Number.isInteger(i) || i < 0 || i >= (v.options as unknown[]).length)) return false;
  if (v.kind === "single" || v.kind === "judge") return v.options.length >= 2 && (v.kind !== "judge" || v.options.length === 2) && v.answerIndices.length === 1;
  if (v.kind === "multiple") return v.options.length >= 2 && v.answerIndices.length >= 1;
  return v.options.length === 0 && v.answerIndices.length === 0;
}
