import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import * as fsConstants from "node:fs";
import * as files from "node:fs/promises";
import { createRequire, register } from "node:module";
import { tmpdir } from "node:os";
import * as paths from "node:path";
import test from "node:test";
import { crc32 } from "node:zlib";
import ts from "typescript";

register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const shared = await import("@pi-desktop/shared");
const sharp = createRequire(new URL("../../../packages/courseware-runtime/package.json", import.meta.url))("sharp");
const png = await sharp({ create: { width: 2, height: 2, channels: 4, background: "red" } }).png().toBuffer();
async function load(name, dependencies) {
  const exports = {};
  new Function("require", "exports", ts.transpileModule(await files.readFile(new URL(`../electron/main/${name}.ts`, import.meta.url), "utf8"), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText)(id => { assert(Object.hasOwn(dependencies, id), `Unexpected dependency: ${id}`); return dependencies[id]; }, exports);
  return exports;
}
// Only Electron's native codec is mocked; archive reads, hashes and PNG validation are real.
const electron = { nativeImage: { createFromBuffer: () => ({ isEmpty: () => false,
  getSize: () => ({ width: 2, height: 2 }), toBitmap: () => Buffer.alloc(16) }) } };
const context = await load("courseware-scene-context", { electron, "node:crypto": { createHash }, "node:zlib": { crc32 } });
const assets = await load("courseware-scene-image-assets", { electron, "node:crypto": { createHash },
  "node:fs": fsConstants, "node:fs/promises": files, "node:path": paths, "./courseware-scene-context": context, "./public-https-fetch": await load("public-https-fetch", {
    "node:dns/promises": await import("node:dns/promises"), "@pi-desktop/shared": shared }) });
const mediaScope = await load("courseware-media-scope", {});
const { CoursewareCanvasImages } = await load("courseware-canvas-images", { "node:crypto": { createHash, randomUUID },
  "@pi-desktop/shared": shared, "./courseware-scene-image-assets": assets, "./courseware-media-scope": mediaScope });
const principalA = "a".repeat(64), principalB = "b".repeat(64);
const rpc = name => `courseware.mediaCanvas.image.${name}`;
const digest = value => createHash("sha256").update(value).digest("hex");
function requestHash(request) {
  const fields = [request.kind, request.model, request.input, null];
  if (request.referenceImage) fields.push(request.referenceImage.sha256, request.referenceImage.mimeType, String(request.referenceImage.byteLength));
  return digest(fields.reduce((text, value) => `${text}:${value === null ? -1 : value.length}:${value ?? ""}`, "courseware-media-v1"));
}
function pause(t) {
  let enter, release;
  const entered = new Promise(resolve => { enter = resolve; }), pending = new Promise(resolve => { release = resolve; });
  t.after(release);
  return { entered, release, wait() { enter(); return pending; } };
}

async function fixture(t, { reference = false } = {}) {
  const root = await files.mkdtemp(paths.join(tmpdir(), "deckwise-canvas-images-"));
  t.after(() => files.rm(root, { recursive: true, force: true }));
  const asset = { sha256: digest(png), mimeType: "image/png", byteLength: png.length, width: 2, height: 2 };
  const referenceImage = { sha256: asset.sha256, mimeType: asset.mimeType, byteLength: asset.byteLength };
  const referencePath = paths.join(root, `${asset.sha256}.bin`);
  await files.writeFile(referencePath, png);
  const draft = { id: "draft-1", revision: 2, kind: "image", title: "Circle", prompt: "Bright circle 圆 🎨",
    references: reference ? [{ assetId: "scene-image-original", revision: asset.sha256, label: "Reviewed circle" }] : [], x: 12, y: 24 };
  const state = { account: principalA, active: "chat-a", running: false, mode: "agent", canvasRevision: "canvas-v2",
    draft, supportsReference: true, lostReceipt: false, missing: false, taskPatch: {}, downloadBytes: png,
    reference: { reference: referenceImage, asset, path: referencePath } };
  const journals = new Map(), tasks = new Map(), calls = [], hooks = new Map();
  const partition = p => JSON.stringify([p.sessionId, p.principalKey]);
  const records = p => journals.get(partition(p)) ?? [];
  const current = intent => ({ current: JSON.stringify(intent.draft) === JSON.stringify(state.draft), intent: structuredClone(intent) });
  const host = { async call(method, p) {
    calls.push({ method, params: structuredClone(p) });
    let result;
    if (method === "courseware.task.get") result = { task: { teamProjectId: state.teamProjectId } };
    else if (method === "session.get") result = { session: { projectPath: root, mode: state.mode } };
    else if (method === rpc("list")) result = { intents: records(p).map(current) };
    else if (method === rpc("prepare")) {
      assert.equal(p.expectedRevision, state.canvasRevision, "Host canvas CAS");
      assert.equal(p.draftId, state.draft.id, "Host draft identity");
      assert.equal(p.expectedDraftRevision, state.draft.revision, "Host draft CAS");
      let intent = records(p).find(row => row.intentId === p.intentId);
      if (!intent) {
        const request = { kind: "image", model: p.model, input: state.draft.prompt,
          ...(state.draft.references.length ? { referenceImage: structuredClone(referenceImage) } : {}) };
        intent = { intentId: p.intentId, draft: structuredClone(state.draft), request,
          idempotencyKey: randomUUID(), requestHash: requestHash(request), phase: "prepared", taskRef: null };
        journals.set(partition(p), [...records(p), intent]);
      }
      result = current(intent);
    } else {
      const intent = records(p).find(row => row.intentId === p.intentId);
      if (!intent) throw new Error("COURSEWARE_NOT_FOUND");
      if (method === rpc("reference")) result = structuredClone(state.reference);
      else {
        if (method === rpc("begin")) {
          if (!current(intent).current || intent.phase !== "prepared") throw new Error("HOST_DRAFT_CHANGED");
          intent.submissionScope = { sessionId: p.sessionId, teamProjectId: state.teamProjectId ?? null };
          intent.phase = "submission-unknown";
          calls.push({ method: "WAL begin", params: structuredClone(p) });
        } else if (method === rpc("reject")) {
          assert.equal(intent.phase, "submission-unknown");
          assert(intent.submissionScope.teamProjectId);
          assert.deepEqual(p.rejectedRequest, { idempotencyKey: intent.idempotencyKey, requestHash: intent.requestHash });
          intent.phase = "rejected";
        } else if (method === rpc("bind")) {
          assert.notEqual(intent.phase, "prepared");
          assert(shared.isCoursewareTaskRef(p.taskRef));
          assert.equal(p.taskRef.idempotencyKey, intent.idempotencyKey);
          assert.equal(p.taskRef.requestHash, intent.requestHash);
          if (intent.taskRef) assert.deepEqual(p.taskRef, intent.taskRef, "Host cannot replace a receipt");
          intent.taskRef = structuredClone(p.taskRef); intent.phase = "submitted";
        } else if ([rpc("asset.stage"), rpc("asset.restore")].includes(method)) {
          if (method === rpc("asset.restore")) assert(intent.asset, "Only an already archived candidate can be restored");
          assert.equal(intent.phase, "submitted"); assert.deepEqual(p.asset.taskRef, intent.taskRef);
          if (intent.asset) assert.deepEqual(p.asset, intent.asset, "Host archive is immutable");
          await files.writeFile(paths.join(root, `${p.asset.sha256}.bin`), Buffer.from(p.bytesBase64, "base64"));
          intent.asset = structuredClone(p.asset);
        } else assert([rpc("get"), rpc("asset.get")].includes(method), method);
        result = current(intent);
        if (method === rpc("asset.get")) result.path = state.assetPath ?? (intent.asset && paths.join(root, `${intent.asset.sha256}.bin`));
      }
    }
    await hooks.get(method)?.(p, result);
    return structuredClone(result);
  } };
  state.host = host;
  const quote = { version: "courseware-media-quote-v1", kind: "image", model: "image-model", priceVersion: "fixture-price-v1",
    maxPoints: 3, maxChars: 4000, expiresAt: "2099-01-01T00:00:00Z", quoteToken: "private-fixture-proof" };
  const media = {
    async getImageModels() {
      calls.push({ method: "GET models" });
      await hooks.get("GET models")?.();
      return [{ model: "image-model", supportsReferenceImage: state.supportsReference, privateField: "hidden" }];
    },
    async getImageQuote(model) {
      calls.push({ method: "GET quote", model }); await hooks.get("GET quote")?.(); return quote;
    },
    async submitConfirmedImage(key, request, confirmation, signal, projectId, check, admit) {
      await check?.(); if (admit) projectId = await admit();
      const scope = { sessionId: state.active, principalKey: state.account };
      const intent = records(scope).find(row => row.idempotencyKey === key);
      assert(intent, "POST belongs to the authenticated original Chat");
      assert.equal(projectId, intent.submissionScope.teamProjectId ?? undefined);
      assert.equal(intent.phase, "submission-unknown", "Host begin must commit before POST");
      assert.equal(requestHash(request), intent.requestHash, "POST uses the canonical pinned request");
      calls.push({ method: "POST confirmed", key, request: structuredClone(request), quote: structuredClone(confirmation) });
      if (state.refusal) throw new Error(state.refusal);
      const task = { version: "courseware-media-v1", kind: "image", taskId: `task-${tasks.size + 1}`, idempotencyKey: key,
        requestHash: requestHash(request), model: request.model, state: "queued", feeState: "reserved", reservedPoints: 3,
        actualPoints: null, receiptId: null, errorCode: null, assetRef: null };
      tasks.set(JSON.stringify([scope.principalKey, key]), task);
      await hooks.get("POST confirmed")?.();
      if (state.lostReceipt) throw new Error("fixture receipt lost");
      return { ...task, ...state.taskPatch };
    },
    async findImage(ref) {
      calls.push({ method: "GET by-key", reference: structuredClone(ref) });
      const task = tasks.get(JSON.stringify([state.account, ref.idempotencyKey]));
      await hooks.get("GET by-key")?.();
      return state.missing || !task ? null : { ...task, ...state.taskPatch };
    },
    async getImage(ref) {
      calls.push({ method: "GET by-id", reference: structuredClone(ref) });
      const task = tasks.get(JSON.stringify([state.account, ref.idempotencyKey]));
      await hooks.get("GET by-id")?.();
      assert(task); return { ...task, ...state.taskPatch };
    },
    async downloadImage(ref) {
      calls.push({ method: "GET asset", reference: structuredClone(ref) });
      const task = tasks.get(JSON.stringify([state.account, ref.idempotencyKey])); assert(task);
      const result = { task: structuredClone({ ...task, ...state.taskPatch }), bytes: Buffer.from(state.downloadBytes) };
      await hooks.get("GET asset")?.();
      return result;
    },
  };
  const auth = { coursewareMedia: media, getCoursewarePrincipal() {
    const captured = state.account;
    return { key: captured, assertCurrent() { if (state.account !== captured) throw new Error("account changed"); } };
  } };
  const create = () => new CoursewareCanvasImages(() => state.host, () => state.active, () => state.running, auth);
  const coordinator = create(), base = { sessionId: "chat-a" };
  const prepareInput = () => ({ ...base, draftId: draft.id, expectedRevision: "canvas-v2", expectedDraftRevision: 2,
    intentId: randomUUID(), model: "image-model" });
  const prepare = (extra = {}) => coordinator.prepare({ ...prepareInput(), ...extra });
  const operation = row => ({ ...base, intentId: row.intentId });
  const priced = async () => {
    const row = await prepare(), offer = await coordinator.quote(operation(row));
    return { row, offer, payload: { ...operation(row), quoteId: offer.quoteId } };
  };
  const events = method => calls.filter(call => call.method === method);
  const saved = (row, principalKey = principalA) => records({ ...base, principalKey }).find(intent => intent.intentId === row.intentId);
  const ready = () => {
    for (const task of tasks.values()) Object.assign(task, { state: "ready", feeState: "settled", actualPoints: 3,
      assetRef: { assetId: "fixture-image", sha256: asset.sha256, mime: asset.mimeType, byteLength: asset.byteLength,
        width: asset.width, height: asset.height, downloadPath: `/courseware/media/tasks/${task.taskId}/asset` } });
  };
  return { root, referencePath, asset, state, calls, hooks, host, quote, media, create, coordinator, base, prepareInput,
    prepare, operation, priced, events, saved, ready };
}

test("models, prepare, list and quote are nonpaid and expose no private journal or server proof", async t => {
  const f = await fixture(t), row = await f.prepare();
  assert.deepEqual(await f.coordinator.models(f.base), [{ model: "image-model", supportsReferenceImage: true }]);
  f.state.supportsReference = undefined;
  assert.deepEqual(await f.coordinator.models(f.base), [{ model: "image-model", supportsReferenceImage: false }]);
  assert.deepEqual((await f.coordinator.prepare({ ...f.prepareInput(), intentId: row.intentId })), row);
  assert.deepEqual(await f.coordinator.list(f.base), [row]);
  assert.deepEqual(await f.coordinator.status(f.operation(row)), row);
  const quote = await f.coordinator.quote(f.operation(row));
  assert.equal(quote.intentId, row.intentId); assert.equal(quote.maxPoints, 3); assert.equal(quote.model, "image-model");
  const publicResult = JSON.stringify({ row, quote });
  for (const privateValue of [f.root, principalA, f.saved(row).idempotencyKey, f.saved(row).requestHash, "private-fixture-proof", "quoteToken", "taskRef"])
    assert(!publicResult.includes(privateValue), privateValue);
  assert.equal(f.events("POST confirmed").length, 0); assert.equal(f.events(rpc("begin")).length, 0);
});

test("surplus and malformed arguments reject before any Host or media access", async t => {
  const f = await fixture(t);
  const operations = [
    ["models", f.base], ["list", f.base], ["prepare", f.prepareInput()],
    ["quote", { ...f.base, intentId: "attempt" }], ["status", { ...f.base, intentId: "attempt" }],
    ["archive", { ...f.base, intentId: "attempt" }], ["preview", { ...f.base, intentId: "attempt" }],
    ["restore", { ...f.base, intentId: "attempt" }],
    ["referencePreview", { ...f.base, intentId: "attempt" }],
    ["submitConfirmed", { ...f.base, intentId: "attempt", quoteId: "quote" }],
  ];
  for (const [method, valid] of operations) {
    for (const invalid of [null, [], {}, { ...valid, sessionId: ".." }, { ...valid, input: "forged prompt" },
      { ...valid, principalKey: principalB }, { ...valid, confirmed: true }])
      await assert.rejects(f.coordinator[method](invalid), /INVALID_REQUEST/, method);
  }
  for (const patch of [{ expectedDraftRevision: -1 }, { expectedDraftRevision: 1.5 }, { draftId: " " }, { expectedRevision: "" }])
    await assert.rejects(f.coordinator.prepare({ ...f.prepareInput(), ...patch }), /INVALID_REQUEST/);
  assert.equal(f.calls.length, 0);
});

test("only the current explicit quote may dispatch; absent, superseded and restarted offers reject", async t => {
  const f = await fixture(t), p = await f.priced();
  await assert.rejects(f.coordinator.submitConfirmed({ ...p.payload, quoteId: "unknown" }), /QUOTE_REQUIRED/);
  await assert.rejects(f.create().submitConfirmed(p.payload), /QUOTE_REQUIRED/);
  const latest = await f.coordinator.quote(f.operation(p.row));
  await assert.rejects(f.coordinator.submitConfirmed(p.payload), /QUOTE_REQUIRED/);
  f.quote.expiresAt = "2000-01-01T00:00:00Z";
  const expired = await f.coordinator.quote(f.operation(p.row));
  await assert.rejects(f.coordinator.submitConfirmed({ ...p.payload, quoteId: expired.quoteId }), /QUOTE_REQUIRED/);
  await assert.rejects(f.coordinator.submitConfirmed({ ...p.payload, quoteId: latest.quoteId }), /QUOTE_REQUIRED/);
  assert.equal(f.events(rpc("begin")).length, 0); assert.equal(f.events("POST confirmed").length, 0);
});

test("confirmed submit waits for durable begin acknowledgement and freezes the approved price", { timeout: 5000 }, async t => {
  const f = await fixture(t), p = await f.priced(), gate = pause(t);
  f.quote.maxPoints = 900;
  f.hooks.set(rpc("begin"), () => gate.wait());
  const pending = f.coordinator.submitConfirmed(p.payload);
  await gate.entered;
  assert.equal(f.saved(p.row).phase, "submission-unknown");
  assert.equal(f.events("WAL begin").length, 1); assert.equal(f.events("POST confirmed").length, 0);
  gate.release();
  const result = await pending;
  assert.equal(result.phase, "submitted"); assert.equal(result.task.reservedPoints, 3);
  assert.deepEqual(result.task, { state: "queued", feeState: "reserved", reservedPoints: 3, actualPoints: null, errorCode: null });
  const [post] = f.events("POST confirmed"), saved = f.saved(p.row);
  assert.equal(post.key, saved.idempotencyKey); assert.equal(post.quote.maxPoints, 3);
  assert.equal(requestHash(post.request), saved.requestHash); assert.equal(post.request.input, p.row.draft.prompt);
  assert(f.calls.findIndex(call => call.method === "WAL begin") < f.calls.findIndex(call => call.method === "POST confirmed"));
  assert(f.calls.findIndex(call => call.method === "POST confirmed") < f.calls.findIndex(call => call.method === rpc("bind")));
  assert.equal((await f.coordinator.submitConfirmed(p.payload)).phase, "submitted");
  assert.equal(f.events("POST confirmed").length, 1); assert.equal(f.events("GET by-id").length, 1);
});

test("an overlapping submit is refused without a second begin or POST", { timeout: 5000 }, async t => {
  const f = await fixture(t), p = await f.priced(), gate = pause(t);
  f.hooks.set("POST confirmed", () => gate.wait());
  const pending = f.coordinator.submitConfirmed(p.payload); await gate.entered;
  await assert.rejects(f.coordinator.submitConfirmed(p.payload), /IN_FLIGHT/);
  gate.release(); assert.equal((await pending).phase, "submitted");
  assert.equal(f.events(rpc("begin")).length, 1); assert.equal(f.events("POST confirmed").length, 1);
});

test("lost receipt survives restart and absence retains the original key through GET-only recovery", async t => {
  const f = await fixture(t), p = await f.priced(), pins = structuredClone(f.saved(p.row));
  f.state.lostReceipt = true;
  await assert.rejects(f.coordinator.submitConfirmed(p.payload), /fixture receipt lost/);
  const restarted = f.create(); f.state.missing = true; f.state.mode = "plan";
  assert.equal((await restarted.status(f.operation(p.row))).phase, "submission-unknown");
  f.state.mode = "agent";
  assert.equal((await restarted.submitConfirmed(p.payload)).phase, "submission-unknown");
  await assert.rejects(restarted.quote(f.operation(p.row)), /DRAFT_CHANGED/);
  f.state.missing = false; f.state.draft.revision++;
  const recovered = await restarted.status(f.operation(p.row));
  assert.equal(recovered.phase, "submitted"); assert.equal(recovered.current, false);
  assert.equal((await restarted.submitConfirmed(p.payload)).phase, "submitted");
  assert.equal(f.events("POST confirmed").length, 1); assert.equal(f.events(rpc("begin")).length, 1);
  assert.equal(f.events("GET by-key").length, 3);
  for (const call of f.events("GET by-key")) assert.deepEqual(call.reference, { idempotencyKey: pins.idempotencyKey, requestHash: pins.requestHash });
  assert.equal(f.saved(p.row).idempotencyKey, pins.idempotencyKey); assert.equal(f.saved(p.row).requestHash, pins.requestHash);
});

test("lost durable begin acknowledgement keeps unknown state without dispatch or replay", async t => {
  const f = await fixture(t), p = await f.priced();
  f.hooks.set(rpc("begin"), () => { throw new Error("fixture WAL acknowledgement lost"); });
  await assert.rejects(f.coordinator.submitConfirmed(p.payload), /WAL acknowledgement lost/);
  assert.equal(f.saved(p.row).phase, "submission-unknown");
  const restarted = f.create();
  assert.equal((await restarted.status(f.operation(p.row))).phase, "submission-unknown");
  assert.equal((await restarted.submitConfirmed(p.payload)).phase, "submission-unknown");
  assert.equal(f.events("POST confirmed").length, 0); assert.equal(f.events(rpc("begin")).length, 1);
});

test("foreign receipt pins never bind and a later canonical GET can recover", async t => {
  for (const field of ["kind", "model", "idempotencyKey", "requestHash"]) await t.test(field, async t => {
    const f = await fixture(t), p = await f.priced(); f.state.taskPatch = { [field]: "foreign" };
    await assert.rejects(f.coordinator.submitConfirmed(p.payload), /INVALID_TASK/);
    assert.equal(f.events(rpc("bind")).length, 0); assert.equal(f.saved(p.row).phase, "submission-unknown");
    await assert.rejects(f.create().status(f.operation(p.row)), /INVALID_TASK/);
    assert.equal(f.events(rpc("bind")).length, 0);
    f.state.taskPatch = {};
    assert.equal((await f.create().status(f.operation(p.row))).phase, "submitted");
    assert.equal(f.events("POST confirmed").length, 1);
  });
});

test("account partition, active Chat, running turn and Agent mode refuse unapproved paid work", async t => {
  const f = await fixture(t), p = await f.priced();
  f.state.account = principalB;
  assert.deepEqual(await f.coordinator.list(f.base), []);
  await assert.rejects(f.coordinator.submitConfirmed(p.payload), /NOT_FOUND/);
  f.state.account = principalA; f.state.active = "chat-b";
  await assert.rejects(f.coordinator.submitConfirmed(p.payload), /CONTEXT_CHANGED/);
  f.state.active = "chat-a"; f.state.running = true;
  await assert.rejects(f.coordinator.submitConfirmed(p.payload), /CONTEXT_CHANGED/);
  f.state.running = false; f.state.mode = "plan";
  for (const [method, params] of [["prepare", f.prepareInput()], ["quote", f.operation(p.row)], ["submitConfirmed", p.payload]])
    await assert.rejects(f.coordinator[method](params), /AGENT_REQUIRED/);
  assert.equal((await f.coordinator.status(f.operation(p.row))).phase, "prepared");
  assert.equal(f.events(rpc("begin")).length, 0); assert.equal(f.events("POST confirmed").length, 0);
});

const scopeChanges = {
  account: f => { f.state.account = principalB; },
  Chat: f => { f.state.active = "chat-b"; },
  Host: f => { f.state.host = { call() { throw new Error("replacement Host must not be called"); } }; },
  running: f => { f.state.running = true; },
};
test("account, Chat or Host changes across session and begin awaits prevent POST", { timeout: 15000 }, async t => {
  for (const boundary of ["session.get", rpc("begin")]) for (const [name, change] of Object.entries(scopeChanges))
    await t.test(`${boundary}: ${name}`, async t => {
      const f = await fixture(t), p = await f.priced(), gate = pause(t);
      f.hooks.set(boundary, () => gate.wait());
      const pending = f.coordinator.submitConfirmed(p.payload); await gate.entered;
      change(f); gate.release(); await assert.rejects(pending, /account changed|CONTEXT_CHANGED/);
      assert.equal(f.events("POST confirmed").length, 0);
      assert.equal(f.saved(p.row).phase, boundary === "session.get" ? "prepared" : "submission-unknown");
    });
});

test("stale drafts reject at initial read, during quote and at the Host begin CAS", async t => {
  for (const boundary of ["initial", "quote", "begin"]) await t.test(boundary, async t => {
    const f = await fixture(t), p = await f.priced();
    if (boundary === "initial") f.state.draft.revision++;
    if (boundary === "quote") f.hooks.set("GET quote", () => { f.state.draft.revision++; });
    if (boundary === "begin") f.hooks.set(rpc("get"), () => { f.state.draft.revision++; });
    await assert.rejects(boundary === "quote" ? f.coordinator.quote(f.operation(p.row)) : f.coordinator.submitConfirmed(p.payload), /DRAFT_CHANGED/);
    assert.equal(f.events("POST confirmed").length, 0); assert.equal(f.saved(p.row).phase, "prepared");
  });
});

test("scope changes while quoting expose no usable confirmation", { timeout: 10000 }, async t => {
  for (const [name, change] of Object.entries(scopeChanges)) await t.test(name, async t => {
    const f = await fixture(t), row = await f.prepare(), gate = pause(t);
    f.hooks.set("GET quote", () => gate.wait());
    const pending = f.coordinator.quote(f.operation(row)); await gate.entered;
    change(f); gate.release(); await assert.rejects(pending, /account changed|CONTEXT_CHANGED/);
    assert.equal(f.events("POST confirmed").length, 0); assert.equal(f.events(rpc("begin")).length, 0);
  });
});

test("valid late receipts bind on the original Host/account/Chat before stale UI rejection", { timeout: 10000 }, async t => {
  for (const [name, change] of Object.entries(scopeChanges)) await t.test(name, async t => {
    const f = await fixture(t), p = await f.priced(), gate = pause(t);
    f.hooks.set("POST confirmed", () => gate.wait());
    const pending = f.coordinator.submitConfirmed(p.payload); await gate.entered;
    change(f); f.state.draft.revision++; gate.release();
    await assert.rejects(pending, /account changed|CONTEXT_CHANGED/);
    assert.equal(f.saved(p.row).phase, "submitted");
    assert.deepEqual(f.events(rpc("bind"))[0].params, { ...f.operation(p.row), principalKey: principalA, taskRef: f.saved(p.row).taskRef });
    assert.equal(f.saved(p.row, principalB), undefined); assert.equal(f.events("POST confirmed").length, 1);
    f.state.account = principalA; f.state.active = "chat-a"; f.state.running = false; f.state.host = f.host;
    const recovered = await f.create().status(f.operation(p.row));
    assert.equal(recovered.phase, "submitted"); assert.equal(recovered.current, false);
  });
});

test("a valid late GET receipt also binds its original scope before account rejection", { timeout: 5000 }, async t => {
  const f = await fixture(t), p = await f.priced(); f.state.lostReceipt = true;
  await assert.rejects(f.coordinator.submitConfirmed(p.payload), /receipt lost/);
  const gate = pause(t); f.hooks.set("GET by-key", () => gate.wait());
  const pending = f.create().status(f.operation(p.row)); await gate.entered;
  f.state.account = principalB; gate.release(); await assert.rejects(pending, /account changed/);
  assert.equal(f.saved(p.row).phase, "submitted"); assert.equal(f.events(rpc("bind"))[0].params.principalKey, principalA);
  assert.equal(f.events("POST confirmed").length, 1);
});

test("prepare copies all caller parameters before awaiting Host", { timeout: 5000 }, async t => {
  const f = await fixture(t), params = f.prepareInput(), original = structuredClone(params), gate = pause(t);
  f.hooks.set("session.get", () => gate.wait());
  const pending = f.coordinator.prepare(params); await gate.entered;
  Object.assign(params, { sessionId: "chat-b", intentId: "other", model: "other-model", draftId: "other-draft",
    expectedRevision: "other-revision", expectedDraftRevision: 999 });
  gate.release(); const row = await pending;
  assert.equal(row.intentId, original.intentId); assert.equal(row.model, original.model);
  assert.deepEqual(f.events(rpc("prepare"))[0].params, { ...original, principalKey: principalA });
});

for (const method of ["quote", "status", "submitConfirmed"])
  test(`${method} retains original caller parameters across await`, { timeout: 5000 }, async t => {
    const f = await fixture(t), p = await f.priced(), gate = pause(t);
    const params = method === "submitConfirmed" ? { ...p.payload } : f.operation(p.row);
    f.hooks.set("session.get", () => gate.wait());
    const pending = f.coordinator[method](params); await gate.entered;
    Object.assign(params, { sessionId: "chat-b", intentId: "other-attempt" });
    if (method === "submitConfirmed") params.quoteId = "other-quote";
    gate.release(); const result = await pending;
    assert.equal(result.intentId, p.row.intentId);
    assert.equal(f.events(rpc("get")).at(-1).params.sessionId, "chat-a");
    assert.equal(f.events("POST confirmed").length, method === "submitConfirmed" ? 1 : 0);
  });

test("a confirmed quote identity cannot be changed by caller mutation during session lookup", { timeout: 5000 }, async t => {
  const f = await fixture(t), p = await f.priced(), gate = pause(t), params = { ...p.payload };
  f.hooks.set("session.get", () => gate.wait());
  const pending = f.coordinator.submitConfirmed(params); await gate.entered;
  params.quoteId = "other-quote"; gate.release();
  assert.equal((await pending).phase, "submitted");
  assert.equal(f.events("POST confirmed").length, 1);
});

test("mutating an initially unknown quote ID cannot authorize a dispatch after await", { timeout: 5000 }, async t => {
  const f = await fixture(t), p = await f.priced(), gate = pause(t), params = { ...p.payload, quoteId: "unknown-quote" };
  f.hooks.set("session.get", () => gate.wait());
  const pending = f.coordinator.submitConfirmed(params); await gate.entered;
  params.quoteId = p.payload.quoteId; gate.release();
  const result = await pending.then(view => ({ view }), error => ({ error }));
  assert.equal(f.events("POST confirmed").length, 0, "The original unknown quote must never authorize POST");
  assert.match(result.error?.message ?? "", /QUOTE_REQUIRED/);
  assert.equal(f.events(rpc("begin")).length, 0);
});

test("canonical request hashes include Unicode and reference metadata; fake digests reject", async t => {
  for (const reference of [false, true]) await t.test(reference ? "with reference" : "text only", async t => {
    const f = await fixture(t, { reference }), row = await f.prepare(), saved = f.saved(row);
    assert.equal(saved.requestHash, requestHash(saved.request));
    saved.requestHash = digest("fake-but-hex");
    await assert.rejects(f.coordinator.list(f.base), /INVALID_JOURNAL/);
    await assert.rejects(f.coordinator.quote(f.operation(row)), /INVALID_JOURNAL/);
    assert.equal(f.events("GET quote").length, 0); assert.equal(f.events("POST confirmed").length, 0);
  });
});

test("reference capability is explicitly required at quote and rechecked before begin", async t => {
  const f = await fixture(t, { reference: true }), row = await f.prepare();
  for (const capability of [false, undefined]) {
    f.state.supportsReference = capability;
    await assert.rejects(f.coordinator.quote(f.operation(row)), /REFERENCE_UNSUPPORTED/);
  }
  assert.equal(f.events("GET quote").length, 0);
  f.state.supportsReference = true;
  const quote = await f.coordinator.quote(f.operation(row)); f.state.supportsReference = false;
  await assert.rejects(f.coordinator.submitConfirmed({ ...f.operation(row), quoteId: quote.quoteId }), /REFERENCE_UNSUPPORTED/);
  assert.equal(f.saved(row).phase, "prepared"); assert.equal(f.events(rpc("begin")).length, 0);
  assert.equal(f.events("POST confirmed").length, 0);
});

test("reference metadata stays private until confirmation and only verified original bytes reach the fixture provider", async t => {
  const f = await fixture(t, { reference: true }), p = await f.priced();
  assert.equal(f.events("POST confirmed").length, 0);
  assert(!JSON.stringify(p).includes("bytesBase64")); assert(!JSON.stringify(p).includes(f.root));
  const result = await f.coordinator.submitConfirmed(p.payload), [post] = f.events("POST confirmed");
  assert.equal(result.phase, "submitted");
  assert.deepEqual(post.request.referenceImage, { sha256: f.asset.sha256, mimeType: "image/png", byteLength: png.length, bytesBase64: png.toString("base64") });
  for (const privateValue of [f.root, "scene-image-original", "Reviewed circle", p.row.intentId, principalA])
    assert(!JSON.stringify(post.request).includes(privateValue), privateValue);
  assert.equal(requestHash(post.request), f.saved(p.row).requestHash);
});

test("changed reference identity or metadata refuses submission before durable begin", async t => {
  for (const field of ["reference", "asset"]) await t.test(field, async t => {
    const f = await fixture(t, { reference: true }), p = await f.priced();
    f.state.reference[field].sha256 = "f".repeat(64);
    await assert.rejects(f.coordinator.submitConfirmed(p.payload), /REFERENCE_CHANGED/);
    assert.equal(f.saved(p.row).phase, "prepared"); assert.equal(f.events(rpc("begin")).length, 0);
    assert.equal(f.events("POST confirmed").length, 0);
  });
});

test("corrupt bytes, forged dimensions and non-content-addressed paths cannot reach begin or POST", async t => {
  for (const mode of ["corrupt bytes", "wrong dimensions", "wrong path", "wrong length"]) await t.test(mode, async t => {
    const f = await fixture(t, { reference: true }), p = await f.priced();
    if (mode === "corrupt bytes") await files.writeFile(f.referencePath, Buffer.alloc(png.length));
    if (mode === "wrong dimensions") f.state.reference.asset.width = 3;
    if (mode === "wrong path") f.state.reference.path = paths.join(f.root, "untrusted.bin");
    if (mode === "wrong length") await files.writeFile(f.referencePath, png.subarray(1));
    await assert.rejects(f.coordinator.submitConfirmed(p.payload), /INVALID_ASSET|SCENE_INVALID_INPUT/);
    assert.equal(f.saved(p.row).phase, "prepared"); assert.equal(f.events(rpc("begin")).length, 0);
    assert.equal(f.events("POST confirmed").length, 0);
  });
});

test("archive accepts only a submitted ready/settled receipt without another supplier POST", async t => {
  const f = await fixture(t), p = await f.priced();
  await assert.rejects(f.coordinator.archive(f.operation(p.row)), /TASK_REQUIRED/);
  await assert.rejects(f.coordinator.preview(f.operation(p.row)), /ASSET_REQUIRED/);
  assert.equal(f.events("GET asset").length, 0);
  await f.coordinator.submitConfirmed(p.payload);
  await assert.rejects(f.coordinator.archive(f.operation(p.row)), /INVALID_TASK/);
  f.ready();
  const preview = await f.coordinator.archive(f.operation(p.row));
  assert.equal(preview.image.phase, "submitted"); assert.equal(preview.image.current, true);
  assert.deepEqual(preview.image.asset, f.asset);
  assert.equal(preview.dataUrl, `data:image/png;base64,${png.toString("base64")}`);
  const [stage] = f.events(rpc("asset.stage"));
  assert.deepEqual(stage.params, { ...f.operation(p.row), principalKey: principalA,
    asset: { ...f.asset, taskRef: f.saved(p.row).taskRef }, bytesBase64: png.toString("base64") });
  for (const privateValue of [f.root, principalA, f.saved(p.row).taskRef.taskId, f.saved(p.row).idempotencyKey,
    f.saved(p.row).requestHash, "taskRef", "downloadPath", "bytesBase64"])
    assert(!JSON.stringify(preview).includes(privateValue), privateValue);
  assert.equal(f.events("POST confirmed").length, 1);
});

test("archived previews reopen locally after coordinator restart and keep old drafts without a download", async t => {
  const f = await fixture(t), p = await f.priced();
  await f.coordinator.submitConfirmed(p.payload); f.ready();
  const preview = await f.coordinator.archive(f.operation(p.row)), reads = f.events("GET asset").length;
  const restarted = f.create();
  assert.deepEqual(await restarted.preview(f.operation(p.row)), preview);
  assert.deepEqual(await restarted.archive(f.operation(p.row)), preview);
  f.state.draft = null; f.state.mode = "plan";
  const historical = await restarted.preview(f.operation(p.row));
  assert.equal(historical.image.current, false); assert.deepEqual(historical.image.draft, p.row.draft);
  assert.deepEqual(await restarted.archive(f.operation(p.row)), historical);
  assert.deepEqual((await restarted.list(f.base))[0].asset, f.asset);
  assert.equal(f.events("GET asset").length, reads); assert.equal(f.events(rpc("asset.stage")).length, 1);
  assert.equal(f.events("POST confirmed").length, 1);
});

test("explicit restore retrieves missing or corrupt original bytes without another quote or generation", async t => {
  for (const damage of ["missing", "corrupt"]) await t.test(damage, async t => {
    const f = await fixture(t), p = await f.priced();
    await f.coordinator.submitConfirmed(p.payload); f.ready();
    const original = await f.coordinator.archive(f.operation(p.row)), saved = structuredClone(f.saved(p.row));
    if (damage === "missing") await files.rm(f.referencePath);
    else await files.writeFile(f.referencePath, Buffer.alloc(png.length));
    await assert.rejects(f.coordinator.preview(f.operation(p.row)));
    assert.equal(f.events("GET asset").length, 1, "Preview cannot silently fetch a remote result");
    f.state.draft = null; f.state.mode = "plan";
    const restored = await f.coordinator.restore(f.operation(p.row));
    assert.equal(restored.image.current, false); assert.equal(restored.dataUrl, original.dataUrl);
    assert.deepEqual(f.saved(p.row), saved); assert.deepEqual(await files.readFile(f.referencePath), png);
    assert.deepEqual(await f.create().preview(f.operation(p.row)), restored);
    assert.equal(f.events("GET asset").length, 2); assert.equal(f.events(rpc("asset.restore")).length, 1);
    assert.equal(f.events("POST confirmed").length, 1); assert.equal(f.events("GET quote").length, 1);
  });
});

test("restore requires an archived receipt and rejects changed remote originals or access refusal without writes", async t => {
  const f = await fixture(t), p = await f.priced();
  await assert.rejects(f.coordinator.restore(f.operation(p.row)), /TASK_REQUIRED|ASSET_REQUIRED/);
  await f.coordinator.submitConfirmed(p.payload); f.ready();
  await assert.rejects(f.coordinator.restore(f.operation(p.row)), /ASSET_REQUIRED/);
  assert.equal(f.events("GET asset").length, 0);
  await f.coordinator.archive(f.operation(p.row));
  const saved = structuredClone(f.saved(p.row));
  await files.rm(f.referencePath);
  const download = f.media.downloadImage;
  const replacement = await sharp({ create: { width: 2, height: 2, channels: 4, background: "blue" } }).png().toBuffer();
  f.media.downloadImage = async ref => {
    const result = await download(ref); result.bytes = replacement;
    Object.assign(result.task.assetRef, { sha256: digest(replacement), byteLength: replacement.length });
    return result;
  };
  await assert.rejects(f.coordinator.restore(f.operation(p.row)), /INVALID_TASK/);
  f.media.downloadImage = async () => { throw new Error("access revoked"); };
  await assert.rejects(f.coordinator.restore(f.operation(p.row)), /access revoked/);
  assert.deepEqual(f.saved(p.row), saved); assert.equal(f.events(rpc("asset.restore")).length, 0);
  assert.equal(f.events("POST confirmed").length, 1);
  await assert.rejects(files.stat(f.referencePath), { code: "ENOENT" });
});

test("restore serializes retrieval and rejects account, Chat, Host or running changes before writing", async t => {
  for (const [name, change] of Object.entries(scopeChanges)) await t.test(name, async t => {
    const f = await fixture(t), p = await f.priced(), gate = pause(t);
    await f.coordinator.submitConfirmed(p.payload); f.ready(); await f.coordinator.archive(f.operation(p.row));
    await files.rm(f.referencePath);
    f.hooks.set("GET asset", () => gate.wait());
    const pending = f.coordinator.restore(f.operation(p.row)); await gate.entered;
    await assert.rejects(f.coordinator.restore(f.operation(p.row)), /IN_FLIGHT/);
    change(f); gate.release(); await assert.rejects(pending, /account changed|CONTEXT_CHANGED/);
    assert.equal(f.events(rpc("asset.restore")).length, 0); assert.equal(f.events("POST confirmed").length, 1);
    await assert.rejects(files.stat(f.referencePath), { code: "ENOENT" });
  });
});

test("foreign task receipt fields and unsettled results cannot be archived", async t => {
  const patches = { taskId: "foreign-task", idempotencyKey: randomUUID(), requestHash: "b".repeat(64), model: "foreign-model",
    kind: "tts", state: "queued", feeState: "reserved", assetRef: null };
  for (const [field, value] of Object.entries(patches)) await t.test(field, async t => {
    const f = await fixture(t), p = await f.priced();
    await f.coordinator.submitConfirmed(p.payload); f.ready(); f.state.taskPatch = { [field]: value };
    await assert.rejects(f.coordinator.archive(f.operation(p.row)), /INVALID_TASK/);
    assert.equal(f.saved(p.row).asset, undefined); assert.equal(f.events(rpc("asset.stage")).length, 0);
    assert.equal(f.events("POST confirmed").length, 1);
  });
});

test("downloaded image bytes, MIME and dimensions verify before any Host archive write", async t => {
  for (const mode of ["corrupt", "truncated", "width", "mime", "digest", "byteLength"]) await t.test(mode, async t => {
    const f = await fixture(t), p = await f.priced();
    await f.coordinator.submitConfirmed(p.payload); f.ready();
    const download = f.media.downloadImage;
    f.media.downloadImage = async ref => {
      const result = await download(ref), asset = result.task.assetRef;
      if (mode === "corrupt") result.bytes = Buffer.alloc(png.length);
      if (mode === "truncated") result.bytes = png.subarray(1);
      if (mode === "width") asset.width++;
      if (mode === "mime") asset.mime = "image/jpeg";
      if (mode === "digest") asset.sha256 = "c".repeat(64);
      if (mode === "byteLength") asset.byteLength++;
      return result;
    };
    await assert.rejects(f.coordinator.archive(f.operation(p.row)), /INVALID_ASSET|SCENE_INVALID_INPUT/);
    assert.equal(f.events(rpc("asset.stage")).length, 0); assert.equal(f.saved(p.row).asset, undefined);
    assert.equal(f.events("POST confirmed").length, 1);
  });
});

test("corrupt archive bytes or forged archive paths fail locally without redownloading", async t => {
  for (const mode of ["bytes", "path", "dimensions", "taskRef", "no task"]) await t.test(mode, async t => {
    const f = await fixture(t), p = await f.priced();
    await f.coordinator.submitConfirmed(p.payload); f.ready(); await f.coordinator.archive(f.operation(p.row));
    if (mode === "bytes") await files.writeFile(f.referencePath, Buffer.alloc(png.length));
    if (mode === "path") f.state.assetPath = paths.join(f.root, "foreign.bin");
    if (mode === "dimensions") f.saved(p.row).asset.width++;
    if (mode === "taskRef") f.saved(p.row).asset.taskRef.taskId = "foreign-task";
    if (mode === "no task") { f.saved(p.row).taskRef = null; f.saved(p.row).phase = "prepared"; }
    const restarted = f.create();
    await assert.rejects(restarted.preview(f.operation(p.row)), /INVALID_ASSET|INVALID_JOURNAL|SCENE_INVALID_INPUT/);
    await assert.rejects(restarted.archive(f.operation(p.row)), /INVALID_ASSET|INVALID_JOURNAL|SCENE_INVALID_INPUT/);
    assert.equal(f.events("GET asset").length, 1); assert.equal(f.events(rpc("asset.stage")).length, 1);
    assert.equal(f.events("POST confirmed").length, 1);
  });
});

test("scope changes during download refuse stale data and perform no archive write", { timeout: 10000 }, async t => {
  for (const [name, change] of Object.entries(scopeChanges)) await t.test(name, async t => {
    const f = await fixture(t), p = await f.priced(), gate = pause(t);
    await f.coordinator.submitConfirmed(p.payload); f.ready();
    f.hooks.set("GET asset", () => gate.wait());
    const pending = f.coordinator.archive(f.operation(p.row)); await gate.entered;
    change(f); gate.release(); await assert.rejects(pending, /account changed|CONTEXT_CHANGED/);
    assert.equal(f.events(rpc("asset.stage")).length, 0); assert.equal(f.saved(p.row).asset, undefined);
    assert.equal(f.events("POST confirmed").length, 1);
    f.state.account = principalA; f.state.active = "chat-a"; f.state.running = false; f.state.host = f.host;
    assert.deepEqual((await f.coordinator.archive(f.operation(p.row))).image.asset, f.asset, "archive lock releases after failure");
  });
});

test("stale draft after submission still archives only the original pinned candidate", { timeout: 5000 }, async t => {
  const f = await fixture(t), p = await f.priced(), gate = pause(t);
  await f.coordinator.submitConfirmed(p.payload); f.ready();
  f.hooks.set("GET asset", () => gate.wait());
  const pending = f.coordinator.archive(f.operation(p.row)); await gate.entered;
  f.state.draft = { ...f.state.draft, revision: 3, prompt: "A different picture" }; gate.release();
  const preview = await pending;
  assert.equal(preview.image.current, false); assert.deepEqual(preview.image.draft, p.row.draft);
  assert.equal(f.events("POST confirmed").length, 1);
});

test("one archive per account/Chat partition runs at a time, even across different intents", { timeout: 5000 }, async t => {
  const f = await fixture(t), first = await f.priced(), second = await f.priced(), gate = pause(t);
  await f.coordinator.submitConfirmed(first.payload); await f.coordinator.submitConfirmed(second.payload); f.ready();
  f.hooks.set("GET asset", () => gate.wait());
  const pending = f.coordinator.archive(f.operation(first.row)); await gate.entered;
  await assert.rejects(f.coordinator.archive(f.operation(first.row)), /IN_FLIGHT/);
  await assert.rejects(f.coordinator.archive(f.operation(second.row)), /IN_FLIGHT/);
  gate.release(); assert((await pending).image.asset);
  assert((await f.coordinator.archive(f.operation(second.row))).image.asset);
  assert.equal(f.events("POST confirmed").length, 2); assert.equal(f.events("GET asset").length, 2);
});

test("a lost archive acknowledgement reopens the committed private asset without another download", async t => {
  const f = await fixture(t), p = await f.priced();
  await f.coordinator.submitConfirmed(p.payload); f.ready();
  f.hooks.set(rpc("asset.stage"), () => { throw new Error("fixture archive acknowledgement lost"); });
  await assert.rejects(f.coordinator.archive(f.operation(p.row)), /archive acknowledgement lost/);
  assert.deepEqual((await f.create().archive(f.operation(p.row))).image.asset, f.asset);
  assert.equal(f.events("GET asset").length, 1); assert.equal(f.events(rpc("asset.stage")).length, 1);
  assert.equal(f.events("POST confirmed").length, 1);
});

test("private reference preview verifies original identity and bytes without any model or provider call", async t => {
  const f = await fixture(t, { reference: true }), row = await f.prepare();
  f.state.supportsReference = false; f.state.mode = "plan"; f.state.draft = null;
  const preview = await f.coordinator.referencePreview(f.operation(row));
  assert.deepEqual(preview, { intentId: row.intentId, reference: row.draft.references[0], dataUrl: `data:image/png;base64,${png.toString("base64")}` });
  assert.deepEqual(await f.create().referencePreview(f.operation(row)), preview);
  assert(!JSON.stringify(preview).includes(f.root)); assert(!JSON.stringify(preview).includes(principalA));
  assert(!f.calls.some(call => /^(GET|POST)/.test(call.method)));
  const plain = await fixture(t), plainRow = await plain.prepare();
  await assert.rejects(plain.coordinator.referencePreview(plain.operation(plainRow)), /REFERENCE_REQUIRED/);
});

test("private reference preview refuses changed identity, corrupt bytes, dimensions and paths", async t => {
  for (const mode of ["reference", "asset", "bytes", "dimensions", "path"]) await t.test(mode, async t => {
    const f = await fixture(t, { reference: true }), row = await f.prepare();
    if (mode === "reference") f.state.reference.reference.sha256 = "f".repeat(64);
    if (mode === "asset") f.state.reference.asset.byteLength++;
    if (mode === "bytes") await files.writeFile(f.referencePath, Buffer.alloc(png.length));
    if (mode === "dimensions") f.state.reference.asset.width++;
    if (mode === "path") f.state.reference.path = paths.join(f.root, "foreign.bin");
    await assert.rejects(f.coordinator.referencePreview(f.operation(row)), /REFERENCE_CHANGED|INVALID_ASSET|SCENE_INVALID_INPUT/);
    assert(!f.calls.some(call => /^(GET|POST)/.test(call.method)));
  });
});

test("preview and reference preview reject stale account/Chat/Host data after private Host reads", { timeout: 15000 }, async t => {
  for (const method of ["preview", "referencePreview"]) for (const [name, change] of Object.entries(scopeChanges))
    await t.test(`${method}: ${name}`, async t => {
      const f = await fixture(t, { reference: true }), p = await f.priced(), gate = pause(t);
      if (method === "preview") { await f.coordinator.submitConfirmed(p.payload); f.ready(); await f.coordinator.archive(f.operation(p.row)); }
      f.hooks.set(method === "preview" ? rpc("asset.get") : rpc("reference"), () => gate.wait());
      const pending = f.coordinator[method](f.operation(p.row)); await gate.entered;
      change(f); gate.release(); await assert.rejects(pending, /account changed|CONTEXT_CHANGED/);
    });
});

for (const method of ["archive", "restore", "preview", "referencePreview"])
  test(`${method} freezes caller arguments before session lookup`, { timeout: 5000 }, async t => {
    const f = await fixture(t, { reference: true }), p = await f.priced(), gate = pause(t);
    if (method !== "referencePreview") {
      await f.coordinator.submitConfirmed(p.payload); f.ready();
      if (method === "preview" || method === "restore") await f.coordinator.archive(f.operation(p.row));
    }
    const params = f.operation(p.row); f.hooks.set("session.get", () => gate.wait());
    const pending = f.coordinator[method](params); await gate.entered;
    Object.assign(params, { sessionId: "chat-b", intentId: "foreign-intent" }); gate.release();
    const result = await pending;
    assert.equal(method === "referencePreview" ? result.intentId : result.image.intentId, p.row.intentId);
    for (const call of f.calls.filter(call => call.method.startsWith("courseware.") && call.method !== "courseware.task.get")) {
      assert.equal(call.params.sessionId, "chat-a"); assert.equal(call.params.principalKey, principalA);
    }
  });

test("canvas submission uses the Host team scope", async t => {
  const f = await fixture(t); f.state.teamProjectId = "12345678-1234-1234-1234-123456789abc";
  const prepared = await f.coordinator.prepare(f.prepareInput());
  const quote = await f.coordinator.quote({ ...f.base, intentId: prepared.intentId });
  await f.coordinator.submitConfirmed({ ...f.base, intentId: prepared.intentId, quoteId: quote.quoteId });
  assert.equal(f.calls.filter(call => call.method === "POST confirmed").length, 1);
});

test("canvas first binding after durable begin cannot retarget a personal request", async t => {
  const f = await fixture(t), priced = await f.priced();
  f.hooks.set(rpc("begin"), async () => { f.state.teamProjectId = "12345678-1234-1234-1234-123456789abc"; });
  await f.coordinator.submitConfirmed(priced.payload);
  assert.equal(f.calls.filter(call => call.method === "POST confirmed").length, 1);
});

test("canvas missing or foreign begin scope prevents POST", async t => {
  for (const value of [undefined, { sessionId: "foreign", teamProjectId: null }]) {
    const f = await fixture(t), priced = await f.priced();
    f.hooks.set(rpc("begin"), async (_p, result) => { result.intent.submissionScope = value; });
    await assert.rejects(f.coordinator.submitConfirmed(priced.payload), /INVALID_SUBMISSION_SCOPE/);
    assert.equal(f.calls.filter(call => call.method === "POST confirmed").length, 0);
  }
});

for (const code of [46100, 46102]) test(`definite team canvas refusal ${code} ends the attempt without recovery or replay`, async t => {
  const f = await fixture(t); f.state.teamProjectId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const first = await f.priced(); f.state.refusal = `COURSEWARE_MEDIA_PLATFORM_${code}`;
  const rejected = await f.coordinator.submitConfirmed(first.payload);
  assert.equal(rejected.phase, "rejected"); assert.equal(rejected.task, null);
  assert.equal(f.saved(first.row).taskRef, null);
  const restarted = f.create();
  assert.equal((await restarted.status(f.operation(first.row))).phase, "rejected");
  assert.equal((await restarted.submitConfirmed(first.payload)).phase, "rejected");
  assert.equal(f.events("GET by-key").length, 0); assert.equal(f.events("POST confirmed").length, 1);
  f.state.refusal = undefined;
  const next = await f.priced();
  assert.notEqual(f.saved(next.row).idempotencyKey, f.saved(first.row).idempotencyKey);
  assert.notEqual(next.offer.quoteId, first.offer.quoteId);
  assert.equal(f.events("POST confirmed").length, 1, "fresh prepare and quote cannot submit");
  assert.equal((await f.coordinator.submitConfirmed(next.payload)).phase, "submitted");
  assert.equal(f.events("POST confirmed").length, 2);
});

test("generic 403 and personal refusals retain uncertain canvas attempts", async t => {
  for (const [team, code] of [[true, 403], [false, 46102]]) {
    const f = await fixture(t); if (team) f.state.teamProjectId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const first = await f.priced(); f.state.refusal = `COURSEWARE_MEDIA_PLATFORM_${code}`;
    await assert.rejects(f.coordinator.submitConfirmed(first.payload), new RegExp(String(code)));
    assert.equal(f.saved(first.row).phase, "submission-unknown");
    assert.equal((await f.create().status(f.operation(first.row))).phase, "submission-unknown");
    assert.equal(f.events("GET by-key").length, 1); assert.equal(f.events("POST confirmed").length, 1);
    assert.equal(f.events(rpc("reject")).length, 0);
  }
});
