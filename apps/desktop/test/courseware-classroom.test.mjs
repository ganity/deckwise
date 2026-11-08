import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, symlink } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import ts from "typescript";
import JSZip from "jszip";
import * as runtime from "../../../packages/courseware-runtime/dist/node.mjs";

const require = createRequire(import.meta.url);
async function load(path, dependencies = {}) {
  const exports = {};
  new Function("require", "exports", ts.transpileModule(await readFile(new URL(path, import.meta.url), "utf8"), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText)(id => dependencies[id] ?? require(id), exports);
  return exports;
}
const fsPanel = await load("../electron/main/fs-panel.ts");
const assetReader = await load("../electron/main/courseware-classroom-assets.ts", { "./fs-panel": fsPanel });
const { CoursewareClassroomCoordinator } = await load("../electron/main/courseware-classroom.ts", {
  "@pi-desktop/courseware-runtime/node": runtime, "./fs-panel": fsPanel, "./courseware-classroom-assets": assetReader,
});
const { buildMaicCourseware } = await load("../electron/main/courseware-classroom-build.ts", {
  "@pi-desktop/courseware-runtime/node": runtime, "./courseware-classroom-assets": assetReader, jszip: { default: JSZip },
});
const { openCoursewareBuildFiles, openCoursewareBuildUpload } = await load("../electron/main/courseware-build-files.ts");
const png = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=";
function classroom() {
  return { id: "classroom", stage: { id: "stage", name: "Test/class", createdAt: 1, updatedAt: 1 }, createdAt: new Date(1).toISOString(), scenes: [
    { id: "quiz", stageId: "stage", order: 0, title: "Quiz", type: "quiz", content: { type: "quiz", questions: [
      { id: "q", type: "single", question: "Choose", options: [{ value: "A", label: "Yes" }, { value: "B", label: "No" }], answer: ["A"] },
    ] } },
    { id: "slide", stageId: "stage", order: 1, title: "Interaction", type: "slide", content: { type: "slide", canvas: { id: "canvas", elements: [], viewportSize: 1000, viewportRatio: 0.5625, theme: { themeColors: ["#000000"], fontColor: "#000000", fontName: "Arial", backgroundColor: "#ffffff" } } }, actions: [
      { id: "checkpoint", type: "interaction_checkpoint", checkpointKind: "chapter_summary", checkpointId: "c", chapterId: "chapter", chapterTitle: "Chapter", question: "Why?", constraintPrompt: "Respond briefly", referenceAnswer: { summary: "Because", keyPoints: ["Evidence"] }, context: { chapterSummary: "Summary", sourceSceneIds: ["slide"] } },
    ] },
  ] };
}
const fence = { sessionId: "session", projectId: "project", expectedRevision: "r1", expectedSourceRevision: "source" };
async function setup(t, extra = {}) {
  const workspace = await mkdtemp(join(tmpdir(), "maic-main-"));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  let view = { projectId: "project", revision: "r1", sourceRevision: "source", classroom: classroom() };
  let active = "session", attached = true, intercept = async () => {};
  const calls = [];
  const host = { async call(method, args) {
    calls.push([method, args]); await intercept(method, args);
    if (method === "session.get") return { session: { mode: "agent", projectPath: workspace } };
    if (method === "courseware.task.get") return { task: attached ? { canonicalProjectId: "project" } : {} };
    if (method === "courseware.classroom.get") return structuredClone(view);
    if (method === "courseware.classroom.create") { view = { ...view, revision: "r2", classroom: structuredClone(args.classroom) }; return structuredClone(view); }
    if (method === "courseware.classroom.write") {
      assert.equal(args.expectedRevision, view.revision);
      assert.equal(args.expectedSourceRevision, view.sourceRevision);
      view = { ...view, revision: "r2", classroom: structuredClone(args.classroom) };
      return structuredClone(view);
    }
    assert.fail(`Unexpected RPC ${method}`);
  } };
  const coordinator = new CoursewareClassroomCoordinator({ getHost: () => host, getSessionId: () => active, getWorkspace: async () => workspace,
    assertOwned: sessionId => { if (active !== sessionId) throw new Error("stale session"); },
    openProject: async () => ({ project: { projectId: "project" } }), ...extra,
  });
  return { coordinator, workspace, calls, get view() { return view; }, change: patch => { view = { ...view, ...patch }; },
    stale: () => { active = "other"; }, intercept: fn => { intercept = fn; }, detach: () => { attached = false; } };
}
test("open canonical-only project and save independent Quiz/checkpoint without changing fields", async t => {
  const f = await setup(t);
  const opened = await f.coordinator.open({ sessionId: "session" });
  const next = structuredClone(opened.classroom);
  next.scenes[0].content.questions[0].options[0].label = "Changed";
  next.scenes[1].actions[0].constraintPrompt = "Use evidence";
  const written = await f.coordinator.write({ ...fence, classroom: next });
  assert.deepEqual(written.classroom, runtime.prepareMaicAssessmentSpeech(next));
  assert.equal(written.revision, "r2");
  assert(f.calls.some(([method]) => method === "courseware.task.get"));
});

test("assessment editing never reads or encodes unrelated body slide images", async t => {
  const f = await setup(t), document = classroom();
  document.mediaManifest = [{ sceneId: "slide", elementId: "background", assetId: "body", assetType: "image", mimeType: "image/png", src: ".deckwise-ppt/missing-body.png", originalSrc: ".deckwise-ppt/missing-body.png" }];
  document.scenes[1].content.canvas.elements = [{id:"background",type:"image",src:".deckwise-ppt/missing-body.png",left:0,top:0,width:100,height:100,rotate:0,fixedRatio:true}];
  f.change({classroom:document});
  const view = await f.coordinator.open({sessionId:"session"});
  assert.deepEqual(view.resourceUrls, {});
  assert.equal(view.classroom.mediaManifest.length, 1, "Preserve the body manifest for playback/export");
  const [, params] = f.calls.find(([method]) => method === "session.get");
  assert.equal(params.messageLimit, 1, "Workspace checks must not read the entire Chat history");
  assert.equal(params.contentLimit, 1);
});

test("native assessment selection reads current canonical data without repeating native reconciliation", async t => {
  let refreshes = 0;
  const f = await setup(t, {refreshNative:async()=>{refreshes++; return f.view;}});
  const document = classroom();
  for (const scene of document.scenes) scene.metadata = {nativeTeachingRevision:"teaching-1",nativePageId:scene.id};
  f.change({classroom:document});
  const native = {pageId:"quiz",project:{projectId:"project",source:{revision:"source"},teachingRevision:"teaching-1",pages:[{pageId:"quiz"},{pageId:"slide"}]}};
  await f.coordinator.openNative("session", native);
  document.scenes[0].content.questions[0].question = "Edited by another writer";
  f.change({revision:"r2",classroom:document});
  const next = await f.coordinator.openNative("session", native);
  assert.equal(next.revision, "r2");
  assert.equal(next.classroom.scenes[0].content.questions[0].question, "Edited by another writer");
  assert.equal(refreshes, 0);
});

for (const mismatch of ["source", "teaching", "pages"]) test(`native assessment reconciles changed ${mismatch} before editing`, async t => {
  let refreshes = 0;
  const f = await setup(t, {refreshNative:async()=>{refreshes++;return {...f.view,sourceRevision:mismatch === "source" ? "new-source" : "source"};}});
  const document = classroom();
  for (const scene of document.scenes) scene.metadata = {nativeTeachingRevision:"teaching-1",nativePageId:scene.id};
  f.change({classroom:document});
  const native = {pageId:"quiz",project:{projectId:"project",source:{revision:mismatch === "source" ? "new-source" : "source"},teachingRevision:mismatch === "teaching" ? "new-teaching" : "teaching-1",pages:mismatch === "pages" ? [{pageId:"quiz"}] : [{pageId:"quiz"},{pageId:"slide"}]}};
  await f.coordinator.openNative("session", native);
  assert.equal(refreshes, 1);
});
test("native assessment synchronizes a Host source conflict but never hides unrelated read failures", async t => {
  let refreshes = 0;
  const f = await setup(t, {refreshNative:async()=>{refreshes++;return f.view;}});
  const document = classroom();
  for (const scene of document.scenes) scene.metadata = {nativeTeachingRevision:"teaching-1",nativePageId:scene.id};
  f.change({classroom:document});
  let failure = "COURSEWARE_CONFLICT: native source changed; regenerate classroom";
  f.intercept(method => {if(method === "courseware.classroom.get") throw new Error(failure);});
  const native = {pageId:"quiz",project:{projectId:"project",source:{revision:"source"},teachingRevision:"teaching-1",pages:[{pageId:"quiz"},{pageId:"slide"}]}};
  await f.coordinator.openNative("session", native);
  assert.equal(refreshes, 1);
  failure = "Database unavailable";
  await assert.rejects(f.coordinator.openNative("session",native),/Database unavailable/);
  assert.equal(refreshes, 1);
});
test("image question and option use exact MAIC manifest identifiers and export to archived resources", async t => {
  const f = await setup(t);
  const result = await f.coordinator.image({ ...fence, sceneId: "quiz", questionId: "q", optionValue: "A", dataUrl: png });
  const image = result.classroom.scenes[0].content.questions[0].options[0].image;
  const bytes = Buffer.from(png.split(",")[1], "base64"), digest = createHash("sha256").update(bytes).digest("hex");
  assert.equal(image.src, `.deckwise-ppt/classroom-assets/${digest}.png`);
  assert.equal(result.resourceUrls[image.src], png);
  assert.equal(image.assetId, `image-${digest}`);
  assert.equal(result.classroom.mediaManifest[0].elementId, "quiz-option:q:A");
  assert.deepEqual(await readFile(join(f.workspace, ".deckwise-ppt/classroom-assets", `${digest}.png`)), bytes);
  const exported = await f.coordinator.export({ ...fence, expectedRevision: "r2" });
  assert.equal(exported.fileName, "Test_class.zip");
  const zip = await JSZip.loadAsync(exported.bytes), meta = JSON.parse(await zip.file("meta.json").async("string"));
  const src = meta.classroom.scenes[0].content.questions[0].options[0].image.src;
  assert.equal(src, `assets/${digest}.png`);
  assert.deepEqual(await zip.file(src).async("nodebuffer"), bytes);
  assert.equal(meta.classroom.scenes[1].actions[0].constraintPrompt, "Respond briefly");
  const question = await f.coordinator.image({ ...fence, expectedRevision: "r2", sceneId: "quiz", questionId: "q", dataUrl: png });
  assert(question.classroom.mediaManifest.some(item => item.elementId === "quiz-question:q"));
});
test("image upload commits unsaved question content and the image together behind the original CAS", async t => {
  const f = await setup(t), draft = classroom();
  draft.scenes[0].content.questions[0].question = 'New question';
  draft.scenes[0].content.questions[0].options.push({value:'C', label:'New option'});
  const result = await f.coordinator.image({...fence, sceneId:'quiz', questionId:'q', optionValue:'C', dataUrl:png, classroom:draft});
  assert.equal(result.classroom.scenes[0].content.questions[0].question, 'New question');
  assert(result.classroom.scenes[0].content.questions[0].options[2].image);
  assert.equal(f.calls.filter(([method]) => method === 'courseware.classroom.write').length, 1);
  const g = await setup(t);
  await assert.rejects(g.coordinator.image({...fence, sceneId:'quiz', questionId:'q', dataUrl:png, classroom:{id:'invalid'}}));
  assert(!g.calls.some(([method]) => method === 'courseware.classroom.write'));
  await assert.rejects(g.coordinator.image({...fence, expectedRevision:'stale', sceneId:'quiz', questionId:'q', dataUrl:png, classroom:draft}), /changed/);
});
test("stale revisions, missing options and untrusted MIME cannot write documents", async t => {
  const f = await setup(t);
  await assert.rejects(f.coordinator.image({ ...fence, expectedRevision: "old", sceneId: "quiz", questionId: "q", dataUrl: png }), /changed/);
  await assert.rejects(f.coordinator.image({ ...fence, sceneId: "quiz", questionId: "q", optionValue: "X", dataUrl: png }), /option is missing/);
  await assert.rejects(f.coordinator.image({ ...fence, sceneId: "quiz", questionId: "q", dataUrl: "data:image/png;base64,dGV4dA==" }), /MIME/);
  await assert.rejects(f.coordinator.write({ ...fence, classroom: classroom(), path: "/etc/passwd" }), /fields/);
  assert(!f.calls.some(([method]) => method === "courseware.classroom.write"));
});
test("session and source changes during async operations fail before document write or export", async t => {
  const f = await setup(t);
  f.intercept(async method => { if (method === "courseware.classroom.get") f.stale(); });
  await assert.rejects(f.coordinator.write({ ...fence, classroom: classroom() }), /stale session/);
  assert(!f.calls.some(([method]) => method === "courseware.classroom.write"));
  const g = await setup(t); let reads = 0;
  g.intercept(async method => { if (method === "courseware.classroom.get" && ++reads === 2) g.change({ revision: "newer" }); });
  await assert.rejects(g.coordinator.export(fence), /changed/);
});
test("image archive symlink escape and external asset exports are rejected", async t => {
  const f = await setup(t), outside = await mkdtemp(join(tmpdir(), "maic-outside-"));
  t.after(() => rm(outside, { recursive: true, force: true }));
  await symlink(outside, join(f.workspace, ".deckwise-ppt"));
  await assert.rejects(f.coordinator.image({ ...fence, sceneId: "quiz", questionId: "q", dataUrl: png }), /escapes/);
  const c = classroom();
  c.scenes[0].content.questions[0].image = { src: "http://127.0.0.1/private", assetId: "external", mimeType: "image/png" };
  c.mediaManifest = [{ sceneId: "quiz", elementId: "quiz-question:q", assetId: "external", assetType: "image", mimeType: "image/png", src: "http://127.0.0.1/private", originalSrc: "http://127.0.0.1/private" }];
  f.change({ classroom: c });
  await assert.rejects(f.coordinator.export(fence), /not archived locally/);
});
test("two near-limit image uploads keep canonical JSON small and actual bytes portable", async t => {
  const f = await setup(t);
  const bytes = Buffer.alloc(5 * 1024 * 1024);
  Buffer.from(png.split(",")[1], "base64").copy(bytes);
  const image = `data:image/png;base64,${bytes.toString("base64")}`;
  const first = await f.coordinator.image({ ...fence, sceneId: "quiz", questionId: "q", dataUrl: image });
  const second = await f.coordinator.image({ ...fence, expectedRevision: first.revision, sceneId: "quiz", questionId: "q", optionValue: "B", dataUrl: image });
  assert(Buffer.byteLength(JSON.stringify(second.classroom)) < 10_000);
  const exported = await f.coordinator.export({ ...fence, expectedRevision: second.revision });
  const zip = await JSZip.loadAsync(exported.bytes), meta = JSON.parse(await zip.file("meta.json").async("string"));
  const question = meta.classroom.scenes[0].content.questions[0];
  assert.equal(question.image.src, question.options[1].image.src);
  assert.deepEqual(await zip.file(question.image.src).async("nodebuffer"), bytes);
});
test("reference regeneration uses explicit current checkpoint, preserves Quiz and rejects stale completion", async t => {
  let data;
  const f = await setup(t, { completeReference: async (_session, prompt) => { data = JSON.parse(prompt); return JSON.stringify({ summary: "Generated", keyPoints: ["New point"], constraintPrompt: "New constraint" }); } });
  const result = await f.coordinator.reference({ ...fence, sceneId: "slide", actionId: "checkpoint" });
  assert.equal(data.question, "Why?");
  assert.deepEqual(result.classroom.scenes[0], classroom().scenes[0]);
  assert.equal(result.classroom.scenes[1].actions[0].referenceAnswer.summary, "Generated");
  const g = await setup(t, { completeReference: async () => { g.change({ revision: "changed" }); return JSON.stringify({ summary: "Bad", keyPoints: [] }); } });
  await assert.rejects(g.coordinator.reference({ ...fence, sceneId: "slide", actionId: "checkpoint" }), /changed/);
  assert(!g.calls.some(([method]) => method === "courseware.classroom.write"));
});
test("canonical build archives edited MAIC content and supports a Quiz-only source without fake PPT", async t => {
  const f = await setup(t);
  const saved = await f.coordinator.image({ ...fence, sceneId: "quiz", questionId: "q", dataUrl: png });
  const content = structuredClone(saved.classroom);
  content.scenes = content.scenes.filter(scene => scene.type === "quiz");
  const built = await buildMaicCourseware({ classroom: content, workspace: f.workspace, outputDirectory: join(f.workspace, "builds"), report: { ready: true }, assertCurrent: async () => {} });
  const files = await openCoursewareBuildFiles(built.directory, built.buildId);
  const pkg = JSON.parse(Buffer.from(files.packageBytes()).toString("utf8"));
  assert.equal(pkg.schemaVersion, "deckwise-maic/1");
  assert.equal(pkg.classroom.scenes.length, 1);
  assert.equal(pkg.classroom.scenes[0].type, "quiz");
  const image = pkg.classroom.scenes[0].content.questions[0].image;
  assert(image.src.startsWith("assets/"));
  assert.deepEqual(Buffer.from(await files.assetBytes(image.assetId)), Buffer.from(png.split(",")[1], "base64"));
  await assert.rejects(openCoursewareBuildUpload(built.directory, built.buildId), /Invalid fixed build file list|Incomplete/);
  await assert.rejects(readFile(join(built.directory, "source.pptx")), /ENOENT/);
});
