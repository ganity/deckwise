import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";
import { sceneAssetBlockers } from "@pi-desktop/shared";

const source = await readFile(new URL("../electron/main/courseware-chat-workflow.ts", import.meta.url), "utf8");
const compiled = ts.transpileModule(source, { compilerOptions: {
  target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS,
} }).outputText;

function fixture() {
  let viewing = "chat", dispatchable = true, mode = "agent", generated = false;
  const calls = [];
  const plan = { sha256: "a".repeat(64), approvedSha256: "a".repeat(64), pages: [
    { pageId: "scene-001", title: "Shapes", visibleText: ["Circle"], narration: "Good!", visualIntent: "A circle" },
  ] };
  const host = { async call(method, params) {
    calls.push([method, params]);
    if (method === "session.get") return { session: { projectPath: "/workspace", mode } };
    if (method === "courseware.task.get") return { task: { taskType: "scene", educationContext: {}, ...(generated ? { generatedPath: "/workspace/result.pptx" } : {}) } };
    if (method === "courseware.task.updateEducation") return {};
    assert.fail(method);
  } };
  class Images {
    constructor(_getHost, current, running) { this.current = current; this.running = running; }
    assert() { assert.equal(this.current(), "chat"); assert.equal(this.running(), false); }
    async list() { this.assert(); calls.push(["list"]); return []; }
    async models() { this.assert(); return [{ model: "image-model" }]; }
    async prepare(args) { this.assert(); calls.push(["prepare", args]); return { phase: "prepared", prompt: args.instructions }; }
    async status(args) { this.assert(); calls.push(["status", args]); return { asset: null, task: { state: "ready", feeState: "settled" } }; }
    async archive(args) { this.assert(); calls.push(["archive", args]); return { image: { selected: false } }; }
  }
  class Generation {
    async generate(args) { calls.push(["compile", args]); generated = true; return { path: "/workspace/result.pptx" }; }
  }
  const exports = {};
  new Function("require", "exports", compiled)(id => {
    if (id === "@pi-desktop/shared") return { sceneAssetBlockers };
    if (id === "./courseware-scene-draft") return { readSceneCourseDraft: async () => ({ plan: structuredClone(plan) }) };
    if (id === "./courseware-scene-images") return { CoursewareSceneImages: Images };
    if (id === "./courseware-scene-generation") return { CoursewareSceneGeneration: Generation };
    assert.fail(id);
  }, exports);
  const coordinator = new exports.CoursewareChatWorkflow(() => host, () => viewing, {}, {});
  return { calls, plan, coordinator, execute: (name, args = {}) => coordinator.execute("chat", name, args, () => dispatchable),
    view: value => { viewing = value; }, stop: () => { dispatchable = false; }, mode: value => { mode = value; } };
}

test("main Chat reads actual readiness and can prepare assets during its active turn without a mounted panel", async () => {
  const f = fixture();
  const view = await f.execute("courseware_workflow_get");
  assert.deepEqual(view.blockers.map(item => item.kind), ["visualMaster", "cleanPlate", "layer"]);
  assert.equal(view.models[0].model, "image-model");
  const input = { planSha256: f.plan.sha256, pageId: "scene-001", target: { kind: "visualMaster" }, model: "image-model", instructions: "Use warm colors" };
  const result = await f.execute("courseware_scene_image_prepare", input);
  assert.equal(result.requiresHumanCostConfirmation, true);
  assert.deepEqual(f.calls.at(-1), ["prepare", { ...input, sessionId: "chat" }]);
  assert(!f.calls.some(([name]) => /submit|approve|select/.test(name)));
});

test("readiness requires every foreground and its matching decomposition base/master", () => {
  const plan = { sha256: "a".repeat(64), pages: [{ pageId: "scene-001" }] };
  const common = { planSha256: plan.sha256, pageId: "scene-001", current: true, selected: true };
  const master = { ...common, intentId: "master", target: { kind: "visualMaster" }, asset: { sha256: "b".repeat(64), byteLength: 70 } };
  const clean = { ...common, intentId: "decomposition", decomposition: true, target: { kind: "cleanPlate" }, asset: { sha256: "c".repeat(64), byteLength: 70 },
    referenceImage: { intentId: "master", sha256: master.asset.sha256 } };
  const one = { ...common, intentId: "decomposition-layer-1", decomposition: true, target: { kind: "layer", name: "Teacher" }, asset: { byteLength: 70 } };
  const two = { ...one, intentId: "decomposition-layer-2", target: { kind: "layer", name: "Student" } };
  assert.deepEqual(sceneAssetBlockers(plan, [master, clean, one, two]), []);
  assert(sceneAssetBlockers(plan, [master, clean, one, { ...two, selected: false }]).some(blocker => blocker.kind === "layer"));
  assert(sceneAssetBlockers(plan, [master, { ...clean, referenceImage: { ...clean.referenceImage, intentId: "old-master" } }, one, two]).some(blocker => blocker.kind === "cleanPlate"));
  assert(sceneAssetBlockers(plan, [master, { ...clean, decomposition: false }, one, two]).some(blocker => blocker.kind === "cleanPlate"));
});

test("unapproved, stopped and foreign Chat work cannot advance", async () => {
  const f = fixture(); f.plan.approvedSha256 = null;
  await assert.rejects(f.execute("courseware_scene_compile", { planSha256: f.plan.sha256 }), /approve/);
  f.plan.approvedSha256 = f.plan.sha256; f.stop();
  await assert.rejects(f.execute("courseware_scene_compile", { planSha256: f.plan.sha256 }), /turn ended/);
  const other = fixture(); other.view("peer");
  await assert.rejects(other.coordinator.read("chat"), /conversation changed/);
  const wrongMode = fixture(); wrongMode.mode("plan");
  await assert.rejects(wrongMode.execute("courseware_workflow_get"), /Agent mode/);
});

test("status uses the original request and archives only verified settled results for human selection", async () => {
  const f = fixture();
  const result = await f.execute("courseware_scene_image_refresh", { intentId: "original" });
  assert.equal(result.requiresHumanSelection, true);
  assert.deepEqual(f.calls.slice(-2), [["status", { intentId: "original", sessionId: "chat" }], ["archive", { intentId: "original", sessionId: "chat" }]]);
});

test("successful compilation advances durable workflow and cannot be replayed over the generated source", async () => {
  const f = fixture();
  assert.deepEqual(await f.execute("courseware_scene_compile", { planSha256: f.plan.sha256 }), { generated: true, openEditorRequired: true });
  assert.equal((await f.coordinator.read("chat")).task.generated, true);
  await assert.rejects(f.execute("courseware_scene_compile", { planSha256: f.plan.sha256 }), /approve/);
  assert.equal(f.calls.filter(([name]) => name === "compile").length, 1);
});

test("teaching updates preserve owner identity and reject foreign parameters", async () => {
  const f = fixture();
  await f.execute("courseware_requirements_update", { expectedEducationContext: {}, educationContext: { grade: "3" } });
  assert.deepEqual(f.calls.find(([name]) => name === "courseware.task.updateEducation")[1], {
    sessionId: "chat", expectedEducationContext: {}, educationContext: { grade: "3" },
  });
  await assert.rejects(f.execute("courseware_requirements_update", { sessionId: "peer", educationContext: {} }), /Invalid teaching/);
});
