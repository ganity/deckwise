import { isCoursewareQuestionResponse, type CoursewareQuestionResponse } from "./courseware-question.js";

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
export function isCoursewareSceneTeaching(value: unknown): value is CoursewareSceneTeaching {
  const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
  const text = (v: unknown, max: number) => typeof v === "string" && !!v.trim() && v.length <= max;
  if (!record(value) || !["pageType", "phase", "objective", "durationSeconds", "requiredObjects"].every(k => Object.hasOwn(value, k)) ||
      Object.keys(value).some(k => !["pageType", "phase", "objective", "durationSeconds", "requiredObjects", "question", "music", "video"].includes(k)) ||
      !["slide", "quiz", "interactive", "pbl"].includes(String(value.pageType)) ||
      !["opening", "explore", "practice", "review"].includes(String(value.phase)) || !text(value.objective, 1000) ||
      !Number.isInteger(value.durationSeconds) || Number(value.durationSeconds) < 5 || Number(value.durationSeconds) > 1800 ||
      !Array.isArray(value.requiredObjects) || value.requiredObjects.length > 30 || value.requiredObjects.some(o => !text(o, 200)) ||
      new Set(value.requiredObjects).size !== value.requiredObjects.length) return false;
  if (Object.hasOwn(value, "question") && (!record(value.question) || Object.keys(value.question).sort().join(",") !== "response,text" ||
      !text(value.question.text, 160) || !isCoursewareQuestionResponse(value.question.response))) return false;
  if (value.pageType !== "slide" && !value.question) return false;
  if (Object.hasOwn(value, "music") && (!record(value.music) || Object.keys(value.music).sort().join(",") !== "prompt,purpose" ||
      !text(value.music.purpose, 500) || !text(value.music.prompt, 4000))) return false;
  if (Object.hasOwn(value, "video") && (!record(value.video) || Object.keys(value.video).sort().join(",") !== "prompt,purpose" ||
      !text(value.video.purpose, 500) || !text(value.video.prompt, 4000))) return false;
  return true;
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
