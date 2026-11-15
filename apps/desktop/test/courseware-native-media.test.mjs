import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, writeFile, mkdtemp, rm, symlink } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import ts from "typescript";
const placementExports = {};
new Function("exports", ts.transpileModule(await readFile(new URL("../electron/main/courseware-video-placement.ts", import.meta.url), "utf8"), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText)(placementExports);
const module = { exports: {} };
new Function("require", "exports", ts.transpileModule(await readFile(new URL("../electron/main/courseware-native-media.ts", import.meta.url), "utf8"), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText)(id => id === "./courseware-video-placement" ? placementExports : createRequire(import.meta.url)(id), module.exports);
const { CoursewareNativeMedia } = module.exports;
test("native music/video preview accepts verified portable bytes without requesting an account", async () => {
  const result = { bytes: new Uint8Array([1]), mimeType: "video/mp4" };
  const media = new CoursewareNativeMedia({}, { getCoursewarePrincipal() { assert.fail("Portable playback must stay local"); } }, {},
    { async preview() { return result; } });
  assert.equal(await media.preview({}), result);
  const failed = new CoursewareNativeMedia({}, { getCoursewarePrincipal() { assert.fail("No provider fallback"); } }, {},
    { async preview() { throw new Error("bad local video"); } });
  await assert.rejects(failed.preview({}), /bad local video/);
});
const request = { viewId: "view", expectedTeachingRevision: "rev", actionId: "clip" };
async function setup(t, type = "audio_clip") {
  const dir = await mkdtemp(join(tmpdir(), "native-teaching-media-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const bytes = Buffer.from(type === "audio_clip" ? "ID3-saved-music" : "\x00\x00\x00\x18ftypmp42");
  const sha256 = createHash("sha256").update(bytes).digest("hex"), path = join(dir, `${sha256}.bin`);
  await writeFile(path, bytes);
  const asset = { sha256, byteLength: bytes.length, mimeType: "audio/mpeg" };
  const principalKey = "a".repeat(64), id = `${type === "audio_clip" ? "music" : "video"}-${sha256}`;
  const action = { id: "clip", type, [type === "audio_clip" ? "audioAssetId" : "videoAssetId"]: id };
  const project = { source: { revision: "source", sha256: "f".repeat(64) }, pages: [{ pageId: "page", actions: [action] }] };
  let receiptPrincipal = principalKey, videoSource = { ...project.source };
  const network = [], adoptions = [];
  const taskRef = { taskId: "task", idempotencyKey: "original", requestHash: "d".repeat(64) };
  const placements = [];
  const calls = []; let current = true, account = true, intercept = async () => {};
  const check = async () => { if (!current) throw new Error("stale view"); };
  const host = { async call(method, args) {
    calls.push([method, args]); await intercept(method);
    if (method === "courseware.mediaCanvas.music.snapshotAssets") return { assets: [{ asset: { id, sha256, mimeType: "audio/mpeg" }, music: { principalKey: receiptPrincipal, intentId: "music-intent" } }] };
    if (method === "courseware.mediaCanvas.music.asset.get") return { path, intent: { asset } };
    if (method === "courseware.video.list") return { intents: [{ intentId: "video-intent", principalKey, projectId: "project", pageId: "page", slotId: "clip", phase: "adopted", model: "video-model", prompt: "A classroom greeting", taskRef, submissionScope: { sessionId: "session" }, placements, source: videoSource, asset }] };
    if (method === "courseware.video.asset.get") return { path, asset };
    throw new Error("Unexpected operation " + method);
  } };
  const media = new CoursewareNativeMedia({ async reuseVideo(input) { await check(); adoptions.push(input); return { adopted: true }; }, async ttsContext(args) {
    assert.deepEqual(args, { viewId: "view", expectedTeachingRevision: "rev" });
    return { host, sessionId: "session", projectId: "project", pageId: "page", project,
      expectedSourceRevision: "source", expectedTeachingRevision: "rev", assertCurrent: check };
  } }, { coursewareMedia: { video: { async get(ref) { network.push(ref); await intercept("permission"); return { ...taskRef, kind: "video", model: "video-model", state: "ready", feeState: "settled", assetRef: { sha256, mime: "video/mp4", byteLength: bytes.length } }; } } }, getCoursewarePrincipal: () => ({ key: principalKey, assertCurrent() { if (!account) throw new Error("account changed"); } }) }, { list: async () => [], adopt: async () => { throw new Error("Unexpected music adoption"); } });
  return { media, bytes, path, asset, action, project, calls, dir, network, adoptions, placements,
    foreignReceipt: () => { receiptPrincipal = "b".repeat(64); }, foreignSource: () => { videoSource = { ...project.source, sha256: "e".repeat(64) }; },
    intercept: fn => { intercept = fn; }, stale: () => { current = false; }, logout: () => { account = false; } };
}
for (const type of ["audio_clip", "video_clip"]) test(`${type} preview returns hash-verified local bytes without paths or network`, async t => {
  const f = await setup(t, type);
  const result = await f.media.preview(request);
  assert.deepEqual(Buffer.from(result.bytes), f.bytes);
  assert.equal(result.mimeType, type === "audio_clip" ? "audio/mpeg" : "video/mp4");
  assert.deepEqual(Object.keys(result).sort(), ["bytes", "mimeType"]);
  assert.equal(f.calls.length, 2);
  assert(f.calls.every(([, args]) => args.principalKey === "a".repeat(64) && args.sessionId === "session"));
});
test("foreign actions and untrusted request fields cannot request files", async t => {
  const f = await setup(t);
  for (const value of [null, [], { ...request, path: f.path }, { ...request, actionId: "../file" }, { ...request, actionId: "foreign" }])
    await assert.rejects(f.media.preview(value));
  assert.equal(f.calls.length, 0);
});
test("hash corruption and a symlink archive are rejected", async t => {
  const f = await setup(t);
  await writeFile(f.path, Buffer.alloc(f.bytes.length));
  await assert.rejects(f.media.preview(request), /PREVIEW_INVALID/);
  await rm(f.path); const other = join(f.dir, "other.bin"); await writeFile(other, f.bytes); await symlink(other, f.path);
  await assert.rejects(f.media.preview(request));
});
test("navigation and logout during retrieval cannot deliver late media", async t => {
  for (const change of ["stale", "logout"]) {
    const f = await setup(t);
    f.intercept(async method => { if (method.endsWith("asset.get")) f[change](); });
    await assert.rejects(f.media.preview(request), /stale|account/);
  }
});
test("wrong music account and video source do not authorize a local read", async t => {
  const f = await setup(t);
  f.foreignReceipt();
  await assert.rejects(f.media.preview(request));
  const v = await setup(t, "video_clip");
  v.foreignSource();
  await assert.rejects(v.media.preview(request));
  assert.equal(v.calls.some(([method]) => method.endsWith("asset.get")), false);
});

const libraryRequest = { viewId: "view", expectedTeachingRevision: "rev" };
test("video library is local and adoption checks the original receipt without generating media", async t => {
  const f = await setup(t, "video_clip");
  assert.deepEqual(await f.media.list(libraryRequest), [{ kind: "video", intentId: "video-intent", title: "A classroom greeting", model: "video-model", inPage: false }]);
  assert.deepEqual(f.network, []);
  assert.deepEqual(await f.media.adopt({ ...libraryRequest, kind: "video", intentId: "video-intent", actionId: "new-node" }), { adopted: true });
  assert.equal(f.network.length, 1);
  assert.deepEqual(f.adoptions, [{ ...libraryRequest, principalKey: "a".repeat(64), intentId: "video-intent", actionId: "new-node", assetId: `video-${f.asset.sha256}` }]);
});
test("reuse placements are previewable while a forged clip has no current receipt", async t => {
  const f = await setup(t, "video_clip");
  f.action.id = "reuse-node";
  await assert.rejects(f.media.preview({ ...request, actionId: "reuse-node" }));
  f.placements.push({ pageId: "page", actionId: "reuse-node" });
  assert.deepEqual(Buffer.from((await f.media.preview({ ...request, actionId: "reuse-node" })).bytes), f.bytes);
});
test("revoked video permission and navigation during permission read prevent adoption", async t => {
  const f = await setup(t, "video_clip");
  f.intercept(async method => { if (method === "permission") throw new Error("PERMISSION_DENIED"); });
  await assert.rejects(f.media.adopt({ ...libraryRequest, kind: "video", intentId: "video-intent", actionId: "new-node" }), /PERMISSION_DENIED/);
  assert.equal(f.adoptions.length, 0);
  f.intercept(async method => { if (method === "permission") f.stale(); });
  await assert.rejects(f.media.adopt({ ...libraryRequest, kind: "video", intentId: "video-intent", actionId: "new-node" }), /stale/);
  assert.equal(f.adoptions.length, 0);
});
