import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";
import { coursewareMediaRecovery, sceneAssetBlockers } from "@pi-desktop/shared";

const source = await readFile(new URL("../electron/main/courseware-chat-workflow.ts", import.meta.url), "utf8");
test("Main dispatches saved narration through the durable courseware workflow", async () => {
  const main = await readFile(new URL("../electron/main/index.ts", import.meta.url), "utf8");
  const route = main.slice(main.indexOf("executePptEditorTool: async"), main.indexOf("executePptEditorTool: async") + 1000);
  assert.match(route, /startsWith\("courseware_narration_"\)/);
  assert(route.indexOf("coursewareChatWorkflow.execute") < route.indexOf("pptEditorChat.execute"));
});
const compiled = ts.transpileModule(source, { compilerOptions: {
  target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS,
} }).outputText;

function fixture(options = {}) {
  let viewing = "chat", dispatchable = true, mode = "agent", generated = false;
  const calls = [], rows = [], states = [];
  let stoppedDuringStatus = false, stoppedDuringWait = false;
  const plan = { sha256: "a".repeat(64), approvedSha256: "a".repeat(64), pages: [
    { pageId: "scene-001", title: "Shapes", visibleText: ["Circle"], narration: "Good!", visualIntent: "A circle" },
  ] };
  const host = { async call(method, params) {
    calls.push([method, params]);
    if (method === "session.get") { await options.readSession?.(); return { session: { projectPath: "/workspace", mode } }; }
    if (method === "courseware.task.get") return { task: { taskType: "scene", educationContext: {}, ...(generated ? { generatedPath: "/workspace/result.pptx" } : {}) } };
    if (method === "courseware.task.updateEducation") return {};
    assert.fail(method);
  } };
  const image = { intentId: "image-1", planSha256: plan.sha256, pageId: "scene-001", target: { kind: "visualMaster" },
    current: true, selected: false, phase: "submitted", asset: null, task: null };
  class Images {
    constructor(_getHost, current, running) { this.current = current; this.running = running; }
    assert() { assert.equal(this.current(), "chat"); assert.equal(this.running(), false); }
    async list() { this.assert(); calls.push(["list"]); return structuredClone(rows); }
    async models() { this.assert(); return [{ model: "image-model" }]; }
    async prepare(args) { this.assert(); calls.push(["prepare", args]); Object.assign(image, { pageId: args.pageId, target: args.target }); return { ...image, phase: "prepared", prompt: args.instructions }; }
    async generate(args) { this.assert(); calls.push(["generate", args]); image.phase = "submitted"; return { ...image }; }
    async retry(args) { this.assert(); calls.push(["retry", args]); image.intentId = "retry-image-1"; image.phase = "prepared"; return { ...image }; }
    async status(args) { this.assert(); calls.push(["status", args]); if (stoppedDuringStatus) dispatchable = false; const saved = rows.find(row => row.intentId === args.intentId) ?? image; return { ...saved, task: saved.phase === "submitted" ? { state: "ready", feeState: "settled" } : null, ...states.shift() }; }
    async archive(args) { this.assert(); calls.push(["archive", args]); const result = { ...image, asset: { sha256: "b".repeat(64) } }; rows.push(result); return { image: result }; }
    async adopt(args) { this.assert(); calls.push(["adopt", args]); const row = rows.find(row => row.intentId === args.intentId); row.selected = true; return structuredClone(rows); }
  }
  class Generation {
    async generate(args) { calls.push(["compile", args]); await options.compile?.(); generated = true; return { path: "/workspace/result.pptx" }; }
  }
  const exports = {};
  new Function("require", "exports", compiled)(id => {
    if (id === "node:timers/promises") return { setTimeout: async ms => { calls.push(["wait", ms]); if (stoppedDuringWait) dispatchable = false; } };
    if (id === "@pi-desktop/shared") return { coursewareMediaRecovery, sceneAssetBlockers };
    if (id === "./courseware-scene-draft") return { readSceneCourseDraft: async () => ({ plan: structuredClone(plan) }) };
    if (id === "./courseware-scene-images") return { CoursewareSceneImages: Images };
    if (id === "./courseware-scene-generation") return { CoursewareSceneGeneration: Generation };
    assert.fail(id);
  }, exports);
  let currentHost = host;
  const coordinator = new exports.CoursewareChatWorkflow(() => currentHost, () => viewing, {}, {});
  return { calls, plan, coordinator, rows, image, states, stopOnStatus: () => { stoppedDuringStatus = true; }, stopOnWait: () => { stoppedDuringWait = true; }, execute: (name, args = {}) => coordinator.execute("chat", name, args, () => dispatchable),
    view: value => { viewing = value; }, stop: () => { dispatchable = false; }, mode: value => { mode = value; },
    restartHost: () => { currentHost = { ...host }; } };
}

test("workflow diagnostics distinguish navigation, ended turns and a runtime replaced during a read", async () => {
  const foreign = fixture(); foreign.view("other");
  await assert.rejects(foreign.coordinator.read("chat"), /conversation changed; return to this Chat/);
  const stopped = fixture(); stopped.stop();
  await assert.rejects(stopped.execute("courseware_workflow_get"), /Chat turn ended or was cancelled/);
  const restarted = fixture({ readSession: () => restarted.restartHost() });
  await assert.rejects(restarted.coordinator.read("chat"), /runtime changed; read saved workflow/);
  for (const f of [foreign, stopped, restarted]) assert(!f.calls.some(([name]) => name === "compile"));
});

test("returning to the owning Chat restores saved workflow reads after navigation", async () => {
  const f = fixture(); f.view("other");
  await assert.rejects(f.coordinator.read("chat"), /conversation changed/);
  f.view("chat");
  assert.equal((await f.coordinator.read("chat")).plan.sha256, f.plan.sha256);
  assert(!f.calls.some(([name]) => name === "compile" || name === "generate"));
});

test("background workflow stays with its turn when another Chat or settings is visible", async () => {
  for (const viewing of ["other", null]) {
    const f = fixture(); f.view(viewing);
    assert.equal((await f.execute("courseware_workflow_get")).plan.sha256, f.plan.sha256);
    const prepared = await f.execute("courseware_scene_image_prepare", { planSha256: f.plan.sha256,
      pageId: "scene-001", target: { kind: "visualMaster" }, instructions: "Circle" });
    const ready = await f.execute("courseware_scene_image_refresh", { intentId: prepared.image.intentId });
    assert.equal(ready.requiresHumanSelection, true);
    assert.deepEqual(await f.execute("courseware_scene_compile", { planSha256: f.plan.sha256 }), { generated: true, openEditorRequired: true });
    assert(f.calls.filter(([name]) => ["session.get", "courseware.task.get"].includes(name))
      .every(([name, args]) => (name === "session.get" ? args.id : args.sessionId) === "chat"));
    f.stop();
    await assert.rejects(f.execute("courseware_workflow_get"), /Chat turn ended or was cancelled/);
  }
});

test("navigation during compilation does not cancel its owning turn", async () => {
  const f = fixture({ compile: async () => { f.view("other"); } });
  assert.equal((await f.execute("courseware_scene_compile", { planSha256: f.plan.sha256 })).generated, true);
  assert.equal((await f.execute("courseware_workflow_get")).task.sourcePath, "/workspace/result.pptx");
});

test("background narration and media receive the owning session and live turn guard", async () => {
  const f = fixture(); f.view("other");
  const calls = [];
  const service = { async execute(sessionId, name, args, canDispatch) {
    calls.push({ sessionId, name, args, canDispatch });
    assert.equal(canDispatch(), true);
    return { saved: true };
  } };
  f.coordinator.narration = service; f.coordinator.media = service;
  for (const name of ["courseware_narration_context", "courseware_narration_propose", "courseware_media_context", "courseware_media_prepare", "courseware_media_refresh"])
    assert.deepEqual(await f.execute(name, { pageNumber: 1 }), { saved: true });
  assert(calls.every(call => call.sessionId === "chat" && call.args.pageNumber === 1));
  f.stop();
  assert(calls.every(call => !call.canDispatch()), "Delegated work must still observe cancellation");
});

test("main Chat reads actual readiness and can prepare assets during its active turn without a mounted panel", async () => {
  const f = fixture();
  const view = await f.execute("courseware_workflow_get");
  assert.deepEqual(view.blockers.map(item => item.kind), ["visualMaster", "cleanPlate", "layer"]);
  assert.equal(view.models[0].model, "image-model");
  const input = { planSha256: f.plan.sha256, pageId: "scene-001", target: { kind: "visualMaster" }, model: "image-model", instructions: "Use warm colors" };
  const result = await f.execute("courseware_scene_image_prepare", input);
  assert.equal(result.image.phase, "submitted");
  assert.equal(result.image.asset, null);
  assert.equal(result.requiresHumanSelection, false);
  assert.equal(f.calls.filter(([name]) => name === "status").length, 0);
  const ready = await f.execute("courseware_scene_image_refresh", { intentId: result.image.intentId });
  assert(ready.image.asset);
  assert.equal(ready.requiresHumanSelection, true);
  assert.equal(result.requiresHumanCostConfirmation, undefined);
  assert.deepEqual(f.calls.find(([name]) => name === "prepare"), ["prepare", { ...input, sessionId: "chat" }]);
  assert.deepEqual(f.calls.find(([name]) => name === "generate"), ["generate", { sessionId: "chat", intentId: "image-1" }]);
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
  await assert.rejects(f.execute("courseware_scene_image_prepare", { planSha256: f.plan.sha256, pageId: "scene-001", target: { kind: "visualMaster" } }), /approve/);
  assert(!f.calls.some(([name]) => name === "prepare" || name === "generate"));
  f.plan.approvedSha256 = f.plan.sha256; f.stop();
  await assert.rejects(f.execute("courseware_scene_compile", { planSha256: f.plan.sha256 }), /turn ended/);
  const other = fixture(); other.view("peer");
  await assert.rejects(other.coordinator.read("chat"), /conversation changed/);
  const wrongMode = fixture(); wrongMode.mode("plan");
  await assert.rejects(wrongMode.execute("courseware_workflow_get"), /Agent mode/);
});

test("status uses the original request and archives only verified settled results for human selection", async () => {
  const f = fixture();
  const result = await f.execute("courseware_scene_image_refresh", { intentId: "image-1" });
  assert.equal(result.requiresHumanSelection, true);
  assert(f.calls.some(([name]) => name === "archive"));
  assert.equal(f.calls.some(([name]) => name === "generate"), false);
});

test("pending and uncertain original jobs return one snapshot without holding the Chat turn", async () => {
  for (const state of ["queued", "submitted", "submission_unknown", "failed", "cancelled", "archive_failed"]) {
    const f = fixture();
    f.states.push({ task: { state, feeState: "reserved" } }, {}, {});
    const result = await f.execute("courseware_scene_image_refresh", { intentId: f.image.intentId });
    assert.equal(result.image.task.state, state);
    assert.equal(result.requiresHumanSelection, false);
    assert.equal(result.requiresGeneration, false);
    assert.equal(f.calls.filter(([name]) => name === "status").length, 1);
    assert(!f.calls.some(([name]) => ["archive", "generate", "adopt"].includes(name)));
  }
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


test("unconfirmed cover blocks later masters and decomposition before submission", async () => {
  const f = fixture();
  for (const args of [{ pageId: "scene-002", target: { kind: "visualMaster" } }, { pageId: "scene-001", target: { kind: "cleanPlate" } }])
    await assert.rejects(f.execute("courseware_scene_image_prepare", { planSha256: f.plan.sha256, ...args }), /confirm the first page/);
  assert(!f.calls.some(([name]) => ["prepare", "generate"].includes(name)));
});

test("a stop during status prevents archiving or resubmission", async () => {
  const f = fixture(); f.stopOnStatus();
  await assert.rejects(f.execute("courseware_scene_image_refresh", { intentId: "image-1" }), /turn ended/);
  assert.equal(f.calls.filter(([name]) => name === "status").length, 1);
  assert.equal(f.calls.filter(([name]) => ["archive", "generate", "adopt"].includes(name)).length, 0);
});

test("after style confirmation a verified decomposition adopts its complete group without another review", async () => {
  const f = fixture();
  f.rows.push({ ...f.image, intentId: "cover", selected: true, asset: { sha256: "c".repeat(64) } });
  Object.assign(f.image, { target: { kind: "cleanPlate" }, decomposition: true });
  f.rows.push({ ...f.image, intentId: "image-1-layer-1", target: { kind: "layer", name: "Circle" }, asset: { sha256: "d".repeat(64) } });
  const result = await f.execute("courseware_scene_image_refresh", { intentId: "image-1" });
  assert.equal(result.requiresHumanSelection, false);
  assert.equal(f.rows.every(row => row.selected), true);
  assert.equal(f.calls.filter(([name]) => name === "adopt").length, 2);
  assert.equal(f.calls.filter(([name]) => name === "generate").length, 0);
});


test("a partially selected decomposition resumes its remaining children without replacing selected assets", async () => {
  const f = fixture();
  f.rows.push({ ...f.image, intentId: "cover", selected: true, asset: { sha256: "c".repeat(64) } });
  Object.assign(f.image, { target: { kind: "cleanPlate" }, decomposition: true, selected: true, asset: { sha256: "d".repeat(64) } });
  f.rows.push({ ...f.image });
  f.rows.push({ ...f.image, intentId: "image-1-layer-1", target: { kind: "layer", name: "Circle" }, selected: false });
  const result = await f.execute("courseware_scene_image_refresh", { intentId: "image-1" });
  assert.equal(result.requiresHumanSelection, false);
  assert.equal(f.rows.every(row => row.selected), true);
  assert.deepEqual(f.calls.filter(([name]) => name === "adopt"), [["adopt", { sessionId: "chat", intentId: "image-1-layer-1", expectedSelectedIntentId: null }]]);
});

test("changed plan status stops the active image wait without selecting or resubmitting", async () => {
  const f = fixture();
  f.states.push({ current: false }, { current: false }, {});
  await assert.rejects(f.execute("courseware_scene_image_refresh", { intentId: "image-1" }), /Scene plan changed/);
  assert.equal(f.calls.filter(([name]) => ["archive", "adopt", "generate"].includes(name)).length, 0);
});

test("prepared recovery reports generation instead of human review and resumes only when explicitly requested", async () => {
  const f = fixture(); f.image.phase = "prepared";
  const pending = await f.execute("courseware_scene_image_refresh", { intentId: f.image.intentId });
  assert.equal(pending.requiresGeneration, true);
  assert.equal(pending.requiresHumanSelection, false);
  assert(!f.calls.some(([name]) => name === "generate"));
  const ready = await f.execute("courseware_scene_image_refresh", { intentId: f.image.intentId, generatePrepared: true });
  assert.equal(ready.image.asset, null);
  assert.equal(ready.requiresHumanSelection, false);
  assert((await f.execute("courseware_scene_image_refresh", { intentId: f.image.intentId })).image.asset);
  assert.deepEqual(f.calls.filter(([name]) => name === "generate"), [["generate", { sessionId: "chat", intentId: f.image.intentId }]]);
});

test("prepared recovery preserves style and plan fences and never resubmits uncertain receipts", async () => {
  for (const change of [{ pageId: "scene-002" }, { target: { kind: "cleanPlate" } }, { current: false }]) {
    const f = fixture(); Object.assign(f.image, { phase: "prepared" }, change);
    await assert.rejects(f.execute("courseware_scene_image_refresh", { intentId: f.image.intentId, generatePrepared: true }), /confirm the first page|Scene plan changed/);
    assert(!f.calls.some(([name]) => name === "generate"));
  }
  const f = fixture(); f.image.phase = "submission-unknown";
  await f.execute("courseware_scene_image_refresh", { intentId: f.image.intentId, generatePrepared: true });
  assert(!f.calls.some(([name]) => name === "generate"));
  await assert.rejects(f.execute("courseware_scene_image_refresh", { intentId: f.image.intentId, generatePrepared: "yes" }), /Invalid image refresh/);
});

test("explicit image retry submits its successor and preserves the cover confirmation gate", async () => {
  const f = fixture();
  await f.execute("courseware_scene_image_refresh", { intentId: "image-1", retryFailed: true });
  assert.deepEqual(f.calls.filter(([name]) => name === "retry"), [["retry", { sessionId: "chat", intentId: "image-1" }]]);
  assert.deepEqual(f.calls.filter(([name]) => name === "generate"), [["generate", { sessionId: "chat", intentId: "retry-image-1" }]]);
  for (const change of [{ pageId: "scene-002" }, { target: { kind: "cleanPlate" } }, { current: false }]) {
    const blocked = fixture(); Object.assign(blocked.image, change);
    await assert.rejects(blocked.execute("courseware_scene_image_refresh", { intentId: "image-1", retryFailed: true }), /confirm the first page|Scene plan changed/);
    assert(!blocked.calls.some(([name]) => name === "retry" || name === "generate"));
  }
});


test("workflow distinguishes confirmed cover style from service-pending decomposition", async () => {
  const f = fixture();
  f.rows.push({ ...f.image, intentId: "cover", selected: true, asset: { sha256: "c".repeat(64) } },
    { ...f.image, intentId: "decomposition", target: { kind: "cleanPlate" }, phase: "submission-unknown" });
  const result = await f.execute("courseware_workflow_get");
  assert.equal(result.styleConfirmed, true);
  assert.equal(result.requiresHumanSelection, false);
  const cover = await f.execute("courseware_scene_image_refresh", { intentId: "cover" });
  assert.equal(cover.requiresHumanSelection, false);
});

test("only an unselected cover requests human style review", async () => {
  for (const target of [{ kind: "visualMaster" }, { kind: "cleanPlate" }, { kind: "layer", name: "Circle" }]) {
    const f = fixture();
    Object.assign(f.image, { target, pageId: "scene-002", asset: { sha256: "b".repeat(64) } });
    const result = await f.execute("courseware_scene_image_refresh", { intentId: f.image.intentId });
    assert.equal(result.requiresHumanSelection, false);
    assert.equal(result.waitingFor, "coverStyle");
  }
});

test("Agent waits on original jobs until ready and automatically selects decomposition without human review", async () => {
  const f = fixture();
  f.rows.push({ ...f.image, intentId: "cover", selected: true, asset: { sha256: "c".repeat(64) } });
  Object.assign(f.image, { target: { kind: "cleanPlate" }, decomposition: true });
  f.rows.push({ ...f.image, intentId: "image-1-layer-1", target: { kind: "layer", name: "Circle" }, asset: { sha256: "d".repeat(64) } });
  f.states.push({ task: { state: "submitting", feeState: "reserved" } });
  const result = await f.execute("courseware_scene_image_refresh", { intentId: f.image.intentId, waitForUpdate: true });
  assert.equal(result.requiresHumanSelection, false);
  assert.equal(result.styleConfirmed, true);
  assert.equal(result.image.selected, true);
  assert.deepEqual(f.calls.filter(([name]) => name === "wait"), [["wait", 3000]]);
  assert.equal(f.calls.filter(([name]) => name === "status").length, 2);
  assert(!f.calls.some(([name]) => name === "generate"));
});

test("pending-job waits are bounded and preserve cancellation and plan fences", async () => {
  const f = fixture();
  f.states.push(...Array.from({ length: 11 }, () => ({ task: { state: "submitting", feeState: "reserved" } })));
  const result = await f.execute("courseware_scene_image_refresh", { intentId: f.image.intentId, waitForUpdate: true });
  assert.equal(result.waitingFor, "service");
  assert.equal(result.requiresHumanSelection, false);
  assert.equal(f.calls.filter(([name]) => name === "wait").length, 10);
  assert(!f.calls.some(([name]) => ["generate", "archive", "adopt"].includes(name)));
  const stopped = fixture(); stopped.stopOnWait();
  stopped.states.push({ task: { state: "queued", feeState: "reserved" } });
  await assert.rejects(stopped.execute("courseware_scene_image_refresh", { intentId: stopped.image.intentId, waitForUpdate: true }), /turn ended/);
  assert.equal(stopped.calls.filter(([name]) => name === "status").length, 1);
  assert(!stopped.calls.some(([name]) => ["generate", "archive", "adopt"].includes(name)));
  const changed = fixture(); changed.states.push({ task: { state: "submitted" } }, { current: false });
  await assert.rejects(changed.execute("courseware_scene_image_refresh", { intentId: changed.image.intentId, waitForUpdate: true }), /Scene plan changed/);
  assert.equal(changed.calls.filter(([name]) => name === "wait").length, 1);
  assert(!changed.calls.some(([name]) => ["generate", "archive", "adopt"].includes(name)));
});

test("ready bytes still wait for fee settlement before archive and adoption", async () => {
  const f = fixture();
  f.states.push({ task: { state: "ready", feeState: "reserved" } });
  const result = await f.execute("courseware_scene_image_refresh", { intentId: f.image.intentId, waitForUpdate: true });
  assert(result.image.asset);
  assert.equal(result.requiresHumanSelection, true);
  assert.deepEqual(f.calls.filter(([name]) => name === "wait"), [["wait", 3000]]);
  assert.equal(f.calls.filter(([name]) => name === "archive").length, 1);
});

test("upstream errors and unknown outcomes stop polling and expose the original failure", async () => {
  for (const state of ["submission_unknown", "archive_failed", "failed", "archiving"]) {
    const f = fixture();
    f.states.push({ task: { state, feeState: "reserved", errorCode: "UPSTREAM_HTTP_401" } });
    const result = await f.execute("courseware_scene_image_refresh", { intentId: f.image.intentId, waitForUpdate: true });
    assert.equal(result.waitingFor, null);
    assert.equal(result.image.task.errorCode, "UPSTREAM_HTTP_401");
    assert.equal(result.requiresHumanSelection, false);
    assert.equal(f.calls.filter(([name]) => name === "status").length, 1);
    assert(!f.calls.some(([name]) => ["wait", "generate", "archive", "adopt"].includes(name)));
  }
});


test("workspace observes compiler activity and saved source independently of Chat state", async () => {
  let release;
  const f = fixture({ compile: () => new Promise(resolve => { release = resolve; }) });
  const compilation = f.execute("courseware_scene_compile", { planSha256: f.plan.sha256 });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal((await f.coordinator.read("chat")).compilation.state, "running");
  release(); await compilation;
  const saved = await f.coordinator.read("chat");
  assert.equal(saved.task.sourcePath, "/workspace/result.pptx");
  assert.equal(saved.compilation, undefined);
});

test("compiler failure is scoped to its plan and never hides preserved assets", async () => {
  const f = fixture({ compile: async () => { throw new Error("Compiler failed"); } });
  await assert.rejects(f.execute("courseware_scene_compile", { planSha256: f.plan.sha256 }), /Compiler failed/);
  const view = await f.coordinator.read("chat");
  assert.equal(view.compilation.state, "failed"); assert.equal(view.task.generated, false);
  f.plan.sha256 = "b".repeat(64);
  assert.equal((await f.coordinator.read("chat")).compilation, undefined);
});

test("scene plan submission returns validated draft status without approving or generating", async () => {
  const f = fixture(); f.plan.approvedSha256 = null;
  const result = await f.execute("courseware_scene_plan_submit");
  assert.equal(result.validated, true);
  assert.equal(result.awaitingPlanApproval, true);
  assert.equal(result.plan.sha256, f.plan.sha256);
  assert(!f.calls.some(([name]) => ["compile", "generate", "courseware.scenePlan.approve"].includes(name)));
  await assert.rejects(f.execute("courseware_scene_plan_submit", { approve: true }), /valid scene plan/);
});
