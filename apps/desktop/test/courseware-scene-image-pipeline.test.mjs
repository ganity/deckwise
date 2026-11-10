import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";
import * as shared from "@pi-desktop/shared";

async function load(name, dependencies = {}) {
  const source = await readFile(new URL(`../electron/main/${name}.ts`, import.meta.url), "utf8");
  const exports = {};
  new Function("require", "exports", ts.transpileModule(source, { compilerOptions: {
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS,
  } }).outputText)(id => { assert(Object.hasOwn(dependencies, id), id); return dependencies[id]; }, exports);
  return exports;
}
const queues = await load("courseware-generation-queue");
const { runSceneImagePipeline } = await load("courseware-scene-image-pipeline", {
  "@pi-desktop/shared": shared, "./courseware-generation-queue": queues,
});
const gate = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const flush = async () => { for (let i = 0; i < 300; i++) await Promise.resolve(); };
function fixture(count = 3, hold = async () => {}) {
  const plan = { sha256: "a".repeat(64), approvedSha256: "a".repeat(64), pages: Array.from({ length: count }, (_, index) => ({ pageId: `scene-${String(index + 1).padStart(3, "0")}` })) };
  const rows = [], calls = [], posts = [], active = { visualMaster: 0, cleanPlate: 0 }, peak = { ...active };
  const generation = { visualMaster: new queues.CoursewareGenerationQueue(5), cleanPlate: new queues.CoursewareGenerationQueue(5) };
  let dispatchable = true;
  const check = () => { if (!dispatchable) throw new Error("turn cancelled"); };
  const make = (pageId, kind, intentId = `${pageId}-${kind}`, referenceImage) => ({ intentId, pageId, planSha256: plan.sha256,
    target: { kind }, current: true, selected: false, phase: "prepared", task: null, asset: null,
    ...(referenceImage ? { referenceImage } : {}), ...(kind === "cleanPlate" ? { decomposition: true } : {}) });
  const finish = row => {
    row.selected = true; row.asset = { sha256: row.intentId, byteLength: 100 };
    row.phase = "submitted"; row.task = { state: "ready", feeState: "settled", errorCode: null };
    if (row.target.kind === "cleanPlate") rows.push({ ...row, intentId: `${row.intentId}-layer-1`, target: { kind: "layer", name: "Animal" } });
    return row;
  };
  rows.push(finish(make("scene-001", "visualMaster")));
  const services = {
    check,
    async images() { check(); return structuredClone(rows); },
    async execute(name, args) {
      check(); calls.push({ name, args });
      let row = rows.find(row => row.intentId === args.intentId);
      if (name === "courseware_scene_image_prepare") {
        const master = rows.find(row => row.intentId === args.referenceIntentId);
        row = make(args.pageId, args.target.kind, undefined, master ? { intentId: master.intentId, sha256: master.asset.sha256 } : undefined);
        rows.push(row);
      }
      assert(row);
      if (row.phase === "prepared") await generation[row.target.kind].run(async () => {
        check();
        posts.push({ pageId: row.pageId, kind: row.target.kind, intentId: row.intentId, referenceImage: row.referenceImage });
        active[row.target.kind]++; peak[row.target.kind] = Math.max(peak[row.target.kind], active[row.target.kind]);
        try { await hold(row); check(); finish(row); return { state: "ready" }; }
        finally { active[row.target.kind]--; }
      }, async () => row.task, undefined, check);
      return { image: structuredClone(row) };
    },
  };
  return { plan, rows, calls, posts, peak, make, services, stop: () => { dispatchable = false; }, run: () => runSceneImagePipeline(plan, services) };
}

test("per-page handoff overlaps masters and decomposition with real independent five-slot queues", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const masters = new Map(Array.from({ length: 11 }, (_, i) => [`scene-${String(i + 2).padStart(3, "0")}`, gate()]));
  const split = gate();
  const f = fixture(12, row => row.target.kind === "visualMaster" ? masters.get(row.pageId).promise : split.promise);
  const pending = f.run(); await flush();
  assert.equal(f.posts.filter(row => row.kind === "visualMaster").length, 5);
  assert(f.posts.some(row => row.kind === "cleanPlate" && row.pageId === "scene-001"), "cover decomposition starts without waiting for later masters");
  for (const [pageId, held] of masters) if (pageId !== "scene-002") held.resolve();
  await flush();
  assert.equal(f.posts.filter(row => row.kind === "visualMaster").length, 11, "a slow split does not occupy master workers");
  assert.equal(f.posts.filter(row => row.kind === "cleanPlate").length, 5);
  assert(f.posts.some(row => row.kind === "cleanPlate" && row.pageId === "scene-003"));
  assert(!f.rows.find(row => row.pageId === "scene-002").selected, "a slow page does not block another page's split");
  assert.deepEqual(f.peak, { visualMaster: 5, cleanPlate: 5 });
  masters.get("scene-002").resolve(); split.resolve();
  const result = await pending;
  assert.deepEqual(result, { ready: true, failures: [], blockers: [] });
  assert.equal(f.posts.length, 23);
  for (const post of f.posts.filter(row => row.kind === "cleanPlate")) {
    const master = f.rows.find(row => row.pageId === post.pageId && row.target.kind === "visualMaster");
    assert.deepEqual(post.referenceImage, { intentId: master.intentId, sha256: master.asset.sha256 });
  }
  await f.run(); assert.equal(f.posts.length, 23, "resume reuses every verified selected asset");
});

test("failed and unknown originals are read once without retries while independent pages finish", async () => {
  const f = fixture(4);
  f.rows.push({ ...f.make("scene-002", "visualMaster", "failed-original"), phase: "submitted", task: { state: "failed", errorCode: "PolicyViolation" } });
  f.rows.push({ ...f.make("scene-003", "visualMaster", "unknown-original"), phase: "submission-unknown" });
  const result = await f.run();
  assert.equal(result.ready, false);
  assert.deepEqual(result.failures.map(row => [row.pageId, row.intentId, row.error]).sort(), [
    ["scene-002", "failed-original", "PolicyViolation"], ["scene-003", "unknown-original", "Scene image unknown"],
  ]);
  assert.deepEqual(f.posts.map(row => row.pageId).sort(), ["scene-001", "scene-004", "scene-004"]);
  assert(f.calls.every(call => !call.args.retryFailed));
  assert.equal(f.calls.filter(call => call.args.intentId === "unknown-original").length, 1);
  await f.run(); assert.equal(f.posts.length, 3);
});

test("saved prepared and submitted jobs keep their original IDs and pending polls are query-only", async () => {
  const f = fixture(3);
  f.rows.push(f.make("scene-002", "visualMaster", "prepared-original"));
  const submitted = { ...f.make("scene-003", "visualMaster", "submitted-original"), phase: "submitted", task: { state: "queued" } };
  f.rows.push(submitted);
  const execute = f.services.execute;
  f.services.execute = async (name, args) => {
    if (args.intentId === submitted.intentId && args.waitForUpdate) {
      assert.equal(args.generatePrepared, undefined);
      submitted.selected = true; submitted.asset = { sha256: "saved-master", byteLength: 100 }; submitted.task = { state: "ready" };
    }
    return execute(name, args);
  };
  assert.equal((await f.run()).ready, true);
  assert(f.posts.some(row => row.intentId === "prepared-original"));
  assert(!f.posts.some(row => row.intentId === "submitted-original"));
  assert(f.calls.some(call => call.args.intentId === "submitted-original" && call.args.waitForUpdate));
});

test("resume processes a newer replacement master instead of reusing the old selected design", async () => {
  const f = fixture(2);
  f.rows.push({ ...f.make("scene-002", "visualMaster", "old-master"), selected: true, asset: { sha256: "old" } });
  const replacement = f.make("scene-002", "visualMaster", "replacement-master");
  f.rows.push(replacement);
  const execute = f.services.execute;
  f.services.execute = async (name, args) => {
    const result = await execute(name, args);
    if (args.intentId === replacement.intentId) f.rows.find(row => row.intentId === "old-master").selected = false;
    return result;
  };
  assert.equal((await f.run()).ready, true);
  assert(f.calls.some(call => call.args.intentId === replacement.intentId));
  assert.deepEqual(f.posts.find(row => row.kind === "cleanPlate" && row.pageId === "scene-002").referenceImage,
    { intentId: replacement.intentId, sha256: replacement.intentId });
});

test("stop joins started work and prevents queued or dependent submissions", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const held = gate(), f = fixture(12, () => held.promise);
  const pending = f.run(); const stopped = assert.rejects(pending, /turn cancelled/);
  await flush(); const paid = f.posts.length;
  f.stop(); held.resolve(); await stopped;
  assert.equal(f.posts.length, paid);
  assert.equal(f.posts.filter(row => row.kind === "cleanPlate").length, 1);
});

test("a selected split for another source blocks just that page without replacement spending", async () => {
  const f = fixture(2);
  f.rows.push({ ...f.make("scene-001", "cleanPlate", "old-split", { intentId: "old-master", sha256: "old" }), selected: true, asset: { sha256: "old-background" } });
  const result = await f.run();
  assert.equal(result.ready, false);
  assert(result.failures.some(row => row.pageId === "scene-001" && /another master/.test(row.error)));
  assert(!f.posts.some(row => row.pageId === "scene-001"));
  assert.equal(f.posts.filter(row => row.pageId === "scene-002").length, 2);
});

test("actual Main entry runs the pipeline through its scoped image actions and never compiles", async () => {
  const f = fixture(3), held = gate();
  const execute = f.services.execute;
  f.services.execute = async (name, args) => {
    if (name === "courseware_scene_image_prepare" && args.pageId === "scene-002") await held.promise;
    return execute(name, args);
  };
  class Images {
    async list() { return f.services.images(); }
    async status({ intentId }) { f.services.check(); return structuredClone(f.rows.find(row => row.intentId === intentId)); }
    async prepare(args) { return (await f.services.execute("courseware_scene_image_prepare", args)).image; }
  }
  const { CoursewareChatWorkflow } = await load("courseware-chat-workflow", {
    "@pi-desktop/shared": shared,
    "./courseware-presentation": { adoptPresentation: () => assert.fail("Scene tasks cannot adopt ordinary exports") },
    "./courseware-presentation-prepare": { preparePresentation: () => assert.fail("Scene tasks cannot prepare ordinary pages") },
    "node:timers/promises": { setTimeout: async () => {} },
    "./courseware-scene-draft": { readSceneCourseDraft: async () => ({ plan: structuredClone(f.plan) }) },
    "./courseware-scene-images": { CoursewareSceneImages: Images },
    "./courseware-scene-image-pipeline": { runSceneImagePipeline },
    "./courseware-scene-generation": { CoursewareSceneGeneration: class { constructor() { assert.fail("unrequested compilation"); } } },
  });
  const host = { async call(method) {
    if (method === "session.get") return { session: { projectPath: "/fixture", mode: "agent" } };
    assert.equal(method, "courseware.task.get"); return { task: { taskType: "scene" } };
  } };
  const main = new CoursewareChatWorkflow(() => host, () => "chat", {}, {});
  const pending = main.execute("chat", "courseware_scene_image_refresh", { intentId: f.rows[0].intentId, generateRemaining: true }, () => true);
  await flush();
  assert(f.posts.some(row => row.pageId === "scene-003" && row.kind === "cleanPlate"));
  assert(!f.posts.some(row => row.pageId === "scene-002"));
  held.resolve();
  const result = await pending;
  assert.equal(result.pipeline.ready, true); assert.equal(result.styleConfirmed, true);
  assert.equal(f.posts.length, 5);
});

test("decomposition policy failure preserves the original while other pages reach readiness", async () => {
  const f = fixture(3), execute = f.services.execute;
  f.services.execute = async (name, args) => {
    const result = await execute(name, args);
    if (args.pageId === "scene-002" && args.target?.kind === "cleanPlate") {
      const row = f.rows.find(row => row.intentId === result.image.intentId);
      row.asset = null; row.selected = false; row.task = { state: "failed", errorCode: "OutputImageSensitiveContentDetected.PolicyViolation" };
      return { image: structuredClone(row) };
    }
    return result;
  };
  const result = await f.run();
  assert.equal(result.ready, false);
  assert.equal(result.failures[0].intentId, "scene-002-cleanPlate");
  assert.equal(result.failures[0].error, "OutputImageSensitiveContentDetected.PolicyViolation");
  assert(result.blockers.every(row => row.pageId === "scene-002"));
  assert(f.rows.some(row => row.pageId === "scene-003" && row.target.kind === "cleanPlate" && row.selected));
});

test("Quiz and checkpoint pages never enter image generation queues", async () => {
  const f = fixture(2);
  f.plan.pages.unshift({ pageId: 'quiz', quiz: { type: 'quiz' } }, { pageId: 'checkpoint', teaching: { question: { text: 'Why?' } } });
  assert.equal((await f.run()).ready, true);
  assert(f.posts.length > 0);
  assert(f.posts.every(row => !['quiz', 'checkpoint'].includes(row.pageId)));
});
