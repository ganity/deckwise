import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import test from "node:test";
import ts from "typescript";
import * as runtime from "../../../packages/courseware-runtime/dist/node.mjs";
const exports = {};
new Function("require", "exports", ts.transpileModule(await readFile(new URL("../electron/main/courseware-classroom-native.ts", import.meta.url), "utf8"), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText)((id) => {
  if (id === "node:crypto") return { createHash };
  if (id === "node:fs/promises") return { readFile, writeFile, mkdir: async path => (await import("node:fs/promises")).mkdir(path, { recursive: true }) };
  if (id === "node:path") return { dirname };
  if (id === "@pi-desktop/courseware-runtime/node") return runtime;
  if (id === "./fs-panel") return { resolveRealPathForCreateWithinRoot: async (root, path) => join(root, path) };
  throw new Error(id);
}, exports);
const { reconcileMaicNativeSource, refreshNativeMaicClassroom } = exports;
function seed() {
  const input = { projectId: "project", revision: "canonical-1", sourceRevision: "old", currentSourceRevision: "new",
    classroom: { id: "classroom", stage: { id: "stage", name: "Lesson", createdAt: 1, updatedAt: 1 }, createdAt: "2026-01-01",
      scenes: [
        { id: "slide-1", stageId: "stage", type: "slide", title: "Opening", order: 0,
          content: { type: "slide", canvas: { id: "canvas", elements: [] } }, actions: [{ id: "speech", type: "speech", text: "Hello" }] },
        { id: "quiz", stageId: "stage", type: "quiz", title: "Check", order: 1,
          content: { type: "quiz", questions: [{ id: "q", type: "single", question: "Edited question", options: [{ value: "A", label: "Edited answer" }, { value: "C", label: "Other" }], answer: ["A"] }] } },
      ] },
    project: { pages: [{ pageId: "native-uuid", actions: [] }] },
    mapping: { pages: [{ pageId: "native-uuid", planPageId: "slide-1" }] },
    ir: { kind: "slide", sourceType: "pptx", pages: [{ id: "native-page", width: 1000, height: 625, elements: [] }] }, assets: [] };
  input.classroom.scenes[0].content.canvas = { ...runtime.mapMaicSlideIrToScenes("stage", input.ir)[0].content.canvas, id: "canvas" };
  return input;
}
test("native refresh updates slide canvas while retaining independently edited Quiz and scene identity", () => {
  const input = seed(), quiz = structuredClone(input.classroom.scenes[1]);
  const output = reconcileMaicNativeSource(input, new Map());
  assert.deepEqual(output.scenes[1], quiz);
  assert.equal(output.scenes[0].id, "slide-1");
  assert.equal(output.scenes[0].content.canvas.id, "canvas");
  assert.equal(output.scenes[0].content.canvas.viewportRatio, 0.625);
  assert.deepEqual(output.scenes[0].actions, input.classroom.scenes[0].actions);
});
test("unknown native page identity fails rather than assigning edited scenes by array position", () => {
  const input = seed(); input.mapping.pages[0].planPageId = "missing";
  assert.throws(() => reconcileMaicNativeSource(input, new Map()), /explicit reassociation/);
});
test("native TTS attaches only when text exactly matches canonical speech", () => {
  const input = seed(); input.sourceRevision = input.currentSourceRevision;
  input.project.pages[0].actions = [{ type: "speech", text: "Hello", audioAssetId: "audio" }];
  const resources = new Map([["audio", { url: ".deckwise-ppt/classroom-assets/audio.wav", mimeType: "audio/wav" }]]);
  const output = reconcileMaicNativeSource(input, resources);
  assert.equal(output.scenes[0].actions[0].audioUrl, resources.get("audio").url);
  assert.equal(output.audioManifest[0].actionId, "speech");
  input.classroom.scenes[0].actions[0].text = "Edited narration";
  assert.equal(reconcileMaicNativeSource(input, resources).audioManifest, undefined);
});
test("refresh persists with canonical CAS and current native source fence", async () => {
  const input = seed(), calls = [];
  const result = await refreshNativeMaicClassroom({ host: { async call(method, params) {
    calls.push({ method, params });
    if (method === "courseware.classroom.source") return input;
    return { projectId: "project", revision: "canonical-2", sourceRevision: "new", classroom: params.classroom };
  } }, sessionId: "session", projectId: "project", jobId: "job", workspace: "/unused" });
  assert.equal(result.revision, "canonical-2");
  assert.equal(calls[1].params.expectedRevision, "canonical-1");
  assert.equal(calls[1].params.expectedSourceRevision, "new");
  assert.equal(calls[0].params.jobId, "job");
});
test("changed archived native audio bytes fail before write", async () => {
  const root = await mkdtemp(join(tmpdir(), "maic-native-"));
  try {
    const input = seed(), path = join(root, "audio.wav"); await writeFile(path, "changed");
    input.assets = [{ id: "audio", path, sha256: "0".repeat(64), mimeType: "audio/wav" }];
    await assert.rejects(refreshNativeMaicClassroom({ host: { async call(method) {
      assert.equal(method, "courseware.classroom.source"); return input;
    } }, sessionId: "session", projectId: "project", jobId: "job", workspace: root }), /archived asset changed/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
function questionSeed() {
  const input = seed(), scene = input.classroom.scenes[0];
  scene.metadata = { nativeQuestionText: "Original?" };
  scene.content.canvas.elements = [{ id: "slide-1_question", type: "text", sourceShapeId: "42", left: 0, top: 0,
    width: 500, height: 100, rotate: 0, content: "<p>Original?</p>", defaultFontName: "Arial", defaultColor: "#000000" }];
  scene.actions.push({ id: "checkpoint", type: "interaction_checkpoint", checkpointKind: "chapter_summary", checkpointId: "cp",
    chapterId: "chapter", chapterTitle: "Chapter", question: "Original?", referenceAnswer: { summary: "Reference", keyPoints: ["Point"] },
    context: { chapterSummary: "Summary", sourceSceneIds: [scene.id] } });
  input.ir.pages[0].elements = [{ id: "import-question", type: "text", sourceShapeId: "42", left: 0, top: 0,
    width: 500, height: 100, content: "<p>Native edited?</p>" }];
  return input;
}
test("native question edit updates checkpoint through stable shape identity", () => {
  const output = reconcileMaicNativeSource(questionSeed(), new Map()), scene = output.scenes[0];
  assert.equal(scene.actions[1].question, "Native edited?");
  assert.equal(scene.content.canvas.elements[0].id, "slide-1_question");
  assert.equal(scene.metadata.nativeQuestionText, "Native edited?");
});
test("structured question edit survives unrelated native save; simultaneous edits require resolution", () => {
  const input = questionSeed(); input.classroom.scenes[0].actions[1].question = "Structured edit?";
  input.classroom.scenes[0].content.canvas.elements[0].content = "<p>Structured edit?</p>";
  assert.throws(() => reconcileMaicNativeSource(input, new Map()), /both native and structured editors/);
  input.ir.pages[0].elements[0].content = "<p>Original?</p>";
  const output = reconcileMaicNativeSource(input, new Map());
  assert.equal(output.scenes[0].actions[1].question, "Structured edit?");
  assert.equal(output.scenes[0].content.canvas.elements[0].content, "<p>Structured edit?</p>");
});
test("native background resources are archived in the MAIC media manifest", () => {
  const input = seed(); input.ir.pages[0].background = { type: "image", src: "import-asset:local:bg" };
  const resource = { url: ".deckwise-ppt/classroom-assets/bg.png", mimeType: "image/png" };
  const output = reconcileMaicNativeSource(input, new Map([["import-asset:local:bg", resource]]));
  assert(output.mediaManifest.some(asset => asset.src === resource.url && output.scenes[0].content.canvas.elements.some(element => element.id === asset.elementId)));
  assert(!JSON.stringify(output.scenes).includes("import-asset:"));
});
test("native reordered slides move within course slide slots while independent Quiz stays in its slot", () => {
  const input = seed(), extra = structuredClone(input.classroom.scenes[0]);
  extra.id = "slide-2"; extra.order = 2; extra.content.canvas.id = "canvas-2";
  input.classroom.scenes.push(extra);
  input.project.pages.unshift({ pageId: "native-2", actions: [] });
  input.mapping.pages.unshift({ pageId: "native-2", planPageId: "slide-2" });
  input.ir.pages.unshift({ id: "page-2", width: 1000, height: 625, elements: [] });
  const output = reconcileMaicNativeSource(input, new Map());
  assert.deepEqual(output.scenes.map(scene => scene.id), ["slide-2", "quiz", "slide-1"]);
});
test("native deletion never silently removes independently edited course data", () => {
  const input = seed(); input.classroom.scenes[0].metadata = { nativePageId: "native-uuid" }; input.project.pages = []; input.mapping.pages = []; input.ir.pages = [];
  assert.throws(() => reconcileMaicNativeSource(input, new Map()), /no longer exists/);
});

test("first native save binds generated question by persisted objectName before sourceShapeId exists", () => {
  const input = questionSeed();
  delete input.classroom.scenes[0].content.canvas.elements[0].sourceShapeId;
  input.ir.pages[0].elements[0].sourceObjectName = "slide-1_question";
  const output = reconcileMaicNativeSource(input, new Map());
  assert.equal(output.scenes[0].actions[1].question, "Native edited?");
  assert.equal(output.scenes[0].content.canvas.elements[0].id, "slide-1_question");
});
test("native narration changes and splits update compatible speech while retaining checkpoints", () => {
  const input = questionSeed(); input.sourceRevision = input.currentSourceRevision;
  input.classroom.scenes[0].metadata.nativeNarrationText = "Hello";
  input.project.pages[0].actions = [{ id: "n1", type: "speech", text: "New part 1" }, { id: "n2", type: "speech", text: "New part 2" }];
  const output = reconcileMaicNativeSource(input, new Map()), actions = output.scenes[0].actions;
  assert.deepEqual(actions.filter(action => action.type === "speech").map(action => action.text), ["New part 1", "New part 2"]);
  assert.equal(actions[2].id, "checkpoint");
  assert.equal(actions[0].id, "speech");
});
test("simultaneous narration edits and unsupported native teaching fail explicitly", () => {
  const input = seed(); input.classroom.scenes[0].metadata = { nativeNarrationText: "Hello" };
  input.project.pages[0].actions = [{ id: "n", type: "speech", text: "Native edited" }];
  input.classroom.scenes[0].actions[0].text = "Structured edit";
  assert.throws(() => reconcileMaicNativeSource(input, new Map()), /Narration changed in both/);
  input.classroom.scenes[0].actions[0].text = "Hello";
  input.project.pages[0].actions.push({ id: "control", type: "delay", durationMs: 500 });
  assert.throws(() => reconcileMaicNativeSource(input, new Map()), /explicit MAIC translation: delay/);
});

test("canonical regenerated voice is preserved when native TTS has not changed", () => {
  const input = seed(); input.sourceRevision = input.currentSourceRevision;
  input.classroom.scenes[0].metadata = { nativeAudioBindings: { native: "old-native-audio" } };
  input.classroom.scenes[0].actions[0].audioId = "new-canonical-voice";
  input.classroom.scenes[0].actions[0].audioUrl = ".deckwise-ppt/classroom-assets/new.wav";
  input.project.pages[0].actions = [{ id: "native", type: "speech", text: "Hello", audioAssetId: "old-native-audio" }];
  const output = reconcileMaicNativeSource(input, new Map([["old-native-audio", { url: ".deckwise-ppt/classroom-assets/old.wav", mimeType: "audio/wav" }]]));
  assert.equal(output.scenes[0].actions[0].audioId, "new-canonical-voice");
});
