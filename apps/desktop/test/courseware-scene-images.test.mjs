import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire, register } from "node:module";
import * as fsConstants from "node:fs";
import * as files from "node:fs/promises";
import * as paths from "node:path";
import { crc32 } from "node:zlib";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import ts from "typescript";

register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const shared = await import("@pi-desktop/shared");
const draftReader = await import("../electron/main/courseware-scene-draft.ts");
const sharp = createRequire(new URL("../../../packages/courseware-runtime/package.json", import.meta.url))("sharp");
const png = await sharp({ create: { width: 2, height: 2, channels: 4, background: "red" } }).png().toBuffer();
async function load(name, dependencies) {
  const exports = {};
  new Function("require", "exports", ts.transpileModule(await readFile(new URL(`../electron/main/${name}.ts`, import.meta.url), "utf8"), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText)(id => { if (!Object.hasOwn(dependencies, id)) throw new Error(id); return dependencies[id]; }, exports);
  return exports;
}
// Native codec is an external edge here; actual Electron decoding is covered by the UI gate.
let nativePixels = Buffer.alloc(16);
const electron = { nativeImage: { createFromBuffer: () => ({ isEmpty: () => false,
  getSize: () => ({ width: 2, height: 2 }), toPNG: () => png, toBitmap: () => Buffer.from(nativePixels) }) } };
const context = await load("courseware-scene-context", { electron, "node:crypto": { createHash }, "node:zlib": { crc32 } });
const assetHelpers = await load("courseware-scene-image-assets", { electron, "node:crypto": { createHash },
  "node:fs": fsConstants, "node:fs/promises": files, "node:path": paths, "./courseware-scene-context": context,
  "./public-https-fetch": await import("../electron/main/public-https-fetch.ts") });
const mediaScope = await load("courseware-media-scope", {});
const retryHelpers = await import("../electron/main/courseware-retry.ts");
const module = { exports: {} };
new Function("require", "exports", ts.transpileModule(await readFile(new URL("../electron/main/courseware-scene-images.ts", import.meta.url), "utf8"), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText)((id) => {
  if (id === "./courseware-media-scope") return mediaScope;
  if (id === "./courseware-retry") return retryHelpers;
  if (id === "node:crypto") return { randomUUID };
  if (id === "@pi-desktop/shared") return shared;
  if (id === "./courseware-scene-draft") return draftReader;
  if (id === "./courseware-scene-image-assets") return assetHelpers;
  throw new Error(id);
}, module.exports);
const { CoursewareSceneImages } = module.exports;
const generation = await load("courseware-scene-generation", { "./courseware-scene-image-assets": assetHelpers });
const { sceneCoursePlanRelativePath } = await import("../electron/main/courseware-scene-plan.ts");
const plan = { title: "Shapes", pages: [{ title: "Circle", visibleText: ["圆"], visualIntent: "Bright circle", narration: "Good!" }] };
const digest = (v) => createHash("sha256").update(v).digest("hex");
const pause = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };

async function fixture(t, coursePlan = plan) {
  const root = await mkdtemp(join(tmpdir(), "deckwise-scene-images-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, sceneCoursePlanRelativePath("chat-a"));
  await mkdir(dirname(path), { recursive: true }); await writeFile(path, JSON.stringify(coursePlan));
  const sha256 = digest(await readFile(path));
  let account = "a".repeat(64), active = "chat-a", running = false, approval = sha256;
  let lostReceipt = false, missing = false, wrongTask = false, submitGate, quoteGate, downloadGate, downloadBytes = png;
  let supportsReferenceImage, teamProjectId, afterBegin, refusal;
  let model = { providerId: "provider", modelId: "model" };
  const journals = new Map(), tasks = new Map(), calls = [];
  const partition = p => JSON.stringify([p.sessionId, p.principalKey]);
  const records = p => journals.get(partition(p)) ?? [];
  const current = async j => ({ current: approval === j.planSha256 && digest(await readFile(path)) === j.planSha256, intent: structuredClone(j) });
  const host = { async call(method, p) {
    calls.push(method);
    if (method === "session.get") return { session: { projectPath: root, ...model, mode: "agent" } };
    if (method === "courseware.task.get") return { task: { taskType: "scene", teamProjectId } };
    if (method === "courseware.scenePlan.get") return { approval: { sha256: approval } };
    if (method === "courseware.sceneImage.list") return { intents: await Promise.all(records(p).map(current)) };
    if (method === "courseware.sceneImage.prepare") {
      const target = p.target ?? { kind: "visualMaster" }, input = `Bright circle${p.instructions ? `\n${p.instructions}` : ""}`;
      const reference = p.referenceIntentId === undefined ? null : records(p).find(row => row.intentId === p.referenceIntentId &&
        row.selected && row.asset && row.planSha256 === p.planSha256 && row.pageId === (target.kind === "visualMaster" ? "scene-001" : p.pageId) && row.target.kind === "visualMaster");
      if (p.referenceIntentId !== undefined && !reference) throw new Error("REFERENCE_CHANGED");
      let j = records(p).findLast(j => j.phase !== "rejected" && j.pageId === p.pageId && j.planSha256 === p.planSha256 && j.request.model === p.model &&
        JSON.stringify(j.target) === JSON.stringify(target) && j.request.input === input && j.referenceIntentId === p.referenceIntentId);
      if (!j) {
        j = { intentId: randomUUID(), planSha256: p.planSha256, pageId: p.pageId, target, request: { kind: p.decomposition ? "image-layers" : "image", model: p.model, input },
          phase: "prepared", taskRef: null, asset: null, selected: false, idempotencyKey: randomUUID(), requestHash: digest("pinned") };
        if (reference) {
          j.referenceIntentId = reference.intentId;
          j.request.referenceImage = { sha256: reference.asset.sha256, mimeType: reference.asset.mimeType, byteLength: reference.asset.byteLength };
        }
        journals.set(partition(p), [...records(p), j]);
      }
      return current(j);
    }
    const j = records(p).find(j => j.intentId === p.intentId);
    assert(j, "scoped journal exists");
    if (method === "courseware.sceneImage.retry") {
      const retryId = retryHelpers.coursewareRetryIntentId(j.intentId);
      let retry = records(p).find(row => row.intentId === retryId);
      if (!retry) {
        retry = { ...structuredClone(j), intentId: retryId, idempotencyKey: randomUUID(), phase: "prepared", taskRef: null };
        delete retry.submissionScope;
        journals.set(partition(p), [...records(p), retry]);
      }
      return current(retry);
    } else if (method === "courseware.sceneImage.rebindModel") {
      assert.equal(j.phase, "prepared"); assert.equal(j.requestHash, p.expectedRequestHash);
      assert((await current(j)).current); assert.equal(j.taskRef, null);
      j.request.model = p.model; j.idempotencyKey = randomUUID(); j.requestHash = digest(JSON.stringify(j.request));
    } else if (method === "courseware.sceneImage.begin") {
      assert.equal(j.phase, "prepared"); assert((await current(j)).current);
      j.submissionScope = { sessionId: p.sessionId, teamProjectId: teamProjectId ?? null };
      j.phase = "submission-unknown";
      await afterBegin?.(j);
    } else if (method === "courseware.sceneImage.reject") {
      assert.equal(j.phase, "submission-unknown"); assert(j.submissionScope.teamProjectId);
      assert.deepEqual(p.rejectedRequest, { idempotencyKey: j.idempotencyKey, requestHash: j.requestHash });
      j.phase = "rejected";
    } else if (method === "courseware.sceneImage.bind") {
      assert.notEqual(j.phase, "prepared");
      if (j.taskRef) assert.deepEqual(j.taskRef, p.taskRef);
      j.taskRef = p.taskRef; j.phase = "submitted";
    } else if (method === "courseware.sceneImage.bundle.stage") {
      if (p.stageOnly) {
        assert.equal(p.images.length, 1);
        const image = p.images[0];
        assert.deepEqual(image.asset.taskRef, j.taskRef);
        await writeFile(join(root, `${image.asset.sha256}.bin`), Buffer.from(image.bytesBase64, "base64"));
        return current(j);
      }
      for (const [index, image] of p.images.entries()) {
        assert.deepEqual(image.asset.taskRef, j.taskRef);
        assert.equal(image.bytesBase64, undefined);
        assert.equal(digest(await readFile(join(root, `${image.asset.sha256}.bin`))), image.asset.sha256);
        if (!index) j.asset = structuredClone(image.asset);
        else records(p).push({ ...structuredClone(j), intentId: `${j.intentId}-layer-${index}`,
          target: image.target, asset: structuredClone(image.asset), selected: false });
      }
    } else if (method === "courseware.sceneImage.asset.stage") {
      assert.deepEqual(p.asset.taskRef, j.taskRef);
      if (j.asset) assert.deepEqual(j.asset, p.asset);
      await writeFile(join(root, `${p.asset.sha256}.bin`), Buffer.from(p.bytesBase64, "base64"));
      j.asset = structuredClone(p.asset);
    } else if (method === "courseware.sceneImage.asset.adopt") {
      assert((await current(j)).current); assert(j.asset);
      const matching = other => other.pageId === j.pageId && other.planSha256 === j.planSha256 && JSON.stringify(other.target) === JSON.stringify(j.target);
      const selected = records(p).find(other => matching(other) && other.selected);
      if ((selected?.intentId ?? null) !== p.expectedSelectedIntentId) throw new Error("selected image changed");
      for (const other of records(p)) if (matching(other)) other.selected = other === j;
    } else if (method !== "courseware.sceneImage.asset.get") assert.equal(method, "courseware.sceneImage.get");
    return { ...await current(j), ...(method.includes(".asset.") ? { path: join(root, `${j.asset.sha256}.bin`) } : {}) };
  } };
  const quote = { version: "courseware-media-quote-v1", kind: "image", model: "image-model", priceVersion: "image-v1",
    maxPoints: 3, maxChars: 4000, expiresAt: "2099-01-01T00:00:00Z", quoteToken: "private-server-proof" };
  const media = {
    async getLayerModels() { return []; },
    async getImageModels() { calls.push("GET models"); return [{ model: "image-model", voices: [], providerDefaultVoice: false,
      ...(supportsReferenceImage === undefined ? {} : { supportsReferenceImage }) }]; },
    async getImageQuote() { calls.push("GET quote"); if (quoteGate) await quoteGate.promise; return quote; },
    async submitConfirmedImage(key, request, confirmation, signal, projectId, check, admit) {
      await check?.(); if (admit) projectId = await admit();
      assert.equal(projectId, [...journals.values()].flat().find(j => j.idempotencyKey === key).submissionScope.teamProjectId ?? undefined);
      calls.push("POST confirmed");
      calls.push({ postedRequest: structuredClone(request) });
      assert.equal(records({ sessionId: "chat-a", principalKey: "a".repeat(64) }).find(j => j.idempotencyKey === key).phase, "submission-unknown");
      assert.equal(confirmation.quoteToken, quote.quoteToken);
      assert.equal(confirmation.maxPoints, 3, "confirmed ceiling is captured");
      if (refusal) throw new Error(refusal);
      if (submitGate) await submitGate.promise;
      const j = [...journals.values()].flat().find(j => j.idempotencyKey === key);
      const task = { version: "courseware-media-v1", kind: request.kind, taskId: "task-1", idempotencyKey: key,
        requestHash: j.requestHash, model: request.model, state: "queued", feeState: "reserved", reservedPoints: 3, actualPoints: null, errorCode: null, assetRef: null };
      tasks.set(key, task);
      if (lostReceipt) throw new Error("receipt lost");
      return wrongTask ? { ...task, model: "foreign" } : task;
    },
    async findImage(ref) { calls.push("GET by-key"); return missing ? null : tasks.get(ref.idempotencyKey) ?? null; },
    async getImage(ref) { calls.push("GET by-id"); return tasks.get(ref.idempotencyKey); },
    async downloadImage(ref) {
      calls.push("GET asset"); if (downloadGate) await downloadGate.promise;
      return { task: structuredClone(tasks.get(ref.idempotencyKey)), bytes: Buffer.from(downloadBytes) };
    },
  };
  const auth = { coursewareMedia: media, getCoursewarePrincipal() {
    const captured = account;
    return { key: captured, assertCurrent() { if (captured !== account) throw new Error("account changed"); } };
  } };
  const create = () => new CoursewareSceneImages(() => host, () => active, () => running, auth);
  const base = { sessionId: "chat-a" }, coordinator = create();
  const prepare = (extra = {}) => coordinator.prepare({ ...base, planSha256: sha256, pageId: "scene-001", model: "image-model", ...extra });
  const operation = v => ({ ...base, intentId: v.intentId });
  const priced = async () => { const v = await prepare(); return { view: v, payload: { ...operation(v), quoteId: (await coordinator.quote(operation(v))).quoteId } }; };
  return { root, path, sha256, calls, host, media, quote, create, coordinator, base, prepare, operation, priced,
    model(value) { model = value; },
    refusal(v) { refusal = v; }, team(v) { teamProjectId = v; }, afterBegin(fn) { afterBegin = fn; },
    account(v) { account = v; }, active(v) { active = v; }, running(v) { running = v; },
    lost(v = true) { lostReceipt = v; }, missing(v = true) { missing = v; }, wrong(v = true) { wrongTask = v; },
    submitGate(v) { submitGate = v; }, quoteGate(v) { quoteGate = v; }, approval(v) { approval = v; },
    downloadGate(v) { downloadGate = v; }, downloadBytes(v) { downloadBytes = v; },
    supportsReference(v) { supportsReferenceImage = v; },
    deselect(intentId) { for (const j of [...journals.values()].flat()) if (j.intentId === intentId) j.selected = false; },
    ready(bytes = png) { for (const task of tasks.values()) if (task.state === "queued") Object.assign(task, { state: "ready", feeState: "settled", actualPoints: 3,
      assetRef: { assetId: "image-asset", sha256: digest(bytes), byteLength: bytes.length,
        ...(task.kind === "image-layers" ? { mime: "application/vnd.trainwise.image-layers+json" } : { mime: "image/png", width: 2, height: 2 }),
        downloadPath: `/courseware/media/tasks/${task.taskId}/asset` } }); },
  };
}

test("an explicitly requested retry creates one fresh attempt for a refunded failed image without changing its prompt", async t => {
  const f = await fixture(t);
  const original = await f.prepare();
  await f.coordinator.generate(f.operation(original));
  const getImage = f.media.getImage;
  f.media.getImage = async (...args) => ({ ...await getImage(...args), state: "failed", feeState: "released", actualPoints: 0, errorCode: "UPSTREAM_HTTP_400" });
  assert.equal((await f.coordinator.status(f.operation(original))).task.state, "failed");
  assert.equal((await f.prepare()).intentId, original.intentId, "ordinary continuation must not buy a replacement");
  const retry = await f.coordinator.retry(f.operation(original));
  assert.notEqual(retry.intentId, original.intentId);
  assert.equal(retry.prompt, original.prompt);
  assert.equal((await f.coordinator.retry(f.operation(original))).intentId, retry.intentId, "repeat delivery must reuse this retry");
  assert.equal((await f.prepare()).intentId, retry.intentId);
  const rows = await f.coordinator.list(f.base);
  assert.equal(rows.find(row => row.intentId === original.intentId).current, false);
  assert.equal(rows.find(row => row.intentId === retry.intentId).current, true);
  await f.coordinator.generate(f.operation(retry));
  assert.equal(f.calls.filter(call => call === "POST confirmed").length, 2);
});

for (const state of ["queued", "submission_unknown", "ready"]) test(`explicit image retry rejects ${state} without creating a successor`, async t => {
  const f = await fixture(t);
  const original = await f.prepare();
  await f.coordinator.generate(f.operation(original));
  const getImage = f.media.getImage;
  f.media.getImage = async (...args) => ({ ...await getImage(...args), state, feeState: state === "ready" ? "settled" : "reserved", actualPoints: state === "ready" ? 3 : null });
  await assert.rejects(f.coordinator.retry(f.operation(original)), /CONFIRMED_TERMINAL_FAILURE/);
  assert.equal((await f.coordinator.list(f.base)).length, 1);
  assert.equal(f.calls.filter(call => call === "POST confirmed").length, 1);
});

test("queued scene dispatch rechecks its approved plan before the paid request", async t => {
  const f = await fixture(t), priced = await f.priced();
  f.media.submitConfirmedImage = async (...args) => {
    assert.equal(typeof args[5], "function");
    f.approval("b".repeat(64));
    await args[5]();
    assert.fail("replaced plan reached submission");
  };
  await assert.rejects(f.coordinator.submitConfirmed(priced.payload), /PLAN_CHANGED/);
  assert.equal(f.calls.includes("POST"), false);
});

test("one confirmed decomposition archives its base and foreground with the same receipt after coordinator restart", async t => {
  const f = await fixture(t), master = await f.priced();
  await f.coordinator.submitConfirmed(master.payload); f.ready();
  await f.coordinator.archive(f.operation(master.view));
  await f.coordinator.adopt({ ...f.operation(master.view), expectedSelectedIntentId: null });
  f.media.getLayerModels = async () => [{ model: "layers-model", supportsReferenceImage: true }];
  const prepared = await f.prepare({ model: undefined, target: { kind: "cleanPlate" }, referenceIntentId: master.view.intentId });
  assert.equal(prepared.decomposition, true);
  assert.equal(prepared.model, "layers-model");
  Object.assign(f.quote, { kind: "image-layers", model: "layers-model" });
  const quote = await f.coordinator.quote(f.operation(prepared));
  await f.coordinator.submitConfirmed({ ...f.operation(prepared), quoteId: quote.quoteId });
  nativePixels = Buffer.from([0, 0, 0, 0, 0, 0, 255, 255, 0, 0, 0, 0, 0, 0, 0, 0]);
  const bytes = Buffer.from(JSON.stringify({ data: [
    { z_index: 0, b64_json: png.toString("base64") },
    { z_index: 2, name: "Teacher", b64_json: png.toString("base64"), bounding_box: { normalized: [100, 200, 700, 900] } },
  ] }));
  f.ready(bytes); f.downloadBytes(bytes);
  const restarted = f.create();
  await restarted.archive(f.operation(prepared));
  const rows = await restarted.list(f.base), foreground = rows.find(row => row.intentId === `${prepared.intentId}-layer-1`);
  assert.deepEqual(foreground.asset.normalizedBoundingBox, [100, 200, 700, 900]);
  assert.equal(foreground.selected, false);
  const before = f.calls.filter(call => call === "GET asset").length;
  await restarted.archive(f.operation(prepared));
  assert.equal(f.calls.filter(call => call === "GET asset").length, before);
  assert.equal(f.calls.filter(call => call === "POST confirmed").length, 2, "master plus one decomposition");
});

test("explicit failed decomposition retry retains the selected master and submits identical reference bytes once", async t => {
  const f = await fixture(t), master = await f.priced();
  await f.coordinator.submitConfirmed(master.payload); f.ready();
  await f.coordinator.archive(f.operation(master.view));
  await f.coordinator.adopt({ ...f.operation(master.view), expectedSelectedIntentId: null });
  f.media.getLayerModels = async () => [{ model: "layers-model", supportsReferenceImage: true }];
  const original = await f.prepare({ model: undefined, target: { kind: "cleanPlate" }, referenceIntentId: master.view.intentId });
  Object.assign(f.quote, { kind: "image-layers", model: "layers-model" });
  await f.coordinator.generate(f.operation(original));
  const getImage = f.media.getImage;
  f.media.getImage = async (...args) => ({ ...await getImage(...args), state: "failed", feeState: "released", actualPoints: 0, errorCode: "UPSTREAM_HTTP_400" });
  const restarted = f.create();
  const retry = await restarted.retry(f.operation(original));
  assert.deepEqual(retry.referenceImage, original.referenceImage);
  assert.equal(retry.model, original.model);
  await restarted.generate(f.operation(retry));
  const posts = f.calls.filter(call => call.postedRequest).map(call => call.postedRequest);
  assert.deepEqual(posts[2], posts[1]);
  assert.equal((await restarted.retry(f.operation(original))).intentId, retry.intentId);
  assert.equal(posts.length, 3, "one master and two decomposition attempts");
  assert((await restarted.list(f.base)).find(row => row.intentId === master.view.intentId).selected);
});

test("retry requires final accounting even when the original image has failed", () => {
  for (const task of [{ state: "failed", feeState: "reserved", actualPoints: null },
    { state: "failed", feeState: "released", actualPoints: 1 }, { state: "failed", feeState: "settled", actualPoints: null }])
    assert.throws(() => retryHelpers.assertCoursewareRetryable(task), /CONFIRMED_TERMINAL_FAILURE/);
});

test("decomposition preserves validated layer bounds and rejects missing or forged layer data", async () => {
  nativePixels = Buffer.from([0, 0, 0, 0, 0, 0, 255, 255, 0, 0, 0, 0, 0, 0, 0, 0]);
  const taskRef = { taskId: "layers-task", idempotencyKey: randomUUID(), requestHash: "a".repeat(64) };
  const data = [
    { z_index: 2, name: "Teacher", b64_json: png.toString("base64"), bounding_box: { normalized: [100, 200, 700, 900] } },
    { z_index: 0, b64_json: png.toString("base64") },
  ];
  const decode = value => assetHelpers.decodeSceneImageBundle(Buffer.from(JSON.stringify({ data: value })), taskRef);
  const images = decode(data);
  assert.deepEqual(images.map(image => image.target), [{ kind: "cleanPlate" }, { kind: "layer", name: "2 - Teacher" }]);
  assert.deepEqual(images[1].asset.normalizedBoundingBox, [100, 200, 700, 900]);
  assert.equal(images[1].asset.sourceZIndex, 2);
  assert.deepEqual(images[1].asset.taskRef, taskRef);
  for (const layer of [ { ...data[0], bounding_box: {} }, { ...data[0], bounding_box: { normalized: [700, 200, 100, 900] } },
    { ...data[0], b64_json: "broken" }, { ...data[0], url: "https://untrusted.test/image" }, { ...data[0], z_index: 0 } ]) {
    assert.throws(() => decode([data[1], layer]), /INVALID_ASSET/);
  }
});

test("configured model is selected automatically and an invented model never reaches Host prepare", async t => {
  const f = await fixture(t);
  const image = await f.prepare({ model: undefined });
  assert.equal(image.model, "image-model");
  const prepared = f.calls.filter(call => call === "courseware.sceneImage.prepare").length;
  await assert.rejects(f.prepare({ model: "invented-model" }), /MODEL_UNAVAILABLE/);
  assert.equal(f.calls.filter(call => call === "courseware.sceneImage.prepare").length, prepared);
});

test("reviewed private references, background and layers resolve into pinned Main-only input without another media call", async t => {
  const f = await fixture(t);
  const missing = { ...f.base, planSha256: f.sha256 };
  await assert.rejects(f.coordinator.captureSelected(missing), /ASSETS_REQUIRED/);
  const colors = ["red", "blue", "green"];
  const targets = [{ kind: "visualMaster" }, { kind: "cleanPlate" }, { kind: "layer", name: "Circle" }];
  nativePixels = Buffer.from([0, 0, 0, 0, 0, 0, 0, 255, 0, 0, 0, 0, 0, 0, 0, 0]);
  for (let i = 0; i < targets.length; i++) {
    const bytes = await sharp({ create: { width: 2, height: 2, channels: 4, background: colors[i] } }).png().toBuffer();
    const row = await f.prepare({ target: targets[i] });
    await f.coordinator.submitConfirmed({ ...f.operation(row), quoteId: (await f.coordinator.quote(f.operation(row))).quoteId });
    f.ready(bytes); f.downloadBytes(bytes);
    await f.coordinator.archive(f.operation(row));
    await f.coordinator.adopt({ ...f.operation(row), expectedSelectedIntentId: null });
  }
  const mediaCalls = f.calls.filter(c => /^(GET|POST)/.test(c));
  const captured = await f.coordinator.captureSelected(missing);
  assert.equal(captured.workspace, f.root);
  assert.equal(captured.modelKey, "provider/model");
  assert.equal(captured.images.length, 3);
  assert.equal(new Set(captured.images.map(image => image.asset.sha256)).size, 3);
  assert.deepEqual(captured.proof.selectedIntentIds, captured.images.map(image => image.intentId));
  assert(captured.images.every(image => Buffer.isBuffer(image.bytes) && !Object.hasOwn(image, "path")));
  await captured.assertCurrent();
  assert.deepEqual(f.calls.filter(c => /^(GET|POST)/.test(c)), mediaCalls);
  f.model({});
  await assert.rejects(f.coordinator.captureSelected(missing), /MODEL_REQUIRED/);
  let inherited = { modelKey: "default-provider/default-model", thinkingLevel: "off" };
  const inheritedCapture = await f.coordinator.captureSelected(missing, async sessionId => {
    assert.equal(sessionId, "chat-a"); return { ...inherited };
  });
  assert.equal(inheritedCapture.modelKey, inherited.modelKey);
  await inheritedCapture.assertCurrent();
  inherited = { ...inherited, modelKey: "default-provider/changed-model" };
  await assert.rejects(inheritedCapture.assertCurrent(), /INPUT_CHANGED/);
  f.model({ providerId: "provider", modelId: "model" });
  f.active("another-chat");
  await assert.rejects(captured.assertCurrent(), /CONTEXT_CHANGED/);
  f.active("chat-a");
  f.account("b".repeat(64));
  await assert.rejects(captured.assertCurrent(), /account changed/);
  f.account("a".repeat(64));
  await writeFile(f.path, JSON.stringify({ ...plan, title: "Changed" }));
  await assert.rejects(captured.assertCurrent(), /PLAN_CHANGED/);
});

test("reviewed reference stays private until explicit confirmation and uses archived bytes with frozen identity", async t => {
  const f = await fixture(t);
  const master = await f.prepare();
  await f.coordinator.submitConfirmed({ ...f.operation(master), quoteId: (await f.coordinator.quote(f.operation(master))).quoteId });
  f.ready(); await f.coordinator.archive(f.operation(master));
  await f.coordinator.adopt({ ...f.operation(master), expectedSelectedIntentId: null });
  const posted = () => f.calls.filter(value => typeof value === "object").map(value => value.postedRequest);
  assert.equal(posted().length, 1);
  await assert.rejects(f.prepare({ target: { kind: "cleanPlate" }, referenceIntentId: master.intentId }), /REFERENCE_UNSUPPORTED/);
  assert.equal(posted().length, 1);
  f.supportsReference(true);
  const background = await f.prepare({ target: { kind: "cleanPlate" }, referenceIntentId: master.intentId });
  assert.deepEqual(background.referenceImage, { intentId: master.intentId, sha256: digest(png), mimeType: "image/png", byteLength: png.length });
  const quote = await f.coordinator.quote(f.operation(background));
  assert.equal(posted().length, 1, "prepare and quote never send bytes");
  assert(!JSON.stringify(quote).includes("bytesBase64"));
  f.supportsReference(false);
  await assert.rejects(f.coordinator.submitConfirmed({ ...f.operation(background), quoteId: quote.quoteId }), /REFERENCE_UNSUPPORTED/);
  assert.equal((await f.coordinator.list(f.base)).find(row => row.intentId === background.intentId).phase, "prepared");
  f.supportsReference(true);
  f.lost();
  await assert.rejects(f.coordinator.submitConfirmed({ ...f.operation(background), quoteId: quote.quoteId }), /receipt lost/);
  assert.deepEqual(posted()[1].referenceImage, { sha256: digest(png), mimeType: "image/png", byteLength: png.length, bytesBase64: png.toString("base64") });
  assert(!JSON.stringify(posted()[1]).includes(master.intentId), "private intent identity is not disclosed to the provider");
  const recovered = await f.create().status(f.operation(background));
  assert.equal(recovered.phase, "submitted");
  await f.coordinator.submitConfirmed({ ...f.operation(background), quoteId: quote.quoteId });
  assert.equal(posted().length, 2, "unknown receipt recovery never posts again");
});

test("stale or foreign reference selection refuses a paid dispatch", async t => {
  const f = await fixture(t), master = await f.prepare();
  await f.coordinator.submitConfirmed({ ...f.operation(master), quoteId: (await f.coordinator.quote(f.operation(master))).quoteId });
  f.ready(); await f.coordinator.archive(f.operation(master));
  await f.coordinator.adopt({ ...f.operation(master), expectedSelectedIntentId: null });
  f.supportsReference(true);
  const layer = await f.prepare({ target: { kind: "layer", name: "Circle" }, referenceIntentId: master.intentId });
  const quote = await f.coordinator.quote(f.operation(layer));
  f.deselect(master.intentId);
  await assert.rejects(f.coordinator.quote(f.operation(layer)), /REFERENCE_CHANGED/);
  await assert.rejects(f.coordinator.submitConfirmed({ ...f.operation(layer), quoteId: quote.quoteId }), /REFERENCE_CHANGED/);
  assert.equal(f.calls.filter(value => value === "POST confirmed").length, 1);
  f.account("b".repeat(64));
  await assert.rejects(f.prepare({ target: { kind: "cleanPlate" }, referenceIntentId: master.intentId }), /REFERENCE_CHANGED/);
  assert.equal(f.calls.filter(value => value === "POST confirmed").length, 1);
});

test("corrupt reviewed reference bytes refuse submission before durable begin", async t => {
  const f = await fixture(t), master = await f.prepare();
  await f.coordinator.submitConfirmed({ ...f.operation(master), quoteId: (await f.coordinator.quote(f.operation(master))).quoteId });
  f.ready(); await f.coordinator.archive(f.operation(master));
  await f.coordinator.adopt({ ...f.operation(master), expectedSelectedIntentId: null });
  f.supportsReference(true);
  const row = await f.prepare({ target: { kind: "cleanPlate" }, referenceIntentId: master.intentId });
  const quote = await f.coordinator.quote(f.operation(row));
  await writeFile(join(f.root, `${digest(png)}.bin`), Buffer.alloc(png.length));
  await assert.rejects(f.coordinator.submitConfirmed({ ...f.operation(row), quoteId: quote.quoteId }), /INVALID_ASSET/);
  assert.equal((await f.coordinator.list(f.base)).find(value => value.intentId === row.intentId).phase, "prepared");
  assert.equal(f.calls.filter(value => value === "POST confirmed").length, 1);
});

test("generation resolves only reviewed input, rejects surplus paths and refuses missing or byte-identical background roles", async t => {
  const f = await fixture(t);
  await assert.rejects(f.coordinator.captureSelected({ ...f.base, planSha256: f.sha256, path: "/other" }), /INVALID_REQUEST/);
  await assert.rejects(f.coordinator.captureSelected({ ...f.base, planSha256: "a".repeat(64) }), /PLAN_CHANGED/);
  const row = await f.prepare();
  assert.equal(row.selected, false);
  await assert.rejects(f.coordinator.captureSelected({ ...f.base, planSha256: f.sha256 }), /ASSETS_REQUIRED/);
  assert.equal(f.calls.filter(c => c === "POST confirmed").length, 0);
});

test("an old unsubmitted model is rebound before quoting, preserving its prompt and requiring fresh confirmation", async t => {
  const f = await fixture(t), old = await f.prepare({ instructions: "Keep the reviewed character" });
  const before = (await f.host.call("courseware.sceneImage.get", { sessionId: "chat-a", principalKey: "a".repeat(64), intentId: old.intentId })).intent;
  f.media.getImageModels = async () => [{ model: "current-model", voices: [], providerDefaultVoice: false }];
  f.media.getImageQuote = async model => { assert.equal(model, "current-model"); f.calls.push("GET quote"); return { ...f.quote, model }; };
  const quote = await f.coordinator.quote(f.operation(old));
  assert.equal(quote.model, "current-model");
  assert.equal(quote.intentId, old.intentId);
  const rebound = (await f.host.call("courseware.sceneImage.get", { sessionId: "chat-a", principalKey: "a".repeat(64), intentId: old.intentId })).intent;
  assert.equal(rebound.request.input, before.request.input);
  assert.notEqual(rebound.idempotencyKey, before.idempotencyKey);
  assert(!f.calls.includes("POST confirmed"));
  await f.coordinator.submitConfirmed({ ...f.operation(old), quoteId: quote.quoteId });
  assert.equal(f.calls.filter(call => call === "POST confirmed").length, 1);
  assert.equal(f.calls.find(call => call?.postedRequest).postedRequest.model, "current-model");
});

test("missing catalogs and begun requests cannot rebind or dispatch", async t => {
  const f = await fixture(t), prepared = await f.prepare();
  f.media.getImageModels = async () => [];
  await assert.rejects(f.coordinator.quote(f.operation(prepared)), /MODEL_UNAVAILABLE/);
  assert(!f.calls.includes("courseware.sceneImage.rebindModel"));
  assert(!f.calls.includes("GET quote"));
  assert(!f.calls.includes("POST confirmed"));
  const g = await fixture(t), begun = await g.prepare();
  await g.host.call("courseware.sceneImage.begin", { sessionId: "chat-a", principalKey: "a".repeat(64), intentId: begun.intentId });
  g.media.getImageModels = async () => [{ model: "current-model" }];
  await assert.rejects(g.coordinator.quote(g.operation(begun)), /PLAN_CHANGED/);
  assert(!g.calls.includes("courseware.sceneImage.rebindModel"));
});

test("scene image preparation and quote are nonpaid and hide server proofs; confirmed submit is journaled first", async t => {
  const f = await fixture(t), v = await f.prepare();
  assert.equal(v.pageId, "scene-001"); assert.equal(v.prompt, "Bright circle");
  assert.deepEqual(await f.coordinator.models(f.base), [{ model: "image-model" }]);
  const quoted = await f.coordinator.quote(f.operation(v));
  assert.equal(quoted.maxPoints, 3); assert(!JSON.stringify(quoted).includes("private-server-proof"));
  assert(!f.calls.includes("POST confirmed"));
  const result = await f.coordinator.submitConfirmed({ ...f.operation(v), quoteId: quoted.quoteId });
  assert.equal(result.phase, "submitted"); assert.equal(result.task.reservedPoints, 3);
  await f.coordinator.submitConfirmed({ ...f.operation(v), quoteId: quoted.quoteId });
  assert.equal(f.calls.filter(c => c === "POST confirmed").length, 1);
});

test("a requested cover-only correction preserves plan approval and the original archived image", async t => {
  const f = await fixture(t), original = await f.prepare();
  const bytes = await readFile(f.path);
  await f.coordinator.generate(f.operation(original));
  f.ready();
  await f.coordinator.archive(f.operation(original));
  const before = await f.coordinator.status(f.operation(original));
  assert(before.asset);
  const revised = await f.prepare({ target: { kind: "visualMaster" }, instructions: "Only the five animal subjects; exclude human figures." });
  assert.notEqual(revised.intentId, original.intentId);
  assert.equal(revised.planSha256, original.planSha256);
  assert.equal(revised.selected, false);
  assert.match(revised.prompt, /Only the five animal subjects/);
  assert.deepEqual(await readFile(f.path), bytes);
  const { plan: saved } = await draftReader.readSceneCourseDraft(f.host, f.base);
  assert.equal(saved.approvedSha256, saved.sha256);
  const retained = await f.coordinator.status(f.operation(original));
  assert.deepEqual(retained.asset, before.asset);
  assert.equal(f.calls.filter(c => c === "POST confirmed").length, 1, "Preparing the requested variant does not resubmit the old image");
});

test("asset roles and edited requirements reach Host; invalid role data is refused before Host access", async t => {
  const f = await fixture(t);
  for (const target of [{ kind: "visualMaster" }, { kind: "cleanPlate" }, { kind: "layer", name: "小兔" }]) {
    const original = await f.prepare({ target });
    assert.deepEqual(original.target, target);
    assert.equal((await f.prepare({ target })).intentId, original.intentId);
    const revised = await f.prepare({ target, instructions: "Change the palette" });
    assert.notEqual(revised.intentId, original.intentId);
    assert.match(revised.prompt, /Change the palette/);
  }
  const before = f.calls.length;
  for (const target of [null, { kind: "other" }, { kind: "layer", name: "" }, { kind: "cleanPlate", name: "hidden" },
    { kind: "layer", name: " bad " }, { kind: "layer", name: "x\ny" }, { kind: "layer", name: "x".repeat(81) }])
    await assert.rejects(f.prepare({ target }), /INVALID_REQUEST/);
  for (const instructions of [null, "x".repeat(1201), "bad\0prompt"])
    await assert.rejects(f.prepare({ instructions }), /INVALID_REQUEST/);
  assert.equal(f.calls.length, before);
  assert(!f.calls.includes("POST confirmed"));
});

test("independent layers require both visible pixels and actual transparent PNG pixels", async () => {
  const asset = { sha256: digest(png), mimeType: "image/png", byteLength: png.length, width: 2, height: 2 };
  const target = { kind: "layer", name: "Character" };
  try {
    for (const alpha of [0, 255]) {
      nativePixels = Buffer.alloc(16, alpha);
      assert.throws(() => assetHelpers.verifySceneImageAsset(png, asset, target), /REQUIRES_TRANSPARENT_PNG/);
    }
    nativePixels = Buffer.alloc(16); nativePixels[3] = 255;
    assert.deepEqual(assetHelpers.verifySceneImageAsset(png, asset, target), png);
    const jpeg = await sharp(png).jpeg().toBuffer();
    assert.throws(() => assetHelpers.verifySceneImageAsset(jpeg, { ...asset, sha256: digest(jpeg),
      mimeType: "image/jpeg", byteLength: jpeg.length }, target), /REQUIRES_TRANSPARENT_PNG/);
  } finally { nativePixels = Buffer.alloc(16); }
});

test("lost receipt survives coordinator restart and recovers only with GET; absence never submits again", async t => {
  const f = await fixture(t), p = await f.priced(); f.lost();
  await assert.rejects(f.coordinator.submitConfirmed(p.payload), /receipt lost/);
  const restarted = f.create(); f.missing();
  assert.equal((await restarted.status(f.operation(p.view))).phase, "submission-unknown");
  assert.equal((await restarted.submitConfirmed(p.payload)).phase, "submission-unknown");
  f.missing(false);
  assert.equal((await restarted.status(f.operation(p.view))).phase, "submitted");
  assert.equal(f.calls.filter(c => c === "POST confirmed").length, 1);
  assert.equal(f.calls.filter(c => c === "GET by-key").length, 3);
});

test("uncertain original jobs stay query-only without blocking independent image submissions", async t => {
  for (const lostReceipt of [false, true]) {
    const f = await fixture(t), original = await f.priced();
    if (lostReceipt) {
      f.lost();
      await assert.rejects(f.coordinator.submitConfirmed(original.payload), /receipt lost/);
      f.missing();
    } else {
      await f.coordinator.submitConfirmed(original.payload);
      const get = f.media.getImage;
      f.media.getImage = async (...args) => ({ ...await get(...args), state: "submission_unknown", errorCode: "SUBMISSION_UNKNOWN" });
    }
    const next = await f.prepare({ instructions: "A different visual" });
    f.lost(false);
    await f.coordinator.generate(f.operation(next));
    assert.equal(f.calls.filter(c => c === "POST confirmed").length, 2);
    await f.create().generate(f.operation(original.view));
    assert.equal(f.calls.filter(c => c === "POST confirmed").length, 2, "recovering the uncertain intent never submits it again");
  }
});

test("stale plan, forged payload, absent quote and restarted quote all reject before begin/POST", async t => {
  const f = await fixture(t), p = await f.priced();
  await assert.rejects(f.coordinator.submitConfirmed({ ...p.payload, quoteId: "unknown" }), /QUOTE_REQUIRED/);
  await assert.rejects(f.create().submitConfirmed(p.payload), /QUOTE_REQUIRED/);
  for (const invalid of [null, [], {}, { ...f.base, input: "renderer prompt" }, { ...p.payload, confirmed: true }])
    await assert.rejects(f.coordinator.submitConfirmed(invalid), /INVALID_REQUEST/);
  await writeFile(f.path, JSON.stringify({ ...plan, title: "Changed" }));
  await assert.rejects(f.coordinator.submitConfirmed(p.payload), /PLAN_CHANGED/);
  assert(!f.calls.includes("POST confirmed")); assert(!f.calls.includes("courseware.sceneImage.begin"));
});

test("account, active Chat and running-turn checks prevent paid work; late valid receipt remains in original partition", async t => {
  const f = await fixture(t), p = await f.priced();
  f.running(true); await assert.rejects(f.coordinator.submitConfirmed(p.payload), /CONTEXT_CHANGED/);
  f.running(false); f.active("chat-b"); await assert.rejects(f.coordinator.submitConfirmed(p.payload), /CONTEXT_CHANGED/);
  f.active("chat-a");
  const gate = pause(); f.submitGate(gate);
  const pending = f.coordinator.submitConfirmed(p.payload);
  while (!f.calls.includes("POST confirmed")) await new Promise(resolve => setImmediate(resolve));
  f.account("b".repeat(64)); gate.resolve();
  await assert.rejects(pending, /account changed/);
  assert.deepEqual(await f.coordinator.list(f.base), []);
  f.account("a".repeat(64));
  assert.equal((await f.coordinator.list(f.base))[0].phase, "submitted");
  assert.equal(f.calls.filter(c => c === "POST confirmed").length, 1);
});

test("in-flight duplicate rejects; corrupt task pins never bind, and the confirmed ceiling is immutable", async t => {
  const f = await fixture(t), p = await f.priced(), gate = pause();
  f.quote.maxPoints = 900; f.submitGate(gate); f.wrong();
  const first = f.coordinator.submitConfirmed(p.payload);
  while (!f.calls.includes("POST confirmed")) await new Promise(resolve => setImmediate(resolve));
  await assert.rejects(f.coordinator.submitConfirmed(p.payload), /IN_FLIGHT/);
  gate.resolve(); await assert.rejects(first, /INVALID_TASK/);
  assert(!f.calls.includes("courseware.sceneImage.bind"));
  assert.equal((await f.coordinator.list(f.base))[0].phase, "submission-unknown");
});

test("account switch while fetching a quote returns no usable confirmation", async t => {
  const f = await fixture(t), v = await f.prepare(), gate = pause(); f.quoteGate(gate);
  const pending = f.coordinator.quote(f.operation(v));
  while (!f.calls.includes("GET quote")) await new Promise(resolve => setImmediate(resolve));
  f.account("b".repeat(64)); gate.resolve();
  await assert.rejects(pending, /account changed/);
  assert(!f.calls.includes("POST confirmed"));
});

test("lost durable-begin acknowledgement or a just-revised plan cannot dispatch or reset the retained request", async t => {
  for (const mode of ["lost-ack", "plan-change"]) {
    const f = await fixture(t), p = await f.priced();
    const call = f.host.call;
    f.host.call = async (method, params) => {
      const result = await call(method, params);
      if (method === "courseware.sceneImage.begin") {
        if (mode === "lost-ack") throw new Error("checkpoint acknowledgement lost");
        await writeFile(f.path, JSON.stringify({ ...plan, title: "Revised after checkpoint" }));
      }
      return result;
    };
    await assert.rejects(f.coordinator.submitConfirmed(p.payload), mode === "lost-ack" ? /acknowledgement lost/ : /PLAN_CHANGED/);
    assert.equal((await f.coordinator.list(f.base))[0].phase, "submission-unknown");
    assert.equal((await f.create().status(f.operation(p.view))).phase, "submission-unknown");
    assert(!f.calls.includes("POST confirmed"));
  }
});

test("scene image IPC refuses a foreign renderer and surplus arguments before Host/media access", async () => {
  const ipc = { exports: {} };
  new Function("require", "exports", ts.transpileModule(await readFile(new URL("../electron/main/ipc/courseware-scene-image-ipc.ts", import.meta.url), "utf8"), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText)((id) => {
    if (id === "@pi-desktop/shared") return shared;
    if (id === "../courseware-scene-images") return { CoursewareSceneImages };
    if (id === "../courseware-scene-generation") return generation;
    throw new Error(id);
  }, ipc.exports);
  const handlers = new Map();
  ipc.exports.registerCoursewareSceneImageIpc({ registrar: {
    handleWithEvent(channel, fn) { handlers.set(channel, fn); },
    assertMainWindowSender(event) { if (event.sender !== "main") throw new Error("PERMISSION_DENIED"); },
  }, getHost() { throw new Error("Host must not be touched"); }, getViewingSessionId: () => "chat-a", activeTurns: new Map(), authSession: {} });
  assert.equal(handlers.size, 11);
  for (const fn of handlers.values()) {
    await assert.rejects(fn({ sender: "other" }, { sessionId: "chat-a" }), /PERMISSION_DENIED/);
    await assert.rejects(fn({ sender: "main" }, { sessionId: "chat-a" }, "extra"), /Unexpected scene (image|generation)/);
  }
});

test("ready image archives original bytes, previews after coordinator restart and needs explicit page selection without another POST", async t => {
  const f = await fixture(t), p = await f.priced();
  await f.coordinator.submitConfirmed(p.payload); f.ready();
  const preview = await f.coordinator.archive(f.operation(p.view));
  assert.equal(preview.image.selected, false); assert.equal(preview.image.asset.sha256, digest(png));
  assert.equal(preview.dataUrl, `data:image/png;base64,${png.toString("base64")}`);
  assert(!JSON.stringify(preview).includes(f.root)); assert(!JSON.stringify(preview.image).includes("taskRef"));
  const restarted = f.create();
  assert.deepEqual(await restarted.preview(f.operation(p.view)), preview);
  assert.deepEqual(await restarted.archive(f.operation(p.view)), preview);
  f.media.getImage = async () => { throw new Error("COURSEWARE_MEDIA_LEGACY_TASK_UNAVAILABLE"); };
  assert.deepEqual(await restarted.status(f.operation(p.view)), preview.image);
  assert.equal(f.calls.filter(c => c === "GET asset").length, 1);
  const selected = await restarted.adopt({ ...f.operation(p.view), expectedSelectedIntentId: null });
  assert.equal(selected[0].selected, true);
  await assert.rejects(restarted.adopt({ ...f.operation(p.view), expectedSelectedIntentId: null }), /selected image changed/);
  assert.equal((await restarted.adopt({ ...f.operation(p.view), expectedSelectedIntentId: p.view.intentId }))[0].selected, true);
  assert.equal(f.calls.filter(c => c === "POST confirmed").length, 1);
});

test("image download ownership, format and account races cannot archive or select unrelated bytes", async t => {
  const f = await fixture(t), p = await f.priced();
  await assert.rejects(f.coordinator.archive(f.operation(p.view)), /TASK_REQUIRED/);
  await f.coordinator.submitConfirmed(p.payload);
  await assert.rejects(f.coordinator.archive(f.operation(p.view)), /INVALID_TASK/);
  f.ready(); f.downloadBytes(Buffer.from("corrupt"));
  await assert.rejects(f.coordinator.archive(f.operation(p.view)), /INVALID_ASSET/);
  f.downloadBytes(png);
  const gate = pause(); f.downloadGate(gate);
  const before = f.calls.filter(c => c === "GET asset").length;
  const pending = f.coordinator.archive(f.operation(p.view));
  while (f.calls.filter(c => c === "GET asset").length === before) await new Promise(resolve => setImmediate(resolve));
  f.account("b".repeat(64)); gate.resolve();
  await assert.rejects(pending, /account changed/);
  assert(!f.calls.includes("courseware.sceneImage.asset.stage"));
  f.account("a".repeat(64));
  assert.equal((await f.coordinator.list(f.base))[0].asset, null);
  assert.equal(f.calls.filter(c => c === "POST confirmed").length, 1);
});

test("archived references keep their old plan, reject adoption after revision and verify private bytes again", async t => {
  const f = await fixture(t), p = await f.priced();
  await f.coordinator.submitConfirmed(p.payload); f.ready();
  await f.coordinator.archive(f.operation(p.view));
  await writeFile(f.path, JSON.stringify({ ...plan, title: "Revised lesson" }));
  assert.equal((await f.coordinator.preview(f.operation(p.view))).image.current, false);
  await assert.rejects(f.coordinator.adopt({ ...f.operation(p.view), expectedSelectedIntentId: null }), /PLAN_CHANGED/);
  await writeFile(join(f.root, `${digest(png)}.bin`), Buffer.alloc(png.length));
  await assert.rejects(f.coordinator.preview(f.operation(p.view)), /INVALID_ASSET/);
  await assert.rejects(f.coordinator.archive(f.operation(p.view)), /INVALID_ASSET/);
  assert.equal(f.calls.filter(c => c === "GET asset").length, 1, "Corruption must not silently redownload/replace");
  await assert.rejects(f.coordinator.adopt({ ...f.operation(p.view), expectedSelectedIntentId: null, path: "/tmp/forged" }), /INVALID_REQUEST/);
});

test("image metadata rejects dimensions and MIME mismatches before native codec allocation", async () => {
  for (const format of ["jpeg", "webp"]) {
    const bytes = await sharp(png)[format]().toBuffer();
    const asset = { sha256: digest(bytes), mimeType: `image/${format}`, byteLength: bytes.length, width: 2, height: 2 };
    assert.deepEqual(assetHelpers.verifySceneImageAsset(bytes, asset), bytes);
    assert.throws(() => assetHelpers.verifySceneImageAsset(bytes, { ...asset, width: 3 }), /INVALID_ASSET/);
    assert.throws(() => assetHelpers.verifySceneImageAsset(bytes, { ...asset, mimeType: "image/png" }));
    assert.throws(() => assetHelpers.verifySceneImageAsset(bytes, { ...asset, width: 5000 }), /INVALID_ASSET/);
  }
});

test("lost archive acknowledgement recovers the committed private image without a second download", async t => {
  const f = await fixture(t), p = await f.priced();
  await f.coordinator.submitConfirmed(p.payload); f.ready();
  const call = f.host.call;
  f.host.call = async (method, params) => {
    const result = await call(method, params);
    if (method === "courseware.sceneImage.asset.stage") throw new Error("archive acknowledgement lost");
    return result;
  };
  await assert.rejects(f.coordinator.archive(f.operation(p.view)), /acknowledgement lost/);
  assert.equal((await f.create().archive(f.operation(p.view))).image.asset.sha256, digest(png));
  assert.equal(f.calls.filter(c => c === "GET asset").length, 1);
  assert.equal(f.calls.filter(c => c === "POST confirmed").length, 1);
});

test("overlapping image archive is refused and swapped original task receipts never reach the archive", async t => {
  const f = await fixture(t), p = await f.priced();
  await f.coordinator.submitConfirmed(p.payload); f.ready();
  const download = f.media.downloadImage;
  for (const field of ["taskId", "idempotencyKey", "requestHash", "model"]) {
    f.media.downloadImage = async reference => {
      const result = await download(reference); result.task[field] = "foreign"; return result;
    };
    await assert.rejects(f.coordinator.archive(f.operation(p.view)), /INVALID_TASK/);
  }
  assert(!f.calls.includes("courseware.sceneImage.asset.stage"));
  f.media.downloadImage = download;
  const gate = pause(); f.downloadGate(gate);
  const before = f.calls.filter(c => c === "GET asset").length;
  const pending = f.coordinator.archive(f.operation(p.view));
  while (f.calls.filter(c => c === "GET asset").length === before) await new Promise(resolve => setImmediate(resolve));
  await assert.rejects(f.coordinator.archive(f.operation(p.view)), /IN_FLIGHT/);
  gate.resolve(); assert((await pending).image.asset);
});

test("scene submission carries the Host team binding", async t => {
  const f = await fixture(t); f.team("12345678-1234-1234-1234-123456789abc");
  const priced = await f.priced();
  await f.coordinator.submitConfirmed(priced.payload);
  assert.equal(f.calls.filter(method => method === "POST confirmed").length, 1);
});

test("scene submission pins personal scope before later first binding", async t => {
  const f = await fixture(t), priced = await f.priced();
  f.afterBegin(() => { f.team("12345678-1234-1234-1234-123456789abc"); });
  await f.coordinator.submitConfirmed(priced.payload);
  assert.equal(f.calls.filter(method => method === "POST confirmed").length, 1);
});

test("scene submission rejects a missing or foreign begin scope before POST", async t => {
  for (const value of [undefined, { sessionId: "foreign", teamProjectId: null }]) {
    const f = await fixture(t), priced = await f.priced();
    f.afterBegin(j => { j.submissionScope = value; });
    await assert.rejects(f.coordinator.submitConfirmed(priced.payload), /INVALID_SUBMISSION_SCOPE/);
    assert.equal(f.calls.filter(method => method === "POST confirmed").length, 0);
  }
});

for (const code of [46100, 46102]) test(`definite team scene refusal ${code} preserves history and requires a new quote`, async t => {
  const f = await fixture(t); f.team("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
  const first = await f.priced(); f.refusal(`COURSEWARE_MEDIA_PLATFORM_${code}`);
  assert.equal((await f.coordinator.submitConfirmed(first.payload)).phase, "rejected");
  const restarted = f.create();
  assert.equal((await restarted.status(f.operation(first.view))).phase, "rejected");
  assert.equal((await restarted.submitConfirmed(first.payload)).phase, "rejected");
  assert.equal(f.calls.filter(v => v === "GET by-key").length, 0);
  assert.equal(f.calls.filter(v => v === "POST confirmed").length, 1);
  f.refusal(undefined); const next = await f.priced();
  assert.notEqual(next.view.intentId, first.view.intentId);
  assert.notEqual(next.payload.quoteId, first.payload.quoteId);
  assert.equal(f.calls.filter(v => v === "POST confirmed").length, 1);
  assert.equal((await f.coordinator.submitConfirmed(next.payload)).phase, "submitted");
});

test("generation quotes internally and submits once without a renderer fee confirmation", async t => {
  const f = await fixture(t), prepared = await f.prepare();
  const result = await f.coordinator.generate(f.operation(prepared));
  assert.equal(result.phase, "submitted");
  await f.coordinator.generate(f.operation(prepared));
  assert.equal(f.calls.filter(call => call === "POST confirmed").length, 1);
});


test("the current Chat can inspect existing images during generation but cannot submit or select from the renderer", async t => {
  const f = await fixture(t), p = await f.prepare();
  f.running(true);
  assert.equal((await f.coordinator.list({ sessionId: "chat-a" })).length, 1);
  assert.equal((await f.coordinator.status(f.operation(p))).phase, "prepared");
  await assert.rejects(f.coordinator.generate(f.operation(p)), /CONTEXT_CHANGED/);
  await assert.rejects(f.coordinator.adopt({ ...f.operation(p), expectedSelectedIntentId: null }), /CONTEXT_CHANGED/);
  f.active("other");
  await assert.rejects(f.coordinator.list({ sessionId: "chat-a" }), /CONTEXT_CHANGED/);
});


test("later visual masters automatically upload the selected first page as a pinned style reference", async t => {
  const f = await fixture(t, { ...plan, pages: [...plan.pages, { ...plan.pages[0], title: "Pandy waves" }] });
  const master = await f.prepare();
  await f.coordinator.generate(f.operation(master));
  f.ready(); await f.coordinator.archive(f.operation(master));
  await f.coordinator.adopt({ ...f.operation(master), expectedSelectedIntentId: null });
  await assert.rejects(f.prepare({ pageId: "scene-002" }), /REFERENCE_UNSUPPORTED/);
  f.supportsReference(true);
  const next = await f.prepare({ pageId: "scene-002" });
  assert.equal(next.referenceImage.intentId, master.intentId);
  await f.coordinator.generate(f.operation(next));
  const posted = f.calls.filter(value => typeof value === "object").at(-1).postedRequest;
  assert.deepEqual(Buffer.from(posted.referenceImage.bytesBase64, "base64"), png);
  assert.equal(posted.referenceImage.sha256, digest(png));
  f.deselect(master.intentId);
  await assert.rejects(f.prepare({ pageId: "scene-002" }), /REFERENCE_CHANGED/);
});

test("native Seedream JPEG base is normalized to PNG without changing foreground bounds", async () => {
  const jpeg = await sharp(png).jpeg({ quality: 95 }).toBuffer();
  nativePixels = Buffer.from([0, 0, 0, 0, 0, 0, 255, 255, 0, 0, 0, 0, 0, 0, 0, 0]);
  const taskRef = { taskId: "layers-task", idempotencyKey: randomUUID(), requestHash: "a".repeat(64) };
  const images = assetHelpers.decodeSceneImageBundle(Buffer.from(JSON.stringify({ data: [
    { z_index: 1, b64_json: png.toString("base64"), bounding_box: { normalized: [187, 59, 808, 188] } },
    { z_index: 0, b64_json: jpeg.toString("base64"), output_format: "jpeg" },
  ] })), taskRef);
  assert.equal(images[0].target.kind, "cleanPlate");
  assert.equal(images[0].asset.mimeType, "image/png");
  assert.equal(images[0].bytesBase64, png.toString("base64"));
  assert.deepEqual(images[1].asset.normalizedBoundingBox, [187, 59, 808, 188]);
});


test("native decomposition keeps opaque PNG text carriers and rejects invisible layers", () => {
  const taskRef = { taskId: "layers-task", idempotencyKey: randomUUID(), requestHash: "a".repeat(64) };
  const bytes = Buffer.from(JSON.stringify({ data: [
    { z_index: 0, b64_json: png.toString("base64") },
    { z_index: 1, name: "Hello text card", b64_json: png.toString("base64"), bounding_box: { normalized: [187, 59, 808, 188] } },
  ] }));
  nativePixels = Buffer.alloc(16, 255);
  const images = assetHelpers.decodeSceneImageBundle(bytes, taskRef);
  assert.equal(images[1].bytesBase64, png.toString("base64"));
  nativePixels = Buffer.alloc(16);
  assert.throws(() => assetHelpers.decodeSceneImageBundle(bytes, taskRef), /LAYER_REQUIRES_TRANSPARENT_PNG/);
});


test("supplier layer URLs download in Desktop without credentials and retain native pixels", async () => {
  const calls = [], resolutions = [];
  electron.session = { defaultSession: {
    resolveHost: async host => { resolutions.push(host); return { endpoints: [{ address: "8.8.8.8", family: "ipv4" }] }; },
    resolveProxy: async () => "DIRECT",
  } };
  electron.net = { fetch: async (url, init) => {
    calls.push({ url, init });
    return new Response(png, { headers: { "content-type": "image/png" } });
  } };
  const taskRef = { taskId: "gw-url", idempotencyKey: randomUUID(), requestHash: "a".repeat(64) };
  const bundle = Buffer.from(JSON.stringify({ data: [
    { z_index: 0, url: "https://ark-cdn.example/base.png" },
    { z_index: 1, url: "https://ark-cdn.example/title.png", name: "Hello", bounding_box: { normalized: [100, 100, 900, 900] } },
  ] }));
  nativePixels = Buffer.alloc(16, 255);
  const images = await assetHelpers.downloadSceneImageBundle(bundle, taskRef);
  assert.equal(images.length, 2);
  assert.equal(images[1].bytesBase64, png.toString("base64"));
  assert.deepEqual(images[1].asset.normalizedBoundingBox, [100, 100, 900, 900]);
  assert.equal(calls.length, 2);
  assert.deepEqual(resolutions, ["ark-cdn.example", "ark-cdn.example"]);
  for (const { init } of calls) {
    assert.equal(init.headers, undefined);
    assert.equal(init.credentials, "omit");
    assert.equal(init.redirect, "error");
  }
  const bad = Buffer.from(bundle.toString().replaceAll("ark-cdn.example", "127.0.0.1"));
  await assert.rejects(assetHelpers.downloadSceneImageBundle(bad, taskRef));
  assert.equal(calls.length, 2);
  electron.net.fetch = async () => new Response("denied", { status: 403 });
  await assert.rejects(assetHelpers.downloadSceneImageBundle(bundle, taskRef), /INVALID_ASSET/);
  electron.net.fetch = async () => new Response(Buffer.alloc(8 * 1024 * 1024 + 1), { headers: { "content-type": "image/png" } });
  await assert.rejects(assetHelpers.downloadSceneImageBundle(bundle, taskRef), /BUNDLE_TOO_LARGE/);
});

test("native layer bundles above 16 MiB retain every provider pixel within Host RPC bounds", () => {
  // Valid ancillary PNG metadata models the multi-megabyte provenance chunks in real Ark output.
  const type = Buffer.from("caBX"), metadata = Buffer.alloc(5 * 1024 * 1024);
  const chunk = Buffer.alloc(metadata.length + 12);
  chunk.writeUInt32BE(metadata.length); type.copy(chunk, 4); metadata.copy(chunk, 8);
  chunk.writeUInt32BE(crc32(chunk.subarray(4, -4)), chunk.length - 4);
  const large = Buffer.concat([png.subarray(0, -12), chunk, png.subarray(-12)]);
  nativePixels = Buffer.alloc(16, 255);
  const data = Array.from({ length: 5 }, (_, z_index) => ({ z_index, b64_json: large.toString("base64"),
    ...(z_index ? { bounding_box: { normalized: [100, 100, 900, 900] } } : {}) }));
  const bytes = Buffer.from(JSON.stringify({ data }));
  assert(bytes.length > 16 * 1024 * 1024);
  const images = assetHelpers.decodeSceneImageBundle(bytes, { taskId: "gw-large", idempotencyKey: randomUUID(), requestHash: "a".repeat(64) });
  assert.equal(images.length, 5);
  assert.equal(images[4].bytesBase64, large.toString("base64"));
  assert(Buffer.byteLength(JSON.stringify({ images })) < shared.MAX_HOST_STDIN_LINE_BYTES);
});

test("large URL bundles stage one verified image per Host frame without changing supplier bytes", async () => {
  const type = Buffer.from("caBX"), metadata = Buffer.alloc(5 * 1024 * 1024);
  const chunk = Buffer.alloc(metadata.length + 12);
  chunk.writeUInt32BE(metadata.length); type.copy(chunk, 4); metadata.copy(chunk, 8);
  chunk.writeUInt32BE(crc32(chunk.subarray(4, -4)), chunk.length - 4);
  const large = Buffer.concat([png.subarray(0, -12), chunk, png.subarray(-12)]);
  const taskRef = { taskId: "gw-streamed", idempotencyKey: randomUUID(), requestHash: "a".repeat(64) };
  const data = Array.from({ length: 10 }, (_, z_index) => ({ z_index, url: `https://ark-cdn.example/${z_index}.png`,
    ...(z_index ? { bounding_box: { normalized: [100, 100, 900, 900] } } : {}) }));
  electron.session = { defaultSession: { resolveHost: async () => ({ endpoints: [{ address: "8.8.8.8", family: "ipv4" }] }), resolveProxy: async () => "DIRECT" } };
  let downloaded = 0, staged = 0;
  electron.net = { fetch: async () => { assert.equal(downloaded, staged, "archive each image before downloading the next"); downloaded++; return new Response(large, { headers: { "content-type": "image/png" } }); } };
  nativePixels = Buffer.alloc(16, 255);
  const images = await assetHelpers.downloadSceneImageBundle(Buffer.from(JSON.stringify({ data })), taskRef, async image => {
    assert.equal(image.bytesBase64, large.toString("base64"));
    assert(Buffer.byteLength(JSON.stringify({ images: [image] })) < shared.MAX_HOST_STDIN_LINE_BYTES);
    staged++;
  });
  assert.equal(staged, 10);
  assert.equal(images.length, 10);
  assert(images.every(image => image.bytesBase64 === undefined));
  assert(large.length * images.length > 44 * 1024 * 1024);
  assert(Buffer.byteLength(JSON.stringify({ images })) < 100_000);
});
