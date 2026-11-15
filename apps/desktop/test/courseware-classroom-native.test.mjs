import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import test from "node:test";
import ts from "typescript";
import * as runtime from "../../../packages/courseware-runtime/dist/node.mjs";
const timeline = {};
new Function("require", "exports", ts.transpileModule(await readFile(new URL("../electron/main/courseware-classroom-timeline.ts", import.meta.url), "utf8"), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText)(id => { if (id === "@pi-desktop/courseware-runtime/node") return runtime; throw Error(id); }, timeline);
const exports = {};
new Function("require", "exports", ts.transpileModule(await readFile(new URL("../electron/main/courseware-classroom-native.ts", import.meta.url), "utf8"), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText)((id) => {
  if (id === "node:crypto") return { createHash, randomUUID };
  if (id === "node:fs/promises") return { readFile, writeFile, mkdir: async path => (await import("node:fs/promises")).mkdir(path, { recursive: true }) };
  if (id === "node:path") return { dirname };
  if (id === "@pi-desktop/courseware-runtime/node") return runtime;
  if (id === "./courseware-classroom-timeline") return timeline;
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
test("native reconciliation records the verified teaching revision for subsequent assessment reads", () => {
  const input = seed();
  input.project.teachingRevision = "verified-teaching";
  const output = reconcileMaicNativeSource(input, new Map());
  assert.equal(output.scenes[0].metadata.nativeTeachingRevision,"verified-teaching");
  assert.equal(output.scenes[0].metadata.nativePageId,"native-uuid");
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
test("repeated narration retains each saved speech's own audio", () => {
  const input = seed(); input.sourceRevision = input.currentSourceRevision;
  input.classroom.scenes[0].actions = [{ id: "one", type: "speech", text: "Hello" }, { id: "two", type: "speech", text: "Hello" }];
  input.project.pages[0].actions = [{ id: "native-one", type: "speech", text: "Hello", audioAssetId: "first" },
    { id: "native-two", type: "speech", text: "Hello", audioAssetId: "second" }];
  const resources = new Map(["first", "second"].map(id => [id, { url: `asset:${id}`, mimeType: "audio/wav" }]));
  const output = reconcileMaicNativeSource(input, resources);
  assert.deepEqual(output.scenes[0].actions.map(a => a.audioId), ["first", "second"]);
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
test("native narration refresh preserves separately managed checkpoint question speech", () => {
  const input = questionSeed(); input.sourceRevision = input.currentSourceRevision;
  input.ir.pages[0].elements[0].content = "<p>Original?</p>";
  input.classroom = runtime.prepareMaicAssessmentSpeech(input.classroom);
  input.project.pages[0].actions = [{ id: "native-speech", type: "speech", text: "Hello" }, { id: "pause", type: "delay", durationMs: 100 }];
  const output = reconcileMaicNativeSource(input, new Map());
  assert(output.scenes[0].actions.some(a => a.id === "checkpoint-question-tts"));
  assert(!output.scenes[0].metadata.nativeTeachingActionIds.includes("checkpoint-question-tts"));
  assert.equal(output.scenes[0].metadata.nativeNarrationText, "Hello");
});
for (const route of ['import', 'ppt-master']) test(`${route}: native questions initialize common canonical teaching without a generated scene plan`, async () => {
  const input = questionSeed(), checkpoint = input.classroom.scenes[0].actions.find(action => action.type === 'interaction_checkpoint');
  input.project.pages[0].actions = [checkpoint]; input.classroom = null; input.revision = null;
  input.ir.title = 'Original lesson';
  let saved;
  const view = await refreshNativeMaicClassroom({sessionId:'session',projectId:input.projectId,jobId:'job',workspace:'/unused',
    host:{call:async(method,args)=>{
      if(method==='courseware.classroom.source')return structuredClone(input);
      assert.equal(method,'courseware.classroom.refresh'); assert.equal(args.expectedRevision,null);
      saved=args.classroom; return {projectId:input.projectId,revision:'canonical-new',sourceRevision:input.currentSourceRevision,classroom:saved};
    }}});
  assert.equal(saved.stage.name,'Original lesson');
  assert.equal(saved.scenes[0].metadata.nativePageId,'native-uuid');
  assert.equal(saved.scenes[0].metadata.nativeEmbeddedAssessments,true);
  assert.equal(saved.scenes[0].actions.find(action=>action.type==='interaction_checkpoint').question,'Original?');
  assert.equal(view.revision,'canonical-new');
  const prepared=runtime.prepareMaicAssessmentSpeech(saved);
  assert(prepared.scenes[0].actions.some(action=>action.type==='speech'&&action.text==='Original?'));
});
test("native question text decodes numeric and named HTML entities without stripping literal text", () => {
  const input = questionSeed();
  input.ir.pages[0].elements[0].content = '<p>说一句：This&#160;is&#xA0;my&nbsp;family! &quot;Hi&quot; &amp; &lt;name&gt; &#128512;</p>';
  const scene = reconcileMaicNativeSource(input, new Map()).scenes[0];
  assert.equal(scene.actions[1].question, '说一句：This is my family! "Hi" & <name> 😀');
  assert.equal(scene.metadata.nativeQuestionText, scene.actions[1].question);
});
test("previously persisted encoded question is repaired without a new PPT save and without overwriting structured edits", () => {
  const input = questionSeed(), scene = input.classroom.scenes[0];
  input.currentSourceRevision = input.sourceRevision;
  scene.content.canvas.elements[0].content = '<p>This&#160;is&#160;my&#160;family!</p>';
  scene.metadata.nativeQuestionText = scene.actions[1].question = 'This&#160;is&#160;my&#160;family!';
  const output = reconcileMaicNativeSource(input, new Map());
  assert.equal(output.scenes[0].actions[1].question, 'This is my family!');
  assert.equal(output.scenes[0].metadata.nativeQuestionText, 'This is my family!');
  assert.deepEqual(reconcileMaicNativeSource({...input, classroom:output}, new Map()), output);
  scene.actions[1].question = 'My intentional &#160; example';
  assert.equal(reconcileMaicNativeSource(input, new Map()).scenes[0].actions[1].question, 'My intentional &#160; example');
});
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
test("verified native deletion removes its bound canonical page while preserving unbound independent Quiz", () => {
  const input = seed(); input.classroom.scenes[0].metadata = { nativePageId: "native-uuid" }; input.project.pages = []; input.mapping.pages = []; input.ir.pages = [];
  assert.deepEqual(reconcileMaicNativeSource(input, new Map()).scenes.map(scene => scene.id), ["quiz"]);
});

test("physical Quiz pages follow native order and deletion while retaining structured questions", () => {
  const input = seed(), quiz = input.classroom.scenes[1];
  input.classroom.scenes[0].metadata = { nativePageId: "native-uuid" };
  quiz.metadata = { nativePageId: "native-quiz" };
  input.project.pages.unshift({ pageId: "native-quiz", actions: [] });
  input.mapping.pages.unshift({ pageId: "native-quiz", planPageId: "quiz" });
  input.ir.pages.unshift({ id: "quiz-placeholder", width: 1000, height: 625, elements: [] });
  const output = reconcileMaicNativeSource(input, new Map());
  assert.deepEqual(output.scenes.map(scene => scene.id), ["quiz", "slide-1"]);
  assert.deepEqual(output.scenes[0].content, quiz.content);
  assert.equal(output.scenes[0].content.canvas, undefined);
  input.classroom = output;
  input.project.pages.shift(); input.mapping.pages.shift(); input.ir.pages.shift();
  assert.deepEqual(reconcileMaicNativeSource(input, new Map()).scenes.map(scene => scene.id), ["slide-1"]);
});

function nativeCopySeed() {
  const input = questionSeed();
  input.classroom.scenes[0].metadata.nativePageId = "native-uuid";
  input.ir.pages[0].elements[0].sourceObjectName = "slide-1_question";
  input.ir.pages[0].elements.push({ ...input.ir.pages[0].elements[0], id: "label", sourceShapeId: "43", sourceObjectName: "slide-1_section_label", content: "<p>课堂互动问答</p>" });
  input.project.pages.push({ pageId: "native-copy", actions: [] });
  input.mapping.pages.push({ pageId: "native-copy" });
  input.ir.pages.push(structuredClone(input.ir.pages[0]));
  return input;
}

test("an unambiguous native checkpoint copy retains independently editable reference content", () => {
  const input = nativeCopySeed();
  const output = reconcileMaicNativeSource(input, new Map()), copy = output.scenes[2];
  assert.equal(copy.id, "native-native-copy");
  assert.equal(copy.actions[1].question, "Native edited?");
  assert.deepEqual(copy.actions[1].referenceAnswer, input.classroom.scenes[0].actions[1].referenceAnswer);
  assert.notEqual(copy.actions[1].id, "checkpoint");
  assert.notEqual(copy.actions[1].checkpointId, "cp");
  assert.equal(copy.metadata.nativePageId, "native-copy");
});

test("native copies with shared anchors never guess which edited reference to inherit", () => {
  const input = nativeCopySeed(), previousCopy = structuredClone(input.classroom.scenes[0]);
  previousCopy.id = "previous-copy";
  previousCopy.metadata = { nativePageId: "previous-native-copy", nativeQuestionElementId: "slide-1_question" };
  previousCopy.actions[1].referenceAnswer.summary = "Different reference";
  input.classroom.scenes.push(previousCopy);
  assert.throws(() => reconcileMaicNativeSource(input, new Map()), /explicit reassociation/);
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
test("simultaneous narration edits fail; bounded native delays synchronize", () => {
  const input = seed(); input.classroom.scenes[0].metadata = { nativeNarrationText: "Hello" };
  input.project.pages[0].actions = [{ id: "n", type: "speech", text: "Native edited" }];
  input.classroom.scenes[0].actions[0].text = "Structured edit";
  assert.throws(() => reconcileMaicNativeSource(input, new Map()), /Narration changed in both/);
  input.classroom.scenes[0].actions[0].text = "Hello";
  input.project.pages[0].actions.push({ id: "control", type: "delay", durationMs: 500 });
  const pending = reconcileMaicNativeSource(input, new Map());
  assert.equal(pending.scenes[0].metadata.nativeTeachingSyncPending, undefined);
  assert.equal(pending.scenes[0].actions[0].text, "Native edited");
  assert.equal(pending.scenes[0].actions[0].pauseAfterMs, 500);
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

test("content editing stays available when native music, pauses or cues cannot be translated", () => {
  const input = questionSeed();
  input.classroom.scenes[0].metadata.nativeNarrationText = "Hello";
  input.project.pages[0].actions = [
    { id: "n", type: "speech", text: "Detailed teaching", visualCues: [{ effect: { type: "spotlight" } }] },
    { id: "music", type: "audio_clip", audioAssetId: "music" },
    { id: "pause", type: "interaction_checkpoint", checkpointKind: "teacher_continue" },
  ];
  const original = structuredClone(input.project);
  const output = reconcileMaicNativeSource(input, new Map());
  assert.equal(output.scenes[0].actions[0].text, "Hello", "Do not adopt a partial native timeline");
  assert.equal(output.scenes[0].actions[1].question, "Native edited?");
  assert.deepEqual(output.scenes[1], input.classroom.scenes[1]);
  assert.equal(output.scenes[0].metadata.nativeNarrationText, "Hello", "Keep the unadopted baseline");
  assert.equal(output.scenes[0].metadata.nativeTeachingSyncPending, true);
  assert.deepEqual(input.project, original, "Never rewrite native teaching to unblock editing");
  input.project.pages[0].actions = [{ id: "n", type: "speech", text: "Supported teaching" }];
  input.classroom = output;
  const resolved = reconcileMaicNativeSource(input, new Map());
  assert.equal(resolved.scenes[0].metadata.nativeTeachingSyncPending, undefined);
  assert.equal(resolved.scenes[0].actions[0].text, "Supported teaching");
});

test("native music and bounded pauses become standard MAIC actions and archived canvas media", () => {
  const input = seed(); input.sourceRevision = input.currentSourceRevision;
  input.classroom.scenes[0].metadata = { nativeNarrationText: "Hello" };
  input.project.pages[0].actions = [
    { id: "n", type: "speech", text: "Hello", pauseAfterMs: 200 },
    { id: "pause", type: "delay", durationMs: 500 },
    { id: "song", type: "audio_clip", audioAssetId: "music" },
  ];
  const resources = new Map([["music", { url: ".deckwise-ppt/classroom-assets/song.wav", mimeType: "audio/wav", durationMs: 1000 }]]);
  const output = reconcileMaicNativeSource(input, resources), scene = output.scenes[0];
  assert.equal(scene.metadata.nativeTeachingSyncPending, undefined);
  assert.equal(scene.actions[0].pauseAfterMs, 700);
  assert.equal(scene.actions[1].type, "play_audio");
  assert.equal(scene.content.canvas.elements.find(e => e.id === scene.actions[1].elementId).src, resources.get("music").url);
  assert.equal(output.mediaManifest[0].assetId, "music");
  assert.deepEqual(reconcileMaicNativeSource({ ...input, classroom: output }, resources), output, "Refresh is idempotent");
});

function timedSeed() {
  const input = seed(); input.sourceRevision = input.currentSourceRevision;
  input.project.source = { sha256: "a".repeat(64) };
  input.classroom.scenes[0].metadata = { nativeNarrationText: "Hello" };
  const element = { id: "target", type: "text", sourceShapeId: "42", left: 20, top: 30, width: 200, height: 80, rotate: 0, content: "<p>Hello</p>", defaultFontName: "Arial", defaultColor: "#000000" };
  input.classroom.scenes[0].content.canvas.elements.push(element);
  input.ir.pages[0].elements.push({ ...element, id: "import-target" });
  input.mapping.pages[0].objects = [{ objectId: "logical-target", importElementId: "import-target" }];
  input.project.pages[0].actions = [{ id: "n", type: "speech", text: "Hello", audioAssetId: "voice", visualCues: [] }];
  return input;
}
const timedResources = () => new Map([["voice", { url: ".deckwise-ppt/classroom-assets/voice.wav", mimeType: "audio/wav", durationMs: 1000 }]]);

test("replacement native audio recalibrates its saved gentle rotation instead of retaining an obsolete binding", () => {
  const input = timedSeed();
  input.classroom.scenes[0].actions[0].audioId = "old-voice";
  input.classroom.scenes[0].metadata.nativeAudioBindings = { n: "old-voice" };
  input.project.pages[0].actions[0].visualCues = [{ id: "motion", atMs: 0, endMs: 200,
    effect: { type: "element_animation", elementId: "logical-target", effect: "gentleRotate" } }];
  const scene = reconcileMaicNativeSource(input, timedResources()).scenes[0];
  assert.equal(scene.metadata.nativeTeachingSyncPending, undefined);
  assert.equal(scene.actions[0].audioId, "voice");
  assert.equal(scene.actions[1].effect, "gentleRotate");
  assert.equal(scene.actions[1].animationType, "attention");
});
test("old repeated-text audio bindings recover without dropping calibrated cues", () => {
  const input = timedSeed(), resources = timedResources();
  resources.set("second", { url: "asset:second", mimeType: "audio/wav", durationMs: 1000 });
  input.project.pages[0].actions.push({ id: "repeat", type: "speech", text: "Hello", audioAssetId: "second",
    visualCues: [{ id: "repeat-motion", atMs: 0, endMs: 200, effect: { type: "element_animation", elementId: "logical-target", effect: "pulse" } }] });
  input.classroom.scenes[0].actions.push({ id: "repeat", type: "speech", text: "Hello", audioId: "voice" });
  const scene = reconcileMaicNativeSource(input, resources).scenes[0];
  assert.equal(scene.metadata.nativeTeachingSyncPending, undefined);
  assert.equal(scene.actions.find(a => a.id === "repeat").audioId, "second");
  assert.equal(scene.actions.find(a => a.type === "element_animation").speechCue.timingTrackId, "second");
});

test("native refresh recovers timing removed by older Host invalidation without hiding editor conflicts", () => {
  const input = timedSeed(), resources = timedResources();
  input.project.pages[0].actions[0].visualCues = [{ id: "motion", atMs: 0, endMs: 200,
    effect: { type: "element_animation", elementId: "logical-target", effect: "pulse" } }];
  input.classroom = reconcileMaicNativeSource(input, resources);
  for (const a of input.classroom.scenes[0].actions) delete a.speechCue;
  input.project.pages[0].actions.push({ id: "pause", type: "delay", durationMs: 200 });
  const recovered = reconcileMaicNativeSource(input, resources);
  assert.equal(recovered.scenes[0].actions.find(a => a.type === "element_animation").speechCue.atMs, 0);
  assert.equal(recovered.scenes[0].actions.find(a => a.type === "speech").pauseAfterMs, 200);
  input.classroom.scenes[0].actions.find(a => a.type === "element_animation").duration = 300;
  assert.throws(() => reconcileMaicNativeSource(input, resources), /both native and structured/);
});

test("speech animations, spotlight and highlight use saved identities and upstream speech cues", () => {
  const input = timedSeed(), speech = input.project.pages[0].actions[0];
  speech.visualCues = [
    { id: "motion", atMs: 0, endMs: 200, effect: { type: "element_animation", elementId: "logical-target", effect: "pulse" } },
    { id: "focus", atMs: 200, endMs: 600, effect: { type: "spotlight", elementId: "logical-target" } },
    { id: "outline", atMs: 600, endMs: 900, effect: { type: "highlight", elementIds: ["logical-target"], style: "outline" } },
  ];
  const before = structuredClone(input), resources = timedResources();
  const output = reconcileMaicNativeSource(input, resources), scene = output.scenes[0];
  assert.equal(scene.metadata.nativeTeachingSyncPending, undefined);
  const motions = scene.actions.filter(a => a.type === "element_animation");
  assert.equal(motions.length, 5);
  assert.equal(motions[0].elementId, "target");
  assert.deepEqual(motions.map(a => a.speechCue.atMs), [0, 200, 600, 600, 900]);
  assert(motions.every(a => a.speechCue.speechActionId === "speech"));
  assert.equal(scene.content.canvas.elements.length, 3);
  assert.deepEqual(input, before);
  assert.deepEqual(reconcileMaicNativeSource({ ...input, classroom: output }, resources), output, "No duplicate overlays, audio or actions on refresh");
  speech.visualCues[0].effect.elementId = "deleted";
  const unresolved = reconcileMaicNativeSource(input, resources);
  assert.equal(unresolved.scenes[0].metadata.nativeTeachingSyncPending, true);
  assert.match(unresolved.scenes[0].metadata.nativeTeachingSyncReason, /missing or ambiguous/);
  assert.deepEqual(unresolved.scenes[0].actions, input.classroom.scenes[0].actions, "No partial timeline on unresolved target");
});

test("native animation steps retain order and exact saved target; stale source fails atomically", () => {
  const input = timedSeed();
  input.project.pages[0].actions.unshift({ id: "entry", type: "native_animation", version: 1, sourceSha256: "a".repeat(64), stepIndex: 0 });
  input.ir.pages[0].pptxAnimation = { steps: [{ id: "native-entry", trigger: "click", items: [{ id: "native-item", animationType: "in", target: { shapeId: "42" }, startAtMs: 100, durationMs: 300, effect: "fade" }] }] };
  const output = reconcileMaicNativeSource(input, timedResources());
  assert.equal(output.scenes[0].metadata.nativeTeachingSyncPending, undefined);
  assert.deepEqual(output.scenes[0].actions.map(a => a.type), ["element_animation", "speech"]);
  assert.equal(output.scenes[0].actions[0].effect, "fadeIn");
  assert.equal(output.scenes[0].actions[0].elementId, "target");
  assert.equal(output.scenes[0].actions[0].startAtMs, 100);
  input.project.pages[0].actions[0].sourceSha256 = "b".repeat(64);
  const stale = reconcileMaicNativeSource(input, timedResources());
  assert.equal(stale.scenes[0].metadata.nativeTeachingSyncPending, true);
  assert.match(stale.scenes[0].metadata.nativeTeachingSyncReason, /no longer matches/);
});

test("unrepresentable waits, missing media and uncalibrated timing keep an actionable reason", () => {
  for (const node of [
    { id: "wait", type: "interaction_checkpoint", checkpointKind: "teacher_continue", checkpointId: "wait" },
    { id: "video", type: "video_clip", videoAssetId: "missing" },
    { id: "delay", type: "delay", durationMs: 100 },
  ]) {
    const input = timedSeed(); input.project.pages[0].actions.unshift(node);
    const output = reconcileMaicNativeSource(input, timedResources());
    assert.equal(output.scenes[0].metadata.nativeTeachingSyncPending, true);
    assert.equal(typeof output.scenes[0].metadata.nativeTeachingSyncReason, "string");
  }
  const input = timedSeed(); input.project.pages[0].actions[0].visualCues = [{ id: "stale", atMs: 0, endMs: 100,
    trigger: { kind: "text", text: "Hello", start: 0, end: 5, audioAssetId: "old-voice" }, effect: { type: "element_animation", elementId: "logical-target", effect: "pulse" } }];
  assert.match(reconcileMaicNativeSource(input, timedResources()).scenes[0].metadata.nativeTeachingSyncReason, /recalibration/);
});

test("converted media, pauses and animations survive the MAIC archive without native-only fields", async () => {
  const input = timedSeed(); input.classroom.scenes.pop();
  input.project.pages[0].actions[0].visualCues = [{ id: "motion", atMs: 0, endMs: 200, effect: { type: "element_animation", elementId: "logical-target", effect: "pulse" } }];
  input.project.pages[0].actions.push({ id: "pause", type: "delay", durationMs: 500 }, { id: "song", type: "audio_clip", audioAssetId: "voice" });
  const output = reconcileMaicNativeSource(input, timedResources());
  const wav = Buffer.alloc(46); wav.write("RIFF"); wav.writeUInt32LE(38, 4); wav.write("WAVEfmt ", 8); wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22); wav.writeUInt32LE(8000, 24); wav.writeUInt32LE(16000, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write("data", 36); wav.writeUInt32LE(2, 40);
  const { default: JSZip } = await import("jszip");
  const zip = await JSZip.loadAsync(await runtime.exportMaicClassroom(output, async () => wav));
  const { classroom } = JSON.parse(await zip.file("meta.json").async("string"));
  runtime.parseMaicClassroom(classroom);
  assert.equal(classroom.scenes[0].actions[0].pauseAfterMs, 500);
  assert.equal(classroom.scenes[0].actions[1].speechCue.speechActionId, "speech");
  assert.equal(classroom.scenes[0].actions[2].type, "play_audio");
  assert(!JSON.stringify(classroom).includes("nativeTeaching"));
  assert(!JSON.stringify(classroom.scenes[0].actions).includes("audioAssetId"));
  assert(zip.file(classroom.mediaManifest[0].src));
  assert(zip.file(classroom.audioManifest[0].url));
});


test("structured timeline edits survive refresh and simultaneous native edits require resolution", () => {
  const input = timedSeed(); input.project.pages[0].actions.push({ id: "pause", type: "delay", durationMs: 500 });
  const resources = timedResources(), output = reconcileMaicNativeSource(input, resources);
  output.scenes[0].actions[0].text = "Structured replacement";
  delete output.scenes[0].actions[0].audioId; delete output.scenes[0].actions[0].audioUrl;
  const preserved = reconcileMaicNativeSource({ ...input, classroom: output }, resources);
  assert.equal(preserved.scenes[0].actions[0].text, "Structured replacement");
  input.project.pages[0].actions[0].text = "Native replacement";
  assert.throws(() => reconcileMaicNativeSource({ ...input, classroom: output }, resources), /both native and structured/);
});

test("Host JSON key normalization cannot create a false concurrent timeline edit", () => {
  const input = timedSeed(), resources = timedResources();
  input.project.pages[0].actions.push({ id: "pause", type: "delay", durationMs: 500 });
  const first = reconcileMaicNativeSource(input, resources);
  const persisted = JSON.parse(runtime.canonicalJson(first));
  input.project.pages[0].actions[1].durationMs = 700;
  const updated = reconcileMaicNativeSource({ ...input, classroom: persisted }, resources);
  assert.equal(updated.scenes[0].actions[0].pauseAfterMs, 700);
});

test("unchanged persisted native reconciliation does not create another canonical revision", async () => {
  const input = seed(); input.sourceRevision = input.currentSourceRevision;
  input.classroom.scenes[0].metadata = { nativeNarrationText: "Hello" };
  input.project.pages[0].actions = [{ id: "n", type: "speech", text: "Hello" }, { id: "pause", type: "delay", durationMs: 500 }];
  input.classroom = JSON.parse(runtime.canonicalJson(reconcileMaicNativeSource(input, new Map())));
  const methods = [];
  const view = await refreshNativeMaicClassroom({ host: { async call(method) { methods.push(method); assert.equal(method, "courseware.classroom.source"); return input; } },
    sessionId: "session", projectId: "project", jobId: "job", workspace: "/unused" });
  assert.equal(view.revision, input.revision);
  assert.deepEqual(methods, ["courseware.classroom.source"]);
});
