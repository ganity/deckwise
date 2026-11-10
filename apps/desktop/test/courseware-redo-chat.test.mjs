import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";
import * as shared from "../../../packages/shared/dist/index.js";
import * as runtime from "../../../packages/agent-runtime/dist/index.js";

const source = await readFile(new URL("../electron/main/courseware-candidates.ts", import.meta.url), "utf8");
const fixture = JSON.parse(await readFile(new URL("../../../packages/shared/src/courseware-contract.fixtures/accepted.json", import.meta.url), "utf8"));
function setup() {
  const project = structuredClone(fixture.project);
  const editor = { projectId: "native", documentId: "doc", sessionId: "office", editGeneration: 1, page: 1 };
  const session = { mode: "agent", providerId: "provider", modelId: "vision", thinkingLevel: "off" };
  const view = { projectId: project.projectId, pageId: project.pages[0].pageId, sourceSha256: project.source.sha256 };
  let approved = true, installed = true, active = true, text = "Current text", duringComplete = () => {};
  const staged = [], requests = [];
  const host = { async call(method) {
    if (method === "courseware.project.openSaved" || method === "courseware.project.get") return { project: structuredClone(project) };
    if (method === "courseware.pageText") return { text };
    if (method === "session.get") return { session: structuredClone(session) };
    assert.fail(method);
  } };
  const teaching = { async withSaved(_session, run) { return run(host, "job", { path: "/private/source.pptx", sha256: project.source.sha256 }, { ...editor }); },
    async assertCurrent(_snapshot, pinned) { assert.deepEqual(pinned, editor); } };
  const imports = {
    "./courseware-native-narration": { generateNativeNarration() { throw new Error("Unexpected native narration"); } },
    "@pi-desktop/shared": shared, "@pi-desktop/agent-runtime": runtime,
    "./courseware-runtime": { coursewareAuthoringUrl: () => installed ? "file:///private/authoring.mjs" : undefined },
    "./courseware-style-batch-candidate": { stagePageStyleBatchCandidate() { assert.fail("Unexpected batch"); } },
    "./courseware-source-candidate": { stagePageFadeCandidate() { assert.fail("Unexpected fade"); } },
    "./courseware-redo-candidate": { async stagePageRedoCandidate(input) {
      staged.push(input); await input.current(); await input.complete({}); await input.current();
      return { candidateId: "redo", kind: "page-pptx", baseline: input.baseline, outputSha256: "c".repeat(64),
        warnings: ["Rebuilt page objects"], reviewState: "needs-review", applied: false };
    } },
  };
  const exports = {};
  new Function("require", "exports", ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText)(
    id => { assert(Object.hasOwn(imports, id), id); return imports[id]; }, exports);
  const service = new exports.CoursewareCandidateCoordinator(teaching, () => assert.fail("Unexpected text-only completion"), {
    visuals: { async approved() { return approved ? { view } : null; } },
    async completeScene(request) { requests.push(request); duringComplete(); return { text: "fixture" }; },
  });
  return { project, editor, session, view, staged, requests,
    context: () => service.execute("chat", "ppt_get_narration_context", {}, () => active),
    propose: baseline => service.execute("chat", "ppt_propose_page_redo", { kind: "page-pptx", baseline, instruction: "Rebuild current page" }, () => active),
    change(kind) { if (kind === "unapproved") approved = false; if (kind === "missing") installed = false; if (kind === "empty") text = "";
      if (kind === "model") session.modelId = "another"; if (kind === "cancel") active = false; if (kind === "page") editor.page = 2;
      if (kind === "policy") project.educationContext = { schoolStage: "KINDERGARTEN" }; },
    during(fn) { duringComplete = fn; },
  };
}

test("Chat redo exposes only the current approved/installed capability, including image-only pages", async () => {
  for (const state of ["approved", "unapproved", "missing", "empty", "foreign"]) {
    const f = setup(); f.change(state); if (state === "foreign") f.view.pageId = "other";
    const context = await f.context();
    assert.equal(context.capabilities.includes("page-pptx"), state === "approved" || state === "empty", state);
    if (state === "empty") assert(!context.capabilities.includes("page-narration"));
    assert.equal(f.staged.length, 0); assert.equal(f.requests.length, 0);
  }
});

test("Chat redo uses private reviewed inputs and current model; returns the finite unapplied receipt", async () => {
  const f = setup(), context = await f.context(), before = structuredClone(f.project);
  const receipt = await f.propose(context.baseline);
  assert.deepEqual(Object.keys(receipt).sort(), ["candidateId", "kind", "baseline", "outputSha256", "reviewState", "applied"].sort());
  assert.equal(receipt.applied, false); assert.equal(receipt.reviewState, "needs-review");
  assert.equal(f.staged[0].reviewed.view, f.view); assert.equal(f.staged[0].modelKey, "provider/vision");
  assert.equal(f.staged[0].sourcePath, "/private/source.pptx"); assert.deepEqual(f.project, before);
  const g = setup(), prior = await g.context(); g.change("unapproved");
  await assert.rejects(g.propose(prior.baseline), /explicitly approve/); assert.equal(g.staged.length, 0);
});

test("Chat redo rejects forged baseline and model/page/policy/cancellation changes during completion", async () => {
  const f = setup(), context = await f.context(); context.baseline.pageId = "other";
  await assert.rejects(f.propose(context.baseline), /baseline changed/); assert.equal(f.requests.length, 0);
  for (const kind of ["model", "page", "policy", "cancel"]) {
    const g = setup(), prior = await g.context(); g.during(() => g.change(kind));
    await assert.rejects(g.propose(prior.baseline), undefined, kind);
    assert.equal(g.requests.length, 1);
  }
});
