import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { promises as fs, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import ts from "typescript";
import * as shared from "@pi-desktop/shared";

const require = createRequire(import.meta.url);
const load = (path, dependencies = {}) => {
  const exports = {};
  new Function("require", "exports", ts.transpileModule(readFileSync(new URL(path, import.meta.url), "utf8"), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText)(id => Object.hasOwn(dependencies, id) ? dependencies[id] : require(id), exports);
  return exports;
};
const office = load("../electron/main/office-file.ts", { "@pi-desktop/shared": shared });
const { stageOnlineSourceFiles } = load("../electron/main/courseware-online-source-files.ts", { "./office-file": office });
const { importOnlineCoursewareSnapshot } = load("../electron/main/courseware-online-snapshot.ts", { "@pi-desktop/shared": shared });
const digest = bytes => createHash("sha256").update(bytes).digest("hex");
const deferred = () => { let resolve; const promise = new Promise(yes => { resolve = yes; }); return { promise, resolve }; };
const wav = () => { const bytes = Buffer.alloc(48); bytes.write("RIFF", 0); bytes.write("WAVE", 8); return bytes; };

async function fixture(t, options = {}) {
  const workspace = await fs.mkdtemp(join(tmpdir(), "online-snapshot-test-"));
  let files;
  t.after(async () => { try { await files?.dispose(); } finally { await fs.rm(workspace, { recursive: true, force: true }); } });
  const calls = [], assets = new Map(), jobs = new Map(), archived = new Map();
  const targetBytes = Buffer.from("PK[Content_Types].xmlppt/presentation.xmlarchived-target"), revision = randomUUID();
  const project = { schemaVersion: shared.COURSEWARE_CONTRACT_VERSION, projectId: randomUUID(), taskType: "plain", title: "Remote",
    source: { revision, sha256: digest(targetBytes) }, teachingRevision: randomUUID(),
    pages: [{ pageId: "page-1", actions: [], locked: false, reviewState: "ready" }] };
  if (!options.noAudio) {
    for (const [kind, bytes, mime] of [["speech", wav(), "audio/wav"], ["audio_clip", Buffer.from("ID3-existing-music"), "audio/mpeg"]]) {
      const assetId = randomUUID();
      assets.set(assetId, { bytes, reference: { projectId: project.projectId, assetRef: { assetId, sha256: digest(bytes), mime,
        byteLength: bytes.length, downloadPath: `/courseware/team/projects/${project.projectId}/assets/${assetId}/content` } } });
      project.pages[0].actions.push({ id: kind, type: kind, audioAssetId: assetId, ...(kind === "speech" ? { text: "Good!" } : {}) });
      if (kind === "speech") project.pages[0].actions.push({ id: "speech-repeat", type: kind, audioAssetId: assetId, text: "Good!" });
    }
  }
  const mapping = { revision: randomUUID(), sourceSha256: project.source.sha256,
    pages: [{ pageId: "page-1", importPageId: "slide-1", objects: [] }] };
  const review = { snapshotId: revision, sessionEpoch: 2, forceSaveRequestId: randomUUID(), callbackId: "b".repeat(64),
    sourceByteLength: targetBytes.length, baselineSourceRevision: randomUUID(), baselineTeachingRevision: randomUUID(),
    teaching: { project, mappingRevision: mapping.revision }, mapping };
  const canonicalProject = structuredClone(project);
  let allowed = true, currentHost;
  const host = { async call(method, params) {
    calls.push([method, structuredClone(params)]);
    if (options.hostCall) { const custom = await options.hostCall(method, params, { jobs, archived }); if (custom !== undefined) return custom; }
    if (method === "courseware.parseStart") {
      assert.equal(jobs.size, 0);
      const bytes = await fs.readFile(params.path), jobId = randomUUID(); jobs.set(jobId, { bytes }); return { jobId };
    }
    if (method === "courseware.parseStatus") return { status: "SUCCEEDED", summary: { sourceSha256: digest(jobs.get(params.jobId).bytes) } };
    if (method === "courseware.parseRelease") { jobs.delete(params.jobId); return { released: true }; }
    if (method === "courseware.snapshot.importOnline") {
      const bytes = jobs.get(params.jobId).bytes;
      assert.equal(bytes.length, params.sourceByteLength); assert.equal(digest(bytes), params.project.source.sha256);
      for (const { asset, path } of params.assets) {
        const input = await fs.readFile(path); assert.equal(digest(input), asset.sha256);
        assert.equal((await fs.stat(path)).mode & 0o777, 0o600);
        assert.equal((await fs.stat(dirname(path))).mode & 0o777, 0o700);
        archived.set(asset.id, Buffer.from(input));
      }
      assert.deepEqual(params.project, canonicalProject); assert.deepEqual(params.mapping, { ...mapping, sourceRevision: revision });
      return { snapshot: { snapshotId: params.snapshotId, projectId: project.projectId, source: project.source,
        teachingRevision: project.teachingRevision, mappingRevision: mapping.revision, assetIds: params.assets.map(entry => entry.asset.id).sort() },
        sourcePath: "private-host-archive", assets: params.assets, project };
    }
    throw new Error(`Unexpected Host write: ${method}`);
  } };
  currentHost = host;
  const signal = new AbortController(), current = () => { if (!allowed) throw new Error("owner changed"); };
  files = await stageOnlineSourceFiles({ workspace, sessionId: "chat-1", original: { source: { revision: review.baselineSourceRevision,
    sha256: digest(targetBytes) }, bytes: targetBytes }, target: { source: project.source, bytes: targetBytes },
    getHost: () => currentHost, assertCurrent: current });
  const media = {
    async getTeamAsset(projectId, assetId) {
      calls.push(["getTeamAsset", { projectId, assetId }]);
      const reference = structuredClone(assets.get(assetId).reference);
      return options.reference ? options.reference(reference) : reference;
    },
    async downloadTeamAsset(reference) {
      calls.push(["downloadTeamAsset", structuredClone(reference)]);
      const result = { reference: structuredClone(reference), bytes: Buffer.from(assets.get(reference.assetRef.assetId).bytes) };
      return options.download ? options.download(result) : result;
    },
  };
  const input = { workspace, sessionId: "chat-1", review,
    expected: { projectId: project.projectId, sessionEpoch: review.sessionEpoch, forceSaveRequestId: review.forceSaveRequestId,
      callbackId: review.callbackId, source: structuredClone(project.source), sourceByteLength: targetBytes.length },
    files, media, getHost: () => currentHost, assertCurrent: current, signal: signal.signal };
  return { workspace, calls, assets, jobs, archived, project, review, files, input, signal,
    revoke() { allowed = false; }, replaceHost() { currentHost = {}; } };
}

test("real private audio files and archived target parser import only an independent finite snapshot", async t => {
  const f = await fixture(t), before = structuredClone(f.review), live = join(f.workspace, "live.pptx");
  await fs.writeFile(live, "unchanged"); await fs.mkdir(join(f.workspace, "unrelated"));
  const snapshot = await importOnlineCoursewareSnapshot(f.input);
  assert.equal(snapshot.snapshotId, f.review.snapshotId); assert.equal(snapshot.source.revision, f.review.snapshotId);
  assert.deepEqual(snapshot.assetIds, [...f.assets.keys()].sort()); assert.deepEqual(f.review, before);
  assert.equal(f.calls.filter(([method]) => method === "getTeamAsset").length, 2, "shared audio references download once");
  assert.equal(f.archived.size, 2); assert.equal(f.jobs.size, 0);
  assert.deepEqual(Object.keys(snapshot).sort(), ["snapshotId", "projectId", "source", "teachingRevision", "mappingRevision", "assetIds"].sort());
  assert.equal(await fs.readFile(live, "utf8"), "unchanged");
  assert.equal((await fs.readdir(f.workspace)).some(name => name.startsWith(".deckwise-online-audio-")), false);
  await f.files.dispose(); assert.deepEqual((await fs.readdir(f.workspace)).sort(), ["live.pptx", "unrelated"]);
});

test("every epoch/callback/source/length/force-save mismatch is rejected before downloads or Host admission", async t => {
  for (const mutate of [i => { i.expected.projectId = randomUUID(); }, i => { i.expected.sessionEpoch++; },
    i => { i.expected.forceSaveRequestId = randomUUID(); }, i => { i.expected.callbackId = "c".repeat(64); },
    i => { i.expected.source.revision = randomUUID(); }, i => { i.expected.source.sha256 = "d".repeat(64); },
    i => { i.expected.sourceByteLength++; }, i => { i.review.teaching.mappingRevision = randomUUID(); },
    i => { i.review.mapping.pages[0].pageId = "wrong-page"; }, i => { i.review.teaching.project.pages[0].reviewState = "review"; },
    i => { i.review.teaching.project.pages[0].actions[0].audioAssetId = "tts-private"; },
    i => { i.review.teaching.project.pages[0].actions[0].audioUrl = "https://elsewhere/audio"; }]) {
    const f = await fixture(t); mutate(f.input);
    await assert.rejects(importOnlineCoursewareSnapshot(f.input), /SOURCE_INVALID/);
    assert.equal(f.calls.length, 0); await f.files.dispose();
  }
});

test("unauthorized metadata, bad bytes, MIME, and mismatched download tuple never reach Host import and clean written files", async t => {
  for (const options of [
    { reference: value => ({ ...value, projectId: randomUUID() }) },
    { reference: value => ({ ...value, assetRef: { ...value.assetRef, mime: "image/png" } }) },
    { reference: value => ({ ...value, assetRef: { ...value.assetRef, sha256: "0".repeat(64) } }) },
    { reference: value => ({ ...value, assetRef: { ...value.assetRef, byteLength: value.assetRef.byteLength + 1 } }) },
    { download: value => ({ ...value, bytes: Buffer.from("corrupt") }) },
    { download: value => ({ ...value, reference: { ...value.reference, projectId: randomUUID() } }) },
    { download: value => {
      if (value.reference.assetRef.mime === "audio/mpeg") value.bytes.fill(0);
      return value;
    } },
  ]) {
    const f = await fixture(t, options);
    await assert.rejects(importOnlineCoursewareSnapshot(f.input), /SOURCE_INVALID/);
    assert.equal(f.calls.some(([method]) => method === "courseware.snapshot.importOnline"), false);
    assert.equal((await fs.readdir(f.workspace)).some(name => name.startsWith(".deckwise-online-audio-")), false);
    await f.files.dispose();
  }
});

test("owner/Host changes or abort after audio await suppress parse/import and clean only owned audio files", async t => {
  for (const action of ["revoke", "replaceHost", "abort"]) {
    let f; f = await fixture(t, { download(value) { action === "abort" ? f.signal.abort() : f[action](); return value; } });
    await assert.rejects(importOnlineCoursewareSnapshot(f.input), /owner changed|CONTEXT_CHANGED|abort/i);
    assert.equal(f.calls.some(([method]) => method === "courseware.parseStart"), false);
    assert.equal((await fs.readdir(f.workspace)).some(name => name.startsWith(".deckwise-online-audio-")), false);
  }
});

test("one files context rejects concurrent imports, clones capture before await, and permits retry after completion", async t => {
  const entered = deferred(), completed = deferred(); let reads = 0;
  const f = await fixture(t, { async download(value) { if (!reads++) { entered.resolve(); await completed.promise; } return value; } });
  const pending = importOnlineCoursewareSnapshot(f.input); await entered.promise;
  await assert.rejects(importOnlineCoursewareSnapshot(f.input), /SOURCE_BUSY/);
  const title = f.project.title; f.review.teaching.project.title = "mutated later";
  completed.resolve(); assert.equal((await pending).snapshotId, f.review.snapshotId);
  f.project.title = title;
  assert.equal((await importOnlineCoursewareSnapshot(f.input)).snapshotId, f.review.snapshotId);
});

test("unresolved Host import retains private audio for a possible late reader and leaves live files untouched", async t => {
  const f = await fixture(t, { hostCall(method) { if (method === "courseware.snapshot.importOnline") throw new Error("reply lost"); } });
  await assert.rejects(importOnlineCoursewareSnapshot(f.input), /SOURCE_IMPORT_UNCERTAIN/);
  const imported = f.calls.find(([method]) => method === "courseware.snapshot.importOnline")[1];
  for (const { asset, path } of imported.assets) assert.equal(digest(await fs.readFile(path)), asset.sha256);
  assert.equal(f.jobs.size, 0);
});

test("a successful but mismatched Host snapshot is rejected and its temporary audio still cleans", async t => {
  const f = await fixture(t, { hostCall(method) {
    if (method === "courseware.snapshot.importOnline") return { snapshot: { snapshotId: "wrong" } };
  } });
  await assert.rejects(importOnlineCoursewareSnapshot(f.input), /SOURCE_INVALID/);
  assert.equal((await fs.readdir(f.workspace)).some(name => name.startsWith(".deckwise-online-audio-")), false);
  assert.equal(f.jobs.size, 0);
});

test("late import completion cannot return success after its owning account changed", async t => {
  let f;
  f = await fixture(t, { hostCall(method) { if (method === "courseware.snapshot.importOnline") f.revoke(); } });
  await assert.rejects(importOnlineCoursewareSnapshot(f.input), /owner changed/);
  assert.equal(f.archived.size, 2, "an accepted immutable import is not rolled back or written to live teaching");
  assert.equal(f.jobs.size, 0);
  assert.equal((await fs.readdir(f.workspace)).some(name => name.startsWith(".deckwise-online-audio-")), false);
});

test("confirmed projects without speech/audio import without any team request or audio directory", async t => {
  const f = await fixture(t, { noAudio: true });
  assert.deepEqual((await importOnlineCoursewareSnapshot(f.input)).assetIds, []);
  assert.equal(f.calls.some(([method]) => method.includes("TeamAsset")), false);
  assert.equal((await fs.readdir(f.workspace)).some(name => name.startsWith(".deckwise-online-audio-")), false);
});
