import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

const names = ["models", "list", "prepare", "quote", "submitConfirmed", "status", "archive", "preview", "referencePreview", "restore"];
const keys = ["Models", "List", "Prepare", "Quote", "SubmitConfirmed", "Status", "Archive", "Preview", "ReferencePreview", "Restore"];
const invoke = Object.fromEntries(keys.map((key, index) => [`coursewareCanvasImage${key}`, names[index]]));
const exports = {}, calls = [];
class Images {
  constructor(...args) { calls.push(["constructor", ...args]); }
}
for (const name of names) Images.prototype[name] = async function (value) { calls.push([name, value]); return value; };
new Function("require", "exports", ts.transpileModule(await readFile(new URL("../electron/main/ipc/courseware-canvas-image-ipc.ts", import.meta.url), "utf8"), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText)(name => {
  if (name === "@pi-desktop/shared") return { IPC: { invoke } };
  assert.equal(name, "../courseware-canvas-images"); return { CoursewareCanvasImages: Images };
}, exports);

test("canvas image IPC registers only explicit operations and validates the window and argument count before delegation", async () => {
  const handlers = new Map(), mainWindow = {};
  exports.registerCoursewareCanvasImageIpc({ registrar: {
    handleWithEvent: (name, handler) => handlers.set(name, handler),
    assertMainWindowSender: event => { assert.equal(event, mainWindow, "main window required"); },
  }, getHost: () => null, getViewingSessionId: () => "chat", activeTurns: new Map(), authSession: {} });
  assert.equal(handlers.size, 10);
  for (const name of names) {
    const payload = { sessionId: "chat" };
    assert.equal(await handlers.get(name)(mainWindow, payload), payload);
    assert.deepEqual(calls.at(-1), [name, payload]);
    const count = calls.length;
    await assert.rejects(handlers.get(name)({}, payload), /main window required/);
    await assert.rejects(handlers.get(name)(mainWindow, payload, "unexpected"), /Unexpected/);
    assert.equal(calls.length, count);
  }
  assert(!handlers.has("generate")); assert(!handlers.has("adopt"));
});
