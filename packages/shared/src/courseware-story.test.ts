import { describe, expect, it } from "vitest";
import { coursewareStoryRequirementsMatch, isCoursewareStory, storyNeedsApproval, type CoursewareStory } from "./courseware-story.js";
const story: CoursewareStory = { title: "Rainbow rescue", summary: "Help restore the colors.", setting: "A classroom garden", objectives: ["Recognize red"],
  characters: [{ name: "Robin", description: "A small round robot with a green scarf" }],
  beats: [{ id: "find", title: "Find red", event: "Robin finds a red ball", objective: "Recognize red", activity: "Sort objects by color",
    assessment: { kind: "quiz", question: "Which is red?", referenceAnswer: "The ball" } }], assumptions: ["Suggested duration: 15 minutes"], bodyPageLimit: 5 };
describe("teaching story contract", () => {
  it("separates production settings from teaching requirements when offering story review", () => {
    expect(coursewareStoryRequirementsMatch(null, { visualStyle: "Watercolor", bodyPageLimit: 8 })).toBe(true);
    expect(coursewareStoryRequirementsMatch({ grade: "K2", visualStyle: "Park" }, { grade: "K2", visualStyle: "Watercolor", bodyPageLimit: 8 })).toBe(true);
    for (const changed of [{ grade: "K3" }, { subject: "math" }, { fullEnglishTeaching: true }, { chapter: "Colors" }]) {
      expect(coursewareStoryRequirementsMatch({ grade: "K2" }, { grade: "K2", ...changed })).toBe(false);
    }
    expect(coursewareStoryRequirementsMatch({ grade: "K2" }, {})).toBe(false);
  });
  it("validates a topic-to-teaching story without requiring a page plan", () => {
    expect(isCoursewareStory(story)).toBe(true);
    for (const value of [{ ...story, beats: [] }, { ...story, title: " " }, { ...story, path: "/private" },
      { ...story, beats: [...story.beats, ...story.beats] }, { ...story, objectives: ["Unrelated"] },
      { ...story, bodyPageLimit: 31 }, { ...story, beats: [{ ...story.beats[0], assessment: { kind: "unknown" } }] }]) expect(isCoursewareStory(value)).toBe(false);
  });
  it("requires review of the exact saved revision and leaves legacy tasks on direct generation", () => {
    expect(storyNeedsApproval(undefined)).toBe(false);
    expect(storyNeedsApproval(null)).toBe(false);
    const state = { schemaVersion: 1 as const, revision: 1, draft: story, sha256: "a".repeat(64), approvedSha256: null, educationContext: {}, bound: false };
    expect(storyNeedsApproval(state)).toBe(true);
    expect(storyNeedsApproval({ ...state, approvedSha256: state.sha256 })).toBe(false);
    expect(storyNeedsApproval({ ...state, approvedSha256: "b".repeat(64) })).toBe(true);
  });
});
