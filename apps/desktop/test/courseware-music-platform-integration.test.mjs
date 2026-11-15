import assert from "node:assert/strict";
import test from "node:test";
import { loadCoursewareMedia } from "./fixtures/courseware-media-loader.mjs";

const url = process.env.DECKWISE_JOINED_MUSIC_URL;
const project = process.env.DECKWISE_JOINED_MUSIC_PROJECT;

test("music client joins real Spring HTTP, SQL/Redis, private previews and explicit paid export", {
  skip: !url ? "Run Platform MusicDesktopJoinedTest to start its isolated real HTTP fixture" : false,
  timeout: 60_000,
}, async () => {
  assert.match(url, /^http:\/\/127\.0\.0\.1:\d+$/u);
  assert.match(project, /^[a-f0-9-]{36}$/u);
  const { CoursewareMediaClient } = await loadCoursewareMedia();
  const { musicRequestHash } = await loadCoursewareMedia("courseware-music-request");
  const principal = {}, requests = [];
  let loseNextSubmissionResponse = false;
  const client = () => new CoursewareMediaClient({ baseUrl: url, resolveAccessToken: async () => "fixture-editor",
    getPrincipal: () => principal, fetch: async (input, init) => {
      requests.push({ path: new URL(input).pathname, method: init.method ?? "GET" });
      const response = await fetch(input, init);
      if (loseNextSubmissionResponse && init.method === "POST") {
        loseNextSubmissionResponse = false;
        await response.arrayBuffer();
        throw new Error("fixture response lost after real server acceptance");
      }
      return response;
    } }).music;
  let music = client();
  const control = async (path, params = {}, method = "POST") => {
    const response = await fetch(url + "/__fixture/" + path + "?" + new URLSearchParams(params), {
      method, headers: { "X-Fixture-Control": "music-joined-local-control" },
    });
    assert.equal(response.status, 200); return response.json();
  };
  const state = () => control("state", {}, "GET");
  const reference = task => ({ taskId: task.taskId, idempotencyKey: task.idempotencyKey, requestHash: task.requestHash });
  const input = { kind: "music", model: "song-model", input: "Red apple, good job!", music: {
    title: "Fruit song", tags: "gentle", instrumental: false,
  } };
  assert.deepEqual(await music.models("music"), [{ model: "song-model" }]);
  assert.deepEqual(await music.models("music-export"), [{ model: "export-model" }]);
  const quote = await music.quote("song-model", "music");
  assert.equal(quote.maxPoints, 5);
  const expected = { idempotencyKey: "joined-music", requestHash: musicRequestHash(input) };
  loseNextSubmissionResponse = true;
  await assert.rejects(music.submitConfirmed(expected.idempotencyKey, input, quote, undefined, project), /TRANSPORT_FAILED/u);
  const afterLost = requests.length;
  music = client();
  let collection = await music.find(expected, "music");
  assert(collection); assert.equal(collection.state, "queued");
  assert(requests.slice(afterLost).every(r => r.method === "GET"));
  assert.equal((await state()).reserves, 1);
  await control("step", { taskId: collection.taskId });
  collection = await music.get(reference(collection), "music");
  assert.equal(collection.state, "ready"); assert.equal(collection.assetRef, null);
  const candidates = (await music.candidates(reference(collection))).candidates;
  assert.equal(candidates.length, 2);
  assert.deepEqual(candidates.map(c => c.order), [0, 1]);
  assert(candidates.every(c => c.exportable && c.state === "completed" && c.durationMs === 8250));
  const beforePreview = requests.length;
  const previews = [];
  for (const candidate of candidates) previews.push(await music.preview(reference(collection), candidate.candidateId));
  assert.notEqual(previews[0].preview.sha256, previews[1].preview.sha256);
  assert(requests.slice(beforePreview).every(r => r.method === "GET"));
  const cached = await music.preview(reference(collection), candidates[0].candidateId);
  assert.deepEqual(cached.bytes, previews[0].bytes);
  assert.deepEqual(await state(), { generates: 1, exports: 0, downloads: 2, reserves: 1, settlements: 1 });
  const exportQuote = await music.quote("export-model", "music-export");
  assert.equal(exportQuote.maxPoints, 2);
  const exportInput = { kind: "music-export", model: "export-model", input: candidates[0].candidateId };
  const exportExpected = { idempotencyKey: "joined-export", requestHash: musicRequestHash(exportInput) };
  loseNextSubmissionResponse = true;
  await assert.rejects(music.submitConfirmed(exportExpected.idempotencyKey, exportInput, exportQuote, undefined, project), /TRANSPORT_FAILED/u);
  const afterExportLost = requests.length;
  music = client();
  let exported = await music.find(exportExpected, "music-export");
  assert(exported); assert(requests.slice(afterExportLost).every(r => r.method === "GET"));
  await control("step", { taskId: exported.taskId });
  const download = await music.downloadExport(reference(exported));
  assert.equal(download.task.state, "ready"); assert.deepEqual(download.bytes, previews[0].bytes);
  assert.deepEqual(await state(), { generates: 1, exports: 1, downloads: 3, reserves: 2, settlements: 2 });
  await control("member", { projectId: project, role: "VIEWER" });
  await assert.rejects(music.submitConfirmed("joined-viewer", input, quote, undefined, project), /PLATFORM_46102/u);
  assert.equal((await state()).reserves, 2);
  await control("member", { projectId: project, role: "REVOKE" });
  await assert.rejects(music.preview(reference(collection), candidates[0].candidateId), /PLATFORM_46100/u);
  assert.equal((await state()).downloads, 3);
  assert.equal((await music.find(expected, "music")).feeState, "settled");
  assert.equal(requests.filter(r => r.method === "POST").length, 3);
  console.log(JSON.stringify({ joined: "desktop-client -> real Tomcat/Spring MVC -> actual isolated SQL/Redis -> loopback MAIC protocol fixture",
    candidates: candidates.length, generationPosts: 1, exportPosts: 1, previewDownloads: 2, lostResponseGetRecoveries: 2,
    viewerSubmissionDenied: true, revokedPreviewDenied: true, final: await state() }));
});
