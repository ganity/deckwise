import { coursewareQuestionResponseIssues, isCoursewareQuestionResponse, type CoursewareQuestionResponse } from "./courseware-question.js";

export type CoursewareSceneTeaching = {
  pageType: "slide" | "quiz" | "interactive" | "pbl";
  phase: "opening" | "explore" | "practice" | "review";
  objective: string;
  durationSeconds: number;
  requiredObjects: string[];
  question?: { text: string; response: CoursewareQuestionResponse };
  music?: { purpose: string; prompt: string };
  video?: { purpose: string; prompt: string };
};
export function coursewareSceneTeachingIssues(value: unknown, path: string): string[] {
  const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
  const text = (v: unknown, max: number) => typeof v === "string" && !!v.trim() && v.length <= max;
  if (!record(value)) return [path + ": expected an object"];
  const issues: string[] = [];
  for (const key of ["pageType", "phase", "objective", "durationSeconds", "requiredObjects"])
    if (!Object.hasOwn(value, key)) issues.push(path + "." + key + ": required");
  const allowed = ["pageType", "phase", "objective", "durationSeconds", "requiredObjects", "question", "music", "video"];
  const extras = Object.keys(value).filter(key => !allowed.includes(key));
  if (extras.length) issues.push(path + ": unexpected fields " + extras.join(", "));
  if (!["slide", "quiz", "interactive", "pbl"].includes(String(value.pageType)))
    issues.push(path + ".pageType: received " + JSON.stringify(value.pageType) + "; expected slide|quiz|interactive|pbl");
  if (!["opening", "explore", "practice", "review"].includes(String(value.phase)))
    issues.push(path + ".phase: received " + JSON.stringify(value.phase) + "; expected opening|explore|practice|review");
  if (!text(value.objective, 1000)) issues.push(path + ".objective: expected nonempty text of at most 1000 characters");
  if (!Number.isInteger(value.durationSeconds) || Number(value.durationSeconds) < 5 || Number(value.durationSeconds) > 1800)
    issues.push(path + ".durationSeconds: expected an integer from 5 to 1800");
  if (!Array.isArray(value.requiredObjects)) issues.push(path + ".requiredObjects: expected an array");
  else {
    if (value.requiredObjects.length > 30) issues.push(path + ".requiredObjects: expected at most 30 objects");
    value.requiredObjects.forEach((object, index) => {
      if (!text(object, 200)) issues.push(path + ".requiredObjects[" + index + "]: expected nonempty text of at most 200 characters");
    });
    if (new Set(value.requiredObjects).size !== value.requiredObjects.length)
      issues.push(path + ".requiredObjects: names must be unique");
  }
  if (Object.hasOwn(value, "question")) {
    if (!record(value.question)) issues.push(path + ".question: expected an object");
    else {
      if (Object.keys(value.question).sort().join(",") !== "response,text")
        issues.push(path + ".question: expected exactly text and response");
      if (!text(value.question.text, 160)) issues.push(path + ".question.text: expected nonempty text of at most 160 characters");
      issues.push(...coursewareQuestionResponseIssues(value.question.response, path + ".question.response"));
    }
  } else if (value.pageType !== "slide") issues.push(path + ".question: required for every non-slide pageType");
  for (const kind of ["music", "video"] as const) {
    if (!Object.hasOwn(value, kind)) continue;
    const media = value[kind];
    if (!record(media)) { issues.push(path + "." + kind + ": expected an object"); continue; }
    if (Object.keys(media).sort().join(",") !== "prompt,purpose")
      issues.push(path + "." + kind + ": expected exactly purpose and prompt");
    if (!text(media.purpose, 500)) issues.push(path + "." + kind + ".purpose: expected nonempty text of at most 500 characters");
    if (!text(media.prompt, 4000)) issues.push(path + "." + kind + ".prompt: expected nonempty text of at most 4000 characters");
  }
  return issues;
}
export function isCoursewareSceneTeaching(value: unknown): value is CoursewareSceneTeaching {
  return coursewareSceneTeachingIssues(value, "teaching").length === 0;
}

/** Only boundary whitespace is normalized; ordered choices and answer keys are exact. */
export function coursewareQuestionMatches(action: Record<string, unknown>, expected: unknown): boolean {
  if (!expected || typeof expected !== "object" || Array.isArray(expected)) return false;
  const question = expected as Record<string, unknown>;
  return typeof action.question === "string" && typeof question.text === "string" && action.question.trim() === question.text.trim() &&
    isCoursewareQuestionResponse(action.response) && isCoursewareQuestionResponse(question.response) &&
    action.response.kind === question.response.kind &&
    JSON.stringify(action.response.options) === JSON.stringify(question.response.options) &&
    JSON.stringify(action.response.answerIndices) === JSON.stringify(question.response.answerIndices);
}
