import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import * as crypto from "node:crypto";
import * as util from "node:util";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { createServer } from "node:http";
import { once } from "node:events";
import test from "node:test";
import ts from "typescript";
import * as shared from "../../../packages/shared/dist/index.js";
import { loadCoursewareMedia } from "./fixtures/courseware-media-loader.mjs";

const transportFetch = process.env.DECKWISE_E2E_ELECTRON_NET === "1" ? (await import("electron")).default.net.fetch : fetch;

async function load(file, dependencies) {
  const source = await fs.readFile(new URL(`../electron/main/${file}.ts`, import.meta.url), "utf8");
  const { outputText } = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } });
  const exports = {};
  new Function("require", "exports", outputText)((id) => {
    if (!Object.hasOwn(dependencies, id)) throw new Error(`Unexpected dependency ${id}`);
    return dependencies[id];
  }, exports);
  return exports;
}
const media = await loadCoursewareMedia();
const { CoursewareMediaClient } = media;
const { musicRequestHash } = await loadCoursewareMedia("courseware-music-request");
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const input = { kind: "tts", model: "courseware-tts-v1", input: "Good! 小朋友😀", voice: "teacher_1" };
function hashRequest(value) {
  let canonical = "courseware-media-v1";
  for (const field of [value.kind, value.model, value.input, value.voice ?? null]) canonical += `:${field === null ? -1 : field.length}:${field ?? ""}`;
  if (value.referenceImage) for (const field of [value.referenceImage.sha256, value.referenceImage.mimeType, String(value.referenceImage.byteLength)]) canonical += `:${field.length}:${field}`;
  return sha(canonical);
}
// A real PCM file proves transport integrity only; no generated-speech claim.
const audio = Buffer.alloc(844);
audio.write("RIFF"); audio.writeUInt32LE(audio.length - 8, 4); audio.write("WAVEfmt ", 8);
audio.writeUInt32LE(16, 16); audio.writeUInt16LE(1, 20); audio.writeUInt16LE(1, 22);
audio.writeUInt32LE(8000, 24); audio.writeUInt32LE(16000, 28); audio.writeUInt16LE(2, 32);
audio.writeUInt16LE(16, 34); audio.write("data", 36); audio.writeUInt32LE(800, 40);
const ready = (body = input, key = "saved-key-1") => ({ version: "courseware-media-v1", taskId: "task-1", idempotencyKey: key,
  requestHash: hashRequest(body), kind: "tts", model: body.model, state: "ready", feeState: "settled",
  reservedPoints: 5, actualPoints: 3, receiptId: "courseware-media:task-1", errorCode: null,
  assetRef: { assetId: "audio-1", sha256: sha(audio), mime: "audio/wav", byteLength: audio.length,
    downloadPath: "/courseware/media/tasks/task-1/asset", durationMs: 50 } });
const reference = (task = ready()) => ({ taskId: task.taskId, idempotencyKey: task.idempotencyKey, requestHash: task.requestHash });
const json = (value, status = 200) => new Response(JSON.stringify({ code: 200, data: value }), { status, headers: { "content-type": "application/json" } });
function setup(fetch = async () => json(ready())) {
  let principal = { tenantId: 1, userId: 2 }, calls = [], tokens = 0;
  const client = new CoursewareMediaClient({ baseUrl: "https://platform.test/api/backend", getPrincipal: () => principal,
    resolveAccessToken: async () => `private-access-${++tokens}`, fetch: async (url, init) => { calls.push([url, init]); return fetch(url, init); } });
  return { client, calls, principal: (value) => { principal = value; } };
}

test("all media kinds share five slots, including async generation after submit returns", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const submitted = [], completed = new Set(), tasks = new Map();
  let releaseFirst, releaseSecond;
  const firstStarted = new Promise(resolve => { releaseFirst = resolve; });
  const secondStarted = new Promise(resolve => { releaseSecond = resolve; });
  const f = setup(async (url, init) => {
    const parsed = new URL(url);
    if (parsed.pathname.endsWith("/models")) return json([{ model: imageInput.model, voices: [], providerDefaultVoice: false, supportsReferenceImage: true }]);
    if (init.method === "POST") {
      const body = JSON.parse(init.body).request;
      const key = init.headers.get("Idempotency-Key");
      submitted.push(key);
      const value = { ...ready(body, key), taskId: `task-${key}`, kind: body.kind, state: "submitted", assetRef: null,
        feeState: "reserved", actualPoints: null, receiptId: null,
        requestHash: body.kind.startsWith("music") ? musicRequestHash(body) : hashRequest(body) };
      tasks.set(key, value);
      if (submitted.length === 5) releaseFirst();
      if (submitted.length === 10) releaseSecond();
      return json(value);
    }
    const key = parsed.searchParams.get("key") ?? parsed.pathname.split("/").at(-1).slice(5);
    assert(tasks.has(key), "queued work must only poll existing tasks");
    return json({ ...tasks.get(key), state: completed.has(key) ? "failed" : "submitted" });
  });
  const jobs = Array.from({ length: 12 }, (_, index) => {
    const kind = ["tts", "image", "image-layers", "music", "video", "music-export"][index % 6];
    const bytes = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLttAAAAABJRU5ErkJggg==", "base64");
    const body = kind === "tts" ? input : kind.startsWith("music") ? { kind, model: kind,
      input: kind === "music-export" ? "11111111-1111-4111-8111-111111111111" : "Hello song",
      ...(kind === "music" ? { music: { title: "Hello" } } : {}) } : { ...imageInput, kind, ...(kind === "image-layers" ? {
      referenceImage: { sha256: sha(bytes), mimeType: "image/png", byteLength: bytes.length, bytesBase64: bytes.toString("base64") },
    } : {}) };
    const quote = { ...imageQuote(), kind, model: body.model };
    if (kind === "music" || kind === "music-export") return f.client.music.submitConfirmed(`batch-${index}`, body, quote);
    if (kind === "video") return f.client.video.submit(`batch-${index}`, body, quote);
    return kind === "tts" ? f.client.submitConfirmedTts(`batch-${index}`, body, quote)
      : f.client.submitConfirmedImage(`batch-${index}`, body, quote);
  });
  await firstStarted;
  for (let i = 0; i < 60; i++) await Promise.resolve();
  assert.equal(submitted.length, 5, "pending remote jobs must retain their generation slots");
  for (const key of submitted) completed.add(key);
  t.mock.timers.tick(3000);
  await secondStarted;
  for (let i = 0; i < 60; i++) await Promise.resolve();
  assert.equal(submitted.length, 10);
  for (const key of submitted) completed.add(key);
  t.mock.timers.tick(3000);
  await Promise.all(jobs);
  assert.deepEqual(submitted.toSorted(), Array.from({ length: 12 }, (_, i) => `batch-${i}`).sort());
});

test("team submission uses a distinct route with unchanged hashes and never falls back", async () => {
  const project = "12345678-1234-1234-1234-123456789abc";
  const quote = { version: "courseware-media-quote-v1", kind: "tts", model: input.model,
    priceVersion: "price-v1", maxPoints: 5, maxChars: 4000, expiresAt: "2099-01-01T00:00:00Z",
    quoteToken: "4070908800." + "a".repeat(43) };
  const f = setup();
  await f.client.submitTts("saved-key-1", input, undefined, project);
  await f.client.submitConfirmedTts("saved-key-1", input, quote, undefined, project);
  assert.deepEqual(f.calls.map(([url]) => new URL(url).pathname), [
    `/api/backend/courseware/team/projects/${project}/media/tasks`,
    `/api/backend/courseware/team/projects/${project}/media/tasks/confirmed`]);
  assert.deepEqual(JSON.parse(f.calls[0][1].body), input);
  const unavailable = setup(async () => new Response("missing", { status: 404 }));
  await assert.rejects(unavailable.client.submitTts("saved-key-1", input, undefined, project));
  assert.equal(unavailable.calls.length, 1);
  await assert.rejects(unavailable.client.submitTts("saved-key-1", input, undefined, "../other"), /INVALID_TEAM_PROJECT/);
  assert.equal(unavailable.calls.length, 1);
});

test("both image submission variants retain their original request on the team route", async () => {
  const project = "12345678-1234-1234-1234-123456789abc";
  const f = setup(async () => json(imageQueued()));
  await f.client.submitImage("scene-image-1", imageInput, undefined, project);
  await f.client.submitConfirmedImage("scene-image-1", imageInput, imageQuote(), undefined, project);
  assert.deepEqual(f.calls.map(([url]) => new URL(url).pathname), [
    `/api/backend/courseware/team/projects/${project}/media/tasks`,
    `/api/backend/courseware/team/projects/${project}/media/tasks/confirmed`]);
  assert.deepEqual(JSON.parse(f.calls[0][1].body), imageInput);
  assert.deepEqual(JSON.parse(f.calls[1][1].body).request, imageInput);
});

test("TTS price lookup is authenticated and read-only, with no submission or fallback", async () => {
  const quote = { version: "courseware-media-quote-v1", kind: "tts", model: input.model,
    priceVersion: "tts-2026-10", maxPoints: 5, maxChars: 4000, expiresAt: "2099-01-01T00:00:00Z", quoteToken: "4070908800." + "a".repeat(43) };
  const f = setup(async () => json(quote));
  assert.deepEqual(await f.client.getTtsQuote(input.model), quote);
  assert.equal(f.calls.length, 1);
  const [url, init] = f.calls[0];
  assert.equal(url, `https://platform.test/api/backend/courseware/media/models/${input.model}/quote?kind=tts`);
  assert.ok(!init.method || init.method === "GET");
  assert.equal(init.body, undefined);
  assert.equal(init.headers.has("Idempotency-Key"), false);
  assert.match(init.headers.get("Authorization"), /^Bearer private-access-/);
  await assert.rejects(f.client.getTtsQuote("../other"), /INVALID_REQUEST/);
  assert.equal(f.calls.length, 1);
  const missing = setup(async () => new Response("", { status: 404 }));
  await assert.rejects(missing.client.getTtsQuote(input.model), /HTTP_404/);
  assert.equal(missing.calls.length, 1);
});

test("TTS quote rejects stale, swapped, malformed and account-changed offers", async () => {
  const quote = { version: "courseware-media-quote-v1", kind: "tts", model: input.model,
    priceVersion: "tts-2026-10", maxPoints: 5, maxChars: 4000, expiresAt: "2099-01-01T00:00:00Z", quoteToken: "4070908800." + "a".repeat(43) };
  for (const patch of [{ kind: "image" }, { model: "other" }, { priceVersion: "" }, { maxPoints: 0 },
    { maxPoints: 1.5 }, { maxChars: 4001 }, { expiresAt: "bad" }, { expiresAt: "2000-01-01T00:00:00Z" },
    { accountRef: "private-provider" }]) {
    const f = setup(async () => json({ ...quote, ...patch }));
    await assert.rejects(f.client.getTtsQuote(input.model), /INVALID_RESPONSE|QUOTE_EXPIRED/);
    assert.equal(f.calls.length, 1);
  }
  const f = setup(async () => { f.principal({ tenantId: 1, userId: 3 }); return json(quote); });
  await assert.rejects(f.client.getTtsQuote(input.model), /AUTH_CHANGED/);
});

test("TTS model selection, quote and confirmed submit preserve the original task hash and confirmed ceiling", async () => {
  const models = [{ model: input.model, voices: [input.voice], providerDefaultVoice: true }];
  const quote = { version: "courseware-media-quote-v1", kind: "tts", model: input.model,
    priceVersion: "price-v1", maxPoints: 5, maxChars: 4000, expiresAt: "2099-01-01T00:00:00Z",
    quoteToken: "4070908800." + "a".repeat(43) };
  const f = setup(async (url) => json(url.endsWith("models?kind=tts") ? models : url.includes("/quote?") ? quote : ready()));
  assert.deepEqual(await f.client.getTtsModels(), models);
  const offer = await f.client.getTtsQuote(input.model);
  const result = await f.client.submitConfirmedTts("saved-key-1", input, offer);
  assert.equal(result.requestHash, hashRequest(input));
  assert.equal(f.calls[2][0], "https://platform.test/api/backend/courseware/media/tasks/confirmed");
  assert.deepEqual(JSON.parse(f.calls[2][1].body), { request: input,
    confirmation: { priceVersion: quote.priceVersion, maxPoints: 5, quoteToken: quote.quoteToken } });
  assert.equal(f.calls[2][1].headers.get("Idempotency-Key"), "saved-key-1");
  await assert.rejects(f.client.submitConfirmedTts("saved-key-1", input, { ...quote, model: "other" }), /INVALID_RESPONSE/);
  await assert.rejects(f.client.submitConfirmedTts("saved-key-1", input, { ...quote, maxChars: 1 }), /INVALID_REQUEST/);
  assert.equal(f.calls.length, 3);
  const excessive = setup(async () => json({ ...ready(), reservedPoints: 6 }));
  await assert.rejects(excessive.client.submitConfirmedTts("saved-key-1", input, quote), /INVALID_RESPONSE/);
});

test("TTS catalogue rejects malformed voices, duplicate models and private extra fields", async () => {
  const model = { model: input.model, voices: [input.voice], providerDefaultVoice: true };
  for (const response of [[model, model], [{ ...model, voices: ["../voice"] }],
    [{ ...model, voices: [input.voice, input.voice] }], [{ ...model, accountRef: "private" }], {}]) {
    const f = setup(async () => json(response));
    await assert.rejects(f.client.getTtsModels(), /INVALID_RESPONSE/);
  }
});

const imageInput = { kind: "image", model: "scene-image", input: "A bright classroom. 小朋友😀" };
const imageQuote = () => ({ version: "courseware-media-quote-v1", kind: "image", model: imageInput.model,
  priceVersion: "billing-image-5-7500000-6", maxPoints: 8, maxChars: 4000,
  expiresAt: "2099-01-01T00:00:00Z", quoteToken: "4070908800." + "a".repeat(43) });
const imageQueued = () => ({ ...ready(imageInput, "scene-image-1"), kind: "image", state: "queued",
  feeState: "reserved", reservedPoints: 8, actualPoints: null, receiptId: null, assetRef: null });

test("configured gateway owns image catalog, quote, submit, lookup and bytes while TTS retains its existing route", async () => {
  const calls = [], principal = {}, bytes = await fs.readFile(new URL("fixtures/courseware-team-image.png", import.meta.url));
  const saved = { ...imageQueued(), taskId: "gw-image-1", state: "ready", feeState: "settled", actualPoints: 3,
    receiptId: "courseware-media:gw-image-1", assetRef: { assetId: "gw-asset-1", sha256: sha(bytes), mime: "image/png", byteLength: bytes.length,
      width: 1, height: 1, downloadPath: "/courseware/media/tasks/gw-image-1/asset" } };
  const client = new CoursewareMediaClient({ baseUrl: "https://platform.test/api", imageBaseUrl: "https://gateway.test/llm-ha/v1",
    getPrincipal: () => principal, resolveAccessToken: async () => "user-access", fetch: async (url, init) => {
      calls.push([url, init]); assert.equal(init.headers.get("authorization"), "Bearer user-access");
      if (url.endsWith("kind=tts")) return json([]);
      assert.equal(new URL(url).origin, "https://gateway.test");
      if (url.includes("/models?")) return json([{ model: imageInput.model, voices: [], providerDefaultVoice: false }]);
      if (url.includes("/quote?")) return json(imageQuote());
      if (url.endsWith("/asset")) return new Response(bytes, { headers: { "content-type": "image/png" } });
      return json(saved);
    } });
  await client.getImageModels(); const quote = await client.getImageQuote(imageInput.model);
  await client.submitConfirmedImage(saved.idempotencyKey, imageInput, quote);
  assert.deepEqual((await client.downloadImage(reference(saved))).bytes, bytes);
  assert.deepEqual(await client.findImage({ idempotencyKey: saved.idempotencyKey, requestHash: saved.requestHash }), saved);
  await client.getTtsModels();
  assert(calls.slice(0, -1).every(([url]) => url.startsWith("https://gateway.test/llm-ha/v1/")));
  assert(calls.at(-1)[0].startsWith("https://platform.test/api/"));
  await assert.rejects(client.submitImage(saved.idempotencyKey, imageInput), /QUOTE_REQUIRED/);
  const invalidGateway = new CoursewareMediaClient({ baseUrl: "https://platform.test", imageBaseUrl: "https://gateway.test/v1",
    getPrincipal: () => principal, resolveAccessToken: async () => "user", fetch: async () => json(imageQueued()) });
  await assert.rejects(invalidGateway.findImage({ idempotencyKey: "scene-image-1", requestHash: hashRequest(imageInput) }), /INVALID_RESPONSE/);
});

test("gateway failure cannot submit to Platform and old receipts have only read-only recovery", async () => {
  const calls = [], principal = {};
  const client = new CoursewareMediaClient({ baseUrl: "https://platform.test", imageBaseUrl: "https://gateway.test/v1",
    getPrincipal: () => principal, resolveAccessToken: async () => "user", fetch: async (url, init) => {
      calls.push([url, init]);
      if (new URL(url).origin === "https://gateway.test") {
        if (init.method === "POST") return new Response("missing", { status: 404 });
        return new Response(JSON.stringify({ code: 46006 }), { headers: { "content-type": "application/json" } });
      }
      assert.notEqual(init.method, "POST"); return json(imageQueued());
    } });
  await assert.rejects(client.submitConfirmedImage("scene-image-1", imageInput, imageQuote()), /HTTP_404/);
  assert.equal(calls.length, 1);
  const found = await client.findImage({ idempotencyKey: "scene-image-1", requestHash: hashRequest(imageInput) });
  assert.equal(found.taskId, "task-1");
  await client.getImage(reference(found));
  assert(calls.slice(1).every(([, init]) => init.method !== "POST"));
  assert(calls.at(-1)[0].startsWith("https://platform.test/"));
});

test("confirmed reference generation sends exact reviewed PNG bytes and the shared UTF-16 hash fixture", async () => {
  const bytesBase64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLttAAAAABJRU5ErkJggg==";
  const referenceImage = { sha256: "d8aeb7b31114535bbf9035568464d5eb3dadfabaa70525a487d2c04571203426", mimeType: "image/png", byteLength: 70, bytesBase64 };
  const body = { ...imageInput, referenceImage }, hash = "d7ebe81a655cdb742f9b5dceee3a2419a0fbe7e49ce73dde29bad23496987881";
  assert.equal(hashRequest(imageInput), "44ecfadd1f67a10194854070a668f25f21da00c98905a78465c6f68bc4523da5");
  assert.equal(hashRequest(body), hash);
  const f = setup(async url => json(url.endsWith("models?kind=image") ?
    [{ model: imageInput.model, voices: [], providerDefaultVoice: false, supportsReferenceImage: true }] :
    url.includes("/quote?") ? imageQuote() : { ...imageQueued(), requestHash: hash }));
  const quote = await f.client.getImageQuote(imageInput.model);
  assert(f.calls.every(([, init]) => init.body === undefined), "quote does not transport a reference");
  const task = await f.client.submitConfirmedImage("scene-image-1", body, quote);
  assert.equal(task.requestHash, hash);
  const posts = f.calls.filter(([, init]) => init.method === "POST");
  assert.equal(posts.length, 1);
  assert.deepEqual(JSON.parse(posts[0][1].body).request, body);
  assert.equal(posts[0][1].headers.get("Idempotency-Key"), "scene-image-1");
  for (const supportsReferenceImage of [undefined, false]) {
    const unsupported = setup(async () => json([{ model: imageInput.model, voices: [], providerDefaultVoice: false,
      ...(supportsReferenceImage === undefined ? {} : { supportsReferenceImage }) }]));
    await assert.rejects(unsupported.client.submitConfirmedImage("scene-image-1", body, imageQuote()), /REFERENCE_UNSUPPORTED/);
    assert(unsupported.calls.every(([, init]) => init.body === undefined));
  }
  for (const patch of [{ sha256: "0".repeat(64) }, { byteLength: 71 }, { bytesBase64: bytesBase64 + "\n" },
    { mimeType: "image/webp" }, { mimeType: "image/jpeg" }, { byteLength: 8 * 1024 * 1024 + 1 }, { path: "/private" }]) {
    const invalid = setup();
    await assert.rejects(invalid.client.submitConfirmedImage("scene-image-1", { ...body, referenceImage: { ...referenceImage, ...patch } }, imageQuote()), /INVALID_REQUEST/);
    assert.equal(invalid.calls.length, 0);
  }
  const unconfirmed = setup();
  await assert.rejects(unconfirmed.client.submitImage("scene-image-1", body), /REFERENCE_CONFIRMATION_REQUIRED/);
  assert.equal(unconfirmed.calls.length, 0);
});

test("image catalogue, quote and confirmed submit retain kind, request pins and the quoted ceiling", async () => {
  const models = [{ model: imageInput.model, voices: [], providerDefaultVoice: false }];
  const quote = imageQuote();
  const f = setup(async (url) => json(url.endsWith("models?kind=image") ? models : url.includes("/quote?") ? quote : imageQueued()));
  assert.deepEqual(await f.client.getImageModels(), models);
  const offer = await f.client.getImageQuote(imageInput.model);
  assert.deepEqual(offer, quote);
  assert.equal(f.calls[1][0], `https://platform.test/api/backend/courseware/media/models/${imageInput.model}/quote?kind=image`);
  assert(!f.calls[1][1].method || f.calls[1][1].method === "GET");
  assert.equal(f.calls[1][1].body, undefined);
  const saved = await f.client.submitConfirmedImage("scene-image-1", imageInput, offer);
  assert.equal(saved.requestHash, hashRequest(imageInput));
  assert.equal(f.calls[2][0], "https://platform.test/api/backend/courseware/media/tasks/confirmed");
  assert.equal(f.calls[2][1].headers.get("Idempotency-Key"), "scene-image-1");
  assert.deepEqual(JSON.parse(f.calls[2][1].body), { request: imageInput,
    confirmation: { priceVersion: quote.priceVersion, maxPoints: 8, quoteToken: quote.quoteToken } });
  assert.equal(f.calls.length, 3);
});

test("reference capability lookup cannot switch the principal before private bytes are posted", async () => {
  const bytesBase64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLttAAAAABJRU5ErkJggg==";
  const body = { ...imageInput, referenceImage: { sha256: sha(Buffer.from(bytesBase64, "base64")),
    mimeType: "image/png", byteLength: 70, bytesBase64 } };
  const f = setup(async url => json(url.endsWith("models?kind=image") ?
    [{ model: imageInput.model, voices: [], providerDefaultVoice: false, supportsReferenceImage: true }] :
    { ...imageQueued(), requestHash: hashRequest(body) }));
  const models = f.client.getImageModels.bind(f.client);
  f.client.getImageModels = (...args) => models(...args).then(result => {
    f.principal({ tenantId: 1, userId: 3 }); return result;
  });
  await assert.rejects(f.client.submitConfirmedImage("scene-image-1", body, imageQuote()), /AUTH_CHANGED/);
  assert.equal(f.calls.filter(([, init]) => init.method === "POST").length, 0);
});

test("one layer-decomposition quote binds a reference hash and downloads a bundle through the private task route", async () => {
  const bytesBase64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLttAAAAABJRU5ErkJggg==";
  const body = { kind: "image-layers", model: "seedream-layers", input: "Separate foregrounds", referenceImage: {
    sha256: sha(Buffer.from(bytesBase64, "base64")), mimeType: "image/png", byteLength: 70, bytesBase64 } };
  const quote = { ...imageQuote(), kind: "image-layers", model: body.model };
  const bundle = Buffer.from(JSON.stringify({ data: [] }));
  const queued = { ...imageQueued(), kind: body.kind, model: body.model, requestHash: hashRequest(body) };
  const ready = { ...queued, state: "ready", feeState: "settled", actualPoints: 3, receiptId: `courseware-media:${queued.taskId}`,
    assetRef: { assetId: "layer-bundle", sha256: sha(bundle), mime: "application/vnd.trainwise.image-layers+json",
      byteLength: bundle.length, downloadPath: `/courseware/media/tasks/${queued.taskId}/asset` } };
  let submitted = false;
  const f = setup(async (url, init) => {
    if (url.endsWith("models?kind=image-layers")) return json([{ model: body.model, voices: [], providerDefaultVoice: false, supportsReferenceImage: true }]);
    if (url.includes("/quote?kind=image-layers")) return json(quote);
    if (init.method === "POST") { submitted = true; assert.deepEqual(JSON.parse(init.body).request, body); return json(queued); }
    if (url.endsWith("/asset")) return new Response(bundle, { headers: { "Content-Type": ready.assetRef.mime } });
    return json(ready);
  });
  const offer = await f.client.getImageQuote(body.model, undefined, "image-layers");
  await f.client.submitConfirmedImage("scene-image-1", body, offer);
  assert.equal(submitted, true);
  const downloaded = await f.client.downloadImage({ taskId: queued.taskId, idempotencyKey: queued.idempotencyKey, requestHash: queued.requestHash }, undefined, "image-layers");
  assert.deepEqual(downloaded.bytes, bundle);
  assert.equal(f.calls.filter(([, init]) => init.method === "POST").length, 1);
  await assert.rejects(f.client.submitConfirmedImage("another-key", { ...body, referenceImage: undefined }, offer), /INVALID_REQUEST|REFERENCE_REQUIRED/);
});

test("image pricing rejects foreign, stale and malformed offers before any paid POST", async () => {
  for (const patch of [{ kind: "tts" }, { model: "other" }, { priceVersion: "" }, { maxPoints: 0 },
    { maxPoints: 1.5 }, { maxChars: 4001 }, { expiresAt: "bad" }, { expiresAt: "2000-01-01T00:00:00Z" },
    { quoteToken: "123." + "a".repeat(43) }, { accountRef: "private" }]) {
    const f = setup(async () => json({ ...imageQuote(), ...patch }));
    await assert.rejects(f.client.getImageQuote(imageInput.model), /INVALID_RESPONSE|QUOTE_EXPIRED/);
    await assert.rejects(f.client.submitConfirmedImage("scene-image-1", imageInput, { ...imageQuote(), ...patch }), /INVALID_RESPONSE|QUOTE_EXPIRED/);
    assert.equal(f.calls.length, 1);
  }
  const f = setup();
  for (const request of [{ ...imageInput, apiKey: "private" }, { ...imageInput, voice: "teacher" },
    { ...imageInput, input: "\ud800" }, { ...imageInput, input: " " }]) {
    await assert.rejects(f.client.submitConfirmedImage("scene-image-1", request, imageQuote()), /INVALID_REQUEST/);
  }
  await assert.rejects(f.client.submitConfirmedImage("scene-image-1", imageInput, { ...imageQuote(), maxChars: 1 }), /INVALID_REQUEST/);
  await assert.rejects(f.client.submitConfirmedImage("../key", imageInput, imageQuote()), /INVALID_KEY/);
  await assert.rejects(f.client.getImageQuote("../model"), /INVALID_REQUEST/);
  assert.equal(f.calls.length, 0);
  for (const models of [[{ model: imageInput.model, voices: ["teacher"], providerDefaultVoice: false }],
    [{ model: imageInput.model, voices: [], providerDefaultVoice: true }],
    [{ model: imageInput.model, voices: [], providerDefaultVoice: false, apiKey: "private" }]]) {
    const invalid = setup(async () => json(models));
    await assert.rejects(invalid.client.getImageModels(), /INVALID_RESPONSE/);
  }
  const excessive = setup(async () => json({ ...imageQueued(), reservedPoints: 9 }));
  await assert.rejects(excessive.client.submitConfirmedImage("scene-image-1", imageInput, imageQuote()), /INVALID_RESPONSE/);
  const changed = setup(async () => { changed.principal({ tenantId: 1, userId: 3 }); return json(imageQuote()); });
  await assert.rejects(changed.client.getImageQuote(imageInput.model), /AUTH_CHANGED/);
});

test("confirmed quote ceiling is captured before asynchronous transport", async () => {
  for (const kind of ["tts", "image"]) {
    const offer = kind === "tts" ? { ...imageQuote(), kind, model: input.model } : imageQuote();
    const f = setup(async () => {
      offer.maxPoints = 20;
      return json(kind === "tts" ? { ...ready(), reservedPoints: 9 } : { ...imageQueued(), reservedPoints: 9 });
    });
    await assert.rejects(kind === "tts" ? f.client.submitConfirmedTts("saved-key-1", input, offer)
      : f.client.submitConfirmedImage("scene-image-1", imageInput, offer), /INVALID_RESPONSE/);
  }
});

test("lost image receipt is queried by saved key/hash without retrying submission", async () => {
  const expected = { idempotencyKey: "scene-image-1", requestHash: hashRequest(imageInput) };
  const unknown = { ...imageQueued(), state: "submission_unknown", errorCode: "SUBMISSION_UNKNOWN" };
  const f = setup(async () => json(unknown));
  assert.deepEqual(await f.client.findImage(expected), unknown);
  assert.equal(f.calls.length, 1);
  const [url, init] = f.calls[0];
  assert(url.includes("/tasks/by-idempotency?"));
  assert.equal(new URL(url).searchParams.get("key"), expected.idempotencyKey);
  assert.equal(new URL(url).searchParams.get("requestHash"), expected.requestHash);
  assert(!init.method || init.method === "GET");
  assert.equal(init.body, undefined);
  assert.equal(init.headers.has("Idempotency-Key"), false);
  for (const patch of [{ kind: "tts" }, { requestHash: "0".repeat(64) }, { idempotencyKey: "other" }]) {
    const swapped = setup(async () => json({ ...unknown, ...patch }));
    await assert.rejects(swapped.client.findImage(expected), /INVALID_RESPONSE/);
    assert.equal(swapped.calls.length, 1);
  }
  const missing = setup(async () => new Response(JSON.stringify({ code: 46006, message: "TASK_NOT_FOUND" }),
    { headers: { "content-type": "application/json" } }));
  assert.equal(await missing.client.findImage(expected), null);
  assert.equal(missing.calls.length, 1);
  const unavailable = setup(async () => new Response("", { status: 404 }));
  await assert.rejects(unavailable.client.findImage(expected), /HTTP_404/);
  assert.equal(unavailable.calls.length, 1);
  const changed = setup(async () => { changed.principal({ tenantId: 1, userId: 3 }); return json(unknown); });
  await assert.rejects(changed.client.findImage(expected), /AUTH_CHANGED/);
  await assert.rejects(f.client.findImage({ ...expected, path: "/elsewhere" }), /INVALID_TASK_REF/);
  assert.equal(f.calls.length, 1);
});

test("review metadata uses the authenticated team asset path and rejects swapped references", async () => {
  const ref = JSON.parse(await fs.readFile(new URL("../../../packages/shared/src/courseware-contract.fixtures/team-image.json", import.meta.url), "utf8")).data;
  let response = structuredClone(ref);
  const f = setup(async () => json(response));
  assert.deepEqual(await f.client.getTeamAsset(ref.projectId, ref.assetRef.assetId), ref);
  assert.equal(f.calls[0][0], `https://platform.test/api/backend/courseware/team/projects/${ref.projectId}/assets/${ref.assetRef.assetId}`);
  assert.match(f.calls[0][1].headers.get("Authorization"), /^Bearer private-access-/);
  for (const [projectId, assetId] of [["../other", ref.assetRef.assetId], [ref.projectId, "not-an-id"]]) {
    await assert.rejects(f.client.getTeamAsset(projectId, assetId), /INVALID_TEAM_ASSET_REF/);
  }
  assert.equal(f.calls.length, 1);
  response = { ...ref, projectId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa" };
  await assert.rejects(f.client.getTeamAsset(ref.projectId, ref.assetRef.assetId), /INVALID_RESPONSE/);
  response = { ...ref, assetRef: { ...ref.assetRef, assetId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa" } };
  await assert.rejects(f.client.getTeamAsset(ref.projectId, ref.assetRef.assetId), /INVALID_RESPONSE/);
});

test("team project listing is authenticated, bounded and strictly validated", async () => {
  const projects = [{ projectId: "project-1", ownerUserId: 2, role: "OWNER", createdAt: "2026-10-22T10:00:00Z" }];
  const f = setup(async (url) => {
    assert.equal(url, "https://platform.test/api/backend/courseware/team/projects");
    return json(projects);
  });
  assert.deepEqual(await f.client.getTeamProjects(), projects);
  assert.match(f.calls[0][1].headers.get("Authorization"), /^Bearer private-access-/);
  for (const value of [
    [{ ...projects[0], role: "ADMIN" }], [{ ...projects[0], apiKey: "secret" }],
    [{ ...projects[0], createdAt: "bad" }], { projectId: "project-1" },
  ]) {
    const invalid = setup(async () => json(value));
    await assert.rejects(invalid.client.getTeamProjects(), /INVALID_RESPONSE/);
  }
});

test("team project creation accepts only an authenticated UUID response", async () => {
  const projectId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const f = setup(async (url, init) => {
    assert.equal(url, "https://platform.test/api/backend/courseware/team/projects");
    assert.equal(init.method, "POST");
    assert.equal(init.body, "{}");
    return json({ projectId });
  });
  assert.equal(await f.client.createTeamProject(), projectId);
  const changed = setup(async () => { changed.principal({ tenantId: 1, userId: 3 }); return json({ projectId }); });
  await assert.rejects(changed.client.createTeamProject(), /AUTH_CHANGED/);
  for (const value of [{ projectId: "not-a-uuid" }, { projectId, extra: true }, projectId]) {
    const invalid = setup(async () => json(value));
    await assert.rejects(invalid.client.createTeamProject(), /INVALID_RESPONSE/);
  }
});

test("owner member grant and revoke use strict authenticated endpoints", async () => {
  const projectId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const f = setup(async (url, init) => {
    assert.equal(init.method, init.body === undefined ? "DELETE" : "PUT");
    assert.ok(url.includes("courseware/team/projects/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/members"));
    return json(null);
  });
  await f.client.grantTeamMember(projectId, 7, "EDITOR");
  assert.deepEqual(JSON.parse(f.calls[0][1].body), { userId: 7, role: "EDITOR" });
  await f.client.revokeTeamMember(projectId, 7);
  for (const args of [["bad", 7, "VIEWER"], [projectId, 0, "VIEWER"], [projectId, 7, "OWNER"]]) await assert.rejects(f.client.grantTeamMember(...args), /INVALID_TEAM_MEMBER/);
  await assert.rejects(f.client.revokeTeamMember(projectId, 0), /INVALID_TEAM_MEMBER/);
  const malformed = setup(async () => json({ ok: true }));
  await assert.rejects(malformed.client.grantTeamMember(projectId, 7, "VIEWER"), /INVALID_RESPONSE/);
});

test("team fixed playback keeps signed URLs in Main and verifies bounded file downloads", async () => {
  const projectId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const blobs = {
    "manifest.json": Buffer.from("manifest"),
    "package.json": Buffer.from("package"),
    "report.json": Buffer.from("report"),
    "source.pptx": Buffer.from("pptx"),
  };
  const buildId = sha(blobs["package.json"]);
  const snapshotId = "snapshot-1";
  const pointer = { projectId, channel: "shared", buildId, snapshotId, packageSha256: buildId, version: 1 };
  const files = Object.entries(blobs).map(([path, bytes]) => ({ file: {
    path, sha256: sha(bytes), byteLength: bytes.length,
    mimeType: path === "source.pptx" ? "application/vnd.openxmlformats-officedocument.presentationml.presentation" : "application/json",
  }, downloadUrl: `https://bucket.oss-cn-hangzhou.aliyuncs.com/${path}?signature=fixture` }));
  const playback = { pointer, fixedBuild: { build: { buildId, snapshotId, packageSha256: buildId },
    manifestSha256: sha(blobs["manifest.json"]), files, expiresAt: new Date(Date.now() + 60_000).toISOString() } };
  const f = setup(async (url, init) => {
    if (url === `https://platform.test/api/backend/courseware/team/projects/${projectId}/publish/shared/fixed-playback`) return json(playback);
    const file = files.find(({ downloadUrl }) => downloadUrl === url)?.file;
    assert(file);
    assert.equal(init.headers.Authorization, undefined);
    assert.equal(init.credentials, "omit");
    assert.equal(init.redirect, "error");
    return new Response(blobs[file.path], { headers: { "content-type": file.mimeType, "content-length": String(file.byteLength) } });
  });
  const selected = await f.client.getTeamFixedPlayback(projectId);
  assert.deepEqual(selected.pointer, pointer);
  assert.deepEqual(await f.client.downloadTeamFixedFile(selected, "source.pptx"), blobs["source.pptx"]);
  await assert.rejects(f.client.downloadTeamFixedFile(selected, "../../etc/passwd"), /INVALID_TEAM_FILE/);
  selected.fixedBuild.expiresAt = "2000-01-01T00:00:00Z";
  assert.deepEqual(await f.client.downloadTeamFixedFile(selected, "report.json"), blobs["report.json"]);
  assert.equal(f.calls.length, 4);
  assert.match(f.calls[0][1].headers.get("Authorization"), /^Bearer private-access-/);
  assert.match(f.calls[2][1].headers.get("Authorization"), /^Bearer private-access-/);
  assert(!JSON.stringify(selected).includes("private-access"));
  f.principal({ tenantId: 1, userId: 3 });
  await assert.rejects(f.client.downloadTeamFixedFile(selected, "report.json"), /AUTH_CHANGED/);

  const forged = structuredClone(playback);
  forged.fixedBuild.files[0].downloadUrl = "https://127.0.0.1/admin?signature=forged";
  const rejected = setup(async () => json(forged));
  await assert.rejects(rejected.client.getTeamFixedPlayback(projectId), /INVALID_RESPONSE/);
  assert.equal(rejected.calls.length, 1);
  await assert.rejects(f.client.getTeamFixedPlayback(projectId, "invalid"), /INVALID_TEAM_CHANNEL/);
});

test("fixed build sharing uploads multipart bytes then publishes with the current pointer version", async () => {
  const projectId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const snapshotId = "snapshot-1";
  const buildId = "b".repeat(64);
  const upload = { manifestHash: "c".repeat(64), manifestBytes: Buffer.from("manifest"),
    files: [{ path: "package.json", sha256: buildId, bytes: Buffer.from("package") },
      { path: "source.pptx", sha256: "d".repeat(64), bytes: Buffer.from("pptx") },
      { path: "report.json", sha256: "e".repeat(64), bytes: Buffer.from("report") }] };
  let multipart;
  let pointerVersion = 3;
  let currentBuild = "a".repeat(64);
  let currentSnapshot = "old-snapshot";
  const f = setup(async (url, init) => {
    if (url.includes("/fixed-builds?")) {
      multipart = init;
      return json({ buildId, snapshotId, packageSha256: buildId });
    }
    if (url.endsWith("/publish/shared")) return json({ projectId, channel: "shared", buildId: currentBuild, snapshotId: currentSnapshot,
      packageSha256: currentBuild, version: pointerVersion });
    pointerVersion++;
    currentBuild = buildId;
    currentSnapshot = snapshotId;
    return json({ projectId, channel: "shared", buildId, snapshotId, packageSha256: buildId, version: pointerVersion });
  });
  await f.client.uploadAndPublishFixedBuild(projectId, snapshotId, buildId, upload);
  assert.equal(multipart.method, "POST");
  assert.equal(multipart.headers.get("Content-Type"), null);
  assert.ok(multipart.body instanceof FormData);
  assert.equal(multipart.body.get("manifest").name, "manifest.json");
  assert.deepEqual(multipart.body.getAll("files").map((file) => file.name), ["package.json", "source.pptx", "report.json"]);
  assert.deepEqual(Buffer.from(await multipart.body.getAll("files")[1].arrayBuffer()), Buffer.from("pptx"));
  assert.equal(f.calls.length, 3);
  assert.equal(f.calls[2][1].method, "POST");
  assert.deepEqual(JSON.parse(f.calls[2][1].body), { channel: "shared", buildId, expectedVersion: 3 });
  assert.ok(f.calls.every(([, init]) => init.headers.get("Authorization").startsWith("Bearer ")));
  await f.client.uploadAndPublishFixedBuild(projectId, snapshotId, buildId, upload);
  assert.equal(f.calls.length, 5);
  const conflict = setup(async (url) => url.includes("/fixed-builds?") ? json({ buildId, snapshotId, packageSha256: buildId }) :
    url.endsWith("/publish/shared") ? json({ projectId, channel: "shared", buildId: null, snapshotId: null, packageSha256: null, version: 3 }) :
      json({ projectId, channel: "shared", buildId, snapshotId, packageSha256: buildId, version: 9 }));
  await assert.rejects(conflict.client.uploadAndPublishFixedBuild(projectId, snapshotId, buildId, upload), /INVALID_RESPONSE/);
});

test("formal fixed build publishing stays on the formal pointer and rejects unknown channels", async () => {
  const projectId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const snapshotId = "snapshot-formal";
  const buildId = "f".repeat(64);
  const upload = { manifestHash: "c".repeat(64), manifestBytes: Buffer.from("manifest"), files: [
    { path: "package.json", sha256: buildId, bytes: Buffer.from("package") },
    { path: "source.pptx", sha256: "d".repeat(64), bytes: Buffer.from("pptx") },
    { path: "report.json", sha256: "e".repeat(64), bytes: Buffer.from("report") },
  ] };
  const f = setup(async (url) => url.includes("/fixed-builds?") ? json({ buildId, snapshotId, packageSha256: buildId }) :
    url.endsWith("/publish/formal") ? json({ projectId, channel: "formal", buildId: null, snapshotId: null, packageSha256: null, version: 0 }) :
    json({ projectId, channel: "formal", buildId, snapshotId, packageSha256: buildId, version: 1 }));
  await f.client.uploadAndPublishFixedBuild(projectId, snapshotId, buildId, upload, "formal");
  assert.match(f.calls[1][0], /\/publish\/formal$/);
  assert.deepEqual(JSON.parse(f.calls[2][1].body), { channel: "formal", buildId, expectedVersion: 0 });
  await assert.rejects(f.client.uploadAndPublishFixedBuild(projectId, snapshotId, buildId, upload, "invalid"), /INVALID_TEAM_CHANNEL/);
});

test("submit/query/download uses the authenticated finite path and preserves caller's idempotency key", async () => {
  const f = setup(async (url) => url.endsWith("/asset") ? new Response(audio, { headers: { "content-type": "audio/wav", "content-length": String(audio.length) } }) : json(ready()));
  const task = await f.client.submitTts("saved-key-1", input);
  assert.deepEqual(reference(task), reference());
  const downloaded = await f.client.download(reference(task));
  assert.deepEqual(downloaded.bytes, audio);
  assert.equal(f.calls.length, 3);
  for (const [url, init] of f.calls) {
    assert(url.startsWith("https://platform.test/api/backend/courseware/media/tasks"));
    assert.match(init.headers.get("Authorization"), /^Bearer private-access-/);
    assert.equal(init.redirect, "error"); assert.equal(init.credentials, "omit"); assert.equal(init.cache, "no-store");
  }
  assert.equal(f.calls[0][1].headers.get("Idempotency-Key"), "saved-key-1");
  assert.deepEqual(JSON.parse(f.calls[0][1].body), input);
  assert(!JSON.stringify(task).includes("private-access"));
});

test("lost-ID lookup is read-only, validates saved key/hash and never falls back to submission", async () => {
  const expected = { idempotencyKey: reference().idempotencyKey, requestHash: reference().requestHash };
  const unknown = { ...ready(), state: "submission_unknown", feeState: "reserved", actualPoints: null,
    receiptId: null, errorCode: "SUBMISSION_UNKNOWN", assetRef: null };
  const f = setup(async () => json(unknown));
  assert.deepEqual(await f.client.findTts(expected), unknown);
  const [url, init] = f.calls[0];
  assert.equal(new URL(url).pathname, "/api/backend/courseware/media/tasks/by-idempotency");
  assert.equal(new URL(url).searchParams.get("key"), expected.idempotencyKey);
  assert.equal(new URL(url).searchParams.get("requestHash"), expected.requestHash);
  assert.equal(init.method ?? "GET", "GET"); assert.equal(init.body, undefined);
  assert.equal(init.headers.has("Idempotency-Key"), false);
  assert.match(init.headers.get("Authorization"), /^Bearer private-access-/);
  for (const patch of [{ requestHash: "0".repeat(64) }, { idempotencyKey: "foreign" }, { kind: "image" }]) {
    const swapped = setup(async () => json({ ...unknown, ...patch }));
    await assert.rejects(swapped.client.findTts(expected), /INVALID_RESPONSE/);
  }
  for (const invalid of [{ ...expected, requestHash: "bad" }, { ...expected, idempotencyKey: "bad/key" }, { ...expected, taskId: "forged" }])
    await assert.rejects(f.client.findTts(invalid), /INVALID_TASK_REF/);
  assert.equal(f.calls.length, 1);
  const missing = setup(async () => new Response(JSON.stringify({ code: 46006, message: "TASK_NOT_FOUND" }), { headers: { "content-type": "application/json" } }));
  assert.equal(await missing.client.findTts(expected), null);
  const unavailable = setup(async () => new Response("", { status: 404 }));
  await assert.rejects(unavailable.client.findTts(expected), /HTTP_404/);
  let changed;
  changed = setup(async () => { changed.principal({ userId: 99 }); return json(unknown); });
  await assert.rejects(changed.client.findTts(expected), /AUTH_CHANGED/);
  for (const sample of [f, missing, unavailable, changed]) assert(sample.calls.every(([, request]) => (request.method ?? "GET") === "GET"));
});

test("the actual C Spring response and its Java request hash are accepted byte-for-byte", async () => {
  const fixture = JSON.parse(await fs.readFile(new URL("fixtures/courseware-media-ready.json", import.meta.url), "utf8"));
  const actualInput = { kind: "tts", model: "courseware-tts-v1", input: "c1 local smoke", voice: "alloy" };
  assert.equal(hashRequest(actualInput), fixture.requestHash);
  const f = setup(async (url) => url.endsWith("/asset") ? new Response("fake-mp3", { headers: { "content-type": "audio/mpeg" } }) : json(fixture));
  assert.deepEqual(await f.client.submitTts(fixture.idempotencyKey, actualInput), fixture);
  assert.equal((await f.client.download(reference(fixture))).bytes.toString(), "fake-mp3");
});

test("image tasks use the same private idempotent route and verify archived PNG bytes", async () => {
  const imageInput = { kind: "image", model: "team-image", input: "两个孩子挥手" };
  const bytes = await fs.readFile(new URL("fixtures/courseware-team-image.png", import.meta.url));
  const imageTask = { ...ready(), kind: "image", idempotencyKey: "scene-image-1", requestHash: hashRequest(imageInput), model: imageInput.model,
    assetRef: { assetId: "image-1", sha256: sha(bytes), mime: "image/png", byteLength: bytes.length,
      downloadPath: "/courseware/media/tasks/task-1/asset", width: 1, height: 1 } };
  const f = setup(async (url) => url.endsWith("/asset")
    ? new Response(bytes, { headers: { "content-type": "image/png" } }) : json(imageTask));
  const submitted = await f.client.submitImage("scene-image-1", imageInput);
  assert.equal(submitted.kind, "image");
  const downloaded = await f.client.downloadImage(reference(submitted));
  assert.deepEqual(downloaded.bytes, bytes);
  assert.equal(f.calls.length, 3);
  assert.deepEqual(JSON.parse(f.calls[0][1].body), imageInput);
  assert.equal(f.calls[0][1].headers.get("Idempotency-Key"), "scene-image-1");
  assert(!JSON.stringify(submitted).includes("private-access"));
  await assert.rejects(f.client.submitImage("bad", { ...imageInput, apiKey: "secret" }), /INVALID_REQUEST/);
  assert.equal(f.calls.length, 3);
});

test("invalid, forged, image and malformed Unicode requests never reach the network", async () => {
  const f = setup();
  for (const value of [{ ...input, apiKey: "secret" }, { ...input, tenantId: 1 }, { ...input, kind: "image" },
    { ...input, input: " " }, { ...input, input: "a".repeat(4001) }, { ...input, input: "\ud800" }, { ...input, voice: "x/y" }]) {
    await assert.rejects(f.client.submitTts("key", value), /INVALID_REQUEST/);
  }
  for (const key of ["", "a".repeat(97), "key\r\n", 5]) await assert.rejects(f.client.submitTts(key, input), /INVALID_KEY/);
  for (const ref of [{ ...reference(), taskId: "../elsewhere" }, { ...reference(), taskId: ".." }, { ...reference(), path: "/etc/passwd" }]) await assert.rejects(f.client.get(ref));
  assert.equal(f.calls.length, 0);
  for (const url of ["http://remote.test", "ftp://localhost", "https://a:b@server.test", "https://server.test?key=secret"]) assert.throws(() => new CoursewareMediaClient({ baseUrl: url }), /INVALID_BASE_URL/);
});

test("strict server responses cannot swap task/request/model, download origins, asset bytes or MIME", async () => {
  let response = ready();
  const f = setup(async () => json(response));
  const original = ready();
  for (const mutation of [
    { taskId: "other-task" }, { requestHash: "f".repeat(64) }, { idempotencyKey: "other-key" }, { kind: "image" },
    { version: "v2" }, { reservedPoints: -1 }, { actualPoints: 6 }, { feeState: "reserved" }, { receiptId: null },
    { assetRef: { ...original.assetRef, downloadPath: "https://outside.test/audio" } },
    { assetRef: { ...original.assetRef, byteLength: 16777217 } }, { assetRef: { ...original.assetRef, mime: "text/html" } },
    { assetRef: { ...original.assetRef, path: "/etc/passwd" } }, { providerKey: "server-secret" },
  ]) { response = { ...original, ...mutation }; await assert.rejects(f.client.get(reference()), /INVALID_RESPONSE/); }
  response = { ...original, model: "different-model" };
  await assert.rejects(f.client.submitTts("saved-key-1", input), /INVALID_RESPONSE/);
  response = original;
  for (const [bytes, mime] of [[Buffer.from("wrong"), "audio/wav"], [audio, "audio/mpeg"]]) {
    const corrupt = setup(async (url) => url.endsWith("/asset") ? new Response(bytes, { headers: { "content-type": mime } }) : json(original));
    await assert.rejects(corrupt.client.download(reference()), /INTEGRITY_ERROR/);
  }
});

test("unknown and archive failure stay queryable; download failure never submits or silently regenerates", async () => {
  let state = "submission_unknown";
  const f = setup(async () => json({ ...ready(), state, assetRef: null, errorCode: state.toUpperCase(),
    ...(state === "submission_unknown" ? { feeState: "reserved", actualPoints: null, receiptId: null } : {}) }));
  assert.equal((await f.client.get(reference())).state, "submission_unknown");
  await assert.rejects(f.client.download(reference()), /ASSET_NOT_READY/);
  state = "archive_failed";
  assert.equal((await f.client.get(reference())).state, "archive_failed");
  assert(f.calls.every(([, init]) => !init.method));
  for (const code of [46000, 46002, 46003, 46005, 46006, 46007, 46008, 46009, 46010]) {
    const failure = setup(async () => new Response(JSON.stringify({ code, message: "secret provider details" }), { headers: { "content-type": "application/json" } }));
    await assert.rejects(failure.client.get(reference()), new RegExp(`PLATFORM_${code}$`));
    assert.equal(failure.calls.length, 1);
  }
});

test("unsigned/malformed envelopes, wrong HTTP content and streamed overflow reject with bounded reads", async () => {
  let cancelled = false;
  const cases = [
    () => new Response("not-json", { headers: { "content-type": "application/json" } }),
    () => new Response(JSON.stringify({ data: ready() }), { headers: { "content-type": "application/json" } }),
    () => new Response("<html>login</html>", { headers: { "content-type": "text/html" } }),
    () => new Response(null, { status: 401 }),
    () => new Response("x", { headers: { "content-length": "100000000", "content-type": "application/json" } }),
    () => new Response(new ReadableStream({ start(c) { c.enqueue(new Uint8Array(65537)); }, cancel() { cancelled = true; } }), { headers: { "content-type": "application/json" } }),
    () => new Response(new ReadableStream({ start(c) { c.enqueue(new Uint8Array(65537)); }, cancel() { throw new Error("Bearer private-stream-token"); } }), { headers: { "content-type": "application/json" } }),
  ];
  for (const response of cases) {
    const f = setup(response);
    await assert.rejects(f.client.get(reference()), /COURSEWARE_MEDIA_(INVALID_RESPONSE|HTTP_401|RESPONSE_TOO_LARGE)/);
    assert.equal(f.calls.length, 1);
  }
  assert.equal(cancelled, true);
});

test("signed out, late sign-out/account changes and cancellation reject without exposing token or late bytes", async () => {
  const signedOut = setup(); signedOut.principal(null);
  await assert.rejects(signedOut.client.get(reference()), /AUTH_REQUIRED/); assert.equal(signedOut.calls.length, 0);
  let release;
  const f = setup(async () => new Promise((resolve) => { release = resolve; }));
  const pending = f.client.get(reference());
  await new Promise((resolve) => setImmediate(resolve));
  f.principal({ tenantId: 1, userId: 3 }); release(json(ready()));
  await assert.rejects(pending, /AUTH_CHANGED/);
  const aborted = new AbortController(); aborted.abort();
  const untouched = setup(); await assert.rejects(untouched.client.get(reference(), aborted.signal));
  assert.equal(untouched.calls.length, 0);
  const failed = setup(async () => { throw new Error("network error https://user:secret@server.test Bearer token-secret"); });
  await assert.rejects(failed.client.submitTts("saved-key-1", input), /^Error: COURSEWARE_MEDIA_TRANSPORT_FAILED$/);
  assert.equal(failed.calls.length, 1);
  const principal = {};
  const refreshFailure = new CoursewareMediaClient({ baseUrl: "https://platform.test", getPrincipal: () => principal,
    resolveAccessToken: async () => { throw new Error("refresh failed Bearer private-refresh-token"); },
    fetch: async () => { assert.fail("Failed authentication must not dispatch"); } });
  await assert.rejects(refreshFailure.get(reference()), /^Error: COURSEWARE_MEDIA_AUTH_REQUIRED$/);
});

test("real HTTP redirects do not forward credentials or repeat a submission", async (t) => {
  let targetCalls = 0, submits = 0;
  const target = createServer((_req, res) => { targetCalls++; res.end(); });
  target.listen(0, "127.0.0.1"); await once(target, "listening");
  const server = createServer((_req, res) => { submits++; res.writeHead(307, { Location: `http://127.0.0.1:${target.address().port}/steal` }); res.end(); });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(() => { server.closeAllConnections(); target.closeAllConnections(); server.close(); target.close(); });
  const principal = {};
  const client = new CoursewareMediaClient({ baseUrl: `http://127.0.0.1:${server.address().port}`, fetch: transportFetch,
    getPrincipal: () => principal, resolveAccessToken: async () => "private" });
  await assert.rejects(client.submitTts("saved-key-1", input), /TRANSPORT_FAILED/);
  assert.equal(submits, 1); assert.equal(targetCalls, 0);
});

test("actual DesktopAuthSession login, private transport, restart/replay and logout over real loopback HTTP", async (t) => {
  const root = await fs.mkdtemp(path.join(tmpdir(), "deckwise-media-auth-"));
  let submissions = 0, charges = 0;
  const stored = new Map(), requests = [], relayAudio = Buffer.from([73,68,51,4,0,0,0,0,0,0,1,2]);
  const token = `header.${Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600 })).toString("base64url")}.signature`;
  const server = createServer(async (req, res) => {
    let body = ""; for await (const chunk of req) body += chunk;
    requests.push({ url: req.url, method: req.method, auth: req.headers.authorization });
    const send = (data, code = 200) => { res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ code, data })); };
    if (req.url.startsWith("/auth/desktop/wx/qrcode")) return send({ ticket: "ticket-1", entryUrl: "https://fixture.test/qr" });
    if (req.url === "/auth/wx/poll/ticket-1" || req.url === "/auth/desktop/refresh") return send({ status: "SUCCESS", accessToken: token, refreshToken: "fixture-refresh" });
    if (req.url === "/auth/me") return send({ edition: "EDUCATION", pcAllowed: true, role: "ADMIN", userId: 7, tenantId: 8 });
    if (req.url === "/auth/logout") return send({});
    if (req.headers.authorization !== `Bearer ${token}`) { res.writeHead(401); return res.end(); }
    if (req.url === "/courseware/media/relay" && req.method === "POST") {
      submissions++; charges++;
      assert.equal(JSON.parse(body).request.input, input.input);
      return send({ kind: "tts", receipts: [], bytesBase64: relayAudio.toString("base64"), mime: "audio/mpeg",
        actualPoints: 1, billingReceipt: "11111111-1111-4111-8111-111111111111" });
    }
    res.writeHead(404); res.end();
  });
  const before = process.env.DECKWISE_PLATFORM_BASE_URL;
  let first, second;
  t.after(async () => {
    try { await Promise.allSettled([first?.logout(), second?.logout()]); }
    finally {
      server.closeAllConnections(); server.close();
      if (before === undefined) delete process.env.DECKWISE_PLATFORM_BASE_URL; else process.env.DECKWISE_PLATFORM_BASE_URL = before;
      await fs.rm(root, { recursive: true, force: true });
    }
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  process.env.DECKWISE_PLATFORM_BASE_URL = `http://127.0.0.1:${server.address().port}`;
  const office = await load("office-file", { "@pi-desktop/shared": shared });
  const online = await load("courseware-online-editing", { "@pi-desktop/shared": shared, "node:crypto": crypto,
    "node:util": util, "./office-file": office });
  const { DesktopAuthSession } = await load("auth-session", { "node:crypto": crypto, "node:fs/promises": fs,
    "node:os": { homedir: () => root }, "node:path": path, electron: { net: { fetch: transportFetch } }, "@pi-desktop/shared": shared,
    "./courseware-media": media, "./courseware-online-editing": online });
  const options = { dataDir: root, onChanged() {}, log() {}, mediaRelayHost: { async call(method, params) {
    const key = params.principalKey + ":" + params.key, previous = stored.get(key);
    if (method.endsWith(".read")) return structuredClone(previous ?? null);
    assert.equal(params.expectedRevision, previous?.revision ?? 0);
    const next = { revision: params.expectedRevision + 1, value: structuredClone(params.value) };
    stored.set(key, next); return structuredClone(next);
  } } };
  const quote = { version: "courseware-media-quote-v1", kind: "tts", model: input.model,
    priceVersion: "price-v1", maxPoints: 2, maxChars: 4000, expiresAt: "2099-01-01T00:00:00Z", quoteToken: "4070908800." + "a".repeat(43) };
  first = new DesktopAuthSession(options); second = new DesktopAuthSession(options);
  assert.throws(() => first.getCoursewarePrincipal(), /AUTH_REQUIRED/);
  assert.equal((await first.startQrLogin()).status, "waitingForScan");
  assert.equal((await first.pollQrLogin("ticket-1")).status, "authenticated");
  const principal = first.getCoursewarePrincipal();
  assert.match(principal.key, /^[a-f0-9]{64}$/u);
  principal.assertCurrent();
  const task = await first.coursewareMedia.submitConfirmedTts("saved-key-1", input, quote);
  assert.deepEqual((await first.coursewareMedia.download(reference(task))).bytes, relayAudio);
  assert.equal((await second.restore()).status, "authenticated");
  const recoveredPrincipal = second.getCoursewarePrincipal();
  assert.equal(recoveredPrincipal.key, principal.key);
  assert.equal((await second.coursewareMedia.get(reference(task))).taskId, task.taskId);
  assert.deepEqual((await second.coursewareMedia.download(reference(task))).bytes, relayAudio);
  assert.deepEqual(await second.coursewareMedia.submitConfirmedTts("saved-key-1", input, quote), task);
  await assert.rejects(second.coursewareMedia.submitConfirmedTts("saved-key-1", { ...input, input: "different" }, quote), /INVALID_RESPONSE/);
  assert.equal(submissions, 1); assert.equal(charges, 1);
  await second.logout();
  assert.throws(() => recoveredPrincipal.assertCurrent(), /AUTH_CHANGED/);
  assert.throws(() => second.getCoursewarePrincipal(), /AUTH_REQUIRED/);
  const count = requests.length;
  await assert.rejects(second.coursewareMedia.get(reference(task)), /AUTH_REQUIRED/);
  assert.equal(requests.length, count);
  assert(requests.filter((req) => req.url.startsWith("/courseware/")).every((req) => req.auth === `Bearer ${token}`));
});


test("video uses the quoted original task and verifies MP4 integrity on Platform", async () => {
  const input = { kind: "video", model: "scene-video", input: "小朋友😀 watches a turning square" };
  const bytes = Buffer.alloc(24); bytes.write("ftyp", 4);
  const task = { ...ready(input, "video-key"), kind: "video", assetRef: { assetId: "clip", sha256: sha(bytes), mime: "video/mp4", byteLength: bytes.length,
    downloadPath: "/courseware/media/tasks/task-1/asset" } };
  const quote = { ...imageQuote(), kind: "video", model: input.model };
  const f = setup(async url => url.endsWith("/asset") ? new Response(bytes, { headers: { "content-type": "video/mp4" } }) : json(task));
  const result = await f.client.video.submit("video-key", input, quote);
  assert.equal(result.requestHash, hashRequest(input));
  assert.deepEqual(JSON.parse(f.calls[0][1].body).request, input);
  assert.deepEqual((await f.client.video.download(reference(task))).bytes, bytes);
  assert.equal((await f.client.video.find(reference(task))).taskId, task.taskId);
  assert.equal(f.calls.filter(([, init]) => init.method === "POST").length, 1);
  assert(f.calls.every(([url]) => new URL(url).origin === "https://platform.test"));
  const invalid = setup(async url => url.endsWith("/asset") ? new Response(Buffer.alloc(24), { headers: { "content-type": "video/mp4" } }) : json(task));
  await assert.rejects(invalid.client.video.download(reference(task)), /INTEGRITY_ERROR/);
  await assert.rejects(f.client.video.submit("video-key", input, { ...quote, kind: "image" }), /INVALID_RESPONSE/);
});
