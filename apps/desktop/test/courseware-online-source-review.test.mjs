import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { promises as fs, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import ts from "typescript";
import * as shared from "@pi-desktop/shared";

const require = createRequire(import.meta.url), modules = { "@pi-desktop/shared": shared };
const load = name => {
  const exports = {};
  new Function("require", "exports", ts.transpileModule(readFileSync(new URL(`../electron/main/${name}.ts`, import.meta.url), "utf8"), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText)(id => Object.hasOwn(modules, id) ? modules[id] : id.startsWith("node:") ? require(id) : assert.fail(`Unexpected dependency ${id}`), exports);
  modules[`./${name}`] = exports; return exports;
};
load("office-file"); load("courseware-online-source-files"); load("courseware-online-snapshot");
modules["./courseware-source-visuals"] = { async renderCoursewareSourceVisuals(input) {
  await input.assertCurrent(); assert.equal(digest(await fs.readFile(input.snapshot.sourcePath)), input.snapshot.sha256);
  return { normal: { image: { bytes: Buffer.from("fixture PNG") } } };
} };
const { CoursewareOnlineSourceReviewCoordinator } = load("courseware-online-source-review");
const ownerId = "11111111-1111-4111-8111-111111111111", projectId = "22222222-2222-4222-8222-222222222222";
const digest = bytes => createHash("sha256").update(bytes).digest("hex");
const bytes = text => Buffer.from(`PK[Content_Types].xmlppt/presentation.xml${text}`);
const clone = value => structuredClone(value);
const deferred = () => { let resolve; const promise = new Promise(yes => { resolve = yes; }); return { promise, resolve }; };
const decisions = () => ({ pages: [{ kind: "carry", targetImportPageId: "import-page-new", oldPageId: "page-old", confirmReady: true }], removedPages: [], cues: [] });

async function fixture(t, options = {}) {
  const workspace = await fs.mkdtemp(join(tmpdir(), "online-source-review-test-"));
  const original = bytes("original"), target = bytes("saved target");
  const source = { revision: randomUUID(), sha256: digest(original) };
  const project = { schemaVersion: "deckwise-courseware/1", projectId, title: "Lesson", taskType: "plain", source, teachingRevision: randomUUID(),
    pages: [{ pageId: "page-old", locked: false, reviewState: "ready", actions: [{ id: "speech-1", type: "speech", text: "Hello" }] }] };
  const audio = new Map();
  if (options.silent) project.pages[0].actions = [];
  if (options.audio) {
    const speech = Buffer.alloc(48); speech.write("RIFF"); speech.write("WAVE", 8);
    for (const [type, bytes, mime] of [["speech", speech, "audio/wav"], ["audio_clip", Buffer.from("ID3 music fixture"), "audio/mpeg"]]) {
      const assetId = randomUUID();
      audio.set(assetId, { bytes, reference: { projectId, assetRef: { assetId, sha256: digest(bytes), mime, byteLength: bytes.length,
        downloadPath: `/courseware/team/projects/${projectId}/assets/${assetId}/content` } } });
      if (type === "speech") project.pages[0].actions[0].audioAssetId = assetId;
      else project.pages[0].actions.push({ id: "music-1", type, audioAssetId: assetId });
    }
  }
  const mapping = { revision: "mapping-old", sourceSha256: source.sha256, pages: [{ pageId: "page-old", importPageId: "import-page-old",
    objects: [{ objectId: "object-old", importElementId: "shape-old" }] }] };
  const pause = { projectId, sessionEpoch: 1, pauseId: randomUUID(), state: "held", teaching: { project, mappingRevision: mapping.revision } };
  const barrier = { projectId, sessionEpoch: 1, barrierId: randomUUID(), pauseId: pause.pauseId, state: "held", coverage: "managed",
    allRegisteredClientsHeld: true, authoritativeCoverage: false, consistentPublicationReady: false, proof: "client-reported",
    clients: [{ clientId: randomUUID(), docsUserId: "fixture-client", state: "held", nativeReady: true, lastSeenEpochMillis: Date.now() }], reasons: [] };
  const f = { workspace, original, target, source, project, mapping, pause, barrier, events: [], jobs: new Map(), permitted: true,
    sessionId: "chat-1", binding: { ownerId, projectId, sessionEpoch: 1, source: clone(source), documentKey: "native-key" }, callbackId: "c".repeat(64),
    saveState: "archived", baselineId: randomUUID(), reviewId: "d".repeat(64), mappingReads: 0, captured: null, audio, archivedAudio: new Map() };
  const report = target => ({ baselineId: f.baselineId, reviewId: f.reviewId, original: { project: clone(f.project), mapping: clone(f.mapping) },
    previousPages: [{ pageId: "page-old", pageNumber: 1, objects: [{ objectId: "object-old", index: 1, kind: "shape" }] }],
    target: { ...clone(target), pages: [{ pageNumber: 1, importPageId: "import-page-new", objects: [{ importElementId: "shape-new", index: 1, kind: "shape" }] }] },
    requiresExplicitAssociations: true });
  f.host = { async call(method, params) {
    f.events.push([method, clone(params)]);
    if (f.hook) await f.hook(method, params);
    if (method === "session.get") return { session: { id: f.sessionId, projectPath: f.workspace } };
    if (method === "courseware.parseStart") { assert.equal(f.jobs.size, 0); const jobId = randomUUID();
      f.jobs.set(jobId, digest(await fs.readFile(params.path))); return { jobId, status: "RUNNING" }; }
    if (method === "courseware.parseStatus") return { status: "SUCCEEDED", summary: { sourceSha256: f.jobs.get(params.jobId) } };
    if (method === "courseware.parseCancel") return { status: "FAILED" };
    if (method === "courseware.parseRelease") { f.jobs.delete(params.jobId); return { released: true }; }
    if (method === "courseware.onlineSource.baseline") {
      assert.equal(f.jobs.get(params.jobId), source.sha256); assert.deepEqual(params.project, f.project); assert.deepEqual(params.mapping, f.mapping);
      return { baselineId: f.baselineId, projectId, source: clone(source), teachingRevision: project.teachingRevision, mappingRevision: mapping.revision };
    }
    if (method === "courseware.onlineSource.review") { f.reviewTarget = clone(params.target); return report(params.target); }
    if (method === "courseware.onlineSource.resolve") {
      assert.deepEqual(params.target, f.reviewTarget); assert.deepEqual(params.pages, decisions().pages);
      const next = { ...clone(project), source: clone(params.target.source) };
      if (f.resolveMalformed) next.source.sha256 = "f".repeat(64);
      if (f.resolveUnready) next.pages[0].reviewState = "review";
      f.captured = clone(params);
      f.resolved = { reviewId: f.reviewId, project: next, mapping: { revision: "mapping-new", sourceSha256: params.target.source.sha256,
        pages: [{ pageId: "page-old", importPageId: "import-page-new", objects: [{ objectId: "object-new", importElementId: "shape-new" }] }] } };
      return clone(f.resolved);
    }
    if (method === "courseware.snapshot.importOnline") {
      if (f.importFails) { f.importFails--; throw new Error("Host reply lost"); }
      assert.equal(f.jobs.get(params.jobId), digest(f.target));
      assert.equal(params.sourceByteLength, f.target.length);
      assert.deepEqual(params.project, f.savedReview.teaching.project);
      assert.deepEqual(params.mapping, { ...f.savedReview.mapping, sourceRevision: f.savedReview.snapshotId });
      for (const { asset, path } of params.assets) {
        const bytes = await fs.readFile(path); assert.equal(digest(bytes), asset.sha256);
        f.archivedAudio.set(asset.id, Buffer.from(bytes));
      }
      return { snapshot: { snapshotId: params.snapshotId, projectId, source: clone(params.project.source),
        teachingRevision: params.project.teachingRevision, mappingRevision: params.mapping.revision,
        assetIds: params.assets.map(entry => entry.asset.id).sort() }, sourcePath: "private-archive-path" };
    }
    if (method === "courseware.onlineSource.clear") return { cleared: true };
    throw new Error(`Unexpected Host ${method}`);
  } };
  const receipt = () => ({ requestId: f.saveRequestId, key: "native-key", sessionEpoch: 1, state: f.saveState, commandError: null,
    callbackId: f.saveState === "archived" ? f.callbackId : null });
  f.client = {
    async current() { return { projectId, epoch: 1, active: true, sessionId: "native-key" }; },
    async currentWritePause() { return clone(f.pause); }, async getWritePause() { return clone(f.pause); },
    async currentNativeBarrier() { return clone(f.barrier); }, async getNativeBarrier() { return clone(f.barrier); },
    async getTeachingMapping() { return { projectId, source: clone(source), mapping: clone(mapping) }; },
    async requestBarrierForceSave(_project, epoch, barrierId, id, key) {
      assert.equal(epoch, 1); assert.equal(key, "native-key"); assert.equal(barrierId, f.barrier.barrierId);
      f.saveRequestId = id; return receipt();
    },
    async getForceSave() { f.saveState = "archived"; return receipt(); },
    async downloadCallbackArchive() { return { receipt: { callbackId: f.callbackId, key: "native-key", sessionEpoch: 1, documentStatus: 6,
      state: "archived", sha256: digest(target), byteLength: target.length }, bytes: Buffer.from(target) }; },
    async downloadSource() { return { version: { projectId, source: clone(source), byteLength: original.length }, bytes: Buffer.from(original) }; },
    async captureVerifiedSourceReview(teamProjectId, input) {
      assert.equal(teamProjectId, projectId); assert.equal(input.requestId, f.reviewTarget.source.revision);
      assert.equal(input.sessionEpoch, 1); assert.equal(input.pauseId, f.pause.pauseId); assert.equal(input.barrierId, f.barrier.barrierId);
      assert.equal(input.forceSaveRequestId, f.saveRequestId); assert.equal(input.expectedSourceRevision, f.source.revision);
      assert.equal(input.expectedTeachingRevision, f.project.teachingRevision);
      assert.deepEqual(input.project, f.resolved.project); assert.deepEqual(input.mapping, f.resolved.mapping);
      f.savedReview = { snapshotId: input.requestId, sessionEpoch: input.sessionEpoch, forceSaveRequestId: input.forceSaveRequestId,
        callbackId: f.callbackId, sourceByteLength: f.target.length, baselineSourceRevision: input.expectedSourceRevision,
        baselineTeachingRevision: input.expectedTeachingRevision,
        teaching: { project: { ...clone(input.project), teachingRevision: randomUUID() }, mappingRevision: input.mapping.revision }, mapping: clone(input.mapping) };
      if (f.captureFails) { f.captureFails--; throw new Error("capture reply lost"); }
      const result = clone(f.savedReview); return f.captureResponse ? f.captureResponse(result) : result;
    },
    async getVerifiedSourceReview(teamProjectId, snapshotId) {
      assert.equal(teamProjectId, projectId); assert.equal(snapshotId, f.reviewTarget.source.revision);
      if (f.reviewNotFound === "http") throw new Error("COURSEWARE_ONLINE_HTTP_404");
      if (f.reviewNotFound || !f.savedReview) throw new Error("COURSEWARE_ONLINE_PLATFORM_46606");
      const result = clone(f.savedReview); return f.captureResponse ? f.captureResponse(result) : result;
    },
  };
  for (const name of Object.keys(f.client)) { const call = f.client[name]; f.client[name] = async (...args) => {
    f.events.push([name, args]); if (f.hook) await f.hook(name, args); return call(...args);
  }; }
  const media = {
    async getTeamAsset(teamProjectId, assetId) {
      f.events.push(["getTeamAsset", { projectId: teamProjectId, assetId }]);
      assert.equal(teamProjectId, projectId); return clone(audio.get(assetId).reference);
    },
    async downloadTeamAsset(reference) {
      f.events.push(["downloadTeamAsset", clone(reference)]);
      return { reference: clone(reference), bytes: Buffer.from(audio.get(reference.assetRef.assetId).bytes) };
    },
  };
  f.main = new CoursewareOnlineSourceReviewCoordinator({ binding: () => clone(f.binding), client: () => f.client, media: () => media,
    principal: () => ({ assertCurrent() { if (!f.permitted) throw new Error("account changed"); } }), getHost: () => f.host,
    getWorkspaceRoot: async () => f.workspace, getViewingSessionId: () => f.sessionId, ipcMain: {} });
  t.after(async () => {
    // Clear through the public API before removing the fixture's owning workspace.
    if (f.viewId) { try { await f.main.clear(f.viewId); } catch {} }
    f.main.invalidate(); await fs.rm(workspace, { recursive: true, force: true });
  });
  return f;
}

test("Owner saves immutable archived bytes, parses original/baseline then target/review, previews, explicitly resolves and clears", async t => {
  const f = await fixture(t), initial = clone(f.project), view = await f.main.begin(ownerId, "chat-1");
  assert.equal(view.original.project.pages[0].actions[0].text, "Hello");
  assert.equal(view.targetPages[0].importPageId, "import-page-new"); assert.throws(() => f.main.assertNoPendingOperation(), /SOURCE_BUSY/);
  const encoded = JSON.stringify(view); for (const privateValue of [f.workspace, f.callbackId, f.baselineId, "native-key", "mapping-old"]) assert(!encoded.includes(privateValue));
  assert.deepEqual(f.events.filter(([name]) => name.startsWith("courseware.")).map(([name]) => name), ["courseware.parseStart", "courseware.parseStatus",
    "courseware.onlineSource.baseline", "courseware.parseRelease", "courseware.parseStart", "courseware.parseStatus", "courseware.onlineSource.review", "courseware.parseRelease"]);
  assert.equal((await f.main.preview(view.viewId, "target", 1)).startsWith("data:image/png;base64,"), true);
  const result = await f.main.resolve(view.viewId, decisions());
  assert.deepEqual(result, { viewId: view.viewId, ownerId, status: "reviewed", readyPages: 1, totalPages: 1 });
  assert.equal(Object.hasOwn(result, "project"), false); assert.equal(Object.hasOwn(result, "mapping"), false);
  assert.deepEqual(f.project, initial); assert.equal(f.jobs.size, 0); assert.throws(() => f.main.assertNoPendingOperation(), /SOURCE_BUSY/);
  assert(!f.events.some(([name]) => /capture|adopt|publish|resume/i.test(name)));
  await f.main.clear(view.viewId); f.main.assertNoPendingOperation(); assert.deepEqual(await fs.readdir(f.workspace), []);
});

test("save is refused before submission if teaching pause or registered native windows are not held", async t => {
  for (const change of [f => { f.pause.state = "released"; }, f => { f.barrier.state = "draining"; }, f => { f.barrier.allRegisteredClientsHeld = false; },
    f => { f.barrier.coverage = "unmanaged"; }, f => { f.barrier.clients = []; }, f => { f.barrier.clients[0].nativeReady = false; }]) {
    const f = await fixture(t); change(f); await assert.rejects(f.main.begin(ownerId, "chat-1"), /SOURCE_CHANGED|SOURCE_NOT_READY/);
    assert(!f.events.some(([name]) => name === "requestBarrierForceSave")); assert.deepEqual(await fs.readdir(f.workspace), []);
  }
});

test("pending and command-unknown saves are polled with the same UUID and never resubmitted", async t => {
  for (const state of ["pending", "command_unknown"]) {
    const f = await fixture(t); f.saveState = state;
    const view = await f.main.begin(ownerId, "chat-1");
    assert.equal(f.events.filter(([name]) => name === "requestBarrierForceSave").length, 1);
    const get = f.events.find(([name]) => name === "getForceSave"); assert.equal(get[1][2], f.saveRequestId);
    await f.main.clear(view.viewId);
  }
  const f = await fixture(t); f.saveState = "no_changes";
  await assert.rejects(f.main.begin(ownerId, "chat-1"), /SOURCE_NOT_READY/);
  assert(!f.events.some(([name]) => name === "downloadCallbackArchive"));
});

test("account, native binding, session and Host changes during async work cannot create a review or invoke automatic resume", async t => {
  for (const change of [f => { f.permitted = false; }, f => { f.binding.sessionEpoch++; }, f => { f.sessionId = "other"; }, f => { f.host = {}; }]) {
    const f = await fixture(t); f.hook = async name => { if (name === "downloadSource") change(f); };
    await assert.rejects(f.main.begin(ownerId, "chat-1"), /changed|SOURCE_CHANGED/);
    assert.deepEqual(await fs.readdir(f.workspace), []); assert(!f.events.some(([name]) => /resume/i.test(name)));
  }
});

test("invalid decisions, page previews and malformed Host results never return private mapping/project authority", async t => {
  const f = await fixture(t), view = await f.main.begin(ownerId, "chat-1");
  await assert.rejects(f.main.resolve(view.viewId, { ...decisions(), jobId: "injected" }), /SOURCE_INVALID/);
  await assert.rejects(f.main.preview(view.viewId, "target", 2), /SOURCE_INVALID/);
  f.resolveMalformed = true; await assert.rejects(f.main.resolve(view.viewId, decisions()), /SOURCE_INVALID/);
  await f.main.clear(view.viewId); assert.deepEqual(await fs.readdir(f.workspace), []);
});

test("invalidation cancels an outstanding save response without replaying or releasing the remote pause", async t => {
  const f = await fixture(t), wait = deferred(), entered = deferred();
  f.hook = async name => { if (name === "requestBarrierForceSave") { entered.resolve(); await wait.promise; } };
  const pending = f.main.begin(ownerId, "chat-1"), rejected = assert.rejects(pending, /abort/i);
  await entered.promise; f.main.invalidate(); wait.resolve(); await rejected;
  assert(!f.events.some(([name]) => /resume/i.test(name))); assert.deepEqual(await fs.readdir(f.workspace), []);
});

async function readyReview(f) {
  const view = await f.main.begin(ownerId, "chat-1"); f.viewId = view.viewId;
  await f.main.resolve(view.viewId, decisions());
  return view;
}
const count = (f, name) => f.events.filter(([method]) => method === name).length;

test("public capture imports a finite silent snapshot from verified saved bytes without changing live teaching", async t => {
  const f = await fixture(t, { silent: true }), original = clone(f.project), view = await readyReview(f);
  const result = await f.main.capture(view.viewId);
  assert.deepEqual(Object.keys(result).sort(), ["viewId", "ownerId", "snapshot"].sort());
  assert.equal(result.viewId, view.viewId); assert.equal(result.ownerId, ownerId);
  assert(shared.isCoursewareSnapshot(result.snapshot));
  assert.equal(result.snapshot.snapshotId, f.savedReview.snapshotId);
  assert.deepEqual(result.snapshot.source, f.reviewTarget.source); assert.deepEqual(result.snapshot.assetIds, []);
  assert.equal(result.snapshot.teachingRevision, f.savedReview.teaching.project.teachingRevision);
  assert.notEqual(result.snapshot.teachingRevision, original.teachingRevision, "the server's captured teaching revision is retained");
  assert.equal(count(f, "captureVerifiedSourceReview"), 1); assert.equal(count(f, "getTeamAsset"), 0);
  assert.equal(count(f, "courseware.snapshot.importOnline"), 1);
  assert(!JSON.stringify(result).includes(f.workspace)); assert(!JSON.stringify(result).includes("native-key"));
  assert.deepEqual(f.project, original); assert.equal(f.jobs.size, 0);
  assert(!f.events.some(([name]) => /publish|adopt|resume|generate/i.test(name)));
  await f.main.clear(view.viewId); f.main.assertNoPendingOperation(); assert.deepEqual(await fs.readdir(f.workspace), []);
});

test("public capture resolves authenticated UUID speech/music bytes through real private files", async t => {
  const f = await fixture(t, { audio: true }), view = await readyReview(f);
  const result = await f.main.capture(view.viewId);
  assert.deepEqual(result.snapshot.assetIds, [...f.audio.keys()].sort());
  assert.equal(count(f, "getTeamAsset"), 2); assert.equal(count(f, "downloadTeamAsset"), 2);
  assert.equal(f.archivedAudio.size, 2);
  for (const [id, value] of f.audio) assert.deepEqual(f.archivedAudio.get(id), value.bytes);
  const imported = f.events.find(([name]) => name === "courseware.snapshot.importOnline")[1];
  for (const asset of imported.assets) await assert.rejects(fs.stat(asset.path), { code: "ENOENT" });
  await f.main.clear(view.viewId); assert.deepEqual(await fs.readdir(f.workspace), []);
});

test("capture requires an explicit complete ready resolution before any capture POST or audio read", async t => {
  const f = await fixture(t, { silent: true }), view = await f.main.begin(ownerId, "chat-1"); f.viewId = view.viewId;
  await assert.rejects(async () => f.main.capture(view.viewId), /SOURCE_NOT_READY|SOURCE_INVALID/);
  f.resolveUnready = true;
  assert.equal((await f.main.resolve(view.viewId, decisions())).readyPages, 0);
  await assert.rejects(async () => f.main.capture(view.viewId), /SOURCE_NOT_READY|SOURCE_INVALID/);
  assert.equal(count(f, "captureVerifiedSourceReview"), 0); assert.equal(count(f, "getTeamAsset"), 0);
  assert.equal(count(f, "courseware.snapshot.importOnline"), 0);
  await f.main.clear(view.viewId);
});

test("uncertain capture recovers only the same request ID by GET; absent receipt never resubmits POST", async t => {
  const f = await fixture(t, { silent: true }), view = await readyReview(f); f.captureFails = 1;
  await assert.rejects(async () => f.main.capture(view.viewId), /SOURCE_CAPTURE_UNCERTAIN|reply lost/);
  assert.equal(count(f, "captureVerifiedSourceReview"), 1); assert.equal(count(f, "courseware.snapshot.importOnline"), 0);
  f.reviewNotFound = true;
  await assert.rejects(async () => f.main.capture(view.viewId), /SOURCE_CAPTURE_UNCERTAIN/);
  assert.equal(count(f, "captureVerifiedSourceReview"), 1); assert.equal(count(f, "getVerifiedSourceReview"), 1);
  f.reviewNotFound = "http";
  await assert.rejects(async () => f.main.capture(view.viewId), /SOURCE_CAPTURE_UNCERTAIN/);
  f.reviewNotFound = false;
  const result = await f.main.capture(view.viewId);
  assert.equal(result.snapshot.snapshotId, f.reviewTarget.source.revision);
  assert.equal(count(f, "captureVerifiedSourceReview"), 1); assert.equal(count(f, "getVerifiedSourceReview"), 3);
  assert.equal(count(f, "courseware.snapshot.importOnline"), 1); await f.main.clear(view.viewId);
});

test("an uncertain Host import retries its already captured teaching without another capture or result lookup", async t => {
  const f = await fixture(t, { audio: true }), view = await readyReview(f); f.importFails = 1;
  await assert.rejects(async () => f.main.capture(view.viewId), /SOURCE_IMPORT_UNCERTAIN/);
  const captured = clone(f.savedReview), first = f.events.find(([name]) => name === "courseware.snapshot.importOnline")[1];
  for (const asset of first.assets) assert.equal(digest(await fs.readFile(asset.path)), asset.asset.sha256);
  const result = await f.main.capture(view.viewId);
  assert.equal(result.snapshot.snapshotId, captured.snapshotId);
  assert.equal(result.snapshot.teachingRevision, captured.teaching.project.teachingRevision);
  assert.equal(count(f, "captureVerifiedSourceReview"), 1); assert.equal(count(f, "getVerifiedSourceReview"), 0);
  assert.equal(count(f, "courseware.snapshot.importOnline"), 2); await f.main.clear(view.viewId);
});

test("verified R8 capture and import recovery remain independent of resumed R9 teaching", async t => {
  for (const boundary of ["capture", "import"]) {
    const f = await fixture(t, { silent: true }), view = await readyReview(f);
    if (boundary === "capture") f.captureFails = 1;
    else f.importFails = 1;
    await assert.rejects(f.main.capture(view.viewId), /SOURCE_(?:CAPTURE|IMPORT)_UNCERTAIN/);
    const captured = clone(f.savedReview), pauseReads = count(f, "getWritePause"), barrierReads = count(f, "getNativeBarrier");
    f.pause.state = "released"; f.barrier.state = "released";
    f.project.teachingRevision = randomUUID(); f.project.pages[0].actions.push({ id: "r9-pause", type: "pause", durationMs: 900 });
    const result = await f.main.capture(view.viewId);
    assert.equal(result.snapshot.teachingRevision, captured.teaching.project.teachingRevision);
    assert.notEqual(result.snapshot.teachingRevision, f.project.teachingRevision);
    assert.equal(count(f, "captureVerifiedSourceReview"), 1);
    assert.equal(count(f, "getWritePause"), pauseReads); assert.equal(count(f, "getNativeBarrier"), barrierReads);
    const imported = f.events.filter(([name]) => name === "courseware.snapshot.importOnline").at(-1)[1];
    assert.deepEqual(imported.project, captured.teaching.project);
    assert(!f.events.some(([name]) => /resume|publish/i.test(name))); await f.main.clear(view.viewId);
  }
});

test("foreign captured epoch/callback/source/baseline/project replies are refused before audio or Host import", async t => {
  for (const change of [r => { r.snapshotId = randomUUID(); }, r => { r.sessionEpoch++; },
    r => { r.forceSaveRequestId = randomUUID(); }, r => { r.callbackId = "f".repeat(64); },
    r => { r.sourceByteLength++; }, r => { r.baselineSourceRevision = randomUUID(); },
    r => { r.baselineTeachingRevision = randomUUID(); }, r => { r.teaching.project.projectId = randomUUID(); },
    r => { r.teaching.project.source.sha256 = "e".repeat(64); }, r => { r.mapping.pages[0].pageId = "foreign-page"; }]) {
    const f = await fixture(t, { audio: true }), view = await readyReview(f);
    f.captureResponse = result => { change(result); return result; };
    await assert.rejects(async () => f.main.capture(view.viewId), /SOURCE_INVALID|SOURCE_CHANGED|SOURCE_CAPTURE_UNCERTAIN/);
    assert.equal(count(f, "getTeamAsset"), 0); assert.equal(count(f, "courseware.snapshot.importOnline"), 0);
    await f.main.clear(view.viewId);
  }
});

test("changed account, editor epoch, Host or Chat refuses capture and never automatically resumes", async t => {
  for (const change of [f => { f.permitted = false; }, f => { f.binding.sessionEpoch++; },
    f => { f.host = {}; }, f => { f.sessionId = "another-chat"; }]) {
    const f = await fixture(t, { silent: true }), view = await readyReview(f); change(f);
    await assert.rejects(async () => f.main.capture(view.viewId), /account changed|SOURCE_CHANGED|CONTEXT_CHANGED/);
    assert.equal(count(f, "captureVerifiedSourceReview"), 0); assert.equal(count(f, "courseware.snapshot.importOnline"), 0);
    assert(!f.events.some(([name]) => /resume/i.test(name))); await f.main.clear(view.viewId);
  }
});

test("a late capture response after account loss never imports and retains its ID for lookup recovery", async t => {
  const f = await fixture(t, { silent: true }), view = await readyReview(f);
  f.hook = async name => { if (name === "captureVerifiedSourceReview") f.permitted = false; };
  await assert.rejects(async () => f.main.capture(view.viewId), /account changed|SOURCE_CHANGED|SOURCE_CAPTURE_UNCERTAIN/);
  assert.equal(count(f, "courseware.snapshot.importOnline"), 0); assert.equal(count(f, "captureVerifiedSourceReview"), 1);
  f.hook = undefined; f.permitted = true;
  const result = await f.main.capture(view.viewId);
  assert.equal(result.snapshot.snapshotId, f.savedReview.snapshotId);
  assert.equal(count(f, "captureVerifiedSourceReview"), 1); assert.equal(count(f, "getVerifiedSourceReview"), 1);
  await f.main.clear(view.viewId);
});

test("one pending capture refuses concurrent edits and repeated successful capture returns the same immutable snapshot", async t => {
  const f = await fixture(t, { silent: true }), view = await readyReview(f), entered = deferred(), returned = deferred();
  f.hook = async name => { if (name === "captureVerifiedSourceReview") { entered.resolve(); await returned.promise; } };
  const pending = f.main.capture(view.viewId); await entered.promise;
  await assert.rejects(async () => f.main.capture(view.viewId), /SOURCE_BUSY/);
  await assert.rejects(async () => f.main.resolve(view.viewId, decisions()), /SOURCE_BUSY/);
  await assert.rejects(async () => f.main.preview(view.viewId, "target", 1), /SOURCE_BUSY/);
  returned.resolve(); const first = await pending;
  await assert.rejects(async () => f.main.resolve(view.viewId, decisions()), /SOURCE_BUSY/);
  assert.deepEqual(await f.main.capture(view.viewId), first);
  assert.equal(count(f, "captureVerifiedSourceReview"), 1); assert.equal(count(f, "getVerifiedSourceReview"), 0);
  assert.equal(count(f, "courseware.snapshot.importOnline"), 1); await f.main.clear(view.viewId);
});

test("clear waits for a pending capture, refuses its late result and cleans only the private review", async t => {
  const f = await fixture(t, { silent: true }), view = await readyReview(f), entered = deferred(), returned = deferred();
  const live = join(f.workspace, "live.pptx"); await fs.writeFile(live, "saved live file");
  f.hook = async name => { if (name === "captureVerifiedSourceReview") { entered.resolve(); await returned.promise; } };
  const pending = f.main.capture(view.viewId), rejected = assert.rejects(pending, /abort|SOURCE_CHANGED/i);
  await entered.promise; const clearing = f.main.clear(view.viewId); returned.resolve();
  await rejected; await clearing;
  assert.equal(count(f, "captureVerifiedSourceReview"), 1); assert.equal(count(f, "courseware.snapshot.importOnline"), 0);
  assert(!f.events.some(([name]) => /resume/i.test(name)));
  assert.equal(await fs.readFile(live, "utf8"), "saved live file"); assert.deepEqual(await fs.readdir(f.workspace), ["live.pptx"]);
  f.main.assertNoPendingOperation();
});
