import { expect, it } from "vitest";
import { planNativeLesson, type NativeLessonPage } from "./native-lesson-planning.js";

const text = "Introduce the red apple. Discuss: Why are apples red? Practice peeling an apple.";
const pages: NativeLessonPage[] = [
  { pageId: "apple", pageNumber: 1, text: "A red apple", notes: "Introduce the red apple", activities: [] },
  { pageId: "discussion", pageNumber: 2, text: "Why are apples red?", notes: "", activities: [{ id: "question", question: "Why are apples red?" }] },
];
const units = [
  { title: "Introduce", evidence: "Introduce the red apple.", kind: "teaching", mappings: [{ pageId: "apple", evidence: "red apple" }] },
  { title: "Discuss", evidence: "Discuss: Why are apples red?", kind: "checkpoint", mappings: [{ pageId: "discussion", evidence: "Why are apples red?" }] },
  { title: "Practice", evidence: "Practice peeling an apple.", kind: "checkpoint", mappings: [] },
];
const run = (value: unknown, sourcePages = pages) => planNativeLesson({ text, pages: sourcePages, instruction: "No additional quiz",
  complete: async (system, data) => {
    expect(system).toContain("Do not add default quizzes");
    expect(JSON.parse(data)).toMatchObject({ source: text, instruction: "No additional quiz", pages: sourcePages });
    return JSON.stringify(value);
  } });

it("maps exact evidence, reuses a unique existing question and keeps unmatched practice visible", async () => {
  const result = await run({ units });
  expect(result).toMatchObject([
    { id: "lesson-unit-1", kind: "teaching", pageIds: ["apple"] },
    { id: "lesson-unit-2", kind: "checkpoint", pageIds: ["discussion"], activityId: "question" },
    { id: "lesson-unit-3", kind: "checkpoint", pageIds: [] },
  ]);
  expect(result.some(u => u.kind === "quiz")).toBe(false);
});

it("does not silently bind duplicate existing questions", async () => {
  const result = await run({ units }, [...pages, { ...pages[1]!, pageId: "duplicate", pageNumber: 3 }]);
  expect(result[1]?.activityId).toBeUndefined();
});

it("rejects invented source quotes, nonexistent pages, invented page evidence and model activity identities", async () => {
  for (const change of [
    { evidence: "An invented objective" },
    { mappings: [{ pageId: "ghost", evidence: "red apple" }] },
    { mappings: [{ pageId: "apple", evidence: "A blue apple" }] },
    { mappings: [{ pageId: "apple", evidence: " " }] },
    { activityId: "invented" }, { kind: "exercise" },
    { mappings: [{ pageId: "apple", evidence: "red" }, { pageId: "apple", evidence: "apple" }] },
  ]) await expect(run({ units: [{ ...units[0], ...change }] })).rejects.toThrow();
});

it("rejects overlarge evidence before calling a model instead of dropping the tail", async () => {
  await expect(planNativeLesson({ text: "x".repeat(100001), pages, instruction: "", complete: async () => { throw new Error("must not call model"); } }))
    .rejects.toThrow("split larger material");
});

it("repairs invalid model evidence once while keeping the immutable source and real pages", async () => {
  let calls = 0;
  const result = await planNativeLesson({ text, pages, instruction: "No additional quiz", complete: async (_system, data) => {
    const input = JSON.parse(data);
    expect(input.source).toBe(text);
    expect(input.pages).toEqual(pages);
    if (++calls === 1) return JSON.stringify({ units: [{ ...units[0], evidence: "An invented objective" }] });
    expect(input.repair.error).toMatch(/units\[0\]\.evidence.*exact source evidence/);
    return JSON.stringify({ units });
  } });
  expect(calls).toBe(2);
  expect(result).toHaveLength(3);
});

it("identifies the exact mapping and page for a repair", async () => {
  const incorrect = { ...units[1], mappings: [{ pageId: "apple", evidence: "apple" }, { pageId: "discussion", evidence: "invented" }] };
  await expect(run({ units: [units[0], incorrect] })).rejects.toThrow(/units\[1\]\.mappings\[1\]\.evidence.*discussion/);
});

it("does not repeat a provider failure or accept a second invalid model mapping", async () => {
  let calls = 0;
  await expect(planNativeLesson({ text, pages, instruction: "", complete: async () => {
    calls++; throw new Error("provider unavailable");
  } })).rejects.toThrow("provider unavailable");
  expect(calls).toBe(1);
  calls = 0;
  await expect(planNativeLesson({ text, pages, instruction: "", complete: async () => {
    calls++; return JSON.stringify({ units: [{ ...units[0], evidence: "An invented objective" }] });
  } })).rejects.toThrow("exact source evidence");
  expect(calls).toBe(2);
});
