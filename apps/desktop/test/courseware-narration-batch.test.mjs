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

test('native batch grounds image UUIDs, plans peer-page bridges once, and writes every selected page', async () => {
  const { generateNativeNarration } = load('./courseware-native-narration');
  let project = { schemaVersion: shared.COURSEWARE_CONTRACT_VERSION, projectId: 'native', taskType: 'plain', title: 'Family',
    source: { revision: 'r1', sha256: 'a'.repeat(64) }, teachingRevision: 'r1',
    pages: [1, 2].map(n => ({ pageId: 'p' + n, locked: false, reviewState: 'review', actions: [] })) };
  const calls = [], writes = [];
  const evidence = n => ({ width: 1280, height: 720, notes: '', objects: [{ objectId: 'portrait' + n, kind: 'image', text: '', bbox: [10, 10, 100, 100] }] });
  const png = Buffer.alloc(24); png.writeUInt32BE(0x89504e47); png.writeUInt32BE(1280, 16); png.writeUInt32BE(720, 20);
  const teaching = { native: async (operation, args, n) => {
    if (operation === 'narration-visual') return { value: { dataUrl: 'data:image/png;base64,' + png.toString('base64') } };
    if (operation === 'write') {
      assert.equal(args.expectedTeachingRevision, project.teachingRevision);
      assert.equal(args.semantics[0].objectId, 'portrait' + n);
      writes.push(n); project.pages[n - 1].actions = args.actions;
      project.teachingRevision = 'r' + (writes.length + 1); project.source.revision = project.teachingRevision;
      return { value: { project: structuredClone(project) } };
    }
    assert.equal(operation, 'narration-context');
    return { value: { view: { pageNumber: n, pageId: 'p' + n, viewId: 'native.p' + n, project: structuredClone(project) }, editor: { projectId: 'native', documentId: 'deck', sessionId: 'chat', editGeneration: writes.length + 1, readOnly: false }, text: '', evidence: evidence(n) } };
  } };
  const result = await generateNativeNarration({ teaching, sessionId: 'chat', selected: [1, 2], instruction: 'Explain each portrait', model: { modelKey: 'fixture' }, canDispatch: () => true, assertModel: async () => {},
    completeVision: async request => { const data = JSON.parse(request.data); calls.push('vision'); return { text: JSON.stringify({ summary: 'Father portrait', issues: [], objects: data.objects.map(o => ({ objectId: o.objectId, role: 'father portrait', aliases: ['father'], text: '', teachingTarget: true })) }) }; },
    complete: async request => {
      const data = JSON.parse(request.messages[0].content);
      if (data.outline) { calls.push('plan'); assert.equal(data.outline.length, 2); return { text: JSON.stringify({ goal: 'Family', pages: [1, 2].map(n => ({ pageNumber: n, purpose: 'Name father', focus: 'father', bridge: n === 1 ? 'Next portrait' : 'Recap' })) }) }; }
      calls.push('speech'); assert.match(data.evidence.objects[0].objectId, /^portrait/);
      return { text: JSON.stringify({ blocks: [{ type: 'speech', text: 'Look at father.', attention: { type: 'spotlight', objectIds: [data.evidence.objects[0].objectId] } }, { type: 'speech', text: 'Say father.' }] }) };
    } });
  assert.deepEqual(result.failures, []); assert.equal(result.applied, true);
  assert.equal(calls.filter(c => c === 'plan').length, 1); assert.equal(writes.length, 2);
  assert(project.pages.every(p => p.actions.filter(a => a.type === 'speech').length === 2));
});



function nativeRecoveryFixture(pageCount = 1) {
  const { generateNativeNarration } = load('./courseware-native-narration');
  let project = { schemaVersion: shared.COURSEWARE_CONTRACT_VERSION, projectId: 'native', taskType: 'plain', title: 'Words',
    source: { revision: 'r1', sha256: 'a'.repeat(64) }, teachingRevision: 'r1',
    pages: Array.from({ length: pageCount }, (_, i) => ({ pageId: 'p' + (i + 1), locked: false, reviewState: 'review', actions: [] })) };
  const state = { generation: 1, documentId: 'deck', readOnly: false, words: Array(pageCount).fill('father'), pixels: Array(pageCount).fill(0), mutate: undefined };
  const writes = [], visions = [], plans = [];
  const teaching = { native: async (operation, args, n) => {
    if (operation === 'narration-visual') {
      const png = Buffer.alloc(25); png.writeUInt32BE(0x89504e47); png.writeUInt32BE(1280, 16); png.writeUInt32BE(720, 20); png[24] = state.pixels[n - 1];
      return { value: { dataUrl: 'data:image/png;base64,' + png.toString('base64') } };
    }
    if (operation === 'write') {
      assert.equal(args.expectedTeachingRevision, project.teachingRevision);
      writes.push({ pageNumber: n, actions: structuredClone(args.actions) });
      project.pages[n - 1].actions = args.actions; project.teachingRevision = 'r' + (writes.length + 1); project.source.revision = project.teachingRevision;
      state.generation++; state.afterWrite?.(n, project);
      return { value: { project: structuredClone(project) } };
    }
    assert.equal(operation, 'narration-context');
    return { value: { view: { pageNumber: n, pageId: 'p' + n, viewId: 'native.p' + n, project: structuredClone(project) },
      editor: { projectId: 'native', documentId: state.documentId, sessionId: 'chat', editGeneration: state.generation, readOnly: state.readOnly },
      text: state.words[n - 1], evidence: { width: 1280, height: 720, notes: '', objects: [{ objectId: 'word' + n, kind: 'text', text: state.words[n - 1], bbox: [0, 0, 100, 30] }] } } };
  } };
  const input = { teaching, sessionId: 'chat', selected: [1], instruction: 'Explain the current words', model: { modelKey: 'fixture' }, canDispatch: () => true, assertModel: async () => {},
    completeVision: async request => {
      const data = JSON.parse(request.data); visions.push(data.pageNumber);
      const output = { text: JSON.stringify({ summary: data.pageText, issues: [], objects: data.objects.map(o => ({ objectId: o.objectId, role: 'Word', aliases: [o.text], text: o.text, teachingTarget: true })) }) };
      state.mutate?.('vision', data.pageNumber); return output;
    },
    complete: async request => {
      const data = JSON.parse(request.messages[0].content);
      if (data.outline) { plans.push(data); return { text: JSON.stringify({ goal: 'Words', pages: data.requestedPageNumbers.map(pageNumber => ({ pageNumber, purpose: 'Read words', focus: 'Word', bridge: 'Continue' })) }) }; }
      const output = { text: JSON.stringify({ blocks: [{ type: 'speech', text: 'Read ' + data.evidence.objects.map(o => o.text).join(' ') + '.' }] }) };
      state.mutate?.('speech', data.pageNumber); return output;
    } };
  return { state, writes, visions, plans, input, run: () => generateNativeNarration(input) };
}

test('native narration rereads harmless selection generations without discarding valid output', async () => {
  const f = nativeRecoveryFixture(); f.state.mutate = () => { f.state.generation++; };
  const result = await f.run();
  assert.equal(result.saved, true, JSON.stringify(result.failures)); assert.equal(f.writes.length, 1); assert.equal(f.visions.length, 1);
});

for (const change of ['text', 'pixels']) test(`native narration regenerates from fresh ${change} after a real edit`, async () => {
  const f = nativeRecoveryFixture(); let changed = false;
  f.state.mutate = phase => { if (phase === 'vision' && !changed) { changed = true; f.state.generation++; if (change === 'text') f.state.words[0] = 'mother'; else f.state.pixels[0]++; } };
  const result = await f.run();
  assert.equal(result.saved, true, JSON.stringify(result.failures)); assert.equal(f.writes.length, 1); assert.equal(f.visions.length, 2);
  assert.match(f.writes[0].actions[0].text, change === 'text' ? /mother/ : /father/);
  assert(result.diagnostics.some(d => /re-read|reread|refresh/i.test(d.message)));
});

test('native single-page narration uses peer text for the outline without reobserving every slide', async () => {
  const f = nativeRecoveryFixture(10); f.input.selected = [8];
  const result = await f.run();
  assert.equal(result.saved, true); assert.deepEqual(f.visions, [8]); assert.equal(f.plans[0].outline.length, 10); assert.deepEqual(f.writes.map(w => w.pageNumber), [8]);
});

for (const change of ['readOnly', 'documentId']) test(`native narration never resumes across ${change} changes`, async () => {
  const f = nativeRecoveryFixture(); f.state.mutate = () => { f.state[change] = change === 'readOnly' ? true : 'different-document'; f.state.generation++; };
  try { const result = await f.run(); assert.equal(result.saved, false); } catch (error) { assert.match(String(error), /owner|read.only|document/i); }
  assert.equal(f.writes.length, 0); assert.equal(f.visions.length, 1);
});

test('native narration bounds rereads when slide content keeps changing', async () => {
  const f = nativeRecoveryFixture(); f.state.mutate = () => { f.state.generation++; f.state.pixels[0]++; };
  const result = await f.run();
  assert.equal(result.saved, false); assert.equal(f.writes.length, 0); assert(f.visions.length >= 2 && f.visions.length <= 3);
  assert(result.failures.some(f => /chang|unstable/i.test(f.error)));
});

test('native narration keeps acknowledged pages when a later page needs fresh content', async () => {
  const f = nativeRecoveryFixture(2); f.input.selected = [1, 2];
  f.state.afterWrite = n => { if (n === 1) { f.state.words[1] = 'mother'; f.state.generation++; } };
  const result = await f.run();
  assert.equal(result.saved, true, JSON.stringify(result.failures)); assert.deepEqual(f.writes.map(w => w.pageNumber), [1, 2]);
  assert.match(f.writes[1].actions[0].text, /mother/);
});

test('native narration does not repeat visual-content mismatches until live content changes', async () => {
  const f = nativeRecoveryFixture(); f.input.contentFailures = new Map();
  const vision = f.input.completeVision;
  f.input.completeVision = async request => {
    const output = JSON.parse((await vision(request)).text);
    output.issues = [{ kind: 'missing_required_content', message: 'Page 8 has word cards but its plan requires two questions.' }];
    return { text: JSON.stringify(output) };
  };
  const first = await f.run(); assert.equal(first.failures[0].code, 'COURSEWARE_PAGE_CONTENT_MISMATCH');
  assert.equal(f.visions.length, 1); assert.equal(f.plans.length, 0);
  f.input.instruction = 'Please try different wording';
  const second = await f.run(); assert.equal(second.saved, false); assert.equal(f.visions.length, 1);
  assert(second.diagnostics.some(d => /SVG-only edits/.test(d.message)));
  f.state.words[0] = 'two questions'; f.state.generation++;
  f.input.completeVision = vision;
  const third = await f.run(); assert.equal(third.saved, true); assert.equal(f.visions.length, 2); assert.equal(f.writes.length, 1);
});

test('native narration refreshes a selection conflict at the atomic write without recalling the model', async () => {
  const f = nativeRecoveryFixture(); const native = f.input.teaching.native; let attempts = 0;
  f.input.teaching.native = async (op, args, n) => {
    if (op === 'write' && ++attempts === 1) { f.state.generation++; throw new Error('Native editor generation changed before narration write'); }
    return native(op, args, n);
  };
  const result = await f.run();
  assert.equal(result.saved, true); assert.equal(attempts, 2); assert.equal(f.visions.length, 1); assert.equal(f.writes.length, 1);
});

test('native narration rereads an acknowledged-lost write without replaying it', async () => {
  const f = nativeRecoveryFixture(); const native = f.input.teaching.native;
  f.input.teaching.native = async (op, args, n) => {
    const result = await native(op, args, n);
    if (op === 'write') throw new Error('Reply lost after successful native write');
    return result;
  };
  const result = await f.run();
  assert.equal(result.saved, true); assert.equal(f.writes.length, 1); assert.equal(f.visions.length, 1);
});

test('native narration never overwrites teaching edited while the model was running', async () => {
  const f = nativeRecoveryFixture(); const native = f.input.teaching.native; let edited = false;
  f.state.mutate = phase => { if (phase === 'vision' && !edited) { edited = true; void native('write', { expectedTeachingRevision: 'r1', actions: [{ id: 'manual', type: 'speech', text: 'My own wording' }] }, 1); } };
  const result = await f.run();
  assert.equal(result.saved, false); assert.equal(f.writes.length, 1); assert.equal(f.writes[0].actions[0].text, 'My own wording'); assert.equal(f.visions.length, 1);
});
