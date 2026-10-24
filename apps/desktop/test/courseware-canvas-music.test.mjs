import assert from "node:assert/strict";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as files from "node:fs/promises";
import * as paths from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import ts from "typescript";
import * as shared from "../../../packages/shared/dist/index.js";
import { loadCoursewareMedia } from "./fixtures/courseware-media-loader.mjs";

async function load(name, dependencies) {
  const exports = {};
  const source = await files.readFile(new URL(`../electron/main/${name}.ts`, import.meta.url), "utf8");
  new Function("require", "exports", ts.transpileModule(source, { compilerOptions: {
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS,
  } }).outputText)(name => { assert(Object.hasOwn(dependencies, name), name); return dependencies[name]; }, exports);
  return exports;
}
const requests = await loadCoursewareMedia("courseware-music-request");
const { musicRequestHash } = requests;
const mediaScope = await load("courseware-media-scope", {});
const { CoursewareCanvasMusic } = await load("courseware-canvas-music", { "node:crypto": crypto, "node:fs": fs,
  "node:fs/promises": files, "node:path": paths, "@pi-desktop/shared": shared,
  "./courseware-music-request": requests, "./courseware-media-scope": mediaScope });
const candidateIds = ["11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222"];
const audio = Buffer.from([73,68,51,4,0,0,0,0,0,0,1,2,3,4]);
const hash = value => crypto.createHash("sha256").update(value).digest("hex");
const rpc = method => `courseware.mediaCanvas.music.${method}`;
const clone = value => structuredClone(value);

async function fixture(t) {
  const directory = await files.mkdtemp(paths.join(tmpdir(), "deckwise-music-main-"));
  t.after(() => files.rm(directory, { recursive: true, force: true }));
  const state = { sessionId: "chat", principal: "a".repeat(64), mode: "agent", running: false, team: null,
    draft: { id: "song", kind: "music", revision: 0, title: "Fruit song", prompt: "Good job, red apple!", references: [], x: 0, y: 0 },
    lost: false, failure: null, afterSubmit: null, afterQuote: null, nextTask: 0 };
  const journals = new Map(), tasks = new Map(), calls = [], provider = [];
  const key = p => JSON.stringify([p.sessionId, p.principalKey, p.intentId]);
  const saved = p => { const i = journals.get(key(p)); assert(i, "journal required"); return i; };
  const wrap = i => ({ current: JSON.stringify(i.draft) === JSON.stringify(state.draft), intent: clone(i) });
  const host = { async call(method, p) {
    calls.push([method, clone(p)]);
    if (method === "session.get") return { session: { projectPath: directory, mode: state.mode } };
    if (method === rpc("list")) return { intents: [...journals.entries()].filter(([k]) => {
      const [session, principal] = JSON.parse(k); return session === p.sessionId && principal === p.principalKey;
    }).map(([, i]) => wrap(i)) };
    if (method === rpc("prepare") || method === rpc("export.prepare")) {
      let i = journals.get(key(p));
      if (!i) {
        const parent = p.sourceIntentId ? saved({ ...p, intentId: p.sourceIntentId }) : null;
        const request = parent ? { kind: "music-export", model: p.model, input: p.candidateId }
          : { kind: "music", model: p.model, input: state.draft.prompt, music: clone(p.music) };
        i = { intentId: p.intentId, draft: clone(parent?.draft ?? state.draft), request, idempotencyKey: crypto.randomUUID(),
          requestHash: musicRequestHash(request), phase: "prepared", taskRef: null, candidates: [], ready: false, previews: [],
          ...(parent ? { sourceIntentId: p.sourceIntentId, submissionScope: parent.submissionScope } : {}) };
        journals.set(key(p), i);
      }
      return wrap(i);
    }
    const i = saved(p);
    if (method === rpc("begin")) {
      assert.equal(i.phase, "prepared"); i.phase = "submission-unknown";
      i.submissionScope ??= { sessionId: p.sessionId, teamProjectId: state.team };
    } else if (method === rpc("bind")) { i.phase = "submitted"; i.taskRef = p.taskRef; }
    else if (method === rpc("reject")) { i.phase = "rejected"; }
    else if (method === rpc("candidates.record")) { i.candidates = p.candidates; i.ready = p.ready; }
    else if (method === rpc("asset.stage")) {
      await files.writeFile(paths.join(directory, `${p.asset.sha256}.bin`), Buffer.from(p.bytesBase64, "base64"));
      if (p.candidateId) i.previews.push({ candidateId: p.candidateId, asset: p.asset }); else i.asset = p.asset;
    } else if (method === rpc("asset.get")) {
      const a = p.candidateId ? i.previews.find(v => v.candidateId === p.candidateId).asset : i.asset;
      return { ...wrap(i), path: paths.join(directory, `${a.sha256}.bin`) };
    } else assert.equal(method, rpc("get"));
    return wrap(i);
  } };
  const candidates = () => candidateIds.map((candidateId, order) => ({ candidateId, order, state: "completed", exportable: true }));
  const taskFor = (request, key) => ({ version: "courseware-media-v1", taskId: `task-${++state.nextTask}`, idempotencyKey: key,
    requestHash: musicRequestHash(request), kind: request.kind, model: request.model, state: "ready", feeState: "settled",
    reservedPoints: 5, actualPoints: 5, receiptId: `courseware-media:task-${state.nextTask}`, errorCode: null,
    assetRef: request.kind === "music" ? null : { assetId: "export-asset", sha256: hash(audio), mime: "audio/mpeg", byteLength: audio.length } });
  const music = {
    async models(kind) { provider.push(["models", kind]); return [{ model: kind === "music" ? "song-model" : "export-model" }]; },
    async quote(model, kind) { provider.push(["quote", kind]); await state.afterQuote?.(); return { version: "courseware-media-quote-v1", model, kind,
      priceVersion: "fixture", maxPoints: 5, maxChars: 4000, expiresAt: "2099-01-01T00:00:00Z", quoteToken: "fixture" }; },
    async submitConfirmed(key, request, quote, signal, team) {
      provider.push(["POST", key, clone(request), team]); assert.equal(quote.kind, request.kind);
      assert.equal([...journals.values()].find(i => i.idempotencyKey === key)?.phase, "submission-unknown");
      if (state.failure) throw new Error(state.failure);
      const task = taskFor(request, key); tasks.set(key, task); await state.afterSubmit?.();
      if (state.lost) throw new Error("lost response"); return clone(task);
    },
    async get(ref, kind) { provider.push(["GET", ref.taskId]); const task = tasks.get(ref.idempotencyKey); assert.equal(task.kind, kind); return clone(task); },
    async find(ref, kind) { provider.push(["FIND", ref.idempotencyKey]); const task = tasks.get(ref.idempotencyKey); if (task) assert.equal(task.kind, kind); return clone(task ?? null); },
    async candidates(ref) { provider.push(["CANDIDATES", ref.taskId]); return { task: clone(tasks.get(ref.idempotencyKey)), candidates: candidates() }; },
    async preview(ref, candidateId) { provider.push(["PREVIEW", candidateId]); return { task: clone(tasks.get(ref.idempotencyKey)),
      candidates: candidates(), candidate: candidates().find(c => c.candidateId === candidateId), bytes: audio,
      preview: { sha256: hash(audio), mimeType: "audio/mpeg", byteLength: audio.length } }; },
    async downloadExport(ref) { provider.push(["DOWNLOAD", ref.taskId]); return { task: clone(tasks.get(ref.idempotencyKey)), bytes: audio }; },
  };
  const make = (adoption) => new CoursewareCanvasMusic(() => host, () => state.sessionId, () => state.running, {
    coursewareMedia: { music }, getCoursewarePrincipal() {
      const key = state.principal;
      return { key, assertCurrent() { if (state.principal !== key) throw new Error("account changed"); } };
    },
  }, adoption);
  const operation = { sessionId: "chat", intentId: "song-intent" };
  const prepare = async (main = make()) => main.prepare({ ...operation, draftId: "song", expectedRevision: "canvas-sha", expectedDraftRevision: 0,
    model: "song-model", music: { title: state.draft.title, tags: "gentle", instrumental: false } });
  const submit = async (main, op = operation, exported = false) => {
    const quote = await (exported ? main.exportQuote(op) : main.quote(op));
    return exported ? main.exportSubmitConfirmed({ ...op, quoteId: quote.quoteId }) : main.submitConfirmed({ ...op, quoteId: quote.quoteId });
  };
  return { state, journals, tasks, calls, provider, directory, make, operation, prepare, submit, music, host };
}

async function adoptableFixture(t) {
  const f = await fixture(t), adopted = [], decoded = [];
  const target = { host: f.host, sessionId: "chat", expectedTeachingRevision: "teaching-1",
    async assertCurrent() { if (f.state.staleTarget) throw new Error("Teaching view changed"); },
    async adoptMusic(value) { await this.assertCurrent(); adopted.push(value); return { viewId: "view-2" }; } };
  const main = f.make({ teaching: { async musicAdoptionContext(p) {
    assert.equal(p.viewId, "view-1"); assert.equal(p.expectedTeachingRevision, "teaching-1");
    await target.assertCurrent(); return target;
  } }, async decodeAudio(bytes, mime) {
    decoded.push([bytes, mime]); await f.state.afterDecode?.(); return f.state.durationMs ?? 1400;
  } });
  await f.prepare(main); await f.submit(main);
  const op = { sessionId: "chat", intentId: "export-intent" };
  await main.exportPrepare({ ...f.operation, exportIntentId: op.intentId, candidateId: candidateIds[0], model: "export-model" });
  await f.submit(main, op, true); await main.exportArchive(op);
  return { ...f, main, target, decoded, adopted, op, input: { ...op, viewId: "view-1", expectedTeachingRevision: "teaching-1" } };
}

test("explicit adoption decodes only the archived export and reauthorizes without buying music", async t => {
  const f = await adoptableFixture(t), before = f.provider.length;
  assert.deepEqual(await f.main.adopt(f.input), { viewId: "view-2" });
  assert.deepEqual(f.adopted, [{ principalKey: f.state.principal, intentId: f.op.intentId,
    assetId: `music-${hash(audio)}`, durationMs: 1400 }]);
  assert.deepEqual(f.decoded, [[audio, "audio/mpeg"]]);
  assert.deepEqual(f.provider.slice(before).map(v => v[0]), ["GET"]);
});

test("previews, absent exports and invalid decoder output cannot become teaching music", async t => {
  const f = await adoptableFixture(t);
  await assert.rejects(f.main.adopt({ ...f.input, intentId: f.operation.intentId }), /INVALID_JOURNAL/);
  f.journals.get(JSON.stringify(["chat", f.state.principal, f.op.intentId])).asset = null;
  await assert.rejects(f.main.adopt(f.input), /ARCHIVE_REQUIRED/);
  assert.equal(f.adopted.length, 0); assert.equal(f.decoded.length, 0);
  await f.main.exportArchive(f.op); f.state.durationMs = 0;
  await assert.rejects(f.main.adopt(f.input), /INVALID_DURATION/);
  assert.equal(f.adopted.length, 0);
});

test("page, account and active Chat changes during music decoding refuse adoption", async t => {
  for (const change of [f => { f.state.staleTarget = true; }, f => { f.state.principal = "b".repeat(64); },
    f => { f.state.sessionId = "other-chat"; }]) {
    const f = await adoptableFixture(t); f.state.afterDecode = () => change(f);
    await assert.rejects(f.main.adopt(f.input), /changed|CONTEXT_CHANGED/);
    assert.equal(f.adopted.length, 0);
  }
});

test("revoked permission and changed export receipts refuse local music adoption", async t => {
  const f = await adoptableFixture(t);
  f.music.get = async () => { throw new Error("PERMISSION_DENIED"); };
  await assert.rejects(f.main.adopt(f.input), /PERMISSION_DENIED/);
  assert.equal(f.adopted.length, 0);
  f.music.get = async () => ({ ...f.tasks.get(f.journals.get(JSON.stringify(["chat", f.state.principal, f.op.intentId])).idempotencyKey),
    assetRef: { sha256: "b".repeat(64), mime: "audio/mpeg", byteLength: audio.length } });
  await assert.rejects(f.main.adopt(f.input), /INVALID_JOURNAL/);
  assert.equal(f.adopted.length, 0);
});

test("generation quotes cannot submit without explicit consent and frozen scope", async t => {
  const f = await fixture(t), main = f.make();
  assert.deepEqual(await main.models({ sessionId: "chat" }), { generation: [{ model: "song-model" }], export: [{ model: "export-model" }] });
  await f.prepare(main);
  await assert.rejects(main.submitConfirmed({ ...f.operation, quoteId: "missing" }), /QUOTE_REQUIRED/);
  assert(!f.calls.some(([m]) => m === rpc("begin")));
  const quoted = await main.quote(f.operation);
  f.state.draft.prompt = "changed";
  await assert.rejects(main.submitConfirmed({ ...f.operation, quoteId: quoted.quoteId }), /DRAFT_CHANGED/);
  assert(!f.provider.some(([m]) => m === "POST"));
});

test("lost generation response recovers by GET after coordinator restart without repost", async t => {
  const f = await fixture(t), main = f.make(); await f.prepare(main); f.state.lost = true;
  await assert.rejects(f.submit(main), /lost response/);
  assert.equal((await main.list({ sessionId: "chat" }))[0].phase, "submission-unknown");
  const restarted = f.make(), recovered = await restarted.status(f.operation);
  assert.equal(recovered.phase, "submitted"); assert.equal(recovered.candidates.length, 2);
  await restarted.submitConfirmed({ ...f.operation, quoteId: "old-quote" });
  assert.equal(f.provider.filter(([m]) => m === "POST").length, 1);
});

test("unknown not-found remains recoverable and never automatically posts again", async t => {
  const f = await fixture(t), main = f.make(); await f.prepare(main); f.state.failure = "network unknown";
  await assert.rejects(f.submit(main), /network unknown/);
  assert.equal((await main.status(f.operation)).phase, "submission-unknown");
  assert.equal((await main.submitConfirmed({ ...f.operation, quoteId: "expired" })).phase, "submission-unknown");
  assert.equal(f.provider.filter(([m]) => m === "POST").length, 1);
});

test("all candidate previews remain private cached reads and export needs its own quote", async t => {
  const f = await fixture(t), main = f.make(); await f.prepare(main); await f.submit(main); await main.status(f.operation);
  for (const candidateId of candidateIds) {
    const preview = await main.preview({ ...f.operation, candidateId });
    assert.equal(preview.dataUrl, `data:audio/mpeg;base64,${audio.toString("base64")}`);
  }
  const count = f.provider.length;
  await f.make().preview({ ...f.operation, candidateId: candidateIds[1] }); assert.equal(f.provider.length, count);
  f.state.draft.prompt = "new revision";
  const exp = await main.exportPrepare({ ...f.operation, exportIntentId: "export-intent", candidateId: candidateIds[1], model: "export-model" });
  const op = { sessionId: "chat", intentId: exp.intentId };
  assert.equal(exp.operation, "music-export"); assert.equal(exp.current, false);
  await assert.rejects(main.exportSubmitConfirmed({ ...op, quoteId: "generation-quote" }), /QUOTE_REQUIRED/);
  await f.submit(main, op, true);
  const result = await main.exportArchive(op); assert.equal(result.candidateId, undefined);
  assert.equal(result.dataUrl, `data:audio/mpeg;base64,${audio.toString("base64")}`);
  const downloads = f.provider.filter(([m]) => m === "DOWNLOAD").length;
  await f.make().exportArchive(op); assert.equal(f.provider.filter(([m]) => m === "DOWNLOAD").length, downloads);
  assert.equal(f.provider.filter(([m]) => m === "POST").length, 2);
});

test("team refusal persists rejected state and does not fall back or resubmit", async t => {
  const f = await fixture(t), main = f.make(); f.state.team = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  await f.prepare(main); f.state.failure = "COURSEWARE_MEDIA_PLATFORM_46102";
  assert.equal((await f.submit(main)).phase, "rejected");
  assert.equal((await f.make().status(f.operation)).phase, "rejected");
  assert.equal((await main.submitConfirmed({ ...f.operation, quoteId: "old" })).phase, "rejected");
  assert.equal(f.provider.filter(([m]) => m === "POST").length, 1);
  assert.equal(f.provider.find(([m]) => m === "POST")[3], f.state.team);
});

test("late accepted receipt persists in original account but cannot paint another account", async t => {
  const f = await fixture(t), main = f.make(); await f.prepare(main);
  f.state.afterSubmit = () => { f.state.principal = "b".repeat(64); };
  await assert.rejects(f.submit(main), /account changed/);
  assert.equal([...f.journals.values()][0].phase, "submitted");
  assert.deepEqual(await f.make().list({ sessionId: "chat" }), []);
  f.state.principal = "a".repeat(64); assert.equal((await f.make().status(f.operation)).candidates.length, 2);
});

test("corrupt cached audio fails without another download or paid call", async t => {
  const f = await fixture(t), main = f.make(); await f.prepare(main); await f.submit(main);
  const preview = await main.preview({ ...f.operation, candidateId: candidateIds[0] });
  await files.writeFile(paths.join(f.directory, `${preview.asset.sha256}.bin`), Buffer.alloc(audio.length));
  const count = f.provider.length;
  await assert.rejects(f.make().preview({ ...f.operation, candidateId: candidateIds[0] }), /INTEGRITY_ERROR/);
  assert.equal(f.provider.length, count);
});

test("malformed caller fields and quote account changes fail before submission", async t => {
  const f = await fixture(t), main = f.make();
  for (const value of [{ sessionId: "chat", principalKey: "override" }, { sessionId: "../chat" }]) await assert.rejects(main.list(value), /INVALID_REQUEST/);
  await f.prepare(main); f.state.afterQuote = () => { f.state.principal = "b".repeat(64); };
  await assert.rejects(main.quote(f.operation), /account changed/);
  assert(!f.calls.some(([m]) => m === rpc("begin")));
  assert(!f.provider.some(([m]) => m === "POST"));
});

test("all thirteen music IPC operations require the main sender and exact argument count", async () => {
  const source = await files.readFile(new URL("../electron/main/ipc/courseware-canvas-music-ipc.ts", import.meta.url), "utf8");
  const calls = [], methods = ["models", "list", "prepare", "quote", "submitConfirmed", "status", "preview", "exportPrepare", "exportQuote", "exportSubmitConfirmed", "exportStatus", "exportArchive", "adopt"];
  class Coordinator { constructor() {} }
  for (const method of methods) Coordinator.prototype[method] = async p => { calls.push(method); return p; };
  const exports = {};
  new Function("require", "exports", ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText)(id =>
    id === "@pi-desktop/shared" ? shared : { CoursewareCanvasMusic: Coordinator }, exports);
  const handlers = new Map(), sender = {};
  exports.registerCoursewareCanvasMusicIpc({ registrar: { handleWithEvent: (channel, fn) => handlers.set(channel, fn),
    assertMainWindowSender: actual => assert.equal(actual, sender, "main sender required") },
    getHost: () => null, getViewingSessionId: () => "chat", activeTurns: new Map(), authSession: {} });
  assert.equal(handlers.size, methods.length);
  for (const fn of handlers.values()) {
    const before = calls.length; await assert.rejects(fn({}, {}), /main sender/); await assert.rejects(fn(sender, {}, 1), /Unexpected/);
    assert.equal(calls.length, before); assert.deepEqual(await fn(sender, { sessionId: "chat" }), { sessionId: "chat" });
  }
});
