import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import ts from "typescript";
import * as shared from "../../../packages/shared/dist/index.js";
import * as runtime from "../../../packages/agent-runtime/dist/index.js";

const require = createRequire(import.meta.url);
function loadNative(id) {
  if (id === "@pi-desktop/shared") return shared;
  if (id === "@pi-desktop/agent-runtime") return runtime;
  if (id === "./courseware-narration-visuals") return {};
  if (!id.startsWith("./")) return require(id);
  const exports = {};
  new Function("require", "exports", ts.transpileModule(readFileSync(new URL(`../electron/main/${id.slice(2)}.ts`, import.meta.url), "utf8"), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true } }).outputText)(loadNative, exports);
  return exports;
}
const source = await readFile(new URL("../electron/main/courseware-candidates.ts", import.meta.url), "utf8");
const { outputText } = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true } });
let authoringUrl;
const module = { exports: {} };
new Function("require", "exports", outputText)((id) => {
  if (id === "./courseware-native-narration") return loadNative(id);
  if (id === "./courseware-source-candidate") return { stagePageFadeCandidate() { throw new Error("Unexpected fade call in narration test"); } };
  if (id === "./courseware-style-batch-candidate") return { stagePageStyleBatchCandidate() { throw new Error("Unexpected batch in narration test"); } };
  if (id === "./courseware-redo-candidate") return { stagePageRedoCandidate() { throw new Error("Unexpected redo call in narration test"); } };
  if (id === "./courseware-runtime") return { coursewareAuthoringUrl: () => authoringUrl };
  if (id === "@pi-desktop/shared") return shared;
  if (id === "@pi-desktop/agent-runtime") return runtime;
  throw new Error(id);
}, module.exports);
const { CoursewareCandidateCoordinator } = module.exports;

test("native lesson planning reads real pages, uses the selected model and rejects changes before adoption", async () => {
  const project = { schemaVersion: "deckwise-courseware/1", projectId: "native", taskType: "import", title: "Lesson", source: { revision: "r", sha256: "a".repeat(64) },
    teachingRevision: "r", pages: [{ pageId: "apple", locked: false, reviewState: "review", actions: [] }] };
  let liveText = "A red apple", selected = "provider/model", active = true, mutate = () => {};
  const operations = [];
  const teaching = { async native(op, args, n = 1) {
    operations.push(op);
    const view = structuredClone({ project, viewId: "native.apple", pageId: "apple", pageNumber: n });
    if (op === "open") return { value: view };
    assert.equal(op, "narration-context");
    return { value: { view, text: liveText, evidence: { notes: "Teacher note" } } };
  } };
  const complete = async input => {
    assert.equal(input.modelKey, "provider/model"); assert.equal(input.includeSessionContext, false);
    assert.equal(JSON.parse(input.messages[0].content).pages[0].text, "A red apple");
    mutate();
    return { text: JSON.stringify({ units: [{ title: "Apple", evidence: "Teach red apples.", kind: "teaching", mappings: [{ pageId: "apple", evidence: "red apple" }] }] }), modelKey: input.modelKey };
  };
  const coordinator = new CoursewareCandidateCoordinator(teaching, complete, undefined, async () => ({ modelKey: selected }));
  const proposal = await coordinator.planNativeLesson("chat", "Teach red apples.", "Preserve the course", () => active);
  assert.deepEqual(proposal.units[0].pageIds, ["apple"]); assert(!operations.includes("write"));
  mutate = () => { liveText = "A blue ball"; };
  await assert.rejects(coordinator.planNativeLesson("chat", "Teach red apples.", "", () => active), /content changed/);
  liveText = "A red apple"; mutate = () => { selected = "provider/other"; };
  await assert.rejects(coordinator.planNativeLesson("chat", "Teach red apples.", "", () => active), /model changed/);
  selected = "provider/model"; mutate = () => { active = false; };
  await assert.rejects(coordinator.planNativeLesson("chat", "Teach red apples.", "", () => active), /owner changed/);
});
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
  const teaching = { isAdoptedTeachingDocument: async () => false, async withSaved(id, operation) { assert.equal(id, "chat"); await duringSaved?.(); return operation(host, "job", snapshot, structuredClone(editor)); },
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
    { type: "speech", text: "Look! A red apple.", pauseAfterMs: 4000 }, { type: "speech", text: "Thank you for trying." }]);
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
    assert(system.includes("For spoken teaching use speech blocks."));
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
    { type: "speech", text: "观察苹果。\n说说你的发现。" }]);
  assert.equal(staged.write.actions.map(action => action.text).join(""), "观察苹果。\n说说你的发现。");
  assert.notEqual(f.project.teachingRevision, before.teachingRevision);
  assert.deepEqual(f.project.pages.slice(1), before.pages.slice(1));
});

test("supplied lesson-plan wording remains exact and bypasses generated-language review", async () => {
  const f = setup();
  const context = await f.context();
  const text = "教师应该引导学生观察。设计意图是比较两个数。";
  const receipt = await f.coordinator.selectNarrationSource("chat", { kind: "external", baseline: context.baseline, text }, () => true);
  assert.equal(f.requests.length, 0);
  assert.equal(f.calls.find(([method]) => method === "courseware.narration.save")[1].write.actions[0].text, text);
  assert.equal(receipt.diagnostics?.some(d => /Narration language review/.test(d.message)) ?? false, false);
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

test("current reviewed redo and confirmed batch capabilities survive source selection before narration", async () => {
  const f = setup(); f.project.pages.forEach(page => { page.actions = []; }); const calls = [];
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

test("page image redo and style batch capabilities disappear once narration exists", async () => {
  const f = setup(); const calls = [];
  const scope = { reviewId: "review-current", pageIds: f.project.pages.map((page) => page.pageId) };
  const redo = {
    visuals: { approved: async () => { calls.push("visual"); return { view: { projectId: f.project.projectId, pageId: f.project.pages[0].pageId, sourceSha256: f.snapshot.sha256 } }; } },
    style: { confirmedScope: async () => { calls.push("scope"); return scope; } },
  };
  const coordinator = new CoursewareCandidateCoordinator(f.teaching, async () => { throw new Error("No model call for frozen image stage"); }, redo);
  authoringUrl = "file:///private-fixture-authoring.mjs";
  try {
    const context = await coordinator.execute("chat", "ppt_get_narration_context", {}, () => true);
    assert.deepEqual(context.capabilities, ["page-narration", "page-fade"]);
    await assert.rejects(coordinator.execute("chat", "ppt_propose_page_redo", { kind: "page-pptx", baseline: context.baseline, instruction: "Redo" }, () => true), /frozen after narration/);
    await assert.rejects(coordinator.execute("chat", "ppt_propose_page_style_batch", { kind: "page-style-batch", baseline: context.baseline, styleBatch: scope }, () => true), /frozen after narration/);
  } finally { authoringUrl = undefined; }
  assert.deepEqual(calls, ["visual", "scope"]);
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
      ["ppt_propose_page_redo", { kind: "page-pptx", baseline: context.baseline, instruction: "Redo" }, /frozen after narration/],
      ["ppt_propose_page_style_batch", { kind: "page-style-batch", baseline: context.baseline, styleBatch: scope }, /frozen after narration/],
    ]) await assert.rejects(coordinator.execute("chat", name, args, () => true), expected);
    assert(!f.calls.some(([method]) => method === "courseware.narration.save"));
  } finally { authoringUrl = undefined; }
});

test("native generated narration keeps page requirements, live targets and adopted clips through rewrite and repair", async () => {
  const f = setup(async () => ({ modelKey: "provider/model" })), page = f.project.pages[0];
  page.actions.push({ id: "bound", type: "native_animation", version: 1, sourceSha256: f.project.source.sha256, stepIndex: 0 });
  page.actions.push({ id: "song", type: "audio_clip", audioAssetId: "music-" + "b".repeat(64), durationMs: 1500 });
  f.project.taskType = "plain";
  const teaching = { pageType: "slide", phase: "explore", objective: "Name the apple", durationSeconds: 30, requiredObjects: ["apple"] };
  const captured = () => ({ view: { nativeTeaching: true, viewId: "native-page", pageId: page.pageId, pageNumber: 1, project: structuredClone(f.project), teaching, teachingRequirements: [{ pageId: page.pageId, teaching }] },
    text: "A red apple.", editor: { ...f.editor, readOnly: false }, evidence: { width: 1280, height: 720, notes: "Point at the apple.", visualSummary: "A red apple.",
      objects: [{ objectId: "apple", name: "apple", kind: "shape", text: "", bbox: [10, 20, 80, 80], aliases: ["apple"] }] } });
  const writes = [];
  f.teaching.native = async (operation, args) => {
    if (operation === "narration-visual") {
      const png = Buffer.alloc(24); png.writeUInt32BE(0x89504e47); png.writeUInt32BE(1280, 16); png.writeUInt32BE(720, 20);
      return { value: { dataUrl: "data:image/png;base64," + png.toString("base64") } };
    }
    if (operation === "narration-context") return { value: captured() };
    assert.equal(operation, "write"); writes.push(args);
    page.actions = structuredClone(args.actions); f.project.teachingRevision += "saved";
    return { value: captured().view };
  };
  const originalComplete = f.coordinator.complete;
  let focusRepairs = 0;
  f.coordinator.complete = async args => {
    if (JSON.parse(args.messages[0].content).reviewKind === 'narration_semantics') return { text: JSON.stringify({ issues: [] }) };
    if (args.system.startsWith('Plan a coherent course')) return { text: JSON.stringify({ goal: 'Name the apple', pages: [{ pageNumber: 1, purpose: 'Name', bridge: 'Practice', focus: 'apple' }] }) };
    if (args.system.startsWith('Repair only synchronized effects')) { focusRepairs++; return { text: JSON.stringify({ focuses: [] }) }; }
    return originalComplete(args);
  };
  await f.coordinator.proposeNativeNarration("chat", 1, "Explain the apple", () => true);
  const input = JSON.parse(f.requests[0].messages[0].content);
  assert.deepEqual(input.coursePlan.teaching, teaching);
  assert.equal(input.evidence.objects[0].objectId, "apple");
  assert.equal(input.evidence.notes, "Point at the apple.");
  assert.equal(writes[0].actions.find(action => action.id === "song").audioAssetId, "music-" + "b".repeat(64));
  assert.equal(writes[0].actions.find(action => action.id === "song").durationMs, 1500);
  assert.deepEqual(writes[0].actions.find(action => action.id === "bound"), { id: "bound", type: "native_animation", version: 1, sourceSha256: f.project.source.sha256, stepIndex: 0 });
  const before = page.actions.filter(action => action.type === "speech").map(action => action.text);
  await f.coordinator.proposeNativeNarration("chat", 1, "Preserve speech", () => true, true);
  assert.deepEqual(page.actions.filter(action => action.type === "speech").map(action => action.text), before);
  assert.equal(f.requests.length, 1, "a satisfied repair never regenerates speech or buys replacement media");
  assert.equal(focusRepairs, 1, "effect repair uses its own validated delta, not generated speech");
});

for (const policy of ["preserve", "generate-missing", "silent"]) test(`native selected narration respects ${policy} source policy before any write`, async () => {
  const f = setup(), page = f.project.pages[0];
  const enrichment = { schemaVersion: "deckwise-teaching-enrichment/1", originalPages: f.project.pages.map((p, i) => ({ pageId: p.pageId, pageNumber: i + 1 })),
    script: { sha256: "a".repeat(64), policy: policy === "silent" ? "revise" : policy, segments: [{ id: "source", text: "Existing narration", sourceLine: 1,
      pageId: policy === "silent" ? f.project.pages[1].pageId : page.pageId, actionId: page.actions[0].id }], silentPageIds: policy === "silent" ? [page.pageId] : [] } };
  f.teaching.native = async operation => {
    assert.equal(operation, "narration-context");
    return { value: { view: { viewId: "native-page", pageId: page.pageId, pageNumber: 1, project: structuredClone(f.project), enrichment },
      editor: f.editor, text: "A red apple." } };
  };
  const context = await f.context();
  await assert.rejects(f.coordinator.selectNarrationSource("chat", { kind: "external", baseline: context.baseline, text: "Replacement" }, () => true),
    policy === "silent" ? /intentionally silent/ : /policy prevents/);
  assert.equal(f.requests.length, 0);
  assert.equal(page.actions[0].text, "Existing narration");
});

for (const taskType of ['plain', 'scene', 'import']) test(`${taskType}: native retry budget survives runtime and editor recreation within one turn`, async () => {
  const project = { schemaVersion: shared.COURSEWARE_CONTRACT_VERSION, projectId: 'native', taskType, title: 'Father',
    source: { revision: 'R1', sha256: 'a'.repeat(64) }, teachingRevision: 'T1',
    pages: [{ pageId: 'page', locked: false, reviewState: 'review', actions: [] }] };
  const png = Buffer.alloc(24); png.writeUInt32BE(0x89504e47, 0); png.writeUInt32BE(1280, 16); png.writeUInt32BE(720, 20);
  const teaching = { isAdoptedTeachingDocument: async () => taskType === 'scene', native: async op => {
    if (op === 'narration-visual') return { value: { dataUrl: `data:image/png;base64,${png.toString('base64')}` } };
    assert.equal(op, 'narration-context');
    return { value: { editor: { projectId: 'native', documentId, sessionId: 'chat', editGeneration: 1 },
      view: { project: structuredClone(project), pageId: 'page', viewId: 'view' }, text: 'father',
      evidence: { width: 1280, height: 720, notes: '', objects: [{ objectId: 'father', kind: 'text', text: 'father', bbox: [0,0,100,100] }] } } };
  } };
  let turnId = 'turn-1', plans = 0, speech = 0, documentId = 'doc';
  let stored = { revision: 0, failures: { page: 'Required repair pending' } };
  const retryStore = { read: async () => structuredClone(stored), writeNarration: async (_session, _project, previous, narration) => {
    assert.equal(previous.revision, stored.revision);
    stored = { ...stored, revision: stored.revision + 1, narration: structuredClone(narration) };
    return structuredClone(stored);
  } };
  const complete = async request => {
    const data = JSON.parse(request.messages[0].content);
    if (data.outline) {
      plans++;
      return { text: JSON.stringify({ goal: 'Read', pages: [{ pageNumber: 1, purpose: 'Read', focus: 'father', bridge: 'Continue' }] }) };
    }
    assert.equal(Object.values(stored.narration.pages)[0].attempts, speech % 3 + 1, 'Reserve before model call');
    speech++;
    return { text: JSON.stringify({ blocks: [{ type: 'speech', text: 'Read father.', attention: { type: 'highlight', objectIds: ['unknown'] } }] }) };
  };
  const create = () => new CoursewareCandidateCoordinator(teaching, complete, undefined, async () => ({ modelKey: 'test' }), () => turnId, undefined, retryStore);
  let coordinator = create();
  const generate = instruction => coordinator.proposeNativeNarrationBatch('chat', [1], instruction, () => true);
  const first = await generate('Read father');
  assert.equal(first.failures[0].retriable, false); assert.equal(speech, 3); assert.equal(plans, 1);
  project.source.sha256 = 'b'.repeat(64);
  const repeated = await generate('Use a shorter instruction');
  assert.equal(repeated.failures[0].code, 'COURSEWARE_NARRATION_RETRY_EXHAUSTED');
  assert.equal(speech, 3); assert.equal(plans, 1);
  documentId = 'reopened-doc'; coordinator = create();
  const resumed = await generate('Resume unchanged document');
  assert.equal(resumed.failures[0].code, 'COURSEWARE_NARRATION_RETRY_EXHAUSTED');
  assert.equal(speech, 3); assert.equal(plans, 1);
  assert.equal(stored.failures.page, 'Required repair pending');
  turnId = 'turn-2';
  await generate('Try again');
  assert.equal(speech, 6); assert.equal(plans, 2);
});

test("activity review checks the question against real page context and rejects missing answer conditions", async () => {
  let request;
  const coordinator = new CoursewareCandidateCoordinator({}, async input => {
    request = input; return { text: JSON.stringify({ valid: false, reason: 'Specify the light direction before choosing front or back.' }) };
  }, undefined, async () => ({ modelKey: 'review/model' }));
  const data = { question: 'Where is the shadow?', response: { kind: 'single', options: ['front', 'back'], answerIndices: [1] },
    pageText: 'Shadows can be in front or behind.', planEvidence: 'The answer is back.' };
  await assert.rejects(coordinator.reviewNativeActivity('chat', data, () => true), /Specify the light direction/);
  assert.deepEqual(JSON.parse(request.messages[0].content), data);
  assert.equal(request.includeSessionContext, false);
  assert(request.system.includes('self-authored lesson plan'));
  assert(request.system.includes('activityTitle'));
  assert(request.system.includes('A shared topic alone is insufficient'));
  assert(request.system.includes('cannot supply an absent teaching objective'));
  assert(request.system.includes('A text-only extraction does not prove that an illustration is absent'));
  assert(request.system.includes('Source-page facts can support a recall question'));
  assert(request.system.includes('activityPage.visibleText'));
  assert(request.system.includes('Reading prices on this page requires prices on the activity page'));
});

test("activity review leaves room for model reasoning before its bounded JSON verdict", async () => {
  const coordinator = new CoursewareCandidateCoordinator({}, async input => {
    // The real provider used 1,822 reasoning tokens before its 155-token verdict.
    return { text: input.maxOutputTokens !== undefined && input.maxOutputTokens < 1977
      ? 'We need answer JSON {valid, reason}. Need evaluate proposed teaching question'
      : JSON.stringify({ valid: true, reason: 'Supported by the source.' }) };
  }, undefined, async () => ({ modelKey: 'review/model' }));
  await coordinator.reviewNativeActivity('chat', { question: 'Show left and right.' }, () => true);
});

test('document runtime forwards its authorized vision completion into the native batch', async () => {
  const completeVision = async () => ({ text: 'review' });
  let batch;
  const candidateExports = {};
  new Function('require', 'exports', outputText)(id => id === './courseware-native-narration'
    ? { generateNativeNarration: async input => { batch = input; return { saved: true }; } }
    : id === '@pi-desktop/shared' ? shared : id === '@pi-desktop/agent-runtime' ? runtime : {}, candidateExports);
  let coordinator;
  const runtimeExports = {};
  const code = ts.transpileModule(readFileSync(new URL('../electron/main/courseware-document-runtime.ts', import.meta.url), 'utf8'),
    { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true } }).outputText;
  const Empty = class {};
  new Function('require', 'exports', code)(id => {
    if (id === './courseware-teaching') return { CoursewareTeachingCoordinator: class { async isAdoptedTeachingDocument() { return true; } } };
    if (id === './courseware-candidates') return { CoursewareCandidateCoordinator: class extends candidateExports.CoursewareCandidateCoordinator {
      constructor(...args) { super(...args); coordinator = this; }
    } };
    if (id === './courseware-native-assessment-media') return { createNativeAssessmentMedia: () => ({ assessments: {} }) };
    if (id === './courseware-native-tools') return { CoursewareNativeTools: class { execute() {} } };
    if (id === './courseware-native-repairs') return { nativeRepairStore: () => ({ marker: 'durable' }) };
    return new Proxy({}, { get: () => Empty });
  }, runtimeExports);
  for (const background of [false, true]) {
    runtimeExports.createCoursewareDocumentRuntime({ editor: {}, scope: { sessionId: 'chat', workspace: '/lesson' }, background,
      complete: async () => ({ text: '' }), completeVision, resolveModel: async () => ({ modelKey: 'provider/model' }),
      activeTurns: new Map([['chat', 'turn']]), getHost: () => ({}) });
    await coordinator.proposeNativeNarrationBatch('chat', [1], 'Explain', () => true);
    assert.equal(batch.frozenArtwork, true);
    assert.equal(batch.completeVision, completeVision, 'native review must receive the authorized vision callback');
    assert.equal(batch.retryStore.marker, 'durable');
    assert.equal(batch.turnId, 'turn');
  }
});

test('activity review repairs malformed verdicts without changing the proposed question or retrying a rejection', async () => {
  const activity = { question: '6 times 2?', answer: '12', analysis: 'multiply' };
  for (const response of ['{', '{}', JSON.stringify({ valid: true, reason: '' })]) {
    let calls = 0;
    const candidate = new CoursewareCandidateCoordinator({}, async request => {
      const data = JSON.parse(request.messages[0].content); assert.deepEqual(data.activity ?? data, activity);
      if (++calls > 1) assert(data.repair.error);
      return { text: calls === 1 ? response : JSON.stringify({ valid: true, reason: '' }) };
    }, undefined, async () => ({ modelKey: 'fixture' }));
    await candidate.reviewNativeActivity('chat', activity, () => true);
    assert.equal(calls, response.startsWith('{"valid"') ? 1 : 2);
  }
  let calls = 0;
  const candidate = new CoursewareCandidateCoordinator({}, async () => { calls++; return { text: '{"valid":false,"reason":"Incorrect answer"}' }; },
    undefined, async () => ({ modelKey: 'fixture' }));
  await assert.rejects(candidate.reviewNativeActivity('chat', activity, () => true), /Incorrect answer/);
  assert.equal(calls, 1, 'A rejected question needs actual content correction, not a repeated review');
});
