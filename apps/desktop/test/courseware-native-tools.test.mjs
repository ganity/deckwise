import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import * as handshake from "../electron/main/ppt-editor-handshake.ts";
import ts from "typescript";
import * as authoring from "../../../packages/courseware-runtime/dist/authoring.mjs";
import * as runtime from "../../../packages/courseware-runtime/dist/node.mjs";
import * as shared from "../../../packages/shared/dist/index.js";
const require = createRequire(import.meta.url), exports = {}, materials = {}, activities = {}, recovery = {};
new Function("require", "exports", ts.transpileModule(readFileSync(new URL("../electron/main/courseware-native-audio-recovery.ts", import.meta.url), "utf8"), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText)(require, recovery);
new Function("require", "exports", ts.transpileModule(readFileSync(new URL("../electron/main/courseware-native-activities.ts", import.meta.url), "utf8"), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText)(id => id === "@pi-desktop/shared" ? shared : id === "@pi-desktop/courseware-runtime/node" ? runtime :
  id.startsWith("file:") ? authoring : id === "./courseware-runtime" ? { coursewareAuthoringUrl: () => new URL("../../../packages/courseware-runtime/dist/authoring.mjs", import.meta.url).href } : require(id), activities);
new Function("require", "exports", ts.transpileModule(readFileSync(new URL("../electron/main/courseware-native-materials.ts", import.meta.url), "utf8"), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText)(id => id === "@pi-desktop/shared" ? shared : require(id), materials);
new Function("require", "exports", ts.transpileModule(readFileSync(new URL("../electron/main/courseware-native-tools.ts", import.meta.url), "utf8"), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText)(id => id === "./ppt-editor-handshake" ? handshake : id === "@pi-desktop/courseware-runtime/node" ? runtime : id === "@pi-desktop/shared" ? shared : id === "./courseware-native-materials" ? materials : id === "./courseware-native-activities" ? activities : id === "./courseware-native-audio-recovery" ? recovery : require(id), exports);
const { CoursewareNativeTools } = exports;
test("full-deck recovery defers implicit saves until all original orders are adopted", async () => {
  const f = setup();
  f.project.pages[0].actions.push({ id: "extra", type: "speech", text: "More detail" });
  let pending = false, saves = 0;
  const route = async (op, args, n = 1) => {
    assert.equal(op, "open");
    return { value: structuredClone({ viewId: `native.page${n}`, pageId: `page${n}`, pageNumber: n, project: f.project }) };
  };
  const save = async () => {
    if (pending) { f.project.source.sha256 = "b".repeat(64); pending = false; saves++; }
  };
  const teaching = { async native(...args) { await save(); return route(...args); } };
  const audio = { async execute(op, args, n, view) {
    if (op === "tts:list") return view.project.pages[n - 1].actions.map(a => ({ intentId: `original-${a.id}`, actionId: a.id, current: true, model: "voice", voice: null }));
    if (op === "tts:status") return { task: { state: "ready" } };
    assert.equal(op, "tts:adopt", "Recovery must not prepare, quote or submit");
    const action = f.project.pages[n - 1].actions.find(a => `original-${a.id}` === args.intentId);
    action.audioAssetId = `audio-${action.id}`; f.project.teachingRevision += "a"; pending = true;
  } };
  const tools = new CoursewareNativeTools(teaching, {}, audio, route, () => "chat", undefined, undefined, undefined, save);
  const result = (await tools.execute("chat", "courseware_media_refresh", { kind: "tts", recover: true, sourceSha256: f.project.source.sha256 }, () => true)).value;
  assert.deepEqual(result.failures, []);
  assert.equal(result.audioReady, true);
  assert.equal(result.saved, true);
  assert.equal(saves, 1);
  assert.equal(result.sourceSha256, "b".repeat(64));
  assert.equal(result.pages.length, 3);
  const status = (await tools.execute("chat", "courseware_media_context", {}, () => true)).value;
  assert.equal(status.audioReady, true);
  assert.equal(status.completion.counts.audioReady, 3);
  assert.equal(status.completion.counts.audioMissing, 0);
  assert.deepEqual(status.jobs, []);
});
test("full-deck recovery still rejects an external source change between original orders", async () => {
  const f = setup(); let adopts = 0;
  const route = async (op, _args, n = 1) => {
    assert.equal(op, "open");
    return { value: structuredClone({ viewId: `native.page${n}`, pageId: `page${n}`, pageNumber: n, project: f.project }) };
  };
  const audio = { async execute(op, _args, n) {
    if (op === "tts:list") return [{ intentId: `original${n}`, actionId: `speech${n}`, current: true }];
    if (op === "tts:status") return { task: { state: "ready" } };
    assert.equal(op, "tts:adopt", "Recovery must not purchase replacement audio");
    adopts++; f.project.pages[0].actions[0].audioAssetId = "original-audio";
    f.project.source.sha256 = "e".repeat(64);
  } };
  const tools = new CoursewareNativeTools({ native: route }, {}, audio, route, () => "chat");
  const result = (await tools.execute("chat", "courseware_media_refresh", {
    kind: "tts", recover: true, sourceSha256: f.project.source.sha256,
  }, () => true)).value;
  assert.equal(adopts, 1);
  assert.equal(result.audioReady, false);
  assert.equal(result.saved, false);
  assert.match(result.failures[0].error, /Native source changed/);
  assert.equal(f.project.pages[1].actions[0].audioAssetId, undefined);
});
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
    if (op === "tts:prepare") return { intentId: "intent" + n, phase: "prepared" };
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

for (const taskType of ["plain", "scene", "import"]) test(`${taskType}: full-deck recovery retains audio, saves partial success and never buys replacement orders`, async () => {
  const f = setup(); f.project.taskType = taskType;
  f.project.pages = Array.from({ length: 5 }, (_, i) => ({ pageId: `page${i + 1}`, locked: false, reviewState: "review",
    actions: [{ id: `speech${i + 1}`, type: "speech", text: `Words ${i + 1}`, ...(i === 0 ? { audioAssetId: "manual-audio" } : {}) }] }));
  const operations = []; let saves = 0, failLast = true;
  const route = async (op, args, n = 1) => {
    assert.equal(op, "open"); const page = f.project.pages[n - 1];
    return { value: structuredClone({ viewId: `native.${page.pageId}`, pageId: page.pageId, pageNumber: n, project: f.project }) };
  };
  const audio = { async execute(op, args, n, view) {
    operations.push([op, view.pageId]); assert.equal(args.expectedTeachingRevision, f.project.teachingRevision);
    assert(!["tts:prepare", "tts:quote", "tts:submit"].includes(op));
    const index = Number(view.pageId.slice(4));
    if (op === "tts:list") return [{ intentId: `original${index}`, actionId: `speech${index}`, current: true, model: "voice", voice: null }];
    if (op === "tts:status") return { phase: index === 3 ? "submission-unknown" : "submitted", task: index === 3 ? null : { state: index === 4 ? "running" : "ready" } };
    assert.equal(op, "tts:adopt");
    if (index === 5 && failLast) throw new Error("Download unavailable");
    f.project.pages.find(p => p.pageId === view.pageId).actions[0].audioAssetId = `audio${index}`;
    f.project.teachingRevision += "a";
    if (index === 2) f.project.pages.reverse();
    return {};
  } };
  const tools = new CoursewareNativeTools({ native: route }, {}, audio, route, () => "chat", undefined, undefined, undefined, async () => { saves++; });
  const args = { kind: "tts", sourceSha256: f.project.source.sha256, recover: true };
  const first = (await tools.execute("chat", "courseware_media_refresh", args, () => true)).value;
  assert.equal(saves, 1); assert.equal(first.saved, false); assert.equal(first.audioReady, false);
  assert(first.pages.some(p => p.pageId === "page2" && p.applied && p.saved));
  assert(first.failures.some(p => p.pageId === "page3" && /unknown/.test(p.error)));
  assert(first.failures.some(p => p.pageId === "page5" && /Download/.test(p.error)));
  assert.equal(f.project.pages.find(p => p.pageId === "page1").actions[0].audioAssetId, "manual-audio");
  assert(!operations.some(([, page]) => page === "page1"));
  failLast = false;
  const second = (await tools.execute("chat", "courseware_media_refresh", args, () => true)).value;
  assert.equal(saves, 2); assert.equal(second.audioReady, false);
  assert.equal(f.project.pages.find(p => p.pageId === "page5").actions[0].audioAssetId, "audio5");
  assert.equal(operations.filter(([op, page]) => op === "tts:adopt" && page === "page2").length, 1);
});

test("full-deck recovery exposes ambiguous orders and respects explicit model/voice selection", async () => {
  const f = setup(); let adopted = 0;
  const route = async (op, args, n = 1) => ({ value: structuredClone({ viewId: "native.page" + n, pageId: "page" + n, pageNumber: n, project: f.project }) });
  const audio = { async execute(op) {
    if (op === "tts:list") return ["one", "two"].map(voice => ({ intentId: voice, actionId: "speech1", current: true, model: "voice", voice }));
    if (op === "tts:status") return { phase: "submitted", task: { state: "ready" } };
    assert.equal(op, "tts:adopt"); adopted++; return {};
  } };
  const tools = new CoursewareNativeTools({ native: route }, {}, audio, route, () => "chat");
  const input = { kind: "tts", sourceSha256: f.project.source.sha256, recover: true, pageNumbers: [1] };
  const ambiguous = (await tools.execute("chat", "courseware_media_refresh", input, () => true)).value;
  assert.equal(adopted, 0); assert.match(ambiguous.failures[0].error, /Multiple matching/);
  const selected = (await tools.execute("chat", "courseware_media_refresh", { ...input, model: "voice", voice: "two" }, () => true)).value;
  assert.equal(adopted, 1); assert.equal(selected.pages[0].intentId, "two");
});

test("native media preparation reuses unknown tasks without another quote and retains valid attached audio", async () => {
  const f = setup(); f.project.pages[0].actions.push({ id: "already", type: "speech", text: "Keep", audioAssetId: "manual" });
  const route = async (op, args, n = 1) => ({ value: { viewId: "native.page" + n, pageId: "page" + n, pageNumber: n, project: f.project } });
  const operations = [], audio = { async execute(op, args) {
    operations.push(op); assert.equal(op, "tts:prepare"); assert.equal(args.reuseExisting, true);
    return { intentId: "original", phase: "submission-unknown" };
  } };
  const tools = new CoursewareNativeTools({ native: route }, {}, audio, route, () => "chat");
  const result = (await tools.execute("chat", "courseware_media_prepare", { kind: "tts", pageNumber: 1, sourceSha256: f.project.source.sha256,
    model: "voice", actionIds: ["already", "speech1"] }, () => true)).value;
  assert.deepEqual(operations, ["tts:prepare"]); assert.equal(result.jobs[0].intentId, "original");
  assert.equal(result.pages[0].retained, true);
});

test("native media context protects manual audio and reports ambiguous originals instead of queuing both voices", async () => {
  const f = setup(); f.project.pages[0].actions[0].audioAssetId = "manual";
  const route = async (op, args, n = 1) => ({ value: structuredClone({ viewId: "native.page" + n, pageId: "page" + n, pageNumber: n, project: f.project }) });
  const audio = { async execute(op, args, n) {
    assert.equal(op, "tts:list");
    return [1, 2].map(i => ({ intentId: `intent-${n}-${i}`, actionId: `speech${n}`, current: true, audioReady: false }));
  } };
  const tools = new CoursewareNativeTools({ native: route }, {}, audio, route, () => "chat");
  const context = (await tools.execute("chat", "courseware_media_context", {}, () => true)).value;
  assert.deepEqual(context.jobs, []); assert.equal(context.unresolvedOriginals.length, 2);
  assert(context.unresolvedOriginals.every(i => i.pageNumber === 2));
});

test("scene acceptance reports missing narration and unresolved required object descriptions with page reasons", async () => {
  const f = setup();
  f.project.taskType = "scene";
  f.project.pages[0].actions = [];
  const teaching = { pageType: "slide", phase: "explore", objective: "Read the word", durationSeconds: 30,
    requiredObjects: ["little black"], requiredEffects: ["highlight"] };
  const view = { project: f.project, viewId: "native.page1", pageId: "page1", pageNumber: 1,
    teachingRequirements: [{ pageId: "page1", teaching }], teachingObjects: [],
    enrichmentCapabilities: { version: 1 } };
  const route = async (op, args, n = 1) => ({ value: { ...view, pageNumber: n, pageId: `page${n}`, viewId: `native.page${n}` } });
  const tools = new CoursewareNativeTools({ native: async () => ({ value: view }) }, {},
    { async execute(op) { if (op === "tts:list") return []; return {}; } }, route, () => "chat");
  const context = (await tools.execute("chat", "courseware_media_context", {}, () => true)).value;
  assert.equal(context.completion.ready, false);
  assert(context.completion.issues.some(issue => issue.pageNumber === 1 && issue.code === "NARRATION_MISSING"));
  assert(context.completion.warnings.some(issue => issue.pageNumber === 1 && issue.code === "OBJECT_BINDING_ADVISORY"));
  assert(context.completion.issues.some(issue => issue.pageNumber === 1 && issue.code === "EFFECT_MISSING"));
});

test("recovery saves a proven native adoption when its journal acknowledgment is lost", async () => {
  const f = setup(); let saves = 0;
  const route = async (op, args, n = 1) => ({ value: structuredClone({ viewId: "native.page" + n, pageId: "page" + n, pageNumber: n, project: f.project }) });
  const audio = { async execute(op) {
    if (op === "tts:list") return [{ intentId: "original", actionId: "speech1", current: true, model: "voice", voice: null }];
    if (op === "tts:status") return { phase: "submitted", task: { state: "ready" } };
    assert.equal(op, "tts:adopt"); f.project.pages[0].actions[0].audioAssetId = "verified";
    throw new Error("Journal reply lost after native adoption");
  } };
  const tools = new CoursewareNativeTools({ native: route }, {}, audio, route, () => "chat", undefined, undefined, undefined, async () => { saves++; });
  const value = (await tools.execute("chat", "courseware_media_refresh", { kind: "tts", recover: true, pageNumbers: [1], sourceSha256: f.project.source.sha256 }, () => true)).value;
  assert.equal(saves, 1); assert.equal(value.saved, false); assert.equal(value.pages[0].saved, true);
  assert.equal(value.pages[0].state, "adopted_with_error"); assert.match(value.failures[0].error, /Journal reply lost/);
});

for (const taskType of ["plain", "scene", "import"]) test(`${taskType}: lesson planning uses immutable source, existing adoption/save and never rewrites script or audio`, async () => {
  const f = setup(); f.project.taskType = taskType;
  const original = structuredClone(f.project.pages); f.project.pages[0].actions[0].audioAssetId = "kept";
  let enrichment, saves = 0, proposals = 0, source = "Teach native page 1. Discuss native page 2.";
  const sourceId = "c".repeat(64), captures = [];
  const route = async (op, args = {}, n = 1) => {
    if (op === "write") { assert.equal(args.expectedTeachingRevision, f.project.teachingRevision); enrichment = structuredClone(args.enrichment); f.project.teachingRevision += "w"; }
    else assert(["open", "narration-context"].includes(op));
    const view = structuredClone({ viewId: "native.page" + n, pageId: "page" + n, pageNumber: n, project: f.project, enrichment,
      enrichmentCapabilities: { version: 1 } });
    return { value: op === "narration-context" ? { view, editor: { editGeneration: 1, readOnly: false }, text: "Native page " + n, evidence: { notes: "" } } : view };
  };
  const candidates = { async planNativeLesson(session, text, instruction) {
    proposals++; captures.push([session, text, instruction]);
    return { view: (await route("open")).value, units: [{ id: "stage", title: "Teach", kind: "teaching", evidence: "Teach native page 1.", pageIds: ["page1"] },
      { id: "activity", title: "Discuss", kind: "checkpoint", evidence: "Discuss native page 2.", pageIds: ["page2"] }] };
  } };
  const tools = new CoursewareNativeTools({ native: route }, candidates, {}, route, () => "chat", undefined, undefined, undefined,
    async () => { saves++; }, undefined, { read: async (session, id) => { assert.equal(session, "chat"); assert.equal(id, sourceId); return { text: source }; }, list: async () => [] });
  const input = { sourceSha256: f.project.source.sha256, lessonPlan: { sourceId }, instruction: "No additional quiz", apply: false };
  const preview = (await tools.execute("chat", "courseware_narration_plan", input, () => true)).value;
  assert.equal(saves, 0); assert.equal(enrichment, undefined); assert.equal(preview.plan.units.length, 2);
  assert.deepEqual(captures, [["chat", source, "No additional quiz"]]);
  const adopted = (await tools.execute("chat", "courseware_narration_plan", { ...input, apply: true }, () => true)).value;
  assert.deepEqual(adopted.plan.units, preview.plan.units);
  assert.equal(saves, 1); assert.equal(proposals, 1); assert.equal(enrichment.plan.units[1].kind, "checkpoint");
  const again = (await tools.execute("chat", "courseware_narration_plan", { ...input, apply: true }, () => true)).value;
  assert.equal(again.reused, true); assert.equal(proposals, 1); assert.equal(saves, 1);
  source = "An explicit different lesson plan";
  const changed = (await tools.execute("chat", "courseware_narration_plan", { ...input, apply: true }, () => true)).value;
  assert.equal(changed.requiresExplicitReplacement, true); assert.equal(proposals, 1); assert.equal(saves, 1);
  assert.equal(f.project.pages[0].actions[0].audioAssetId, "kept");
  assert.deepEqual(f.project.pages[1].actions, original[1].actions);
  assert.equal(f.project.pages[0].actions[0].text, original[0].actions[0].text);
  await assert.rejects(tools.execute("chat", "courseware_narration_plan", { ...input, lessonPlan: { sourceId, text: "forged" } }, () => true), /exactly one/);
});
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

test("switching away before a native tool waits without reading the other Chat's document", async () => {
  const f = setup(); let viewing = "other", opens = 0, reads = 0;
  const current = { value: { viewId: "native.page1", pageId: "page1", pageNumber: 1, project: f.project } };
  const route = async () => { reads++; assert.equal(viewing, "chat"); return current; };
  const tools = new CoursewareNativeTools({ native: route }, {}, {}, route, () => viewing, undefined, undefined,
    async () => { opens++; assert.equal(viewing, "chat"); });
  const result = tools.execute("chat", "courseware_narration_context", {}, () => true)
    .then(value => ({ value }), error => ({ error }));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(opens, 0); assert.equal(reads, 0);
  viewing = "chat";
  const outcome = await result;
  assert.equal(outcome.error, undefined);
  assert.equal(outcome.value.value.projectId, "native"); assert.equal(opens, 1);
});

test("cancelling while waiting for the original Chat never dispatches native work", async () => {
  let active = true, calls = 0;
  const route = async () => { calls++; throw new Error("must not dispatch"); };
  const tools = new CoursewareNativeTools({ native: route }, {}, {}, route, () => "other");
  const pending = tools.execute("chat", "courseware_narration_context", {}, () => active);
  active = false;
  await assert.rejects(pending, /turn ended/);
  assert.equal(calls, 0);
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

for (const taskType of ["plain", "import", "scene"]) test(`${taskType}: new Quiz inserts a page even when original content contains the same question`, async () => {
  const f = setup(); f.project.taskType = taskType;
  const originals = structuredClone(f.project.pages);
  const view = { viewId: "native.page1", project: f.project, enrichmentCapabilities: { version: 1 }, enrichment: {
    schemaVersion: "deckwise-teaching-enrichment/1", originalPages: f.project.pages.map((p, i) => ({ pageId: p.pageId, pageNumber: i + 1 })),
    plan: { sha256: "c".repeat(64), units: [{ id: "review", title: "Round shapes", evidence: "A circle is round.", kind: "quiz", pageIds: [] }] } } };
  const calls = [];
  const teaching = { async native(op, args, n) {
    calls.push(op);
    if (op === "narration-context") return { value: { view, text: "A circle is round. Which shape is round?", editor: { editGeneration: 7 }, evidence: { width: 254, height: 142.875 } } };
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
  assert.equal(f.project.pages.length, originals.length + 1);
  assert.deepEqual([f.project.pages[0], f.project.pages[2]], originals);
  const repeated = await activities.insertNativeActivity({ view, args: { ...args, apply: true }, teaching, check() {} });
  assert.equal(repeated.reused, true); assert.equal(calls.filter(op => op === "assessment-insert").length, 1);
});

test("a new oral checkpoint validates and projects its native canvas", async () => {
  const f = setup();
  const view = { project: f.project, enrichmentCapabilities: { version: 1 }, enrichment: {
    schemaVersion: "deckwise-teaching-enrichment/1", originalPages: f.project.pages.map((p, i) => ({ pageId: p.pageId, pageNumber: i + 1 })),
    plan: { sha256: "c".repeat(64), units: [{ id: "talk", title: "Round objects", evidence: "A circle is round.", kind: "checkpoint", pageIds: [] }] } } };
  const result = await activities.insertNativeActivity({ view, args: { apply: false, unitId: "talk", afterPageId: "page1",
    question: "Name a round object around you.", referenceAnswer: { summary: "a ball", keyPoints: ["a ball"] }, referenceEvidence: "A circle is round.", response: { kind: "short_answer", options: [], answerIndices: [] } },
    check() {}, teaching: { native: async () => ({ value: { view, editor: { editGeneration: 1 }, text: "A circle is round.", evidence: { width: 254, height: 142.875 } } }) } });
  assert.equal(result.preview, true);
  assert.equal(result.response.kind, "short_answer");
  assert.equal(result.referenceAnswer.summary, "a ball");
});


test("retained audio resolves pending native attention without any provider call", async () => {
  const f = setup(); f.project.pages[0].actions[0].audioAssetId = "kept";
  f.project.pages[0].actions[0].attention = { type: "highlight", objectIds: ["word"] };
  const route = async (op, args, n = 1) => {
    if (op === "write") { assert.equal(args.expectedTeachingRevision, f.project.teachingRevision); delete f.project.pages[n - 1].actions[0].attention; f.project.teachingRevision += "w"; }
    return { value: structuredClone({ viewId: "native.page" + n, pageId: "page" + n, pageNumber: n, project: f.project }) };
  };
  const tools = new CoursewareNativeTools({ native: route }, {}, { execute() { throw Error("No provider call"); } }, route, () => "chat");
  const result = (await tools.execute("chat", "courseware_media_refresh", { kind: "tts", recover: true, pageNumbers: [1], sourceSha256: f.project.source.sha256 }, () => true)).value;
  assert.equal(result.pages[0].state, "retained_effects_repaired"); assert.equal(result.pages[0].applied, true);
  assert.equal(f.project.pages[0].actions[0].audioAssetId, "kept");
});

test('native teaching readiness is identical across context tools and requires pending option images', async () => {
  const f = setup();for (const page of f.project.pages) page.actions[0].audioAssetId = 'existing';
  const view = { viewId: 'native.page1', pageId: 'page1', pageNumber: 1, project: f.project };
  let targets = [{ kind: 'image', sceneId: 'page1', questionId: 'q', optionValue: 'A' }];
  const assessment = { execute: async () => ({ ready: false, targets }) };
  const audio = { execute: async () => [] };
  const tools = new CoursewareNativeTools({ native: async () => ({ value: view }) }, {}, audio, async () => ({ value: view }), () => 'chat', undefined, undefined, undefined, undefined, assessment);
  for (const name of ['courseware_narration_context', 'courseware_media_context']) {
    const result = (await tools.execute('chat', name, {}, () => true)).value;
    assert.equal(result.teachingReady, false, name);assert.equal(result.completion.ready, false, name);
    assert.equal(result.assessmentMedia.ready, false);assert.deepEqual(result.assessmentMedia.targets, targets);
  }
  targets = [{ kind: 'tts', sceneId: 'page1', actionId: 'missing-reading' }];
  for (const name of ['courseware_narration_context', 'courseware_media_context']) {
    const result = (await tools.execute('chat', name, {}, () => true)).value;
    assert.equal(result.teachingReady, false, name);assert.equal(result.completion.ready, false, name);
    assert.equal(result.audioReady, true, 'Saved speech remains ready even when an assessment reading is missing');
  }
});

test('native Chat narration supplies an owner-checked save between generator batches', async () => {
  const f = setup(); let saves = 0;
  const route = async (_op, _args, n = 1) => ({ value: { viewId: 'native.page'+n, pageId: 'page'+n, pageNumber: n, project: f.project } });
  const candidates = { async proposeNativeNarrationBatch(session, numbers, instruction, canDispatch, repair, persist) {
    assert.equal(session, 'chat'); assert.deepEqual(numbers, [1,2]); assert.equal(repair, false);
    assert.equal(canDispatch(), true); assert.equal(typeof persist, 'function');
    await persist(); assert.equal(saves, 1);
    return { applied: true, savedPages: numbers.map(pageNumber=>({pageNumber})), failures: [] };
  } };
  const tools = new CoursewareNativeTools({native:()=>route('open',{},1)}, candidates, {}, route, ()=>'chat', undefined, undefined, undefined,
    async (session, canDispatch) => { assert.equal(session,'chat'); assert.equal(canDispatch(),true); saves++; });
  const result = await tools.execute('chat','courseware_narration_propose',{sourceSha256:f.project.source.sha256,pageNumbers:[1,2],instruction:'Teach each page'},()=>true);
  assert.equal(result.value.saved,true); assert.equal(saves,2);
});

test('native generation rejects a 56-page tool call even when the internal generator can split it', async () => {
  const f = setup();
  f.project.pages = Array.from({length:56},(_,i)=>({pageId:'page'+(i+1),locked:false,reviewState:'review',actions:[]}));
  for (const pageNumbers of [undefined, [1,2,3,4,5,6], Array.from({length:56},(_,i)=>i+1)]) {
    await assert.rejects(f.tools.execute('chat','courseware_narration_propose',{
      pageNumbers,sourceSha256:f.project.source.sha256,instruction:'Teach the whole lesson',
    },f.active), /at most 5 pages/);
  }
  assert.equal(f.calls.filter(c=>c[0]==='narration').length,0);
  await f.tools.execute('chat','courseware_narration_propose',{
    pageNumbers:[1,2,3,4,5],sourceSha256:f.project.source.sha256,instruction:'Teach the next five pages',
  },f.active);
  assert.deepEqual(f.calls.filter(c=>c[0]==='narration').map(c=>c[1]),[1,2,3,4,5]);
});

test("completion rejects the same duplicate entrances as fixed playback", async () => {
  const f = setup();
  f.project.pages[0].actions = [1, 2].map(n => ({ id: 's' + n, type: 'speech', text: 'Circle', audioAssetId: 'audio',
    visualCues: [{ id: 'c' + n, atMs: 0, endMs: 500, trigger: { version: 1, kind: 'start' },
      effect: { type: 'element_animation', elementId: 'circle', effect: 'fadeIn' } }] }));
  const result = (await f.tools.execute('chat', 'courseware_narration_context', {}, f.active)).value;
  assert.equal(result.completion.ready, false);
  assert(result.completion.issues.some(i => i.code === 'ANIMATION_TARGET_CONFLICT' && i.pageNumber === 1));
});

test("a failed native read is reported without blindly reopening or replaying mutations", async () => {
  let reads = 0;
  const route = async () => { reads++; throw Error('Native teaching view changed'); };
  const tools = new CoursewareNativeTools({ native: route }, {}, {}, route, () => 'chat');
  await assert.rejects(tools.execute('chat', 'courseware_narration_context', {}, () => true), /view changed/);
  assert.equal(reads, 1);
  await assert.rejects(tools.execute('chat', 'courseware_narration_propose', {}, () => true), /view changed/);
  assert.equal(reads, 2);
});

test("semantic review accepts a supported paraphrase without forcing invented verbatim evidence", async () => {
  const f = setup(); let reviewed;
  const view = { project: f.project, enrichmentCapabilities: { version: 1 }, enrichment: {
    schemaVersion: 'deckwise-teaching-enrichment/1', originalPages: [{ pageId: 'page1', pageNumber: 1 }],
    plan: { sha256: 'c'.repeat(64), units: [{ id: 'quiz', title: 'Shape', kind: 'quiz', pageIds: ['page1'], evidence: 'A circle has no corners.' }] } } };
  const input = { view, args: { apply: false, unitId: 'quiz', afterPageId: 'page1', question: 'Which has no corners?',
    response: { kind: 'single', options: ['The round circle', 'The square'], answerIndices: [0] }, referenceEvidence: 'A circle has no corners.' },
    check() {}, teaching: { native: async () => ({ value: { view, text: 'A circle has no corners.', editor: { editGeneration: 1 }, evidence: { width: 254, height: 142.875 } } }) },
    review: async data => { reviewed = data; } };
  const result = await activities.insertNativeActivity(input);
  assert.equal(result.preview, true); assert.equal(reviewed.response.options[0], 'The round circle');
  assert.equal(reviewed.activityTitle, 'Shape');
  assert.deepEqual(reviewed.activityPage, { independent: true, visibleText: ['Which has no corners?', 'The round circle', 'The square'] });
  await assert.rejects(activities.insertNativeActivity({ ...input, review: async () => { throw Error('Question lacks a required condition'); } }), /required condition/);
});

test('native tools await a pending open before their first teaching read', async () => {
  const f = setup(); let ready = false;
  const route = async () => { if (!ready) throw Error('Native document opening'); return {value:{viewId:'v',pageId:'page1',pageNumber:1,project:f.project}}; };
  const tools = new CoursewareNativeTools({native:route},{},{},route,()=> 'chat',undefined,undefined,async()=>{ready=true});
  const result = await tools.execute('chat','courseware_narration_context',{},()=>true);
  assert.equal(result.value.pageCount,2);
});

test('complete media still fails completion when shared playback preflight finds a broken binding', async () => {
  const f = setup(); for (const page of f.project.pages) page.actions[0].audioAssetId = 'adopted';
  const view = { viewId: 'v', pageId: 'page1', pageNumber: 1, project: f.project };
  const route = async () => ({ value: view }); let inspections = 0;
  const tools = new CoursewareNativeTools({ native: route }, {}, { execute: async () => [] }, route, () => 'chat',
    undefined, undefined, undefined, undefined, undefined, undefined, async (_view, check) => {
      check(); inspections++; return { ready: false, sourceSha256: f.project.source.sha256, diagnostics: [],
        issues: [{ code: 'EFFECT_BINDING_MISMATCH', pageNumber: 2, pageId: 'page2', message: 'Page 2 target is missing' }] };
    });
  const result = (await tools.execute('chat', 'courseware_media_context', {}, () => true)).value;
  assert.equal(inspections, 1); assert.equal(result.audioReady, true); assert.equal(result.completion.ready, false);
  assert.equal(result.teachingReady, false); assert.equal(result.playbackPreflight.ready, false);
  assert(result.completion.issues.some(issue => issue.code === 'EFFECT_BINDING_MISMATCH' && issue.pageNumber === 2));
  await tools.execute('chat', 'courseware_media_context', {pageNumbers:[1]}, () => true);
  assert.equal(inspections, 1, 'A partial-page query must not run whole-deck completion preflight');
  delete f.project.pages[0].actions[0].audioAssetId;
  await tools.execute('chat', 'courseware_media_context', {}, () => true);
  assert.equal(inspections, 1, 'Do not reparse a whole deck while media is still being generated');
});

for (const type of ['video_slot', 'music_slot']) test(`pending ${type} without a submitted job still allows media catalog/status reads`, async () => {
  const f = setup(); for (const page of f.project.pages) page.actions[0].audioAssetId = 'adopted';
  const pending = { id: 'pending', type, prompt: 'A short teaching clip', title: 'Teaching' };
  f.project.pages[0].actions.push(pending);
  const view = { viewId: 'v', pageId: 'page1', pageNumber: 1, project: f.project };
  const route = async () => ({ value: view }); let inspections = 0;
  const models = [{ model: 'seedance', voices: [], providerDefaultVoice: false, supportsReferenceImage: true }];
  const tools = new CoursewareNativeTools({ native: route }, {}, { execute: async () => [] }, route, () => 'chat',
    { jobs: async () => [], models: async () => models }, undefined, undefined, undefined, undefined, undefined, async () => {
      inspections++;
      assert(!f.project.pages.some(page => page.actions.some(action => action.type.endsWith('_slot'))),
        'Playback parsing cannot consume an unfilled media slot');
      return { ready: true, sourceSha256: f.project.source.sha256, diagnostics: [], issues: [] };
    });
  const context = (await tools.execute('chat', 'courseware_media_context', { kind: 'video' }, () => true)).value;
  assert.equal(inspections, 0); assert.equal(context.audioReady, true); assert.equal(context.teachingReady, false);
  assert.deepEqual(context.models, models); assert.deepEqual(context.jobs, []);
  assert.equal(context.pages[0].actions.at(-1).type, type);
  f.project.pages[0].actions.pop();
  const complete = (await tools.execute('chat', 'courseware_media_context', {}, () => true)).value;
  assert.equal(inspections, 1); assert.equal(complete.playbackPreflight.ready, true);
});

test('a required object description resolves to unique verified semantics without renaming the source', async () => {
  const f = setup(); for (const page of f.project.pages) page.actions[0].audioAssetId = 'adopted';
  const view = { viewId: 'v', pageId: 'page1', pageNumber: 1, project: f.project,
    teachingRequirements: [{ pageId: 'page1', teaching: { pageType: 'slide', phase: 'opening', objective: 'Circle', durationSeconds: 30, requiredObjects: ['Circle title text carrier'] } }],
    teachingObjects: [{ objectId: 'title', name: 'Title', aliases: ['Circle heading'], role: 'Title text carrier containing the word Circle', status: 'mapped', effectTargetEligible: true }] };
  const route = async () => ({ value: view });
  const tools = new CoursewareNativeTools({native:route}, {}, {execute:async()=>[]}, route, ()=>'chat');
  const read = async (name = 'courseware_media_context') => (await tools.execute('chat', name, {}, () => true)).value;
  assert(!(await read()).completion.issues.some(issue => issue.code === 'OBJECT_REQUIREMENT_UNRESOLVED'));
  view.teachingObjects.push({...view.teachingObjects[0],objectId:'ambiguous'});
  const media = await read(), narration = await read('courseware_narration_context');
  assert(media.completion.warnings.some(issue => issue.code === 'OBJECT_BINDING_ADVISORY'));
  assert(narration.completion.warnings.some(issue => issue.code === 'OBJECT_BINDING_ADVISORY'));
  assert.equal(media.completion.ready, true);
  assert.equal(narration.completion.ready, true);
});

for (const taskType of ['plain', 'import', 'scene']) test(`${taskType}: appearance names and background props do not block otherwise complete teaching`, async () => {
  const f = setup(); f.project.taskType = taskType;
  for (const page of f.project.pages) page.actions[0].audioAssetId = 'adopted';
  const view = { viewId: 'v', pageId: 'page1', pageNumber: 1, project: f.project,
    teachingRequirements: [{ pageId: 'page1', teaching: { pageType: 'slide', phase: 'practice', objective: 'Say flying the kite', durationSeconds: 30, requiredObjects: ['燕形风筝', '公园长椅'] } }],
    teachingObjects: [{ objectId: 'kite', name: '红黄菱形风筝', aliases: ['风筝', 'kite'], status: 'mapped', effectTargetEligible: true },
      { objectId: 'background', name: 'park background', aliases: ['公园长椅'], status: 'mapped', effectTargetEligible: false }] };
  const route = async () => ({ value: view });
  const tools = new CoursewareNativeTools({ native: route }, {}, { execute: async () => [] }, route, () => 'chat');
  const result = (await tools.execute('chat', 'courseware_media_context', {}, () => true)).value;
  assert.equal(result.completion.ready, true, JSON.stringify(result.completion));
  assert(result.completion.warnings.some(w => w.code === 'OBJECT_BINDING_ADVISORY'));
  assert.deepEqual(view.teachingObjects[0].aliases, ['风筝', 'kite']);
  f.project.pages[0].actions[0].visualCues = [{ id: 'unsafe', atMs: 0, endMs: 1000,
    effect: { type: 'spotlight', elementId: 'missing-object' } }];
  const unsafe = (await tools.execute('chat', 'courseware_media_context', {}, () => true)).value;
  assert.equal(unsafe.completion.ready, false);
  assert(unsafe.completion.issues.some(issue => issue.code === 'EFFECT_TARGET_MISSING'));
});

test('native assessment audio omissions expose repairable actions instead of an empty blocked completion', async () => {
  const f = setup();
  f.project.pages[0].actions[0].audioAssetId = 'saved-body';
  const teaching = { pageType: 'quiz', phase: 'practice', objective: 'Answer', durationSeconds: 30, requiredObjects: [] };
  const view = { project: f.project, viewId: 'native.page1', pageId: 'page1', pageNumber: 1,
    teachingRequirements: [{ pageId: 'page2', teaching }] };
  const route = async (op, args, n = 1) => ({ value: { ...view, pageNumber: n, pageId: `page${n}`, viewId: `native.page${n}` } });
  const tools = new CoursewareNativeTools({ native: route }, {}, { async execute() { return []; } }, route, () => 'chat');
  const read = async () => (await tools.execute('chat', 'courseware_media_context', {}, () => true)).value;
  let result = await read();
  assert.equal(result.completion.ready, false);
  assert.deepEqual(result.completion.issues, [{ code: 'AUDIO_MISSING', pageNumber: 2, pageId: 'page2', actionId: 'speech2', repair: 'tts', repairable: true }]);
  f.project.pages[1].locked = true;
  assert.equal((await read()).completion.issues[0].repairable, false);
  f.project.pages[1].actions[0].audioAssetId = 'saved-question';
  assert.equal((await read()).completion.ready, true);
});

test('inserting after a Quiz reviews the mapped source page rather than the insertion anchor', async () => {
  const f = setup();
  const facts = 'Your front is ahead, your back is behind. Your left hand is left and your right hand is right.';
  const enrichment = { originalPages: [], sources: [], plan: { sha256: 'c'.repeat(64), units: [
    { id: 'practice', title: 'Show directions', evidence: 'Show the directions.', kind: 'checkpoint', pageIds: ['page1'] },
  ] } };
  const view = { project: f.project, viewId: 'native.page2', pageId: 'page2', pageNumber: 2, enrichment,
    enrichmentCapabilities: { version: 1 } };
  let reviewed;
  const result = await activities.insertNativeActivity({ view, check() {},
    teaching: { async native(op, args, n) {
      assert.equal(op, 'narration-context');
      return { value: { view: { ...view, pageId: 'page' + n, pageNumber: n }, editor: { editGeneration: 1 },
        text: n === 1 ? facts : 'Which direction is ahead? A. Front B. Back', evidence: { width: 1280, height: 720 } } };
    } },
    args: { apply: false, unitId: 'practice', afterPageId: 'page2', question: 'Show front, back, left and right.',
      response: { kind: 'practice', options: [], answerIndices: [] }, referenceEvidence: 'Show the directions.',
      referenceAnswer: { summary: 'Use your body and hands to show the four directions.', keyPoints: ['Left hand is left.'] } },
    review: async data => { reviewed = data; assert.equal(data.pageText, facts); },
  });
  assert.equal(result.preview, true);
  assert.deepEqual(reviewed.savedNarration, ['Native page 1']);
});
