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

const require = createRequire(import.meta.url), modules = new Map([["@pi-desktop/shared", shared]]);
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
    errorCode: null }; return base; };
  const host = { async call(method, p) {
    calls.push([method, clone(p)]);
    if (method === "session.get") return { session: { mode: "agent", projectPath: directory } };
    if (method === "courseware.project.get") return { project: clone(project) };
    if (method === "courseware.mediaCanvas.get") return { document: clone(state.canvas), revision: state.canvas ? "canvas" : null };
    if (method === "courseware.mediaCanvas.set") { state.canvas = clone(p.document); return { revision: "canvas" }; }
    const music = method.startsWith("courseware.mediaCanvas.music."), operation = method.slice(music ? "courseware.mediaCanvas.music.".length : "courseware.tts.".length);
    if (operation === "list") { scope(p); return { intents: [...journals.values()].filter(i => (i.request.kind !== "tts") === music).map(i => music ? wrap(i) : { ...wrap(i).intent, current: wrap(i).current, audioReady: false }) }; }
    if (operation === "prepare" || operation === "export.prepare") {
      const selection = p.selection;
      const parent = p.sourceIntentId ? journals.get(p.sourceIntentId) : null;
      const draft = music ? clone(parent?.draft ?? state.canvas.drafts.find(d => d.id === p.draftId)) : null;
      const speech = selection ? project.pages.find(page => page.pageId === selection.pageId).actions.find(a => a.id === selection.actionId) : null;
      const request = !music ? { kind: "tts", model: selection.model, input: speech.text, voice: selection.voice }
        : parent ? { kind: "music-export", model: p.model, input: p.candidateId } : { kind: "music", model: p.model, input: draft.prompt, music: p.music };
      const i = { ...(selection ? { selection: clone(selection), sourceSha256: sha } : { intentId: p.intentId, draft,
        candidates: [], ready: false, previews: [], ...(parent ? { sourceIntentId: p.sourceIntentId, submissionScope: parent.submissionScope } : {}) }),
        request, requestHash: music ? musicRequestHash(request) : crypto.createHash("sha256").update(JSON.stringify(request)).digest("hex"), idempotencyKey: crypto.randomUUID(), phase: "prepared", taskRef: null };
      journals.set(selection?.intentId ?? p.intentId, i); return wrap(i);
    }
    const i = journals.get(p.intentId); assert(i, method);
    if (operation === "begin") { i.phase = "submission-unknown"; i.submissionScope ??= { sessionId: "chat", teamProjectId: null }; }
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
      const adoption = { pageId: p.pageId, actionId: `clip-${p.intentId}`, assetId: `music-${digest}` };
      const page = project.pages.find(page => page.pageId === p.pageId);
      if (!page.actions.some(a => a.id === adoption.actionId)) page.actions.push({ id: adoption.actionId, type: "audio_clip", audioAssetId: adoption.assetId });
      project.teachingRevision = `t${++state.revision}`; return { project: clone(project), adoption };
    }
    assert(["prepare", "get", "begin", "bind", "candidates.record", "asset.stage"].includes(operation), method);
    return wrap(i);
  } };
  const check = async () => { if (!state.active || state.sourceChanged) throw new Error("Saved courseware changed or turn stopped"); };
  const saved = { async withSaved(session, canDispatch, operation) { await check(); assert(canDispatch()); return operation({ host, project: clone(project), jobId: "parser", bytes: audio, check }); },
    async execute() { return { projectId: project.projectId, sourceSha256: sha, teachingRevision: project.teachingRevision }; } };
  const submit = async (key, request) => {
    posts.push([key, clone(request)]);
    const i = [...journals.values()].find(i => i.idempotencyKey === key); assert.equal(i.phase, "submission-unknown");
    tasks.set(key, i); if (state.lost) throw new Error("COURSEWARE_MEDIA_TRANSPORT_FAILED"); return task(i);
  };
  const get = async ref => task(tasks.get(ref.idempotencyKey));
  const media = { getTtsModels: async () => [{ model: "tts", voices: ["teacher"], providerDefaultVoice: true }],
    getTtsQuote: async model => ({ model, maxChars: 4000, maxPoints: 5, expiresAt: "2099-01-01T00:00:00Z" }), submitConfirmedTts: submit,
    get, findTts: async ref => tasks.has(ref.idempotencyKey) ? get(ref) : null,
    download: async ref => ({ task: await get(ref), bytes: audio }), music: {
      models: async kind => [{ model: kind === "music" ? "music" : "export" }],
      quote: async (model, kind) => ({ model, kind, maxChars: 4000, maxPoints: 5, expiresAt: "2099-01-01T00:00:00Z" }),
      submitConfirmed: submit, get, find: async ref => tasks.has(ref.idempotencyKey) ? get(ref) : null,
      candidates: async ref => ({ task: await get(ref), candidates: [{ candidateId: candidate, order: 0, state: state.ready ? "completed" : "processing", exportable: state.ready }] }),
      downloadExport: async ref => ({ task: await get(ref), bytes: audio }),
    } };
  const main = new CoursewareSavedMedia(saved, { coursewareMedia: media, getCoursewarePrincipal() { const account = state.account;
    return { key: principalKey, assertCurrent() { if (!account || state.account !== account) throw new Error("Account changed"); } }; } }, async () => 1000);
  return { state, project, posts, calls, execute: (name, args) => main.execute("chat", name, args, () => state.active),
    prepare: extra => main.execute("chat", "courseware_media_prepare", { kind: "tts", pageNumber: 1, sourceSha256: sha, actionId: "speech-1", model: "tts", ...extra }, () => state.active) };
}

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
    quote: async () => ({}), submit: async () => { posts++; throw new Error("COURSEWARE_MEDIA_TRANSPORT_FAILED"); },
    find: async () => found ? task() : null, get: async () => task(), download: async () => ({ task: task(), bytes }),
  } } };
  const decode = async data => { assert.deepEqual(data, bytes); decoded++; return { durationMs: 5000, width: 1280, height: 720 }; };
  const args = { pageNumber: 1, actionId: "slot", model: "video" };
  const pending = await savedVideo(args, saved, "chat", auth, decode); assert.equal(pending.waitingFor, "service");
  found = true;
  const recovered = await savedVideo(args, saved, "chat", auth, decode); assert.equal(recovered.waitingFor, "service");
  ready = true;
  const result = await savedVideo({ pageNumber: 1, intentId: intent.intentId }, saved, "chat", auth, decode);
  assert.equal(result.saved, true); assert.equal(posts, 1); assert.equal(decoded, 1);
  assert.equal((await savedVideo(args, saved, "chat", auth, decode)).saved, true); assert.equal(posts, 1);
  page.locked = true;
  await assert.rejects(savedVideo(args, saved, "chat", auth, decode), /locked/);
});
