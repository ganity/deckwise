import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";
import * as runtime from "../../../packages/courseware-runtime/dist/node.mjs";
const exports = {};
new Function("require", "exports", ts.transpileModule(await readFile(new URL("../electron/main/courseware-delivery-assessment.ts", import.meta.url), "utf8"), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText)(() => runtime, exports);
const { projectDeliveryAssessments } = exports;
function fixture(kind = "single") {
  const canvas = runtime.mapMaicSlideIrToScenes("stage", { kind: "slide", sourceType: "pptx", pages: [{ id: "page", width: 1000, height: 625, elements: [] }] })[0].content;
  const checkpoint = { id: "question", type: "interaction_checkpoint", checkpointId: "checkpoint", checkpointKind: "chapter_summary", chapterId: "page", chapterTitle: "Question", question: "Choose", response: { kind, options: ["Yes", "No"], answerIndices: [0] }, referenceAnswer: { summary: "Yes", keyPoints: ["Correct"] }, context: { chapterSummary: "Summary", sourceSceneIds: ["page"] } };
  return { checkpoint, document: { id: "doc", stage: { id: "stage", name: "Lesson", createdAt: 0, updatedAt: 0 }, createdAt: "2026-01-01", scenes: [{ id: "page", stageId: "stage", title: "Question", order: 0, type: "slide", content: canvas,
    actions: [{ ...Object.fromEntries(Object.entries(checkpoint).filter(([key]) => key !== "response")) }, { id: "speech", type: "speech", text: "Choose", audioId: "a", audioUrl: "assets/audio.wav" }] }] } };
}
test("objective native question preserves the PPTist page, narration, options and answer in a standard Quiz", () => {
  const { checkpoint, document } = fixture();
  const result = projectDeliveryAssessments(document, [{ pageId: "page", actions: [checkpoint] }]);
  assert.equal(result.scenes.length, 2); assert.deepEqual(result.scenes[0].content, document.scenes[0].content);
  assert.deepEqual(result.scenes[0].actions.map(a => a.id), ["speech"]);
  assert.equal(result.scenes[1].content.questions[0].options[0].label, "Yes");
  assert.deepEqual(result.scenes[1].content.questions[0].answer, ["A"]);
});
test("judge answers use MAIC T/F keys and discussions retain their checkpoint", () => {
  const judge = fixture("judge");
  assert.deepEqual(projectDeliveryAssessments(judge.document, [{ pageId: "page", actions: [judge.checkpoint] }]).scenes[1].content.questions[0].answer, ["T"]);
  const discussion = fixture("discussion");
  assert.equal(projectDeliveryAssessments(discussion.document, [{ pageId: "page", actions: [discussion.checkpoint] }]).scenes.length, 1);
});

test("stored native Quiz keeps instant feedback, question images and the original page", () => {
  const { checkpoint, document } = fixture(), image = "data:image/png;base64,aGVsbG8=";
  const quiz = { type: "quiz", interactionMode: "classroom_instant_feedback", playbackConfig: { introSpeechMode: "page_enter_only",
    attemptPolicy: "until_correct", successSpeechText: "Correct", failureSpeechText: "Try again", cueUserOnEnter: true, cueUserOnRetry: true },
    questions: [{ id: "q", type: "single", question: "Choose", image: { src: image }, options: [{ value: "A", label: "Yes", image: { src: image } }, { value: "B", label: "No" }], answer: ["A"] }] };
  const result = projectDeliveryAssessments(document, [{ pageId: "page", actions: [checkpoint] }], { page: quiz }, undefined,
    new Map([[image, { url: "assets/image.png", mimeType: "image/png" }]]));
  assert.equal(result.scenes.length, 2);
  assert.deepEqual(result.scenes[0].content, document.scenes[0].content);
  assert.equal(result.scenes[1].content.interactionMode, "classroom_instant_feedback");
  assert.deepEqual(result.scenes[1].content.playbackConfig, quiz.playbackConfig);
  assert.equal(result.scenes[1].content.questions[0].image.src, "assets/image.png");
  assert.equal(result.scenes[1].content.questions[0].options[0].image.src, "assets/image.png");
  assert.equal(result.mediaManifest.some(asset => asset.src === "assets/image.png"), true);
});

test("short-answer teacher checkpoints stay teacher-led unless the saved lesson plan marks a quiz", () => {
  const { checkpoint, document } = fixture("short_answer");
  const result = projectDeliveryAssessments(document, [{ pageId: "page", actions: [checkpoint] }]);
  assert.equal(result.scenes.length, 1);
  assert.equal(result.scenes[0].actions[0].type, "interaction_checkpoint");
});
