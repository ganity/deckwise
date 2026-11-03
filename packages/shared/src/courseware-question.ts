/** Teacher-led response formats; answer keys never imply an observed student response. */
export type CoursewareQuestionResponse = {
  kind: "single" | "multiple" | "judge" | "short_answer" | "discussion" | "practice" | "pbl";
  options: string[];
  answerIndices: number[];
};
export function coursewareQuestionResponseIssues(value: unknown, path: string): string[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [path + ": expected an object"];
  const v = value as Record<string, unknown>;
  const issues: string[] = [];
  if (Object.keys(v).sort().join(",") !== "answerIndices,kind,options")
    issues.push(path + ": expected exactly kind, options and answerIndices");
  const kind = String(v.kind);
  const knownKind = ["single", "multiple", "judge", "short_answer", "discussion", "practice", "pbl"].includes(kind);
  if (!knownKind) issues.push(path + ".kind: expected single|multiple|judge|short_answer|discussion|practice|pbl");
  const options = Array.isArray(v.options) ? v.options : null;
  if (!options) issues.push(path + ".options: expected an array");
  else {
    if (options.length > 8) issues.push(path + ".options: expected at most 8 choices");
    options.forEach((option, index) => {
      if (typeof option !== "string" || !option.trim() || option.length > 500)
        issues.push(path + ".options[" + index + "]: expected nonempty text of at most 500 characters");
    });
    if (new Set(options).size !== options.length) issues.push(path + ".options: choices must be unique");
  }
  const indices = Array.isArray(v.answerIndices) ? v.answerIndices : null;
  if (!indices) issues.push(path + ".answerIndices: expected an array");
  else {
    if (new Set(indices).size !== indices.length) issues.push(path + ".answerIndices: indices must be unique");
    indices.forEach((index, position) => {
      if (!Number.isInteger(index) || index < 0 || options && index >= options.length)
        issues.push(path + ".answerIndices[" + position + "]: expected a zero-based index into options");
    });
  }
  if (knownKind && options && indices) {
    if (kind === "single" || kind === "judge") {
      if (options.length < 2 || kind === "judge" && options.length !== 2)
        issues.push(path + ".options: single needs at least 2 choices; judge needs exactly 2");
      if (indices.length !== 1) issues.push(path + ".answerIndices: expected exactly one correct index");
    } else if (kind === "multiple") {
      if (options.length < 2) issues.push(path + ".options: multiple needs at least 2 choices");
      if (indices.length < 1) issues.push(path + ".answerIndices: multiple needs at least one correct index");
    } else {
      if (options.length) issues.push(path + ".options: non-objective questions require an empty array");
      if (indices.length) issues.push(path + ".answerIndices: non-objective questions require an empty array");
    }
  }
  return issues;
}
export function isCoursewareQuestionResponse(value: unknown): value is CoursewareQuestionResponse {
  return coursewareQuestionResponseIssues(value, "response").length === 0;
}
