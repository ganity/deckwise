import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import ts from "typescript";
const shared = await import("../../../packages/shared/dist/index.js");
const module = { exports: {} };
new Function("require", "exports", "module", ts.transpileModule(readFileSync(new URL("../electron/main/courseware-native-sidebar.ts", import.meta.url), "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS },
}).outputText)(id => id === "@pi-desktop/shared" ? shared : createRequire(import.meta.url)(id), module.exports, module);
const { createNativeTeachingHandler } = module.exports;
const context = { projectId: "project", documentId: "document", sessionId: "editor-session", page: 1, editGeneration: 2, readOnly: false };
function setup() {
  const calls = [];
  const handler = createNativeTeachingHandler({
    context: async () => context, sessionId: () => "conversation",
    teaching: { open: async sessionId => { calls.push(["open", sessionId]); return "view"; },
      update: async (...args) => { calls.push(["write", ...args]); return "saved"; },
      draft: async (...args) => { calls.push(["draft", ...args]); return "draft"; } },
    media: { list: async args => { calls.push(["catalog", args]); return []; },
      adopt: async args => { calls.push(["adopt", args]); return "adopted"; }, preview: async args => { calls.push(["media", args]); return "local-media"; } },
    tts: { list: async args => { calls.push(["list", args]); return []; },
      submitConfirmed: async args => { calls.push(["submit", args]); return "submitted"; } },
  });
  return { handler, calls };
}
const request = (operation, args = {}, overrides = {}) => ({ operation, args, context: { ...context, ...overrides } });
test("native teaching shares the current conversation and existing write/TTS authorities", async () => {
  const { handler, calls } = setup();
  assert.equal(await handler(request("open")), "view");
  const args = { viewId: "view", expectedTeachingRevision: "revision", actions: [] };
  assert.equal(await handler(request("write", args)), "saved");
  await handler(request("tts:list", { viewId: "view" }));
  assert.deepEqual(calls, [["open", "conversation"], ["write", args, false], ["list", { viewId: "view" }]]);
  assert.equal(calls.some(([name]) => name === "submit"), false);
});
test("stale page, edit, document and read-only requests never reach teaching or paid submission", async () => {
  for (const override of [{ page: 2 }, { editGeneration: 1 }, { documentId: "foreign" }, { sessionId: "foreign" }]) {
    const { handler, calls } = setup();
    await assert.rejects(handler(request("tts:submit", {}, override)), /target changed/);
    assert.deepEqual(calls, []);
  }
  const { handler, calls } = setup(); context.readOnly = true;
  try { await assert.rejects(handler(request("write")), /target changed/); } finally { context.readOnly = false; }
  assert.deepEqual(calls, []);
});
test("queued recovery drafts may finish after navigation without authorizing a teaching write", async () => {
  const { handler, calls } = setup();
  assert.equal(await handler(request("draft:set", { viewId: "old-page-view" }, { page: 2 })), "draft");
  assert.deepEqual(calls, [["draft", { viewId: "old-page-view" }, true]]);
  await assert.rejects(handler(request("write", {}, { page: 2 })), /target changed/);
});
test("unsupported, malformed and oversized native requests are refused", async () => {
  const { handler, calls } = setup();
  for (const input of [null, [], {}, { ...request("open"), injected: true }, request("write", []), request("open", { text: "x".repeat(2_000_000) }), request("shell:run")])
    await assert.rejects(handler(input));
  assert.deepEqual(calls, []);
});

test("adopted media preview uses the same native binding fence", async () => {
  const { handler, calls } = setup();
  assert.equal(await handler(request("media:preview", { actionId: "music" })), "local-media");
  await assert.rejects(handler(request("media:preview", {}, { page: 2 })), /target changed/);
  assert.deepEqual(calls, [["media", { actionId: "music" }]]);
});

test("catalog and explicit adoption share native binding fences without forwarding unsupported operations", async () => {
  const { handler, calls } = setup();
  assert.deepEqual(await handler(request("media:list", { viewId: "view" })), []);
  assert.equal(await handler(request("media:adopt", { kind: "video", intentId: "saved" })), "adopted");
  await assert.rejects(handler(request("media:adopt", {}, { editGeneration: 100 })), /target changed/);
  assert.deepEqual(calls.map(([operation]) => operation), ["catalog", "adopt"]);
});
