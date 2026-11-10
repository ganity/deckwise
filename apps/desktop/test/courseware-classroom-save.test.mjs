import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import ts from "typescript";
import * as shared from "../../../packages/shared/dist/index.js";
import * as runtime from "../../../packages/courseware-runtime/dist/authoring.mjs";
import * as agentRuntime from "@pi-desktop/agent-runtime";
import * as nodeRuntime from "../../../packages/courseware-runtime/dist/node.mjs";
import { Host, resolveHostBinary } from "../../../scripts/e2e/host.mjs";
const require = createRequire(import.meta.url), cache = new Map();
// This CommonJS test loader lowers the production file-URL import to require.
const authoringUrl = new URL("../../../packages/courseware-runtime/dist/authoring.mjs", import.meta.url).href;
function load(file) {
  if (cache.has(file)) return cache.get(file);
  const exports = {}; cache.set(file, exports);
  const code = ts.transpileModule(readFileSync(file, "utf8"), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
  new Function("require", "exports", code)(id => id === "@pi-desktop/shared" ? shared : id === "@pi-desktop/agent-runtime" ? agentRuntime : id === "@pi-desktop/courseware-runtime/node" ? nodeRuntime : (id === "@pi-desktop/courseware-runtime/authoring" || id === authoringUrl) ? runtime : id === "./courseware-scene-generator" ? { createCoursewareSceneGenerator() { throw Error("Assessment pages must not invoke a model"); } } : id.startsWith(".") ? load(join(dirname(file), id + ".ts")) : require(id), exports);
  return exports;
}
const main = new URL("../electron/main/", import.meta.url).pathname;
const { stageGeneratedSceneCourse } = load(join(main, "courseware-scene-staging.ts"));
const { createClassroomNativeWriter, commitSavedPptx } = load(join(main, "courseware-classroom-save.ts"));
const { CoursewareClassroomCoordinator } = load(join(main, "courseware-classroom.ts"));
const { CoursewareNativeSave } = load(join(main, "courseware-native-save.ts"));
const { refreshNativeMaicClassroom } = load(join(main, "courseware-classroom-native.ts"));
const { executeSavedAssessmentMedia } = load(join(main, "courseware-assessment-saved.ts"));
test("managed question speech saves without recompiling the native presentation", async () => {
  const classroom = { scenes: [{ id: "quiz", title: "Quiz", content: { type: "quiz", questions: [{ id: "q", question: "Question" }] }, actions: [] }] };
  const prepared = structuredClone(classroom);
  prepared.scenes[0].actions.push({ id: "question-tts", type: "speech", text: "Question" });
  prepared.scenes[0].metadata = { assessmentSpeechIds: { quiz: "question-tts" } };
  const writer = createClassroomNativeWriter({ getWorkspace: async () => "/workspace", assertOwned() {},
    editor: { ensureSaved: async () => {} },
    teaching: { assertCurrent: async () => {}, withSaved: async (_, operation) => operation({ call: async (method) => {
      if (method === "courseware.classroom.source") return { classroom, revision: "r", sourceRevision: "s", currentSourceRevision: "s" };
      assert.equal(method, "courseware.classroom.write"); return { saved: true };
    } }, "job", {}, {}, "session") },
  });
  assert.deepEqual(await writer({ sessionId: "session", projectId: "project", expectedRevision: "r", expectedSourceRevision: "s", classroom: prepared }), { saved: true });
});
const { CoursewareSavedNarration } = load(join(main, "courseware-saved-narration.ts"));
const { jobIdFor, listRevisions, publishRevision, replaceSourceFile } = load(join(main, "ppt-editor-files.ts"));
const { parseMaicClassroom } = nodeRuntime;
const hash = bytes => createHash("sha256").update(bytes).digest("hex");

test("approved Quiz and checkpoint plan compiles and stages every physical page through real Host proof validation", { timeout: 60_000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), "classroom-approved-generation-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const workspace = join(directory, "workspace"), data = join(directory, "data"); await mkdir(workspace);
  await mkdir(join(data, "plugins/market"), { recursive: true });
  await writeFile(join(data, "plugins/market/catalog.json"), JSON.stringify({ schemaVersion: 2, providerId: "official", plugins: [] }));
  process.env.DECKWISE_PPTX_NODE = process.execPath;
  process.env.DECKWISE_PPTX_WORKER = new URL("../../../packages/courseware-runtime/dist/pptx-worker.mjs", import.meta.url).pathname;
  const host = new Host(resolveHostBinary(), data); t.after(() => host.stop()); await host.start();
  const { session } = await host.call("session.create", { title: "Independent assessments", mode: "agent", projectPath: workspace });
  const sessionId = session.id; await host.call("courseware.task.set", { sessionId, taskType: "scene" });
  const teaching = { phase: "practice", objective: "Greetings", durationSeconds: 30, requiredObjects: [] };
  const planJson = JSON.stringify({ title: "Greetings", bodyPageLimit: 1, pages: [
    { title: "Quiz", visibleText: [], visualIntent: "Quiz template", narration: "", teaching: { ...teaching, pageType: "quiz" }, quiz: { type: "quiz", questions: [{ id: "q", type: "single", question: "Choose", options: [{ value: "A", label: "Hello" }, { value: "B", label: "Bye" }], answer: ["A"] }] } },
    { title: "Discussion", visibleText: [], visualIntent: "Checkpoint template", narration: "", teaching: { ...teaching, pageType: "interactive", question: { text: "Your name?", response: { kind: "discussion", options: [], answerIndices: [] }, referenceAnswer: { summary: "My name is Pandy.", keyPoints: ["Name"] }, constraintPrompt: "Use one sentence." } } },
  ] });
  const planPath = join(workspace, `.deckwise-ppt/scenes/${sessionId}/plan.json`);
  await mkdir(dirname(planPath), { recursive: true }); await writeFile(planPath, planJson);
  const planSha256 = hash(planJson);
  await host.call("courseware.scenePlan.approve", { sessionId, sha256: planSha256 });
  const { parseSceneCoursePlan } = load(join(main, "courseware-scene-plan.ts"));
  const { buildSceneCourseDeck } = load(join(main, "courseware-scene-deck.ts"));
  const plan = parseSceneCoursePlan(planJson);
  const deck = await buildSceneCourseDeck({ sessionId, modelKey: "unused", pages: plan.pages, visuals: [], canvas: { width: 1000, height: 562.5 } }, async () => { throw Error("Unexpected paid model request"); }, runtime);
  const staged = await stageGeneratedSceneCourse({ workspace, sessionId, title: plan.title, ...deck, sceneMapping: deck.mapping, sceneProof: { planSha256, principalKey: "a".repeat(64), selectedIntentIds: [] }, host });
  assert.equal(staged.project.pages.length, 2);
  const saved = await host.call("courseware.classroom.get", { sessionId, projectId: staged.project.projectId });
  assert.deepEqual(saved.classroom.scenes.map(scene => scene.type), ["quiz", "slide"]);
  assert(saved.classroom.scenes.every(scene => scene.metadata.nativePageId));
  assert(!("canvas" in saved.classroom.scenes[0].content));
  const checkpoint = saved.classroom.scenes[1].actions.find(action => action.type === "interaction_checkpoint");
  assert.equal(checkpoint.question, "Your name?");
  assert.equal(checkpoint.constraintPrompt, "Use one sentence.");
  assert(staged.project.pages.every(page => page.actions.length === 0));
  assert.deepEqual(saved.classroom.scenes[0].actions, []);
  assert.deepEqual(saved.classroom.scenes[1].actions.map(a => a.type), ["interaction_checkpoint"]);
  const context = await host.call("courseware.project.context", { sessionId, projectId: staged.project.projectId });
  assert.deepEqual([...context.assessmentPageIds].sort(), staged.project.pages.map(p => p.pageId).sort());
  assert.equal(context.completion.ready, true, JSON.stringify(context.completion));
  const savedNarration = new CoursewareSavedNarration(() => host, () => 'another-visible-chat', async () => { throw Error('Unexpected LLM'); });
  const imageBytes = Buffer.from(runtime.assessmentBackground.bytes), tasks = new Map();
  const auth = { getCoursewarePrincipal: () => ({key:'test-principal',assertCurrent(){}}), coursewareMedia: {
    getImageModels: async () => [{model:'fixture-image'}],
    getImageQuote: async () => ({maxPoints:1,maxChars:8000,expiresAt:new Date(Date.now()+60000).toISOString()}),
    findImage: async ref => tasks.get(ref.idempotencyKey) ?? null,
    submitConfirmedImage: async (key, request, quote, signal, projectId, check, admit) => {
      await check(); await admit();
      const task = {taskId:'fixture-task',state:'ready',assetRef:{mime:'image/png',byteLength:imageBytes.length,sha256:hash(imageBytes)}};
      tasks.set(key,task); return task;
    },
    getImage: async ref => tasks.get(ref.idempotencyKey),
    downloadImage: async ref => ({task:tasks.get(ref.idempotencyKey),bytes:imageBytes}),
  } };
  const media = args => executeSavedAssessmentMedia({sessionId,args,canDispatch:()=>true,getHost:()=>host,saved:savedNarration,auth,
    decodeAudio:async()=>{throw Error('Unexpected TTS decode');}});
  const pending = await media({mode:'context',kind:'image'});
  assert.equal(pending.ready,false); assert.equal(pending.targets.length,4);
  assert.equal(tasks.size,0,'Reading a headless assessment context must not submit media');
  const target = pending.targets.find(target=>target.kind==='image');
  const select = value => ({projectId:value.projectId,expectedRevision:value.expectedRevision,expectedSourceRevision:value.expectedSourceRevision,...target,model:'fixture-image'});
  await media({mode:'prepare',...select(pending)});
  const current = await media({mode:'context'});
  const beforeImage = hash(await readFile(staged.path));
  const adopted = await media({mode:'refresh',...select(current)});
  assert.equal(adopted.state,'adopted'); assert.notEqual(hash(await readFile(staged.path)),beforeImage);
  assert.equal(tasks.size,1,'The original image order must be reused across service reconstruction');
  const archived = await host.call('courseware.classroom.get',{sessionId,projectId:staged.project.projectId});
  assert(archived.classroom.scenes[0].content.questions[0].options[0].image.src.startsWith('.deckwise-ppt/classroom-assets/'));
  const output = await (await import('jszip')).default.loadAsync(await readFile(staged.path));
  assert(Object.keys(output.files).some(name=>/^ppt\/media\/.*\.png$/u.test(name)),'Generated option image must be embedded in the real saved PPTX with Office closed');
});

test("real Main writer and Host atomically save question, copy, reorder, delete, undo, restart and export", { timeout: 120_000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), "classroom-native-save-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const workspace = join(directory, "workspace"), data = join(directory, "data"); await mkdir(workspace);
  await mkdir(join(data, "plugins/market"), { recursive: true });
  await writeFile(join(data, "plugins/market/catalog.json"), JSON.stringify({ schemaVersion: 2, providerId: "official", plugins: [] }));
  process.env.DECKWISE_PPTX_NODE = process.execPath;
  process.env.DECKWISE_PPTX_WORKER = new URL("../../../packages/courseware-runtime/dist/pptx-worker.mjs", import.meta.url).pathname;
  const host = new Host(resolveHostBinary(), data); t.after(() => host.stop()); await host.start();
  const { session } = await host.call("session.create", { title: "MAIC native save", mode: "agent", projectPath: workspace });
  const sessionId = session.id; await host.call("courseware.task.set", { sessionId, taskType: "scene" });
  const canvas = runtime.createMaicInteractionCanvas("discussion", "Discuss", "Original question");
  const checkpoint = { id: "checkpoint", type: "interaction_checkpoint", checkpointKind: "chapter_summary", checkpointId: "cp", chapterId: "chapter", chapterTitle: "Discuss", question: "Original question", referenceAnswer: { summary: "Hello", keyPoints: ["Greeting"] }, context: { chapterSummary: "Lesson", sourceSceneIds: [] } };
  const classroom = parseMaicClassroom({ id: "course", stage: { id: "stage", name: "Lesson", createdAt: 1, updatedAt: 1 }, createdAt: "2026-11-05", mediaManifest: [], audioManifest: [], scenes: [
    { id: "discussion", type: "slide", stageId: "stage", title: "Discuss", order: 0, content: { type: "slide", canvas }, actions: [{ id: "speech", type: "speech", text: "Explain" }, checkpoint] },
    { id: "quiz", type: "quiz", stageId: "stage", title: "Quiz", order: 1, content: { type: "quiz", questions: [{ id: "q", type: "single", question: "Choose", options: [{ value: "A", label: "Hello" }, { value: "B", label: "Bye" }], answer: ["A"] }] }, actions: [{ id: "quiz-speech", type: "speech", text: "Choose" }] },
  ] });
  const bodyTemplate = structuredClone(classroom.scenes[0]); bodyTemplate.id = "body"; bodyTemplate.content.canvas = runtime.createMaicInteractionCanvas("body", "Body", "Ordinary teaching");
  const compiled = await runtime.compileScenesToPptx([...classroom.scenes, bodyTemplate].map(scene => runtime.assessmentPptxScene(scene, "sha256:test", { width: 1000, height: 562.5 })), { [runtime.assessmentBackground.id]: runtime.assessmentBackground.bytes });
  bodyTemplate.actions = [{ id: "body-speech", type: "speech", text: "Body narration" }]; bodyTemplate.order = 2; classroom.scenes.push(bodyTemplate);
  const staged = await stageGeneratedSceneCourse({ workspace, sessionId, title: "Lesson", pptx: compiled.pptx, canonicalClassroom: classroom, teaching: classroom.scenes.map(scene => ({ pageId: scene.id, narration: scene.actions.find(a => a.type === "speech").text })), host });
  const projectId = staged.project.projectId, sourcePath = staged.path;
  const documentId = jobIdFor(workspace, sourcePath), root = join(workspace, ".deckwise-ppt/revisions");
  const read = () => host.call("courseware.classroom.get", { sessionId, projectId });
  async function parse(path) {
    const { jobId } = await host.call("courseware.parseStart", { sessionId, path });
    while (true) { const status = await host.call("courseware.parseStatus", { jobId }); if (status.status !== "RUNNING") { assert.equal(status.status, "SUCCEEDED", JSON.stringify(status)); return jobId; } await delay(20); }
  }
  const guardJob = await parse((await listRevisions(root, documentId)).at(-1).documentPath);
  try {
    await host.call("courseware.project.attach", { sessionId, jobId: guardJob, sourcePath });
    const { project: baseline } = await host.call("courseware.project.openSaved", { sessionId, jobId: guardJob });
    const attempt = (pageId, actions) => host.call("courseware.narration.save", { sessionId, jobId: guardJob, baseline,
      write: { projectId, pageId, expectedSourceRevision: baseline.source.revision, expectedTeachingRevision: baseline.teachingRevision, actions } });
    const speech = { id: "generated-lecture", type: "speech", text: "Unwanted lecture", source: "generated" };
    for (const scene of classroom.scenes.slice(0, 2)) {
      const bound = (await read()).classroom.scenes.find(s => s.id === scene.id).metadata.nativePageId;
      await assert.rejects(attempt(bound, [speech]), /independent Quiz\/checkpoint pages use the question editor/);
    }
    const bodyId = (await read()).classroom.scenes.find(s => s.id === "body").metadata.nativePageId;
    await assert.rejects(attempt(bodyId, [speech, { ...checkpoint, id: "embedded-checkpoint", context: { chapterSummary: "Lesson", sourceSceneIds: ["body"] } }]), /questions require separate assessment pages/);
    const current = await host.call("courseware.project.openSaved", { sessionId, jobId: guardJob });
    assert.deepEqual(current.project, baseline, "rejected lecture writes preserve every page and revision");
  } finally { await host.call("courseware.parseRelease", { jobId: guardJob }); }
  let frozen = 0, reopened = 0, livePage;
  const nativeSaveForQuiz = new CoursewareNativeSave(() => host, () => sessionId, async () => workspace,
    id => assert.equal(id, sessionId), operation => operation());
  const writer = createClassroomNativeWriter({
    getWorkspace: async () => workspace, assertOwned: id => assert.equal(id, sessionId),
    editor: { ensureSaved: async () => {}, getContext: async () => ({ page: livePage }), freezeForSourceAdoption: () => { frozen++; },
      // External Office export boundary. The real SDK transaction is covered by wiseoffice-quiz-live.browser.mjs.
      applyClassroomPage: async (actualWorkspace, snapshot, payload, classroomSave) => {
        assert.equal(actualWorkspace, workspace); assert.equal(payload.page, 1);
        assert.equal(payload.next.elements.find(e => e.id.endsWith('_question')).content, 'Question edited immediately before upload');
        assert(payload.assets[payload.next.elements.find(e => e.id.endsWith('_option1_image')).assetId]);
        const job = await parse(snapshot.path);
        let source;
        try { source = await host.call('courseware.classroom.source', {sessionId,projectId,jobId:job}); }
        finally { await host.call('courseware.parseRelease',{jobId:job}); }
        const compiled = await runtime.syncClassroomPptx({source:await readFile(snapshot.path),sourceHash:`sha256:${snapshot.sha256}`,
          previous:source.classroom,classroom:classroomSave.classroom,pages:source.project.pages.map(p=>({pageId:p.pageId})),
          readImage:async()=>runtime.assessmentBackground.bytes});
        const bytes=Buffer.from(compiled.pptx);
        const revision=await publishRevision({root,jobId:documentId,bytes,extension:'pptx',cause:'edited',expectedRevision:snapshot.revision});
        const binding={projectId:snapshot.projectId,documentId:snapshot.documentId,sessionId:snapshot.sessionId};
        const lineage={...binding,protocol:'deckwise-office-page-lineage/1',saveRequestId:'live-quiz-save',sourceSha256:snapshot.sha256,
          outputSha256:revision.sha256,openedPageTokens:source.project.pages.map(p=>p.pageId),pageTokens:source.project.pages.map(p=>p.pageId),
          objects:compiled.pages.map(p=>p.objectNames.map(name=>({name,...(p.animationUnchanged?{sourceName:name,sourcePageToken:p.sourcePageId}:{})}))),
          animationUnchanged:compiled.pages.map(p=>p.animationUnchanged)};
        const pending=await nativeSaveForQuiz.prepare({workspace,sourcePath,sourceRevisionPath:snapshot.path,sourceSha256:snapshot.sha256,
          outputPath:revision.documentPath,outputSha256:revision.sha256,saveRequestId:lineage.saveRequestId,binding,lineage,classroomSave});
        await replaceSourceFile(sourcePath,bytes,'pptx',snapshot.sha256); await pending.commit();
      } },
    reopen: async path => { assert.equal(path, sourcePath); reopened++; },
    teaching: {
      assertCurrent: async snapshot => assert.equal(hash(await readFile(sourcePath)), snapshot.sha256),
      withSaved: async (id, operation) => {
        assert.equal(id, sessionId);
        const revision = (await listRevisions(root, documentId)).at(-1);
        let activeJob = await parse(revision.documentPath); const jobId = activeJob;
        await host.call("courseware.project.attach", { sessionId, jobId, sourcePath });
        await host.call("courseware.project.openSaved", { sessionId, jobId });
        const snapshot = { projectId: hash(workspace), documentId, sessionId: "native-session", sourcePath, path: revision.documentPath, sha256: revision.sha256, revision: revision.revision };
        try { return await operation(host, jobId, snapshot, {}, sessionId, async path => { await host.call("courseware.parseRelease", { jobId: activeJob }); activeJob = await parse(path); return activeJob; }); }
        finally { await host.call("courseware.parseRelease", { jobId: activeJob }); }
      },
    },
  });
  const coordinator = new CoursewareClassroomCoordinator({ getHost: () => host, getSessionId: () => sessionId,
    getWorkspace: async () => workspace, assertOwned: id => assert.equal(id, sessionId), writeNative: writer,
    openProject: async () => ({project: {projectId}}) });
  async function save(change) { const before = await read(), next = structuredClone(before.classroom); change(next); return writer({ sessionId, projectId, expectedRevision: before.revision, expectedSourceRevision: before.sourceRevision, classroom: next }); }
  const beforeNoop = await read();
  const unchanged = await coordinator.write({sessionId, projectId, expectedRevision:beforeNoop.revision,
    expectedSourceRevision:beforeNoop.sourceRevision, classroom:beforeNoop.classroom});
  assert.equal(frozen, 0, "Pre-upload save of unchanged content must not destroy the requesting native iframe");
  assert.equal(unchanged.revision, beforeNoop.revision, "An unchanged save must not stale another open sidebar/preview");
  await assert.rejects(save(next => {
    const quiz = next.scenes.find(scene => scene.type === "quiz").content;
    quiz.interactionMode = "assessment_review";
    quiz.questions.push({ ...quiz.questions[0], id: "second" });
  }), /每个 Quiz 页面必须且只能包含一道题/);
  assert.equal(frozen, 0, "Invalid multi-question writes never close the native editor");
  let result = await save(next => { next.scenes[0].actions[1].question = "Edited <question> & 中文"; next.scenes[0].content.canvas.elements.find(e => e.id === "discussion_question").content = "<p>Edited &lt;question&gt; &amp; 中文</p>"; });
  assert.equal(result.classroom.scenes[0].actions[1].question, "Edited <question> & 中文");
  let jobId = await parse((await listRevisions(root, documentId)).at(-1).documentPath);
  let seed = await host.call("courseware.classroom.source", { sessionId, projectId, jobId });
  assert(seed.ir.pages[0].elements.some(element => element.content?.includes("Edited") && element.content.includes("中文")), JSON.stringify(seed.ir.pages[0]));
  await host.call("courseware.parseRelease", { jobId });
  await save(next => { next.scenes[0].actions[1].question = ""; next.scenes[0].content.canvas.elements.find(e => e.id === "discussion_question").content = "<p></p>"; });
  result = await save(next => { next.scenes[0].actions[1].question = "Restored question"; next.scenes[0].content.canvas.elements.find(e => e.id === "discussion_question").content = "<p>Restored question</p>"; });
  assert.equal(result.classroom.scenes[0].actions[1].question, "Restored question");
  result = await save(next => { const copy = structuredClone(next.scenes[0]); copy.id = "copy"; copy.metadata = { copiedFromNativePageId: copy.metadata.nativePageId, nativeQuestionElementId: "discussion_question" }; copy.actions.forEach(a => { a.id += "-copy"; if (a.type === "interaction_checkpoint") a.checkpointId += "-copy"; }); next.scenes = [next.scenes[1], copy, next.scenes[0], next.scenes[2]]; next.scenes.forEach((s, i) => s.order = i); });
  assert.equal(result.classroom.scenes.length, 4); assert.equal(new Set(result.classroom.scenes.map(s => s.metadata.nativePageId)).size, 4);
  const body = structuredClone(result.classroom.scenes.find(s => s.id === "body"));
  await save(next => { next.scenes = next.scenes.filter(s => s.id !== "body"); });
  result = await save(next => { next.scenes.push(body); }); // Undo after the deletion was already committed.
  assert.equal(result.classroom.scenes.length, 4);
  const beforeOptionEdit = hash(await readFile(sourcePath));
  result = await save(next => { next.scenes[0].content.questions[0].options[0].label = "Edited option"; next.scenes[2].actions[1].constraintPrompt = "Only greetings"; });
  assert.notEqual(hash(await readFile(sourcePath)), beforeOptionEdit);
  const imageSrc = `.deckwise-ppt/classroom-assets/${hash(runtime.assessmentBackground.bytes)}.png`;
  const beforeImage = hash(await readFile(sourcePath));
  livePage = 1;
  const freezesBeforeUpload = frozen;
  const beforeUpload = await read(), imageDraft = structuredClone(beforeUpload.classroom);
  imageDraft.scenes[0].content.questions[0].question = 'Question edited immediately before upload';
  result = await coordinator.image({sessionId, projectId, expectedRevision:beforeUpload.revision,
    expectedSourceRevision:beforeUpload.sourceRevision, classroom:imageDraft, sceneId:imageDraft.scenes[0].id,
    questionId:'q', optionValue:'B', dataUrl:`data:image/png;base64,${Buffer.from(runtime.assessmentBackground.bytes).toString('base64')}`});
  const uploaded = result.classroom.scenes[0].content.questions[0];
  assert.equal(frozen, freezesBeforeUpload, "Quiz image upload must preserve the running editor");
  assert.equal(uploaded.question, imageDraft.scenes[0].content.questions[0].question);
  assert.equal(uploaded.options[1].image.src, imageSrc);
  assert(result.resourceUrls[imageSrc]);
  delete result.resourceUrls; // Display URLs are not part of persisted Host state.
  assert.notEqual(hash(await readFile(sourcePath)),beforeImage);
  assert.equal(frozen, reopened); assert.equal(frozen, 7);
  await host.restart(); assert.deepEqual(await read(), result);
  jobId = await parse((await listRevisions(root, documentId)).at(-1).documentPath);
  seed = await host.call("courseware.classroom.source", { sessionId, projectId, jobId });
  assert(seed.ir.pages[0].elements.some(element => element.content?.includes("Edited")), JSON.stringify(seed.ir.pages[0]));
  const changedDeck = await (await import("jszip")).default.loadAsync(await readFile(sourcePath));
  assert.match(await changedDeck.file("ppt/slides/slide1.xml").async("string"), /Edited option/);
  assert.match(await changedDeck.file("ppt/slides/slide1.xml").async("string"), /Question edited immediately before upload/);
  assert(seed.ir.pages[0].elements.some(element=>element.type==="image"),"image-only changes embed into native PPT");
  assert.equal(seed.project.pages.length, 4); assert.equal(seed.ir.pages.length, 4); assert.equal(seed.mapping.pages.length, 4);
  assert.equal(seed.classroom.scenes[0].content.type, "quiz"); assert(!("canvas" in seed.classroom.scenes[0].content));
  await host.call("courseware.parseRelease", { jobId });
  // Export the actual saved document through the same MAIC exporter used by Main.
  const node = await import("../../../packages/courseware-runtime/dist/node.mjs");
  const exported = await node.exportMaicClassroom(result.classroom, async () => runtime.assessmentBackground.bytes);
  const { default: JSZip } = await import("jszip");
  const meta = JSON.parse(await (await JSZip.loadAsync(exported)).file("meta.json").async("string"));
  assert.equal(meta.classroom.scenes.length, 4);
  assert(!("canvas" in meta.classroom.scenes[0].content));
  assert(!JSON.stringify(meta).includes("nativePageId"));

  // Ordinary native saves update PPT identity before canonical canvas reconciliation.
  const beforeNative = await host.call("courseware.project.context", { sessionId, projectId });
  const previousRevision = (await listRevisions(root, documentId)).at(-1);
  changedDeck.comment = "Ordinary native save after assessment editing";
  const bytes = await changedDeck.generateAsync({ type: "nodebuffer" });
  const revision = await publishRevision({ root, jobId: documentId, bytes, extension: "pptx", cause: "edited", expectedRevision: previousRevision.revision });
  const binding = { projectId: hash(workspace), documentId, sessionId: "native-session" };
  const lineage = { ...binding, protocol: "deckwise-office-page-lineage/1", saveRequestId: "ordinary-save",
    sourceSha256: previousRevision.sha256, outputSha256: revision.sha256,
    openedPageTokens: seed.project.pages.map(p => p.pageId), pageTokens: seed.project.pages.map(p => p.pageId),
    objects: beforeNative.savedObjects.pages.map(page => page.objects.filter(object => typeof object.sourceObjectName === "string").map(object => ({ name: object.sourceObjectName,
      sourceName: object.sourceObjectName, sourcePageToken: page.pageId }))),
    animationUnchanged: seed.project.pages.map(() => true) };
  const nativeSave = new CoursewareNativeSave(() => host, () => sessionId, async () => workspace,
    id => assert.equal(id, sessionId), operation => operation());
  const pending = await nativeSave.prepare({ workspace, sourcePath, sourceRevisionPath: previousRevision.documentPath,
    sourceSha256: previousRevision.sha256, outputPath: revision.documentPath, outputSha256: revision.sha256,
    saveRequestId: lineage.saveRequestId, binding, lineage });
  await replaceSourceFile(sourcePath, bytes, "pptx", previousRevision.sha256);
  await pending.commit();
  await host.restart();
  const contextAfterSave = await host.call("courseware.project.context", { sessionId, projectId });
  assert.deepEqual(contextAfterSave.assessmentPageIds, beforeNative.assessmentPageIds);
  assert.deepEqual(contextAfterSave.project.pages.map(p => p.actions), beforeNative.project.pages.map(p => p.actions));
  const bodyIdAfterUndo = result.classroom.scenes.find(s => s.id === "body").metadata.nativePageId;
  assert.equal(contextAfterSave.project.pages.find(p => p.pageId === bodyIdAfterUndo).actions[0].text, "Body narration");
  await assert.rejects(read(), /native source changed/);
  jobId = await parse(revision.documentPath);
  try {
    const refreshed = await refreshNativeMaicClassroom({ host, sessionId, projectId, jobId, workspace });
    assert.equal(refreshed.sourceRevision, contextAfterSave.project.source.revision);
    assert.deepEqual(refreshed.classroom.scenes[0].content, result.classroom.scenes[0].content);
    assert.equal(refreshed.classroom.scenes.find(s => s.id === "body").actions[0].text, "Body narration");
  } finally { await host.call("courseware.parseRelease", { jobId }); }

  // The same durable receipt must preserve logical targets when only native timing changes.
  const beforeMotions = (await host.call("courseware.project.get", { sessionId, projectId })).project;
  const motionSource = await readFile(sourcePath), motionJob = await parse(revision.documentPath);
  const motionSeed = await host.call("courseware.classroom.source", { sessionId, projectId, jobId: motionJob });
  const motionPages = motionSeed.project.pages.map((page, index) => ({ actions: [], objects: motionSeed.ir.pages[index].elements.map(element => ({
    id: motionSeed.mapping.pages[index].objects.find(object => object.importElementId === element.id).objectId,
    objectName: element.sourceObjectName,
  })) }));
  const bodyIndex = beforeMotions.pages.findIndex(page => page.pageId === bodyIdAfterUndo);
  motionPages[bodyIndex].actions = [{ type: "speech", visualCues: [{ atMs: 0, endMs: 600,
    effect: { type: "element_animation", elementId: motionPages[bodyIndex].objects[0].id, effect: "fadeIn" } }] }];
  const motions = await runtime.syncSpeechAnimations({ source: motionSource, pages: motionPages });
  assert.equal(motions.changedPages.filter(Boolean).length, 1);
  await commitSavedPptx({ sessionId, workspace, sourcePath, bytes: Buffer.from(motions.pptx), assertCurrent() {},
    saved: { host, jobId: motionJob, project: beforeMotions, bytes: motionSource, check: async () => {
      assert.equal(hash(await readFile(sourcePath)), beforeMotions.source.sha256);
    }, release: async () => host.call("courseware.parseRelease", { jobId: motionJob }) },
    lineage: { pageTokens: beforeMotions.pages.map(page => page.pageId), animationUnchanged: motions.changedPages.map(changed => !changed),
      objects: motionPages.map((page, index) => page.objects.map(object => ({ name: object.objectName, sourceName: object.objectName,
        sourcePageToken: beforeMotions.pages[index].pageId }))) } });
  await host.restart();
  const afterMotions = await host.call("courseware.project.context", { sessionId, projectId });
  assert.equal(afterMotions.project.source.sha256, hash(motions.pptx));
  assert.deepEqual(afterMotions.project.pages.map(page => page.actions), beforeMotions.pages.map(page => page.actions));
  assert.deepEqual(afterMotions.mapping.pages.map(page => page.objects.map(object => object.objectId)),
    motionSeed.mapping.pages.map(page => page.objects.map(object => object.objectId)));
});
