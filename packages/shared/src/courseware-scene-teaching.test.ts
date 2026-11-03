import { expect, it } from "vitest";
import cases from "./courseware-scene-teaching.fixtures/requirements.json";
import { coursewareQuestionMatches, coursewareSceneTeachingIssues, isCoursewareSceneTeaching } from "./courseware-scene-teaching.js";

it.each(cases)("compares the full approved question: $name", test => {
  expect(coursewareQuestionMatches(test.action, test.expected)).toBe(test.matches);
});
it("accepts bounded required video and preserves legacy teaching", () => {
  const teaching = { pageType: "slide", phase: "opening", objective: "Greet", durationSeconds: 30, requiredObjects: [] };
  expect(isCoursewareSceneTeaching(teaching)).toBe(true);
  expect(isCoursewareSceneTeaching({ ...teaching, video: { purpose: "Show a wave", prompt: "A five-second silent wave" } })).toBe(true);
  for (const video of [null, { purpose: "", prompt: "wave" }, { purpose: "wave", prompt: "x".repeat(4001) }, { purpose: "wave", prompt: "wave", seconds: 10 }])
    expect(isCoursewareSceneTeaching({ ...teaching, video })).toBe(false);
});

it("reports nested field constraints together without accepting malformed teaching", () => {
  const invalid = { pageType: "quiz", phase: "unknown", objective: "", durationSeconds: 4,
    requiredObjects: ["Monkey", "Monkey"], question: { text: "", response: { kind: "single", options: ["Hello", ""], answerIndices: [2] } },
    music: { purpose: "", prompt: "x".repeat(4001) }, video: null, extra: true };
  const errors = coursewareSceneTeachingIssues(invalid, "pages[3].teaching").join("\n");
  for (const field of ["phase", "objective", "durationSeconds", "requiredObjects", "question.text",
    "question.response.options[1]", "question.response.answerIndices[0]", "music.purpose", "music.prompt", "video"])
    expect(errors).toContain("pages[3].teaching." + field);
  expect(errors).toContain("unexpected fields extra");
  expect(isCoursewareSceneTeaching(invalid)).toBe(false);
});
