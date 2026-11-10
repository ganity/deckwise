import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import test from "node:test";
import ts from "typescript";
import { parseMaicClassroom } from "../../../packages/courseware-runtime/dist/node.mjs";
import * as authoring from "@pi-desktop/courseware-runtime/authoring";

const requireCourseware = createRequire(new URL("../../../packages/courseware-runtime/package.json", import.meta.url));
const sharp = requireCourseware("sharp");
const background = await sharp({ create: { width: 1280, height: 800, channels: 4, background: "#ffffff" } }).png().toBuffer();
const source = await readFile(new URL("../electron/main/courseware-scene-deck.ts", import.meta.url), "utf8");
const { outputText } = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } });
let conflict = false;
let nativeText = false;
let missingForeground = false;
let duplicateForeground = false;
const calls = [];
const exports = {};
new Function("require", "exports", outputText)((id) => {
  if (id === "node:crypto") return { createHash };
  if (id === "./courseware-scene-generator") return { createCoursewareSceneGenerator(config) {
    return async (request) => {
      calls.push({ config, request });
      return { scene: { version: 1, slideId: request.pageId, sourceHash: request.sourceHash, canvas: request.canvas,
        visualMasterAssetId: "master", cleanPlateAssetId: "clean", elements: [
          ...(nativeText ? [{ id: "title", type: "native_text", bboxPx: [80, 70, 800, 100], zIndex: 3,
            content: request.pageText, style: { fontFace: "Arial", fontSizePt: 32, color: "#000000", align: "left", lineHeight: 1.2 } }] : []),
          ...(missingForeground ? [] : [{ id: "teacher", type: "image_layer", assetId: "teacher", semanticRole: "Hello lettering", layerRoute: "A1", bboxPx: [0, 0, 100, 100], rotate: 90, zIndex: 1, crop: [[0, 0], [50, 50]] }]),
          ...(duplicateForeground ? [{ id: "duplicate", type: "image_layer", assetId: "teacher", semanticRole: "Hello lettering", layerRoute: "A1", bboxPx: [0, 0, 100, 100], zIndex: 2 }] : []),
        ] },
        assets: { master: background, clean: conflict && calls.length === 2 ? Buffer.from("different") : background, teacher: background } };
    };
  } };
  throw new Error(`Unexpected dependency: ${id}`);
}, exports);
const { buildSceneCourseDeck } = exports;
const pages = [1, 2].map((number) => ({ pageId: `scene-00${number}`, sourceHash: `sha256:${"a".repeat(64)}`,
  title: `Page ${number}`, visibleText: ["Hello"], visualIntent: "孩子挥手", narration: `讲解 ${number}` }));
const visuals = pages.map(({ pageId }) => ({ pageId, visualMasterAssetId: "master", cleanPlateAssetId: "clean", images: [{ assetIds: ["teacher"], bytes: background }] }));
const input = { sessionId: "s", modelKey: "provider/model", pages, visuals, canvas: { width: 1280, height: 800 } };

test("planned scene pages compile as one editable PPTX and keep page narration separate", async () => {
  calls.length = 0;
  const deck = await buildSceneCourseDeck(input, async () => ({ text: "" }), authoring);
  assert.equal(deck.mapping.pages.length, 2);
  assert.deepEqual(deck.teaching, pages.map(({ pageId, title, narration, teaching, quiz }) => ({ pageId, title, narration, teaching, quiz })));
  assert.equal(calls.length, 2);
  assert.match(calls[0].request.instruction, /teacher narration is separate/i);
  assert.equal(calls[0].request.pageText, "Hello");
  assert.match(calls[0].request.instruction, /visual master as the design authority/);
  assert.match(calls[0].request.instruction, /only image_layer/);
  assert.match(calls[0].request.instruction, /Do not create native_text/);
  assert(!calls[0].request.pageText.includes("讲解"));
  assert(deck.pptx.length > 1000);
});

test("conflicting asset IDs and missing page visuals fail before compiling", async () => {
  calls.length = 0;
  await assert.rejects(buildSceneCourseDeck({ ...input, visuals: visuals.slice(0, 1) }, async () => ({ text: "" }), authoring), /Invalid scene course/);
  conflict = true;
  try { await assert.rejects(buildSceneCourseDeck(input, async () => ({ text: "" }), authoring), /conflicting bytes/); }
  finally { conflict = false; }
});

test("compilation rejects added native text rather than duplicating image lettering", async () => {
  nativeText = true;
  try { await assert.rejects(buildSceneCourseDeck(input, async () => ({ text: "" }), authoring), /decomposed image layers only/); }
  finally { nativeText = false; }
});

test("a scene cannot silently drop a reviewed foreground or lettering image", async () => {
  const withForegrounds = visuals.map(visual => ({ ...visual, images: [
    { assetIds: ["master"], bytes: background }, { assetIds: ["clean"], bytes: background },
    { assetIds: ["apple"], bytes: background },
  ] }));
  await assert.rejects(buildSceneCourseDeck({ ...input, visuals: withForegrounds }, async () => ({ text: "" }), authoring),
    /retain every reviewed foreground as a separate object/);
});

test("decomposition bounds and stacking replace guessed image placement before editable compilation", async () => {
  let captured;
  const selectedVisuals = visuals.map(visual => ({ ...visual, images: ["master", "clean", "teacher"].map(id => ({ assetIds: [id], bytes: background })),
    foregroundPlacements: [{ assetId: "teacher", bboxPx: [128, 184, 768, 504], zIndex: 2 }] }));
  await buildSceneCourseDeck({ ...input, visuals: selectedVisuals }, async () => ({ text: "" }), {
    editablePptxSceneSchema: authoring.editablePptxSceneSchema,
    async compileScenesToPptx(scenes) { captured = scenes; return { pptx: Buffer.from("verified"), mapping: { pages: scenes } }; },
  });
  for (const scene of captured) {
    const layer = scene.elements.find(element => element.id === "teacher");
    assert.deepEqual(layer.bboxPx, [128, 184, 768, 504]);
    assert.equal(layer.zIndex, 2);
    assert.equal(layer.rotate, 0);
    assert.equal(layer.crop, undefined);
  }
});


test("a flattened background or duplicate foreground is refused", async () => {
  for (const mode of ["missing", "duplicate"]) {
    missingForeground = mode === "missing"; duplicateForeground = mode === "duplicate";
    try { await assert.rejects(buildSceneCourseDeck(input, async () => ({ text: "" }), authoring), /retain every reviewed foreground/); }
    finally { missingForeground = false; duplicateForeground = false; }
  }
});

test("scene compilation accepts decomposed lettering images without native text", async () => {
  calls.length = 0;
  const selectedVisuals = visuals.map(visual => ({ ...visual, images: ["master", "clean", "teacher"].map(id => ({ assetIds: [id], bytes: background })),
    foregroundPlacements: [{ assetId: "teacher", bboxPx: [128, 184, 768, 504], zIndex: 2 }] }));
  const deck = await buildSceneCourseDeck({ ...input, visuals: selectedVisuals }, async () => ({ text: "" }), authoring);
  assert.equal(deck.mapping.pages.length, 2);
  const zip = await requireCourseware("jszip").loadAsync(deck.pptx);
  const xml = await zip.file("ppt/slides/slide1.xml").async("string");
  assert.equal((xml.match(/<p:pic>/gu) ?? []).length, 1, "one independent image layer over the base background");
  assert(!xml.includes("<a:t>"), "lettering stays in the layer pixels");
  assert.equal(calls.length, 0, "complete native placements do not require model reconstruction");
});

test("mixed generation keeps Quiz independent and interaction question in an editable PPTist frame", async () => {
  const question = { text: "请介绍你的名字", response: { kind: "discussion", options: [], answerIndices: [] } };
  const interaction = { ...pages[0], visibleText: [], narration: "", teaching: { pageType: "interactive", phase: "practice", objective: "自我介绍", durationSeconds: 30, requiredObjects: [], question } };
  const quiz = { ...pages[1], visibleText: [], narration: "", quiz: { type: "quiz", questions: [{ id: "q1", type: "single", question: "选出问候语", options: [{ value: "A", label: "Hello" }, { value: "B", label: "Bye" }], answer: ["A"] }], interactionMode: "classroom_instant_feedback" } };
  const deck = await buildSceneCourseDeck({ ...input, pages: [interaction, quiz], visuals: [] }, async () => { throw Error("Assessment pages need no image/layout LLM"); }, authoring);
  parseMaicClassroom(deck.canonicalClassroom);
  assert.equal(deck.canonicalClassroom.scenes[0].content.canvas.elements[0].type, "shape");
  assert.equal(deck.mapping.pages.length, 2);
  assert.deepEqual(deck.canonicalClassroom.scenes.map(scene => scene.type), ["slide", "quiz"]);
  const slide = deck.canonicalClassroom.scenes[0], checkpoint = slide.actions.find(action => action.type === "interaction_checkpoint");
  assert.equal(checkpoint.question, question.text);
  assert.deepEqual(slide.actions.map(a => a.type), ["interaction_checkpoint"]);
  assert.deepEqual(deck.canonicalClassroom.scenes[1].actions, []);
  assert(slide.content.canvas.elements.find(element => element.id === `${slide.id}_question`).content.includes(checkpoint.question));
  assert(!Object.hasOwn(checkpoint, "response"));
  assert.deepEqual(deck.canonicalClassroom.scenes[1].content.questions[0].answer, ["A"]);
  assert(!deck.canonicalClassroom.scenes[1].actions.some(action => action.type === "interaction_checkpoint"));
});

test("an all-Quiz course has native navigation placeholders and pure MAIC Quiz content", async () => {
  const quiz = { ...pages[0], visibleText: [], narration: "", quiz: { type: "quiz", questions: [{ id: "q1", type: "short_answer", question: "你的名字", referenceAnswer: "完整自我介绍", keyPoints: ["名字"] }] } };
  const deck = await buildSceneCourseDeck({ ...input, pages: [quiz], visuals: [] }, async () => { throw Error("Quiz needs no image/layout LLM"); }, authoring);
  parseMaicClassroom(deck.canonicalClassroom);
  assert(deck.pptx.length > 1000);
  assert.equal(deck.mapping.pages.length, 1);
  assert.equal(deck.teaching.length, 1);
  assert(!Object.hasOwn(deck.canonicalClassroom.scenes[0].content, "canvas"));
  assert.equal(deck.canonicalClassroom.scenes[0].type, "quiz");
});

test("Freeze activity artwork and lecture remain a body page followed by a separate checkpoint", async () => {
  const body = { ...pages[0], title: "Freeze game rules", visibleText: ["Freeze!", "I love my mum."], narration: "Stand on a mat and freeze.",
    teaching: { pageType: "slide", phase: "practice", objective: "Family sentences", durationSeconds: 60, requiredObjects: ["Children on mats"] } };
  const checkpoint = { ...pages[1], title: "课堂互动", visibleText: [], narration: "",
    teaching: { ...body.teaching, pageType: "interactive", requiredObjects: [], question: { text: "Say a complete family sentence", response: { kind: "practice", options: [], answerIndices: [] } } } };
  const visual = { ...visuals[0], images: ["master", "clean", "teacher"].map(id => ({ assetIds: [id], bytes: background })),
    foregroundPlacements: [{ assetId: "teacher", bboxPx: [128, 184, 768, 504], zIndex: 2 }] };
  const deck = await buildSceneCourseDeck({ ...input, pages: [body, checkpoint], visuals: [visual] }, async () => { throw Error("No model needed"); }, authoring);
  parseMaicClassroom(deck.canonicalClassroom);
  assert.equal(deck.mapping.pages.length, 2);
  const [ordinary, assessment] = deck.canonicalClassroom.scenes;
  assert(ordinary.content.canvas.elements.some(element => element.id === "teacher" && element.type === "image"));
  assert.deepEqual(ordinary.actions.map(a => a.type), ["speech"]);
  assert.equal(ordinary.actions[0].text, body.narration);
  assert.deepEqual(assessment.actions.map(a => a.type), ["interaction_checkpoint"]);
  assert(assessment.content.canvas.elements.some(element => element.content?.includes("课堂互动")));
  const zip = await requireCourseware("jszip").loadAsync(deck.pptx);
  assert(zip.file("ppt/slides/slide1.xml") && zip.file("ppt/slides/slide2.xml"));
  await assert.rejects(buildSceneCourseDeck({ ...input, pages: [{ ...body, teaching: checkpoint.teaching }], visuals: [] }, async () => {}, authoring), /refusing to discard body content/);
});
