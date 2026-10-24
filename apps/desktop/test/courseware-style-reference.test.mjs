import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import test from "node:test";
import ts from "typescript";

const require = createRequire(import.meta.url);
const source = await readFile(new URL("../electron/main/courseware-scene-generator.ts", import.meta.url), "utf8");
const exports = {};
// Pure callback tests replace only native decoding; Electron checks exercise actual PNGs.
new Function("require", "exports", ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText)(id => id === "./courseware-scene-context" ? {
  captureCoursewareSceneImages(images) {
    const values = new Map();
    for (const image of images) {
      const copy = { ...image, assetIds: [...image.assetIds], bytes: Buffer.from(image.bytes) };
      const existing = values.get(image.sha256);
      if (existing) existing.assetIds.push(...copy.assetIds);
      else values.set(image.sha256, copy);
    }
    return [...values.values()];
  },
} : require(id), exports);
const sha = bytes => createHash("sha256").update(bytes).digest("hex");
const image = (value, assetIds) => {
  const bytes = Buffer.from(value);
  return { bytes, assetIds, sha256: sha(bytes), width: 1600, height: 1000 };
};

function fixture() {
  const stage = Buffer.from("owned stage PPTX fixture"), representative = Buffer.from("owned representative PPTX fixture");
  const sourceHash = `sha256:${sha(stage)}`;
  const input = { sessionId: "chat", modelKey: "local", visualMasterAssetId: "master", cleanPlateAssetId: "clean",
    images: [image("master PNG fixture", ["master", "master-alias"]), image("clean PNG fixture", ["clean"])],
    sourceVisual: { pageId: "target", sourceHash },
    representativePreview: { pageId: "representative", outputSha256: sha(representative), image: image("reviewed PNG fixture") } };
  const scene = { slideId: "target", sourceHash, canvas: { width: 1280, height: 800 },
    visualMasterAssetId: "master", cleanPlateAssetId: "clean", elements: [{ type: "native_text", content: "Target facts" }] };
  const request = { pageId: "target", sourceHash, pageText: "Target facts", instruction: "Use the reviewed style",
    canvas: { ...scene.canvas }, schema: { parse: value => value, toJSONSchema: () => ({ type: "object" }) },
    sourcePptx: stage, representative: { pageId: "representative", outputSha256: sha(representative), pptx: representative } };
  const f = { input, request, scene, sent: [], hook: null };
  f.complete = async value => { f.sent.push(value); await f.hook?.(); return { text: JSON.stringify(f.scene) }; };
  f.run = signal => exports.createCoursewareSceneGenerator(input, f.complete)(request, signal);
  return f;
}

test("reviewed reference is model context only; PPTX bytes and reference assets stay private", async () => {
  const f = fixture(), result = await f.run();
  const sent = f.sent[0], data = JSON.parse(sent.data);
  assert.equal(sent.images.length, 3);
  assert.deepEqual(data.representative, { pageId: "representative", outputSha256: f.input.representativePreview.outputSha256,
    previewSha256: f.input.representativePreview.image.sha256, referenceImageId: "courseware-style-reference" });
  assert(!data.availableAssets.some(asset => asset.assetId === "courseware-style-reference"));
  assert(!Object.hasOwn(result.assets, "courseware-style-reference"));
  assert(!sent.data.includes("sourcePptx")); assert(!sent.data.includes("pptx"));
  for (const bytes of [f.request.sourcePptx, f.request.representative.pptx]) assert(!sent.data.includes(bytes.toString("base64")));
});

test("legacy and source-bound single-page requests retain two-image completion", async () => {
  for (const bound of [true, false]) {
    const f = fixture(); delete f.input.representativePreview; delete f.request.representative; delete f.request.sourcePptx;
    if (!bound) delete f.input.sourceVisual;
    await f.run(); assert.equal(f.sent.length, 1); assert.equal(f.sent[0].images.length, 2);
  }
});

const invalidInputs = {
  "missing preview": f => { delete f.input.representativePreview; },
  "missing representative": f => { delete f.request.representative; },
  "wrong representative page": f => { f.request.representative.pageId = "other"; },
  "wrong representative hash": f => { f.request.representative.outputSha256 = "a".repeat(64); },
  "changed representative bytes": f => { f.request.representative.pptx[0] ^= 1; },
  "empty representative bytes": f => { f.request.representative.pptx = Buffer.alloc(0); },
  "missing stage": f => { delete f.request.sourcePptx; },
  "changed stage bytes": f => { f.request.sourcePptx[0] ^= 1; },
  "empty stage bytes": f => { f.request.sourcePptx = Buffer.alloc(0); },
  "unbound preview": f => { delete f.input.sourceVisual; },
  "preview background alias": f => { f.input.representativePreview.image = f.input.images[1]; },
  "reserved asset ID": f => { f.input.images[0].assetIds.push("courseware-style-reference"); },
  "wrong source page": f => { f.request.pageId = "other"; },
  "wrong source hash": f => { f.request.sourceHash = `sha256:${"a".repeat(64)}`; },
  "wrong source aspect ratio": f => { f.request.canvas.height = 720; },
  "extra approval from model": f => { f.request.representative.approved = true; },
  "identical original and background": f => { f.input.images[1] = { ...f.input.images[0], assetIds: ["clean"] }; },
};
for (const [name, change] of Object.entries(invalidInputs)) test(`${name} rejects before model access`, async () => {
  const f = fixture(); change(f);
  await assert.rejects(async () => f.run()); assert.equal(f.sent.length, 0);
});

for (const assetId of ["courseware-style-reference", "preview-alias", "master-alias"]) test(`model cannot flatten reference via ${assetId}`, async () => {
  const f = fixture();
  if (assetId === "preview-alias") f.input.images.push({ ...f.input.representativePreview.image, assetIds: [assetId] });
  f.scene.elements = [{ type: "image_layer", assetId }];
  await assert.rejects(f.run(), /differs from pinned/); assert.equal(f.sent.length, 1);
});

test("model cannot substitute page or source identity", async () => {
  for (const field of ["slideId", "sourceHash"]) {
    const f = fixture(); f.scene[field] = "other";
    await assert.rejects(f.run(), /differs from pinned/);
  }
});

test("captures review before await and returns independent asset copies", async () => {
  const f = fixture(), hash = f.input.representativePreview.image.sha256, master = f.input.images[0].sha256;
  const generate = exports.createCoursewareSceneGenerator(f.input, f.complete);
  f.input.representativePreview.pageId = "late"; f.input.representativePreview.image.bytes.fill(0);
  f.hook = () => { f.input.images[0].bytes.fill(0); f.request.sourcePptx.fill(0); f.request.representative.pptx.fill(0); };
  const result = await generate(f.request), sent = f.sent[0];
  assert.equal(JSON.parse(sent.data).representative.pageId, "representative");
  assert.equal(sha(sent.images.find(i => i.assetIds.includes("courseware-style-reference")).bytes), hash);
  result.assets.master.fill(0);
  assert.equal(sha(sent.images.find(i => i.assetIds.includes("master")).bytes), master);
});

test("cancellation before or during model completion cannot produce a candidate scene", async () => {
  const f = fixture(); await assert.rejects(f.run(AbortSignal.abort())); assert.equal(f.sent.length, 0);
  const g = fixture(), controller = new AbortController(); g.hook = () => controller.abort();
  await assert.rejects(g.run(controller.signal)); assert.equal(g.sent.length, 1);
});
