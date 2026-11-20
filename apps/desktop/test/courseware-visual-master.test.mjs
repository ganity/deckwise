import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";
register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const { planSceneVisualMaster } = await import("../electron/main/courseware-visual-master.ts");
const input = () => ({ sessionId: "chat", signal: new AbortController().signal,
  educationContext: { schoolStage: "SENIOR_HIGH", grade: "11", subject: "MATH", visualStyle: "Watercolor" },
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
  assert.ok(data.visualGuidance.includes(JSON.stringify({ schoolStage: "SENIOR_HIGH", grade: "11", subject: "MATH" })));
  assert.equal(data.educationContext.visualStyle, "Watercolor");
  assert.equal(data.mandatoryTeachingObjects[0].semanticRole, "Monkey Munchy");
  assert.equal(data.additionalRequirements, "Only the five animals");
  assert.equal(data.courseStyleReferenceSupplied, true);
  assert(!JSON.stringify(data).includes("TEACHER_ONLY"));
  assert(prompt.includes("Layer separation:"));
  assert(prompt.includes("Background art direction:"));
  assert(prompt.includes(data.visualGuidance));
  assert(prompt.includes("Approved art direction: Watercolor"));
  assert(!prompt.includes("editable native"));
  assert(prompt.length <= 4000);
});

test("invalid planning gets one correction; literal text is appended when omitted from the image prompt", async () => {
  let calls = 0;
  const prompt = await planSceneVisualMaster(input(), { modelKey: "p/m" }, async () => ++calls === 1 ? { text: "not JSON" } : response("Monkey waves"));
  assert.equal(calls, 2);
  assert(prompt.includes('"Hello!", "早上好"'));
});

test("original design guidance reaches the planner and actual image prompt even when the planner omits it", async () => {
  for (const reference of [false, true]) {
    const request = input();
    request.courseStyleReferenceSupplied = reference;
    if (!reference) delete request.plan.visualBible;
    const check = text => {
      assert.match(text, /Original character design:/);
      assert.match(text, /silhouettes, proportions, faces and color\/outfit combinations/);
      assert.match(text, /not recognizable commercial mascots or their signature feature combinations/);
      assert.match(text, /explicit user appearance requirements and approved identities/);
      assert.match(text, /applying requested corrections consistently across pages/);
    };
    const prompt = await planSceneVisualMaster(request, { modelKey: "p/m" }, async call => {
      check(call.system);
      if (reference) assert.equal(JSON.parse(call.messages[0].content).visualBible.characters, "A monkey in a blue vest");
      const budget = Number(call.system.match(/Keep prompt within (\d+) UTF-16 units/)[1]);
      return response("Hello! 早上好".padEnd(budget, "x"));
    });
    check(prompt);
    assert.equal(prompt.length, 4000);
  }
});

test("oversized, missing-text and extra-text plans fail before an image purchase", async () => {
  for (const value of [response("x".repeat(4001)), { text: JSON.stringify({ prompt: "Hello!", selectedDisplayText: ["Hello!"], selectedOptionalObjectIds: [] }) },
    { text: JSON.stringify({ prompt: "Hello! 早上好 Extra", selectedDisplayText: ["Hello!", "早上好", "Extra"], selectedOptionalObjectIds: [] }) }]) {
    let calls = 0;
    await assert.rejects(planSceneVisualMaster(input(), { modelKey: "p/m" }, async () => { calls++; return value; }));
    assert.equal(calls, 2);
  }
});

test("batched image corrections stay page-scoped and require exact object and quote evidence", async () => {
  const { teachingForReviewedMasters } = await import('../electron/main/courseware-visual-master.ts');
  const pages = [
    { pageId: 'scene-001', intentId: 'master-1', assetSha256: 'a'.repeat(64), instructions: 'Remove the arrow; keep the moon.',
      teaching: { objective: 'Compare moon phases', requiredObjects: ['Moon', 'Arrow'], requiredEffects: ['spotlight'] } },
    { pageId: 'scene-002', intentId: 'master-2', assetSha256: 'b'.repeat(64), instructions: 'Remove the label; keep the fraction.',
      teaching: { objective: 'Read the fraction', requiredObjects: ['Numerator', 'Denominator', 'Label'], requiredEffects: ['highlight'] } },
  ];
  const request = { sessionId: 'chat', modelKey: 'test', signal: new AbortController().signal, pages };
  const reply = rows => async call => {
    assert.equal(JSON.parse(call.messages[0].content).pages.length, 2);
    return { text: JSON.stringify({ pages: rows }) };
  };
  const changed = await teachingForReviewedMasters(request, reply([
    { pageId: 'scene-002', removals: [{ object: 'Label', quote: 'Remove the label' }] },
    { pageId: 'scene-001', removals: [{ object: 'Arrow', quote: 'Remove the arrow' }] },
  ]));
  assert.deepEqual(changed, [
    { pageId: 'scene-002', intentId: 'master-2', assetSha256: 'b'.repeat(64), removals: [{ object: 'Label', quote: 'Remove the label' }] },
    { pageId: 'scene-001', intentId: 'master-1', assetSha256: 'a'.repeat(64), removals: [{ object: 'Arrow', quote: 'Remove the arrow' }] },
  ]);
  for (const rows of [
    [{ pageId: 'scene-001', removals: [{ object: 'invented', quote: 'Remove the arrow' }] }, { pageId: 'scene-002', removals: [] }],
    [{ pageId: 'scene-001', removals: [{ object: 'Arrow', quote: 'remove the arrow' }] }, { pageId: 'scene-002', removals: [] }],
    [{ pageId: 'scene-001', removals: [] }, { pageId: 'scene-001', removals: [] }],
  ]) await assert.rejects(teachingForReviewedMasters(request, reply(rows)), /correction/);
  const unchanged = await teachingForReviewedMasters(request, reply([
    { pageId: 'scene-001', removals: [] }, { pageId: 'scene-002', removals: [] },
  ]));
  assert.deepEqual(unchanged.map(row => row.removals), [[], []]);
  assert.deepEqual(pages.map(page => page.teaching.requiredObjects), [['Moon', 'Arrow'], ['Numerator', 'Denominator', 'Label']]);
});


test("image correction batches retain the single-page output allowance", async () => {
  const { teachingForReviewedMasters } = await import('../electron/main/courseware-visual-master.ts');
  for (const count of [1, 6, 30]) {
    const pages = Array.from({ length: count }, (_, index) => ({
      pageId: `scene-${String(index + 1).padStart(3, '0')}`, intentId: `master-${index + 1}`, assetSha256: 'a'.repeat(64),
      instructions: 'Keep the teaching content.', teaching: { objective: 'Observe the example', requiredObjects: ['Example'] },
    }));
    const corrections = await teachingForReviewedMasters({ sessionId: 'chat', modelKey: 'test', signal: new AbortController().signal, pages }, async call => {
      assert(call.maxOutputTokens >= 1200);
      if (count <= 6) assert(call.maxOutputTokens >= count * 1200);
      assert(call.maxOutputTokens <= 16000);
      return { text: JSON.stringify({ pages: pages.map(({ pageId }) => ({ pageId, removals: [] })) }) };
    });
    assert.equal(corrections.length, count);
  }
});
