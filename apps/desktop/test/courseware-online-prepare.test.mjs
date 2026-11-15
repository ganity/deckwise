import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import test from "node:test";
import ts from "typescript";
import * as shared from "../../../packages/shared/dist/index.js";
import { IPC, IPC_WHITELIST } from "../../../packages/shared/dist/protocol.js";
const require = createRequire(import.meta.url);
const bytes = Buffer.from("PK\x03\x04ppt/presentation.xml[Content_Types].xml");
const hash = value => createHash("sha256").update(value).digest("hex");
const limit = 20 * 1024 * 1024;
const projectId = "22222222-2222-4222-8222-222222222222";
const revision = "33333333-3333-4333-8333-333333333333";
const seedTools = await load("courseware-online-seed", { "@pi-desktop/shared": shared });
const audioTools = await load("courseware-online-audio", { "@pi-desktop/shared": shared });
const { CoursewareOnlinePreparation } = await load("courseware-online-prepare", {
  "@pi-desktop/shared": shared, "./courseware-online-audio": audioTools,
  "./courseware-online-editing": { COURSEWARE_ONLINE_MAX_SOURCE_BYTES: limit },
  "./courseware-source-files": { sourceHash: hash, readLiveSource: async (_workspace, path) => fs.readFile(path) },
  "./courseware-online-seed": seedTools,
});
async function load(name, deps) {
  const exports = {};
  const source = await fs.readFile(new URL(`../electron/main/${name}.ts`, import.meta.url), "utf8");
  new Function("require", "exports", ts.transpileModule(source, { compilerOptions: {
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS,
  } }).outputText)(id => id.startsWith("node:") ? require(id) : deps[id] ?? assert.fail(id), exports);
  return exports;
}
async function fixture(t) {
  const workspace = await fs.mkdtemp(join(tmpdir(), "online-prepare-"));
  t.after(() => fs.rm(workspace, { recursive: true, force: true }));
  const path = join(workspace, "lesson.pptx"); await fs.writeFile(path, bytes);
  const f = { workspace, path, account: true, sessionId: "chat-1", role: "OWNER", dirty: false,
    snapshot: { path, sourcePath: path, revision: 1, sha256: hash(bytes), projectId: "local-project", documentId: "local-doc", sessionId: "local-office" },
    remote: null, remoteTeaching: null, remoteMapping: null, receipt: null, session: { projectId, active: false, epoch: 0, sessionId: null },
    task: { taskType: "import" }, events: [], fail: null, ownerWait: null };
  f.seedContext = {
    project: { schemaVersion: "deckwise-courseware/1", projectId: "office-local-doc", taskType: "import", title: "Lesson",
      source: { revision: "local-source-1", sha256: hash(bytes) }, teachingRevision: "teaching-1",
      pages: [{ pageId: "page-1", actions: [{ id: "speech-1", type: "speech", text: "Good job!", pauseAfterMs: 300 }], locked: false, reviewState: "ready" },
        { pageId: "page-2", actions: [{ id: "wait-1", type: "teacher_continue" }], locked: true, reviewState: "review" }] },
    mapping: { revision: "mapping-1", sourceSha256: hash(bytes), pages: [
      { pageId: "page-1", importPageId: "page_1", objects: [
        { objectId: "object-1", importElementId: "pptx_shape_1" }, { objectId: "object-2", importElementId: "pptx_shape_2" },
      ] }, { pageId: "page-2", importPageId: "page_2", objects: [] }] },
  };
  assert(shared.isCoursewareProject(f.seedContext.project));
  const host = { async call(method, p) {
    f.events.push([method, structuredClone(p)]);
    if (method === "courseware.project.get") return { project: structuredClone(f.seedContext.project) };
    if (f.audioHost && (method.startsWith("courseware.tts.") || method.startsWith("courseware.mediaCanvas.music."))) return f.audioHost(method, p);
    if (method === "session.get") return { session: { projectPath: workspace } };
    if (method === "courseware.task.get") return { task: f.task };
    if (method === "courseware.project.context") {
      assert.equal(p.projectId, "office-local-doc");
      return structuredClone(f.seedContext);
    }
    if (method === "courseware.onlinePrepare.get") return { receipt: structuredClone(f.receipt) };
    if (method === "courseware.onlinePrepare.begin") f.receipt = { ...p.selection, phase: "upload-pending" };
    else if (method === "courseware.onlinePrepare.advance") {
      assert.equal(f.receipt.requestId, p.requestId); assert.equal(f.receipt.phase, p.expectedPhase);
      f.receipt = { ...f.receipt, phase: p.phase, ...(p.uploadedRevision ? { uploadedRevision: p.uploadedRevision } : {}),
        ...(p.sessionEpoch ? { sessionEpoch: p.sessionEpoch } : {}) };
      if (p.phase === "bound") f.task.teamProjectId = projectId;
    } else throw new Error(method);
    return structuredClone(f.receipt);
  } };
  const client = {
    async currentTeaching() { f.events.push(["teaching-read"]); return structuredClone(f.remoteTeaching); },
    async getTeachingMapping(id, sourceRevision, mappingRevision) {
      f.events.push(["mapping-read", { id, sourceRevision, mappingRevision }]);
      assert.equal(id, projectId); assert.equal(sourceRevision, revision); assert.equal(mappingRevision, "mapping-1");
      if (!f.remoteMapping) throw new Error("PLATFORM_46607");
      return structuredClone(f.remoteMapping);
    },
    async initializeTeaching(id, input) {
      f.events.push(["teaching-init", structuredClone(input)]); assert.equal(id, projectId);
      if (f.initializedRequest) {
        assert.equal(input.requestId, f.initializedRequest);
        assert.deepEqual(input, f.initializedInput);
      } else {
        f.initializedRequest = input.requestId; f.initializedInput = structuredClone(input);
        f.remoteTeaching = { project: { ...structuredClone(input.project), teachingRevision: "remote-teaching-1" }, mappingRevision: input.mappingRevision };
        f.remoteMapping = { projectId: id, source: structuredClone(input.project.source), mapping: structuredClone(input.mapping) };
      }
      if (f.fail === "teaching") { f.fail = null; throw new Error("teaching response lost"); }
      return structuredClone(f.remoteTeaching);
    },
    async currentSource() { f.events.push(["source"]); await f.onCurrentSource?.(); return structuredClone(f.remote); },
    async current() { f.events.push(["current"]); return structuredClone(f.session); },
    async uploadSource(id, input) {
      f.events.push(["upload", input]); assert.equal(id, projectId); assert.equal(input.sourceSha256, hash(input.bytes));
      f.remote = { projectId, source: { revision, sha256: input.sourceSha256 }, byteLength: input.bytes.length,
        requestId: input.requestId, sessionEpoch: null, callbackId: null };
      if (f.fail === "upload") { f.fail = null; throw new Error("upload response lost"); }
      return structuredClone(f.remote);
    },
    async start(id, expectedEpoch, _signal, expectedSourceRevision) {
      f.events.push(["start", { id, expectedEpoch, expectedSourceRevision }]);
      assert.equal(expectedSourceRevision, revision);
      f.session = { projectId, active: true, epoch: expectedEpoch + 1, sessionId: "native-key" };
      if (f.fail === "start") { f.fail = null; throw new Error("start response lost"); }
      return structuredClone(f.session);
    },
    async bind(id, epoch) {
      f.events.push(["bind", { id, epoch }]);
      if (f.fail === "bind") { f.fail = null; throw new Error("bind response lost"); }
      return { key: "native-key", sessionEpoch: epoch, callbackUrl: "https://platform.test/callback" };
    },
  };
  const auth = {
    getCoursewarePrincipal: () => ({ key: "a".repeat(64), assertCurrent() { if (!f.account) throw new Error("account changed"); } }),
    getCoursewareOnlineClient: () => client,
    coursewareMedia: { async getTeamProjects() { if (f.ownerWait) await f.ownerWait; return [{ projectId, role: f.role }]; } },
    async joinCoursewareOnline() { return { projectId, sessionEpoch: f.session.epoch, source: f.remote.source, configJson: "private config" }; },
  };
  const editor = { sourceAdoptionSnapshot() { if (f.dirty) throw new Error("dirty editor"); return { ...f.snapshot }; },
    async verifyTeachingSource() { assert.equal(hash(await fs.readFile(path)), f.snapshot.sha256); } };
  f.media = auth.coursewareMedia;
  f.make = () => new CoursewareOnlinePreparation({ editor, auth, getHost: () => host, getWorkspace: async () => workspace,
    getSessionId: () => f.sessionId, assertOwned(id) { if (id !== f.sessionId) throw new Error("chat changed"); } });
  f.preparation = f.make();
  f.review = (includeTeaching = false) => f.preparation.review("chat-1", projectId, includeTeaching);
  f.writes = () => f.events.filter(([name]) => ["upload", "teaching-init", "start", "bind"].includes(name));
  return f;
}

test("Owner reviews without writes, explicitly confirms source/start/bind and joins the pinned generation", async t => {
  const f = await fixture(t), review = await f.review();
  assert.equal(review.fileName, "lesson.pptx"); assert.equal(review.byteLength, bytes.length);
  assert(!JSON.stringify(review).includes(f.workspace)); assert.deepEqual(f.writes(), []); assert.equal(f.receipt, null);
  const result = await f.preparation.confirm(review.reviewId);
  assert.deepEqual(f.writes().map(([name]) => name), ["upload", "start", "bind"]);
  assert(!f.events.some(([name]) => name === "teaching-read" || name === "mapping-read" || name === "courseware.project.context"));
  assert(!Object.hasOwn(f.receipt, "teaching"));
  assert.equal(f.receipt.phase, "bound"); assert.equal(f.task.teamProjectId, projectId);
  assert.deepEqual(result, { projectId, sessionEpoch: 1, source: { revision, sha256: hash(bytes) } });
  assert.equal((await f.preparation.join(projectId)).sessionEpoch, 1);
  await assert.rejects(f.preparation.confirm(review.reviewId));
});

for (const stage of ["upload", "start", "bind"]) test(`a lost ${stage} response resumes after restart using the same persisted request`, async t => {
  const f = await fixture(t), review = await f.review(); f.fail = stage;
  await assert.rejects(f.preparation.confirm(review.reviewId), /response lost/);
  const requestId = f.receipt.requestId;
  f.preparation = f.make();
  const recovered = await f.review(); assert.equal(recovered.recovering, true);
  const result = await f.preparation.confirm(recovered.reviewId);
  assert.equal(result.sessionEpoch, 1); assert.equal(f.receipt.requestId, requestId); assert.equal(f.receipt.phase, "bound");
  assert.equal(f.writes().filter(([name]) => name === "upload").length, 1);
  assert.equal(f.writes().filter(([name]) => name === "start").length, 1);
  assert.equal(f.writes().filter(([name]) => name === "bind").length, stage === "bind" ? 2 : 1);
});

test("active unrelated sessions and non-Owner accounts never perform preparation writes", async t => {
  for (const role of ["EDITOR", "VIEWER"]) {
    const f = await fixture(t); f.role = role; await assert.rejects(f.review(), /OWNER_REQUIRED/); assert.deepEqual(f.writes(), []);
  }
  const f = await fixture(t); f.session = { ...f.session, active: true, epoch: 2, sessionId: "other" };
  await assert.rejects(f.review(), /SESSION_ACTIVE/); assert.deepEqual(f.writes(), []);
});

for (const kind of ["dirty", "account", "chat", "source", "binding", "role", "remote", "epoch"]) test(`confirmation refuses changed ${kind} before upload`, async t => {
  const f = await fixture(t), review = await f.review();
  if (kind === "dirty") f.dirty = true;
  if (kind === "account") f.account = false;
  if (kind === "chat") f.sessionId = "other-chat";
  if (kind === "source") await fs.appendFile(f.path, "external");
  if (kind === "binding") f.task.teamProjectId = "other-project";
  if (kind === "role") f.role = "EDITOR";
  if (kind === "remote") f.remote = { source: { revision: "changed" } };
  if (kind === "epoch") f.session.epoch++;
  await assert.rejects(f.preparation.confirm(review.reviewId)); assert.deepEqual(f.writes(), []);
});

test("oversized sources fail before upload and a canceled asynchronous review cannot become confirmable", async t => {
  const f = await fixture(t); await fs.truncate(f.path, limit + 1);
  await assert.rejects(f.review()); assert.deepEqual(f.writes(), []);
  const second = await fixture(t); let release;
  second.ownerWait = new Promise(resolve => { release = resolve; });
  const pending = second.review();
  await new Promise(resolve => setImmediate(resolve));
  second.preparation.invalidate(); release();
  await assert.rejects(pending); assert.deepEqual(second.writes(), []);
});

test("duplicate confirms are refused and prepared join rejects a later session or source", async t => {
  const f = await fixture(t), review = await f.review();
  const pending = f.preparation.confirm(review.reviewId);
  await assert.rejects(f.preparation.confirm(review.reviewId), /BUSY/); await pending;
  f.session.epoch++;
  await assert.rejects(f.preparation.join(projectId), /CHANGED/);
  f.session.epoch--;
  f.remote.source.sha256 = "b".repeat(64);
  await assert.rejects(f.preparation.join(projectId), /CHANGED/);
});

test("recovery refuses an intervening remote replacement without any new POST", async t => {
  const f = await fixture(t), review = await f.review(); f.fail = "start";
  await assert.rejects(f.preparation.confirm(review.reviewId));
  const writes = f.writes().length; f.remote.source.revision = "other-revision";
  f.preparation = f.make(); await assert.rejects(f.review(), /CHANGED/); assert.equal(f.writes().length, writes);
});

test("an abandoned prepared entry cannot block an ordinary explicit join from another Chat", async t => {
  const f = await fixture(t), review = await f.review(); await f.preparation.confirm(review.reviewId);
  f.sessionId = "other-chat"; f.session.epoch++;
  assert.equal((await f.preparation.join(projectId)).sessionEpoch, 2);
});

test("an external file edit during remote checks is caught again immediately before upload", async t => {
  const f = await fixture(t), review = await f.review();
  f.onCurrentSource = async () => { await fs.appendFile(f.path, "external edit during GET"); f.onCurrentSource = null; };
  await assert.rejects(f.preparation.confirm(review.reviewId));
  assert.deepEqual(f.writes(), []);
  assert.equal(f.receipt.phase, "upload-pending");
});

test("optional teaching review is read-only and explicit confirmation initializes before starting", async t => {
  const f = await fixture(t), review = await f.review(true);
  assert.deepEqual(review.teaching, { pageCount: 2, narrationCount: 1 });
  assert.deepEqual(f.writes(), []); assert.equal(f.receipt, null); assert.equal(f.remoteTeaching, null);
  assert(!JSON.stringify(review).includes("Good job!"));
  await f.preparation.confirm(review.reviewId);
  assert.deepEqual(f.writes().map(([name]) => name), ["upload", "teaching-init", "start", "bind"]);
  const begin = f.events.find(([name]) => name === "courseware.onlinePrepare.begin")[1];
  const initialized = f.events.find(([name]) => name === "teaching-init")[1];
  assert.deepEqual(begin.selection.teaching, seedTools.onlineTeachingSeed(f.seedContext, "office-local-doc", hash(bytes)).pins);
  assert.deepEqual(f.receipt.teaching, begin.selection.teaching);
  assert.equal(initialized.requestId, f.receipt.requestId);
  assert.equal(initialized.mappingRevision, "mapping-1");
  assert.deepEqual(initialized.project, { ...f.seedContext.project, projectId, source: { revision, sha256: hash(bytes) } });
  assert.deepEqual(initialized.mapping, f.seedContext.mapping);
  assert.equal(Object.hasOwn(initialized.mapping, "sourceRevision"), false);
  assert.deepEqual(f.remoteMapping, { projectId, source: { revision, sha256: hash(bytes) }, mapping: f.seedContext.mapping });
  assert(f.events.some(([name]) => name === "mapping-read"));
  assert.equal(f.receipt.phase, "bound"); assert.equal(f.task.teamProjectId, projectId);
});

test("lost teaching initialization response resumes the persisted seed and same request after restart", async t => {
  const f = await fixture(t), review = await f.review(true); f.fail = "teaching";
  await assert.rejects(f.preparation.confirm(review.reviewId), /teaching response lost/);
  const persisted = structuredClone(f.receipt), initialized = structuredClone(f.remoteTeaching);
  assert.equal(persisted.phase, "uploaded"); assert(persisted.teaching);
  assert.deepEqual(f.writes().map(([name]) => name), ["upload", "teaching-init"]);
  f.preparation = f.make();
  const recovered = await f.review(true); assert.equal(recovered.recovering, true);
  const before = f.writes().length;
  await f.preparation.confirm(recovered.reviewId);
  assert.deepEqual(f.writes().slice(before).map(([name]) => name), ["teaching-init", "start", "bind"]);
  assert.deepEqual(f.remoteTeaching, initialized);
  assert.deepEqual(f.receipt.teaching, persisted.teaching);
  assert.equal(f.receipt.requestId, persisted.requestId);
  const requests = f.writes().filter(([name]) => name === "teaching-init").map(([, input]) => input);
  assert.equal(requests.length, 2); assert.deepEqual(requests[0], requests[1]);
});

for (const kind of ["text", "teachingRevision", "mappingRevision", "mappingOrder", "mappingObject", "mappingObjectOrder", "sourceSha256"])
  test(`teaching confirmation refuses changed ${kind} before any remote write`, async t => {
    const f = await fixture(t), review = await f.review(true);
    if (kind === "text") f.seedContext.project.pages[0].actions[0].text = "Changed";
    if (kind === "teachingRevision") f.seedContext.project.teachingRevision = "teaching-2";
    if (kind === "mappingRevision") f.seedContext.mapping.revision = "mapping-2";
    if (kind === "mappingOrder") f.seedContext.mapping.pages.reverse();
    if (kind === "mappingObject") f.seedContext.mapping.pages[0].objects[0].importElementId = "changed-shape";
    if (kind === "mappingObjectOrder") f.seedContext.mapping.pages[0].objects.reverse();
    if (kind === "sourceSha256") f.seedContext.project.source.sha256 = "b".repeat(64);
    await assert.rejects(f.preparation.confirm(review.reviewId), /TEACHING_NOT_READY|PREPARATION_CHANGED/);
    assert.deepEqual(f.writes(), []);
  });

test("pending teaching receipts cannot silently resume as PPTX-only or with changed teaching", async t => {
  const f = await fixture(t), review = await f.review(true); f.fail = "teaching";
  await assert.rejects(f.preparation.confirm(review.reviewId));
  const count = f.writes().length;
  f.preparation = f.make(); await assert.rejects(f.review(), /PREPARATION_CHANGED/);
  f.seedContext.project.pages[0].actions[0].text = "Changed after crash";
  await assert.rejects(f.review(true), /PREPARATION_CHANGED/);
  assert.equal(f.writes().length, count);
});

for (const kind of ["mappingObject", "mappingOrder", "legacyHash"]) test(`restart refuses a pending seed with changed ${kind} without another POST`, async t => {
  const f = await fixture(t), review = await f.review(true); f.fail = "teaching";
  await assert.rejects(f.preparation.confirm(review.reviewId));
  const writes = f.writes().length;
  if (kind === "mappingObject") f.seedContext.mapping.pages[0].objects[0].importElementId = "changed-shape";
  if (kind === "mappingOrder") f.seedContext.mapping.pages[0].objects.reverse();
  if (kind === "legacyHash") {
    const sorted = value => Array.isArray(value) ? value.map(sorted) : value && typeof value === "object" ?
      Object.fromEntries(Object.keys(value).sort().map(key => [key, sorted(value[key])])) : value;
    f.receipt.teaching.payloadSha256 = hash(JSON.stringify(sorted({ project: f.seedContext.project, mappingRevision: f.seedContext.mapping.revision })));
  }
  f.preparation = f.make();
  await assert.rejects(f.review(true), /PREPARATION_CHANGED/);
  assert.equal(f.writes().length, writes);
});

for (const kind of ["missing", "project", "source", "mapping"]) test(`recovery refuses ${kind} remote mapping proof before initializing or starting`, async t => {
  const f = await fixture(t), review = await f.review(true); f.fail = "teaching";
  await assert.rejects(f.preparation.confirm(review.reviewId));
  const writes = f.writes().length;
  if (kind === "missing") f.remoteMapping = null;
  if (kind === "project") f.remoteMapping.projectId = "other-project";
  if (kind === "source") f.remoteMapping.source.revision = "other-source";
  if (kind === "mapping") f.remoteMapping.mapping.pages[0].objects.reverse();
  f.preparation = f.make();
  await assert.rejects(f.review(true), /TEACHING_CONFLICT|PLATFORM_46607/);
  assert.equal(f.writes().length, writes);
});

for (const existing of ["source", "teaching"]) test(`teaching seed refuses existing remote ${existing} during review`, async t => {
  const f = await fixture(t);
  if (existing === "source") f.remote = { projectId, source: { revision, sha256: hash(bytes) } };
  else f.remoteTeaching = { project: { ...f.seedContext.project, projectId }, mappingRevision: "mapping-1" };
  await assert.rejects(f.review(true), /TEACHING_CONFLICT/);
  assert.deepEqual(f.writes(), []); assert.equal(f.receipt, null);
});

test("a remote teaching edit after lost initialization is refused without further writes", async t => {
  const f = await fixture(t), review = await f.review(true); f.fail = "teaching";
  await assert.rejects(f.preparation.confirm(review.reviewId));
  f.remoteTeaching.project.pages[0].actions[0].text = "Another editor's work";
  const count = f.writes().length; f.preparation = f.make();
  await assert.rejects(f.review(true), /TEACHING_CONFLICT/);
  assert.equal(f.writes().length, count);
});

for (const action of [{ id: "music-1", type: "audio_clip", audioAssetId: "local-music" },
  { id: "speech-2", type: "speech", text: "Narration", audioAssetId: "local-tts" }])
  test(`local ${action.type} audio is rejected before upload or remote initialization`, async t => {
    const f = await fixture(t); f.seedContext.project.pages[0].actions.push(action);
    await assert.rejects(f.review(true), /TEACHING_MEDIA_UNAVAILABLE/);
    assert.deepEqual(f.writes(), []); assert.equal(f.receipt, null);
  });

test("preparation IPC accepts finite main-frame selectors and refuses disabled writes or injected paths", async () => {
  const { registerCoursewareOnlinePreparationIpc } = await load("ipc/courseware-online-prepare-ipc", { "@pi-desktop/shared": { IPC } });
  const handlers = new Map(), calls = [], frame = {};
  let available = true, fail = false;
  const event = { sender: { id: 1, mainFrame: frame }, senderFrame: frame };
  registerCoursewareOnlinePreparationIpc({
    handleWithEvent: (channel, handler) => handlers.set(channel, handler),
    assertMainWindowSender(e) { if (e.sender.id !== 1) throw new Error("foreign sender"); },
  }, { review: (...args) => { if (fail) throw new Error("ENOENT /private/source.pptx"); return calls.push(["review", ...args]); },
    confirm: id => calls.push(["confirm", id]), cancel: id => calls.push(["cancel", id]) }, () => available);
  for (const channel of handlers.keys()) assert(IPC_WHITELIST.has(channel));
  const review = handlers.get(IPC.invoke.coursewareOnlinePrepareReview);
  await review(event, { sessionId: "chat-1", projectId });
  assert.deepEqual(calls, [["review", "chat-1", projectId, false]]);
  await review(event, { sessionId: "chat-1", projectId, includeTeaching: true });
  assert.deepEqual(calls.at(-1), ["review", "chat-1", projectId, true]);
  fail = true;
  await assert.rejects(review(event, { sessionId: "chat-1", projectId }), error => error.message === "COURSEWARE_ONLINE_PREPARATION_FAILED");
  fail = false;
  for (const [e, payload, extra] of [[{ ...event, senderFrame: {} }, { sessionId: "chat-1", projectId }],
    [{ ...event, sender: { id: 2 } }, { sessionId: "chat-1", projectId }],
    [event, { sessionId: "chat-1", projectId, path: "/injected" }], [event, { sessionId: "../outside", projectId }],
    [event, { sessionId: "chat-1", projectId, includeTeaching: "true" }],
    [event, { sessionId: "chat-1", projectId }, "extra"]])
    await assert.rejects(review(e, payload, ...(extra ? [extra] : [])));
  available = false;
  await assert.rejects(handlers.get(IPC.invoke.coursewareOnlinePrepareConfirm)(event, { reviewId: "review-1" }), /DISABLED/);
  await handlers.get(IPC.invoke.coursewareOnlinePrepareCancel)(event, { reviewId: "review-1" });
  assert.deepEqual(calls.at(-1), ["cancel", "review-1"]);
});


function enableAudio(f) {
  const speechBytes = Buffer.from("RIFF-adopted-speech"), musicBytes = Buffer.from("ID3-exported-music");
  const speechRef = { taskId: "44444444-4444-4444-8444-444444444444", idempotencyKey: "tts-key", requestHash: "c".repeat(64) };
  const musicRef = { taskId: "55555555-5555-4555-8555-555555555555", idempotencyKey: "music-key", requestHash: "d".repeat(64) };
  const speechId = `tts-${hash(speechBytes)}`, musicId = `music-${hash(musicBytes)}`;
  const speechAsset = { assetId: "66666666-6666-4666-8666-666666666666", sha256: hash(speechBytes), mime: "audio/wav", byteLength: speechBytes.length };
  const musicAsset = { assetId: "77777777-7777-4777-8777-777777777777", sha256: hash(musicBytes), mime: "audio/mpeg", byteLength: musicBytes.length };
  const project = f.seedContext.project;
  project.pages[0].actions[0].audioAssetId = speechId;
  project.pages[1].actions.push({ id: "clip-1", type: "audio_clip", audioAssetId: musicId });
  const selection = { intentId: "tts-1", projectId: project.projectId, principalKey: "a".repeat(64), pageId: "page-1", actionId: "speech-1", expectedSourceRevision: project.source.revision };
  f.audioHost = async (method, params) => {
    assert.equal(params.principalKey, "a".repeat(64));
    if (method === "courseware.tts.list") return { intents: [{ phase: "submitted", selection }] };
    if (method === "courseware.tts.get") return { intent: { phase: "submitted", selection,
      request: { kind: "tts", input: "Good job!" }, sourceSha256: project.source.sha256, taskRef: speechRef } };
    if (method === "courseware.tts.audio.get") return { asset: { id: speechId, sha256: speechAsset.sha256, mimeType: speechAsset.mime },
      audio: { taskRef: speechRef, sha256: speechAsset.sha256, mimeType: speechAsset.mime, byteLength: speechAsset.byteLength },
      adoptedTeachingRevision: "audio-adopted", boundSource: structuredClone(project.source) };
    if (method === "courseware.mediaCanvas.music.snapshotAssets") {
      assert.equal(params.expectedSourceRevision, project.source.revision); assert.equal(params.expectedTeachingRevision, project.teachingRevision);
      return { assets: [{ asset: { id: musicId, sha256: musicAsset.sha256, mimeType: musicAsset.mime }, music: { principalKey: "a".repeat(64), intentId: "music-1" } }] };
    }
    if (method === "courseware.mediaCanvas.music.get") return { intent: { intentId: "music-1", phase: "submitted", request: { kind: "music-export" }, taskRef: musicRef,
      asset: { taskRef: musicRef, sha256: musicAsset.sha256, mimeType: musicAsset.mime, byteLength: musicAsset.byteLength } } };
    assert.fail(method);
  };
  const adopted = new Map(), team = asset => ({ projectId, assetRef: { ...asset, downloadPath: `/courseware/team/projects/${projectId}/assets/${asset.assetId}/content` } });
  Object.assign(f.media, {
    async get(ref) { f.events.push(["audio-task-read"]); await f.onAudioTask?.(); assert.deepEqual(ref, speechRef); return { ...ref, kind: "tts", state: "ready", feeState: "settled", assetRef: structuredClone(speechAsset) }; },
    music: { async get(ref, kind) { assert.equal(kind, "music-export"); assert.deepEqual(ref, musicRef); return { ...ref, kind, state: "ready", feeState: "settled", assetRef: structuredClone(musicAsset) }; } },
    async getTeamAsset(id, assetId) { assert.equal(id, projectId); f.events.push(["audio-get", assetId]); await f.onAudioGet?.();
      if (!adopted.has(assetId)) throw new Error("COURSEWARE_MEDIA_PLATFORM_46901"); return structuredClone(adopted.get(assetId)); },
    async adoptTeamAsset(id, ref) { assert.equal(id, projectId); f.events.push(["audio-adopt", structuredClone(ref)]);
      const value = team(ref.taskId === speechRef.taskId ? speechAsset : musicAsset); adopted.set(value.assetRef.assetId, value);
      if (f.fail === "audio-adopt") { f.fail = null; throw new Error("audio adoption response lost"); } return structuredClone(value); },
    async downloadTeamAsset(reference) { f.events.push(["audio-download", reference.assetRef.assetId]); return { reference: structuredClone(reference),
      bytes: reference.assetRef.assetId === speechAsset.assetId ? Buffer.from(speechBytes) : Buffer.from(musicBytes) }; },
  });
  return { speechAsset, musicAsset, adopted, speechRef, musicRef };
}

test("Owner includeTeaching review is read-only and explicit confirmation adopts archived audio before initialization", async t => {
  const f = await fixture(t), audio = enableAudio(f), original = structuredClone(f.seedContext), review = await f.review(true);
  assert.equal(review.teaching.audioCount, 2); assert.deepEqual(f.writes(), []); assert.equal(f.receipt, null);
  assert.equal(f.events.some(([name]) => name === "audio-adopt" || name === "audio-download"), false);
  await f.preparation.confirm(review.reviewId);
  const sequence = f.events.filter(([name]) => ["upload", "audio-adopt", "teaching-init", "start", "bind"].includes(name)).map(([name]) => name);
  assert.deepEqual(sequence, ["upload", "audio-adopt", "audio-adopt", "teaching-init", "start", "bind"]);
  assert.equal(f.remoteTeaching.project.pages[0].actions[0].audioAssetId, audio.speechAsset.assetId);
  assert.equal(f.remoteTeaching.project.pages[1].actions[1].audioAssetId, audio.musicAsset.assetId);
  assert.deepEqual(f.seedContext, original); assert.equal(f.receipt.phase, "bound");
  assert.equal((await f.preparation.join(projectId)).sessionEpoch, 1);
});

for (const stage of ["audio-adopt", "teaching"]) test(`audio preparation recovers committed ${stage} after restart without repeating adoption or generation`, async t => {
  const f = await fixture(t); enableAudio(f); const review = await f.review(true); f.fail = stage;
  await assert.rejects(f.preparation.confirm(review.reviewId), /response lost/);
  const requestId = f.receipt.requestId, original = structuredClone(f.seedContext);
  f.preparation = f.make(); const recovered = await f.review(true); assert.equal(recovered.recovering, true);
  await f.preparation.confirm(recovered.reviewId);
  assert.equal(f.receipt.requestId, requestId); assert.equal(f.receipt.phase, "bound");
  assert.equal(f.events.filter(([name]) => name === "audio-adopt").length, 2);
  assert.equal(f.events.filter(([name]) => name === "upload").length, 1);
  assert.equal(f.events.filter(([name]) => name === "start").length, 1);
  assert.deepEqual(f.seedContext, original);
});

test("changed audio projection is refused by persisted pins before resuming preparation", async t => {
  const f = await fixture(t), audio = enableAudio(f), review = await f.review(true); f.fail = "upload";
  await assert.rejects(f.preparation.confirm(review.reviewId), /response lost/);
  const count = f.writes().length;
  audio.speechAsset.assetId = "88888888-8888-4888-8888-888888888888";
  f.preparation = f.make(); await assert.rejects(f.review(true), /PREPARATION_CHANGED/);
  assert.equal(f.writes().length, count); assert.equal(f.events.some(([name]) => name === "audio-adopt"), false);
});

test("audio confirmation preserves Owner, dirty and account guards immediately before adoption", async t => {
  for (const change of [f => { f.role = "EDITOR"; }, f => { f.dirty = true; }, f => { f.account = false; },
    f => { f.task.teamProjectId = "another-project"; }, f => fs.appendFile(f.path, "external source edit")]) {
    const f = await fixture(t); enableAudio(f); const review = await f.review(true);
    f.onAudioGet = async () => change(f);
    await assert.rejects(f.preparation.confirm(review.reviewId));
    assert.equal(f.events.some(([name]) => name === "audio-adopt"), false);
    assert.equal(f.events.some(([name]) => name === "teaching-init" || name === "start"), false);
  }
});


test("external PPTX changes during added audio preflight are checked again before the first write", async t => {
  const f = await fixture(t); enableAudio(f); const review = await f.review(true);
  let changed = false;
  f.onAudioTask = async () => { if (!changed) { changed = true; await fs.appendFile(f.path, "changed during preflight"); } };
  await assert.rejects(f.preparation.confirm(review.reviewId));
  assert.deepEqual(f.writes(), []); assert.equal(f.events.some(([name]) => name === "audio-adopt"), false);
});
