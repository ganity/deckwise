import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import ts from "typescript";
import * as shared from "../../../packages/shared/dist/index.js";
import * as runtime from "../../../packages/agent-runtime/dist/index.js";

const source = await readFile(new URL("../electron/main/courseware-candidates.ts", import.meta.url), "utf8");
const { outputText } = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } });
let authoringUrl;
const module = { exports: {} };
new Function("require", "exports", outputText)((id) => {
  if (id === "./courseware-source-candidate") return { stagePageFadeCandidate() { throw new Error("Unexpected fade call in narration test"); } };
  if (id === "./courseware-style-batch-candidate") return { stagePageStyleBatchCandidate() { throw new Error("Unexpected batch in narration test"); } };
  if (id === "./courseware-redo-candidate") return { stagePageRedoCandidate() { throw new Error("Unexpected redo call in narration test"); } };
  if (id === "./courseware-runtime") return { coursewareAuthoringUrl: () => authoringUrl };
  if (id === "@pi-desktop/shared") return shared;
  if (id === "@pi-desktop/agent-runtime") return runtime;
  throw new Error(id);
}, module.exports);
const { CoursewareCandidateCoordinator } = module.exports;
const fixture = JSON.parse(await readFile(new URL("../../../packages/shared/src/courseware-contract.fixtures/accepted.json", import.meta.url), "utf8"));
function setup(resolveModel) {
  const project = structuredClone(fixture.project);
  project.educationContext = { schoolStage: "KINDERGARTEN", subject: "ENGLISH", fullEnglishTeaching: false };
  project.pages[0].actions = [{ id: "old", type: "speech", text: "Existing narration" }];
  const snapshot = { sha256: project.source.sha256 };
  const editor = { projectId: "native-project", documentId: "native-document", sessionId: "native-session", editGeneration: 1, page: 1 };
  const session = { mode: "agent", providerId: "provider", modelId: "model", thinkingLevel: "medium" };
  const calls = []; const requests = []; let active = true; let changed = false; let duringComplete; let duringSaved;
  const host = { async call(method, params) {
    calls.push([method, structuredClone(params)]);
    if (method === "courseware.project.openSaved" || method === "courseware.project.get") return { project: structuredClone(project) };
    if (method === "courseware.pageText") return { text: "What do you see? A red apple." };
    if (method === "session.get") return { session: structuredClone(session) };
    if (method === "courseware.narration.save") {
      assert.deepEqual(params.baseline, project);
      assert.equal(params.write.expectedTeachingRevision, project.teachingRevision);
      project.pages.find(p => p.pageId === params.write.pageId).actions = structuredClone(params.write.actions);
      project.teachingRevision = `saved-${calls.length}`;
      return { project: structuredClone(project) };
    }
    throw new Error(method);
  } };
  const teaching = { async withSaved(id, operation) { assert.equal(id, "chat"); await duringSaved?.(); return operation(host, "job", snapshot, structuredClone(editor)); },
    async assertCurrent(_snapshot, pinned) { if (changed || JSON.stringify(pinned) !== JSON.stringify(editor)) throw new Error("Source or native page changed"); } };
  const complete = async (input) => { requests.push(input); await duringComplete?.(input); return { text: JSON.stringify({ blocks: [{ type: "speech", text: "Look! A red apple." }, { type: "wait", durationMs: 4000 }, { type: "praise", text: "Thank you for trying." }] }), modelKey: "provider/model" }; };
  const coordinator = new CoursewareCandidateCoordinator(teaching, complete, undefined, resolveModel);
  return { coordinator, project, session, editor, snapshot, calls, requests, async context() { return coordinator.execute("chat", "ppt_get_narration_context", {}, () => active); },
    async propose(context) { return coordinator.execute("chat", "ppt_propose_page_narration", { kind: "page-narration", baseline: context.baseline, instruction: "Use short sentences and simple English encouragement" }, () => active); },
    change: () => { changed = true; }, cancel: () => { active = false; }, during(fn) { duringComplete = fn; }, duringSaved(fn) { duringSaved = fn; }, teaching };
}

test("real B policy and structured blocks produce a saved teaching without a candidate", async () => {
  const f = setup(); const before = structuredClone(f.project);
  const context = await f.context(); const receipt = await f.propose(context);
  assert.equal(receipt.saved, true); assert.equal(receipt.applied, true);
  assert(!("write" in receipt)); assert(!("actions" in receipt));
  assert.notEqual(f.project.teachingRevision, before.teachingRevision);
  assert.deepEqual(f.project.pages.slice(1), before.pages.slice(1));
  const staged = f.calls.find(([method]) => method === "courseware.narration.save")[1];
  assert.equal(staged.baseline.teachingRevision, before.teachingRevision); assert.equal(staged.jobId, "job");
  assert.equal(staged.write.pageId, before.pages[0].pageId);
  assert(staged.write.actions.every((action) => Object.keys(action).every((key) => ["id", "type", "text", "pauseAfterMs"].includes(key))));
  assert.deepEqual(staged.write.actions.map(({ type, text, pauseAfterMs }) => ({ type, text, ...(pauseAfterMs ? { pauseAfterMs } : {}) })), [
    { type: "speech", text: "Look! " }, { type: "speech", text: "A red apple.", pauseAfterMs: 4000 }, { type: "speech", text: "Thank you for trying." }]);
  assert(f.requests[0].system.includes("KINDERGARTEN")); assert(f.requests[0].system.includes("Good job!"));
  assert.equal(f.requests[0].includeSessionContext, false); assert.equal(f.requests[0].modelKey, "provider/model");
  const data = JSON.parse(f.requests[0].messages[0].content);
  assert.equal(data.existingNarration, "Existing narration"); assert(!JSON.stringify(data).includes("source"));
});

test("narration inherits the effective Chat model without writing session configuration", async () => {
  const model = { modelKey: "default-provider/default-model", thinkingLevel: "low" };
  const f = setup(async id => { assert.equal(id, "chat"); return { ...model }; });
  delete f.session.providerId; delete f.session.modelId;
  f.session.thinkingLevel = "inherit";
  const before = structuredClone(f.session);
  const receipt = await f.propose(await f.context());
  assert.equal(receipt.saved, true);
  assert.equal(f.requests[0].modelKey, model.modelKey);
  assert.equal(f.requests[0].thinkingLevel, "low");
  assert.deepEqual(f.session, before);
  assert(!f.calls.some(([method]) => method === "session.configure"));
});

test("a changed inherited default model or thinking level never saves narration", async () => {
  for (const field of ["modelKey", "thinkingLevel"]) {
    const model = { modelKey: "default-provider/default-model", thinkingLevel: "low" };
    const f = setup(async () => ({ ...model }));
    delete f.session.providerId; delete f.session.modelId;
    f.during(() => { model[field] = field === "modelKey" ? "other/model" : "high"; });
    await assert.rejects(f.propose(await f.context()), /model changed/);
    assert.equal(f.requests.length, 1);
    assert(!f.calls.some(([method]) => method === "courseware.narration.save"));
  }
});

test("unavailable inherited models reject before a completion or teaching write", async () => {
  const f = setup();
  delete f.session.providerId; delete f.session.modelId;
  await assert.rejects(f.propose(await f.context()), /active Agent model/);
  assert.equal(f.requests.length, 0);
  assert(!f.calls.some(([method]) => method === "courseware.narration.save"));
});

test("cancellation during inherited model resolution never starts a completion", async () => {
  const f = setup(async () => { f.cancel(); return { modelKey: "provider/model" }; });
  await assert.rejects(f.propose(await f.context()), /cancelled|owner changed/);
  assert.equal(f.requests.length, 0);
  assert(!f.calls.some(([method]) => method === "courseware.narration.save"));
});

test("Main can propose narration again after adopting a teacher-continue checkpoint", async () => {
  const f = setup();
  f.project.pages[0].actions.push({ id: "continue-1", type: "interaction_checkpoint", checkpointId: "continue-1", checkpointKind: "teacher_continue" });
  const before = structuredClone(f.project);
  const context = await f.context();
  const receipt = await f.propose(context);
  assert.equal(receipt.saved, true);
  assert.equal(receipt.applied, true);
  assert.equal(f.requests.length, 1);
  assert.equal(JSON.parse(f.requests[0].messages[0].content).existingNarration, "Existing narration");
  assert.notEqual(f.project.teachingRevision, before.teachingRevision);
  assert.deepEqual(f.project.pages.slice(1), before.pages.slice(1));
  const staged = f.calls.find(([method]) => method === "courseware.narration.save")[1];
  assert.equal(staged.baseline.teachingRevision, before.teachingRevision);
  assert.equal(staged.write.pageId, before.pages[0].pageId);
});

test("forged context, locks and unsupported current actions reject before model use", async () => {
  for (const change of ["forged", "lock", "audio"]) {
    const f = setup(); const context = await f.context();
    if (change === "forged") context.baseline.pageId = "another-page";
    if (change === "lock") f.project.pages[0].locked = true;
    if (change === "audio") f.project.pages[0].actions[0].audioUrl = "asset";
    await assert.rejects(f.propose(context)); assert.equal(f.requests.length, 0);
    assert(!f.calls.some(([method]) => method === "courseware.narration.save"));
  }
});

test("late source, page, policy, teaching, model or cancellation changes never save", async () => {
  for (const change of ["source", "page", "policy", "teaching", "model", "cancel"]) {
    const f = setup(); const context = await f.context();
    f.during(() => {
      if (change === "source") f.change();
      if (change === "page") f.editor.page++;
      if (change === "policy") f.project.educationContext.fullEnglishTeaching = true;
      if (change === "teaching") f.project.pages[1].locked = !f.project.pages[1].locked;
      if (change === "model") f.session.modelId = "other-model";
      if (change === "cancel") f.cancel();
    });
    await assert.rejects(f.propose(context)); assert.equal(f.requests.length, 1);
    assert(!f.calls.some(([method]) => method === "courseware.narration.save"), change);
  }
});

test("Main preserves the stage-specific output instructions for ordinary narration", async () => {
  const f = setup();
  f.project.educationContext = { schoolStage: "PRIMARY", grade: "3", subject: "MATH" };
  const context = await f.context();
  const coordinator = new CoursewareCandidateCoordinator(f.teaching, async ({ system }) => {
    assert(system.includes("Allowed block types: speech and wait."));
    assert(!system.includes('"type":"praise"'));
    return { text: JSON.stringify({ blocks: [{ type: "speech", text: "这是什么图形？" }, { type: "wait", durationMs: 4000 }] }), modelKey: "provider/model" };
  });
  const result = await coordinator.execute("chat", "ppt_propose_page_narration", { kind: "page-narration", baseline: context.baseline, instruction: "Use short Chinese sentences" }, () => true);
  assert.equal(result.saved, true);
  const staged = f.calls.find(([method]) => method === "courseware.narration.save")[1];
  assert.deepEqual(staged.write.actions.map(({ type, text, pauseAfterMs }) => ({ type, text, pauseAfterMs })),
    [{ type: "speech", text: "这是什么图形？", pauseAfterMs: 4000 }]);
});

test("tool cancellation aborts an in-flight completion signal", async () => {
  const f = setup(); const context = await f.context();
  f.during(async ({ signal }) => {
    f.cancel();
    await assert.rejects(delay(2000, undefined, { signal }), /abort/i);
    assert(signal.aborted);
  });
  await assert.rejects(f.propose(context), /cancelled/);
  assert(!f.calls.some(([method]) => method === "courseware.narration.save"));
});

test("malformed model blocks, control markers and unsafe waits reject at the canonical boundary", async () => {
  for (const blocks of [[], [{ type: "speech", text: "[wait:4] hello" }], [{ type: "wait", durationMs: 1000 }, { type: "speech", text: "Hello" }], [{ type: "speech", text: "Hello" }, { type: "wait", durationMs: 60000 }], [{ type: "praise", text: "Correct!" }]]) {
    const f = setup(); const context = await f.context();
    const broken = new CoursewareCandidateCoordinator(f.teaching, async () => ({ text: JSON.stringify({ blocks }), modelKey: "provider/model" }));
    await assert.rejects(broken.execute("chat", "ppt_propose_page_narration", { kind: "page-narration", baseline: context.baseline, instruction: "Change narration" }, () => true));
    assert(!f.calls.some(([method]) => method === "courseware.narration.save"));
  }
});


for (const kind of ["original-notes", "external"]) test(`trusted ${kind} selection directly saves teaching without consulting model settings`, async () => {
  const f = setup(); const context = await f.context(); const before = structuredClone(f.project);
  delete f.session.providerId; delete f.session.modelId;
  const receipt = await f.coordinator.selectNarrationSource("chat", { kind, baseline: context.baseline, text: "  观察苹果。\n说说你的发现。  " }, () => true);
  assert.equal(receipt.kind, "page-narration"); assert.equal(receipt.applied, true);
  assert(!("write" in receipt)); assert(!("text" in receipt));
  assert.equal(f.requests.length, 0); assert(!f.calls.some(([method]) => method === "session.get"));
  const staged = f.calls.find(([method]) => method === "courseware.narration.save")[1];
  assert.equal(staged.baseline.teachingRevision, before.teachingRevision);
  assert.deepEqual(staged.write.actions.map(({ type, text }) => ({ type, text })), [
    { type: "speech", text: "观察苹果。\n" }, { type: "speech", text: "说说你的发现。" }]);
  assert.equal(staged.write.actions.map(action => action.text).join(""), "观察苹果。\n说说你的发现。");
  assert.notEqual(f.project.teachingRevision, before.teachingRevision);
  assert.deepEqual(f.project.pages.slice(1), before.pages.slice(1));
});

test("source selection captures text/baseline before saved-source await", async () => {
  const f = setup(); const context = await f.context();
  const selection = { kind: "external", baseline: structuredClone(context.baseline), text: "Original selection" };
  f.duringSaved(() => { selection.text = "Changed"; selection.baseline.pageId = "forged"; });
  await f.coordinator.selectNarrationSource("chat", selection, () => true);
  assert.equal(f.calls.find(([method]) => method === "courseware.narration.save")[1].write.actions[0].text, "Original selection");
});

test("source replacement after audio adoption saves directly without reusing audio", async () => {
  const f = setup();
  f.project.pages[0].actions[0].audioAssetId = "old-audio";
  const before = structuredClone(f.project);
  const context = await f.context();
  await f.coordinator.selectNarrationSource("chat", { kind: "external", baseline: context.baseline, text: "New explanation" }, () => true);
  const staged = f.calls.find(([method]) => method === "courseware.narration.save")[1];
  assert.equal(staged.write.actions[0].text, "New explanation");
  assert.equal(staged.write.actions[0].audioAssetId, undefined);
  assert.notEqual(f.project.teachingRevision, before.teachingRevision);
  assert.deepEqual(f.project.pages.slice(1), before.pages.slice(1));
});

for (const change of ["forged", "lock", "interactive", "source", "page", "policy", "teaching", "cancel"]) test(`source selection rejects ${change} without saving`, async () => {
  const f = setup(); const context = await f.context();
  const selection = { kind: "external", baseline: context.baseline, text: "Selected speech" };
  if (change === "forged") selection.baseline.pageId = "other-page";
  if (change === "lock") f.project.pages[0].locked = true;
  if (change === "interactive") f.project.pages[0].actions.push({ id: "quiz", type: "quiz" });
  if (change === "source") f.change();
  if (change === "page") f.editor.page++;
  if (change === "cancel") f.cancel();
  if (["policy", "teaching"].includes(change)) {
    let checks = 0; const original = f.teaching.assertCurrent;
    f.teaching.assertCurrent = async (...args) => { await original(...args); if (++checks === 2) { if (change === "policy") f.project.educationContext.subject = "MATH"; else f.project.teachingRevision = "new"; } };
  }
  await assert.rejects(f.coordinator.selectNarrationSource("chat", selection, () => change !== "cancel"));
  assert.equal(f.requests.length, 0); assert(!f.calls.some(([method]) => method === "courseware.narration.save"));
});

for (const text of ["", " ", "[wait:4] hello", "<pause>hello", "x".repeat(8001)]) test("invalid selected text rejects before Host reads: " + text.slice(0, 12), async () => {
  const f = setup(); const context = await f.context(); f.calls.length = 0;
  await assert.rejects(f.coordinator.selectNarrationSource("chat", { kind: "external", baseline: context.baseline, text }, () => true));
  assert.equal(f.calls.length, 0);
});

test("unknown selection fields and kinds reject before Host reads", async () => {
  const f = setup(); const context = await f.context(); f.calls.length = 0;
  for (const selection of [{ kind: "generate", baseline: context.baseline, text: "Text" }, { kind: "external", baseline: context.baseline, text: "Text", path: "/secret" }])
    await assert.rejects(f.coordinator.selectNarrationSource("chat", selection, () => true));
  assert.equal(f.calls.length, 0);
});

test("selected notes work on a page without extracted text", async () => {
  const f = setup();
  const original = f.teaching.withSaved;
  f.teaching.withSaved = (id, operation, signal) => original(id, (host, ...args) => operation({ call: (method, params) => method === "courseware.pageText" ? Promise.resolve({ text: "" }) : host.call(method, params) }, ...args), signal);
  const context = await f.context();
  assert.deepEqual(context.capabilities, ["page-fade"]);
  await f.coordinator.selectNarrationSource("chat", { kind: "original-notes", baseline: context.baseline, text: "Read the diagram aloud." }, () => true);
  assert.equal(f.requests.length, 0);
  assert.equal(f.calls.filter(([method]) => method === "courseware.narration.save").length, 1);
});


test("source selection stays Host-only and cannot be smuggled through a public proposal", async () => {
  const f = setup(); const context = await f.context();
  for (const args of [
    { kind: "original-notes", baseline: context.baseline, text: "Selected text" },
    { kind: "page-narration", baseline: context.baseline, instruction: "Rewrite", selectedNarration: { blocks: [{ type: "speech", text: "Injected" }] } },
  ]) await assert.rejects(f.coordinator.execute("chat", "ppt_propose_page_narration", args, () => true), /Invalid candidate proposal/);
  assert.equal(f.requests.length, 0);
  assert(!f.calls.some(([method]) => method === "courseware.narration.save"));
});

test("current reviewed redo and confirmed batch capabilities survive source selection", async () => {
  const f = setup(); const calls = [];
  const scope = { reviewId: "review-current", pageIds: f.project.pages.map((page) => page.pageId) };
  const redo = {
    visuals: { approved: async () => { calls.push("visual"); return { view: { projectId: f.project.projectId, pageId: f.project.pages[0].pageId, sourceSha256: f.snapshot.sha256 } }; } },
    style: { confirmedScope: async () => { calls.push("scope"); return scope; } },
  };
  const coordinator = new CoursewareCandidateCoordinator(f.teaching, async () => { throw new Error("No model call for source selection"); }, redo);
  authoringUrl = "file:///private-fixture-authoring.mjs";
  try {
    const context = await coordinator.execute("chat", "ppt_get_narration_context", {}, () => true);
    assert.deepEqual(context.capabilities, ["page-narration", "page-fade", "page-pptx", "page-style-batch"]);
    assert.deepEqual(context.styleBatch, scope);
    const prior = [...calls];
    await coordinator.selectNarrationSource("chat", { kind: "external", baseline: context.baseline, text: "Explicit source" }, () => true);
    assert.deepEqual(calls, prior);
  } finally { authoringUrl = undefined; }
});

test("fade, redo and confirmed batch keep their existing dedicated delegates", async () => {
  const f = setup(); const context = await f.context();
  const scope = { reviewId: "review-current", pageIds: f.project.pages.map((page) => page.pageId) };
  const coordinator = new CoursewareCandidateCoordinator(f.teaching, async () => { throw new Error("No narration completion"); }, {
    visuals: { approved: async () => ({ view: {} }) }, style: { confirmedScope: async () => scope },
  });
  authoringUrl = "file:///private-fixture-authoring.mjs";
  try {
    for (const [name, args, expected] of [
      ["ppt_propose_page_fade", { kind: "page-fade", baseline: context.baseline }, /Unexpected fade call/],
      ["ppt_propose_page_redo", { kind: "page-pptx", baseline: context.baseline, instruction: "Redo" }, /Unexpected redo call/],
      ["ppt_propose_page_style_batch", { kind: "page-style-batch", baseline: context.baseline, styleBatch: scope }, /Unexpected batch/],
    ]) await assert.rejects(coordinator.execute("chat", name, args, () => true), expected);
    assert(!f.calls.some(([method]) => method === "courseware.narration.save"));
  } finally { authoringUrl = undefined; }
});
