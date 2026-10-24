import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import test from "node:test";
import ts from "typescript";
import * as runtime from "../../../packages/agent-runtime/dist/index.js";

const require = createRequire(import.meta.url);
const source = await readFile(new URL("../electron/main/courseware-style-batch-candidate.ts", import.meta.url), "utf8");
function fixture() {
  let reads = 0, confirmations = 0, checks = 0, duringCheck = () => {}, denied = false;
  const controller = new AbortController();
  const retained = { host: {}, project: {}, snapshot: {}, context: {}, generated: {}, instruction: "Original", confirmation: {}, reviewId: "review", pageIds: ["one", "two"] };
  const style = {
    async loadConfirmed(sessionId) { assert.equal(this, style); assert.equal(sessionId, "chat"); confirmations++; if (denied) throw new Error("Confirm the pages first"); return retained; },
    async assertConfirmed(sessionId, reviewId, ids) { assert.equal(this, style); assert.equal(sessionId, "chat"); assert.equal(reviewId, "review"); assert.deepEqual(ids, ["one", "two"]); },
  };
  retained.host.call = async () => assert.fail("No Host writes before valid review and compiler");
  const imports = {
    "@pi-desktop/agent-runtime": runtime,
    "./courseware-runtime": { coursewareAuthoringUrl: () => undefined },
    "./courseware-candidate-source": { readCandidateSource: async () => { reads++; assert.fail("No source before compiler"); } },
    "./courseware-scene-generator": { createCoursewareSceneGenerator: () => assert.fail("No model before scope") },
  };
  const exports = {};
  new Function("require", "exports", ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText)(
    id => Object.hasOwn(imports, id) ? imports[id] : require(id), exports);
  const input = { sessionId: "chat", jobId: "source", scope: { reviewId: "review", pageIds: ["one", "two"] }, style, signal: controller.signal, assertCurrent: async () => { checks++; duringCheck(); } };
  return { run: () => exports.stagePageStyleBatchCandidate(input), controller, style, deny: () => { denied = true; }, duringCheck: fn => { duringCheck = fn; }, state: () => ({ reads, confirmations, checks }) };
}

test("batch stage refuses cancellation and missing confirmation without source/model/Host writes", async () => {
  const f = fixture(); f.controller.abort(new Error("cancelled batch")); await assert.rejects(f.run(), /cancelled batch/);
  assert.deepEqual(f.state(), { reads: 0, confirmations: 0, checks: 0 });
  const g = fixture(); g.deny(); await assert.rejects(g.run(), /Confirm/); assert.equal(g.state().reads, 0);
});

test("cancellation during owning-context I/O prevents even loading retained bytes", async () => {
  const f = fixture(); f.duringCheck(() => f.controller.abort(new Error("turn stopped")));
  await assert.rejects(f.run(), /turn stopped/); assert.equal(f.state().confirmations, 0);
});

test("original confirmation callbacks stay bound across the first context await", async () => {
  const f = fixture(); f.duringCheck(() => {
    f.style.loadConfirmed = async () => assert.fail("Replaced loader cannot authorize a different scope");
    f.style.assertConfirmed = async () => assert.fail("Replaced guard cannot authorize a different scope");
  });
  await assert.rejects(f.run(), /compiler is unavailable/); assert.equal(f.state().confirmations, 1); assert.equal(f.state().reads, 0);
});
