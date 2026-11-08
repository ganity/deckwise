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

async function fixture({ assessmentPageIds = [], nativeSaved = false, scene = false, failPage, saveFailPage, sourceChange = false, pageCount = 3, cancelAfterSave = false, lostSaveReply = false, inheritedModel = false, visionOutput, teachingPages, planOutputs = [], pageOutputs = {}, planError, stopOnRepair = false, onComplete } = {}) {
  const source = await readFile(new URL("../electron/main/courseware-saved-narration.ts", import.meta.url), "utf8");
  const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
  const project = structuredClone(fixtureProject);
  project.taskType = scene ? "scene" : "import";
  project.projectId = "office-doc";
  project.source.sha256 = "a".repeat(64);
  project.pages = Array.from({ length: pageCount }, (_, i) => i + 1).map(n => ({ ...structuredClone(project.pages[0]), pageId: `page-${n}`, actions: [], locked: n === 3 }));
  const calls = [], saved = [], requests = [];
  let active = true, changed = false, viewing = "chat";
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
    if (method === "courseware.project.context") return { project: structuredClone(project), assessmentPageIds, nativeSaved,
      ...(teachingPages ? { sceneObjects: { schemaVersion: "deckwise-scene-objects/1", sourceSha256: project.source.sha256,
        requiresReview: true, pages: teachingPages.map(page => ({ ...page, objects: [] })) } } : {}),
      mapping: { sourceSha256: project.source.sha256, pages: project.pages.map(p => ({ pageId: p.pageId, objects: [{ objectId: `object-${p.pageId}`, importElementId: "text-1" }] })) } };
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
    if (name === "./courseware-narration-visuals" && visionOutput) return { createNarrationVisuals: async () => ({
      page: async () => ({ images: [{ data: "fixture", mimeType: "image/png" }], imageBindings: [] }), dispose: async () => {} }) };
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
  const coordinator = new exports.CoursewareSavedNarration(() => host, () => viewing, async input => {
    const data = JSON.parse(input.messages[0].content);
    requests.push(data);
    await onComplete?.(data, input);
    if (scene && (data.outline || data.pageText)) assert.equal((data.approvedPlan ?? data.coursePlan?.approvedPlan)?.pages[0].visualIntent, "A five-second silent turning square video");
    if (data.outline) {
      if (planError) throw planError;
      if (data.repair && stopOnRepair) active = false;
      return { text: planOutputs.length ? planOutputs.shift() : JSON.stringify({ goal: "Understand shadows", pages: data.outline.filter(p => !p.unavailable).map(p => ({ pageNumber: p.pageNumber, purpose: "Explain", bridge: "Continue", focus: "Shadow" })) }) };
    }
    if (data.pageText === `Page ${failPage}`) throw new Error("Model failed");
    if (sourceChange) changed = true;
    if (pageOutputs[data.pageText]?.length) return { text: pageOutputs[data.pageText].shift() };
    return { text: JSON.stringify({ blocks: [{ type: "speech", text: `Narration ${data.pageText}` }] }) };
  }, inheritedModel ? async () => ({ modelKey: "test/model", thinkingLevel: "off" }) : undefined,
    visionOutput ? async input => ({ text: JSON.stringify(typeof visionOutput === "function" ? await visionOutput(input) : visionOutput) }) : undefined);
  return { coordinator, project, calls, saved, requests, view: value => { viewing = value; }, stop: () => { active = false; },
    execute: (name, args = {}) => coordinator.execute("chat", name, args, () => active) };
}

test("background saved narration survives leaving Chat during a model call", async () => {
  const f = await fixture({ onComplete: async () => { f.view(null); await delay(130); } });
  const result = await f.execute("courseware_narration_propose", { pageNumbers: [1, 2],
    sourceSha256: f.project.source.sha256, instruction: "Explain both pages" });
  assert.equal(result.saved, true);
  assert.deepEqual(result.savedPages.map(page => page.pageNumber), [1, 2]);
  f.view("other");
  assert.equal((await f.execute("courseware_narration_context")).projectId, f.project.projectId);
  assert(f.calls.filter(([name]) => name === "courseware.narration.save").every(([, args]) => args.sessionId === "chat"));
  await assert.rejects(f.coordinator.review({ sessionId: "chat", candidateId: "saved-candidate" }), /conversation changed/);
  f.stop();
  await assert.rejects(f.execute("courseware_narration_context"), /turn ended|cancelled/);
});

test("saved narration inherits the current resolved Chat model", async () => {
  const f = await fixture({ inheritedModel: true });
  const result = await f.execute("courseware_narration_propose", { pageNumbers: [1], sourceSha256: f.project.source.sha256, instruction: "Explain the saved page" });
  assert.equal(result.saved, true);
  assert.equal(result.savedPages.length, 1);
});

test("repairs only invalid page output with exact feedback while preserving successful pages", async () => {
  const badAnchor = JSON.stringify({ blocks: [{ type: "speech", text: "Look at the square.",
    attention: { type: "highlight", objectIds: ["object-page-1"], anchorText: "absent" } }] });
  const f = await fixture({ pageOutputs: { "Page 1": ["not JSON", badAnchor] } });
  const result = await f.execute("courseware_narration_propose", { pageNumbers: [1, 2], sourceSha256: f.project.source.sha256, instruction: "Explain" });
  assert.equal(result.saved, true);
  assert.equal(f.requests.filter(r => r.pageText === "Page 1").length, 3);
  assert.equal(f.requests.filter(r => r.pageText === "Page 2").length, 1);
  const repairs = f.requests.filter(r => r.repair && r.pageText);
  assert.equal(repairs.length, 2);
  assert.equal(repairs[0].repair.previousOutput, "not JSON");
  assert.match(repairs[1].repair.error, /anchor must occur exactly once/);
  assert.equal(f.saved.length, 2);
});

test("stops page format repair after two corrections and never retries a provider failure", async () => {
  const f = await fixture({ pageOutputs: { "Page 1": ["invalid", "invalid", "invalid"] }, failPage: 2 });
  const result = await f.execute("courseware_narration_propose", { pageNumbers: [1, 2], sourceSha256: f.project.source.sha256, instruction: "Explain" });
  assert.equal(result.saved, false);
  assert.deepEqual(result.failures.map(f => f.pageNumber), [1, 2]);
  assert.equal(f.requests.filter(r => r.pageText === "Page 1").length, 3);
  assert.equal(f.requests.filter(r => r.pageText === "Page 2").length, 1);
  assert.equal(f.saved.length, 0);
});

test("repairs canonical wait placement before saving while keeping the page evidence unchanged", async () => {
  const f = await fixture({ pageOutputs: { "Page 1": [JSON.stringify({ blocks: [
    { type: "wait", durationMs: 1000 }, { type: "speech", text: "Look here." },
  ] })] } });
  const result = await f.execute("courseware_narration_propose", { pageNumbers: [1], sourceSha256: f.project.source.sha256, instruction: "Explain" });
  assert.equal(result.saved, true);
  const requests = f.requests.filter(r => r.pageText === "Page 1");
  assert.equal(requests.length, 2);
  assert.match(requests[1].repair.error, /Waiting requires preceding speech/);
  assert.deepEqual(requests[1].evidence, requests[0].evidence);
});

test("repairs an invalid whole-deck plan inside the original narration request", async () => {
  const f = await fixture({ planOutputs: [JSON.stringify({ goal: "Lesson", pages: [] })] });
  const result = await f.execute("courseware_narration_propose", { pageNumbers: [1, 2], sourceSha256: f.project.source.sha256, instruction: "Explain the whole lesson" });
  assert.equal(result.saved, true);
  assert.deepEqual(result.savedPages.map(page => page.pageNumber), [1, 2]);
  const plans = f.requests.filter(request => request.outline);
  assert.equal(plans.length, 2);
  assert.match(plans[1].repair.error, /pages.*3/);
  assert.deepEqual(plans[1].outline, plans[0].outline);
});

test("bounds invalid-plan repair and reports the exact field without saving", async () => {
  const invalid = JSON.stringify({ goal: "Lesson", pages: [1, 2, 3].map(pageNumber => ({ pageNumber, purpose: "Explain", bridge: "Continue", focus: [] })) });
  const f = await fixture({ planOutputs: [invalid, invalid] });
  await assert.rejects(f.execute("courseware_narration_propose", { pageNumbers: [1], sourceSha256: f.project.source.sha256, instruction: "Explain page one" }), /whole-deck narration plan.*pages\[0\]\.focus/);
  assert.equal(f.requests.filter(request => request.outline).length, 2);
  assert.equal(f.saved.length, 0);
  assert(f.calls.some(([method]) => method === "courseware.parseRelease"));
});

test("repairs malformed planning JSON without narrowing a subset request", async () => {
  const f = await fixture({ planOutputs: ["```json\n{}\n```"] });
  const result = await f.execute("courseware_narration_propose", { pageNumbers: [2], sourceSha256: f.project.source.sha256, instruction: "Explain page two" });
  assert.equal(result.saved, true);
  assert.deepEqual(result.savedPages.map(page => page.pageNumber), [2]);
  const repair = f.requests.find(request => request.repair);
  assert.match(repair.repair.error, /valid JSON/);
  assert.deepEqual(repair.outline.map(page => page.pageNumber), [1, 2, 3]);
});

test("planning transport failure is not replayed as a format repair", async () => {
  const error = new Error("Planning provider connection lost");
  const f = await fixture({ planError: error });
  await assert.rejects(f.execute("courseware_narration_propose", { pageNumbers: [1], sourceSha256: f.project.source.sha256, instruction: "Explain" }), error);
  assert.equal(f.requests.filter(request => request.outline).length, 1);
  assert.equal(f.saved.length, 0);
  assert(f.calls.some(([method]) => method === "courseware.parseRelease"));
});

test("cancelling plan repair preserves saved teaching and releases only its parser", async () => {
  const f = await fixture({ planOutputs: ["{}"], stopOnRepair: true });
  f.project.pages[0].actions = [{ id: "existing", type: "speech", text: "Keep this", audioAssetId: "tts-existing" }];
  const previous = structuredClone(f.project);
  await assert.rejects(f.execute("courseware_narration_propose", { pageNumbers: [1], sourceSha256: f.project.source.sha256, instruction: "Explain" }), /changed|cancelled/);
  assert.equal(f.requests.filter(request => request.outline).length, 2);
  assert.deepEqual(f.project, previous);
  assert.equal(f.saved.length, 0);
  assert(f.calls.some(([method]) => method === "courseware.parseRelease"));
});

test("saved narration checks session identity without loading the full conversation", async () => {
  const f = await fixture({ inheritedModel: true });
  await f.execute("courseware_narration_context");
  const result = await f.execute("courseware_narration_propose", { pageNumbers: [1], sourceSha256: f.project.source.sha256, instruction: "Explain the saved page" });
  assert.equal(result.saved, true);
  const reads = f.calls.filter(([method]) => method === "session.get");
  assert(reads.length > 0);
  for (const [, args] of reads) assert.equal(args.messageLimit, 1);
});

test("saved narration supplies the output schema to the model transport", async () => {
  const f = await fixture();
  await f.execute("courseware_narration_propose", { pageNumbers: [1], sourceSha256: f.project.source.sha256, instruction: "Explain the saved page" });
  const request = f.requests.find(request => request.pageText);
  assert.deepEqual(request.schema, runtime.pageNarrationOutputSchema.toJSONSchema());
});

test("split scene outline speeches do not count as detailed narration", async () => {
  const f = await fixture({ scene: true, pageCount: 1 });
  f.project.pages[0].actions = [0, 1, 2].map(index => ({
    id: `narration-${index}`, type: "speech", text: `Outline sentence ${index}.`,
  }));
  const outline = await f.execute("courseware_narration_context");
  assert.equal(outline.pages[0].hasNarration, true);
  assert.equal(outline.pages[0].narrationReady, false);
  assert.equal(outline.narrationReady, false);
  await f.execute("courseware_narration_propose", {
    pageNumbers: [1], sourceSha256: f.project.source.sha256, instruction: "Generate detailed teaching",
  });
  assert.equal((await f.execute("courseware_narration_context")).narrationReady, true);
  f.project.pages[0].actions = [{ id: "teacher-speech", type: "speech", text: "Manually written teaching." }];
  assert.equal((await f.execute("courseware_narration_context")).narrationReady, true);
  f.project.pages[0].actions = [{ id: "narration-0", type: "speech", text: "Generated teaching.", source: "generated" }];
  assert.equal((await f.execute("courseware_narration_context")).narrationReady, true);
});

test("verified native saved text reports only missing audio and never asks for a narration rewrite", async () => {
  const f = await fixture({ scene: true, nativeSaved: true, pageCount: 1 });
  f.project.pages[0].actions = [0, 1].map(index => ({ id: `narration-${index}`, type: "speech", text: `Saved sentence ${index}.` }));
  const before = structuredClone(f.project);
  const context = await f.execute("courseware_narration_context");
  assert.equal(context.narrationReady, true);
  assert.equal(context.audioReady, false);
  assert.deepEqual(context.quality.counts, { AUDIO_MISSING: 2 });
  assert.equal(f.requests.length, 0);
  assert.deepEqual(f.project, before);
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

test("reordered scene narration uses the saved logical page question and music requirements", async () => {
  const music = { pageType: "slide", phase: "practice", objective: "Sing Hello", durationSeconds: 60, requiredObjects: [],
    music: { purpose: "Greeting song", prompt: "Sing Hello, friends!" } };
  const quiz = { pageType: "quiz", phase: "review", objective: "Choose a greeting", durationSeconds: 30, requiredObjects: [],
    question: { text: "Which is a greeting?", response: { kind: "single", options: ["Hello", "Goodbye"], answerIndices: [0] } } };
  const f = await fixture({ scene: true, pageCount: 2,
    teachingPages: [{ pageId: "page-1", teaching: music }, { pageId: "page-2", teaching: quiz }] });
  f.project.pages.reverse();
  const result = await f.execute("courseware_narration_propose", { pageNumbers: [1, 2], sourceSha256: "a".repeat(64), instruction: "Follow the approved teaching plan" });
  assert.equal(result.saved, true);
  const requests = f.requests.filter(request => request.pageText);
  assert.deepEqual(requests.find(request => request.coursePlan.page.pageNumber === 1).coursePlan.teaching, quiz);
  assert.deepEqual(requests.find(request => request.coursePlan.page.pageNumber === 2).coursePlan.teaching, music);
});


test("the existing scene vision pass binds observed names to saved UUIDs before narration", async () => {
  const visionOutput = { summary: "A monkey waves next to a cloud.", objects: [{ objectId: "object-page-1", role: "Monkey Munchy", aliases: ["小猴", "Monkey Munchy"], text: "", teachingTarget: true }] };
  const f = await fixture({ scene: true, pageCount: 1, visionOutput });
  const result = await f.execute("courseware_narration_propose", { pageNumbers: [1], sourceSha256: "a".repeat(64), instruction: "Explain" });
  assert.equal(result.saved, true);
  const evidence = f.requests.find(r => r.evidence)?.evidence;
  assert.deepEqual(evidence.objects[0].aliases, ["小猴", "Monkey Munchy"]);
  assert.equal(evidence.objects[0].objectId, "object-page-1");
  assert.equal(evidence.visualSummary, visionOutput.summary);
  for (const change of [v => { v.objects[0].objectId = "invented"; }, v => { v.objects.push(v.objects[0]); }, v => { v.objects[0].aliases = ["x".repeat(501)]; }]) {
    const invalid = structuredClone(visionOutput); change(invalid);
    const broken = await fixture({ scene: true, pageCount: 1, visionOutput: invalid });
    const receipt = await broken.execute("courseware_narration_propose", { pageNumbers: [1], sourceSha256: "a".repeat(64), instruction: "Explain" });
    assert.equal(receipt.saved, false);
    assert.equal(broken.saved.length, 0);
    assert.match(receipt.failures[0].error, /visual object/i);
  }
  const decorative = await fixture({ scene: true, pageCount: 1, visionOutput: { ...visionOutput, objects: [{ ...visionOutput.objects[0], teachingTarget: false }] } });
  await decorative.execute("courseware_narration_propose", { pageNumbers: [1], sourceSha256: "a".repeat(64), instruction: "Explain" });
  assert.deepEqual(decorative.requests.find(r => r.evidence)?.evidence.objects, []);
});

test("repairs visual annotations once and reuses successful page observations when retrying a failed page", async () => {
  let recover = false;
  const observations = [];
  const f = await fixture({ scene: true, pageCount: 2, visionOutput: input => {
    const data = JSON.parse(input.data);
    observations.push(data);
    return { summary: "A teaching square.", objects: [{ objectId: !recover && data.pageNumber === 2 ? "invented" : `object-page-${data.pageNumber}`,
      role: "Square", aliases: ["Square"], text: "Square", teachingTarget: true }] };
  } });
  const args = { sourceSha256: f.project.source.sha256, instruction: "Explain" };
  const first = await f.execute("courseware_narration_propose", { ...args, pageNumbers: [1, 2] });
  assert.deepEqual(first.savedPages.map(p => p.pageNumber), [1]);
  assert.equal(observations.filter(p => p.pageNumber === 2).length, 2);
  assert.match(observations.find(p => p.repair)?.repair.error, /Unknown scene visual object UUID/);
  recover = true;
  const second = await f.execute("courseware_narration_propose", { ...args, pageNumbers: [2] });
  assert.equal(second.saved, true);
  assert.deepEqual(f.saved.map(p => p.write.pageId), ["page-1", "page-2"]);
  assert.equal(observations.filter(p => p.pageNumber === 1).length, 1);
  assert.deepEqual(f.requests.filter(p => p.outline).at(-1).outline.map(p => p.pageNumber), [1, 2]);
});

test("a corrected visual annotation saves in the original request; transport errors are not format retries", async () => {
  let attempts = 0;
  const f = await fixture({ scene: true, pageCount: 1, visionOutput: input => {
    const data = JSON.parse(input.data);
    if (++attempts === 1) return { summary: "Square", objects: [] };
    assert.match(data.repair.error, /visual object evidence/);
    return { summary: "Square", objects: [{ objectId: "object-page-1", role: "Square", aliases: ["Square"], text: "Square", teachingTarget: true }] };
  } });
  const args = { pageNumbers: [1], sourceSha256: f.project.source.sha256, instruction: "Explain" };
  assert.equal((await f.execute("courseware_narration_propose", args)).saved, true);
  assert.equal(f.saved.length, 1);
  let failedAttempts = 0;
  const broken = await fixture({ scene: true, pageCount: 1, visionOutput: () => { failedAttempts++; throw new Error("Vision transport failed"); } });
  const result = await broken.execute("courseware_narration_propose", args);
  assert.equal(result.saved, false);
  assert.match(result.failures[0].error, /Vision transport failed/);
  assert.equal(failedAttempts, 1);
});


test("a single generated speech cannot hide unfinished or empty outline speeches", async () => {
  const f = await fixture({ scene: true, pageCount: 1 });
  const page = f.project.pages[0];
  page.actions = [{ id: "generated", type: "speech", text: "Detailed teaching", source: "generated" },
    { id: "narration-1", type: "speech", text: "Outline teaching" }];
  assert.equal((await f.execute("courseware_narration_context")).narrationReady, false);
  page.actions[1] = { id: "manual", type: "speech", text: "  " };
  assert.equal((await f.execute("courseware_narration_context")).narrationReady, false);
});


test("required teaching repair reaches the Host save boundary with exact speech anchors", async () => {
  const f = await fixture({ scene: true, pageCount: 1, teachingPages: [{ pageId: "page-1", teaching: {
    pageType: "slide", phase: "opening", objective: "Retain teaching", durationSeconds: 30, requiredObjects: [] } }] });
  f.project.pages[0].actions = [{ id: "saved-speech", type: "speech", text: "Already paid narration.", source: "generated", audioAssetId: `tts-${"c".repeat(64)}` }];
  const result = await f.execute("courseware_narration_propose", { pageNumbers: [1], sourceSha256: f.project.source.sha256,
    instruction: "Repair approved questions only", repairRequiredTeaching: true });
  assert.equal(result.saved, true);
  assert.equal(f.saved[0].repairRequiredTeaching, true);
  assert.deepEqual(f.saved[0].write.actions, f.project.pages[0].actions);
  assert.equal(f.requests.filter(r => !r.outline).length, 0, "No missing requirements means no model speech round trip");
  await assert.rejects(f.execute("courseware_narration_propose", { pageNumbers: [1], sourceSha256: f.project.source.sha256,
    instruction: "Repair", repairRequiredTeaching: "true" }), /Invalid teaching repair mode/);
});

test("local focus repair needs neither whole-deck planning nor evidence from unrelated pages", async () => {
  const f = await fixture({ scene: true, pageCount: 3, planError: new Error("Planning must not run for local repair"),
    teachingPages: [{ pageId: "page-1", teaching: {
      pageType: "slide", phase: "opening", objective: "Retain teaching", durationSeconds: 30, requiredObjects: [] } }] });
  const speech = { id: "saved-speech", type: "speech", text: "Already paid narration.", source: "generated", audioAssetId: `tts-${"c".repeat(64)}` };
  f.project.pages[0].actions = [speech];
  const peers = structuredClone(f.project.pages.slice(1));
  const result = await f.execute("courseware_narration_propose", { pageNumbers: [1], sourceSha256: f.project.source.sha256,
    instruction: "Repair existing focus only", repairRequiredTeaching: true });
  assert.equal(result.saved, true);
  assert.equal(f.requests.length, 0);
  assert.deepEqual(f.calls.filter(([method]) => method === "courseware.pageEvidence").map(([, args]) => args.pageNumber), [1]);
  assert.deepEqual(f.project.pages[0].actions, [speech]);
  assert.deepEqual(f.project.pages.slice(1), peers);
});

test("approved activity repair does not receive the conflicting body-lecture prohibition", async () => {
  const question = { text: "Which greeting?", response: { kind: "single", options: ["Hello", "Bye"], answerIndices: [0] } };
  let generated = false;
  const f = await fixture({ scene: true, pageCount: 1, teachingPages: [{ pageId: "page-1", teaching: {
    pageType: "slide", phase: "practice", objective: "Greet", durationSeconds: 30, requiredObjects: [], question } }],
    onComplete: (data, input) => { if (data.missing) { generated = true; assert.doesNotMatch(input.system, /omit interaction blocks/); } },
    pageOutputs: { undefined: [JSON.stringify({ insertions: [{ afterSpeechId: "saved-speech", block: {
      type: "interaction", question: question.text, response: question.response,
      referenceAnswer: { summary: "Hello", keyPoints: ["Hello is a greeting"] } } }] })] } });
  f.project.pages[0].actions = [{ id: "saved-speech", type: "speech", text: "Already paid narration.", source: "generated", audioAssetId: `tts-${"c".repeat(64)}` }];
  const result = await f.execute("courseware_narration_propose", { pageNumbers: [1], sourceSha256: f.project.source.sha256,
    instruction: "Repair the required activity", repairRequiredTeaching: true });
  assert(generated);
  assert.equal(result.saved, true);
  assert.deepEqual(f.project.pages[0].actions.map(a => a.type), ["speech", "interaction_checkpoint"]);
});


test("unapproved music is corrected within the narration request before any Host save", async () => {
  const valid = { blocks: [{ type: "speech", text: "Hello." }] };
  const f = await fixture({ scene: true, pageCount: 1,
    teachingPages: [{ pageId: "page-1", teaching: { pageType: "slide", phase: "opening", objective: "Greet", durationSeconds: 30, requiredObjects: [] } }],
    pageOutputs: { "Page 1": [JSON.stringify({ blocks: [...valid.blocks, { type: "music", title: "Extra", prompt: "Unapproved song" }] }), JSON.stringify(valid)] } });
  const result = await f.execute("courseware_narration_propose", { pageNumbers: [1], sourceSha256: f.project.source.sha256, instruction: "Follow the approved plan" });
  assert.equal(result.saved, true);
  assert.equal(f.saved.length, 1);
  assert(f.requests.some(r => r.repair?.error.includes("not approved")));
  assert.deepEqual(f.project.pages[0].actions.map(a => a.type), ["speech"]);
});

// Independent assessments are owned by the canonical classroom, not the lecture generator.
test("independent quiz and checkpoint pages need no lecture and are excluded from generation", async () => {
  const f = await fixture({ scene: true, pageCount: 2, assessmentPageIds: ["page-1", "page-2"] });
  const context = await f.execute("courseware_narration_context");
  assert.equal(context.narrationReady, true);
  assert.equal(context.audioReady, true);
  assert.equal(context.teachingReady, true);
  assert.equal(context.quality.issues.length, 0);
  const result = await f.execute("courseware_narration_propose", { pageNumbers: [1, 2], sourceSha256: f.project.source.sha256, instruction: "Complete teaching" });
  assert.deepEqual(result.skippedPages.map(p => p.pageNumber), [1, 2]);
  assert.equal(f.requests.length, 0);
  assert.equal(f.saved.length, 0);
});

test("whole-deck lecture planning retains body page identities while skipping assessments", async () => {
  const f = await fixture({ scene: true, assessmentPageIds: ["page-2"] });
  const result = await f.execute("courseware_narration_propose", { pageNumbers: [1, 2], sourceSha256: f.project.source.sha256, instruction: "Complete teaching" });
  assert.deepEqual(result.savedPages.map(p => p.pageNumber), [1]);
  assert.deepEqual(f.requests.find(r => r.outline).outline.map(p => p.pageNumber), [1, 3]);
  assert.equal(f.project.pages[1].actions.length, 0);
});

test("saved mixed-course metadata remains readable and generates lectures only for body pages", async () => {
  const base = { phase: "practice", objective: "Greet", durationSeconds: 30, requiredObjects: [] };
  const f = await fixture({ scene: true, assessmentPageIds: ["page-2", "page-3"], teachingPages: [
    { pageId: "page-1", teaching: { ...base, pageType: "slide" } },
    { pageId: "page-2", teaching: { ...base, pageType: "quiz" } },
    { pageId: "page-3", teaching: { ...base, pageType: "interactive", question: {
      text: "Introduce your family.", response: { kind: "discussion", options: [], answerIndices: [] },
    } } },
  ] });
  const context = await f.execute("courseware_narration_context");
  assert.equal(context.narrationReady, false);
  assert(context.pages.slice(1).every(page => page.narrationReady && page.audioReady && page.teachingReady));
  assert.equal(f.requests.length, 0);
  const result = await f.execute("courseware_narration_propose", { pageNumbers: [1, 2, 3], sourceSha256: f.project.source.sha256, instruction: "Complete teaching" });
  assert.deepEqual(result.savedPages.map(page => page.pageNumber), [1]);
  assert.deepEqual(result.skippedPages.map(page => page.pageNumber), [2, 3]);
  assert.deepEqual(f.requests.find(request => request.outline).outline.map(page => page.pageNumber), [1]);
  assert(f.project.pages.slice(1).every(page => page.actions.length === 0));
  assert.equal((await f.execute("courseware_narration_context")).narrationReady, true);
});

test("body lecture generation repairs attempts to embed a checkpoint", async () => {
  const mixed = JSON.stringify({ blocks: [{ type: "speech", text: "Look at your family." }, { type: "interaction", question: "Who is mum?", response: { kind: "discussion", options: [], answerIndices: [] }, referenceAnswer: { summary: "Mum", keyPoints: ["mum"] } }] });
  const f = await fixture({ scene: true, pageOutputs: { "Page 1": [mixed] } });
  const result = await f.execute("courseware_narration_propose", { pageNumbers: [1], sourceSha256: f.project.source.sha256, instruction: "Explain" });
  assert.equal(result.saved, true);
  assert(f.requests.some(r => /separate assessment pages/.test(r.repair?.error ?? "")));
  assert(f.project.pages[0].actions.every(a => a.type !== "interaction_checkpoint"));
});

test("outline repair is rejected before a model call and quality directs generation before TTS", async () => {
  const f = await fixture({ scene: true, pageCount: 1 });
  f.project.pages[0].actions = [{ id: "narration-0", type: "speech", text: "Planning speech with focus." }];
  const previous = structuredClone(f.project);
  const context = await f.execute("courseware_narration_context");
  assert.equal(context.narrationReady, false);
  assert(context.quality.issues.some(issue => issue.code === "NARRATION_MISSING"));
  await assert.rejects(f.execute("courseware_narration_propose", { pageNumbers: [1], sourceSha256: f.project.source.sha256,
    instruction: "Only repair focus", repairRequiredTeaching: true }), /without repairRequiredTeaching/);
  assert.equal(f.requests.length, 0);
  assert.deepEqual(f.project, previous);
  const result = await f.execute("courseware_narration_propose", { pageNumbers: [1], sourceSha256: f.project.source.sha256, instruction: "Complete detailed teaching" });
  assert.equal(result.saved, true);
  assert(f.project.pages[0].actions.filter(action => action.type === "speech").every(action => action.source === "generated"));
  assert.equal((await f.execute("courseware_narration_context")).narrationReady, true);
});
