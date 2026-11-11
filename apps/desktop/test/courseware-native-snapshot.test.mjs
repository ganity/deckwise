import * as runtime from "../../../packages/courseware-runtime/dist/node.mjs";
import assert from "node:assert/strict";
import { readFileSync, promises as fs } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { createHash, randomUUID } from "node:crypto";
import test from "node:test";
import ts from "typescript";
import * as shared from "../../../packages/shared/dist/index.js";
const require = createRequire(import.meta.url), cache = new Map();
function load(file) {
  if (cache.has(file)) return cache.get(file);
  const result = {}; cache.set(file, result);
  new Function("require", "exports", ts.transpileModule(readFileSync(file, "utf8"), { compilerOptions: {
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true,
  } }).outputText)(id => id === "@pi-desktop/shared" ? shared : id === "@pi-desktop/courseware-runtime/node" ? runtime : id.startsWith(".") ? load(join(dirname(file), id + ".ts")) : require(id), result);
  return result;
}
const { readNativeTeachingPackage } = load(new URL("../electron/main/courseware-native-package.ts", import.meta.url).pathname);

test("real native PPTX supplies an immutable Host snapshot without an editable teaching project", {
  skip: !process.env.DECKWISE_NATIVE_REAL_FIXTURE || !process.env.DECKWISE_PPTX_WORKER, timeout: 120000,
}, async t => {
  const { Host, resolveHostBinary } = await import("../../../scripts/e2e/host.mjs");
  const root = await fs.mkdtemp(join(tmpdir(), "native-snapshot-real-")); t.after(() => fs.rm(root, { recursive: true, force: true }));
  const workspace = join(root, "workspace"), data = join(root, "profile");
  await fs.mkdir(workspace); await fs.mkdir(join(data, "plugins/market"), { recursive: true });
  await fs.writeFile(join(data, "plugins/market/catalog.json"), JSON.stringify({ schemaVersion: 2, providerId: "official", plugins: [] }));
  const inputPath = process.env.DECKWISE_NATIVE_EXPORTED_PPTX ?? join(process.env.DECKWISE_NATIVE_REAL_FIXTURE, "native.pptx");
  const bytes = await fs.readFile(inputPath), carrier = await readNativeTeachingPackage(bytes), sourceSha256 = createHash("sha256").update(bytes).digest("hex");
  assert(carrier); const path = join(workspace, "native.pptx"); await fs.writeFile(path, bytes);
  const host = new Host(resolveHostBinary(), data); t.after(() => host.stop()); await host.start();
  const { session } = await host.call("session.create", { title: "Native fixture", mode: "agent", projectPath: workspace });
  const { jobId } = await host.call("courseware.parseStart", { sessionId: session.id, path });
  for (let n = 0; ; n++) {
    const status = await host.call("courseware.parseStatus", { jobId });
    if (status.status !== "RUNNING") { assert.equal(status.status, "SUCCEEDED", status.message); break; }
    if (n > 900) assert.fail("Native parser timed out"); await new Promise(resolve => setTimeout(resolve, 100));
  }
  const assets = [];
  const used = new Set(carrier.pages.flatMap(page => page.actions.flatMap(action =>
    [action.audioAssetId, action.videoAssetId].filter(id => typeof id === "string"))));
  for (const media of carrier.media.filter(media => used.has(media.id))) {
    const path = join(workspace, media.sha256 + ".bin"); await fs.writeFile(path, Buffer.from(media.data, "base64"));
    assets.push({ asset: { id: media.id, sha256: media.sha256, mimeType: media.mimeType }, path });
  }
  const project = { schemaVersion: "deckwise-courseware/1", projectId: carrier.documentId, taskType: "plain", title: "Real native fixture",
    source: { revision: carrier.revision, sha256: sourceSha256 }, teachingRevision: carrier.revision, pages: carrier.pages };
  for (const page of project.pages) for (const action of page.actions) if (action.type === "native_animation") action.sourceSha256 = sourceSha256;
  const snapshotId = randomUUID();
  if (project.pages.some(page => page.actions.some(action => action.type === "video_clip"))) {
    const wrong = structuredClone(assets), video = wrong.find(a => a.asset.mimeType.startsWith("video/"));
    video.asset.mimeType = "audio/wav";
    await assert.rejects(host.call("courseware.snapshot.importNative", { sessionId: session.id, jobId, snapshotId: randomUUID(), project, identity: carrier.identity, assets: wrong }), /clip asset type changed/);
  }
  const result = await host.call("courseware.snapshot.importNative", { sessionId: session.id, jobId, snapshotId, project, identity: carrier.identity, assets });
  assert.equal(result.nativeTeaching, true); assert.equal(result.snapshot.assetIds.length, assets.length); assert.equal(result.project.pages.length, carrier.pages.length);
  const fixedPages = structuredClone(project.pages);
  for (const action of fixedPages.flatMap(page => page.actions)) {
    if (!["audio_clip", "video_clip"].includes(action.type)) continue;
    const field = action.type === "audio_clip" ? "audioAssetId" : "videoAssetId";
    const asset = carrier.media.find(asset => asset.id === action[field]);
    action[field] = (action.type === "audio_clip" ? "music-" : "video-") + asset.sha256;
    delete action.durationMs;
  }
  assert.deepEqual(result.project.pages, fixedPages);
  for (const stored of result.assets) {
    const bytes = await fs.readFile(stored.path); assert.equal(createHash("sha256").update(bytes).digest("hex"), stored.sha256);
  }
  if (process.env.DECKWISE_NATIVE_BUILD_DIRECTORY) {
    const { adaptCanonicalSnapshot, buildFixedCourseware, FixedBuildError } = await import("@pi-desktop/courseware-runtime/node");
    const converter = { version: "maic-pptx-import-ir/1", manifestSha256: createHash("sha256").update(await fs.readFile(join(process.env.DECKWISE_PPTX_WORKER, "../manifest.json"))).digest("hex") };
    const options = { workerDirectory: join(process.env.DECKWISE_PPTX_WORKER, ".."), outputDirectory: process.env.DECKWISE_NATIVE_BUILD_DIRECTORY };
    let input = adaptCanonicalSnapshot(result.project, result.snapshot, { sourcePath: result.sourcePath, mapping: result.mapping, assets: result.assets, converter, reviewedWarningCodes: [] }, { nativeTeaching: result.nativeTeaching });
    let built;
    try { built = await buildFixedCourseware(input, options); }
    catch (error) {
      if (!(error instanceof FixedBuildError) || error.code !== "CONTENT_REVIEW_REQUIRED") throw error;
      const codes = error.diagnostics.filter(d => d.severity === "warning").map(d => d.code);
      input = { ...input, reviewedWarningCodes: [...new Set(codes)] };
      built = await buildFixedCourseware(input, options);
    }
    assert.equal(built.report.ready, true);
    console.log("Native real fixed build", JSON.stringify({ buildId: built.buildId, directory: built.directory, report: built.report }));
  }
  await host.call("courseware.parseRelease", { jobId }); await host.stop(); await host.start();
  const reopened = await host.call("courseware.snapshot.get", { sessionId: session.id, projectId: project.projectId, snapshotId });
  assert.equal(reopened.nativeTeaching, true); assert.deepEqual(reopened.snapshot, result.snapshot);
  const read = await host.call("courseware.project.get", { sessionId: session.id, projectId: project.projectId });
  assert.equal(read.project, null);
});
