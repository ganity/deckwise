/** Actual Host/parser request journal and optional --audio archive/adoption. No provider calls. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { Host } from "./e2e/host.mjs";

const [worker, source, out] = process.argv.slice(2);
const withAudio = process.argv.includes("--audio");
const binary = process.env.PI_DESKTOP_HOST_BIN;
assert([worker, source, out, binary].every((path) => path && isAbsolute(path)), "Supply absolute worker, PPTX, new evidence directory and PI_DESKTOP_HOST_BIN");
await mkdir(out);
const temp = await mkdtemp(join(tmpdir(), "deckwise-tts-journal-"));
const data = join(temp, "data");
const workspace = join(temp, "中文课件");
const other = join(temp, "other");
const archive = join(workspace, ".deckwise-ppt/revisions/tts-e2e/r0001/document.pptx");
await mkdir(join(data, "plugins/market"), { recursive: true });
await writeFile(join(data, "plugins/market/catalog.json"), JSON.stringify({ schemaVersion: 2, providerId: "official", plugins: [] }));
await mkdir(other);
await mkdir(join(archive, ".."), { recursive: true });
await copyFile(source, archive);
process.env.PI_DESKTOP_PLUGIN_MARKET_URL = "http://127.0.0.1:9/catalog.json";
process.env.DECKWISE_PPTX_NODE = process.execPath;
process.env.DECKWISE_PPTX_WORKER = worker;
const host = new Host(binary, data);
const digest = async (path) => createHash("sha256").update(await readFile(path)).digest("hex");
const report = { status: "RUNNING", checks: [], temp, binaryHash: await digest(binary), workerHash: await digest(worker), sourceHash: await digest(source), paidCalls: false, mediaNetworkCalls: false, audioReady: false };
const logs = [];
let sessionId, otherSessionId, project, selection, prepared, unknown, submitted;
const scope = () => ({ sessionId, projectId: selection.projectId, principalKey: selection.principalKey, intentId: selection.intentId });
const get = () => host.call("courseware.tts.get", scope());
const prepare = (value = selection) => host.call("courseware.tts.prepare", { sessionId, selection: value });
const begin = () => host.call("courseware.tts.begin", scope());
const bind = (taskRef) => host.call("courseware.tts.bind", { ...scope(), taskRef });
const list = () => host.call("courseware.tts.list", { sessionId, projectId: selection.projectId, principalKey: selection.principalKey });
async function stop() { logs.push(host.stderr); await host.stop(); }
async function step(name, run) { console.log("START", name); await run(); report.checks.push(name); console.log("PASS", name); }
async function writeTeaching(text) {
  project = (await host.call("courseware.teaching.write", { sessionId, write: {
    projectId: project.projectId, pageId: project.pages[0].pageId,
    expectedSourceRevision: project.source.revision, expectedTeachingRevision: project.teachingRevision,
    actions: [{ id: "speech-1", type: "speech", text }],
  } })).project;
}
try {
  await step("Real parser and stored speech determine the exact paid-request intent", async () => {
    await host.start();
    sessionId = (await host.call("session.create", { projectPath: workspace })).session.id;
    otherSessionId = (await host.call("session.create", { projectPath: other })).session.id;
    const job = await host.call("courseware.parseStart", { sessionId, path: archive });
    const deadline = Date.now() + 95_000;
    let parsed;
    do {
      parsed = await host.call("courseware.parseStatus", { jobId: job.jobId });
      if (parsed.status !== "RUNNING") break;
      await delay(20);
    } while (Date.now() < deadline);
    assert.equal(parsed.status, "SUCCEEDED", JSON.stringify(parsed));
    project = (await host.call("courseware.project.openSaved", { sessionId, jobId: job.jobId })).project;
    await writeTeaching("Good! 小朋友😀");
    selection = { intentId: "intent-1", principalKey: "a".repeat(64), projectId: project.projectId,
      pageId: project.pages[0].pageId, actionId: "speech-1", expectedSourceRevision: project.source.revision,
      expectedTeachingRevision: project.teachingRevision, model: "courseware-tts-v1", voice: "teacher_1" };
    prepared = await prepare();
    assert.equal(prepared.intent.request.input, "Good! 小朋友😀");
    assert.equal(prepared.intent.requestHash, "1614bc16420a22f45df72e5e934e4a28822ae067d8a7dbc2c9b64b6cf2ae6a27");
    assert.equal(prepared.intent.phase, "prepared");
    assert.equal(prepared.current, true); assert.equal(prepared.audioReady, false);
    assert.deepEqual(await prepare(), prepared);
    await host.call("courseware.parseRelease", { jobId: job.jobId });
    await stop();
  });
  await step("Restart preserves the key; forged text, account and workspace cannot borrow it", async () => {
    await host.start(); assert.deepEqual(await get(), prepared);
    await assert.rejects(prepare({ ...selection, input: "forged" }), /unknown field/);
    await assert.rejects(host.call("courseware.tts.prepare", { sessionId, selection, workspace: other }), /unknown field/);
    await assert.rejects(host.call("courseware.tts.get", { ...scope(), principalKey: "b".repeat(64) }), /not found/);
    await assert.rejects(host.call("courseware.tts.get", { ...scope(), sessionId: otherSessionId }), /not found/);
    assert.deepEqual((await list()).intents.map((value) => value.idempotencyKey), [prepared.intent.idempotencyKey]);
    assert.equal("request" in (await list()).intents[0], false);
    unknown = await begin(); assert.equal(unknown.intent.phase, "submission-unknown");
    assert.equal(unknown.intent.idempotencyKey, prepared.intent.idempotencyKey);
    host.child.kill("SIGKILL");
    assert.equal((await host.exitPromise).signal, "SIGKILL");
    await stop();
  });
  await step("Abrupt process death preserves unknown submission without creating a new key", async () => {
    await host.start(); assert.deepEqual(await get(), unknown);
    assert.deepEqual(await prepare(), unknown);
    assert.deepEqual(await begin(), unknown);
    const taskRef = { taskId: "fixture-remote-task", idempotencyKey: unknown.intent.idempotencyKey, requestHash: unknown.intent.requestHash };
    await assert.rejects(bind({ ...taskRef, requestHash: "f".repeat(64) }), /differs/);
    await writeTeaching("Edited after dispatch");
    const revision = project.teachingRevision;
    assert.equal((await get()).current, false);
    await assert.rejects(begin(), /stale/);
    assert.equal((await prepare()).current, false);
    submitted = await bind(taskRef);
    assert.equal(submitted.intent.phase, "submitted"); assert.equal(submitted.current, false);
    assert.equal(submitted.audioReady, false);
    assert.deepEqual(await bind(taskRef), submitted);
    await assert.rejects(bind({ ...taskRef, taskId: "different-task" }), /different task/);
    const stored = await host.call("courseware.project.get", { sessionId, projectId: project.projectId });
    assert.equal(stored.project.teachingRevision, revision);
    assert.equal(stored.project.pages[0].actions[0].text, "Edited after dispatch");
    assert.equal(stored.project.pages[0].actions[0].audioAssetId, undefined);
    await stop();
  });
  await step("Retained receipt survives restart; only an explicit new intent gets a new key", async () => {
    await host.start(); assert.deepEqual(await get(), submitted);
    const next = await prepare({ ...selection, intentId: "explicit-regeneration", expectedTeachingRevision: project.teachingRevision });
    assert.notEqual(next.intent.idempotencyKey, submitted.intent.idempotencyKey);
    assert.equal(next.intent.request.input, "Edited after dispatch");
    assert.equal(next.intent.phase, "prepared");
    assert.equal((await list()).intents.length, 2);
    assert.equal(await digest(archive), report.sourceHash);
    await writeFile(join(out, "retained-intents.json"), JSON.stringify(await list(), null, 2));
  });
  if (withAudio) {
    let staged, adoption, audioScope;
    const wav = Buffer.alloc(1644);
    wav.write("RIFF"); wav.writeUInt32LE(1636, 4); wav.write("WAVEfmt ", 8);
    wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
    wav.writeUInt32LE(8000, 24); wav.writeUInt32LE(16000, 28);
    wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write("data", 36); wav.writeUInt32LE(1600, 40);
    const hash = createHash("sha256").update(wav).digest("hex");
    await step("Verified audio archives separately; changed speech refuses stale adoption", async () => {
      const taskRef = submitted.intent.taskRef;
      const audio = { taskRef, sha256: hash, mimeType: "audio/wav", byteLength: wav.length, durationMs: 100 };
      const stale = await host.call("courseware.tts.audio.stage", { ...scope(), audio, bytesBase64: wav.toString("base64") });
      assert.equal(stale.audioReady, false);
      await assert.rejects(host.call("courseware.tts.audio.adopt", { ...scope(), expectedTeachingRevision: project.teachingRevision, expectedAudioAssetId: null }), /speech changed/);
      const ready = await prepare({ ...selection, intentId: "audio-explicit", expectedTeachingRevision: project.teachingRevision });
      audioScope = { ...scope(), intentId: "audio-explicit" };
      await host.call("courseware.tts.begin", audioScope);
      const freshTask = { taskId: "fixture-audio-task", idempotencyKey: ready.intent.idempotencyKey, requestHash: ready.intent.requestHash };
      await host.call("courseware.tts.bind", { ...audioScope, taskRef: freshTask });
      const before = structuredClone(project);
      staged = await host.call("courseware.tts.audio.stage", { ...audioScope, audio: { ...audio, taskRef: freshTask }, bytesBase64: wav.toString("base64") });
      assert.equal(await digest(staged.path), hash);
      assert.deepEqual((await host.call("courseware.project.get", { sessionId, projectId: project.projectId })).project, before);
      host.child.kill("SIGKILL"); assert.equal((await host.exitPromise).signal, "SIGKILL"); await stop();
    });
    await step("SIGKILL recovery adopts once, preserves source, and refuses corrupted archives", async () => {
      await host.start();
      assert.deepEqual(await host.call("courseware.tts.audio.get", audioScope), staged);
      const params = { ...audioScope, expectedTeachingRevision: project.teachingRevision, expectedAudioAssetId: null };
      adoption = await host.call("courseware.tts.audio.adopt", params);
      const expected = structuredClone(project);
      expected.teachingRevision = adoption.project.teachingRevision;
      expected.pages[0].reviewState = "review";
      expected.pages[0].actions[0].audioAssetId = `tts-${hash}`;
      assert.deepEqual(adoption.project, expected);
      assert.equal(adoption.audioReady, false); assert.equal(await digest(archive), report.sourceHash);
      await stop(); await host.start();
      assert.deepEqual(await host.call("courseware.tts.audio.adopt", params), adoption);
      await writeFile(staged.path, "corrupted");
      await assert.rejects(host.call("courseware.tts.audio.get", audioScope), /bytes differ/);
      await assert.rejects(host.call("courseware.tts.audio.adopt", params), /bytes differ/);
      assert.deepEqual((await host.call("courseware.project.get", { sessionId, projectId: project.projectId })).project, adoption.project);
      await writeFile(join(out, "audio-adoption.json"), JSON.stringify({ asset: staged.asset, audio: staged.audio, project: adoption.project, syntheticPcm: true, decoderVerified: false, audioReady: false }, null, 2));
    });
  }
  report.status = withAudio ? "PASS_HOST_TTS_ARCHIVE_ADOPTION_ONLY" : "PASS_HOST_TTS_JOURNAL_ONLY";
} catch (error) {
  report.status = "FAIL"; report.error = error.stack; process.exitCode = 1;
} finally {
  await stop().catch((error) => { report.stopError = String(error); process.exitCode = 1; });
  await writeFile(join(out, "report.json"), JSON.stringify(report, null, 2));
  await writeFile(join(out, "host.log"), logs.join(""));
}
