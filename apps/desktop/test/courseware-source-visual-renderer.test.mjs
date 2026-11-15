import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname } from "node:path";
import test from "node:test";
import ts from "typescript";

const source = await readFile(new URL("../electron/main/courseware-source-visuals.ts", import.meta.url), "utf8");
function fixture({ revision, mismatch = false, cancel = false } = {}) {
  let disposed = 0, destroyed = false, opened;
  const controller = new AbortController();
  class Window { isDestroyed() { return destroyed; } destroy() { destroyed = true; } }
  class Editor {
    dispose() { disposed++; }
    async open(...args) { opened = args; if (cancel) controller.abort(); return { sha256: mismatch ? "bad" : "a".repeat(64), revision: 1, readOnly: true, canSave: false }; }
    async getContext() { return { page: 1, pageLineage: { openedPageTokens: ["one", "two"] } }; }
    async renderSavedPagePreview(_workspace, page, textless) { return { sourceSha256: "a".repeat(64), page, pageToken: "two", nativeTextOmitted: textless, image: { width: 1600, height: 1000 } }; }
  }
  const exports = {};
  new Function("require", "exports", ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText)(id => {
    if (id === "electron") return { BrowserWindow: Window };
    if (id === "node:path") return { dirname };
    if (id === "node:timers/promises") return { setTimeout: async () => {} };
    assert.equal(id, "./ppt-editor"); return { PptEditorController: Editor };
  }, exports);
  return { run: () => exports.renderCoursewareSourceVisuals({ ipcMain: {}, workspace: "/workspace", snapshot: { sourcePath: "/host/candidates/candidate.pptx", sha256: "a".repeat(64), ...(revision === undefined ? {} : { revision }) }, page: 2, signal: controller.signal, assertCurrent: async () => {} }),
    state: () => ({ disposed, destroyed, opened }) };
}

test("private renderer permits only the trusted candidate directory and pins readonly output hash", async () => {
  const f = fixture(), result = await f.run();
  assert.equal(result.pageCount, 2); assert.equal(result.normal.page, 2);
  const state = f.state(); assert.deepEqual(state.opened.slice(1), ["/workspace", "/host/candidates/candidate.pptx", undefined, ["/host/candidates"], true]);
  assert(state.disposed > 0); assert(state.destroyed);
});

test("known source revisions remain checked; copy revision is independent; errors and abort clean up", async () => {
  await fixture({ revision: 1 }).run();
  for (const options of [{ revision: 2 }, { mismatch: true }, { cancel: true }]) {
    const f = fixture(options); await assert.rejects(f.run()); assert(f.state().destroyed); assert(f.state().disposed > 0);
  }
});
