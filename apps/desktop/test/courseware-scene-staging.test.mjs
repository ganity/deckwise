import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdtemp, readFile, rm, mkdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import ts from "typescript";
import * as shared from "@pi-desktop/shared";
import * as runtime from "@pi-desktop/courseware-runtime/node";
import * as authoring from "../../../packages/courseware-runtime/dist/authoring.mjs";
import { Host } from "../../../scripts/e2e/host.mjs";

const require = createRequire(import.meta.url), cache = new Map([[new URL("../../../packages/courseware-runtime/dist/authoring.mjs", import.meta.url).href, authoring], ["@pi-desktop/shared", shared], ["@pi-desktop/courseware-runtime/node", runtime],
  ["./courseware-runtime", { coursewareAuthoringUrl: () => new URL("../../../packages/courseware-runtime/dist/authoring.mjs", import.meta.url).href }]]);
function load(name) {
  if (cache.has(name)) return cache.get(name);
  if (!name.startsWith("./")) return require(name);
  const exports = {}; cache.set(name, exports);
  const code = ts.transpileModule(readFileSync(new URL(`../electron/main/${name.slice(2)}.ts`, import.meta.url), "utf8"), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true },
  }).outputText;
  new Function("require", "exports", code)(load, exports); return exports;
}
const { stageGeneratedSceneCourse } = load("./courseware-scene-staging");
const { readNativeTeachingPackage } = load("./courseware-native-package");
const hash = b => createHash("sha256").update(b).digest("hex");
const teaching = { pageType: "slide", phase: "explore", objective: "Say Hello", durationSeconds: 30, requiredObjects: [] };
const pages = [
  { pageId: "scene-001", title: "Greeting", narration: "Look at the teacher. Say hello.", teaching: { ...teaching,
    music: { purpose: "Greeting song", prompt: "A short greeting song" }, video: { purpose: "Greeting clip", prompt: "Teacher waves" } } },
  { pageId: "scene-002", title: "Quiz", narration: "", teaching: { ...teaching, pageType: "quiz" },
    quiz: { type: "quiz", questions: [{ id: "quiz1", type: "single", question: "Choose the greeting", options: [{ value: "A", label: "Bye" }, { value: "B", label: "Hello" }], answer: ["B"] }] } },
  { pageId: "scene-003", title: "Practice", narration: "", teaching: { ...teaching, pageType: "interactive",
    question: { text: "Greet your friend.", response: { kind: "practice", options: [], answerIndices: [] },
      referenceAnswer: { summary: "Say Hello", keyPoints: ["Hello"] }, constraintPrompt: "Wait for the teacher" } } },
];
async function compiled() {
  const canvas = { width: 1280, height: 800 }, png = authoring.assessmentBackground;
  return authoring.compileScenesToPptx(pages.map((p, i) => ({ version: 1, slideId: p.pageId, sourceHash: "sha256:" + "a".repeat(64), canvas,
    visualMasterAssetId: png.id, cleanPlateAssetId: png.id, elements: [{ id: `text-${i}`, type: "native_text", bboxPx: [40, 40, 1000, 200], zIndex: 1,
      content: p.teaching.question?.text ?? p.title, style: { fontFace: "Arial", fontSizePt: 28, color: "#111111" } }] })), { [png.id]: png.bytes });
}
async function setup(t) {
  const workspace = await mkdtemp(join(tmpdir(), "native-generation-"));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  const deck = await compiled(), calls = []; let observed;
  const host = { async call(method, params) {
    calls.push(method);
    if (method === "courseware.task.get") return { task: {} };
    if (method === "courseware.parseStart") { observed = await readFile(params.path); return { jobId: "job" }; }
    if (method === "courseware.parseStatus") return { status: "SUCCEEDED", summary: { sourceSha256: hash(observed) } };
    if (method === "courseware.task.attachNativeGenerated") { assert.equal(params.project.source.sha256, hash(observed)); return { task: { generatedPath: params.path } }; }
    if (["courseware.parseRelease", "courseware.parseCancel"].includes(method)) return {};
    assert.fail(`Unexpected mutable teaching route: ${method}`);
  } };
  return { workspace, deck, calls, host, input: { workspace, sessionId: "session", title: "Greeting course", pptx: deck.pptx, teaching: pages, host } };
}
test("mixed scene generation publishes native teaching, Quiz answers and media slots before opening an editor", async t => {
  const f = await setup(t), result = await stageGeneratedSceneCourse(f.input);
  const bytes = await readFile(result.path), native = await readNativeTeachingPackage(bytes);
  assert.deepEqual(native.assessments["scene-002"], pages[1].quiz);
  assert.equal(native.pages.length, 3); assert.equal(native.documentId, result.project.projectId);
  assert.deepEqual(native.pages[0].actions.map(a => a.type), ["music_slot", "video_slot"]);
  assert.equal(native.generation.pages[0].narration, pages[0].narration, "the plan remains evidence, not completed narration");
  assert.deepEqual(native.pages[1].actions[1].response, { kind: "single", options: ["Bye", "Hello"], answerIndices: [1] });
  assert.equal(native.pages[1].actions[0].text, "Choose the greeting\nA. Bye\nB. Hello");
  assert.equal(native.pages[2].actions[1].response.kind, "practice");
  assert.match(native.pages[2].actions[1].context.chapterSummary, /Wait for the teacher/);
  assert.equal(native.identity.pages.every(p => p.objects.length === 1), true);
  assert.deepEqual(f.calls, ["courseware.task.get", "courseware.parseStart", "courseware.parseStatus", "courseware.task.attachNativeGenerated", "courseware.parseRelease"]);
  assert.equal((await stageGeneratedSceneCourse(f.input)).path, result.path, "retry keeps the same native file and IDs");
  assert.deepEqual(await readFile(result.path), bytes);
});
test("Quiz-only generation still creates a physical native PPTX with its answer key", async t => {
  const f = await setup(t), png = authoring.assessmentBackground;
  const q = pages[1], scene = authoring.assessmentPptxScene({ id: q.pageId, stageId: "q", title: q.title, order: 0, type: "quiz", content: q.quiz, actions: [] }, "sha256:" + "a".repeat(64), { width: 1280, height: 800 });
  const deck = await authoring.compileScenesToPptx([scene], { [png.id]: png.bytes });
  const result = await stageGeneratedSceneCourse({ ...f.input, pptx: deck.pptx, teaching: [q] });
  assert(result.path.endsWith(".pptx"));
  assert.equal((await readNativeTeachingPackage(await readFile(result.path))).pages[0].actions[1].response.answerIndices[0], 1);
});
test("cancelled owners, missing physical question bindings and failed parsers cannot attach generated teaching", async t => {
  const f = await setup(t);
  await assert.rejects(stageGeneratedSceneCourse({ ...f.input, assertCurrent: async () => { throw Error("OWNER_CHANGED"); } }), /OWNER_CHANGED/);
  assert.deepEqual(f.calls, []);
  const bad = structuredClone(pages); bad[2].teaching.question.text = "Absent from the PPT";
  await assert.rejects(stageGeneratedSceneCourse({ ...f.input, teaching: bad }), /exact interaction question/);
  assert.deepEqual(f.calls, ["courseware.task.get"]);
  await assert.rejects(stageGeneratedSceneCourse({ ...f.input, host: { async call(method) {
    f.calls.push(method);
    if (method === "courseware.task.get") return { task: {} };
    if (method === "courseware.parseStart") return { jobId: "job" };
    if (method === "courseware.parseStatus") return { status: "FAILED", message: "Parser rejected source" };
    if (method === "courseware.parseRelease") return {};
    assert.fail(method);
  } } }), /Parser rejected source/);
  assert(!f.calls.includes("courseware.task.attachNativeGenerated"));
  assert.equal(f.calls.at(-1), "courseware.parseRelease");
});
test("generated native lesson attaches to real Host and survives restart without mutable teaching records", {
  skip: !process.env.DECKWISE_E2E_WORKFLOW_HOST, timeout: 120000,
}, async t => {
  const f = await setup(t), data = join(f.workspace, "profile");
  await mkdir(join(data, "plugins/market"), { recursive: true });
  await writeFile(join(data, "plugins/market/catalog.json"), JSON.stringify({ schemaVersion: 2, providerId: "official", plugins: [] }));
  let host = new Host(process.env.DECKWISE_E2E_WORKFLOW_HOST, data); await host.start();
  t.after(() => host.stop());
  const sessionId = (await host.call("session.create", { projectPath: f.workspace, mode: "agent" })).session.id;
  await host.call("courseware.task.set", { sessionId, taskType: "scene" });
  const result = await stageGeneratedSceneCourse({ ...f.input, host, sessionId });
  const native = await readNativeTeachingPackage(await readFile(result.path));
  assert.equal((await host.call("courseware.task.get", { sessionId })).task.nativeDocumentId, native.documentId);
  await assert.rejects(host.call("courseware.project.context", { sessionId, projectId: native.documentId }), /not found|NOT_FOUND/i);
  await host.stop(); host = new Host(process.env.DECKWISE_E2E_WORKFLOW_HOST, data); await host.start();
  assert.equal((await host.call("courseware.task.get", { sessionId })).task.generatedPath, result.path);
  assert.deepEqual((await readNativeTeachingPackage(await readFile(result.path))).pages, native.pages);
  const retry = await stageGeneratedSceneCourse({ ...f.input, host, sessionId });
  assert.equal(retry.path, result.path);
  if (process.env.DECKWISE_NATIVE_GENERATED_FIXTURE) {
    await mkdir(process.env.DECKWISE_NATIVE_GENERATED_FIXTURE, { recursive: true });
    await writeFile(join(process.env.DECKWISE_NATIVE_GENERATED_FIXTURE, "native.pptx"), await readFile(result.path));
    await writeFile(join(process.env.DECKWISE_NATIVE_GENERATED_FIXTURE, "teaching.json"), JSON.stringify(native));
  }
});
