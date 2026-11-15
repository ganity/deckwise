/** Real assessment compiler -> trusted PPTX parser -> Host project initialization. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import ts from "typescript";
import * as runtime from "../../../packages/agent-runtime/dist/index.js";
import * as shared from "../../../packages/shared/dist/index.js";
import * as authoring from "../../../packages/courseware-runtime/dist/authoring.mjs";
import { Host } from "../../../scripts/e2e/host.mjs";

const exports = {};
new Function("require", "exports", ts.transpileModule(await readFile(new URL("../electron/main/courseware-scene-deck.ts", import.meta.url), "utf8"), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText)(id => {
  if (id === "node:crypto") return { createHash };
  if (id === "./courseware-scene-generator") return { createCoursewareSceneGenerator() { assert.fail("Unexpected model call"); } };
  assert.fail(id);
}, exports);
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const require = createRequire(import.meta.url);
const modules = new Map([["@pi-desktop/shared", shared], ["@pi-desktop/agent-runtime", runtime]]);
function load(name) {
  if (modules.has(name)) return modules.get(name);
  if (!name.startsWith("./")) return require(name);
  const source = readFileSync(new URL(`../electron/main/${name.slice(2)}.ts`, import.meta.url), "utf8");
  const output = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
  const exports = {};
  modules.set(name, exports);
  new Function("require", "exports", output)(load, exports);
  return exports;
}
const objectView = {};
new Function("require", "exports", ts.transpileModule(await readFile(new URL("../electron/main/courseware-scene-object-view.ts", import.meta.url), "utf8"), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText)(id => {
  if (id === "@pi-desktop/shared") return shared;
  assert.fail(id);
}, objectView);

test("Quiz and checkpoint placeholders compile, bind trusted objects and survive Host restart", {
  skip: !process.env.DECKWISE_E2E_WORKFLOW_HOST, timeout: 90_000,
}, async t => {
  const dir = await mkdtemp(join(tmpdir(), "deckwise-assessment-compile-"));
  const workspace = join(dir, "workspace"), data = join(dir, "data");
  await mkdir(workspace); await mkdir(join(data, "plugins/market"), { recursive: true });
  await writeFile(join(data, "plugins/market/catalog.json"), JSON.stringify({ schemaVersion: 2, providerId: "official", plugins: [] }));
  const host = new Host(process.env.DECKWISE_E2E_WORKFLOW_HOST, data);
  t.after(async () => { await host.stop(); await rm(dir, { recursive: true, force: true }); });
  await host.start();
  const sessionId = (await host.call("session.create", { projectPath: workspace })).session.id;
  await host.call("courseware.task.set", { sessionId, taskType: "scene" });
  const base = { visibleText: [], visualIntent: "MAIC assessment template", narration: "" };
  const plan = { title: "Family", pages: [
    { ...base, title: "Quiz", quiz: { type: "quiz", questions: ["Greeting?"].map((question, index) => ({ id: `q${index}`, type: "single", question, options: [{ value: "A", label: "Hello" }, { value: "B", label: "Bye" }], answer: ["A"] })) },
      teaching: { pageType: "quiz", phase: "practice", objective: "Greet", durationSeconds: 30, requiredObjects: [] } },
    { ...base, title: "Discuss", teaching: { pageType: "interactive", phase: "practice", objective: "Explain", durationSeconds: 30, requiredObjects: [],
      question: { text: "Introduce your family.", response: { kind: "discussion", options: [], answerIndices: [] } } } },
  ] };
  const bytes = Buffer.from(JSON.stringify(plan)), planSha256 = hash(bytes);
  const path = join(workspace, ".deckwise-ppt/scenes", sessionId, "plan.json");
  await mkdir(join(path, ".."), { recursive: true }); await writeFile(path, bytes);
  await host.call("courseware.scenePlan.approve", { sessionId, sha256: planSha256 });
  const planner = {};
  new Function("require", "exports", ts.transpileModule(await readFile(new URL("../electron/main/courseware-scene-plan.ts", import.meta.url), "utf8"), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText)(id => {
    if (id === "node:crypto") return { createHash };
    if (id === "@pi-desktop/shared") return shared;
    if (id === "@pi-desktop/agent-runtime") return runtime;
    assert.fail(id);
  }, planner);
  const { pages } = planner.parseSceneCoursePlan(JSON.stringify(plan));
  const deck = await exports.buildSceneCourseDeck({ sessionId, modelKey: "fixture/model", pages, visuals: [], canvas: { width: 1000, height: 562.5 } },
    async () => assert.fail("Unexpected model call"), authoring);
  const generated = join(workspace, ".deckwise-ppt/generated", `${hash(deck.pptx)}.pptx`);
  const { jobIdFor, publishRevision } = load("./ppt-editor-files");
  const { documentPath: archive } = await publishRevision({ root: join(workspace, ".deckwise-ppt/revisions"),
    jobId: jobIdFor(workspace, generated), bytes: deck.pptx, extension: "pptx", cause: "generated", expectedRevision: 0 });
  const { jobId } = await host.call("courseware.parseStart", { sessionId, path: archive });
  let parsed;
  for (let i = 0; i < 1000; i++) {
    parsed = await host.call("courseware.parseStatus", { jobId });
    if (parsed.status !== "RUNNING") break;
    await delay(20);
  }
  assert.equal(parsed.status, "SUCCEEDED", JSON.stringify(parsed));
  const { project } = await host.call("courseware.project.initializeGenerated", { sessionId, jobId, sourceSha256: hash(deck.pptx), title: plan.title,
    narrations: ["", ""], sceneMapping: deck.mapping, sceneProof: { planSha256, principalKey: "a".repeat(64), selectedIntentIds: [] } });
  assert.equal(project.pages.length, 2);
  const context = await host.call("courseware.project.context", { sessionId, projectId: project.projectId });
  for (const [index, page] of context.sceneObjects.pages.entries()) {
    assert.equal(page.objects.length, deck.mapping.pages[index].elements.length);
    assert(page.objects.every(object => object.status === "mapped"));
  }
  project.pages.forEach((page, index) => {
    assert.deepEqual(context.sceneObjects.pages[index].teaching, pages[index].teaching);
    assert.deepEqual(objectView.sceneTeachingForPage(context, project, page.pageId), pages[index].teaching);
  });
  assert(project.pages.every(page => page.actions.length === 0), "Assessment pages must not receive body narration");
  const scope = { sessionId, projectId: project.projectId };
  const baseline = await host.call("courseware.classroom.get", scope);
  const classroom = structuredClone(deck.canonicalClassroom);
  classroom.scenes.forEach((scene, index) => { scene.metadata = { ...scene.metadata, nativePageId: project.pages[index].pageId }; });
  await host.call("courseware.classroom.write", { ...scope, expectedRevision: baseline.revision,
    expectedSourceRevision: baseline.sourceRevision, classroom });
  const saved = await host.call("courseware.classroom.get", scope);
  assert.equal(saved.classroom.scenes[0].type, "quiz");
  assert.equal(saved.classroom.scenes[0].content.questions.length, 1);
  assert.equal(saved.classroom.scenes[1].actions[0].type, "interaction_checkpoint");
  await mkdir(join(generated, ".."), { recursive: true }); await writeFile(generated, deck.pptx);
  await host.call("courseware.task.attachGenerated", { sessionId, path: generated, projectId: project.projectId,
    sourceSha256: hash(deck.pptx), sceneProof: { planSha256, principalKey: "a".repeat(64), selectedIntentIds: [] } });
  const attachedContext = await host.call("courseware.project.context", scope);
  assert.equal(attachedContext.completion.ready, true);
  assert.deepEqual(new Set(attachedContext.assessmentPageIds), new Set(project.pages.map(page => page.pageId)));
  await host.call("courseware.parseRelease", { jobId });
  const { CoursewareSavedNarration } = load("./courseware-saved-narration");
  const narration = new CoursewareSavedNarration(() => host, () => sessionId, async () => assert.fail("Unexpected model call"));
  const teachingContext = await narration.execute(sessionId, "courseware_narration_context", {}, () => true);
  assert.equal(teachingContext.projectId, project.projectId);
  assert.equal(teachingContext.teachingReady, true);
  const { CoursewareSavedMedia } = load("./courseware-saved-media");
  const media = new CoursewareSavedMedia(narration, {
    getCoursewarePrincipal: () => ({ key: "a".repeat(64), assertCurrent() {} }),
    coursewareMedia: {},
  }, async () => assert.fail("Context reads must not decode audio"));
  const mediaContext = await media.execute(sessionId, "courseware_media_context", {}, () => true);
  assert.equal(mediaContext.teachingReady, true);
  assert.deepEqual(mediaContext.jobs, []);
  await host.stop(); await host.start();
  assert.deepEqual(await host.call("courseware.project.context", scope), attachedContext);
  assert.deepEqual(await host.call("courseware.classroom.get", scope), saved);
});

test("assessment page bindings survive JSON field reordering but reject a changed course revision", () => {
  const project = { schemaVersion: shared.COURSEWARE_CONTRACT_VERSION, projectId: "project-1", taskType: "scene", title: "Lesson",
    source: { revision: "source-1", sha256: "a".repeat(64) }, teachingRevision: "teaching-1",
    pages: [{ pageId: "page-1", locked: false, reviewState: "ready", actions: [] },
      { pageId: "page-2", locked: false, reviewState: "ready", actions: [] }] };
  const reorder = value => Array.isArray(value) ? value.map(reorder) : value && typeof value === "object"
    ? Object.fromEntries(Object.entries(value).reverse().map(([key, item]) => [key, reorder(item)])) : value;
  const context = { project: reorder(project), assessmentPageIds: ["page-2"] };
  assert.deepEqual([...objectView.assessmentPageIds(context, project)], ["page-2"]);
  assert.equal(objectView.objectsForTeaching(context, project, "page-1"), undefined);
  assert.equal(objectView.sceneObjectsForTeaching(context, project, "page-1"), undefined);
  assert.throws(() => objectView.assessmentPageIds({ project: { ...reorder(project), teachingRevision: "teaching-2" }, assessmentPageIds: ["page-2"] }, project),
    /Assessment context changed/);
});
