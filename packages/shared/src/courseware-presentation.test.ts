import { expect, it } from "vitest";
import { coursewarePresentationIssues, isCoursewarePresentationPages } from "./courseware-presentation.js";
import { isCoursewareSceneTeaching } from "./courseware-scene-teaching.js";

const teaching = { pageType: "slide", phase: "explore", objective: "Name family", durationSeconds: 30, requiredObjects: ["father"] };
it("pins teaching to contiguous physical pages and rejects mixed assessment/body requirements", () => {
  const body = { pageNumber: 1, teaching: { ...teaching, requiredEffects: ["highlight", "animation"] } };
  const quiz = { pageNumber: 2, teaching: { ...teaching, pageType: "quiz", requiredObjects: [] },
    quiz: { type: "quiz", questions: [{ id: "q", type: "single", question: "Who?", options: [{ value: "A", label: "father" }], answer: ["A"] }] } };
  expect(isCoursewarePresentationPages([body, quiz])).toBe(true);
  for (const invalid of [[], [quiz, body], [{ ...body, pageNumber: 2 }], [{ ...body, approval: true }],
    [{ ...quiz, pageNumber: 1, quiz: undefined }], [{ ...quiz, pageNumber: 1, teaching: { ...quiz.teaching, requiredObjects: ["father"] } }],
    [{ ...body, teaching: { ...body.teaching, pageType: "interactive", question: {
      text: "Introduce family", response: { kind: "discussion", options: [], answerIndices: [] },
    } } }]]) expect(isCoursewarePresentationPages(invalid)).toBe(false);
});
it("accepts bounded unique effect requirements and rejects invalid effect contracts", () => {
  expect(isCoursewareSceneTeaching({ ...teaching, requiredEffects: ["highlight", "spotlight", "animation"] })).toBe(true);
  for (const requiredEffects of [null, ["unknown"], ["animation", "animation"], "spotlight"])
    expect(isCoursewareSceneTeaching({ ...teaching, requiredEffects })).toBe(false);
});
it("reports the exact interaction field to repair without changing its page type", () => {
  const pages = [{ pageNumber: 1, teaching: { ...teaching, pageType: "interactive", requiredObjects: [], question: {
    text: "Introduce family", response: { kind: "discussion", options: [], answerIndices: [] },
  } } }];
  expect(coursewarePresentationIssues(pages)).toEqual([]);
  expect(coursewarePresentationIssues([{ ...pages[0], teaching: { ...pages[0].teaching, question: { text: "Introduce family" } } }]))
    .toContain("pages[0].teaching.question.response: expected an object");
  expect(coursewarePresentationIssues([{ ...pages[0], quiz: { type: "quiz", questions: [] } }]).join("\n"))
    .toContain("pages[0].quiz: only pageType quiz accepts quiz; keep interactive/pbl questions in teaching.question");
});
