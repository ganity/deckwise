import assert from "node:assert/strict";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as files from "node:fs/promises";
import * as paths from "node:path";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import test from "node:test";
import ts from "typescript";
import * as shared from "../../../packages/shared/dist/index.js";
import * as runtime from "@pi-desktop/agent-runtime";

const require = createRequire(import.meta.url), modules = new Map([["@pi-desktop/shared", shared], ["@pi-desktop/agent-runtime", runtime]]);
function load(name) {
  if (modules.has(name)) return modules.get(name);
  if (!name.startsWith("./")) return require(name);
  const source = fs.readFileSync(new URL(`../electron/main/${name.slice(2)}.ts`, import.meta.url), "utf8");
  const output = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
  const exports = {};
  new Function("require", "exports", output)(load, exports); modules.set(name, exports); return exports;
}
const { CoursewareSavedMedia } = load("./courseware-saved-media");
const { musicRequestHash } = load("./courseware-music-request");
const sha = "a".repeat(64), principalKey = "b".repeat(64), audio = Buffer.from([73,68,51,4,0,0,0,0,0,0,1,2,3]);
const digest = crypto.createHash("sha256").update(audio).digest("hex"), clone = v => structuredClone(v);
const candidate = "11111111-1111-4111-8111-111111111111";

async function fixture(t) {
  const directory = await files.mkdtemp(paths.join(tmpdir(), "saved-media-"));
  t.after(() => files.rm(directory, { recursive: true, force: true }));
  const project = { schemaVersion: shared.COURSEWARE_CONTRACT_VERSION, projectId: "project", taskType: "scene", title: "Greetings",
    source: { revision: "r1", sha256: sha }, teachingRevision: "t1", pages: [1,2].map(n => ({ pageId: `page-${n}`, locked: false,
      reviewState: "review", actions: [{ id: `speech-${n}`, type: "speech", text: `Hello ${n}`, source: "generated" }] })) };
  const state = { active: true, ready: false, lost: false, account: true, revision: 1, canvas: null, sourceChanged: false };
  const calls = [], posts = [], journals = new Map(), tasks = new Map(), archives = new Map();
  const scope = p => { assert.equal(p.principalKey, principalKey); assert.equal(p.sessionId, "chat"); };
  const wrap = i => clone({ intent: i, current: i.selection ? i.selection.expectedTeachingRevision === project.teachingRevision : true, audioReady: false });
  const task = i => { const base = { version: "courseware-media-v1", kind: i.request.kind, model: i.request.model,
    taskId: `task-${i.idempotencyKey}`, idempotencyKey: i.idempotencyKey, requestHash: i.requestHash,
    state: state.ready ? "ready" : "submitted", feeState: state.ready ? "settled" : "reserved", reservedPoints: 5,
    actualPoints: state.ready ? 5 : null, receiptId: state.ready ? `courseware-media:task-${i.idempotencyKey}` : null,
    assetRef: state.ready && i.request.kind !== "music" ? { assetId: "audio", sha256: digest, mime: "audio/mpeg", byteLength: audio.length } : null,
    errorCode: null }; return { ...base, ...state.taskFor?.(i.request, i) }; };
  const host = { async call(method, p) {
    calls.push([method, clone(p)]);
    if (method === "session.get") return { session: { mode: "agent", projectPath: directory } };
    if (method === "courseware.project.get") return { project: clone(project) };
    if (method === "courseware.classroom.source" && state.onNativeAnimation) return state.onNativeAnimation();
    if (method === "courseware.project.context") return { project: clone(project), nativeSaved: state.nativeSaved === true, ...(state.teaching ? { sceneObjects: {
      schemaVersion: "deckwise-scene-objects/1", sourceSha256: sha, requiresReview: true,
      pages: project.pages.map(page => ({ pageId: page.pageId, objects: [], teaching: state.teaching })) } } : {}) };
    if (method === "courseware.mediaCanvas.get") return { document: clone(state.canvas), revision: state.canvas ? "canvas" : null };
    if (method === "courseware.mediaCanvas.set") { state.canvas = clone(p.document); return { revision: "canvas" }; }
    const music = method.startsWith("courseware.mediaCanvas.music."), operation = method.slice(music ? "courseware.mediaCanvas.music.".length : "courseware.tts.".length);
    if (operation === "list") { scope(p); return { intents: [...journals.values()].filter(i => (i.request.kind !== "tts") === music).map(i => music ? wrap(i) : { ...wrap(i).intent, current: wrap(i).current, audioReady: false }) }; }
    if (operation === "prepare" || operation === "export.prepare") {
      const selection = p.selection;
      const existing = journals.get(selection?.intentId ?? p.intentId);
      if (existing) return wrap(existing);
      const parent = p.sourceIntentId ? journals.get(p.sourceIntentId) : null;
      const draft = music ? clone(parent?.draft ?? state.canvas.drafts.find(d => d.id === p.draftId)) : null;
      const speech = selection ? project.pages.find(page => page.pageId === selection.pageId).actions.find(a => a.id === selection.actionId) : null;
      const request = !music ? { kind: "tts", model: selection.model, input: speech.text, voice: selection.voice }
        : parent ? { kind: "music-export", model: p.model, input: p.candidateId } : { kind: "music", model: p.model, input: draft.prompt, music: p.music };
      const i = { ...(selection ? { selection: clone(selection), sourceSha256: sha } : { intentId: p.intentId, draft,
        candidates: [], ready: false, previews: [], ...(parent ? { sourceIntentId: p.sourceIntentId, submissionScope: parent.submissionScope } : {}) }),
        ...(p.target || parent?.target ? { target: clone(p.target ?? parent.target) } : {}), request, requestHash: music ? musicRequestHash(request) : crypto.createHash("sha256").update(JSON.stringify(request)).digest("hex"), idempotencyKey: crypto.randomUUID(), phase: "prepared", taskRef: null };
      journals.set(selection?.intentId ?? p.intentId, i); return wrap(i);
    }
    const i = journals.get(p.intentId); assert(i, method);
    if (operation === "begin") { i.phase = "submission-unknown"; i.submissionScope ??= { sessionId: "chat", teamProjectId: null }; await state.onBegin?.(); }
    if (operation === "bind") { i.phase = "submitted"; i.taskRef = clone(p.taskRef); }
    if (operation === "candidates.record") { i.candidates = clone(p.candidates); i.ready = p.ready; }
    if (operation === "audio.get") { if (!archives.has(p.intentId)) throw Object.assign(new Error("missing"), { errorCode: "COURSEWARE_NOT_FOUND" }); return clone(archives.get(p.intentId)); }
    if (operation === "audio.stage") { const saved = { audio: p.audio, asset: { id: `tts-${digest}` }, adoptedTeachingRevision: null }; archives.set(p.intentId, saved); return clone(saved); }
    if (operation === "asset.stage") { i.asset = clone(p.asset); await files.writeFile(paths.join(directory, `${digest}.bin`), Buffer.from(p.bytesBase64, "base64")); }
    if (operation === "asset.get") return { ...wrap(i), path: paths.join(directory, `${digest}.bin`) };
    if (operation === "audio.adopt") {
      assert.equal(p.expectedTeachingRevision, project.teachingRevision);
      const speech = project.pages.find(page => page.pageId === i.selection.pageId).actions.find(a => a.id === i.selection.actionId);
      speech.audioAssetId = `tts-${digest}`; project.teachingRevision = `t${++state.revision}`;
      archives.get(p.intentId).adoptedTeachingRevision = project.teachingRevision;
      return { project: clone(project) };
    }
    if (operation === "adopt") {
      assert.equal(p.expectedTeachingRevision, project.teachingRevision);
      const adoption = { pageId: p.pageId, actionId: p.slotId ?? `clip-${p.intentId}`, assetId: `music-${digest}` };
      const page = project.pages.find(page => page.pageId === p.pageId);
      const clip = { id: adoption.actionId, type: "audio_clip", audioAssetId: adoption.assetId };
      const slot = p.slotId ? page.actions.findIndex(a => a.id === p.slotId) : -1;
      if (slot >= 0) page.actions[slot] = clip;
      else if (!page.actions.some(a => a.id === adoption.actionId)) page.actions.push(clip);
      project.teachingRevision = `t${++state.revision}`; return { project: clone(project), adoption };
    }
    assert(["prepare", "get", "begin", "bind", "candidates.record", "asset.stage"].includes(operation), method);
    return wrap(i);
  } };
  const check = async () => { if (!state.active || state.sourceChanged) throw new Error("Saved courseware changed or turn stopped"); };
  const saved = { async withSaved(session, canDispatch, operation) { await check(); assert(canDispatch()); return operation({ host, project: clone(project), jobId: "parser", bytes: audio, check }); },
    async execute() { return { projectId: project.projectId, sourceSha256: project.source.sha256, teachingRevision: project.teachingRevision }; } };
  const submit = async (key, request, quote, signal, projectId, check, admit) => {
    await check?.(); if (admit) projectId = await admit();
    posts.push([key, clone(request)]);
    const i = [...journals.values()].find(i => i.idempotencyKey === key); assert.equal(i.phase, "submission-unknown");
    tasks.set(key, i); await state.onSubmit?.(request); if (state.lost) throw new Error("COURSEWARE_MEDIA_TRANSPORT_FAILED"); return task(i);
  };
  const get = async ref => task(tasks.get(ref.idempotencyKey));
  const media = { getTtsModels: async () => [{ model: "tts", voices: ["teacher"], providerDefaultVoice: true }],
    getTtsQuote: async model => ({ model, maxChars: 4000, maxPoints: 5, expiresAt: "2099-01-01T00:00:00Z" }), submitConfirmedTts: submit,
    get, findTts: async ref => tasks.has(ref.idempotencyKey) ? get(ref) : null,
    resumeUnstartedTts: async (key, request, projectId, check) => {
      if (!state.resumeUnstarted) return null;
      await check();
      return tasks.has(key) ? get({ idempotencyKey: key }) : submit(key, request);
    },
    download: async ref => ({ task: await get(ref), bytes: audio }), music: {
      models: async kind => kind === "music" ? (state.musicModels ?? [{ model: "music" }]) : (state.musicExportModels ?? [{ model: "export" }]),
      quote: async (model, kind) => { await state.onMusicQuote?.(model); return { model, kind, maxChars: 4000, maxPoints: 5, expiresAt: "2099-01-01T00:00:00Z" }; },
      submitConfirmed: submit, get, find: async ref => tasks.has(ref.idempotencyKey) ? get(ref) : null,
      candidates: async ref => ({ task: await get(ref), candidates: [{ candidateId: candidate, order: 0, state: state.ready ? "completed" : "processing", exportable: state.ready }] }),
      downloadExport: async ref => ({ task: await get(ref), bytes: audio }),
    } };
  const main = new CoursewareSavedMedia(saved, { coursewareMedia: media, getCoursewarePrincipal() { const account = state.account;
    return { key: principalKey, assertCurrent() { if (!account || state.account !== account) throw new Error("Account changed"); } }; } }, async () => { await state.onDecode?.(); return 1000; });
  return { state, project, posts, calls, journals, execute: (name, args) => main.execute("chat", name, args, () => state.active),
    prepare: extra => main.execute("chat", "courseware_media_prepare", { kind: "tts", pageNumber: 1, sourceSha256: sha, actionId: "speech-1", model: "tts", ...extra }, () => state.active) };
}

test("scene outline narration cannot reach paid TTS through single or batch preparation", async t => {
  const f = await fixture(t);
  f.project.pages[0].actions = [{ id: "narration-0", type: "speech", text: "Planning outline" }];
  for (const extra of [{ actionId: "narration-0" }, { actionId: undefined, actionIds: ["narration-0"] }]) {
    await assert.rejects(f.prepare(extra), /detailed narration.*before TTS/i);
  }
  assert.equal(f.posts.length, 0);
  assert(!f.calls.some(([method]) => method === "courseware.tts.prepare"));
  f.state.ready = true;
  f.project.pages[0].actions[0].source = "generated";
  assert.equal((await f.prepare({ actionId: "narration-0" })).saved, true);
});

test("native-saved narration fills only missing audio without rewriting other pages", async t => {
  const f = await fixture(t); f.state.ready = true; f.state.nativeSaved = true;
  const actionIds = Array.from({ length: 8 }, (_, i) => i ? `narration-${i}` : "scene-001-speech");
  f.project.pages[0].actions = actionIds.map(id => ({ id, type: "speech", text: `Saved text ${id}` }));
  f.project.pages[1].actions[0].audioAssetId = `tts-${"c".repeat(64)}`;
  const before = clone(f.project.pages);
  const result = await f.prepare({ actionId: undefined, actionIds });
  assert.equal(result.saved, true);
  assert.equal(f.posts.length, 8);
  assert.deepEqual(f.project.pages[0].actions.map(({ audioAssetId, ...action }) => action), before[0].actions);
  assert.deepEqual(f.project.pages[1], before[1]);
  await f.prepare({ actionId: undefined, actionIds });
  assert.equal(f.posts.length, 8, "saved audio is reused on replay");
  assert(!f.calls.some(([method]) => method === "courseware.narration.save"));
});

test("final adopted TTS automatically exports native animations and keeps paid audio after an export failure", async t => {
  const f = await fixture(t); f.state.ready = true;
  f.project.pages[0].actions[0].visualCues = [{ atMs: 0, endMs: 600,
    effect: { type: "element_animation", elementId: "logical-title", effect: "fadeIn" } }];
  let entered = 0;
  f.state.onNativeAnimation = () => { entered++; throw new Error("Native export boundary reached"); };
  assert.equal((await f.prepare()).saved, true);
  assert.equal(entered, 0, "do not change the source while another page still needs TTS");
  await assert.rejects(f.prepare({ pageNumber: 2, actionId: "speech-2" }), /Native export boundary reached/);
  assert.equal(entered, 1);
  assert(f.project.pages.every(page => page.actions[0].audioAssetId));
  assert.equal(f.posts.length, 2);
  await assert.rejects(f.prepare({ pageNumber: 2, actionId: "speech-2" }), /Native export boundary reached/);
  assert.equal(f.posts.length, 2, "retry native export without purchasing existing audio again");
});

test("explicit failed TTS retry retains content and receipts, submits once, and replaces the active failed job", async t => {
  const f = await fixture(t);
  const first = await f.prepare({ voice: "teacher" });
  const failedId = first.job.intentId;
  const original = clone(f.journals.get(failedId));
  f.state.taskFor = (_, intent) => intent.selection?.intentId === failedId
    ? { state: "failed", feeState: "released", actualPoints: 0, assetRef: null, errorCode: "SUPPLIER_FAILED" } : {};
  assert.equal((await f.prepare({ voice: "teacher" })).job.intentId, failedId);
  const args = { ...first.job, retryFailed: true };
  const retry = await f.execute("courseware_media_refresh", args);
  assert.notEqual(retry.job.intentId, failedId);
  assert.deepEqual(f.posts[1][1], f.posts[0][1]);
  assert.notEqual(f.posts[1][0], f.posts[0][0]);
  assert.equal((await f.execute("courseware_media_refresh", args)).job.intentId, retry.job.intentId);
  assert.equal(f.posts.length, 2);
  assert.deepEqual(f.journals.get(failedId), original);
  const context = await f.execute("courseware_media_context", {});
  assert.deepEqual(context.jobs.map(job => job.intentId), [retry.job.intentId]);
  f.state.ready = true;
  assert.equal((await f.execute("courseware_media_refresh", retry.job)).saved, true);
  assert(f.project.pages[0].actions[0].audioAssetId);
  assert.equal(f.posts.length, 2);
});

for (const state of ["submitted", "submission_unknown", "ready"]) test(`explicit retry rejects ${state} TTS without another order`, async t => {
  const f = await fixture(t);
  const first = await f.prepare();
  f.state.taskFor = () => ({ state, feeState: state === "ready" ? "settled" : "reserved", actualPoints: state === "ready" ? 5 : null });
  await assert.rejects(f.execute("courseware_media_refresh", { ...first.job, retryFailed: true }), /CONFIRMED_TERMINAL_FAILURE/);
  assert.equal(f.posts.length, 1);
});

for (const exported of [false, true]) test(`explicit music ${exported ? "export" : "generation"} retry reuses successful work and submits its successor once`, async t => {
  const f = await fixture(t);
  const first = await f.execute("courseware_media_prepare", { kind: "music", pageNumber: 1, sourceSha256: sha,
    model: "music", prompt: "An instrumental greeting", music: { title: "Greeting", instrumental: true } });
  if (exported) { f.state.ready = true; f.state.taskFor = request => request.kind === "music-export" ? { state: "submitted", feeState: "reserved", actualPoints: null } : {}; await f.execute("courseware_media_refresh", first.job); }
  const original = [...f.journals.values()].find(intent => intent.request.kind === (exported ? "music-export" : "music"));
  const originalId = original.intentId;
  const snapshot = clone(original);
  f.state.taskFor = (_, intent) => intent.intentId === originalId
    ? { state: "failed", feeState: "settled", actualPoints: 5, assetRef: null, errorCode: "SUPPLIER_FAILED" }
    : exported && intent.request.kind === "music-export" ? { state: "submitted", feeState: "reserved", actualPoints: null } : {};
  const args = { ...first.job, intentId: originalId, retryFailed: true };
  const before = f.posts.length;
  const retry = await f.execute("courseware_media_refresh", args);
  await f.execute("courseware_media_refresh", args);
  assert.equal(f.posts.length, before + 1);
  assert.deepEqual(f.posts.at(-1)[1], f.posts[exported ? 1 : 0][1]);
  assert.notEqual(f.posts.at(-1)[0], f.posts[exported ? 1 : 0][0]);
  for (const key of ["intentId", "request", "requestHash", "idempotencyKey", "taskRef"]) assert.deepEqual(f.journals.get(originalId)[key], snapshot[key]);
  const context = await f.execute("courseware_media_context", {});
  assert(!context.jobs.some(job => job.intentId === originalId && !exported));
  assert(context.jobs.some(job => job.intentId === retry.job.intentId));
  f.state.ready = true;
  f.state.taskFor = (_, intent) => intent.intentId === originalId ? { state: "failed", feeState: "settled", actualPoints: 5, assetRef: null } : {};
  assert.equal((await f.execute("courseware_media_refresh", retry.job)).saved, true);
});

test("explicit saved TTS preparation resumes an intent cancelled before dispatch using its original key", async t => {
  const f = await fixture(t);
  f.state.onBegin = () => { throw Error('stopped before dispatch'); };
  await assert.rejects(f.prepare(), /stopped before dispatch/);
  assert.equal(f.posts.length, 0);
  const context = await f.execute('courseware_media_context', { kind: 'tts' });
  const { actionId, ...job } = context.jobs[0];
  assert.equal(actionId, "speech-1");
  assert(job);
  const pending = await f.execute('courseware_media_refresh', { ...job });
  assert.equal(pending.saved, false);
  assert.equal(f.posts.length, 0, 'status remains query-only');
  f.state.onBegin = undefined; f.state.resumeUnstarted = true; f.state.ready = true;
  assert.equal((await f.prepare()).saved, true);
  assert.equal(f.posts.length, 1);
  assert.equal(f.calls.filter(([m]) => m === 'courseware.tts.prepare').length, 1);
  assert.equal(f.calls.filter(([m]) => m === 'courseware.tts.bind')[0][1].intentId, job.intentId);
});

test("saved Chat TTS reuses uncertain submissions, verifies bytes and adopts all pages without Office", async t => {
  const f = await fixture(t); f.state.lost = true;
  const retry = await f.prepare();
  assert.equal(retry.waitingFor, "service");
  f.state.lost = false;
  await f.prepare();
  assert.equal(f.posts.length, 1);
  assert.equal(retry.waitingFor, "service");
  f.state.ready = true;
  const ready = await f.execute("courseware_media_refresh", retry.job);
  assert.equal(ready.saved, true); assert.equal(ready.audioReady, true);
  assert.equal(f.project.pages[0].actions[0].audioAssetId, `tts-${digest}`);
  await f.prepare({ pageNumber: 2, actionId: "speech-2" });
  assert.equal(f.project.pages[1].actions[0].audioAssetId, `tts-${digest}`);
  const again = await f.prepare(); assert.equal(again.saved, true); assert.equal(f.posts.length, 2);
  assert(!f.calls.some(([name]) => /Office|view.open|selection/u.test(name)));
});

test("saved TTS batches generate and archive ten speeches concurrently, then adopt without revision loss", async t => {
  const f = await fixture(t); f.state.ready = true;
  const actionIds = Array.from({ length: 11 }, (_, i) => `batch-${i}`);
  f.project.pages[0].actions = actionIds.map(id => ({ id, type: "speech", text: id, source: "generated" }));
  let release, started, active = 0, peak = 0;
  const held = new Promise(resolve => { release = resolve; });
  const firstTen = new Promise(resolve => { started = resolve; });
  let releaseDecode, decodingStarted, decoding = 0, decodePeak = 0;
  const decodeGate = new Promise(resolve => { releaseDecode = resolve; });
  const firstTenDecoding = new Promise(resolve => { decodingStarted = resolve; });
  f.state.onDecode = async () => {
    decodePeak = Math.max(decodePeak, ++decoding);
    if (decoding === 10) decodingStarted();
    await decodeGate; decoding--;
  };
  f.state.onSubmit = async () => {
    peak = Math.max(peak, ++active);
    if (f.posts.length === 10) started();
    await held; active--;
  };
  const batch = f.prepare({ actionId: undefined, actionIds });
  await firstTen;
  assert.equal(f.posts.length, 10);
  assert(!f.calls.some(([method]) => method === "courseware.tts.audio.adopt"));
  release();
  await firstTenDecoding;
  assert(!f.calls.some(([method]) => method === "courseware.tts.audio.adopt"));
  releaseDecode();
  const result = await batch;
  assert.equal(peak, 10);
  assert.equal(decodePeak, 10);
  assert.equal(result.saved, true);
  assert.equal(result.results.length, 11);
  assert.deepEqual(result.failures, []);
  assert(f.project.pages[0].actions.every(a => a.audioAssetId === `tts-${digest}`));
  const methods = f.calls.map(([method]) => method);
  assert.equal(methods.filter(m => m === "courseware.tts.audio.stage").length, 11);
  assert.equal(methods.filter(m => m === "courseware.tts.audio.adopt").length, 11);
  assert.equal(methods.slice(0, methods.indexOf("courseware.tts.audio.adopt")).filter(m => m === "courseware.tts.audio.stage").length, 10);
  await f.prepare({ actionId: undefined, actionIds });
  assert.equal(f.posts.length, 11, "replaying a completed batch reuses all saved audio");
});

test("TTS batch keeps successful audio when decoding fails and resumes the original failed segment without repurchasing", async t => {
  const f = await fixture(t); f.state.ready = true;
  const actionIds = ["one", "two", "three"];
  f.project.pages[0].actions = actionIds.map(id => ({ id, type: "speech", text: id }));
  let decodes = 0;
  f.state.onDecode = () => { if (++decodes === 1) throw new Error("decoder failed"); };
  const result = await f.prepare({ actionId: undefined, actionIds });
  assert.equal(result.saved, false);
  assert.equal(result.failures.length, 1);
  assert.match(result.failures[0].error, /decoder failed/);
  assert.equal(result.results.filter(r => r.saved).length, 2);
  assert.equal(f.project.pages[0].actions.filter(a => a.audioAssetId).length, 2);
  const recovered = await f.prepare({ actionId: undefined, actionIds });
  assert.equal(recovered.saved, true, JSON.stringify(recovered));
  assert.equal(f.posts.length, 3);
  assert(f.project.pages[0].actions.every(a => a.audioAssetId));
});

test("TTS batch refuses invalid IDs before any paid request and preserves teaching edited during decoding", async t => {
  const f = await fixture(t); f.state.ready = true;
  for (const actionIds of [[], ["speech-1", "speech-1"], ["missing"], Array(101).fill("speech-1")])
    await assert.rejects(f.prepare({ actionId: undefined, actionIds }), /Invalid saved TTS batch/);
  for (const intentIds of [[], ["one", "one"], Array(101).fill("one"), ["../foreign"]])
    await assert.rejects(f.execute("courseware_media_refresh", { kind: "tts", sourceSha256: sha, pageNumber: 1, intentIds }), /Invalid saved TTS batch/);
  assert.equal(f.posts.length, 0);
  f.state.onDecode = () => { f.project.teachingRevision = "manual"; f.project.pages[0].actions[0].text = "Manual revision"; };
  const result = await f.prepare({ actionId: undefined, actionIds: ["speech-1"] });
  assert.equal(result.saved, false);
  assert.match(result.failures[0].error, /teaching changed/);
  assert.equal(f.project.pages[0].actions[0].text, "Manual revision");
  assert.equal(f.project.pages[0].actions[0].audioAssetId, undefined);
});

test("TTS batch retains terminal provider diagnostics alongside successful audio", async t => {
  const f = await fixture(t); f.state.ready = true;
  f.project.pages[0].actions.push({ id: "failed-speech", type: "speech", text: "Failed" });
  f.state.taskFor = request => request.input === "Failed" ? { state: "failed", feeState: "released", errorCode: "TTS_PROVIDER_FAILED" } : {};
  const result = await f.prepare({ actionId: undefined, actionIds: ["speech-1", "failed-speech"] });
  assert.equal(result.saved, false);
  assert.equal(result.waitingFor, null);
  assert.equal(result.results.find(r => r.actionId === "speech-1").saved, true);
  const failed = result.results.find(r => r.actionId === "failed-speech");
  assert.equal(failed.media.task.state, "failed");
  assert.equal(failed.media.task.errorCode, "TTS_PROVIDER_FAILED");
  await f.prepare({ actionId: undefined, actionIds: ["speech-1", "failed-speech"] });
  assert.equal(f.posts.length, 2);
});

test("cancelling an active TTS batch fences adoption and never starts the next wave", async t => {
  const f = await fixture(t); f.state.ready = true;
  const actionIds = Array.from({ length: 11 }, (_, i) => `speech-${i}`);
  f.project.pages[0].actions = actionIds.map(id => ({ id, type: "speech", text: id }));
  let release, started;
  const gate = new Promise(resolve => { release = resolve; });
  const firstTen = new Promise(resolve => { started = resolve; });
  f.state.onSubmit = async () => { if (f.posts.length === 10) started(); await gate; };
  const running = f.prepare({ actionId: undefined, actionIds });
  const cancelled = assert.rejects(running, /turn stopped/);
  await firstTen; f.state.active = false; release();
  await cancelled;
  assert.equal(f.posts.length, 10);
  assert(!f.project.pages[0].actions.some(a => a.audioAssetId));
});

test("pending TTS batch receipts recover through the same jobs without duplicate paid submissions", async t => {
  const f = await fixture(t); f.state.lost = true;
  const actionIds = Array.from({ length: 11 }, (_, i) => `pending-${i}`);
  f.project.pages[0].actions = actionIds.map(id => ({ id, type: "speech", text: id }));
  const pending = await f.prepare({ actionId: undefined, actionIds });
  assert.equal(pending.saved, false);
  assert.equal(pending.jobs.length, 11);
  assert.equal(pending.waitingFor, "service");
  assert.deepEqual(pending.failures, []);
  f.state.lost = false; f.state.ready = true;
  let active = 0, peak = 0, release, started;
  const gate = new Promise(resolve => { release = resolve; });
  const decoding = new Promise(resolve => { started = resolve; });
  f.state.onDecode = async () => { peak = Math.max(peak, ++active); if (active === 10) started(); await gate; active--; };
  const intentIds = pending.jobs.map(job => job.intentId);
  const refreshing = f.execute("courseware_media_refresh", { kind: "tts", sourceSha256: sha, pageNumber: 1, intentIds });
  await decoding;
  assert(!f.calls.some(([method]) => method === "courseware.tts.audio.adopt"));
  release();
  const recovered = await refreshing;
  assert.equal(recovered.saved, true, JSON.stringify(recovered));
  assert.equal(peak, 10);
  assert.equal(f.posts.length, 11);
});

test("course music creates a durable draft, exports MP3 and mounts a real clip without replacing narration", async t => {
  const f = await fixture(t);
  const input = { kind: "music", sourceSha256: sha, pageNumber: 2, model: "music", prompt: "Hello, hello!", music: { title: "Hello Song", instrumental: false } };
  const pending = await f.execute("courseware_media_prepare", input);
  assert.equal(pending.waitingFor, "service");
  assert.equal((await f.execute("courseware_media_context", {})).jobs.length, 1);
  await f.execute("courseware_media_prepare", input); assert.equal(f.posts.length, 1);
  f.state.ready = true;
  const ready = await f.execute("courseware_media_refresh", pending.job);
  assert.equal(ready.saved, true); assert.equal(f.posts.length, 2);
  assert.deepEqual(f.posts.map(([, request]) => request.kind), ["music", "music-export"]);
  assert.equal(f.project.pages[1].actions[0].text, "Hello 2");
  assert.equal(f.project.pages[1].actions[1].type, "audio_clip");
  assert.equal((await f.execute("courseware_media_context", {})).jobs.length, 0);
  assert.equal((await f.execute("courseware_media_prepare", input)).saved, true);
  assert.equal(f.posts.length, 2);
});

test("music refresh accepts its export ID and returns the canonical job without repurchasing", async t => {
  const f = await fixture(t);
  const pending = await f.execute("courseware_media_prepare", { kind: "music", sourceSha256: sha, pageNumber: 2,
    model: "music", prompt: "Hello!", music: { title: "Hello" } });
  f.state.ready = true;
  f.state.taskFor = request => request.kind === "music-export" ? { state: "submitted", feeState: "reserved", assetRef: null } : {};
  const exporting = await f.execute("courseware_media_refresh", pending.job);
  assert.equal(exporting.media.operation, "music-export");
  assert.notEqual(exporting.media.intentId, pending.job.intentId);
  const job = { ...pending.job, intentId: exporting.media.intentId };
  await assert.rejects(f.execute("courseware_media_refresh", { ...job, pageNumber: 1 }), /another saved page/);
  const waiting = await f.execute("courseware_media_refresh", job);
  assert.deepEqual(waiting.job, pending.job);
  f.state.taskFor = undefined;
  assert.equal((await f.execute("courseware_media_refresh", job)).saved, true);
  assert.equal(f.posts.length, 2);
});

test("a saved music slot reuses its original order despite changed generation parameters", async t => {
  const f = await fixture(t);
  f.project.pages[1].actions.push({ id: "opening-song", type: "music_slot", title: "Hello", prompt: "Hello" });
  const input = { kind: "music", sourceSha256: sha, pageNumber: 2, actionId: "opening-song",
    model: "music", prompt: "Hello!", music: { title: "Hello" } };
  const original = await f.execute("courseware_media_prepare", input);
  const retry = await f.execute("courseware_media_prepare", { ...input, prompt: "Hello again!", music: { title: "Opening Hello Song", tags: "gentle" } });
  assert.equal(retry.job.intentId, original.job.intentId);
  assert.equal(f.posts.length, 1);
  const duplicate = clone(f.journals.get(original.job.intentId));
  duplicate.intentId = "historical-duplicate";
  duplicate.draft.id = duplicate.draft.id.slice(0, -24) + "e".repeat(24);
  f.journals.set(duplicate.intentId, duplicate);
  f.state.ready = true;
  assert.equal((await f.execute("courseware_media_refresh", original.job)).saved, true);
  assert.equal((await f.execute("courseware_media_context", {})).jobs.length, 0);
  assert.equal((await f.execute("courseware_media_prepare", input)).saved, true);
  const revision = f.project.teachingRevision;
  assert.equal((await f.execute("courseware_media_refresh", original.job)).saved, true);
  assert.equal(f.project.teachingRevision, revision);
  assert.equal(f.posts.length, 2);
});

test("saved TTS recovers submitted and unstarted jobs rebound by a verified native save", async t => {
  for (const unstarted of [false, true]) {
    const f = await fixture(t);
    if (unstarted) {
      f.state.onBegin = () => { throw Error("stopped before dispatch"); };
      await assert.rejects(f.prepare(), /stopped before dispatch/);
      f.state.onBegin = undefined; f.state.resumeUnstarted = true;
    } else await f.prepare();
    const intent = [...f.journals.values()][0];
    f.project.source = { revision: "r2", sha256: "c".repeat(64) };
    intent.boundSource = clone(f.project.source);
    const context = await f.execute("courseware_media_context", { kind: "tts" });
    assert.equal(context.jobs.length, 1);
    assert.equal(context.jobs[0].intentId, intent.selection.intentId);
    f.state.ready = true;
    const result = await f.prepare({ sourceSha256: f.project.source.sha256 });
    assert.equal(result.saved, true);
    assert.equal(f.posts.length, 1);
    assert.equal(f.journals.size, 1);
  }
});

test("an uncertain music export is recovered without purchasing another export", async t => {
  const f = await fixture(t);
  const input = { kind: "music", sourceSha256: sha, pageNumber: 2, model: "music", prompt: "Hello!", music: { title: "Hello" } };
  const pending = await f.execute("courseware_media_prepare", input);
  f.state.ready = true; f.state.lost = true;
  const recovering = await f.execute("courseware_media_refresh", pending.job);
  assert.equal(recovering.saved, true);
  assert.equal(f.posts.length, 2);
  f.state.lost = false;
  const ready = await f.execute("courseware_media_refresh", pending.job);
  assert.equal(ready.saved, true); assert.equal(f.posts.length, 2);
});

test("changed source, stopped turn, locked page and foreign page jobs cannot save media", async t => {
  const f = await fixture(t);
  await assert.rejects(f.prepare({ sourceSha256: "c".repeat(64) }), /source changed/);
  f.project.pages[0].locked = true; await assert.rejects(f.prepare(), /locked/);
  f.project.pages[0].locked = false;
  const pending = await f.prepare();
  await assert.rejects(f.execute("courseware_media_refresh", { ...pending.job, pageNumber: 2 }), /INVALID_JOURNAL/);
  const { intentId, ...batch } = pending.job;
  const foreign = await f.execute("courseware_media_refresh", { ...batch, pageNumber: 2, intentIds: [intentId] });
  assert.equal(foreign.saved, false);
  assert.match(foreign.failures[0].error, /INVALID_JOURNAL/);
  f.state.active = false;
  await assert.rejects(f.execute("courseware_media_refresh", pending.job), /stopped/);
  assert.equal(f.project.pages[0].actions[0].audioAssetId, undefined);
});

test("saved video recovers an uncertain original task and only adopts decoded archived output", async () => {
  const { savedVideo } = load("./courseware-saved-video");
  const page = { pageId: "p1", locked: false, actions: [{ id: "slot", type: "video_slot", prompt: "A turning square" }] };
  const project = { projectId: "project", source: { revision: "r1", sha256: sha }, teachingRevision: "t1", pages: [page] };
  const intent = { intentId: "video-intent", principalKey, projectId: "project", pageId: "p1", slotId: "slot", source: clone(project.source),
    model: "video", prompt: "A turning square", idempotencyKey: "video-key", requestHash: "c".repeat(64), phase: "prepared", taskRef: null, asset: null };
  let posts = 0, found = false, ready = false, decoded = 0;
  const bytes = Buffer.alloc(24); bytes.write("ftyp", 4);
  const assetSha = crypto.createHash("sha256").update(bytes).digest("hex");
  const task = () => ({ taskId: "original", idempotencyKey: intent.idempotencyKey, requestHash: intent.requestHash,
    state: ready ? "ready" : "submitted", feeState: ready ? "settled" : "reserved", assetRef: { sha256: assetSha } });
  const saved = { project, check: async () => {}, host: { async call(method, p) {
    assert.equal(p.projectId, "project"); assert.equal(p.sessionId, "chat");
    if (method === "courseware.project.get") return { project: clone(project) };
    assert.equal(p.principalKey, principalKey);
    if (method === "courseware.video.begin") { assert.equal(intent.phase, "prepared"); intent.phase = "submission-unknown"; intent.submissionScope = { sessionId: "chat", teamProjectId: null }; }
    if (method === "courseware.video.bind") { assert.equal(p.taskRef.taskId, "original"); intent.phase = "submitted"; intent.taskRef = clone(p.taskRef); }
    if (method === "courseware.video.stage") { assert.equal(decoded, 1); assert.equal(p.asset.sha256, assetSha); assert.deepEqual(Buffer.from(p.bytesBase64, "base64"), bytes); intent.asset = p.asset; }
    if (method === "courseware.video.adopt") { assert(intent.asset); assert.equal(p.expectedTeachingRevision, "t1"); page.actions[0] = { id: "slot", type: "video_clip", videoAssetId: `video-${assetSha}` }; intent.phase = "adopted"; return { project }; }
    return { intent: clone(intent) };
  } } };
  const auth = { getCoursewarePrincipal: () => ({ key: principalKey, assertCurrent() {} }), coursewareMedia: { video: {
    quote: async () => ({}), submit: async (key, request, quote, projectId, check, admit) => { await check(); await admit(); posts++; throw new Error("COURSEWARE_MEDIA_TRANSPORT_FAILED"); },
    find: async () => found ? task() : null, get: async () => task(), download: async () => ({ task: task(), bytes }),
  } } };
  const decode = async data => { assert.deepEqual(data, bytes); decoded++; return { durationMs: 5000, width: 1280, height: 720 }; };
  const args = { pageNumber: 1, actionId: "slot", model: "video" };
  const pending = await savedVideo(args, saved, "chat", auth, decode); assert.equal(pending.waitingFor, null); assert.equal(pending.recovery, "unknown");
  found = true;
  const recovered = await savedVideo(args, saved, "chat", auth, decode); assert.equal(recovered.waitingFor, "service");
  ready = true;
  const result = await savedVideo({ pageNumber: 1, intentId: intent.intentId }, saved, "chat", auth, decode);
  assert.equal(result.saved, true); assert.equal(posts, 1); assert.equal(decoded, 1);
  assert.equal((await savedVideo(args, saved, "chat", auth, decode)).saved, true); assert.equal(posts, 1);
  page.locked = true;
  await assert.rejects(savedVideo(args, saved, "chat", auth, decode), /locked/);
});


test("saved video requires the original Host begin receipt and its submission scope", async () => {
  const { savedVideo } = load("./courseware-saved-video");
  const source = { revision: "r1", sha256: sha };
  const original = { intentId: "video-intent", principalKey, projectId: "project", pageId: "p1", slotId: "slot", source,
    model: "video", prompt: "A turning square", idempotencyKey: "video-key", requestHash: "c".repeat(64), phase: "prepared", taskRef: null, asset: null };
  for (const change of [{ submissionScope: null }, { submissionScope: { sessionId: "other", teamProjectId: null } },
    { idempotencyKey: "different-key" }, { source: { ...source, sha256: "d".repeat(64) } }]) {
    let posts = 0;
    const saved = { project: { projectId: "project", source, pages: [{ pageId: "p1", locked: false, actions: [{ id: "slot", type: "video_slot" }] }] },
      check: async () => {}, host: { async call(method) { return { intent: method.endsWith("begin")
        ? { ...original, phase: "submission-unknown", submissionScope: { sessionId: "chat", teamProjectId: null }, ...change } : original }; } } };
    const auth = { getCoursewarePrincipal: () => ({ key: principalKey, assertCurrent() {} }), coursewareMedia: { video: {
      quote: async () => ({}), submit: async (key, request, quote, project, check, admit) => { await check(); await admit(); posts++; },
    } } };
    await assert.rejects(savedVideo({ pageNumber: 1, actionId: "slot", model: "video" }, saved, "chat", auth, async () => {}), /COURSEWARE_MEDIA_INVALID_/);
    assert.equal(posts, 0);
  }
});

test("explicit video retry submits one identical successor and retains its failed original", async () => {
  const { savedVideo } = load("./courseware-saved-video");
  const { coursewareRetryIntentId } = load("./courseware-retry");
  const source = { revision: "r1", sha256: sha };
  const original = { intentId: "failed-video", principalKey, projectId: "project", pageId: "page", slotId: "slot", source,
    model: "video", prompt: "A turning square", idempotencyKey: "video-original", requestHash: "c".repeat(64), phase: "submitted",
    taskRef: { taskId: "old", idempotencyKey: "video-original", requestHash: "c".repeat(64) }, asset: null };
  const rows = new Map([[original.intentId, clone(original)]]);
  let state = "submitted", posts = 0;
  const task = id => { const intent = rows.get(id); return { taskId: id, idempotencyKey: intent.idempotencyKey, requestHash: intent.requestHash,
    state: id === original.intentId ? state : "submitted", feeState: id === original.intentId && state === "failed" ? "released" : "reserved", actualPoints: id === original.intentId && state === "failed" ? 0 : null }; };
  const saved = { project: { projectId: "project", source, pages: [{ pageId: "page", locked: false, actions: [{ id: "slot", type: "video_slot", prompt: original.prompt }] }] },
    check: async () => {}, host: { async call(method, params) {
      assert.equal(params.principalKey, principalKey);
      let row = rows.get(params.intentId);
      if (method === "courseware.video.retry") {
        const next = coursewareRetryIntentId(row.intentId);
        if (!rows.has(next)) rows.set(next, { ...clone(row), intentId: next, idempotencyKey: `video-${next}`, phase: "prepared", taskRef: null });
        row = rows.get(next);
      }
      if (method === "courseware.video.begin") { row.phase = "submission-unknown"; row.submissionScope = { sessionId: "chat", teamProjectId: null }; }
      if (method === "courseware.video.bind") { row.phase = "submitted"; row.taskRef = clone(params.taskRef); }
      return { intent: clone(row) };
    } } };
  const auth = { getCoursewarePrincipal: () => ({ key: principalKey, assertCurrent() {} }), coursewareMedia: { video: {
    get: async ref => task(ref.idempotencyKey === original.idempotencyKey ? original.intentId : coursewareRetryIntentId(original.intentId)),
    quote: async () => ({}), submit: async (key, request, quote, signal, check, admit) => {
      await check(); await admit(); posts++;
      assert.deepEqual(request, { kind: "video", model: original.model, input: original.prompt });
      return task(coursewareRetryIntentId(original.intentId));
    },
  } } };
  const args = { pageNumber: 1, intentId: original.intentId, retryFailed: true };
  await assert.rejects(savedVideo(args, saved, "chat", auth, async () => {}), /CONFIRMED_TERMINAL_FAILURE/);
  assert.equal(posts, 0);
  state = "failed";
  const retry = await savedVideo(args, saved, "chat", auth, async () => {});
  assert.equal(retry.job.intentId, coursewareRetryIntentId(original.intentId));
  await savedVideo(args, saved, "chat", auth, async () => {});
  assert.equal(posts, 1);
  assert.deepEqual(rows.get(original.intentId), original);
});

test("saved music uses its authored position, survives refresh, and keeps two slots distinct even for identical audio bytes", async t => {
  const f = await fixture(t);
  const page = f.project.pages[1];
  page.actions.push({ id: "song-one", type: "music_slot", title: "Hello", prompt: "Hello" },
    { id: "after-song", type: "speech", text: "What did you hear?" },
    { id: "song-two", type: "music_slot", title: "Hello again", prompt: "Hello" });
  const input = { kind: "music", sourceSha256: sha, pageNumber: 2, model: "music", prompt: "Hello", music: { title: "Hello" } };
  await assert.rejects(f.execute("courseware_media_prepare", input), /actionId/);
  const pending = await f.execute("courseware_media_prepare", { ...input, actionId: "song-one" });
  f.state.ready = true;
  assert.equal((await f.execute("courseware_media_refresh", pending.job)).saved, true);
  assert.deepEqual(page.actions.map(a => a.id), ["speech-2", "song-one", "after-song", "song-two"]);
  assert.equal(page.actions[1].type, "audio_clip");
  assert.equal(page.actions[3].type, "music_slot");
  assert.equal((await f.execute("courseware_media_refresh", pending.job)).saved, true);
  assert.equal((await f.execute("courseware_media_prepare", { ...input, actionId: "song-one" })).saved, true);
  assert.equal(f.posts.length, 2);
  const second = await f.execute("courseware_media_prepare", { ...input, actionId: "song-two" });
  assert.equal((await f.execute("courseware_media_refresh", second.job)).saved, true);
  assert.deepEqual(page.actions.map(a => a.type), ["speech", "audio_clip", "speech", "audio_clip"]);
  assert.equal(f.posts.length, 4);
});


test("unsupported music models fail before creating a durable intent", async t => {
  const f = await fixture(t);
  f.state.onMusicQuote = () => { throw new Error("46003 unsupported model"); };
  await assert.rejects(f.execute("courseware_media_prepare", { kind: "music", sourceSha256: sha, pageNumber: 2,
    model: "unavailable", prompt: "Hello!", music: { title: "Hello" } }));
  assert.equal(f.journals.size, 0, "invalid configuration must not become a saved job");
  assert.equal(f.posts.length, 0);
});

test("a corrected music model replaces only the never-submitted prepared request for its slot", async t => {
  const f = await fixture(t);
  f.project.pages[1].actions.push({ id: "song", type: "music_slot", title: "Hello", prompt: "Hello" });
  f.state.musicModels = [{ model: "legacy" }];
  f.state.onMusicQuote = () => { throw new Error("46003 unsupported model"); };
  const input = { kind: "music", sourceSha256: sha, pageNumber: 2, actionId: "song", model: "legacy", prompt: "Hello!", music: { title: "Hello" } };
  await assert.rejects(f.execute("courseware_media_prepare", input));
  const original = clone([...f.journals.values()][0]);
  assert.equal(original.phase, "prepared");
  f.state.musicModels = [{ model: "music" }];
  f.state.onMusicQuote = model => { assert.equal(model, "music", "the stale prepared model must not be reused"); };
  const submitted = await f.execute("courseware_media_prepare", { ...input, model: "music" });
  assert.notEqual(submitted.job.intentId, original.intentId);
  assert.deepEqual(f.journals.get(original.intentId), original, "preserve the historical unsubmitted intent");
  assert.equal(f.posts.length, 1);
  const retry = await f.execute("courseware_media_prepare", { ...input, model: "legacy", prompt: "Paraphrased" });
  assert.equal(retry.job.intentId, submitted.job.intentId, "submitted order identity takes priority over all prepared history");
  assert.equal(f.posts.length, 1);
});


test("music export recovers from a removed prepared model without replacing its generation", async t => {
  const f = await fixture(t); f.state.ready = true;
  f.state.musicExportModels = [{ model: "legacy-export" }];
  f.state.onMusicQuote = model => { if (model === "legacy-export") throw new Error("46003 unsupported export"); };
  const input = { kind: "music", sourceSha256: sha, pageNumber: 2, model: "music", prompt: "Hello!", music: { title: "Hello" } };
  const pending = await f.execute("courseware_media_prepare", input);
  await assert.rejects(f.execute("courseware_media_refresh", pending.job), /46003/);
  const original = [...f.journals.values()].find(i => i.request.kind === "music");
  f.state.musicExportModels = [{ model: "export" }];
  f.state.onMusicQuote = model => { assert.equal(model, "export"); };
  const result = await f.execute("courseware_media_refresh", { kind: "music", sourceSha256: sha, pageNumber: 2, intentId: original.intentId });
  assert.equal(result.saved, true);
  assert.deepEqual(f.posts.map(([, request]) => request.kind), ["music", "music-export"]);
});

test("automatic saved music refuses an unapproved legacy slot before purchase", async t => {
  const f = await fixture(t);
  f.state.teaching = { pageType: "slide", phase: "opening", objective: "Greet", durationSeconds: 30, requiredObjects: [] };
  f.project.pages[1].actions.push({ id: "extra", type: "music_slot", title: "Extra", prompt: "Unapproved song" });
  await assert.rejects(f.execute("courseware_media_prepare", { kind: "music", sourceSha256: sha, pageNumber: 2, actionId: "extra",
    model: "music", prompt: "Extra song", music: { title: "Extra" } }), /not approved/);
  assert.equal(f.posts.length, 0);
  assert.equal(f.journals.size, 0);
});


test("saved music follows a verified target across source save and page reorder", async t => {
  const f = await fixture(t);
  const page = f.project.pages[1];
  page.actions.push({ id: "song", type: "music_slot", title: "Hello", prompt: "Original slot prompt" });
  const pending = await f.execute("courseware_media_prepare", { kind: "music", sourceSha256: sha, pageNumber: 2,
    actionId: "song", model: "music", prompt: "Supplier lyrics", music: { title: "Hello" } });
  const original = clone(f.journals.get(pending.job.intentId));
  assert.equal(original.target.prompt, "Original slot prompt");
  f.project.source = { revision: "r2", sha256: "c".repeat(64) };
  f.project.pages.reverse();
  f.journals.get(pending.job.intentId).target.source = clone(f.project.source);
  const context = await f.execute("courseware_media_context", {});
  assert.equal(context.jobs.find(j => j.intentId === pending.job.intentId).pageNumber, 1);
  const again = await f.execute("courseware_media_prepare", { kind: "music", sourceSha256: f.project.source.sha256,
    pageNumber: 1, actionId: "song", model: "music", prompt: "Changed lyrics", music: { title: "Hello" } });
  assert.equal(again.job.intentId, pending.job.intentId);
  assert.equal(f.posts.length, 1);
  assert.deepEqual(f.journals.get(pending.job.intentId).request, original.request);
});

test("an unresolved legacy music original stays visible and cannot cause another purchase", async t => {
  const f = await fixture(t);
  f.project.pages[1].actions.push({ id: "song", type: "music_slot", title: "Hello", prompt: "Greeting" });
  const request = { kind: "music", sourceSha256: sha, pageNumber: 2, actionId: "song", model: "music", prompt: "Supplier lyrics", music: { title: "Hello" } };
  const pending = await f.execute("courseware_media_prepare", request);
  const original = f.journals.get(pending.job.intentId);
  delete original.target;
  original.unresolvedProjectId = f.project.projectId;
  f.project.source = { revision: "r2", sha256: "c".repeat(64) };
  const context = await f.execute("courseware_media_context", {});
  assert.equal(context.unresolvedOriginals[0].intentId, original.intentId);
  await assert.rejects(f.execute("courseware_media_prepare", { ...request, sourceSha256: f.project.source.sha256 }), /legacy music binding is unresolved/);
  assert.equal(f.posts.length, 1);
});
