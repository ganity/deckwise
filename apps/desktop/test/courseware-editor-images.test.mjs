import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import { isCoursewareTaskRef, samePptEditorBinding } from "../../../packages/shared/dist/index.js";

function load(name, dependencies) {
  const exports = {};
  const code = readFileSync(new URL(`../electron/main/${name}.ts`, import.meta.url), "utf8");
  new Function("require", "exports", ts.transpileModule(code, {
    compilerOptions: { module: ts.ModuleKind.CommonJS },
  }).outputText)(id => {
    assert(Object.hasOwn(dependencies, id), `Unexpected dependency: ${id}`);
    return dependencies[id];
  }, exports);
  return exports;
}

const contracts = load("courseware-media-contracts", { "node:crypto": { createHash }, "@pi-desktop/shared": { isCoursewareTaskRef } });
const requestHash = "a".repeat(64);
const { createEditorImageHandler } = load("courseware-editor-images", {
  "node:crypto": { createHash, randomUUID },
  "@pi-desktop/shared": { samePptEditorBinding },
  "./courseware-media-contracts": contracts,
  "./courseware-media": { requestHash: () => requestHash },
});

async function verifyImageDownload(disconnect) {
  const target = { projectId: "course", documentId: "pptx", sessionId: "editor", page: 1, editGeneration: 2, readOnly: false };
  let live = { ...target };
  const calls = [];
  const taskRef = () => ({ taskId: "gw-editor-image", idempotencyKey: calls[0].id, requestHash });
  const task = () => ({ ...taskRef(), state: "ready", assetRef: { mime: "image/png", byteLength: 6 } });
  const checkRef = ref => assert.deepEqual(contracts.taskRef(ref), taskRef());
  const media = {
    getImageModels: async () => [{ model: "reference-model", supportsReferenceImage: true }],
    getImageQuote: async () => ({ maxPoints: 3, maxChars: 4000, expiresAt: new Date(Date.now() + 60000).toISOString() }),
    submitConfirmedImage: async (id, request, quote, _signal, _project, check) => {
      await check();
      calls.push({ id, request, quote });
      if (disconnect) throw new Error("connection lost");
      return task();
    },
    findImage: async (ref) => {
      assert(disconnect);
      assert.deepEqual(ref, { idempotencyKey: calls[0].id, requestHash });
      return task();
    },
    getImage: async ref => {
      checkRef(ref);
      return task();
    },
    downloadImage: async ref => {
      checkRef(ref);
      return { task: task(), bytes: Buffer.from("result") };
    },
  };
  const run = createEditorImageHandler({ getCoursewarePrincipal: () => ({ key: "owner", assertCurrent() {} }), coursewareMedia: media },
    async () => live, () => "active-chat");
  const reference = "data:image/png;base64,iVBORw0KGgo=";
  const offer = await run("editor-image:quote", { model: "reference-model", prompt: "Improve the picture", reference }, target);
  assert.equal(offer.maxPoints, 3);
  assert.equal(calls.length, 0);

  live = { ...target, page: 2, editGeneration: 3 };
  await assert.rejects(run("editor-image:submit", { id: offer.id }, target), /changed/);
  assert.equal(calls.length, 0);
  live = { ...target };
  let status;
  if (disconnect) {
    await assert.rejects(run("editor-image:submit", { id: offer.id }, target), /connection lost/);
    status = await run("editor-image:status", { id: offer.id }, target);
  } else {
    status = await run("editor-image:submit", { id: offer.id }, target);
  }
  assert.deepEqual(status, { state: "ready", image: "data:image/png;base64,cmVzdWx0" });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].request.referenceImage.bytesBase64, "iVBORw0KGgo=");
}

test("editor image generation downloads the submitted task", () => verifyImageDownload(false));
test("editor image generation recovers and downloads the same task after disconnect", () => verifyImageDownload(true));
