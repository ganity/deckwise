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
  return { renderer: exports, run: () => exports.renderCoursewareSourceVisuals({ ipcMain: {}, workspace: "/workspace", snapshot: { sourcePath: "/host/candidates/candidate.pptx", sha256: "a".repeat(64), ...(revision === undefined ? {} : { revision }) }, page: 2, signal: controller.signal, assertCurrent: async () => {} }),
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

test("first adoption reviews body renderings and distinguishes malformed verdicts from page defects", async () => {
  const f = fixture(), exports = {};
  const source = await readFile(new URL("../electron/main/courseware-presentation-review.ts", import.meta.url), "utf8");
  new Function("require", "exports", ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText)(id => {
    if (id === "./courseware-source-visuals") return f.renderer;
    assert.equal(id, "./courseware-review-json"); return { parseReviewJson: JSON.parse };
  }, exports);
  const request = { sessionId: "chat", workspace: "/workspace", path: "/workspace/export.pptx", sourceSha256: "a".repeat(64),
    pages: [{ pageNumber: 1, teaching: { pageType: "slide", objective: "Compare the measurements" } },
      { pageNumber: 2, teaching: { pageType: "quiz" }, quiz: {} }], check() {} };
  const answers = ["invalid", '{"issues":["The length is labeled in seconds"]}'];
  const review = exports.presentationReview({}, async () => ({ modelKey: "test" }), async input => {
    assert.match(input.system, /trace the visible labels, connectors, boundaries and color coding/);
    assert.match(input.system, /identify the conflicting label and region/);
    assert.equal(JSON.parse(input.data).pageNumber, 1);
    assert.equal(input.images[0].width, 1600);
    const answer = answers.shift();
    if (answer instanceof Error) throw answer;
    return { text: answer };
  });
  await assert.rejects(review(request), /PRESENTATION_VISUAL_DEFECT:.*Page 1: The length is labeled in seconds/);
  assert.equal(answers.length, 0);
  answers.push("invalid", "invalid");
  await assert.rejects(review(request), /PRESENTATION_REVIEW_UNAVAILABLE: Invalid visual review for exported page 1/);
  answers.push(new Error('Provider unavailable'));
  await assert.rejects(review(request), /PRESENTATION_REVIEW_UNAVAILABLE: Page 1: Provider unavailable.*same exported PPTX/);
  answers.push('{"issues":[]}');
  await review(request);
  assert.equal(answers.length, 0);
});
