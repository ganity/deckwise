/** Actual Host/parser snapshot gate. Local PCM fixture verifies storage, not TTS quality. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { createInterface } from "node:readline";
import { setTimeout as delay } from "node:timers/promises";

const [worker, source, out] = process.argv.slice(2);
const hostBin = process.env.PI_DESKTOP_HOST_BIN;
assert([worker, source, out, hostBin].every((path) => path && isAbsolute(path)), "Supply absolute worker, PPTX, new evidence directory and PI_DESKTOP_HOST_BIN");
await mkdir(out);
const temp = await mkdtemp(join(tmpdir(), "deckwise-snapshots-"));
const data = join(temp, "data");
const workspace = join(temp, "workspace");
const other = join(temp, "other");
const archive = join(workspace, ".deckwise-ppt/revisions/snapshot-e2e/r0001/document.pptx");
await mkdir(join(data, "plugins/market"), { recursive: true });
await writeFile(join(data, "plugins/market/catalog.json"), JSON.stringify({ schemaVersion: 2, providerId: "official", plugins: [] }));
await mkdir(other);
await mkdir(join(archive, ".."), { recursive: true });
await copyFile(source, archive);
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const sourceHash = hash(await readFile(source));
const pcm = Buffer.alloc(44 + 1600);
pcm.write("RIFF"); pcm.writeUInt32LE(pcm.length - 8, 4); pcm.write("WAVEfmt ", 8);
pcm.writeUInt32LE(16, 16); pcm.writeUInt16LE(1, 20); pcm.writeUInt16LE(1, 22);
pcm.writeUInt32LE(8000, 24); pcm.writeUInt32LE(16000, 28); pcm.writeUInt16LE(2, 32);
pcm.writeUInt16LE(16, 34); pcm.write("data", 36); pcm.writeUInt32LE(1600, 40);
const audioPath = join(workspace, "voice.wav");
await writeFile(audioPath, pcm);
const audioHash = hash(pcm);
const asset = { id: "voice-1", sha256: audioHash, mimeType: "audio/wav" };
const report = { status: "RUNNING", checks: [], temp, sourceHash, audioHash, audioFixtureOnly: true, paidCalls: false, electronUi: false };
let host, sessionId, otherSessionId, project, jobId, frozen;
let sequence = 0;
const logs = [];
async function start() {
  const child = spawn(hostBin, [], { stdio: ["pipe", "pipe", "pipe"], env: {
    PATH: process.env.PATH, LANG: "C.UTF-8", PI_DESKTOP_DATA_DIR: data,
    PI_DESKTOP_PLUGIN_MARKET_URL: "http://127.0.0.1:9/catalog.json",
    DECKWISE_PPTX_NODE: process.execPath, DECKWISE_PPTX_WORKER: worker,
  } });
  const pending = new Map();
  const exited = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => {
      for (const waiter of pending.values()) { clearTimeout(waiter.timer); waiter.reject(new Error(`Host exited ${code}`)); }
      pending.clear(); resolve(code);
    });
  });
  child.stderr.on("data", (bytes) => logs.push(String(bytes)));
  createInterface({ input: child.stdout }).on("line", (line) => {
    const response = JSON.parse(line); const waiter = pending.get(response.id);
    if (!waiter) return;
    pending.delete(response.id); clearTimeout(waiter.timer);
    if (response.error) waiter.reject(new Error(JSON.stringify(response.error))); else waiter.resolve(response.result);
  });
  host = { child, exited, call(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = ++sequence;
      const timer = setTimeout(() => { pending.delete(id); reject(new Error(`RPC timeout: ${method}`)); }, 100_000);
      pending.set(id, { resolve, reject, timer });
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  } };
  await host.call("app.handshake", { protocolVersion: 11 });
}
async function stop() {
  if (!host) return;
  const current = host; host = undefined; current.child.stdin.end();
  const timer = setTimeout(() => current.child.kill("SIGKILL"), 10_000);
  try { assert.equal(await current.exited, 0); } finally { clearTimeout(timer); }
}
async function parse() {
  const job = await host.call("courseware.parseStart", { sessionId, path: archive });
  const deadline = Date.now() + 95_000;
  while (Date.now() < deadline) {
    const result = await host.call("courseware.parseStatus", { jobId: job.jobId });
    if (result.status !== "RUNNING") { assert.equal(result.status, "SUCCEEDED", JSON.stringify(result)); return job.jobId; }
    await delay(20);
  }
  throw new Error("Parser did not finish");
}
async function step(name, run) { console.log("START", name); await run(); report.checks.push(name); console.log("PASS", name); }
const capture = (extra = {}) => host.call("courseware.snapshot.capture", { sessionId, jobId, snapshotId: "snapshot-1",
  expectedSourceRevision: project.source.revision, expectedTeachingRevision: project.teachingRevision,
  assets: [{ asset, path: audioPath }], ...extra });
const get = (extra = {}) => host.call("courseware.snapshot.get", { sessionId, projectId: project.projectId, snapshotId: "snapshot-1", ...extra });
try {
  await step("Real parser binds saved source; unconfirmed teaching cannot be snapshotted", async () => {
    await start();
    sessionId = (await host.call("session.create", { projectPath: workspace })).session.id;
    otherSessionId = (await host.call("session.create", { projectPath: other })).session.id;
    jobId = await parse();
    project = (await host.call("courseware.project.openSaved", { sessionId, jobId })).project;
    project = (await host.call("courseware.teaching.write", { sessionId, write: {
      projectId: project.projectId, pageId: project.pages[0].pageId,
      expectedSourceRevision: project.source.revision, expectedTeachingRevision: project.teachingRevision,
      actions: [{ id: "speech-1", type: "speech", text: "Good!", audioAssetId: asset.id }],
    } })).project;
    await assert.rejects(capture(), /confirm every/);
    await assert.rejects(get(), /not found/);
  });
  await step("Explicit per-page confirmation fences stale and forged requests; audio remains mandatory", async () => {
    for (const page of project.pages) {
      const params = { sessionId, projectId: project.projectId, pageId: page.pageId,
        expectedSourceRevision: project.source.revision, expectedTeachingRevision: project.teachingRevision };
      await assert.rejects(host.call("courseware.teaching.confirm", { ...params, workspace }), /1002/);
      project = (await host.call("courseware.teaching.confirm", params)).project;
      await assert.rejects(host.call("courseware.teaching.confirm", params), /revisions changed/);
    }
    await assert.rejects(capture({ assets: [] }), /fixed audio/);
    await assert.rejects(capture({ assets: [{ asset: { ...asset, sha256: "0".repeat(64) }, path: audioPath }] }), /bytes differ/);
    await assert.rejects(capture({ assets: [{ asset, path: source }] }), /allowed root/);
  });
  await step("Capture freezes canonical refs, complete mapping, exact PPTX and audio bytes", async () => {
    frozen = await capture();
    assert.deepEqual(await capture(), frozen);
    assert.equal(frozen.snapshot.source.sha256, sourceHash);
    assert.equal(frozen.mapping.revision, frozen.snapshot.mappingRevision);
    assert.deepEqual(frozen.mapping.pages.map((page) => page.pageId), project.pages.map((page) => page.pageId));
    assert.deepEqual(frozen.snapshot.assetIds, [asset.id]);
    assert.equal(hash(await readFile(frozen.sourcePath)), sourceHash);
    assert.equal(hash(await readFile(frozen.assets[0].path)), audioHash);
    assert.notEqual(frozen.sourcePath, archive); assert.notEqual(frozen.assets[0].path, audioPath);
    await writeFile(join(out, "fixed-export.json"), JSON.stringify(frozen, null, 2));
    await assert.rejects(get({ sessionId: otherSessionId }), /not found/);
    await assert.rejects(capture({ sessionId: otherSessionId }), /another workspace/);
    await assert.rejects(capture({ workspace }), /1002/);
    await host.call("courseware.parseRelease", { jobId }); jobId = undefined;
    await stop();
  });
  await step("Full Host restart and later live teaching/source/audio edits do not alter the snapshot", async () => {
    await start(); assert.deepEqual(await get(), frozen);
    if (process.env.DECKWISE_E2E_CHAT_RESOLUTION === "1") {
      jobId = await parse();
      await host.call("session.configure", { id: sessionId, mode: "agent", permissionMode: "auto" });
      const response = await host.call("tools.execute", { sessionId, turnId: "compound-turn", toolCallId: "declare", toolName: "ppt_record_change_plan", mode: "agent",
        args: { baseline: { projectId: hash(Buffer.from(workspace)), documentId: project.projectId.slice("office-".length), sessionId: "snapshot-native",
          editGeneration: 1, coursewareProjectId: project.projectId, pageId: project.pages[0].pageId,
          sourceRevision: project.source.revision, sourceSha256: project.source.sha256,
          teachingRevision: project.teachingRevision, contentSha256: "a".repeat(64) }, pageNumber: 1,
          changes: [{ label: "Rewrite narration", toolName: "ppt_propose_page_narration" }] } });
      assert(response.ok, JSON.stringify(response));
      await assert.rejects(capture({ snapshotId: "blocked-by-chat" }), /unresolved Chat/);
      assert.deepEqual(await get(), frozen);
      const read = () => host.call("courseware.project.context", { sessionId, projectId: project.projectId });
      const change = (await read()).chatChanges.find(c => c.changeGroupId === response.content.changeGroupId);
      const close = { sessionId, projectId: project.projectId, pageId: project.pages[0].pageId,
        expectedSourceRevision: project.source.revision, expectedTeachingRevision: project.teachingRevision,
        resolution: { changeGroupId: change.changeGroupId, receiptSha256: change.receiptSha256, note: "Reviewed saved content; cancel remaining narration request." } };
      await assert.rejects(host.call("courseware.teaching.confirm", { ...close, resolution: { ...close.resolution, receiptSha256: "b".repeat(64) } }), /receipt or resolution changed/);
      const before = structuredClone(project);
      project = (await host.call("courseware.teaching.confirm", close)).project;
      assert.deepEqual(project.pages.map(p => p.actions), before.pages.map(p => p.actions));
      const after = await capture({ snapshotId: "after-resolution" });
      assert.equal(after.snapshot.teachingRevision, project.teachingRevision);
      await writeFile(join(out, "chat-resolution.json"), JSON.stringify({ before, after: project, context: await read(), oldSnapshotUnchanged: await get() }, null, 2));
      await host.call("courseware.parseRelease", { jobId }); jobId = undefined;
      report.checks.push("Actual Host/parser rejects unresolved declared Chat snapshots, retains the old snapshot and allows a new reviewed version");
    }
    project = (await host.call("courseware.teaching.write", { sessionId, write: {
      projectId: project.projectId, pageId: project.pages[0].pageId,
      expectedSourceRevision: project.source.revision, expectedTeachingRevision: project.teachingRevision,
      actions: [{ id: "speech-1", type: "speech", text: "Edited later" }],
    } })).project;
    assert.equal(project.pages[0].reviewState, "review");
    await writeFile(archive, "changed saved source"); await writeFile(audioPath, "changed audio");
    assert.deepEqual(await get(), frozen);
    await stop(); await start(); assert.deepEqual(await get(), frozen);
  });
  await step("Corrupt archived source or audio rejects retrieval without falling back to live files", async () => {
    const sourceBytes = await readFile(frozen.sourcePath);
    const audioBytes = await readFile(frozen.assets[0].path);
    await writeFile(frozen.sourcePath, "corrupt source");
    await assert.rejects(get(), /archive bytes changed/);
    await writeFile(frozen.sourcePath, sourceBytes);
    await writeFile(frozen.assets[0].path, "corrupt audio");
    await assert.rejects(get(), /audio asset bytes differ/);
    await writeFile(frozen.assets[0].path, audioBytes);
    assert.deepEqual(await get(), frozen);
  });
  report.status = "PASS_HOST_SNAPSHOTS_ONLY";
} catch (error) {
  report.status = "FAIL"; report.error = error.stack; process.exitCode = 1;
} finally {
  await stop().catch((error) => { report.stopError = String(error); process.exitCode = 1; });
  await writeFile(join(out, "report.json"), JSON.stringify(report, null, 2));
  await writeFile(join(out, "host.log"), logs.join(""));
}
