import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import ts from "typescript";
import * as shared from "../../../packages/shared/dist/index.js";
const require = createRequire(import.meta.url), exports = {};
new Function("require", "exports", ts.transpileModule(readFileSync(new URL("../electron/main/courseware-native-tools.ts", import.meta.url), "utf8"), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText)(id => id === "@pi-desktop/shared" ? shared : require(id), exports);
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
  const candidates = { async proposeNativeNarration(session, n) { calls.push(["narration", n]); return { pageNumber: n, applied: true }; } };
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
