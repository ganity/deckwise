import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import test from "node:test";
import ts from "typescript";
import * as shared from "../../../packages/shared/dist/index.js";
const require = createRequire(import.meta.url), exports = {};
const source = await readFile(new URL("../electron/main/courseware-online-audio.ts", import.meta.url), "utf8");
new Function("require", "exports", ts.transpileModule(source, { compilerOptions: {
  target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS,
} }).outputText)(name => name.startsWith("node:") ? require(name) : name === "@pi-desktop/shared" ? shared : assert.fail(name), exports);
const { adoptCoursewareOnlineAudio, preflightCoursewareOnlineAudio } = exports;
const teamProjectId = "11111111-1111-4111-8111-111111111111";
const taskId = "22222222-2222-4222-8222-222222222222", musicTaskId = "33333333-3333-4333-8333-333333333333";
const assetId = "44444444-4444-4444-8444-444444444444", musicAssetId = "55555555-5555-4555-8555-555555555555";
const sha = bytes => createHash("sha256").update(bytes).digest("hex");
function fixture() {
  const bytes = Buffer.from("RIFF-archived-TTS-immutable"), musicBytes = Buffer.from("ID3-archived-export-only");
  const speechId = `tts-${sha(bytes)}`, clipId = `music-${sha(musicBytes)}`;
  const project = { schemaVersion: "deckwise-courseware/1", projectId: "local-project", taskType: "import", title: "Lesson",
    source: { revision: "source-1", sha256: "f".repeat(64) }, teachingRevision: "teaching-1", pages: [
      { pageId: "page-1", locked: false, reviewState: "ready", actions: [
        { id: "speech-1", type: "speech", text: "Good!", audioAssetId: speechId, pauseAfterMs: 200 },
        { id: "clip-1", type: "audio_clip", audioAssetId: clipId },
        { id: "cue-1", type: "highlight", target: { objectId: "object-1" } },
      ] }, { pageId: "page-2", locked: false, reviewState: "ready", actions: [
        { id: "clip-2", type: "audio_clip", audioAssetId: clipId }, { id: "wait-1", type: "teacher_continue" },
      ] },
    ] };
  assert(shared.isCoursewareProject(project));
  const ref = { taskId, idempotencyKey: "tts-key", requestHash: "a".repeat(64) };
  const musicRef = { taskId: musicTaskId, idempotencyKey: "export-key", requestHash: "b".repeat(64) };
  const selection = { intentId: "tts-intent", principalKey: "c".repeat(64), projectId: project.projectId, pageId: "page-1", actionId: "speech-1", expectedSourceRevision: "source-1" };
  const journal = { intent: { phase: "submitted", selection, request: { kind: "tts", input: "Good!" }, sourceSha256: project.source.sha256, taskRef: ref } };
  const saved = { asset: { id: speechId, sha256: sha(bytes), mimeType: "audio/wav" },
    audio: { taskRef: ref, sha256: sha(bytes), mimeType: "audio/wav", byteLength: bytes.length, durationMs: 100 },
    adoptedTeachingRevision: "teaching-adopted", boundSource: structuredClone(project.source) };
  const musicJournal = { intent: { intentId: "music-export", phase: "submitted", request: { kind: "music-export" }, taskRef: musicRef,
    asset: { taskRef: musicRef, sha256: sha(musicBytes), mimeType: "audio/mpeg", byteLength: musicBytes.length } } };
  const musicSnapshot = { assets: [{ asset: { id: clipId, sha256: sha(musicBytes), mimeType: "audio/mpeg" }, music: { principalKey: selection.principalKey, intentId: "music-export" } }] };
  const task = { ...ref, kind: "tts", state: "ready", feeState: "settled", assetRef: { assetId, sha256: sha(bytes), mime: "audio/wav", byteLength: bytes.length } };
  const musicTask = { ...musicRef, kind: "music-export", state: "ready", feeState: "settled", assetRef: { assetId: musicAssetId, sha256: sha(musicBytes), mime: "audio/mpeg", byteLength: musicBytes.length } };
  const team = task => ({ projectId: teamProjectId, assetRef: { ...task.assetRef, downloadPath: `/courseware/team/projects/${teamProjectId}/assets/${task.assetRef.assetId}/content` } });
  let intercept = async () => {}, current = true;
  const calls = [], live = structuredClone(project);
  const host = { async call(method, params) {
    calls.push([method, structuredClone(params)]); await intercept(method);
    if (method === "courseware.project.get") return { project: structuredClone(live) };
    if (method === "courseware.tts.list") return { intents: [{ selection, phase: "submitted" }] };
    if (method === "courseware.tts.get") return structuredClone(journal);
    if (method === "courseware.tts.audio.get") return structuredClone(saved);
    if (method === "courseware.mediaCanvas.music.snapshotAssets") return structuredClone(musicSnapshot);
    if (method === "courseware.mediaCanvas.music.get") return structuredClone(musicJournal);
    assert.fail(method);
  } };
  const sharedAssets = new Map();
  const media = {
    async getTeamAsset(projectId, id) {
      assert.equal(projectId, teamProjectId); calls.push(["team.GET", id]); await intercept("team.GET");
      if (!sharedAssets.has(id)) throw new Error("COURSEWARE_MEDIA_PLATFORM_46901");
      return structuredClone(sharedAssets.get(id));
    },
    async get(ref) { calls.push(["task.GET", structuredClone(ref)]); await intercept("task.GET"); return structuredClone(task); },
    music: { async get(ref, kind) { assert.equal(kind, "music-export"); calls.push(["music.GET", structuredClone(ref)]); await intercept("music.GET"); return structuredClone(musicTask); } },
    async adoptTeamAsset(projectId, ref) {
      assert.equal(projectId, teamProjectId); calls.push(["adopt.POST", structuredClone(ref)]); await intercept("adopt.POST");
      const reference = team(ref.taskId === taskId ? task : musicTask);
      sharedAssets.set(reference.assetRef.assetId, structuredClone(reference)); return reference;
    },
    async downloadTeamAsset(reference) {
      calls.push(["content.GET", structuredClone(reference)]); await intercept("content.GET");
      return { reference: structuredClone(reference), bytes: reference.assetRef.assetId === assetId ? Buffer.from(bytes) : Buffer.from(musicBytes) };
    },
  };
  const input = { sessionId: "chat-1", project, teamProjectId, host, media,
    principal: { key: selection.principalKey, assertCurrent() { if (!current) throw new Error("AUTH_CHANGED"); } } };
  return { input, project, live, journal, saved, musicJournal, musicSnapshot, task, musicTask, calls, bytes, musicBytes, sharedAssets, team,
    intercept(value) { intercept = value; }, expire() { current = false; } };
}
const posts = f => f.calls.filter(([method]) => method === "adopt.POST");

test("real Host receipt shapes transfer adopted TTS and deduped exported clips to team UUIDs without mutating local teaching", async () => {
  const f = fixture(), original = structuredClone(f.project), result = await adoptCoursewareOnlineAudio(f.input);
  assert.equal(posts(f).length, 2);
  assert.deepEqual(f.calls.filter(([method]) => /task.GET|music.GET/.test(method)).map(([method]) => method), ["task.GET", "music.GET"]);
  assert(f.calls.findIndex(([method]) => method === "music.GET") < f.calls.findIndex(([method]) => method === "adopt.POST"));
  assert.equal(result.project.pages[0].actions[0].audioAssetId, assetId);
  assert.equal(result.project.pages[0].actions[1].audioAssetId, musicAssetId);
  assert.equal(result.project.pages[1].actions[0].audioAssetId, musicAssetId);
  assert.deepEqual(result.project.pages[0].actions[2], original.pages[0].actions[2]);
  assert.deepEqual(result.project.source, original.source); assert.deepEqual(f.project, original);
  assert.equal(result.project.pages[0].actions[0].text, "Good!");
  assert.deepEqual(result.assets.map(value => value.bytes), [f.bytes, f.musicBytes]);
  assert(!f.calls.some(([method]) => /stage|capture|submit|begin|write/.test(method)));
  result.assets[0].bytes[0] = 0; assert.notEqual(f.bytes[0], 0);
});

for (const [name, mutate] of [
  ["changed local teaching", f => { f.live.teachingRevision = "changed"; }],
  ["changed speech text", f => { f.journal.intent.request.input = "different"; }],
  ["foreign receipt principal", f => { f.journal.intent.selection.principalKey = "d".repeat(64); }],
  ["unadopted TTS", f => { f.saved.adoptedTeachingRevision = null; }],
  ["old TTS source revision", f => { f.saved.boundSource.revision = "old-source"; }],
  ["old TTS source hash", f => { f.saved.boundSource.sha256 = "d".repeat(64); }],
  ["archive hash differs", f => { f.saved.audio.sha256 = "d".repeat(64); }],
  ["archive task differs", f => { f.saved.audio.taskRef.taskId = musicTaskId; }],
  ["music preview", f => { f.musicJournal.intent.request.kind = "music"; }],
  ["missing clip receipt", f => { f.musicSnapshot.assets = []; }],
  ["foreign clip receipt", f => { f.musicSnapshot.assets[0].music.principalKey = "d".repeat(64); }],
  ["duplicate clip proof", f => { f.musicSnapshot.assets.push(structuredClone(f.musicSnapshot.assets[0])); }],
  ["remote TTS bytes changed", f => { f.task.assetRef.sha256 = "d".repeat(64); }],
  ["remote music not ready", f => { f.musicTask.state = "archiving"; }],
  ["unknown URL provenance", f => { f.project.pages[0].actions[0].audioUrl = "https://untrusted.invalid/audio"; f.live.pages[0].actions[0].audioUrl = "https://untrusted.invalid/audio"; }],
]) test(`no share POST for ${name}`, async () => {
  const f = fixture(); mutate(f);
  await assert.rejects(adoptCoursewareOnlineAudio(f.input), /COURSEWARE_ONLINE_AUDIO_/);
  assert.equal(posts(f).length, 0);
});

test("every speech attachment is checked even when its bytes dedupe", async () => {
  const f = fixture();
  const extra = { ...f.project.pages[0].actions[0], id: "speech-unadopted" };
  f.project.pages[0].actions.push(extra); f.live.pages[0].actions.push(structuredClone(extra));
  await assert.rejects(adoptCoursewareOnlineAudio(f.input), /AUDIO_UNAVAILABLE/); assert.equal(posts(f).length, 0);
});

test("existing approved TTS survives source review rebind via boundSource", async () => {
  const f = fixture(); f.journal.intent.selection.expectedSourceRevision = "original-source"; f.journal.intent.sourceSha256 = "d".repeat(64);
  const result = await adoptCoursewareOnlineAudio(f.input); assert.equal(result.assets.length, 2);
});

for (const at of ["courseware.tts.list", "music.GET", "adopt.POST", "content.GET"])
  test(`account change at ${at} rejects late result and stops further sharing`, async () => {
    const f = fixture(); f.intercept(async method => { if (method === at) f.expire(); });
    await assert.rejects(adoptCoursewareOnlineAudio(f.input), /AUTH_CHANGED/);
    assert(posts(f).length <= (at === "adopt.POST" || at === "content.GET" ? 1 : 0));
  });

test("external local edit during remote preflight blocks the first adoption", async () => {
  const f = fixture(); f.intercept(async method => { if (method === "music.GET") f.live.pages[0].actions[0].text = "Changed after review"; });
  await assert.rejects(adoptCoursewareOnlineAudio(f.input), /AUDIO_CONFLICT/); assert.equal(posts(f).length, 0);
});

test("download hash mismatch rejects projection; lost adoption response is never automatically replayed", async () => {
  const f = fixture(); f.input.media.downloadTeamAsset = async reference => ({ reference, bytes: Buffer.alloc(f.bytes.length) });
  await assert.rejects(adoptCoursewareOnlineAudio(f.input), /AUDIO_UNAVAILABLE/); assert.equal(posts(f).length, 1);
  const lost = fixture(); lost.intercept(async method => { if (method === "adopt.POST") throw new Error("response lost"); });
  await assert.rejects(adoptCoursewareOnlineAudio(lost.input), /response lost/); assert.equal(posts(lost).length, 1);
});

test("cancelled transfer makes no Host or remote request; input is cloned before async reads", async () => {
  const f = fixture(), abort = new AbortController(); abort.abort(); f.input.signal = abort.signal;
  await assert.rejects(adoptCoursewareOnlineAudio(f.input), error => error.name === "AbortError"); assert.equal(f.calls.length, 0);
  const clone = fixture(); clone.intercept(async method => { if (method === "courseware.tts.list") clone.input.project.pages[0].actions[0].text = "caller mutated"; });
  const result = await adoptCoursewareOnlineAudio(clone.input); assert.equal(result.project.pages[0].actions[0].text, "Good!");
});


test("audio preflight is read-only and pins original speech/music receipts plus authenticated destination UUIDs", async () => {
  const f = fixture(), original = structuredClone(f.project), projection = await preflightCoursewareOnlineAudio(f.input);
  assert.equal(posts(f).length, 0); assert.equal(f.calls.some(([method]) => /content.GET|team.GET/.test(method)), false);
  assert.deepEqual(projection.assets.map(asset => [asset.localAssetId, asset.assetId]).sort(), [[`tts-${sha(f.bytes)}`, assetId], [`music-${sha(f.musicBytes)}`, musicAssetId]].sort());
  assert.deepEqual(f.project, original); assert.equal(projection.project.pages[0].actions[0].audioAssetId, assetId);
  f.task.assetRef.assetId = "66666666-6666-4666-8666-666666666666";
  await assert.rejects(adoptCoursewareOnlineAudio({ ...f.input, expectedProjection: projection }), /AUDIO_CONFLICT/);
  assert.equal(posts(f).length, 0);
});

test("audio adoption resolves committed same-asset receipts after lost reply and never resubmits generation", async () => {
  const f = fixture(), expectedProjection = await preflightCoursewareOnlineAudio(f.input);
  f.input.media.adoptTeamAsset = async (projectId, ref) => {
    f.calls.push(["adopt.POST", structuredClone(ref)]); assert.equal(projectId, teamProjectId);
    const reference = f.team(ref.taskId === taskId ? f.task : f.musicTask);
    f.sharedAssets.set(reference.assetRef.assetId, structuredClone(reference));
    throw new Error("committed response lost");
  };
  await assert.rejects(adoptCoursewareOnlineAudio({ ...f.input, expectedProjection }), /committed response lost/);
  assert.equal(posts(f).length, 1);
  // Explicit recovery uses GET for the committed TTS and only adopts the not-yet-shared music.
  f.input.media.adoptTeamAsset = async (_projectId, ref) => {
    f.calls.push(["adopt.POST", structuredClone(ref)]); assert.equal(ref.taskId, musicTaskId);
    const reference = f.team(f.musicTask); f.sharedAssets.set(musicAssetId, structuredClone(reference)); return reference;
  };
  const recovered = await adoptCoursewareOnlineAudio({ ...f.input, expectedProjection });
  assert.equal(recovered.assets.length, 2); assert.equal(posts(f).length, 2);
  await adoptCoursewareOnlineAudio({ ...f.input, expectedProjection }); assert.equal(posts(f).length, 2);
});

test("team asset recovery rejects forged metadata and non-missing errors without adoption fallback", async () => {
  for (const mutate of [v => { v.assetRef.sha256 = "d".repeat(64); }, v => { v.assetRef.assetId = musicAssetId; }, v => { v.projectId = taskId; }]) {
    const f = fixture(), bad = f.team(f.task); mutate(bad); f.sharedAssets.set(assetId, bad);
    await assert.rejects(adoptCoursewareOnlineAudio(f.input), /AUDIO_UNAVAILABLE/); assert.equal(posts(f).length, 0);
  }
  for (const message of ["COURSEWARE_MEDIA_PLATFORM_46102", "unknown response", "COURSEWARE_MEDIA_HTTP_503"]) {
    const f = fixture(); f.input.media.getTeamAsset = async () => { throw new Error(message); };
    await assert.rejects(adoptCoursewareOnlineAudio(f.input), error => error.message === message); assert.equal(posts(f).length, 0);
  }
  const f = fixture();
  await assert.rejects(adoptCoursewareOnlineAudio({ ...f.input, beforeAdopt() { throw new Error("Owner lost before write"); } }), /Owner lost/);
  assert.equal(posts(f).length, 0);
});
