import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import ts from "typescript";
import * as runtime from "../../../packages/agent-runtime/dist/index.js";

const require = createRequire(import.meta.url);
const source = await readFile(new URL("../electron/main/courseware-redo-candidate.ts", import.meta.url), "utf8");
function fixture() {
  let revoked = false, reads = 0;
  const calls = [];
  const exports = {};
  const imports = {
    "@pi-desktop/agent-runtime": runtime,
    "./courseware-candidate-source": { async readCandidateSource() { reads++; return Buffer.from("source fixture"); } },
    "./courseware-runtime": { coursewareAuthoringUrl: () => undefined },
    "./courseware-scene-generator": { createCoursewareSceneGenerator() { assert.fail("No model may be created before input authorization"); } },
  };
  new Function("require", "exports", ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText)(
    id => Object.hasOwn(imports, id) ? imports[id] : require(id), exports);
  const input = {
    signal: new AbortController().signal, baseline: { coursewareProjectId: "project", pageId: "page", sourceSha256: "a".repeat(64) },
    reviewed: { view: { projectId: "project", pageId: "page", sourceSha256: "a".repeat(64) },
      async assertCurrent() { if (revoked) throw new Error("review revoked"); } },
    current: async () => ({}), host: { async call(method) { calls.push(method); assert.fail("No Host write before input authorization"); } },
  };
  return { input, calls, run: () => exports.stagePageRedoCandidate(input), revoke: () => { revoked = true; }, reads: () => reads };
}

test("redo refuses cancellation and revoked review before source/model/Host access", async () => {
  const f = fixture(); f.input.signal = AbortSignal.abort(new Error("cancelled redo"));
  await assert.rejects(f.run(), /cancelled redo/); assert.equal(f.reads(), 0);
  const g = fixture(); g.revoke(); await assert.rejects(g.run(), /review revoked/); assert.equal(g.reads(), 0);
});

test("redo rechecks review after awaiting the current Chat baseline", async () => {
  const f = fixture(); f.input.current = async () => { f.revoke(); return {}; };
  await assert.rejects(f.run(), /review revoked/); assert.equal(f.reads(), 0);
});

test("redo refuses a reviewed image from another project/page/source", async () => {
  for (const field of ["projectId", "pageId", "sourceSha256"]) {
    const f = fixture(); f.input.reviewed.view[field] = "other";
    await assert.rejects(f.run(), /differ/); assert.equal(f.reads(), 0);
  }
});

test("missing installed compiler refuses without preparing a Host candidate", async () => {
  const f = fixture(); await assert.rejects(f.run(), /compiler is unavailable/);
  assert.equal(f.reads(), 1); assert.deepEqual(f.calls, []);
});
