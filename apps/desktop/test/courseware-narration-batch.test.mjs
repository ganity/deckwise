import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import ts from "typescript";
import * as shared from "@pi-desktop/shared";
import * as runtime from "@pi-desktop/agent-runtime";

const require = createRequire(import.meta.url);
const cache = new Map();
function load(name) {
  if (cache.has(name)) return cache.get(name);
  if (name === "@pi-desktop/shared") return shared;
  if (name === "@pi-desktop/agent-runtime") return runtime;
  if (name === "./courseware-narration-visuals") return { createNarrationVisuals: async () => ({
    page: async () => ({ images: [{ assetIds: ["preview"], bytes: new Uint8Array([1]), width: 1280, height: 720, sha256: "a".repeat(64) }], imageBindings: [] }),
    dispose: async () => {},
  }) };
  if (!name.startsWith("./")) return require(name);
  const file = new URL(`../electron/main/${name.slice(2)}.ts`, import.meta.url);
  const exports = {}; cache.set(name, exports);
  const code = ts.transpileModule(readFileSync(file, "utf8"), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
  new Function("require", "exports", code)(load, exports);
  return exports;
}
const { generateSavedNarrationBatch } = load("./courseware-narration-batch");

function fixture(taskType, issues = [], requirePortrait = false, pageCount = 1) {
  let project = { schemaVersion: shared.COURSEWARE_CONTRACT_VERSION, projectId: "lesson", taskType, title: "Family",
    source: { revision: "R1", sha256: "a".repeat(64) }, teachingRevision: "T1",
    pages: Array.from({ length: pageCount }, (_, index) => ({ pageId: index ? `page-${index + 1}` : "page", locked: false, reviewState: "review", actions: [] })) };
  const teaching = { pageType: "slide", phase: "review", objective: requirePortrait ? "Recognize the family portrait" : "Read family word labels", durationSeconds: 30, requiredObjects: requirePortrait ? ["family portrait"] : [] };
  const sourceEvidence = { text: "father mother", notes: "Six people are in this family photo.", width: 1280, height: 720,
    elements: [{ id: "text", kind: "text", text: "father mother", bbox: [0, 0, 200, 100] }] };
  const requests = [], writes = [];
  const input = { sessionId: "session", jobId: "job", project, bytes: new Uint8Array(), selected: [1], instruction: requirePortrait ? "Teach family words using the required family portrait" : "Teach family words",
    model: { modelKey: "fixture" }, canDispatch: () => true,
    current: async expected => assert.deepEqual(expected, project),
    host: { call: async (method, args) => {
      if (method === "courseware.project.context") return { project, mapping: { sourceSha256: project.source.sha256, revision: "M1",
        pages: project.pages.map(page => ({ pageId: page.pageId, objects: [{ objectId: "label", importElementId: "text" }] })) },
        teachingRequirements: project.pages.map(page => ({ pageId: page.pageId, teaching })),
        ...(taskType === "scene" ? { sceneObjects: { schemaVersion: "deckwise-scene-objects/1", sourceSha256: project.source.sha256,
          requiresReview: true, pages: [{ pageId: "page", teaching, objects: [] }] } } : {}) };
      if (method === "courseware.pageEvidence") return structuredClone(sourceEvidence);
      if (method === "courseware.narration.save") {
        writes.push(args.write); project = { ...project, teachingRevision: `T${writes.length + 1}`,
          pages: project.pages.map(page => page.pageId === args.write.pageId ? { ...page, actions: args.write.actions } : page) };
        return { project };
      }
      assert.fail(method);
    } },
    completeVision: async request => {
      requests.push(request);
      return { text: JSON.stringify({ summary: "Two word labels. No portrait is visible.", objects: [{ objectId: "label", role: "Word label",
        aliases: ["father mother"], text: "father mother", teachingTarget: true }], issues }) };
    },
    complete: async request => {
      const data = JSON.parse(request.messages[0].content); requests.push({ ...request, data });
      if (data.outline) return { text: JSON.stringify({ goal: "Learn family words", pages: [{ pageNumber: 1, purpose: "Read labels", bridge: "Close", focus: "father mother" }] }) };
      return { text: JSON.stringify({ blocks: [{ type: "speech", text: "Father means 爸爸. Mother means 妈妈." }] }) };
    },
  };
  return { input, requests, writes, sourceEvidence };
}

for (const taskType of ["plain", "import", "scene"]) {
  test(`${taskType}: a missing required picture stops narration before saving or TTS`, async () => {
    const f = fixture(taskType, [{ kind: "missing_required_content", message: "The required family portrait is missing; only labels are visible." }], true);
    const result = await generateSavedNarrationBatch(f.input);
    assert.equal(result.saved, false);
    assert.equal(f.writes.length, 0);
    assert.match(result.failures[0].error, /family portrait/);
    assert.equal(f.requests.length, 1, "No planning or speech call may disguise a missing visual");
  });

  test(`${taskType}: contradictory notes remain on disk but cannot supply narration facts`, async () => {
    const f = fixture(taskType, [{ kind: "notes_conflict", message: "The notes describe six people, but there are only word labels." }]);
    const result = await generateSavedNarrationBatch(f.input);
    assert.equal(result.saved, true, JSON.stringify(result.failures));
    const calls = f.requests.filter(request => request.data && typeof request.data === "object");
    assert.equal(calls[0].data.outline[0].notes, "");
    assert.equal(calls[1].data.evidence.notes, "");
    assert.match(result.diagnostics.map(item => item.message).join("\n"), /six people/);
    assert.equal(f.writes[0].actions.filter(action => action.type === "speech").length, 1);
    assert.equal(f.sourceEvidence.notes, "Six people are in this family photo.");
  });
}

test("invalid visual JSON gets one format repair without reclassifying a missing picture", async () => {
  const f = fixture("plain", [{ kind: "missing_required_content", message: "The required portrait is absent." }], true);
  const observe = f.input.completeVision;
  let attempts = 0;
  f.input.completeVision = async request => ++attempts === 1 ? { text: "invalid JSON" } : observe(request);
  const result = await generateSavedNarrationBatch(f.input);
  assert.equal(attempts, 2);
  assert.equal(f.writes.length, 0);
  assert.match(result.failures[0].error, /required portrait/);
});

test("vision cannot transfer a word label onto an empty native card", async () => {
  const f = fixture("plain");
  f.sourceEvidence.elements.push({ id: "card", kind: "shape", text: "", bbox: [0, 0, 300, 300] });
  const call = f.input.host.call;
  f.input.host.call = async (method, args) => {
    const result = await call(method, args);
    if (method === "courseware.project.context") result.mapping.pages[0].objects.push({ objectId: "card", importElementId: "card" });
    return result;
  };
  let observations = 0;
  f.input.completeVision = async request => {
    observations++;
    const data = JSON.parse(request.data);
    if (observations === 2) assert.match(data.repair.error, /native text.*card/u);
    return { text: JSON.stringify({ summary: "Word labels on a card", issues: [], objects: [
      { objectId: "label", role: "Word label", aliases: ["father mother"], text: "father mother", teachingTarget: true },
      { objectId: "card", role: "White card", aliases: [], text: observations === 1 ? "father mother" : "", teachingTarget: false },
    ] }) };
  };
  const result = await generateSavedNarrationBatch(f.input);
  assert.equal(observations, 2, "Cross-object OCR must use the bounded visual repair");
  assert.equal(result.saved, true, JSON.stringify(result.failures));
  assert.equal(f.writes.length, 1);
  assert.equal(f.sourceEvidence.elements[1].text, "");
});

test("text-only fallback reports that visual completeness was not verified", async () => {
  const f = fixture("import");
  delete f.input.completeVision;
  const result = await generateSavedNarrationBatch(f.input);
  assert.equal(result.saved, true);
  assert.match(result.diagnostics.map(item => item.message).join("\n"), /visual completeness has not been verified/);
});

for (const taskType of ["plain", "import", "scene"]) {
  for (const corrected of [true, false]) test(`${taskType}: ${corrected ? "corrects" : "bounds persistent failure of"} a backplate binding before any save`, async () => {
    const f = fixture(taskType);
    delete f.input.completeVision;
    f.sourceEvidence.elements = [
      { id: "card", kind: "shape", text: "", bbox: [0, 0, 300, 300] },
      { id: "father", kind: "text", text: "father", bbox: [20, 50, 70, 30] },
      { id: "mother", kind: "text", text: "mother", bbox: [120, 50, 70, 30] },
    ];
    const call = f.input.host.call;
    f.input.host.call = async (method, args) => {
      const result = await call(method, args);
      if (method === "courseware.project.context") result.mapping.pages[0].objects = f.sourceEvidence.elements.map(element => ({ objectId: element.id, importElementId: element.id }));
      return result;
    };
    const complete = f.input.complete;
    let attempts = 0;
    f.input.complete = async request => {
      const data = JSON.parse(request.messages[0].content);
      if (data.outline) return complete(request);
      attempts++;
      assert.equal(f.writes.length, 0);
      if (attempts === 2) assert.match(data.repair.error, /card.*container/u);
      return { text: JSON.stringify({ blocks: [{ type: "speech", text: "Read father and mother.", attention: {
        type: "highlight", objectIds: attempts === 1 || !corrected ? ["card", "father", "mother"] : ["father", "mother"], animation: "fadeIn",
      } }] }) };
    };
    const result = await generateSavedNarrationBatch(f.input);
    assert.equal(result.saved, corrected, JSON.stringify(result.failures));
    assert.equal(attempts, corrected ? 2 : 3);
    assert.equal(f.writes.length, corrected ? 1 : 0);
    if (corrected) assert.deepEqual(f.writes[0].actions[0].attention.objectIds, ["father", "mother"]);
    else assert.match(result.failures[0].error, /card.*container/u);
    assert.match(result.diagnostics.map(item => item.message).join("\n"), /Repairing invalid narration/);
  });
}

test("vision checks a card against all native labels even when it marked the labels as non-targets", async () => {
  const f = fixture("plain");
  f.sourceEvidence.elements.push(
    { id: "card", kind: "shape", text: "", bbox: [0, 0, 300, 300] },
    { id: "extra", kind: "text", text: "Read the words", bbox: [10, 110, 200, 50] },
  );
  const call = f.input.host.call;
  f.input.host.call = async (method, args) => {
    const result = await call(method, args);
    if (method === "courseware.project.context") result.mapping.pages[0].objects.push(
      { objectId: "card", importElementId: "card" }, { objectId: "extra", importElementId: "extra" },
    );
    return result;
  };
  let attempts = 0;
  f.input.completeVision = async request => {
    attempts++;
    if (attempts === 2) assert.match(JSON.parse(request.data).repair.error, /card.*empty container/u);
    return { text: JSON.stringify({ summary: "Labels on a white card", issues: [], objects: [
      { objectId: "label", role: "Word label", aliases: ["father mother"], text: "father mother", teachingTarget: attempts === 2 },
      { objectId: "extra", role: "Reading instruction", aliases: [], text: "Read the words", teachingTarget: false },
      { objectId: "card", role: "White card", aliases: ["father mother"], text: "", teachingTarget: attempts === 1 },
    ] }) };
  };
  const result = await generateSavedNarrationBatch(f.input);
  assert.equal(attempts, 2);
  assert.equal(result.saved, true, JSON.stringify(result.failures));
  assert.equal(f.writes.length, 1);
  assert.ok(f.writes[0].actions.every(action => !action.attention?.objectIds.includes("card")));
  assert.deepEqual(f.requests.find(request => request.data?.evidence)?.data.evidence.objects.map(object => object.objectId), ["label"]);
});

test("page delivery briefs repair only the invalid page and preserve successful narration", async () => {
  const f = fixture("plain", [], false, 3);
  delete f.input.completeVision;
  f.input.selected = [1, 2];
  const originalHost = f.input.host.call;
  f.input.host.call = async (method, args) => {
    const result = await originalHost(method, args);
    if (method === "courseware.project.context") {
      result.assessmentPageIds = ["page-3"];
      result.teachingRequirements[2].teaching = {
        ...result.teachingRequirements[2].teaching, pageType: "quiz", objective: "Choose the father portrait",
      };
    }
    return result;
  };
  const pageCalls = [];
  const brief = pageNumber => ({ pageNumber, purpose: "Model family expressions", bridge: "Continue to the Quiz", focus: "father mother",
    mustMention: [pageNumber === 1 ? "father" : "mother"], avoidRepeating: pageNumber === 1 ? [] : ["Opening greeting"],
    deliveryContract: ["Model the expression, then give a short guided learner turn"] });
  f.input.complete = async request => {
    const data = JSON.parse(request.messages[0].content);
    if (data.outline) {
      assert.deepEqual(data.outline.map(page => page.pageNumber), [1, 2]);
      assert.equal(data.outline[1].teaching.objective, "Read family word labels");
      assert.equal(data.assessments[0].pageNumber, 3);
      return { text: JSON.stringify({ goal: "Prepare for family identification", pages: [brief(1), brief(2)] }) };
    }
    const number = data.coursePlan.page.pageNumber;
    pageCalls.push(number);
    assert.deepEqual(data.coursePlan.page.deliveryContract, brief(number).deliveryContract);
    assert.match(request.system, /total classroom activity budget/);
    if (number === 2 && !data.repair) return { text: JSON.stringify({ blocks: [{ type: "speech", text: "Father means 爸爸。" }] }) };
    if (number === 2) assert.match(data.repair.error, /mother/);
    return { text: JSON.stringify({ blocks: [{ type: "speech", text: number === 1 ? "Father means 爸爸。" : "Mother means 妈妈。" }] }) };
  };
  const result = await generateSavedNarrationBatch(f.input);
  assert.equal(result.saved, true, JSON.stringify(result));
  assert.deepEqual(result.savedPages.map(page => page.pageNumber), [1, 2]);
  assert.equal(pageCalls.filter(n => n === 1).length, 1);
  assert.equal(pageCalls.filter(n => n === 2).length, 2);
  assert.deepEqual(f.writes.map(write => write.pageId).sort(), ["page", "page-2"]);
  assert.match(result.diagnostics.map(item => item.message).join("\n"), /mother/);
  assert.equal(result.audioReady, false);
});

test("pacing concerns are advisory and do not force new speech or fill the classroom budget", async () => {
  const f = fixture("plain");
  f.input.project.educationContext = { schoolStage: "KINDERGARTEN", subject: "ENGLISH" };
  const complete = f.input.complete;
  f.input.complete = async request => {
    const data = JSON.parse(request.messages[0].content);
    if (data.outline) return complete(request);
    return { text: JSON.stringify({ blocks: Array.from({ length: 5 }, (_, index) => [
      { type: "speech", text: `请看第${index + 1}张词卡，听老师示范。` }, { type: "wait", durationMs: 8000 },
    ]).flat() }) };
  };
  const result = await generateSavedNarrationBatch(f.input);
  assert.equal(result.saved, true, JSON.stringify(result.failures));
  assert.equal(f.writes.length, 1);
  assert.equal(f.writes[0].actions.length, 5);
  assert.equal(result.diagnostics.filter(d => /pacing review/.test(d.message)).length, 2);
  assert.match(result.diagnostics.map(d => d.message).join("\n"), /40s.*30s/);
});

test("malformed new brief fields get bounded plan repair without saving partial plans", async () => {
  const f = fixture("plain");
  const complete = f.input.complete;
  let attempts = 0;
  f.input.complete = async request => {
    const data = JSON.parse(request.messages[0].content);
    if (!data.outline) return complete(request);
    if (++attempts === 2) assert.match(data.repair.error, /mustMention/);
    return { text: JSON.stringify({ goal: "Teach family", pages: [{ pageNumber: 1, purpose: "Model", bridge: "Continue", focus: "father", mustMention: "father" }] }) };
  };
  await assert.rejects(generateSavedNarrationBatch(f.input), /mustMention/);
  assert.equal(attempts, 2);
  assert.equal(f.writes.length, 0);
});

test("a partial-page retry reuses the validated course arc and keeps successful speech", async () => {
  const f = fixture("plain", [], false, 2);
  delete f.input.completeVision;
  f.input.cache = new Map(); f.input.selected = [1, 2];
  let planning = 0, failSecond = true;
  f.input.complete = async request => {
    const data = JSON.parse(request.messages[0].content);
    if (data.outline) {
      assert.equal(++planning, 1, "Do not ask the model to recreate a valid arc on a failed-page retry");
      assert.equal(data.schema.type, "object");
      return { text: JSON.stringify({ goal: "Teach family", pages: [1, 2].map(pageNumber => ({
        pageNumber, purpose: "Model", bridge: "Continue", focus: "father mother",
      })) }) };
    }
    if (data.coursePlan.page.pageNumber === 2 && failSecond) return { text: "invalid" };
    return { text: JSON.stringify({ blocks: [{ type: "speech", text: "Father means 爸爸. Mother means 妈妈." }] }) };
  };
  const partial = await generateSavedNarrationBatch(f.input);
  assert.deepEqual(partial.savedPages.map(page => page.pageNumber), [1]);
  assert.equal(partial.failures[0].pageNumber, 2);
  const saved = await f.input.host.call("courseware.project.context", {});
  const successful = structuredClone(saved.project.pages[0].actions);
  f.input.project = saved.project; f.input.selected = [2]; failSecond = false;
  const completed = await generateSavedNarrationBatch(f.input);
  assert.equal(completed.saved, true, JSON.stringify(completed.failures));
  assert.equal(planning, 1);
  assert.deepEqual(f.writes.map(write => write.pageId), ["page", "page-2"]);
  const latest = await f.input.host.call("courseware.project.context", {});
  assert.deepEqual(latest.project.pages[0].actions, successful);
});

test("plan validation identifies unexpected fields instead of claiming required fields are absent", async () => {
  const f = fixture("plain"), complete = f.input.complete;
  let planning = 0, repairError;
  f.input.complete = async request => {
    const data = JSON.parse(request.messages[0].content);
    if (!data.outline) return complete(request);
    if (++planning === 2) repairError = data.repair.error;
    return { text: JSON.stringify({ goal: "Teach", pages: [{ pageNumber: 1, purpose: "Model", bridge: "Continue", focus: "father", durationSeconds: 30 }] }) };
  };
  await assert.rejects(generateSavedNarrationBatch(f.input), /durationSeconds/);
  assert.match(repairError, /durationSeconds/);
  assert.equal(planning, 2); assert.equal(f.writes.length, 0);
});

test("selected-page planning keeps the actual neighboring pages as context", async () => {
  const f = fixture("plain", [], false, 3);
  delete f.input.completeVision;
  f.input.selected = [1, 3];
  const generated = [];
  f.input.complete = async request => {
    const data = JSON.parse(request.messages[0].content);
    if (data.outline) {
      assert.deepEqual(data.outline.map(page => page.pageNumber), [1, 2, 3]);
      assert.deepEqual(data.requestedPageNumbers, [1, 3]);
      return { text: JSON.stringify({ goal: "Teach family", pages: [1, 3].map(pageNumber => ({
        pageNumber, purpose: "Model", bridge: "Continue", focus: "father mother",
      })) }) };
    }
    generated.push(data.coursePlan);
    return { text: JSON.stringify({ blocks: [{ type: "speech", text: "Father means 爸爸. Mother means 妈妈." }] }) };
  };
  const result = await generateSavedNarrationBatch(f.input);
  assert.equal(result.saved, true, JSON.stringify(result.failures));
  assert.equal(generated.find(plan => plan.page.pageNumber === 1).next.pageNumber, 2);
  assert.equal(generated.find(plan => plan.page.pageNumber === 3).previous.pageNumber, 2);
  assert.deepEqual(f.writes.map(write => write.pageId).sort(), ["page", "page-3"]);
});

test("readable peer pages cannot trigger planning when the selected page has no evidence", async () => {
  const f = fixture("plain", [], false, 2), call = f.input.host.call;
  delete f.input.completeVision;
  f.input.host.call = async (method, args) => {
    if (method === "courseware.pageEvidence" && args.pageNumber === 1) throw new Error("Selected page evidence unavailable");
    return call(method, args);
  };
  f.input.complete = async () => assert.fail("No selected readable page: do not call the model");
  const result = await generateSavedNarrationBatch(f.input);
  assert.equal(result.saved, false);
  assert.equal(f.writes.length, 0);
  assert.match(result.failures[0].error, /Selected page evidence unavailable/);
});
