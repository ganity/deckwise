import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import ts from "typescript";
import * as runtime from "@pi-desktop/agent-runtime";
import * as shared from "@pi-desktop/shared";
const require = createRequire(import.meta.url);
const fixtureProject = JSON.parse(await readFile(new URL("../../../packages/shared/src/courseware-contract.fixtures/accepted.json", import.meta.url), "utf8")).project;

async function fixture({ scene = false, failPage, saveFailPage, sourceChange = false, pageCount = 3, cancelAfterSave = false, lostSaveReply = false, inheritedModel = false } = {}) {
  const source = await readFile(new URL("../electron/main/courseware-saved-narration.ts", import.meta.url), "utf8");
  const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
  const project = structuredClone(fixtureProject);
  project.taskType = scene ? "scene" : "import";
  project.projectId = "office-doc";
  project.source.sha256 = "a".repeat(64);
  project.pages = Array.from({ length: pageCount }, (_, i) => i + 1).map(n => ({ ...structuredClone(project.pages[0]), pageId: `page-${n}`, actions: [], locked: n === 3 }));
  const calls = [], saved = [];
  let active = true, changed = false;
  const host = { async call(method, args) {
    calls.push([method, args]);
    if (method === "session.get") return { session: { projectPath: "/workspace", mode: "agent", ...(inheritedModel ? {} : { providerId: "test", modelId: "model" }) } };
    if (method === "courseware.scenePlan.get") return { approval: { plan: { title: "Approved teaching", pages: Array.from({length: pageCount}, (_, i) => ({title:`Approved ${i+1}`, visibleText:["Square"], visualIntent:"A five-second silent turning square video", narration:"Look at the square"})) } } };
    if (method === "courseware.task.get") return { task: { taskType: "import", importPath: "/workspace/lesson.pptx" } };
    if (method === "courseware.parseStart") return { jobId: "parser" };
    if (method === "courseware.parseStatus") return { status: "SUCCEEDED", summary: { sourceSha256: project.source.sha256 } };
    if (method === "courseware.parseRelease" || method === "courseware.parseCancel") return {};
    if (method === "courseware.project.openSaved" || method === "courseware.project.get") return { project: structuredClone(project) };
    if (method === "courseware.pageText") return { text: `Page ${args.pageNumber}` };
    if (method === "courseware.pageEvidence") return { text: `Page ${args.pageNumber}`, notes: "Notes", width: 1000, height: 750,
      elements: [{ id: "text-1", kind: "text", text: `Page ${args.pageNumber}`, bbox: [0,0,100,100] }] };
    if (method === "courseware.project.context") return { project: structuredClone(project), mapping: { sourceSha256: project.source.sha256, pages: project.pages.map(p => ({ pageId: p.pageId, objects: [{ objectId: `object-${p.pageId}`, importElementId: "text-1" }] })) } };
    if (method === "courseware.narration.save") {
      assert.deepEqual(args.baseline, project);
      assert.equal(args.write.expectedTeachingRevision, project.teachingRevision);
      if (args.write.pageId === `page-${saveFailPage}`) throw new Error("Save failed");
      saved.push(structuredClone(args));
      project.pages.find(p => p.pageId === args.write.pageId).actions = structuredClone(args.write.actions);
      project.teachingRevision = `saved-${saved.length}`;
      if (cancelAfterSave) { active = false; await delay(150); }
      if (lostSaveReply) throw new Error("Save response lost; read saved teaching before retrying");
      return { project: structuredClone(project) };
    }
    assert.fail(method);
  } };
  const exports = {};
  const load = (code, exports) => new Function("require", "exports", code)(name => {
    if (name === "@pi-desktop/agent-runtime") return runtime;
    if (name === "@pi-desktop/shared") return shared;
    if (name === "./courseware-source-files") return {
      readLiveSource: async () => Buffer.from(changed ? "changed" : "original"),
      sourceHash: bytes => bytes.toString() === "original" ? "a".repeat(64) : "b".repeat(64),
      adoptionRevision: async () => ({ documentPath: "/workspace/.deckwise-ppt/revisions/doc/r0001/document.pptx", sha256: "a".repeat(64) }),
    };
    if (name === "./ppt-editor-files") return { jobIdFor: () => "doc" };
    if (name.startsWith("./")) {
      const path = new URL(`../electron/main/${name.slice(2)}.ts`, import.meta.url);
      const code = ts.transpileModule(require("node:fs").readFileSync(path, "utf8"), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
      const child = {}; load(code, child); return child;
    }
    return require(name);
  }, exports);
  load(compiled, exports);
  const coordinator = new exports.CoursewareSavedNarration(() => host, () => "chat", async input => {
    const data = JSON.parse(input.messages[0].content);
    if (scene) assert.equal((data.approvedPlan ?? data.coursePlan?.approvedPlan)?.pages[0].visualIntent, "A five-second silent turning square video");
    if (data.outline) return { text: JSON.stringify({ goal: "Understand shadows", pages: data.outline.filter(p => !p.unavailable).map(p => ({ pageNumber: p.pageNumber, purpose: "Explain", bridge: "Continue", focus: "Shadow" })) }) };
    if (data.pageText === `Page ${failPage}`) throw new Error("Model failed");
    if (sourceChange) changed = true;
    return { text: JSON.stringify({ blocks: [{ type: "speech", text: `Narration ${data.pageText}` }] }) };
  }, inheritedModel ? async () => ({ modelKey: "test/model", thinkingLevel: "off" }) : undefined);
  return { coordinator, project, calls, saved, stop: () => { active = false; },
    execute: (name, args = {}) => coordinator.execute("chat", name, args, () => active) };
}

test("saved narration inherits the current resolved Chat model", async () => {
  const f = await fixture({ inheritedModel: true });
  const result = await f.execute("courseware_narration_propose", { pageNumbers: [1], sourceSha256: f.project.source.sha256, instruction: "Explain the saved page" });
  assert.equal(result.saved, true);
  assert.equal(result.savedPages.length, 1);
});

test("reads saved deck and generates all selected pages without an editor or page navigation", async () => {
  const f = await fixture();
  const outline = await f.execute("courseware_narration_context");
  assert.equal(outline.pages.length, 3);
  assert.equal(outline.projectId, f.project.projectId);
  assert.equal(outline.teachingRevision, f.project.teachingRevision);
  assert.equal(outline.pages[2].locked, true);
  assert.equal(outline.narrationReady, false);
  assert.equal(outline.audioReady, false);
  const result = await f.execute("courseware_narration_propose", { pageNumbers: [1, 2], sourceSha256: outline.sourceSha256, instruction: "Explain to first graders" });
  assert.equal(result.savedPages.length, 2);
  assert.deepEqual(result.savedPages.map(c => c.pageNumber), [1, 2]);
  assert.equal(f.saved.length, 2);
  assert.equal(result.saved, true);
  const after = await f.execute("courseware_narration_context");
  assert.equal(after.pages[0].narrationReady, true);
  assert.equal(after.pages[0].speeches[0].text, "Narration Page 1");
  assert.equal(after.pages[0].speeches[0].audioReady, false);
  assert(!f.calls.some(([name]) => name.includes("Candidate")));
  assert(!f.calls.some(([name]) => /editor|selection/i.test(name)));
  assert.deepEqual(f.project.pages.map(p => p.actions.some(a => a.type === "speech")), [true, true, false]);
  assert(f.calls.some(([name]) => name === "courseware.parseRelease"));
});

test("partial generation preserves completed receipts and reports locked or failed pages", async () => {
  const f = await fixture({ failPage: 2 });
  const result = await f.execute("courseware_narration_propose", { pageNumbers: [1, 2, 3], sourceSha256: "a".repeat(64), instruction: "Explain" });
  assert.equal(result.savedPages.length, 1);
  assert.deepEqual(result.failures.map(f => f.pageNumber), [2, 3]);
  assert.equal(f.saved.length, 1);
});

test("source changes and cancellation prevent saving and release the parser", async () => {
  const f = await fixture({ sourceChange: true });
  const result = await f.execute("courseware_narration_propose", { pageNumbers: [1, 2], sourceSha256: "a".repeat(64), instruction: "Explain" });
  assert.equal(result.savedPages.length, 0);
  assert.equal(f.saved.length, 0);
  assert(f.calls.some(([name]) => name === "courseware.parseRelease"));
  const stopped = await fixture(); stopped.stop();
  await assert.rejects(stopped.execute("courseware_narration_context"), /changed|cancelled/);
});

test("regeneration replaces only selected teaching and does not need adoption", async () => {
  const f = await fixture();
  const args = { pageNumbers: [1, 2], sourceSha256: "a".repeat(64), instruction: "Explain" };
  await f.execute("courseware_narration_propose", args);
  const peer = structuredClone(f.project.pages[1]);
  f.project.pages[0].actions[0].text = "Previous narration";
  f.project.pages[0].actions[0].audioAssetId = "tts-old";
  const result = await f.execute("courseware_narration_propose", { ...args, pageNumbers: [1] });
  assert.equal(result.saved, true);
  assert.equal(f.project.pages[0].actions[0].text, "Narration Page 1");
  assert.equal(f.project.pages[0].actions[0].audioAssetId, undefined);
  assert.deepEqual(f.project.pages[1], peer);
  assert(!f.calls.some(([name]) => name.includes("Candidate")));
});

test("one save failure preserves completed pages and reports the failed page", async () => {
  const f = await fixture({ saveFailPage: 2 });
  const result = await f.execute("courseware_narration_propose", { pageNumbers: [1, 2], sourceSha256: "a".repeat(64), instruction: "Explain" });
  assert.equal(result.saved, false);
  assert.equal(result.applied, true);
  assert.deepEqual(result.savedPages.map(p => p.pageNumber), [1]);
  assert.deepEqual(result.failures.map(p => p.pageNumber), [2]);
  assert.equal(f.project.pages[0].actions[0].text, "Narration Page 1");
  assert.deepEqual(f.project.pages[1].actions, []);
});

test("cancellation after a completed save keeps teaching and reports every remaining page", async () => {
  const f = await fixture({ pageCount: 6, cancelAfterSave: true });
  const selected = [1, 2, 4, 5, 6];
  const result = await f.execute("courseware_narration_propose", { pageNumbers: selected, sourceSha256: "a".repeat(64), instruction: "Explain" });
  assert.equal(result.savedPages.length, 1);
  assert.equal(result.failures.length, selected.length - 1);
  assert.equal(f.saved.length, 1);
  assert.equal(f.project.pages.filter(p => p.actions.length).length, 1);
  assert.equal(result.saved, false);
  assert(f.calls.some(([name]) => name === "courseware.parseRelease"));
});

test("a lost save reply never triggers automatic replay or a false success receipt", async () => {
  const f = await fixture({ lostSaveReply: true });
  const result = await f.execute("courseware_narration_propose", { pageNumbers: [1, 2], sourceSha256: "a".repeat(64), instruction: "Explain" });
  assert.equal(f.saved.length, 1);
  assert.equal(result.savedPages.length, 0);
  assert.equal(result.failures.length, 2);
  assert(result.failures.some(p => p.error.includes("read saved teaching")));
  assert.equal(f.project.pages.filter(p => p.actions.length).length, 1);
});


test("approved scene requirements reach saved media context and every detailed narration generation", async () => {
  const f = await fixture({ scene: true, pageCount: 1 });
  const context = await f.execute("courseware_narration_context");
  assert.equal(context.approvedPlan.title, "Approved teaching");
  const result = await f.execute("courseware_narration_propose", { pageNumbers: [1], sourceSha256: "a".repeat(64), instruction: "Follow the approved teaching plan" });
  assert.equal(result.saved, true);
  assert.equal(f.saved.length, 1);
});
