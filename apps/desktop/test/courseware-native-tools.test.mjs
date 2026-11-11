import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import ts from "typescript";
import * as authoring from "../../../packages/courseware-runtime/dist/authoring.mjs";
import * as runtime from "../../../packages/courseware-runtime/dist/node.mjs";
import * as shared from "../../../packages/shared/dist/index.js";
const require = createRequire(import.meta.url), exports = {}, materials = {}, activities = {};
new Function("require", "exports", ts.transpileModule(readFileSync(new URL("../electron/main/courseware-native-activities.ts", import.meta.url), "utf8"), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText)(id => id === "@pi-desktop/shared" ? shared : id === "@pi-desktop/courseware-runtime/node" ? runtime :
  id.startsWith("file:") ? authoring : id === "./courseware-runtime" ? { coursewareAuthoringUrl: () => new URL("../../../packages/courseware-runtime/dist/authoring.mjs", import.meta.url).href } : require(id), activities);
new Function("require", "exports", ts.transpileModule(readFileSync(new URL("../electron/main/courseware-native-materials.ts", import.meta.url), "utf8"), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText)(id => id === "@pi-desktop/shared" ? shared : require(id), materials);
new Function("require", "exports", ts.transpileModule(readFileSync(new URL("../electron/main/courseware-native-tools.ts", import.meta.url), "utf8"), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText)(id => id === "@pi-desktop/shared" ? shared : id === "./courseware-native-materials" ? materials : id === "./courseware-native-activities" ? activities : require(id), exports);
const { CoursewareNativeTools } = exports;
function setup() {
  const project = { schemaVersion: "deckwise-courseware/1", projectId: "native", taskType: "plain", title: "Native", source: { revision: "rev", sha256: "a".repeat(64) },
    teachingRevision: "rev", pages: [1, 2].map(n => ({ pageId: "page" + n, locked: false, reviewState: "review", actions: [{ id: "speech" + n, type: "speech", text: "Native page " + n }] })) };
  const calls = []; let active = true;
  const route = async (op, args, n) => {
    assert.equal(op, "open"); const page = project.pages[n - 1];
    return { value: structuredClone({ viewId: "native." + page.pageId, pageId: page.pageId, pageNumber: n, project }) };
  };
  const audio = { async execute(op, args, n, view) {
    calls.push([op, n]); assert.equal(view.pageNumber, n); assert.equal(args.expectedTeachingRevision, project.teachingRevision);
    if (op === "tts:prepare") return { intentId: "intent" + n };
    if (op === "tts:quote") return { quoteId: "quote" + n };
    if (op === "tts:list") return [];
    if (op === "tts:status") return { task: { state: "ready" } };
    if (op === "tts:adopt") { project.teachingRevision += "a"; return view; }
    assert.equal(op, "tts:submit"); return {};
  } };
  const candidates = { async proposeNativeNarrationBatch(session, numbers) { for (const n of numbers) calls.push(["narration", n]); return { applied: true, savedPages: numbers.map(pageNumber => ({ pageNumber })) }; } };
  const tools = new CoursewareNativeTools({ native: () => route("open", {}, 1) }, candidates, audio, route, () => "chat");
  return { tools, project, calls, active: () => active, cancel: () => { active = false; } };
}
test("Chat narration and speech use the native router for the requested page", async () => {
  const f = setup(), sourceSha256 = f.project.source.sha256;
  const context = await f.tools.execute("chat", "courseware_narration_context", {}, f.active);
  assert.equal(context.value.pages.length, 2);
  await f.tools.execute("chat", "courseware_narration_propose", { pageNumbers: [2], sourceSha256, instruction: "Explain the page" }, f.active);
  assert.deepEqual(f.calls, [["narration", 2]]);
  await f.tools.execute("chat", "courseware_media_prepare", { kind: "tts", pageNumber: 2, sourceSha256, actionId: "speech2", model: "voice" }, f.active);
  assert.deepEqual(f.calls.slice(1), [["tts:prepare", 2], ["tts:quote", 2], ["tts:submit", 2]]);
  const adopted = await f.tools.execute("chat", "courseware_media_refresh", { kind: "tts", pageNumber: 2, sourceSha256, intentId: "intent2" }, f.active);
  assert.equal(adopted.value.audioReady, true);
  f.cancel(); await assert.rejects(f.tools.execute("chat", "courseware_narration_context", {}, f.active), /owner/);
});
test("native tools reject foreign sources, pages and malformed speech batches", async () => {
  const f = setup();
  for (const input of [{ kind: "tts", pageNumber: 3, sourceSha256: f.project.source.sha256 },
    { kind: "tts", pageNumber: 1, sourceSha256: "b".repeat(64) },
    { kind: "tts", pageNumber: 1, sourceSha256: f.project.source.sha256, actionIds: ["speech1", "speech1"] }]) {
    await assert.rejects(f.tools.execute("chat", "courseware_media_prepare", input, f.active));
  }
  assert.equal(f.calls.length, 0);
});

test("a closed native document is opened before routing, without invoking legacy tools", async () => {
  const f = setup(); let opened = false, opens = 0;
  const current = { value: { viewId: "native.page1", pageId: "page1", pageNumber: 1, project: f.project } };
  const tools = new CoursewareNativeTools({ native: async () => opened ? current : undefined }, {}, {}, async () => current, () => "chat", undefined, undefined,
    async (sessionId, canDispatch) => { assert.equal(sessionId, "chat"); assert(canDispatch()); opens++; opened = true; });
  const result = await tools.execute("chat", "courseware_narration_context", {}, () => true);
  assert.equal(result.value.projectId, "native"); assert.equal(opens, 1);
});

test("native assessment context, question speech and recovery use document commands only", async () => {
  const f = setup();
  f.project.pages[1].actions.push({ id: "question", type: "interaction_checkpoint", checkpointKind: "chapter_summary", checkpointId: "checkpoint", chapterId: "chapter", chapterTitle: "Review", question: "Who is in your family?", referenceAnswer: { summary: "Family", keyPoints: [] }, context: { chapterSummary: "Family", sourceSceneIds: ["page1"] } });
  const calls = [], intents = []; let phase = "prepared", state = "running";
  const route = async (op, args, n) => {
    if (op === "write") { f.project.pages[n - 1].actions = structuredClone(args.actions); f.project.teachingRevision += "w"; }
    else assert.equal(op, "open");
    return { value: structuredClone({ viewId: "native.page" + n, pageId: "page" + n, pageNumber: n, project: f.project }) };
  };
  const audio = { async execute(op, args, n) {
    assert.equal(n, 2); calls.push(op);
    if (op === "tts:list") return intents;
    if (op === "tts:prepare") { const intent = { intentId: "original", actionId: args.actionId, current: true, model: args.model, voice: args.voice }; intents.push(intent); return intent; }
    if (op === "tts:status") return { phase, task: { state } };
    if (op === "tts:quote") return { quoteId: "quoted" };
    if (op === "tts:submit") { phase = "submission-unknown"; return {}; }
    if (op === "tts:adopt") { f.project.pages[1].actions.find(a => a.id === intents[0].actionId).audioAssetId = "embedded"; return {}; }
    assert.fail(op);
  } };
  const tools = new CoursewareNativeTools({ native: () => route("open", {}, 1) }, {}, audio, route, () => "chat");
  const context = async () => (await tools.execute("chat", "courseware_media_assessments", { mode: "context" }, () => true)).value;
  let current = await context(); assert.equal(current.ready, false); assert.equal(current.targets.length, 1);
  const request = () => ({ kind: "tts", projectId: current.projectId, expectedRevision: f.project.teachingRevision, expectedSourceRevision: f.project.source.revision,
    sceneId: "page2", actionId: current.targets[0].actionId, model: "voice" });
  await tools.execute("chat", "courseware_media_assessments", { mode: "prepare", ...request() }, () => true);
  assert.equal(f.project.pages[1].actions.at(-2).text, "Who is in your family?");
  assert.equal(f.project.pages[1].actions.at(-1).id, "question");
  await tools.execute("chat", "courseware_media_assessments", { mode: "prepare", ...request() }, () => true);
  assert.equal(calls.filter(op => op === "tts:submit").length, 1);
  state = "ready";
  const adopted = await tools.execute("chat", "courseware_media_assessments", { mode: "refresh", ...request() }, () => true);
  assert.equal(adopted.value.audioReady, true);
  assert.equal((await context()).ready, true);
  assert.equal(calls.filter(op => op === "tts:prepare").length, 1);
});


test("Chat native audio adoption saves the complete PPTX before reporting durable completion", async () => {
  const f = setup(); let saves = 0;
  const route = async (op, args, n) => ({ value: { viewId: "native.page" + n, pageId: "page" + n, pageNumber: n, project: f.project } });
  const audio = { async execute(op) {
    if (op === "tts:status") return { task: { state: "ready" } };
    assert.equal(op, "tts:adopt"); return {};
  } };
  const tools = new CoursewareNativeTools({ native: () => route("open", {}, 1) }, {}, audio, route, () => "chat", undefined, undefined, undefined,
    async () => { saves++; });
  const result = await tools.execute("chat", "courseware_media_refresh", { kind: "tts", pageNumber: 1, sourceSha256: f.project.source.sha256, intentId: "ready" }, () => true);
  assert.equal(result.value.saved, true); assert.equal(saves, 1);
  const failed = new CoursewareNativeTools({ native: () => route("open", {}, 1) }, {}, audio, route, () => "chat", undefined, undefined, undefined,
    async () => { throw Error("Save failed"); });
  await assert.rejects(failed.execute("chat", "courseware_media_refresh", { kind: "tts", pageNumber: 1, sourceSha256: f.project.source.sha256, intentId: "ready" }, () => true), /Save failed/);
});

test("generated Quiz readings retain their existing options and adopted audio without adding another speech", async () => {
  const f = setup(), checkpoint = { id: "quiz", type: "interaction_checkpoint", checkpointKind: "chapter_summary", checkpointId: "quiz", chapterId: "q", chapterTitle: "Quiz", question: "Greeting?", response: { kind: "single", options: ["Bye", "Hello"], answerIndices: [1] }, referenceAnswer: { summary: "", keyPoints: [] }, context: { chapterSummary: "Quiz", sourceSceneIds: ["page2"] } };
  f.project.pages[1].actions = [{ id: "generated-question-speech", type: "speech", text: "Greeting?\nA. Bye\nB. Hello", audioAssetId: "tts-original" }, checkpoint];
  const value = (await f.tools.execute("chat", "courseware_media_assessments", { mode: "context" }, f.active)).value;
  assert.equal(value.ready, true); assert.deepEqual(value.targets, []);
  assert.equal(f.project.pages[1].actions.length, 2);
});

test("native media context exposes configured models and reports pending attention as unfinished", async () => {
  const f = setup(); f.project.pages[0].actions[0].audioAssetId = "voice";
  f.project.pages[0].actions[0].attention = { type: "highlight", objectIds: ["label"] };
  const view = { viewId: "native.page1", pageId: "page1", pageNumber: 1, project: f.project,
    teachingRequirements: [{ pageId: "page1", teaching: { pageType: "slide", phase: "opening", objective: "Greet", durationSeconds: 30, requiredObjects: [] } }] };
  const audio = { async execute(op) { if (op === "tts:models") return [{ model: "voice" }]; assert.equal(op, "tts:list"); return []; } };
  const tools = new CoursewareNativeTools({ native: async () => ({ value: view }) }, {}, audio, async () => ({ value: view }), () => "chat");
  const result = (await tools.execute("chat", "courseware_media_context", { kind: "tts" }, () => true)).value;
  assert.equal(result.nativeTeaching, true); assert.deepEqual(result.models, [{ model: "voice" }]);
  assert.equal(result.teachingReady, false); assert.equal(result.completion.ready, false);
});


test('native Chat assessment images reuse the classroom target enumeration and generation service', async () => {
  const serviceExports = {};
  new Function('require', 'exports', ts.transpileModule(readFileSync(new URL('../electron/main/courseware-assessment-media.ts', import.meta.url), 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText)(id => id === '@pi-desktop/courseware-runtime/node' ? runtime : require(id), serviceExports);
  const view = { nativeTeaching: true, projectId: 'native', revision: 'rev', sourceRevision: 'rev', classroom: { id: 'native', createdAt: new Date(0).toISOString(), stage: { id: 'native', name: 'Quiz', createdAt: 0, updatedAt: 0 }, scenes: [{ id: 'page1', stageId: 'native', title: 'Quiz', order: 0, type: 'quiz', content: { type: 'quiz', questions: [{ id: 'q', type: 'single', question: 'Choose', options: [{ value: 'A', label: 'One' }, { value: 'B', label: 'Two' }], answer: ['A'] }] }, actions: [{ id: 'speech', type: 'speech', text: 'Choose\nA. One\nB. Two', audioId: 'tts-adopted' }], metadata: { assessmentSpeechIds: { page1: 'speech' } } }] } };
  let quotes = 0, submits = 0;
  const classroom = { open: async () => structuredClone(view), write: async args => { view.classroom = args.classroom; return structuredClone(view); } };
  const images = { models: async () => [{ model: 'image' }], quote: async () => { quotes++; return { quote: { quoteId: 'quote' } }; }, submit: async args => { assert.equal(args.optionValue, 'B'); submits++; return { state: 'running' }; }, refresh: async () => ({ state: 'running' }) };
  const assessment = new serviceExports.CoursewareAssessmentMedia(classroom, {}, images);
  const f = setup(), tools = new CoursewareNativeTools({ native: () => Promise.resolve({ value: { ...f.project, project: f.project } }) }, {}, {}, async () => {}, () => 'chat', undefined, undefined, undefined, undefined, assessment);
  const context = (await tools.execute('chat', 'courseware_media_assessments', { mode: 'context', kind: 'image' }, () => true)).value;
  assert.equal(context.ready, false); assert.equal(context.targets.length, 2); assert(context.targets.every(t => t.kind === 'image')); assert.equal(context.models[0].model, 'image');
  await tools.execute('chat', 'courseware_media_assessments', { mode: 'prepare', kind: 'image', projectId: 'native', expectedRevision: 'rev', expectedSourceRevision: 'rev', sceneId: 'page1', questionId: 'q', optionValue: 'B', model: 'image' }, () => true);
  assert.equal(quotes, 1); assert.equal(submits, 1);
});

test('saving successful native pages does not mark a partially failed narration batch complete', async () => {
  const f = setup(); let saves = 0;
  const current = { value: { viewId: 'native.page1', pageId: 'page1', pageNumber: 1, project: f.project } };
  const tools = new CoursewareNativeTools({ native: async () => current }, {
    proposeNativeNarrationBatch: async () => ({ applied: true, savedPages: [{ pageNumber: 1 }],
      failures: [{ pageNumber: 2, code: 'COURSEWARE_PAGE_CONTENT_MISMATCH', error: 'Required source content is missing' }] }),
  }, {}, async () => current, () => 'chat', undefined, undefined, undefined, async () => { saves++; });
  const result = await tools.execute('chat', 'courseware_narration_propose', { pageNumbers: [1, 2], sourceSha256: f.project.source.sha256, instruction: 'Explain both pages' }, () => true);
  assert.equal(saves, 1); assert.equal(result.value.saved, false); assert.equal(result.value.pages[0].applied, true); assert.equal(result.value.pages[0].saved, true);
  assert.equal(result.value.failures[0].pageNumber, 2);
});

test("final scripts preview, adopt, retain media, survive reorder and cannot be regenerated", async () => {
  const f = setup(); let enrichment, saves = 0, writes = 0;
  f.project.pages[0].actions[0].text = "Hello class. 1.25 kg.";
  f.project.pages[0].actions[0].audioAssetId = "already-adopted";
  const originalSpeechId = f.project.pages[0].actions[0].id;
  f.project.pages[0].actions.push({ id: "music", type: "audio_clip", audioAssetId: "song" });
  const route = async (op, args, n) => {
    if (op === "write") {
      assert.equal(args.expectedTeachingRevision, f.project.teachingRevision);
      assert.equal(args.expectedEditGeneration, 7);
      f.project.pages[n - 1].actions = structuredClone(args.actions);
      enrichment = structuredClone(args.enrichment);
      f.project.teachingRevision += "w"; writes++;
    }
    const page = f.project.pages[n - 1];
    const view = structuredClone({ viewId: "native." + page.pageId, pageId: page.pageId, pageNumber: n, project: f.project,
      enrichment, enrichmentCapabilities: { version: 1 } });
    return { value: op === "narration-context" ? { view, text: "Visible page " + n, evidence: {},
      editor: { projectId: "native", documentId: "doc", sessionId: "chat", editGeneration: 7, readOnly: false } } : view };
  };
  const tools = new CoursewareNativeTools({ native: (op, args, n = 1) => route(op, args, n) },
    { proposeNativeNarrationBatch() { assert.fail("Preserved script must not call a generator"); } }, {}, route, () => "chat",
    undefined, undefined, undefined, async () => { saves++; });
  const args = { sourceSha256: f.project.source.sha256, apply: false,
    script: { text: "P1：Hello class. 1.25 kg.\nWatch the video!\nP2: Goodbye.", policy: "preserve" } };
  const preview = (await tools.execute("chat", "courseware_narration_import", args, () => true)).value;
  assert.equal(preview.preview, true); assert.equal(preview.coverage.ready, true); assert.equal(writes, 0);
  assert.deepEqual(preview.enrichment.script.segments.map(s => s.text), ["Hello class. 1.25 kg.", "Watch the video!", "Goodbye."]);
  const applied = (await tools.execute("chat", "courseware_narration_import", { ...args, apply: true }, () => true)).value;
  assert.equal(applied.saved, true); assert.equal(writes, 2); assert.equal(saves, 1);
  assert.equal(f.project.pages[0].actions.at(-1).id, "music");
  assert.equal(f.project.pages[0].actions[0].id, originalSpeechId);
  assert.equal(f.project.pages[0].actions[0].audioAssetId, "already-adopted");
  f.project.pages[0].actions[0].audioAssetId = "retained";
  await tools.execute("chat", "courseware_narration_import", { ...args, apply: true }, () => true);
  assert.equal(f.project.pages[0].actions[0].audioAssetId, "retained");
  f.project.pages.reverse();
  const current = (await tools.execute("chat", "courseware_narration_context", {}, () => true)).value;
  assert.equal(current.enrichment.ready, true);
  await assert.rejects(tools.execute("chat", "courseware_narration_propose", { sourceSha256: f.project.source.sha256,
    pageNumbers: [1], instruction: "Regenerate all" }, () => true), /protected/);
  const before = JSON.stringify(f.project.pages);
  const retry = (await tools.execute("chat", "courseware_narration_import", { ...args, apply: false }, () => true)).value;
  assert.equal(retry.enrichment.script.segments[0].pageId, "page1");
  assert.equal(JSON.stringify(f.project.pages), before);
});

test("unmatched script, absent pages, unknown editors and false plan evidence stay explicit", async () => {
  const f = setup();
  await assert.rejects(f.tools.execute("chat", "courseware_narration_import", { sourceSha256: f.project.source.sha256,
    apply: true, script: { text: "Hello", policy: "preserve" } }, () => true), /editor/);
  const view = { project: f.project, enrichmentCapabilities: { version: 1 } };
  const preview = await materials.adoptNativeMaterials({ view, teaching: {}, check() {}, materials: { apply: false,
    script: { text: "Hello, class!\nP2: Bye.", policy: "preserve" } } });
  assert.equal(preview.coverage.ready, false);
  assert(preview.coverage.issues.some(i => i.code === "SCRIPT_UNMATCHED"));
  await assert.rejects(materials.adoptNativeMaterials({ view, teaching: {}, check() {}, materials: { apply: false,
    script: { text: "P1: One\nP2: Two", policy: "preserve", assignments: [{ segmentId: "segment-1", pageId: "page2" }] } } }), /contradicts/);
  await assert.rejects(materials.adoptNativeMaterials({ view, teaching: {}, check() {}, materials: { apply: false,
    lessonPlan: { text: "Real plan", units: [{ id: "u", title: "Review", evidence: "Invented", pageIds: [], kind: "teaching" }] } } }), /exact source/);
});

test("partial source adoption saves acknowledged pages and resumes without replacing their audio", async () => {
  const f = setup(); let enrichment, failSecond = true, saves = 0;
  const route = async (op, args, n) => {
    if (op === "write") {
      if (n === 2 && failSecond) throw Error("Second write failed");
      f.project.pages[n - 1].actions = structuredClone(args.actions); enrichment = structuredClone(args.enrichment); f.project.teachingRevision += "w";
    }
    const view = structuredClone({ viewId: "native.page" + n, pageId: "page" + n, pageNumber: n, project: f.project, enrichment, enrichmentCapabilities: { version: 1 } });
    return { value: op === "narration-context" ? { view, text: "", evidence: {}, editor: { editGeneration: 1 } } : view };
  };
  const tools = new CoursewareNativeTools({ native: (op, args, n = 1) => route(op, args, n) }, {}, {}, route, () => "chat", undefined, undefined, undefined, async () => { saves++; });
  const args = { sourceSha256: f.project.source.sha256, apply: true, script: { text: "P1: One\nP2: Two", policy: "preserve" } };
  const first = (await tools.execute("chat", "courseware_narration_import", args, () => true)).value;
  assert.equal(first.saved, false); assert.equal(first.pages.length, 1); assert.equal(first.failures.length, 1); assert.equal(saves, 1);
  f.project.pages[0].actions[0].audioAssetId = "good"; failSecond = false;
  const resumed = (await tools.execute("chat", "courseware_narration_import", args, () => true)).value;
  assert.equal(resumed.saved, true); assert.equal(resumed.coverage.ready, true); assert.equal(f.project.pages[0].actions[0].audioAssetId, "good");
});

test("source IDs resolve immutable Host text and keep raw attachment paths out of the carrier", async () => {
  const f = setup(); let called;
  const tools = new CoursewareNativeTools({ native: async () => ({ value: { project: f.project, enrichmentCapabilities: { version: 1 } } }) }, {}, {}, {}, () => "chat",
    undefined, undefined, undefined, undefined, undefined, {
      async read(sessionId, sourceId) { called = [sessionId, sourceId]; return { text: "P1: Exact stored script.\nP2: Original goodbye." }; },
      async list() { return { sources: [] }; },
    });
  const value = (await tools.execute("chat", "courseware_narration_import", { sourceSha256: f.project.source.sha256, apply: false,
    script: { sourceId: "b".repeat(64), policy: "preserve" } }, () => true)).value;
  assert.deepEqual(called, ["chat", "b".repeat(64)]);
  assert.equal(value.enrichment.script.segments[0].text, "Exact stored script.");
  assert(!JSON.stringify(value.enrichment).includes("path"));
});

test("activity reconciliation reuses the bound question and refuses unsupported or invented answers", async () => {
  const f = setup();
  const enrichment = { schemaVersion: "deckwise-teaching-enrichment/1", originalPages: f.project.pages.map((p, i) => ({ pageId: p.pageId, pageNumber: i + 1 })),
    plan: { sha256: "c".repeat(64), units: [{ id: "review", title: "Review", evidence: "A circle is round.", kind: "quiz", pageIds: ["page2"], activityId: "question" }] } };
  f.project.pages[1].actions.push({ id: "question", type: "interaction_checkpoint" });
  const view = { project: f.project, enrichment, enrichmentCapabilities: { version: 1 } };
  const reused = await activities.insertNativeActivity({ view, args: { apply: true, unitId: "review", afterPageId: "page1" }, check() {}, teaching: {} });
  assert.equal(reused.reused, true);
  delete enrichment.plan.units[0].activityId;
  const teaching = { native: async () => ({ value: { view, text: "Circle", editor: { editGeneration: 1 }, evidence: { width: 254, height: 142.875 } } }) };
  const args = { apply: false, unitId: "review", afterPageId: "page1", question: "Which is round?",
    response: { kind: "single", options: ["square", "triangle"], answerIndices: [0] }, referenceEvidence: "A circle is round." };
  await assert.rejects(activities.insertNativeActivity({ view, args, check() {}, teaching }), /not backed/);
  args.response = { kind: "practice", options: [], answerIndices: [] };
  await assert.rejects(activities.insertNativeActivity({ view, args, check() {}, teaching }), /checkpoint/);
});

test("new plan Quiz uses the existing native assessment projection and stable activity identity", async () => {
  const f = setup();
  const view = { viewId: "native.page1", project: f.project, enrichmentCapabilities: { version: 1 }, enrichment: {
    schemaVersion: "deckwise-teaching-enrichment/1", originalPages: f.project.pages.map((p, i) => ({ pageId: p.pageId, pageNumber: i + 1 })),
    plan: { sha256: "c".repeat(64), units: [{ id: "review", title: "Round shapes", evidence: "A circle is round.", kind: "quiz", pageIds: [] }] } } };
  const calls = [];
  const teaching = { async native(op, args, n) {
    calls.push(op);
    if (op === "narration-context") return { value: { view, text: "A circle is round.", editor: { editGeneration: 7 }, evidence: { width: 254, height: 142.875 } } };
    if (op === "assessment-insert") {
      assert.equal(args.expectedTeachingRevision, f.project.teachingRevision); assert.equal(args.expectedEditGeneration, 7);
      assert.equal(args.projection.slideId, args.pageId); assert.equal(args.quiz.questions.length, 1);
      assert.deepEqual(args.quiz.questions[0].answer, ["A"]);
      assert(shared.isTeachingWrite({ projectId: f.project.projectId, pageId: args.pageId, expectedSourceRevision: f.project.source.revision,
        expectedTeachingRevision: f.project.teachingRevision, actions: args.actions }), "Inserted actions must use the public teaching contract");
      const visible = args.projection.elements.filter(e => e.type === "native_text").map(e => e.content).join("\n");
      assert(visible.includes("Which shape is round?")); assert(!visible.includes("A circle is round."));
      f.project.pages.splice(n, 0, { pageId: args.pageId, locked: false, reviewState: "review", actions: args.actions });
      view.enrichment = args.enrichment;
    }
    return { value: view };
  } };
  const args = { apply: false, unitId: "review", afterPageId: "page1", question: "Which shape is round?", referenceEvidence: "A circle is round.",
    response: { kind: "single", options: ["circle", "square"], answerIndices: [0] } };
  const preview = await activities.insertNativeActivity({ view, args, teaching, check() {} });
  assert.equal(preview.preview, true); assert(!calls.includes("assessment-insert"));
  const applied = await activities.insertNativeActivity({ view, args: { ...args, apply: true }, teaching, check() {} });
  assert.equal(applied.applied, true); assert.equal(f.project.pages[1].pageId, preview.pageId);
  const repeated = await activities.insertNativeActivity({ view, args: { ...args, apply: true }, teaching, check() {} });
  assert.equal(repeated.reused, true); assert.equal(calls.filter(op => op === "assessment-insert").length, 1);
});

test("a new oral checkpoint validates and projects its native canvas", async () => {
  const f = setup();
  const view = { project: f.project, enrichmentCapabilities: { version: 1 }, enrichment: {
    schemaVersion: "deckwise-teaching-enrichment/1", originalPages: f.project.pages.map((p, i) => ({ pageId: p.pageId, pageNumber: i + 1 })),
    plan: { sha256: "c".repeat(64), units: [{ id: "talk", title: "Round objects", evidence: "A circle is round.", kind: "checkpoint", pageIds: [] }] } } };
  const result = await activities.insertNativeActivity({ view, args: { apply: false, unitId: "talk", afterPageId: "page1",
    question: "Name a round object around you.", referenceEvidence: "A circle is round.", response: { kind: "short_answer", options: [], answerIndices: [] } },
    check() {}, teaching: { native: async () => ({ value: { view, editor: { editGeneration: 1 }, text: "A circle is round.", evidence: { width: 254, height: 142.875 } } }) } });
  assert.equal(result.preview, true);
});

test("an imported visible question is reported for conversion instead of duplicated", async () => {
  const f = setup();
  const view = { project: f.project, enrichmentCapabilities: { version: 1 }, enrichment: {
    schemaVersion: "deckwise-teaching-enrichment/1", originalPages: f.project.pages.map((p, i) => ({ pageId: p.pageId, pageNumber: i + 1 })),
    plan: { sha256: "c".repeat(64), units: [{ id: "review", title: "Review", evidence: "A circle is round.", kind: "quiz", pageIds: [] }] } } };
  const result = await activities.insertNativeActivity({ view, args: { apply: true, unitId: "review", afterPageId: "page1",
    question: "Which shape is round?", referenceEvidence: "A circle is round.", response: { kind: "single", options: ["circle", "square"], answerIndices: [0] } },
    check() {}, teaching: { native: async (op, args, n) => { assert.equal(op, "narration-context");
      return { value: { view, editor: { editGeneration: 1 }, text: n === 2 ? "Which shape is round? A. circle B. square" : "A circle is round.", evidence: {} } }; } } });
  assert.equal(result.applied, false); assert.equal(result.requiresMapping, true);
  assert.deepEqual(result.duplicateCandidates, [{ pageId: "page2", question: "Which shape is round?", requiresConversion: true }]);
  assert.equal(f.project.pages.length, 2);
});
