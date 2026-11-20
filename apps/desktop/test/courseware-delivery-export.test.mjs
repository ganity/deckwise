import * as coursewareRuntime from "../electron/main/courseware-runtime.ts";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import test from "node:test";
import ts from "typescript";
import JSZip from "jszip";
import * as runtime from "../../../packages/courseware-runtime/dist/node.mjs";
const require = createRequire(import.meta.url);
async function load(file, dependencies) {
  const exports = {};
  new Function("require", "exports", ts.transpileModule(await readFile(new URL(file, import.meta.url), "utf8"), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true },
  }).outputText)(id => dependencies[id] ?? (id === "./courseware-runtime" ? coursewareRuntime : require(id)), exports); return exports;
}
const timeline = await load("../electron/main/courseware-classroom-timeline.ts", { "@pi-desktop/courseware-runtime/node": runtime });
const native = await load("../electron/main/courseware-classroom-native.ts", { "@pi-desktop/courseware-runtime/node": runtime,
  "./courseware-classroom-timeline": timeline, "./fs-panel": {} });
const deliveryAssessment = await load("../electron/main/courseware-delivery-assessment.ts", { "@pi-desktop/courseware-runtime/node": runtime });
const digest = data => createHash("sha256").update(data).digest("hex");
test("native delivery exports grouped spotlight targets, saved audio and objective answers", async t => {
  const root = await mkdtemp(join(tmpdir(), "delivery-export-")); t.after(() => rm(root, { recursive: true, force: true }));
  const sourcePath = join(root, "source.pptx"); await writeFile(sourcePath, "saved-native"); await writeFile(join(root, "manifest.json"), "worker");
  const previous = process.env.DECKWISE_PPTX_WORKER; process.env.DECKWISE_PPTX_WORKER = join(root, "pptx-worker.mjs");
  t.after(() => { if (previous === undefined) delete process.env.DECKWISE_PPTX_WORKER; else process.env.DECKWISE_PPTX_WORKER = previous; });
  const wav = Buffer.alloc(64); wav.write("RIFF"); wav.write("WAVE", 8);
  const path = `assets/${digest(wav)}.wav`; await (await import("node:fs/promises")).mkdir(join(root, "assets")); await writeFile(join(root, path), wav);
  const speech = { id: "speech", type: "speech", text: "Choose yes", audioAssetId: "audio", visualCues: [
    { id: "focus", atMs: 100, endMs: 400, effect: { type: "spotlight", elementId: "card-group" } },
    { id: "highlight", atMs: 0, endMs: 1000, effect: { type: "highlight", elementIds: ["card-group"], color: "#123456", style: "fill", opacity: 0.2 } },
    { id: "entrance", atMs: 0, endMs: 200, trigger: { kind: "start" }, effect: { type: "element_animation", elementId: "picture", effect: "fadeIn" } },
    { id: "emphasis", atMs: 0, endMs: 300, effect: { type: "element_animation", elementId: "caption", effect: "pulse" } },
    { id: "exit", atMs: 600, endMs: 800, effect: { type: "element_animation", elementId: "picture", effect: "fadeOut" } },
  ] };
  const question = { id: "question", type: "interaction_checkpoint", checkpointKind: "chapter_summary", checkpointId: "check", chapterId: "page", chapterTitle: "Choose", question: "Choose yes",
    response: { kind: "single", options: ["Yes", "No"], answerIndices: [0] }, referenceAnswer: { summary: "Yes", keyPoints: ["Evidence"] }, context: { chapterSummary: "Question", sourceSceneIds: ["page"] } };
  const pages = [{ pageId: "page", actions: [speech, question] }], source = { revision: "revision", sha256: digest(Buffer.from("saved-native")) };
  const assessment = { type: "quiz", interactionMode: "classroom_instant_feedback", questions: [{ id: "check", type: "single", question: "Choose yes",
    options: [{ value: "A", label: "Yes" }, { value: "B", label: "No" }], answer: ["A"] }] };
  const educationContext = { grade: "3", subject: "science", fullEnglishTeaching: true };
  const project = { projectId: "native-doc", title: "Saved title", source, teachingRevision: "revision", pages, educationContext };
  const snapshot = { projectId: project.projectId, snapshotId: "snapshot", source, teachingRevision: "revision", mappingRevision: "mapping", assetIds: ["audio"] };
  const ir = { kind: "slide", sourceType: "pptx", title: "Parser title", pages: [{ id: "import-page", width: 1000, height: 625, elements: [] }] };
  const mapping = { pages: [{ pageId: "page", importPageId: "import-page", objects: [], groups: [{ objectId: "card-group", sourceShapeId: "16" }] }] };
  const { canvas } = runtime.mapMaicSlideIrToScenes(project.projectId, ir)[0].content;
  const anchor = { id: "native_group_card-group", type: "shape", left: 120, top: 80, width: 300, height: 200, rotate: 0,
    viewBox: [1, 1], path: "M0 0H1V1H0Z", fixedRatio: false, fill: "transparent", opacity: 0 };
  const convertedPages = [{ ...pages[0], slide: { ...canvas, elements: [anchor,
    { ...anchor, id: "picture", fill: "#000", opacity: 1 },
    { ...anchor, id: "caption", fill: "#111", opacity: 1 }] },
    objects: [{ objectId: "card-group", importElementId: anchor.id }] }];
  const assets = [{ id: "audio", path, sha256: digest(wav), mimeType: "audio/wav" }];
  let forwardedAssessment;
  const { exportNativeDelivery } = await load("../electron/main/courseware-delivery-export.ts", {
    "@pi-desktop/shared": { inspectCoursewareTeaching: () => ({ issues: [] }), inspectCoursewareEnrichment: () => ({ ready: true, issues: [] }) },
    "@pi-desktop/courseware-runtime/node": { ...runtime, adaptCanonicalSnapshot: () => ({}), buildFixedCourseware: async (_, options) => {
      forwardedAssessment = options.nativeAssessments.page;
      return options.onConverted({ ir, input: { teaching: { pages }, mapping }, pages: convertedPages, directory: root, assets });
    } },
    "./courseware-native-snapshot": { captureNativeTeachingSnapshot: async () => ({ value: snapshot }) },
    "./courseware-native-package": { readNativeTeachingPackage: async () => ({ documentId: project.projectId, pages,
      assessments: { page: assessment }, media: [{ id: "audio", durationMs: 1000 }] }) },
    "./courseware-classroom-native": native, "./courseware-delivery-assessment": deliveryAssessment,
  });
  const result = await exportNativeDelivery({ workspace: root, sessionId: "session", outputDirectory: root, assertOwner() {},
    host: { call: async () => ({ project, mapping, sourcePath, assets: [] }) },
    teaching: { native: async () => ({ value: { viewId: "view", project } }) }, editor: { verifyTeachingSource: async () => {} } });
  const zip = await JSZip.loadAsync(result.bytes), meta = JSON.parse(await zip.file("meta.json").async("string"));
  assert.equal(meta.classroom.stage.name, "Saved title"); assert.equal(meta.classroom.scenes.length, 2);
  assert.equal(meta.classroom.stage.language, "en");
  assert.deepEqual(meta.classroom.metadata.educationContext, educationContext);
  assert.equal(meta.classroom.metadata.playbackDurationSeconds, 1);
  const { actions, content } = meta.classroom.scenes[0];
  assert.deepEqual(content.canvas.elements, convertedPages[0].slide.elements);
  const [spotlight, highlight, entrance, emphasis, narration, exit] = actions;
  assert.deepEqual(actions.map(action => action.type), ["spotlight", "highlight", "element_animation", "element_animation", "speech", "element_animation"]);
  assert.deepEqual(spotlight.elementIds, [anchor.id]);
  assert.deepEqual(highlight.elementIds, [anchor.id]);
  assert.equal(highlight.color, "#123456");
  assert.equal(highlight.style, "fill");
  assert.equal(highlight.opacity, 0.2);
  assert.deepEqual([entrance.effect, entrance.elementId, entrance.pptistTrigger], ["fadeIn", "picture", "auto"]);
  assert.deepEqual([emphasis.effect, emphasis.elementId, emphasis.pptistTrigger], ["pulse", "caption", "meantime"]);
  assert.equal(entrance.speechCue, undefined);
  assert.equal(emphasis.speechCue, undefined);
  assert.deepEqual(entrance.pptxTimeline, emphasis.pptxTimeline);
  assert.deepEqual(narration.pptxTimeline, { ...entrance.pptxTimeline, phase: "with" });
  assert.equal(exit.effect, "fadeOut");
  assert.equal(exit.speechCue.atMs, 600);
  assert.equal(exit.speechCue.speechActionId, narration.id);
  assert.equal(meta.classroom.scenes[0].actions.some(a => a.type === "interaction_checkpoint"), false);
  assert.deepEqual(meta.classroom.scenes[1].content.questions[0].answer, ["A"]);
  assert.equal(meta.classroom.scenes[1].content.interactionMode, "classroom_instant_feedback");
  assert.deepEqual(meta.classroom.scenes[1].content.questions[0].options[0].label, "Yes");
  assert.deepEqual(forwardedAssessment, assessment);
  assert.deepEqual(Buffer.from(await zip.file(meta.classroom.audioManifest[0].zipPath).async("uint8array")), wav);
  assert.equal(result.sourceHash, source.sha256);
});

test("native delivery requires narration/audio unless the saved policy explicitly marks a page silent", async () => {
  const shared = await import("../../../packages/shared/dist/index.js");
  const { assertNativeCoursewareReady, coursewareDeliveryFingerprint } = await load("../electron/main/courseware-delivery-export.ts", {
    "@pi-desktop/shared": shared, "@pi-desktop/courseware-runtime/node": runtime,
    "./courseware-native-snapshot": {}, "./courseware-native-package": {},
    "./courseware-delivery-assessment": {}, "./courseware-classroom-native": {}, "./courseware-classroom-timeline": {},
  });
  const project = { schemaVersion: "deckwise-courseware/1", projectId: "doc", taskType: "plain", title: "Lesson",
    source: { revision: "source", sha256: digest(Buffer.from("source")) }, teachingRevision: "teaching",
    pages: [{ pageId: "page", locked: false, reviewState: "ready", actions: [] }] };
  const view = { project };
  assert.throws(() => assertNativeCoursewareReady(view), /NARRATION_MISSING/);
  const spoken = { ...project.pages[0], pageId: "spoken", actions: [{ id: "speech", type: "speech", text: "Read this", audioAssetId: "audio" }] };
  const silent = { project: { ...project, pages: [project.pages[0], spoken] }, enrichment: {
    schemaVersion: "deckwise-teaching-enrichment/1", originalPages: [{ pageId: "page", pageNumber: 1 }, { pageId: "spoken", pageNumber: 2 }],
    script: { sha256: "a".repeat(64), policy: "generate-missing", segments: [{ id: "script", text: "Read the lesson", sourceLine: 1, pageId: "spoken", actionId: "speech" }], silentPageIds: ["page"] } } };
  assert.doesNotThrow(() => assertNativeCoursewareReady(silent));
  const missingAudio = { ...view, project: { ...project, pages: [{ ...project.pages[0], actions: [{ id: "speech", type: "speech", text: "Explain" }] }] } };
  assert.throws(() => assertNativeCoursewareReady(missingAudio), /AUDIO_MISSING/);
  assert.notEqual(coursewareDeliveryFingerprint("a", "worker-1"), coursewareDeliveryFingerprint("a", "worker-2"));
});
