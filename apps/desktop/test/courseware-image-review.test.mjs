import assert from "node:assert/strict";
import * as files from "node:fs/promises";
import * as fsConstants from "node:fs";
import * as paths from "node:path";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { crc32 } from "node:zlib";
import test from "node:test";
import ts from "typescript";
import * as shared from "../../../packages/shared/dist/index.js";
import { createHash, randomUUID } from "node:crypto";

const sharp = createRequire(new URL("../../../packages/courseware-runtime/package.json", import.meta.url))("sharp");
const png = await sharp({ create: { width: 2, height: 2, channels: 4, background: "red" } }).png().toBuffer();
const digest = bytes => createHash("sha256").update(bytes).digest("hex");
// Exercise real file/hash/MIME/PNG validation; only the Electron codec is replaced.
const electron = { nativeImage: { createFromBuffer: () => ({ isEmpty: () => false,
  getSize: () => ({ width: 2, height: 2 }), toBitmap: () => Buffer.alloc(16), toPNG: () => png }) } };
async function load(name, dependencies) {
  const exports = {};
  new Function("require", "exports", ts.transpileModule(await files.readFile(new URL(`../electron/main/${name}.ts`, import.meta.url), "utf8"), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText)(id => { assert(Object.hasOwn(dependencies, id), `Unexpected dependency: ${id}`); return dependencies[id]; }, exports);
  return exports;
}
const context = await load("courseware-scene-context", { electron, "node:crypto": { createHash }, "node:zlib": { crc32 } });
const assets = await load("courseware-scene-image-assets", { electron, "node:crypto": { createHash },
  "node:fs": fsConstants, "node:fs/promises": files, "node:path": paths, "./courseware-scene-context": context, "./public-https-fetch": await load("public-https-fetch", {
    "node:dns/promises": await import("node:dns/promises"), "@pi-desktop/shared": shared }) });
const { CoursewareImageReview } = await load("courseware-image-review", { electron, "node:crypto": { createHash, randomUUID },
  "@pi-desktop/shared": shared, "./courseware-scene-image-assets": assets });
const reference = JSON.parse(await files.readFile(new URL("../../../packages/shared/src/courseware-contract.fixtures/team-image.json", import.meta.url), "utf8")).data;
function setup() {
  let account = true, owner = true, dirty = false, workspace = "/work";
  const snapshot = { projectId: "local", documentId: "doc", sessionId: "editor", sha256: "b".repeat(64), revision: 1 };
  const calls = [];
  let beforeResolve = () => {}, beforeArchive = () => {};
  const archived = { intent: {} }, archiveCalls = [], reviewCalls = [];
  let host = { async call(method, params) {
    archiveCalls.push([method, params]); assert.equal(method, "courseware.mediaCanvas.image.asset.get");
    await beforeArchive(); return structuredClone(archived);
  } };
  const native = { ...snapshot, editGeneration: 1, page: 1, readOnly: false, capabilities: [] };
  const assertOwner = () => { if (!owner) throw new Error("owner changed"); };
  const auth = {
    getCoursewarePrincipal() { if (!account) throw new Error("auth required"); return { key: "a".repeat(64), assertCurrent() { if (!account) throw new Error("account changed"); } }; },
    coursewareMedia: { async getTeamAsset(project, asset) { calls.push([project, asset]); return structuredClone(reference); } },
    async resolveTeamSceneImages(refs) { beforeResolve(); calls.push(refs); return [{ sha256: reference.assetRef.sha256, width: 1, height: 1, bytes: Buffer.alloc(68) }]; },
  };
  const editor = {
    teachingSnapshot() { if (dirty) throw new Error("save first"); return { ...snapshot }; },
    async verifyTeachingSource() { if (dirty) throw new Error("save first"); },
    async getContext() { return structuredClone(native); },
    async reviewImageTarget(asset, target) {
      reviewCalls.push([asset, target]);
      if (native.page !== target.page || native.editGeneration !== target.editGeneration || native.readOnly) throw new Error("target changed");
      native.editGeneration++;
      native.capabilities = [{ name: target.operation === "replace" ? "replace_slide_image_from_asset" : "insert_slide_image_from_asset" }];
      return structuredClone(native);
    },
  };
  const service = new CoursewareImageReview(editor, auth, async () => workspace, assertOwner, () => host);
  return { service, calls, archiveCalls, archived, reviewCalls, native, snapshot, auth, editor,
    payload: { sessionId: "chat", projectId: reference.projectId, assetId: reference.assetRef.assetId },
    change(kind) { if (kind === "account") account = false; if (kind === "owner") owner = false; if (kind === "dirty") dirty = true; if (kind === "workspace") workspace = "/other"; if (kind === "source") snapshot.sha256 = "c".repeat(64); if (kind === "session") snapshot.sessionId = "other"; if (kind === "host") host = null; },
    beforeResolve(fn) { beforeResolve = fn; }, beforeArchive(fn) { beforeArchive = fn; } };
}

async function canvasFixture(t, mimeType = "image/png") {
  const f = setup(), root = await files.mkdtemp(paths.join(tmpdir(), "canvas-image-review-"));
  t.after(() => files.rm(root, { recursive: true, force: true }));
  const bytes = mimeType === "image/png" ? png : await sharp(png).toFormat(mimeType === "image/jpeg" ? "jpeg" : "webp").toBuffer();
  const asset = { sha256: digest(bytes), mimeType, byteLength: bytes.length, width: 2, height: 2,
    taskRef: { taskId: "media-image-1", idempotencyKey: randomUUID(), requestHash: "d".repeat(64) } };
  const path = paths.join(root, `${asset.sha256}.bin`); await files.writeFile(path, bytes);
  Object.assign(f.archived, { path, current: false, intent: { intentId: "intent-1", phase: "submitted", asset, taskRef: asset.taskRef } });
  return { ...f, bytes, path, payload: { sessionId: "chat", intentId: "intent-1", operation: "replace" } };
}
function command(f, review, operation = f.payload.operation) {
  return { projectId: f.snapshot.projectId, documentId: f.snapshot.documentId, sessionId: f.snapshot.sessionId,
    requestId: randomUUID(), editGeneration: f.native.editGeneration,
    tool: operation === "replace" ? "replace_slide_image_from_asset" : "insert_slide_image_from_asset",
    input: { assetId: review.asset.assetId } };
}

test("image preview requires explicit approval and binds remote pins to the saved local PPTX", async () => {
  const f = setup();
  const review = await f.service.prepare(f.payload);
  assert.match(review.preview, /^data:image\/png;base64,/);
  assert.equal(await f.service.metadata("/work"), null);
  await assert.rejects(f.service.load(review.asset.assetId, "/work"), /not been reviewed/);
  await assert.rejects(f.service.approve("wrong"), /expired/);
  await f.service.approve(review.reviewId);
  assert.deepEqual(await f.service.metadata("/work"), review.asset);
  const loaded = await f.service.load(review.asset.assetId, "/work");
  loaded.assertCurrent();
  assert.equal(f.calls.length, 3, "preview and execution resolve separately");
  f.service.clear();
  assert.throws(loaded.assertCurrent, /expired/);
  await assert.rejects(f.service.load(review.asset.assetId, "/work"));
});

test("source, account, owner, workspace and session changes revoke review and late bytes", async () => {
  for (const kind of ["account", "owner", "workspace", "source", "session", "dirty"]) {
    const f = setup(); const review = await f.service.prepare(f.payload); await f.service.approve(review.reviewId);
    f.change(kind);
    await assert.rejects(f.service.load(review.asset.assetId, "/work"), undefined, kind);
    assert.equal(await f.service.metadata("/work"), null);
  }
  for (const kind of ["account", "owner", "source", "session", "dirty"]) {
    const f = setup(); const review = await f.service.prepare(f.payload); await f.service.approve(review.reviewId);
    f.beforeResolve(() => f.change(kind));
    await assert.rejects(f.service.load(review.asset.assetId, "/work"), undefined, kind);
  }
});

test("invalid or cancelled/replaced previews never grant an image capability", async () => {
  const f = setup();
  for (const input of [{}, { ...f.payload, url: "https://invalid" }, { ...f.payload, sessionId: 3 }]) await assert.rejects(f.service.prepare(input), /Invalid/);
  assert.equal(f.calls.length, 0);
  f.beforeResolve(() => f.service.clear());
  await assert.rejects(f.service.prepare(f.payload), /expired/);
  assert.equal(await f.service.metadata("/work"), null);
});

test("archived canvas candidates preview exact local bytes and require explicit target approval", async t => {
  const f = await canvasFixture(t);
  const review = await f.service.prepare(f.payload);
  assert.deepEqual(review.target, { page: 1, operation: "replace" });
  assert.equal(review.preview, `data:image/png;base64,${png.toString("base64")}`);
  assert.equal(review.asset.sha256, digest(png));
  assert.equal(await f.service.metadata("/work"), null);
  assert.equal(f.reviewCalls.length, 0, "preview never authorizes native edits");
  await assert.rejects(f.service.load(review.asset.assetId, "/work", command(f, review)), /not been reviewed/);
  await f.service.approve(review.reviewId);
  const native = command(f, review);
  const loaded = await f.service.load(review.asset.assetId, "/work", native);
  loaded.assertCurrent(); assert.deepEqual(loaded.bytes, png);
  assert.equal(f.calls.length, 0, "canvas adoption does not access team or supplier APIs");
  assert.equal(f.archiveCalls.length, 2, "private archive is reverified at execution");
  assert.deepEqual(f.archiveCalls[0][1], { sessionId: "chat", principalKey: "a".repeat(64), intentId: "intent-1" });
  await assert.rejects(f.service.load(review.asset.assetId, "/work"), /target changed/);
  await assert.rejects(f.service.load(review.asset.assetId, "/work", command(f, review, "insert")), /target changed/);
  f.native.editGeneration++;
  await assert.rejects(f.service.load(review.asset.assetId, "/work", command(f, review)), /target changed/);
});

test("canvas JPEG and WebP use a verified PNG review without changing the archived originals", async t => {
  for (const mime of ["image/jpeg", "image/webp"]) {
    const f = await canvasFixture(t, mime);
    const review = await f.service.prepare({ ...f.payload, operation: "insert" });
    assert.equal(review.asset.mime, "image/png"); assert.equal(review.asset.sha256, digest(png));
    await f.service.approve(review.reviewId);
    const loaded = await f.service.load(review.asset.assetId, "/work", command(f, review, "insert"));
    assert.deepEqual(loaded.bytes, png); assert.deepEqual(await files.readFile(f.path), f.bytes);
  }
});

test("selection/page/read-only changes during canvas preview require a fresh review", async t => {
  for (const change of ["generation", "page", "readOnly"]) {
    const f = await canvasFixture(t); const review = await f.service.prepare(f.payload);
    if (change === "generation") f.native.editGeneration++;
    if (change === "page") f.native.page++;
    if (change === "readOnly") f.native.readOnly = true;
    await assert.rejects(f.service.approve(review.reviewId), /target changed/, change);
    assert.equal(await f.service.metadata("/work"), null);
  }
});

test("canvas reviews reject replaced Host, source, owner, account and late archive reads", async t => {
  for (const kind of ["account", "owner", "workspace", "source", "session", "dirty", "host"]) {
    const f = await canvasFixture(t); const review = await f.service.prepare(f.payload);
    await f.service.approve(review.reviewId); const native = command(f, review);
    f.change(kind);
    await assert.rejects(f.service.load(review.asset.assetId, "/work", native), undefined, kind);
    assert.equal(await f.service.metadata("/work"), null);
  }
  for (const kind of ["account", "owner", "host"]) {
    const f = await canvasFixture(t);
    f.beforeArchive(() => f.change(kind));
    await assert.rejects(f.service.prepare(f.payload), undefined, kind);
    assert.equal(await f.service.metadata("/work"), null);
  }
});

test("untrusted canvas fields, receipt mismatches and tampered local bytes never become approved", async t => {
  const f = await canvasFixture(t);
  for (const payload of [{ ...f.payload, intentId: undefined }, { ...f.payload, intentId: ".." },
    { ...f.payload, path: f.path }, { ...f.payload, operation: "guess" }, { ...f.payload, intentId: {} }])
    await assert.rejects(f.service.prepare(payload), /Invalid/);
  assert.equal(f.archiveCalls.length, 0);
  f.archived.intent.taskRef = { ...f.archived.intent.taskRef, requestHash: "f".repeat(64) };
  await assert.rejects(f.service.prepare(f.payload), /Invalid canvas image archive/);
  f.archived.intent.taskRef = f.archived.intent.asset.taskRef;
  await files.writeFile(f.path, Buffer.from("tampered"));
  await assert.rejects(f.service.prepare(f.payload));
  assert.equal(await f.service.metadata("/work"), null);
});

test("canvas capability failures and archive deletion fail closed without downloads or writes", async t => {
  const f = await canvasFixture(t); const review = await f.service.prepare(f.payload);
  f.editor.reviewImageTarget = async () => ({ ...f.native, capabilities: [] });
  await assert.rejects(f.service.approve(review.reviewId), /does not support/);
  assert.equal(await f.service.metadata("/work"), null);
  const next = await f.service.prepare(f.payload);
  f.editor.reviewImageTarget = async () => ({ ...f.native, capabilities: [{ name: "replace_slide_image_from_asset" }] });
  await f.service.approve(next.reviewId);
  await files.rm(f.path);
  await assert.rejects(f.service.load(next.asset.assetId, "/work", command(f, next)));
  assert.equal(f.calls.length, 0);
});
