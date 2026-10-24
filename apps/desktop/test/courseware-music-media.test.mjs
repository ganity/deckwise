import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { once } from "node:events";
import test from "node:test";
import { loadCoursewareMedia } from "./fixtures/courseware-media-loader.mjs";

const { CoursewareMediaClient } = await loadCoursewareMedia();
const { musicRequest, musicRequestHash } = await loadCoursewareMedia("courseware-music-request");
const sha = b => createHash("sha256").update(b).digest("hex");
const input = () => ({ kind: "music", model: "song-model", input: "Red apple, good job!", music: { title: "Fruit song", tags: "gentle", instrumental: false } });
const ids = ["11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222"];
const audio = Buffer.from([73,68,51,4,0,0,0,0,0,0,1,2,3,4]);
const quote = (kind = "music", model = kind === "music" ? "song-model" : "export-model") => ({
  version: "courseware-media-quote-v1", kind, model, priceVersion: "fixture-price", maxPoints: 5, maxChars: 4000,
  expiresAt: "2099-01-01T00:00:00Z", quoteToken: "4070908800." + "a".repeat(43),
});
const json = (data, code = 200) => new Response(JSON.stringify({ code, data, message: "private supplier detail" }), { headers: { "content-type": "application/json" } });
const ready = (request = input(), key = "music-key", state = "ready") => ({
  version: "courseware-media-v1", taskId: request.kind === "music" ? "collection-1" : "export-1", idempotencyKey: key,
  requestHash: musicRequestHash(request), kind: request.kind, model: request.model, state,
  feeState: state === "ready" ? "settled" : "reserved", reservedPoints: 5, actualPoints: state === "ready" ? 5 : null,
  receiptId: state === "ready" ? `courseware-media:${request.kind === "music" ? "collection-1" : "export-1"}` : null,
  errorCode: null, assetRef: request.kind === "music-export" && state === "ready" ? {
    assetId: "asset-1", sha256: sha(audio), mime: "audio/mpeg", byteLength: audio.length,
    downloadPath: "/courseware/media/tasks/export-1/asset",
  } : null,
});
const ref = (task = ready()) => ({ taskId: task.taskId, idempotencyKey: task.idempotencyKey, requestHash: task.requestHash });
const candidates = () => ids.map((candidateId, order) => ({ candidateId, order, state: "completed", exportable: true, durationMs: 8250 }));
function setup(respond = async url => url.endsWith("music-candidates") ? json(candidates()) : json(ready())) {
  let principal = {}, calls = [];
  const client = new CoursewareMediaClient({ baseUrl: "https://platform.test/api/backend", getPrincipal: () => principal,
    resolveAccessToken: async () => "fixture-access", fetch: async (url, init) => { calls.push([url, init]); return respond(url, init); } });
  return { music: client.music, calls, changePrincipal: () => { principal = {}; } };
}

test("music request hashes preserve title/lyrics/styles/Unicode and null versus empty values", () => {
  const request = input(), hashes = new Set([musicRequestHash(request)]);
  for (const patch of [{ title: "Fruit song😀" }, { tags: "" }, { tags: null }, { negativeTags: "" }, { instrumental: true }, { instrumental: null }])
    hashes.add(musicRequestHash({ ...request, music: { ...request.music, ...patch } }));
  assert.equal(hashes.size, 7);
  assert.equal(musicRequestHash({ ...request, music: { title: request.music.title } }),
    musicRequestHash({ ...request, music: { title: request.music.title, tags: null, negativeTags: null, instrumental: null } }));
  assert.equal(musicRequest({ ...request, input: "", music: { title: "Instrumental", instrumental: true } }).input, "");
  assert.notEqual(musicRequestHash(request), musicRequestHash({ ...request, input: request.input + " " }));
});

test("unsupported or malformed music options fail before token/network access", async () => {
  const f = setup(), bad = [null, { ...input(), voice: "teacher" }, { ...input(), apiKey: "override" },
    { ...input(), music: { title: " " } }, { ...input(), input: "" }, { ...input(), music: { title: "bad\ud800" } },
    { ...input(), music: { title: "Fruit", tags: "a".repeat(1001) } }, { ...input(), music: { title: "Fruit", instrumental: "true" } },
    { ...input(), music: { title: "Fruit", providerId: "override" } }, { ...input(), referenceImage: {} },
    { kind: "music-export", model: "export-model", input: "song-1" },
    { kind: "music-export", model: "export-model", input: ids[0], music: { title: "Fruit" } }];
  for (const request of bad) await assert.rejects(f.music.submitConfirmed("key", request, quote()), /INVALID_REQUEST/);
  assert.equal(f.calls.length, 0);
});

test("music and export offers are separate and reject voice/duplicate/foreign fields", async () => {
  let response = [{ model: "song-model", voices: [], providerDefaultVoice: false }];
  const f = setup(async url => url.includes("/quote?") ? json(quote(new URL(url).searchParams.get("kind"))) : json(response));
  assert.deepEqual(await f.music.models("music"), [{ model: "song-model" }]);
  assert.equal((await f.music.quote("export-model", "music-export")).kind, "music-export");
  for (const changed of [[...response, ...response], [{ ...response[0], voices: ["teacher"] }], [{ ...response[0], providerDefaultVoice: true }], [{ ...response[0], apiKey: "bad" }]]) {
    response = changed; await assert.rejects(f.music.models("music"), /INVALID_RESPONSE/);
  }
  const count = f.calls.length;
  await assert.rejects(f.music.models("video"), /INVALID_REQUEST/);
  await assert.rejects(f.music.quote("../other", "music"), /INVALID_REQUEST/);
  await assert.rejects(f.music.submitConfirmed("key", input(), quote("music-export")), /INVALID_RESPONSE/);
  await assert.rejects(f.music.submitConfirmed("key", input(), { ...quote(), expiresAt: "2000-01-01T00:00:00Z", quoteToken: "946684800." + "a".repeat(43) }), /QUOTE_EXPIRED/);
  assert.equal(f.calls.length, count);
});

test("confirmed music freezes caller parameters and the team route never falls back", async () => {
  const request = input(), original = structuredClone(request), project = "12345678-1234-1234-1234-123456789abc";
  const f = setup(async (url, init) => {
    const body = JSON.parse(init.body).request;
    request.input = "changed during await"; request.music.tags = "changed";
    return json(ready(body, "key", "queued"));
  });
  const saved = await f.music.submitConfirmed("key", request, quote(), undefined, project);
  assert.equal(saved.requestHash, musicRequestHash(original));
  assert.deepEqual(JSON.parse(f.calls[0][1].body).request, original);
  assert.equal(new URL(f.calls[0][0]).pathname, `/api/backend/courseware/team/projects/${project}/media/tasks/confirmed`);
  const missing = setup(async () => new Response("missing", { status: 404 }));
  await assert.rejects(missing.music.submitConfirmed("key", input(), quote(), undefined, project), /HTTP_404/);
  assert.equal(missing.calls.length, 1);
  await assert.rejects(missing.music.submitConfirmed("key", input(), quote(), undefined, "../personal"), /INVALID_TEAM_PROJECT/);
  assert.equal(missing.calls.length, 1);
});

test("music recovery is GET-only, bound to key/hash/kind and only exact not-found returns null", async () => {
  let code = 200, value = ready();
  const f = setup(async () => json(value, code));
  const expected = { idempotencyKey: value.idempotencyKey, requestHash: value.requestHash };
  assert.equal((await f.music.find(expected, "music")).taskId, value.taskId);
  code = 46006; assert.equal(await f.music.find(expected, "music"), null);
  code = 46102; await assert.rejects(f.music.find(expected, "music"), /PLATFORM_46102/);
  code = 200; value = { ...ready(), kind: "music-export" };
  await assert.rejects(f.music.find(expected, "music"), /INVALID_RESPONSE/);
  value = { ...ready(), requestHash: "f".repeat(64) };
  await assert.rejects(f.music.find(expected, "music"), /INVALID_RESPONSE/);
  assert(f.calls.every(([url, init]) => url.includes("/by-idempotency?") && (init.method ?? "GET") === "GET"));
});

test("music ready tasks are collections, while exports require their own immutable MP3 asset", async () => {
  const f = setup(async () => json({ ...ready(), assetRef: ready({ kind: "music-export", model: "export-model", input: ids[0] }).assetRef }));
  await assert.rejects(f.music.get(ref(), "music"), /INVALID_RESPONSE/);
  const request = { kind: "music-export", model: "export-model", input: ids[0] }, exported = ready(request);
  for (const mutation of [{ assetRef: null }, { feeState: "reserved" }, { assetRef: { ...exported.assetRef, mime: "audio/wav" } },
    { assetRef: { ...exported.assetRef, downloadPath: "https://public.test/song.mp3" } }]) {
    const bad = setup(async () => json({ ...exported, ...mutation }));
    await assert.rejects(bad.music.get(ref(exported), "music-export"), /INVALID_RESPONSE/);
  }
});

test("candidate lists preserve every ordered result and reject duplicates/foreign fields or impossible readiness", async () => {
  let list = candidates();
  const f = setup(async url => json(url.endsWith("music-candidates") ? list : ready()));
  assert.deepEqual((await f.music.candidates(ref())).candidates, list);
  for (const changed of [[], [list[1], list[0]], [{ ...list[0], order: 1 }], [list[0], { ...list[1], candidateId: list[0].candidateId }],
    [{ ...list[0], url: "https://supplier.test/music" }], [{ ...list[0], state: "processing", exportable: false }],
    [{ ...list[0], exportable: false }], [{ ...list[0], durationMs: Number.MAX_SAFE_INTEGER + 1 }]]) {
    list = changed; await assert.rejects(f.music.candidates(ref()), /INVALID_RESPONSE/);
  }
});

test("candidate preview remains a read and cannot silently export when audio is unavailable", async () => {
  let response = json(null, 46007);
  const f = setup(async url => url.endsWith("/preview") ? response : json(url.endsWith("music-candidates") ? candidates() : ready()));
  await assert.rejects(f.music.preview(ref(), ids[0]), /PLATFORM_46007/);
  response = new Response(audio, { headers: { "content-type": "audio/mpeg" } });
  const preview = await f.music.preview(ref(), ids[0]);
  assert.deepEqual(preview.bytes, audio); assert.equal(preview.preview.sha256, sha(audio));
  assert.equal(preview.candidates.length, 2); assert.equal(preview.task.assetRef, null);
  assert(f.calls.every(([, init]) => (init.method ?? "GET") === "GET"));
  await assert.rejects(f.music.preview(ref(), "song-1"), /INVALID_REQUEST/);
  await assert.rejects(f.music.preview(ref(), "33333333-3333-4333-8333-333333333333"), /ASSET_NOT_READY/);
});

test("preview and export reject malformed/mismatched/oversized audio", async () => {
  const exported = ready({ kind: "music-export", model: "export-model", input: ids[0] });
  for (const headers of [{ "content-type": "text/html" }, { "content-type": "audio/wav" }, { "content-type": "audio/mpeg", "content-length": String(16 * 1024 * 1024 + 1) }]) {
    const f = setup(async url => url.endsWith("/preview") ? new Response(audio, { headers }) : json(url.endsWith("music-candidates") ? candidates() : ready()));
    await assert.rejects(f.music.preview(ref(), ids[0]), /INTEGRITY_ERROR|RESPONSE_TOO_LARGE/);
  }
  for (const bytes of [Buffer.from("<html>"), Buffer.from([...audio, 9])]) {
    const f = setup(async url => url.endsWith("/asset") ? new Response(bytes, { headers: { "content-type": "audio/mpeg" } }) : json(exported));
    await assert.rejects(f.music.downloadExport(ref(exported)), /INTEGRITY_ERROR/);
  }
});

test("music multi-request reads refuse account changes, cancellation and cross-kind receipts", async () => {
  const f = setup(async url => {
    if (url.endsWith("music-candidates")) f.changePrincipal();
    return json(url.endsWith("music-candidates") ? candidates() : ready());
  });
  await assert.rejects(f.music.preview(ref(), ids[0]), /AUTH_CHANGED/);
  assert.equal(f.calls.length, 2);
  const cancelled = setup();
  await assert.rejects(cancelled.music.candidates(ref(), AbortSignal.abort()), /abort/i);
  assert.equal(cancelled.calls.length, 0);
  const wrong = setup(async () => json({ ...ready(), kind: "tts" }));
  await assert.rejects(wrong.music.get(ref(), "music"), /INVALID_RESPONSE/);
});

async function runLifecycle(baseUrl, step) {
  const client = new CoursewareMediaClient({ baseUrl, fetch, getPrincipal: () => principal, resolveAccessToken: async () => "fixture-main-access" });
  const principal = {}, music = client.music, request = input();
  const offer = await music.quote(request.model, "music");
  const parent = await music.submitConfirmed("main-song-key", request, offer);
  await step(parent.taskId);
  const collection = await music.candidates(ref(parent));
  assert.equal(collection.task.state, "ready"); assert.equal(collection.candidates.length, 2);
  const preview = await music.preview(ref(parent), collection.candidates[0].candidateId);
  assert.deepEqual(preview.bytes, audio);
  const exportRequest = { kind: "music-export", model: "export-model", input: collection.candidates[0].candidateId };
  const exportQuote = await music.quote(exportRequest.model, "music-export");
  const exported = await music.submitConfirmed("main-export-key", exportRequest, exportQuote);
  await step(exported.taskId);
  const downloaded = await music.downloadExport(ref(exported));
  assert.deepEqual(downloaded.bytes, audio);
  const restarted = new CoursewareMediaClient({ baseUrl, fetch, getPrincipal: () => principal, resolveAccessToken: async () => "fixture-main-access" }).music;
  assert.equal((await restarted.find({ idempotencyKey: parent.idempotencyKey, requestHash: parent.requestHash }, "music")).taskId, parent.taskId);
  assert.deepEqual((await restarted.preview(ref(parent), collection.candidates[0].candidateId)).bytes, audio);
  assert.deepEqual((await restarted.downloadExport(ref(exported))).bytes, audio);
  return { parent, exported };
}

test("actual Main music transport lifecycle over loopback HTTP retains all candidates and separate exports", async t => {
  const saved = new Map(), methods = [];
  const server = createServer(async (req, res) => {
    try {
      assert.equal(req.headers.authorization, "Bearer fixture-main-access");
      methods.push(req.method); const url = new URL(req.url, "http://127.0.0.1");
      const send = data => { res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify({ code: 200, data })); };
      if (url.pathname.includes("/quote")) return send(quote(url.searchParams.get("kind")));
      if (req.method === "POST") {
        const chunks = []; for await (const chunk of req) chunks.push(chunk);
        const body = JSON.parse(Buffer.concat(chunks)).request, task = ready(body, req.headers["idempotency-key"], "queued");
        saved.set(task.idempotencyKey, task); return send(task);
      }
      if (url.pathname.endsWith("/by-idempotency")) return send(saved.get(url.searchParams.get("key")));
      if (url.pathname.endsWith("/preview") || url.pathname.endsWith("/asset")) { res.writeHead(200, { "Content-Type": "audio/mpeg" }); res.end(audio); return; }
      if (url.pathname.endsWith("music-candidates")) return send(candidates());
      return send([...saved.values()].find(task => url.pathname.endsWith(`/${task.taskId}`)));
    } catch (error) { res.destroy(error); }
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(() => new Promise(resolve => server.close(resolve)));
  await runLifecycle(`http://127.0.0.1:${server.address().port}`, async id => {
    for (const task of saved.values()) if (task.taskId === id) Object.assign(task, { state: "ready", feeState: "settled", actualPoints: 5,
      receiptId: `courseware-media:${id}`, assetRef: task.kind === "music" ? null : ready({ kind: "music-export", model: "export-model", input: ids[0] }).assetRef });
  });
  assert.equal(methods.filter(method => method === "POST").length, 2);
});
