import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFile, open, mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import ts from "typescript";

const scopeExports = {};
new Function("exports", ts.transpileModule(await readFile(new URL("../electron/main/courseware-media-scope.ts", import.meta.url), "utf8"), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText)(scopeExports);
const source = await readFile(new URL("../electron/main/courseware-tts.ts", import.meta.url), "utf8");
const placementExports = {};
new Function("exports", ts.transpileModule(await readFile(new URL("../electron/main/courseware-video-placement.ts", import.meta.url), "utf8"), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText)(placementExports);
const module = { exports: {} };
new Function("require", "exports", ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText)(
  (id) => { if (id === "./courseware-video-placement") return placementExports; if (id === "./courseware-media-scope") return scopeExports; if (id === "node:fs/promises") return { open }; assert.equal(id, "node:crypto"); return { randomUUID, createHash }; }, module.exports);
export const { CoursewareTtsCoordinator } = module.exports;

test("portable TTS preview and complete local snapshot do not require an account or provider receipt", async () => {
  const input = { viewId: "view", expectedTeachingRevision: "rev" };
  const assets = ["tts", "music", "video"].map(prefix => ({ asset: { id: `${prefix}-${"a".repeat(64)}`, sha256: "a".repeat(64), mimeType: prefix === "video" ? "video/mp4" : "audio/wav" }, local: true }));
  const project = { pages: [{ pageId: "page", actions: assets.map((entry, i) => ({ id: `node-${i}`, type: ["speech", "audio_clip", "video_clip"][i],
    [i === 2 ? "videoAssetId" : "audioAssetId"]: entry.asset.id })) }] };
  const bytes = { bytes: new Uint8Array([1, 2]), mimeType: "audio/wav" };
  const teaching = { async ttsContext() { return { project }; }, async captureSnapshot(value, actual) {
    assert.deepEqual(value, input); assert.deepEqual(actual, assets); return "local-snapshot";
  } };
  const coordinator = new CoursewareTtsCoordinator(teaching, { getCoursewarePrincipal() { assert.fail("Local playback cannot require login"); } },
    () => assert.fail("Generation decoder is not used"), { async preview() { return bytes; }, async snapshotAssets() { return assets; } });
  assert.deepEqual(await coordinator.preview({ ...input, actionId: "node-0" }), bytes);
  assert.equal(await coordinator.captureSnapshot(input), "local-snapshot");
});

test("portable media integrity failures never fall back to paid generation or account lookup", async () => {
  const coordinator = new CoursewareTtsCoordinator({}, { getCoursewarePrincipal() { assert.fail("No provider fallback"); } }, undefined,
    { async preview() { throw new Error("corrupt portable media"); } });
  await assert.rejects(coordinator.preview({}), /corrupt portable media/);
});
const baseline = { viewId: "view-1", expectedTeachingRevision: "teaching-1" };
const preparation = { ...baseline, actionId: "speech-1", model: "courseware-tts-v1", voice: "teacher_1" };
const hashRequest = (request) => createHash("sha256").update("courseware-media-v1" +
  [request.kind, request.model, request.input, request.voice].map((field) => `:${field === null ? -1 : field.length}:${field ?? ""}`).join("")).digest("hex");
function setup() {
  const intents = new Map(), archives = new Map(), calls = [], network = [];
  let current = true, active = true, account = true, fail, intercept, decodeFailure = false, teamProjectId;
  const task = (intent) => ({ version: "courseware-media-v1", taskId: "task-1", idempotencyKey: intent.idempotencyKey,
    requestHash: intent.requestHash, kind: "tts", model: intent.selection.model, state: "queued", feeState: "reserved",
    reservedPoints: 5, actualPoints: null, receiptId: null, errorCode: null, assetRef: null });
  const response = (intent) => structuredClone({ intent, current, audioReady: false });
  const host = { async call(method, params) {
    calls.push([method, structuredClone(params)]);
    await intercept?.(method, params);
    if (method === "courseware.task.get") return { task: { teamProjectId } };
    if (method === fail) throw new Error("checkpoint or RPC acknowledgement lost");
    if (method.endsWith("prepare")) {
      const request = { kind: "tts", model: params.selection.model, input: "Good! 小朋友😀", voice: params.selection.voice };
      const intent = { selection: params.selection, request, requestHash: hashRequest(request), sourceSha256: "f".repeat(64),
        idempotencyKey: randomUUID(), phase: "prepared", taskRef: null };
      intents.set(intent.selection.intentId, intent); return response(intent);
    }
    if (method.endsWith("list")) return { intents: [...intents.values()].filter((intent) => intent.selection.principalKey === params.principalKey)
      .map(({ request: _request, sourceSha256: _hash, ...intent }) => ({ ...structuredClone(intent), current, audioReady: false })) };
    const intent = intents.get(params.intentId);
    if (!intent || intent.selection.principalKey !== params.principalKey) throw new Error("not found");
    if (method === "courseware.tts.audio.get") {
      if (!archives.has(params.intentId)) throw Object.assign(new Error("not found"), { errorCode: "COURSEWARE_NOT_FOUND" });
      return structuredClone(archives.get(params.intentId));
    }
    if (method === "courseware.tts.audio.stage") {
      const record = { audio: params.audio, path: "/private/archive", asset: { id: "private-asset" } };
      archives.set(params.intentId, record);
      await intercept?.("after-stage");
      return structuredClone(record);
    }
    if (method.endsWith("begin")) {
      assert.equal(intent.phase, "prepared"); assert(current);
      intent.submissionScope = { sessionId: params.sessionId, teamProjectId: teamProjectId ?? null };
      intent.phase = "submission-unknown";
      await intercept?.("after-begin", intent);
    }
    if (method === "courseware.tts.reject") {
      assert.equal(intent.phase, "submission-unknown"); assert(intent.submissionScope.teamProjectId);
      assert.deepEqual(params.rejectedRequest, { idempotencyKey: intent.idempotencyKey, requestHash: intent.requestHash });
      intent.phase = "rejected";
    }
    if (method.endsWith("bind")) { assert.equal(intent.phase, "submission-unknown"); intent.phase = "submitted"; intent.taskRef = params.taskRef; }
    return response(intent);
  } };
  const teaching = { async ttsContext(input) {
    assert.deepEqual(input, baseline);
    const assertCurrent = async () => { if (!active) throw new Error("editor or Chat changed"); };
    await assertCurrent();
    return { host, sessionId: "chat-1", projectId: "project-1", pageId: "page-1", expectedSourceRevision: "source-1",
      expectedTeachingRevision: "teaching-1", assertCurrent };
  } };
  const auth = { getCoursewarePrincipal() {
    if (!account) throw new Error("AUTH_REQUIRED");
    return { key: "a".repeat(64), assertCurrent() { if (!account) throw new Error("AUTH_CHANGED"); } };
  }, coursewareMedia: {
    async submitTts(key, request, signal, projectId) {
      network.push(["POST", key, structuredClone(request)]);
      const intent = [...intents.values()].find((intent) => intent.idempotencyKey === key);
      assert.equal(projectId, intent.submissionScope.teamProjectId ?? undefined);
      assert.equal(intent.phase, "submission-unknown");
      await intercept?.("POST", request);
      if (fail === "POST") throw new Error("response lost after server acceptance");
      return task(intent);
    },
    async download(ref) {
      network.push(["DOWNLOAD", structuredClone(ref)]); await intercept?.("DOWNLOAD");
      const intent = [...intents.values()].find((entry) => entry.taskRef?.taskId === ref.taskId);
      return { task: { ...task(intent), state: "ready", assetRef: { sha256: "e".repeat(64), mime: "audio/wav", durationMs: 9999 } }, bytes: Buffer.from("fixture") };
    },
    async get(ref) { network.push(["GET", structuredClone(ref)]); await intercept?.("GET"); return task(intents.values().next().value); },
    async findTts(ref) {
      network.push(["GET_KEY", structuredClone(ref)]); await intercept?.("GET_KEY");
      if (fail === "LOOKUP_MISSING") return null;
      const intent = [...intents.values()].find((value) => value.idempotencyKey === ref.idempotencyKey);
      return task(intent);
    },
  } };
  const make = () => new CoursewareTtsCoordinator(teaching, auth, async (bytes, mime) => {
    calls.push(["decode", { size: bytes.length, mime }]); await intercept?.("decode");
    if (decodeFailure) throw new Error("COURSEWARE_AUDIO_DECODE_FAILED");
    return 100;
  });
  return { make, coordinator: make(), calls, network, intents, archives, auth,
    team(value) { teamProjectId = value; },
    decodeFailure() { decodeFailure = true; },
    stale() { current = false; }, move() { active = false; }, logout() { account = false; },
    fail(value) { fail = value; }, intercept(fn) { intercept = fn; } };
}
const operation = (prepared) => ({ ...baseline, intentId: prepared.intentId });

test("queued TTS dispatch carries the original editor guard to the media client", async () => {
  const f = setup(), prepared = await f.coordinator.prepare(preparation);
  f.auth.coursewareMedia.submitTts = async (...args) => {
    assert.equal(typeof args[4], "function");
    f.move();
    await args[4]();
    assert.fail("moved editor reached submission");
  };
  await assert.rejects(f.coordinator.submit(operation(prepared)), /editor or Chat changed/);
  assert.equal(f.network.length, 0);
});

test("prepare persists exact Host speech before explicit submit and exposes only bounded status", async () => {
  const f = setup(), prepared = await f.coordinator.prepare(preparation);
  assert.equal(prepared.phase, "prepared"); assert.equal(f.network.length, 0);
  const sent = await f.coordinator.submit(operation(prepared));
  assert.equal(sent.phase, "submitted"); assert.equal(sent.task.state, "queued"); assert.equal(sent.audioReady, false);
  assert.deepEqual(f.network[0].slice(1), [f.intents.get(prepared.intentId).idempotencyKey,
    { kind: "tts", model: preparation.model, input: "Good! 小朋友😀", voice: "teacher_1" }]);
  assert.equal(f.intents.get(prepared.intentId).requestHash, "1614bc16420a22f45df72e5e934e4a28822ae067d8a7dbc2c9b64b6cf2ae6a27");
  const visible = JSON.stringify(await f.coordinator.list(baseline));
  for (const secret of ["requestHash", "idempotencyKey", "principalKey", "taskId", "input", "downloadPath"]) assert(!visible.includes(secret));
  assert(f.calls.findIndex(([name]) => name.endsWith("begin")) < f.calls.findIndex(([name]) => name.endsWith("bind")));
});

test("malformed IPC-shaped requests reject before Host or network, including forged text, keys and paths", async () => {
  const f = setup();
  for (const payload of [null, [], { ...preparation, input: "forged" }, { ...preparation, principalKey: "b".repeat(64) },
    { ...preparation, idempotencyKey: "key" }, { ...preparation, model: "../file" }, { ...preparation, voice: "bad/url" }]) {
    await assert.rejects(f.coordinator.prepare(payload), /INVALID_REQUEST/);
  }
  await assert.rejects(f.coordinator.submit({ ...baseline, intentId: ".." }), /INVALID_REQUEST/);
  await assert.rejects(f.coordinator.list({ ...baseline, path: "/etc/passwd" }), /INVALID_REQUEST/);
  assert.equal(f.calls.length, 0); assert.equal(f.network.length, 0);
});

test("lost task IDs recover after restart by GET and retain the original request and key", async () => {
  const f = setup(), prepared = await f.coordinator.prepare(preparation);
  f.fail("POST"); await assert.rejects(f.coordinator.submit(operation(prepared)), /response lost/);
  const saved = structuredClone(f.intents.get(prepared.intentId));
  const restarted = f.make();
  assert.equal((await restarted.list(baseline))[0].phase, "submission-unknown");
  assert.equal((await restarted.status(operation(prepared))).task.state, "queued");
  assert.equal((await restarted.submit(operation(prepared))).phase, "submitted");
  const recovered = f.intents.get(prepared.intentId);
  assert.deepEqual({ ...recovered, phase: saved.phase, taskRef: saved.taskRef }, saved);
  assert.equal(recovered.taskRef.taskId, "task-1");
  assert.deepEqual(f.network.map(([method]) => method), ["POST", "GET_KEY", "GET"]);
});

test("missing recovery stays unknown without another paid request or journal mutation", async () => {
  const f = setup(), prepared = await f.coordinator.prepare(preparation);
  f.fail("POST"); await assert.rejects(f.coordinator.submit(operation(prepared)), /response lost/);
  f.fail("LOOKUP_MISSING");
  const saved = structuredClone(f.intents.get(prepared.intentId));
  assert.equal((await f.make().status(operation(prepared))).task, null);
  assert.equal((await f.make().submit(operation(prepared))).phase, "submission-unknown");
  assert.deepEqual(f.intents.get(prepared.intentId), saved);
  assert.deepEqual(f.network.map(([method]) => method), ["POST", "GET_KEY", "GET_KEY"]);
});

test("prepared intents never query and late or mismatched recovery cannot bind another task", async () => {
  const preparedFixture = setup(), untouched = await preparedFixture.coordinator.prepare(preparation);
  await preparedFixture.coordinator.status(operation(untouched));
  assert.equal(preparedFixture.network.length, 0);
  for (const change of ["logout", "hash", "model"]) {
    const f = setup(), prepared = await f.coordinator.prepare(preparation);
    f.fail("POST"); await assert.rejects(f.coordinator.submit(operation(prepared)), /response lost/);
    const saved = structuredClone(f.intents.get(prepared.intentId));
    if (change === "logout") f.intercept((method) => { if (method === "GET_KEY") f.logout(); });
    else {
      const find = f.auth.coursewareMedia.findTts;
      f.auth.coursewareMedia.findTts = async (ref) => ({ ...await find(ref), ...(change === "hash" ? { requestHash: "0".repeat(64) } : { model: "other" }) });
    }
    await assert.rejects(f.coordinator.status(operation(prepared)), /CHANGED|changed|INVALID_TASK/);
    assert.deepEqual(f.intents.get(prepared.intentId), saved);
    assert.equal(f.network.filter(([method]) => method === "POST").length, 1);
    assert.equal(f.calls.filter(([method]) => method === "courseware.tts.bind").length, 0);
  }
});

test("a recovered late receipt is retained but cannot update a moved editor or attach audio", async () => {
  const f = setup(), prepared = await f.coordinator.prepare(preparation);
  f.fail("POST"); await assert.rejects(f.coordinator.submit(operation(prepared)), /response lost/);
  f.intercept((method) => { if (method === "GET_KEY") { f.move(); f.stale(); } });
  await assert.rejects(f.coordinator.status(operation(prepared)), /changed/);
  const saved = f.intents.get(prepared.intentId);
  assert.equal(saved.phase, "submitted"); assert.equal(saved.taskRef.taskId, "task-1");
  assert.equal(f.archives.size, 0);
  assert.deepEqual(f.network.map(([method]) => method), ["POST", "GET_KEY"]);
});

test("known-task recovery only queries; an explicit new preparation has a distinct retained key", async () => {
  const f = setup(), prepared = await f.coordinator.prepare(preparation);
  await f.coordinator.submit(operation(prepared));
  const restarted = f.make();
  await restarted.status(operation(prepared)); await restarted.submit(operation(prepared));
  assert.deepEqual(f.network.map(([method]) => method), ["POST", "GET", "GET"]);
  const other = await restarted.prepare(preparation);
  assert.notEqual(other.intentId, prepared.intentId);
  assert.notEqual(f.intents.get(other.intentId).idempotencyKey, f.intents.get(prepared.intentId).idempotencyKey);
  assert.equal(f.network.length, 3);
});

test("stale content, account changes and missing durable acknowledgement cannot dispatch", async () => {
  for (const change of ["stale", "logout", "move", "begin", "after-begin"]) {
    const f = setup(), prepared = await f.coordinator.prepare(preparation);
    if (change === "stale") f.stale();
    if (change === "logout") f.logout();
    if (change === "move") f.move();
    if (change === "begin") f.fail("courseware.tts.begin");
    if (change === "after-begin") f.intercept((method) => { if (method.endsWith("begin")) f.move(); });
    await assert.rejects(f.coordinator.submit(operation(prepared)));
    assert.equal(f.network.length, 0, change);
  }
});

test("an accepted late response is retained after editor changes but cannot appear current", async () => {
  const f = setup(), prepared = await f.coordinator.prepare(preparation);
  f.intercept((method) => { if (method === "POST") { f.stale(); f.move(); } });
  await assert.rejects(f.coordinator.submit(operation(prepared)), /changed/);
  const saved = f.intents.get(prepared.intentId);
  assert.equal(saved.phase, "submitted"); assert.equal(saved.taskRef.taskId, "task-1");
  assert.equal(f.network.length, 1); assert.equal(saved.request.input, "Good! 小朋友😀");
});

test("overlapping submit calls dispatch once and bind uncertainty never silently resubmits", async () => {
  const f = setup(), prepared = await f.coordinator.prepare(preparation);
  let release, started;
  const waiting = new Promise((resolve) => { started = resolve; });
  f.intercept(async (method) => { if (method === "POST") { started(); await new Promise((resolve) => { release = resolve; }); } });
  const running = f.coordinator.submit(operation(prepared)); await waiting;
  await assert.rejects(f.coordinator.submit(operation(prepared)), /IN_FLIGHT/);
  f.fail("courseware.tts.bind"); release(); await assert.rejects(running, /acknowledgement lost/);
  f.fail(undefined);
  await f.make().submit(operation(prepared));
  assert.deepEqual(f.network.map(([method]) => method), ["POST", "GET_KEY"]);
  assert.equal(f.intents.get(prepared.intentId).phase, "submitted");
});

test("query after teaching changes is marked stale and server readiness never adopts audio", async () => {
  const f = setup(), prepared = await f.coordinator.prepare(preparation);
  await f.coordinator.submit(operation(prepared)); f.stale();
  const status = await f.coordinator.status(operation(prepared));
  assert.equal(status.current, false); assert.equal(status.audioReady, false);
  assert.equal(f.network.filter(([method]) => method === "POST").length, 1);
  assert(f.calls.every(([method]) => (method === "courseware.task.get" || method.startsWith("courseware.tts."))));
});


test("archive decodes before staging, redacts paths and recovers without network or teaching writes", async () => {
  const f = setup(), prepared = await f.coordinator.prepare(preparation);
  await assert.rejects(f.coordinator.archive(operation(prepared)), /TASK_REQUIRED/);
  await f.coordinator.submit(operation(prepared));
  const archived = await f.coordinator.archive(operation(prepared));
  assert.deepEqual(archived, { intentId: prepared.intentId, archived: true, durationMs: 100, audioReady: false });
  assert.equal(f.archives.get(prepared.intentId).audio.durationMs, 100);
  assert(f.calls.findIndex(([name]) => name === "decode") < f.calls.findIndex(([name]) => name.endsWith("audio.stage")));
  const network = f.network.length;
  assert.deepEqual(await f.make().archive(operation(prepared)), archived);
  assert.equal(f.network.length, network);
  assert.equal(f.calls.filter(([name]) => name === "decode").length, 1);
  assert(f.calls.every(([name]) => name === "decode" || name === "courseware.task.get" || name.startsWith("courseware.tts.")));
  for (const extra of [{ path: "/etc/passwd" }, { principalKey: "forged" }, { bytesBase64: "AAAA" }, { durationMs: 1 }])
    await assert.rejects(f.coordinator.archive({ ...operation(prepared), ...extra }), /INVALID_REQUEST/);
});

test("failed decode, account/editor changes, corrupt archives and missing durable receipt cannot report success", async () => {
  for (const change of ["decode", "logout-download", "move-decode", "corrupt", "stage"]) {
    const f = setup(), prepared = await f.coordinator.prepare(preparation);
    await f.coordinator.submit(operation(prepared));
    if (change === "decode") f.decodeFailure();
    if (change === "logout-download") f.intercept((method) => { if (method === "DOWNLOAD") f.logout(); });
    if (change === "move-decode") f.intercept((method) => { if (method === "decode") f.move(); });
    if (change === "corrupt") f.fail("courseware.tts.audio.get");
    if (change === "stage") f.fail("courseware.tts.audio.stage");
    await assert.rejects(f.coordinator.archive(operation(prepared)));
    assert.equal(f.archives.size, 0, change);
    assert.equal(f.network.filter(([method]) => method === "POST").length, 1);
    if (change === "corrupt") assert.equal(f.network.length, 1);
  }
});

test("archive overlap rejects and a lost stage reply recovers its committed record without downloading again", async () => {
  const f = setup(), prepared = await f.coordinator.prepare(preparation);
  await f.coordinator.submit(operation(prepared));
  let release, started;
  const waiting = new Promise((resolve) => { started = resolve; });
  f.intercept(async (method) => {
    if (method === "DOWNLOAD") { started(); await new Promise((resolve) => { release = resolve; }); }
    if (method === "after-stage") throw new Error("lost stage reply after commit");
  });
  const running = f.coordinator.archive(operation(prepared)); await waiting;
  await assert.rejects(f.coordinator.archive(operation(prepared)), /IN_FLIGHT/);
  release(); await assert.rejects(running, /lost stage reply/);
  assert.equal(f.archives.size, 1);
  const network = f.network.length;
  assert.equal((await f.make().archive(operation(prepared))).archived, true);
  assert.equal(f.network.length, network);
});

test("snapshot freezes adopted audio from every page without network and rejects stale or foreign receipts", async () => {
  for (const change of [null, "text", "source", "account", "unadopted", "key", "editor", "rebound", "bad-rebound", "unadopted-rebound"]) {
    const principalKey = "a".repeat(64), calls = [];
    const project = { source: { revision: "source-2", sha256: "f".repeat(64) }, pages: [1, 2].map((index) => ({ pageId: `page-${index}`,
      actions: [{ id: `speech-${index}`, type: "speech", text: `Speech ${index}`, audioAssetId: `tts-${String(index).repeat(64)}` }] })) };
    const intents = project.pages.map((page, index) => ({ phase: "submitted", sourceSha256: project.source.sha256,
      selection: { projectId: "project-1", pageId: page.pageId, actionId: page.actions[0].id, principalKey, intentId: `intent-${index}`, expectedSourceRevision: project.source.revision },
      request: { input: page.actions[0].text }, taskRef: { taskId: `task-${index}`, requestHash: "hash", idempotencyKey: `key-${index}` } }));
    const host = { async call(method, params) {
      calls.push(method);
      if (method === "courseware.tts.list") return { intents };
      const intent = intents.find((entry) => entry.selection.intentId === params.intentId);
      if (method === "courseware.tts.get") return { intent };
      const hash = String(intents.indexOf(intent) + 1).repeat(64);
      return { asset: { id: `tts-${hash}`, sha256: hash, mimeType: "audio/wav" },
        audio: { sha256: hash, taskRef: { ...intent.taskRef, ...(change === "key" ? { idempotencyKey: "wrong-key" } : {}) } },
        adoptedTeachingRevision: ["unadopted", "unadopted-rebound"].includes(change) ? null : "older-adoption-revision",
        ...(change?.includes("rebound") ? { boundSource: { ...project.source, ...(change === "bad-rebound" ? { revision: "wrong-source" } : {}) } } : {}) };
    } };
    if (change === "text") intents[1].request.input = "Old text";
    if (change === "source") intents[1].sourceSha256 = "0".repeat(64);
    if (change?.includes("rebound")) for (const intent of intents) {
      intent.sourceSha256 = "0".repeat(64); intent.selection.expectedSourceRevision = "source-1";
    }
    if (change === "account") intents[1].selection.principalKey = "b".repeat(64);
    let captures = 0;
    const teaching = { async ttsContext() { return { host, project, projectId: "project-1", pageId: "page-1", sessionId: "chat-1",
      async assertCurrent() { if (change === "editor") throw new Error("editor changed"); } }; },
    async captureSnapshot(value, assets, assertAccount) { assert.equal(typeof assertAccount, "function"); assertAccount();
      captures++; assert.deepEqual(value, baseline); assert.equal(assets.length, 2);
      assert.deepEqual(assets.map((entry) => entry.tts.intentId), ["intent-0", "intent-1"]);
      assert(assets.every((entry) => !Object.hasOwn(entry, "path"))); return { snapshotId: "snapshot-1" }; } };
    const auth = { getCoursewarePrincipal() { return { key: principalKey, assertCurrent() {} }; } };
    const coordinator = new CoursewareTtsCoordinator(teaching, auth, () => assert.fail("No decoding during snapshot capture"));
    if (change && change !== "rebound") { await assert.rejects(coordinator.captureSnapshot(baseline)); assert.equal(captures, 0, change); }
    else { assert.deepEqual(await coordinator.captureSnapshot(baseline), { snapshotId: "snapshot-1" }); assert.equal(captures, 1); }
    assert(calls.every((method) => ["courseware.tts.list", "courseware.tts.get", "courseware.tts.audio.get"].includes(method)));
  }
});

test("snapshot without speech preserves unauthenticated fixed-preview capture", async () => {
  const teaching = { async ttsContext() { return { project: { pages: [{ actions: [] }] } }; },
    async captureSnapshot(value) { assert.deepEqual(value, baseline); return { snapshotId: "silent" }; } };
  const coordinator = new CoursewareTtsCoordinator(teaching, { getCoursewarePrincipal() { assert.fail("No media account needed"); } },
    () => assert.fail("No audio decoding"));
  assert.deepEqual(await coordinator.captureSnapshot(baseline), { snapshotId: "silent" });
});

test("music-only snapshots use Host adoption proofs and reject missing, foreign and surplus music", async () => {
  for (const changed of [null, "missing", "foreign", "surplus", "hash"]) {
    const principalKey = "a".repeat(64), sha256 = "c".repeat(64), calls = [];
    const asset = { id: `music-${sha256}`, sha256, mimeType: "audio/mpeg" };
    const music = { principalKey, intentId: "export-intent" };
    const proof = { asset, music };
    const project = { pages: [{ actions: [{ id: "song", type: "audio_clip", audioAssetId: asset.id }] },
      { actions: [{ id: "song-repeat", type: "audio_clip", audioAssetId: asset.id }] }] };
    const host = { async call(method, params) {
      calls.push(method); assert.equal(method, "courseware.mediaCanvas.music.snapshotAssets");
      assert.deepEqual(params, { sessionId: "chat-1", projectId: "project-1", principalKey,
        expectedSourceRevision: "source-1", expectedTeachingRevision: "teaching-1" });
      const saved = structuredClone(proof);
      if (changed === "foreign") saved.music.principalKey = "b".repeat(64);
      if (changed === "hash") saved.asset.sha256 = "d".repeat(64);
      return { assets: changed === "missing" ? [] : changed === "surplus" ? [saved, saved] : [saved] };
    } };
    let captures = 0;
    const teaching = { async ttsContext() { return { host, project, sessionId: "chat-1", projectId: "project-1",
      expectedSourceRevision: "source-1", expectedTeachingRevision: "teaching-1", async assertCurrent() {} }; },
    async captureSnapshot(value, assets, assertAccount) {
      assertAccount(); captures++; assert.deepEqual(value, baseline); assert.deepEqual(assets, [proof]);
      return { snapshotId: "music-snapshot" };
    } };
    const coordinator = new CoursewareTtsCoordinator(teaching, {
      getCoursewarePrincipal: () => ({ key: principalKey, assertCurrent() {} }),
    }, () => assert.fail("Snapshot does not decode or generate media"));
    if (changed) { await assert.rejects(coordinator.captureSnapshot(baseline), /AUDIO_REQUIRED/); assert.equal(captures, 0); }
    else assert.deepEqual(await coordinator.captureSnapshot(baseline), { snapshotId: "music-snapshot" });
    assert.equal(calls.length, 1);
  }
});

function quotedFixture() {
  const f = setup();
  const quote = { version: "courseware-media-quote-v1", kind: "tts", model: preparation.model,
    priceVersion: "price-1", maxPoints: 5, maxChars: 4000, expiresAt: "2099-01-01T00:00:00Z", quoteToken: "private-token" };
  f.auth.coursewareMedia.getTtsModels = async () => [{ model: preparation.model, voices: [preparation.voice], providerDefaultVoice: true }];
  f.auth.coursewareMedia.getTtsQuote = async () => structuredClone(quote);
  f.auth.coursewareMedia.submitConfirmedTts = async (key, request, confirmed, signal, projectId) => {
    assert.deepEqual(confirmed, quote);
    return f.auth.coursewareMedia.submitTts(key, request, signal, projectId);
  };
  return { ...f, quote };
}

test("confirmed generation retains quote in Main and posts only after explicit confirmation", async () => {
  const f = quotedFixture();
  assert.equal((await f.coordinator.models(baseline))[0].model, preparation.model);
  const prepared = await f.coordinator.prepare(preparation);
  const quote = await f.coordinator.quote(operation(prepared));
  assert.equal(quote.maxPoints, 5);
  assert(!JSON.stringify(quote).includes("private-token"));
  assert.equal(f.network.length, 0);
  const args = { ...operation(prepared), quoteId: quote.quoteId };
  assert.equal((await f.coordinator.submitConfirmed(args)).phase, "submitted");
  await f.coordinator.submitConfirmed(args);
  assert.equal(f.network.filter(([method]) => method === "POST").length, 1);
});

test("missing, expired, foreign intent and restart quotes reject before begin or paid POST", async () => {
  for (const mode of ["missing", "expired", "foreign", "restart"]) {
    const f = quotedFixture();
    const prepared = await f.coordinator.prepare(preparation);
    if (mode === "expired") f.quote.expiresAt = "2000-01-01T00:00:00Z";
    const quote = await f.coordinator.quote(operation(prepared));
    const target = mode === "foreign" ? await f.coordinator.prepare(preparation) : prepared;
    const coordinator = mode === "restart" ? f.make() : f.coordinator;
    await assert.rejects(coordinator.submitConfirmed({ ...operation(target), quoteId: mode === "missing" ? "missing" : quote.quoteId }), /QUOTE_REQUIRED/);
    assert.equal(f.network.length, 0);
    assert(!f.calls.some(([name]) => name === "courseware.tts.begin"));
  }
});

test("confirmed submission with lost receipt recovers the original task without another paid POST", async () => {
  const f = quotedFixture(), prepared = await f.coordinator.prepare(preparation);
  const quote = await f.coordinator.quote(operation(prepared));
  f.fail("POST");
  const args = { ...operation(prepared), quoteId: quote.quoteId };
  await assert.rejects(f.coordinator.submitConfirmed(args), /response lost/);
  assert.equal((await f.coordinator.submitConfirmed(args)).phase, "submitted");
  assert.deepEqual(f.network.map(([method]) => method), ["POST", "GET_KEY"]);
});

test("team binding is taken from durable Host begin, including first binding before begin", async () => {
  const project = "12345678-1234-1234-1234-123456789abc";
  const f = setup(); f.team(project);
  const prepared = await f.coordinator.prepare(preparation);
  await f.coordinator.submit(operation(prepared));
  assert.equal(f.network.filter(([method]) => method === "POST").length, 1);
  const changed = setup(); const pending = await changed.coordinator.prepare(preparation);
  changed.intercept(async method => { if (method === "courseware.tts.begin") changed.team(project); });
  await changed.coordinator.submit(operation(pending));
  assert.equal(changed.intents.get(pending.intentId).submissionScope.teamProjectId, project);
  assert.equal(changed.network.length, 1);
});

test("missing or malformed durable submission scope cannot fall back to a personal request", async () => {
  for (const value of [undefined, null, {}, [], { sessionId: "chat-1" },
    { sessionId: "foreign", teamProjectId: null }, { sessionId: "chat-1", teamProjectId: "../other" },
    { sessionId: "chat-1", teamProjectId: undefined }, { sessionId: "chat-1", teamProjectId: null, extra: true }]) {
    assert.throws(() => scopeExports.coursewareMediaSubmissionProject(value, "chat-1"), /INVALID_SUBMISSION_SCOPE/);
    const f = setup(), prepared = await f.coordinator.prepare(preparation);
    f.intercept(async (method, intent) => { if (method === "after-begin") intent.submissionScope = value; });
    await assert.rejects(f.coordinator.submit(operation(prepared)), /INVALID_SUBMISSION_SCOPE/);
    assert.equal(f.network.length, 0);
  }
  assert.equal(scopeExports.coursewareMediaSubmissionProject({ sessionId: "chat-1", teamProjectId: null }, "chat-1"), undefined);
});

test("first binding after durable begin cannot retarget the pinned personal request", async () => {
  const f = setup(), prepared = await f.coordinator.prepare(preparation);
  f.intercept(async method => { if (method === "after-begin") f.team("12345678-1234-1234-1234-123456789abc"); });
  await f.coordinator.submit(operation(prepared));
  assert.deepEqual(f.intents.get(prepared.intentId).submissionScope, { sessionId: "chat-1", teamProjectId: null });
  assert.equal(f.network.length, 1);
});

for (const code of [46100, 46102]) test(`definite team TTS refusal ${code} persists and never resubmits`, async () => {
  const f = setup(); f.team("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
  f.intercept(async method => { if (method === "POST") throw new Error(`COURSEWARE_MEDIA_PLATFORM_${code}`); });
  const first = await f.coordinator.prepare(preparation);
  assert.equal((await f.coordinator.submit(operation(first))).phase, "rejected");
  assert.equal(f.intents.get(first.intentId).taskRef, null);
  const restarted = f.make();
  assert.equal((await restarted.status(operation(first))).phase, "rejected");
  assert.equal((await restarted.submit(operation(first))).phase, "rejected");
  assert.equal(f.network.length, 1);
  f.intercept(undefined); const next = await restarted.prepare(preparation);
  assert.notEqual(f.intents.get(next.intentId).idempotencyKey, f.intents.get(first.intentId).idempotencyKey);
  assert.equal(f.network.length, 1, "preparation cannot auto-submit");
  assert.equal((await restarted.submit(operation(next))).phase, "submitted");
});

test("permission refusal classifier excludes generic HTTP errors and personal scope", () => {
  for (const code of [46100, 46102]) assert.equal(scopeExports.isCoursewareMediaPermissionRefusal(
    new Error(`COURSEWARE_MEDIA_PLATFORM_${code}`), "team"), true);
  for (const failure of [new Error("COURSEWARE_MEDIA_PLATFORM_403"), new Error("fetch failed"),
    new Error("COURSEWARE_MEDIA_PLATFORM_46102 extra"), { message: "COURSEWARE_MEDIA_PLATFORM_46102" }])
    assert.equal(scopeExports.isCoursewareMediaPermissionRefusal(failure, "team"), false);
  assert.equal(scopeExports.isCoursewareMediaPermissionRefusal(new Error("COURSEWARE_MEDIA_PLATFORM_46102"), undefined), false);
});

test("confirmed team TTS refusal consumes the quote and a new attempt needs fresh fee confirmation", async () => {
  const f = quotedFixture(); f.team("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
  f.intercept(async method => { if (method === "POST") throw new Error("COURSEWARE_MEDIA_PLATFORM_46102"); });
  const first = await f.coordinator.prepare(preparation), quote = await f.coordinator.quote(operation(first));
  assert.equal((await f.coordinator.submitConfirmed({ ...operation(first), quoteId: quote.quoteId })).phase, "rejected");
  const next = await f.coordinator.prepare(preparation);
  f.intercept(undefined);
  await assert.rejects(f.coordinator.submitConfirmed({ ...operation(next), quoteId: quote.quoteId }), /QUOTE_REQUIRED/);
  assert.equal(f.network.length, 1);
  const offer = await f.coordinator.quote(operation(next));
  assert.notEqual(offer.quoteId, quote.quoteId);
  assert.equal((await f.coordinator.submitConfirmed({ ...operation(next), quoteId: offer.quoteId })).phase, "submitted");
});


test("native speech preview returns verified adopted local bytes and refuses changed source/text or corrupt files", async () => {
  const directory = await mkdtemp(join(tmpdir(), "native-speech-preview-"));
  try {
    const bytes = Buffer.from("RIFF0123WAVEfixture");
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const path = join(directory, "speech.wav"); await writeFile(path, bytes);
    const source = { revision: "source-1", sha256: "f".repeat(64) };
    const action = { id: "speech-1", type: "speech", text: "Hello", audioAssetId: `tts-${sha256}` };
    const selection = { projectId: "project-1", pageId: "page-1", principalKey: "principal", actionId: action.id, intentId: "intent-1", expectedSourceRevision: source.revision };
    let requestText = "Hello", active = true;
    const coordinator = new CoursewareTtsCoordinator({ async ttsContext() {
      return { sessionId: "chat", projectId: selection.projectId, pageId: selection.pageId,
        project: { source, pages: [{ pageId: selection.pageId, actions: [action] }] },
        async assertCurrent() { if (!active) throw new Error("changed editor"); },
        host: { async call(method) {
          if (method === "courseware.tts.list") return { intents: [{ selection, phase: "submitted" }] };
          if (method === "courseware.tts.get") return { intent: { request: { input: requestText }, sourceSha256: "f".repeat(64) } };
          if (method === "courseware.tts.audio.get") return { path, asset: { id: action.audioAssetId }, audio: { mimeType: "audio/wav", byteLength: bytes.length, sha256 } };
          throw new Error("Unexpected RPC " + method);
        } },
      };
    } }, { getCoursewarePrincipal: () => ({ key: "principal", assertCurrent() {} }),
      coursewareMedia: new Proxy({}, { get() { throw new Error("Preview must never call a provider"); } }) }, async () => { throw new Error("Preview must never decode or regenerate"); });
    const params = { ...baseline, actionId: action.id };
    const result = await coordinator.preview(params);
    assert.equal(result.mimeType, "audio/wav"); assert.deepEqual(Buffer.from(result.bytes), bytes);
    assert.equal(Object.hasOwn(result, "path"), false);
    requestText = "Old narration"; await assert.rejects(coordinator.preview(params), /AUDIO_REQUIRED/); requestText = "Hello";
    source.revision = "changed"; await assert.rejects(coordinator.preview(params), /AUDIO_REQUIRED/); source.revision = "source-1";
    await writeFile(path, Buffer.from("X".repeat(bytes.length)));
    await assert.rejects(coordinator.preview(params), /INTEGRITY/);
    await writeFile(path, bytes); active = false;
    await assert.rejects(coordinator.preview(params), /changed editor/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("snapshot capture resolves reused video placement provenance without a provider lookup", async () => {
  const source = { revision: "source", sha256: "f".repeat(64) }, assetId = `video-${"a".repeat(64)}`;
  const project = { source, pages: [{ pageId: "new-page", actions: [{ id: "new-node", type: "video_clip", videoAssetId: assetId }] }] };
  let snapshotAssets;
  const coordinator = new CoursewareTtsCoordinator({ async ttsContext() { return { projectId: "project", pageId: "new-page", sessionId: "session", project,
    async assertCurrent() {}, host: { async call(method) {
      assert.equal(method, "courseware.video.list");
      return { intents: [{ phase: "adopted", intentId: "original", pageId: "old-page", slotId: "old-node", source,
        placements: [{ pageId: "new-page", actionId: "new-node" }], asset: { sha256: "a".repeat(64) } }] };
    } } }; }, async captureSnapshot(_input, assets) { snapshotAssets = assets; return "snapshot"; } },
    { getCoursewarePrincipal: () => ({ key: "b".repeat(64), assertCurrent() {} }) });
  assert.equal(await coordinator.captureSnapshot({ viewId: "view", expectedTeachingRevision: "rev" }), "snapshot");
  assert.deepEqual(snapshotAssets, [{ asset: { id: assetId, sha256: "a".repeat(64), mimeType: "video/mp4" }, video: { principalKey: "b".repeat(64), intentId: "original" } }]);
});
