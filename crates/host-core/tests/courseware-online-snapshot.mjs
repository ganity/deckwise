/** Actual Host/parser import gate. Remote teaching/mapping and PCM are explicit local fixtures. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { Host } from "../../../scripts/e2e/host.mjs";
import { adaptCanonicalSnapshot } from "../../../packages/courseware-runtime/dist/node.mjs";

const [binary, output] = process.argv.slice(2);
assert(binary && output && isAbsolute(binary) && isAbsolute(output));
await fs.mkdir(output);
const source = await fs.readFile(new URL("../../../packages/courseware-runtime/tests/fixtures/office-lineage-b7/source.pptx", import.meta.url));
const hash = bytes => createHash("sha256").update(bytes).digest("hex"), sha256 = hash(source);
const root = await fs.mkdtemp(join(tmpdir(), "deckwise-online-snapshot-"));
const data = join(root, "data"), workspace = join(root, "workspace");
const saved = join(workspace, ".deckwise-ppt/revisions/local-untouched/r0001/document.pptx");
const online = join(workspace, "online-publication/download.pptx");
await fs.mkdir(join(saved, ".."), { recursive: true }); await fs.mkdir(join(online, ".."), { recursive: true });
await fs.mkdir(join(data, "plugins/market"), { recursive: true });
await fs.writeFile(join(data, "plugins/market/catalog.json"), JSON.stringify({ schemaVersion: 2, providerId: "official", plugins: [] }));
await fs.writeFile(saved, source); await fs.writeFile(online, source);
process.env.DECKWISE_PPTX_NODE = process.execPath;
process.env.DECKWISE_PPTX_WORKER = fileURLToPath(new URL("../../../packages/courseware-runtime/dist/pptx-worker.mjs", import.meta.url));
const pcm = Buffer.alloc(44 + 1600);
pcm.write("RIFF"); pcm.writeUInt32LE(pcm.length - 8, 4); pcm.write("WAVEfmt ", 8);
pcm.writeUInt32LE(16, 16); pcm.writeUInt16LE(1, 20); pcm.writeUInt16LE(1, 22);
pcm.writeUInt32LE(8000, 24); pcm.writeUInt32LE(16000, 28); pcm.writeUInt16LE(2, 32); pcm.writeUInt16LE(16, 34);
pcm.write("data", 36); pcm.writeUInt32LE(1600, 40);
const audio = join(workspace, "fixed-voice.wav"); await fs.writeFile(audio, pcm);
let host, sessionId, project, localBefore, params, frozen;
const report = { status: "RUNNING", binary, binarySha256: hash(await fs.readFile(binary)), checks: [], hostPids: [],
  sourceSha256: sha256, sourceByteLength: source.length, realHost: true, realParser: true,
  remotePlatformFixture: true, audioFixtureOnly: true, realElectron: false, paidCalls: false };
async function restart() {
  await host?.stop(); host = new Host(binary, data); await host.start(); report.hostPids.push(host.child.pid);
}
const call = (method, args) => host.call(method, args, 30_000);
async function parse(path) {
  const { jobId } = await call("courseware.parseStart", { sessionId, path });
  const deadline = Date.now() + 95_000;
  while (Date.now() < deadline) {
    const status = await call("courseware.parseStatus", { jobId });
    if (status.status !== "RUNNING") { assert.equal(status.status, "SUCCEEDED", JSON.stringify(status)); return { jobId, status }; }
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error("Parser did not finish");
}
async function step(name, fn) { await fn(); report.checks.push(name); console.log("PASS", name); }
const get = snapshotId => call("courseware.snapshot.get", { sessionId, projectId: project.projectId, snapshotId });
try {
  await step("Actual saved parser initializes a separate local canonical baseline", async () => {
    await restart(); sessionId = (await call("session.create", { projectPath: workspace })).session.id;
    await call("courseware.task.set", { sessionId, taskType: "plain" });
    const { jobId, status } = await parse(saved);
    let local = (await call("courseware.project.initializeGenerated", { sessionId, jobId, sourceSha256: sha256,
      title: "Local baseline", narrations: Array.from({ length: status.summary.pages }, (_, i) => `Good! Page ${i + 1}.`) })).project;
    for (const page of local.pages) local = (await call("courseware.teaching.confirm", { sessionId, projectId: local.projectId,
      pageId: page.pageId, expectedSourceRevision: local.source.revision, expectedTeachingRevision: local.teachingRevision })).project;
    localBefore = await call("courseware.project.context", { sessionId, projectId: local.projectId });
    await call("courseware.parseRelease", { jobId });
  });
  await step("A real parser job imports the pinned online source without an Office revision path", async () => {
    const { jobId } = await parse(online);
    await assert.rejects(call("courseware.project.openSaved", { sessionId, jobId }), /editor saved revision/u);
    project = { ...structuredClone(localBefore.project), projectId: "22222222-2222-4222-8222-222222222222",
      source: { revision: "33333333-3333-4333-8333-333333333333", sha256 }, teachingRevision: "remote-teaching-fixed-1" };
    for (const page of project.pages) for (const action of page.actions) if (action.type === "speech") action.audioAssetId = "voice-fixed";
    const mapping = { ...structuredClone(localBefore.mapping), revision: "remote-mapping-fixed-1", sourceRevision: project.source.revision };
    params = { sessionId, jobId, snapshotId: "online-fixed-1", sourceByteLength: source.length, project, mapping,
      assets: [{ asset: { id: "voice-fixed", sha256: hash(pcm), mimeType: "audio/wav" }, path: audio }] };
    frozen = await call("courseware.snapshot.importOnline", params);
    assert.deepEqual(await call("courseware.snapshot.importOnline", params), frozen);
    assert.deepEqual(frozen.project, project); assert.deepEqual(frozen.snapshot.source, project.source);
    assert.equal(frozen.snapshot.teachingRevision, project.teachingRevision); assert.equal(frozen.snapshot.mappingRevision, mapping.revision);
    const expectedMapping = structuredClone(mapping); delete expectedMapping.sourceRevision;
    assert.deepEqual(frozen.mapping, expectedMapping);
    assert.equal(hash(await fs.readFile(frozen.sourcePath)), sha256);
    assert.equal(hash(await fs.readFile(frozen.assets[0].path)), hash(pcm));
    assert.deepEqual(await call("courseware.project.context", { sessionId, projectId: localBefore.project.projectId }), localBefore);
    await assert.rejects(call("courseware.project.context", { sessionId, projectId: project.projectId }), /not found/u);
  });
  await step("Wrong length, stale mapping, missing audio, changed bytes and immutable replacement refuse", async () => {
    for (const [id, update] of [
      ["wrong-length", { sourceByteLength: source.length + 1 }],
      ["missing-audio", { assets: [] }],
      ["stale-source", { mapping: { ...params.mapping, sourceRevision: "stale" } }],
    ]) {
      await assert.rejects(call("courseware.snapshot.importOnline", { ...params, snapshotId: id, ...update }));
      await assert.rejects(get(id), /not found/u);
    }
    const wrongMapping = structuredClone(params.mapping); wrongMapping.pages[0].importPageId = "not-the-parsed-page";
    await assert.rejects(call("courseware.snapshot.importOnline", { ...params, snapshotId: "wrong-mapping", mapping: wrongMapping }));
    for (const id of ["music-local", "tts-local"]) {
      const reserved = structuredClone(params);
      reserved.snapshotId = `reserved-${id}`; reserved.assets[0].asset.id = id;
      for (const page of reserved.project.pages) for (const action of page.actions) if (action.type === "speech") action.audioAssetId = id;
      await assert.rejects(call("courseware.snapshot.importOnline", reserved), /Unsupported online snapshot asset provenance/u);
      await assert.rejects(get(reserved.snapshotId), /not found/u);
    }
    const changed = structuredClone(project); changed.pages[0].actions[0].text = "Changed remote text";
    await assert.rejects(call("courseware.snapshot.importOnline", { ...params, project: changed }), /different content/u);
    await fs.appendFile(online, "changed after parsing");
    await assert.rejects(call("courseware.snapshot.importOnline", { ...params, snapshotId: "changed-bytes" }), /changed after parsing/u);
    await fs.writeFile(online, source);
    assert.deepEqual(await get("online-fixed-1"), frozen);
  });
  await step("Builder adapter consumes the unchanged existing snapshot export", async () => {
    const input = adaptCanonicalSnapshot(frozen.project, frozen.snapshot, { sourcePath: frozen.sourcePath,
      mapping: frozen.mapping, assets: frozen.assets, converter: { version: "maic-pptx-import-ir/1", manifestSha256: "a".repeat(64) }, reviewedWarningCodes: [] });
    assert.equal(input.source.sha256, sha256); assert.equal(input.teaching.revision, project.teachingRevision);
    assert.deepEqual(input.mapping, frozen.mapping); assert.equal(input.assets.length, 1);
    report.snapshot = frozen.snapshot; report.mapping = frozen.mapping;
  });
  await step("Restart and later local/remote fixture edits cannot replace the archived online input", async () => {
    const local = localBefore.project;
    await call("courseware.teaching.write", { sessionId, write: { projectId: local.projectId, pageId: local.pages[0].pageId,
      expectedSourceRevision: local.source.revision, expectedTeachingRevision: local.teachingRevision,
      actions: [{ id: "later-local", type: "speech", text: "Later local draft" }] } });
    await call("courseware.parseRelease", { jobId: params.jobId });
    await fs.rm(online); await fs.rm(audio); project.pages[0].actions[0].text = "Later remote fixture";
    await restart(); assert.deepEqual(await get("online-fixed-1"), frozen);
    assert.equal(new Set(report.hostPids).size, report.hostPids.length);
    assert.equal((await call("courseware.project.context", { sessionId, projectId: local.projectId })).project.pages[0].actions[0].text, "Later local draft");
    await fs.writeFile(frozen.sourcePath, "tampered archive");
    await assert.rejects(get("online-fixed-1"), /archive bytes changed/u);
  });
  report.status = "PASS";
} catch (error) { report.status = "FAIL"; report.error = String(error.stack ?? error); throw error; }
finally {
  await host?.stop(); await fs.rm(root, { recursive: true, force: true });
  report.cleanedUp = true;
  await fs.writeFile(join(output, "report.json"), JSON.stringify(report, null, 2) + "\n");
}
