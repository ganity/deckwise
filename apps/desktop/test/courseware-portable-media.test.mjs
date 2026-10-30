import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, writeFile, mkdtemp, rm, symlink } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const exports = {};
new Function("require", "exports", ts.transpileModule(await readFile(new URL("../electron/main/courseware-portable-media.ts", import.meta.url), "utf8"), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText)(createRequire(import.meta.url), exports);
const { CoursewarePortableMedia } = exports;
const view = { viewId: "view", expectedTeachingRevision: "teaching" };

async function fixture(t, type = "speech") {
  const directory = await mkdtemp(join(tmpdir(), "portable-media-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const bytes = await readFile(new URL("../../../packages/courseware-runtime/tests/fixtures/fixed-courseware/page-1.wav", import.meta.url));
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const id = `${type === "speech" ? "tts" : type === "audio_clip" ? "music" : "video"}-${sha256}`;
  const mimeType = type === "video_clip" ? "video/mp4" : "audio/wav";
  const path = join(directory, `${sha256}.bin`);
  await writeFile(path, bytes);
  const asset = { id, sha256, mimeType };
  const media = { asset, path, byteLength: bytes.length, durationMs: 5955 };
  const action = { id: "node", type, text: "Hello!", [type === "video_clip" ? "videoAssetId" : "audioAssetId"]: id };
  const project = { projectId: "portable-project", source: { revision: "source", sha256: "a".repeat(64) },
    pages: [{ pageId: "page", actions: [action] }] };
  let current = true, intercept = async () => {}, duration = 5955, reply = { media };
  const calls = [], decodes = [];
  const check = async () => { if (!current) throw new Error("stale view"); };
  const context = { project, projectId: project.projectId, sessionId: "chat", pageId: "page",
    expectedSourceRevision: "source", expectedTeachingRevision: "teaching", assertCurrent: check,
    host: { async call(method, input) { calls.push([method, input]); await intercept(input); return reply; } } };
  const local = new CoursewarePortableMedia({ async ttsContext(input) { assert.deepEqual(input, view); return context; } },
    async (actual, mime) => { decodes.push(mime); assert.deepEqual(actual, bytes); await intercept("decode"); return { durationMs: duration }; });
  return { local, context, project, media, bytes, calls, decodes, path,
    stale() { current = false; }, intercept(fn) { intercept = fn; }, duration(value) { duration = value; }, reply(value) { reply = value; } };
}

for (const kind of ["speech", "audio_clip", "video_clip"]) test(`portable ${kind} preview decodes hash-verified bytes without a provider`, async t => {
  const f = await fixture(t, kind);
  const result = await f.local.preview({ ...view, actionId: "node" }, kind === "speech" ? "speech" : "clip");
  assert.deepEqual(Buffer.from(result.bytes), f.bytes);
  assert.equal(result.mimeType, f.media.asset.mimeType);
  assert.deepEqual(Object.keys(result).sort(), ["bytes", "mimeType"]);
  assert.deepEqual(f.calls, [["courseware.project.localMedia", { sessionId: "chat", projectId: "portable-project", pageId: "page", actionId: "node",
    expectedSourceRevision: "source", expectedTeachingRevision: "teaching" }]]);
  assert.equal(f.decodes.length, 1);
});

test("speech and clip preview routes refuse the other action kind before reading files", async t => {
  for (const [type, route] of [["speech", "clip"], ["audio_clip", "speech"], ["video_clip", "speech"]]) {
    const f = await fixture(t, type);
    await assert.rejects(f.local.preview({ ...view, actionId: "node" }, route));
    assert.equal(f.calls.length, 0);
    assert.equal(f.decodes.length, 0);
  }
});

for (const change of ["bytes", "length", "digest", "duration", "kind", "symlink", "stale-rpc", "stale-decode", "receipt-shape"]) {
  test(`portable media refuses ${change} before returning playable data`, async t => {
    const f = await fixture(t);
    if (change === "bytes") await writeFile(f.path, Buffer.alloc(f.bytes.length));
    if (change === "length") f.media.byteLength++;
    if (change === "digest") f.media.asset.sha256 = "c".repeat(64);
    if (change === "duration") f.duration(5954);
    if (change === "kind") f.media.asset.mimeType = "video/mp4";
    if (change === "symlink") { const other = f.path + ".other"; await writeFile(other, f.bytes); await rm(f.path); await symlink(other, f.path); }
    if (change === "stale-rpc") f.intercept(input => { if (input !== "decode") f.stale(); });
    if (change === "stale-decode") f.intercept(input => { if (input === "decode") f.stale(); });
    if (change === "receipt-shape") f.reply({ media: f.media, providerReceipt: "unexpected" });
    await assert.rejects(f.local.preview({ ...view, actionId: "node" }, "speech"));
  });
}

test("snapshot checks every page-local reference, decodes repeated assets once and carries no path", async t => {
  const f = await fixture(t);
  f.project.pages.push({ pageId: "other", actions: structuredClone(f.project.pages[0].actions) });
  assert.deepEqual(await f.local.snapshotAssets(view), [{ asset: f.media.asset, local: true }]);
  assert.equal(f.calls.length, 2);
  assert.equal(f.decodes.length, 1);
  f.intercept(input => { if (input.pageId === "other") f.reply({ media: null }); });
  assert.deepEqual(await f.local.snapshotAssets(view), []);
});

test("ordinary projects and unbound imported actions retain the existing provider path", async t => {
  const f = await fixture(t);
  f.context.projectId = "office-project";
  assert.equal(await f.local.preview({ ...view, actionId: "node" }, "speech"), null);
  assert.deepEqual(await f.local.snapshotAssets(view), []);
  assert.equal(f.calls.length, 0);
  f.context.projectId = "portable-project";
  f.reply({ media: null });
  assert.equal(await f.local.preview({ ...view, actionId: "node" }, "speech"), null);
  assert.equal(f.decodes.length, 0);
});

test("real Electron decodes portable WAV/MP3/MP4 and routes local preview/snapshot without an account", {
  skip: process.env.DECKWISE_E2E_PORTABLE_MEDIA !== "1", timeout: 60_000,
}, async t => {
  const directory = await mkdtemp(join(tmpdir(), "portable-media-electron-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const binary = (await import("electron")).default;
  const env = { ...process.env, DECKWISE_PORTABLE_MEDIA_TEST_DIR: directory };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(binary, ["--no-sandbox", fileURLToPath(new URL("./fixtures/courseware-portable-media-electron.cjs", import.meta.url))], { env, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  for (const stream of [child.stdout, child.stderr]) stream.on("data", bytes => { output = (output + bytes).slice(-64 * 1024); });
  const timer = setTimeout(() => child.kill("SIGKILL"), 50_000);
  try {
    const [code] = await once(child, "close");
    assert.equal(code, 0, output);
    const report = JSON.parse(await readFile(join(directory, "report.json"), "utf8"));
    assert.equal(report.status, "PASS");
    assert.equal(report.accountLookups, 0);
    assert.deepEqual(report.codecs.map(codec => codec.mimeType), ["audio/wav", "audio/mpeg", "video/mp4"]);
    assert.equal(report.durationMismatchRejected, true);
    assert(report.mainRoutes.includes("tts-music-video-local-snapshot"));
    assert(report.hostCalls.length > 0 && report.hostCalls.every(method => method === "courseware.project.localMedia"));
  } finally { clearTimeout(timer); if (child.exitCode === null) child.kill("SIGKILL"); }
});
