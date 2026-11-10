import { coursewareSceneTeachingIssues, isCoursewareSceneTeaching, type CoursewareSceneTeaching } from "./courseware-scene-teaching.js";
import type { CoursewarePlannedQuiz } from "./courseware-scene-plan.js";

export type CoursewarePresentationPage = {
  pageNumber: number;
  teaching: CoursewareSceneTeaching;
  quiz?: CoursewarePlannedQuiz;
};

/** The exported physical pages own the budget; teaching never appends hidden pages. */
export function isCoursewarePresentationPages(value: unknown): value is CoursewarePresentationPage[] {
  return coursewarePresentationIssues(value).length === 0;
}

export function coursewarePresentationIssues(value: unknown): string[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 100) return ["pages: expected 1-100 ordered physical pages"];
  return value.flatMap((page: unknown, index) => {
    const path = `pages[${index}]`;
    if (!page || typeof page !== "object" || Array.isArray(page) ||
        Object.keys(page).some(key => !["pageNumber", "teaching", "quiz"].includes(key)))
      return [path + ": expected only pageNumber, teaching and optional quiz; quiz belongs beside teaching"];
    const entry = page as Record<string, unknown>, issues: string[] = [];
    if (entry.pageNumber !== index + 1) issues.push(path + `.pageNumber: expected ${index + 1}`);
    if (!isCoursewareSceneTeaching(entry.teaching)) return [...issues, ...coursewareSceneTeachingIssues(entry.teaching, path + ".teaching")];
    const teaching = entry.teaching, quiz = entry.quiz;
    if (teaching.question && (teaching.pageType === "slide" || ["single", "multiple", "judge"].includes(teaching.question.response.kind)))
      issues.push(path + ".teaching.question: use interactive/pbl with a non-objective response; objective questions belong in quiz");
    if ((teaching.question || teaching.pageType === "quiz") && (teaching.music || teaching.video || teaching.requiredObjects.length || teaching.requiredEffects?.length))
      issues.push(path + ".teaching: fixed assessment pages require empty requiredObjects/effects and no music/video");
    if (teaching.pageType !== "quiz") {
      if (quiz !== undefined) issues.push(path + ".quiz: only pageType quiz accepts quiz; keep interactive/pbl questions in teaching.question");
    } else if (!quiz || typeof quiz !== "object" || Array.isArray(quiz) || !("type" in quiz) || quiz.type !== "quiz" ||
        !("questions" in quiz) || !Array.isArray(quiz.questions) || quiz.questions.length !== 1 || teaching.question)
      issues.push(path + ".quiz: expected {type:quiz, questions:[one complete question]} beside teaching, without teaching.question");
    return issues; // The canonical MAIC parser validates the complete question and answer contract.
  });
}
