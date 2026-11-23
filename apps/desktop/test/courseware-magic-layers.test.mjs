import assert from "node:assert/strict";
import { createRequire, register } from "node:module";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { loadCoursewareMedia } from "./fixtures/courseware-media-loader.mjs";

register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const { magicLayersManifest, magicLayersBundle, planMagicLayers } = await import("../electron/main/courseware-magic-layers.ts");
const require = createRequire(new URL("../../../packages/courseware-runtime/package.json", import.meta.url));
const JSZip = require("jszip"), sharp = require("sharp");
const { CoursewareMagicLayersMedia } = await loadCoursewareMedia("courseware-magic-layers-media");
const manifest = magicLayersManifest(JSON.stringify({ objects: [{ role: "Animal", bbox: [2, 2, 4, 3], positivePoints: [[3, 3]] }] }), 16, 10);
const png = await sharp({ create: { width: 16, height: 10, channels: 4, background: "red" } }).png().toBuffer();
const layer = await sharp({ create: { width: 4, height: 3, channels: 4, background: "blue" } }).png().toBuffer();

test("vision planning uses the selected pixels and forces local extraction parameters", async () => {
  let sent;
  const result = await planMagicLayers({ sessionId: "chat", page: { title: "Animals" }, bytes: png, width: 16, height: 10,
    signal: new AbortController().signal }, { modelKey: "provider/vision" }, async input => {
    sent = input;
    return { text: JSON.stringify(manifest) };
  });
  assert.equal(sent.images[0].bytes, png);
  assert.match(sent.system, /connecting arrows/);
  assert.match(sent.system, /never leave them in the background/);
  assert.equal(result.repairPolicy, "extract_only");
  assert.equal(result.pipelineRevision, 2);
  assert.deepEqual(result.objects[0].bbox, [2, 2, 4, 3]);
  for (const object of [
    { role: "Bad", bbox: [0, 0, 17, 10], positivePoints: [[1, 1]] },
    { role: "Bad", bbox: [2, 2, 4, 3], positivePoints: [[0, 0]] },
    { role: "Bad", bbox: [2, 2, 4, 3], positivePoints: [] },
  ]) assert.throws(() => magicLayersManifest(JSON.stringify({ objects: [object] }), 16, 10));
});

async function resultZip(change = () => {}) {
  const zip = new JSZip();
  const result = { canvas: { width: 16, height: 10 }, resultStatus: "complete",
    layers: [{ id: "object-1", file: "001.png", bbox: [2, 2, 4, 3], zIndex: 1 }],
    targets: [{ id: "object-1", status: "succeeded" }], cleanPlate: { status: "generated", method: "big_lama", file: "plate.png" } };
  change(result, zip);
  zip.file("manifest.json", JSON.stringify(result));
  zip.file("plate.png", png); zip.file("001.png", layer);
  return zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
}

test("local crops map to original slide bounds and retain their original bytes", async () => {
  const value = JSON.parse((await magicLayersBundle(await resultZip(), manifest, 16, 10)).toString());
  assert.equal(value.data[0].b64_json, png.toString("base64"));
  assert.equal(value.data[1].b64_json, layer.toString("base64"));
  assert.deepEqual(value.data[1].bounding_box.normalized, [125, 200, 375, 500]);
});

test("partial output, review flags, placeholders, forged bounds and unsafe ZIP names cannot compile", async () => {
  for (const change of [
    result => { result.resultStatus = "partial"; result.targets[0] = { id: "object-1", status: "failed", error: { code: "segmentation_empty" } }; },
    result => { result.cleanPlate.reviewRequired = true; },
    result => { result.cleanPlate.method = "source_unchanged"; },
    result => { result.layers[0].placeholder = true; },
    result => { result.layers[0].bbox = [15, 2, 4, 3]; },
    (result, zip) => { zip.file("../outside.png", layer); },
    result => { result.layers[0].bbox = [2, 2, 3, 3]; },
  ]) await assert.rejects(magicLayersBundle(await resultZip(change), manifest, 16, 10), /MAGICLAYERS/);
});

function fixture() {
  const store = new Map(), calls = [];
  let job = null, posts = 0, plans = 0, losePost = false, fail = false, principal = {};
  const options = { baseUrl: "https://platform.test/v1", imageBaseUrl: "https://gateway.test/v1",
    getPrincipal: () => principal, resolveAccessToken: async () => "user-token",
    relayJournal: async (method, key, value, expected) => {
      if (method === "read") return structuredClone(store.get(key) ?? null);
      assert.equal(store.get(key)?.revision ?? 0, expected);
      const row = { revision: expected + 1, value: structuredClone(value) }; store.set(key, row); return structuredClone(row);
    }, fetch: async (url, init) => {
      calls.push([url, init]);
      if (init.method === "POST") {
        posts++;
        assert.equal(init.headers.get("Authorization"), "Bearer user-token");
        assert(init.body instanceof FormData);
        assert.deepEqual(JSON.parse(init.body.get("manifest")), manifest);
        job = { id: "a".repeat(32), status: fail ? "failed" : "succeeded", error: fail ? "RuntimeError: exact local failure" : null };
        if (losePost) { losePost = false; throw new Error("lost response"); }
        return new Response(JSON.stringify({ jobId: job.id, status: job.status }), { status: 202, headers: { "content-type": "application/json" } });
      }
      if (!job) return new Response('{"detail":"job not found"}', { status: 404, headers: { "content-type": "application/json" } });
      return url.endsWith("/result") ? new Response("PK-result", { headers: { "content-type": "application/zip" } })
        : new Response(JSON.stringify(job), { headers: { "content-type": "application/json" } });
    } };
  const input = { key: randomUUID(), requestHash: "b".repeat(64), sourceSha256: "c".repeat(64), image: png,
    signal: new AbortController().signal, check: async () => {}, plan: async () => { plans++; return manifest; } };
  return { input, calls, options, create: () => new CoursewareMagicLayersMedia(options),
    posts: () => posts, plans: () => plans, lose: () => { losePost = true; }, fail: () => { fail = true; },
    changePrincipal: () => { principal = {}; } };
}

test("a lost submit response resumes the same local job after recreation without another POST or LLM call", async () => {
  const f = fixture(); f.lose();
  await assert.rejects(f.create().split(f.input), /TRANSPORT_FAILED/);
  const recovered = await f.create().split(f.input);
  assert.equal(recovered.bytes.toString(), "PK-result");
  assert.equal(f.posts(), 1); assert.equal(f.plans(), 1);
  assert(f.calls.every(([url]) => url.startsWith("https://gateway.test/v1/courseware/media/magiclayers/jobs/")));
  await assert.rejects(f.create().split({ ...f.input, sourceSha256: "d".repeat(64) }), /SOURCE_CHANGED/);
});

test("concurrent callers share one fallback, and final local failure never restarts inference", async () => {
  const f = fixture(); f.fail();
  const results = await Promise.allSettled([f.create().split(f.input), f.create().split(f.input)]);
  assert(results.every(result => result.status === "rejected" && /exact local failure/.test(String(result.reason))));
  await assert.rejects(f.create().split(f.input), /exact local failure/);
  assert.equal(f.posts(), 1); assert.equal(f.plans(), 1);
});

test("project scope reaches relay paths and a changed plan stops before network activity", async () => {
  const f = fixture();
  await f.create().split({ ...f.input, projectId: "00000000-0000-4000-8000-000000000002" });
  assert(f.calls.every(([url]) => url.includes("/team/projects/00000000-0000-4000-8000-000000000002/media/magiclayers/")));
  const blocked = fixture();
  await assert.rejects(blocked.create().split({ ...blocked.input, check: async () => { throw new Error("plan changed"); } }), /plan changed/);
  assert.equal(blocked.calls.length, 0);
});

test("HTTP error bodies survive client diagnostics without another supplier submission", async () => {
  const f = fixture();
  f.options.fetch = async () => new Response('{"detail":"queue capacity exhausted"}', { status: 429, headers: { "content-type": "application/json" } });
  await assert.rejects(f.create().split(f.input), /HTTP_429.*queue capacity exhausted/);
  assert.equal(f.posts(), 0);
});
