import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";
register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const { planSceneVisualMaster } = await import("../electron/main/courseware-visual-master.ts");
const input = () => ({ sessionId: "chat", signal: new AbortController().signal,
  plan: { title: "Greetings", visualBible: { artDirection: "Flat cartoon", characters: "A monkey in a blue vest", setting: "Classroom" } },
  page: { pageId: "scene-001", title: "Hello", visibleText: ["Hello!", "早上好"], visualIntent: "The monkey waves", narration: "TEACHER_ONLY",
    teaching: { objective: "Say hello", phase: "opening", requiredObjects: ["Monkey Munchy"] } },
  instructions: "Only the five animals", courseStyleReferenceSupplied: true });
const response = (prompt = "Monkey waves: Hello! 早上好") => ({ text: JSON.stringify({ prompt, selectedDisplayText: ["Hello!", "早上好"], selectedOptionalObjectIds: [] }) });

test("MAIC visual direction uses approved text, cast and reference context without teacher narration", async () => {
  const calls = [];
  const prompt = await planSceneVisualMaster(input(), { modelKey: "provider/model" }, async request => { calls.push(request); return response(); });
  const data = JSON.parse(calls[0].messages[0].content);
  assert.equal(calls[0].thinkingLevel, "off");
  assert.equal(calls[0].maxOutputTokens, 3000);
  assert.equal(data.canvas, "16:10 / 1280x800");
  assert.equal(data.visualBible.artDirection, "Flat cartoon");
  assert.equal(data.mandatoryTeachingObjects[0].semanticRole, "Monkey Munchy");
  assert.equal(data.additionalRequirements, "Only the five animals");
  assert.equal(data.courseStyleReferenceSupplied, true);
  assert(!JSON.stringify(data).includes("TEACHER_ONLY"));
  assert(prompt.includes("Hard extraction constraint:"));
  assert(prompt.includes("Background art direction:"));
  assert(prompt.length <= 4000);
});

test("invalid planning gets one correction; literal text is appended when omitted from the image prompt", async () => {
  let calls = 0;
  const prompt = await planSceneVisualMaster(input(), { modelKey: "p/m" }, async () => ++calls === 1 ? { text: "not JSON" } : response("Monkey waves"));
  assert.equal(calls, 2);
  assert(prompt.includes('"Hello!", "早上好"'));
});

test("oversized, missing-text and extra-text plans fail before an image purchase", async () => {
  for (const value of [response("x".repeat(4001)), { text: JSON.stringify({ prompt: "Hello!", selectedDisplayText: ["Hello!"], selectedOptionalObjectIds: [] }) },
    { text: JSON.stringify({ prompt: "Hello! 早上好 Extra", selectedDisplayText: ["Hello!", "早上好", "Extra"], selectedOptionalObjectIds: [] }) }]) {
    let calls = 0;
    await assert.rejects(planSceneVisualMaster(input(), { modelKey: "p/m" }, async () => { calls++; return value; }));
    assert.equal(calls, 2);
  }
});
