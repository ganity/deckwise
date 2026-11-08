import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";
import * as shared from "../../../packages/shared/dist/index.js";

const source = await readFile(new URL("../electron/main/courseware-scene-workflow.ts", import.meta.url), "utf8");
const { outputText } = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } });
const module = { exports: {} };
new Function("require", "exports", outputText)((id) => {
  if (id === "@pi-desktop/shared") return shared;
  throw new Error(`Unexpected dependency: ${id}`);
}, module.exports);
const { assembleSceneCourse } = module.exports;
const makeInput = () => ({ workspace: "/workspace", sessionId: "scene-chat", modelKey: "provider/model",
  plan: { title: "问候课", pages: [{ pageId: "scene-001", sourceHash: `sha256:${"a".repeat(64)}`,
    title: "Hello", visibleText: ["Hello"], visualIntent: "Two friends waving", narration: "挥挥手，说 Hello。Good!" }] },
  assignments: [], canvas: { width: 1280, height: 800 } });

function setup(input, after = () => {}) {
  const calls = [];
  const visuals = [{ pageId: "scene-001", images: [] }];
  const deck = { pptx: new Uint8Array([80, 75]), mapping: { pages: [] }, teaching: input.plan.pages.map(({ pageId, narration }) => ({ pageId, narration })) };
  const services = {
    async resolve(value) { calls.push(["resolve", value]); after("resolve"); return visuals; },
    async build(value) { calls.push(["build", value]); after("build"); return deck; },
    async stage(value) { calls.push(["stage", value]); return { path: "/workspace/generated.pptx", sha256: "saved" }; },
  };
  return { calls, deck, visuals, services };
}

test("approved plan and authorized assets flow through compilation to durable Host handoff", async () => {
  const input = makeInput(), f = setup(input);
  input.sceneProof = { planSha256: "a".repeat(64), principalKey: "b".repeat(64), selectedIntentIds: ["image-1"] };
  const result = await assembleSceneCourse(input, f.services, async () => {});
  assert.deepEqual(f.calls.map(([name]) => name), ["resolve", "build", "stage"]);
  assert.equal(f.calls[0][1].pages[0].pageId, "scene-001");
  assert.equal(f.calls[1][1].visuals, f.visuals);
  assert.equal(f.calls[1][1].modelKey, "provider/model");
  assert.equal(f.calls[2][1].pptx, f.deck.pptx);
  assert.deepEqual(f.calls[2][1].sceneMapping, f.deck.mapping);
  assert.deepEqual(f.calls[2][1].sceneProof, input.sceneProof);
  assert.deepEqual(f.calls[2][1].teaching, [{ pageId: "scene-001", narration: input.plan.pages[0].narration }]);
  assert.equal(f.calls[2][1].title, input.plan.title);
  assert.equal(result.path, "/workspace/generated.pptx");
});

test("legacy assembly without reviewed proof does not write semantic mapping", async () => {
  const input = makeInput(), f = setup(input);
  await assembleSceneCourse(input, f.services, async () => {});
  assert.equal(f.calls[2][1].sceneMapping, undefined);
  assert.equal(f.calls[2][1].sceneProof, undefined);
});

test("changes to caller-owned plan and paths cannot redirect an in-flight course", async () => {
  const input = makeInput(), original = structuredClone(input);
  const f = setup(input, () => { input.plan.title = "Replacement"; input.workspace = "/other"; input.plan.pages[0].narration = "Changed"; });
  await assembleSceneCourse(input, f.services, async () => {});
  assert.equal(f.calls[2][1].title, original.plan.title);
  assert.equal(f.calls[2][1].workspace, original.workspace);
  assert.equal(f.calls[1][1].pages[0].narration, original.plan.pages[0].narration);
});

test("task changes and cancellation stop before the next model call or project write", async () => {
  for (const phase of ["resolve", "build"]) for (const cancel of [false, true]) {
    const input = makeInput(), controller = new AbortController();
    input.signal = controller.signal;
    let stale = false;
    const f = setup(input, (step) => { if (step === phase) { stale = true; if (cancel) controller.abort(); } });
    await assert.rejects(assembleSceneCourse(input, f.services, async () => { if (stale) throw new Error("Task changed"); }));
    assert.deepEqual(f.calls.map(([name]) => name), phase === "resolve" ? ["resolve"] : ["resolve", "build"]);
  }
});

test("invalid plan and failed asset resolution do not generate or attach a course", async () => {
  const input = makeInput(), f = setup(input);
  input.plan.title = " ";
  await assert.rejects(assembleSceneCourse(input, f.services, async () => {}), /Invalid approved/);
  assert.equal(f.calls.length, 0);
  const valid = makeInput(), failure = setup(valid);
  failure.services.resolve = async () => { throw new Error("Asset authorization denied"); };
  await assert.rejects(assembleSceneCourse(valid, failure.services, async () => {}), /authorization denied/);
  assert.equal(failure.calls.length, 0);
});
