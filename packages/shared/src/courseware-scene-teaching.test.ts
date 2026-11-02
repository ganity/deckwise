import { expect, it } from "vitest";
import cases from "./courseware-scene-teaching.fixtures/requirements.json";
import { coursewareQuestionMatches, isCoursewareSceneTeaching } from "./courseware-scene-teaching.js";

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
