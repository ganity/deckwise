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
  const code = ts.transpileModule(readFileSync(file, "utf8"), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true } }).outputText;
  new Function("require", "exports", code)(load, exports);
  if (name === "./courseware-narration-batch") {
    const generate = exports.generateSavedNarrationBatch;
    exports.generateSavedNarrationBatch = input => {
      const wrap = complete => async request => {
        const data = JSON.parse(request.data ?? request.messages[0].content);
        const reviewFixture = input.reviewFixture ?? input.complete.reviewFixture;
        if (data.reviewKind === "narration_semantics") return reviewFixture
          ? reviewFixture(request, data) : { text: JSON.stringify({ issues: [] }) };
        return complete(request);
      };
      return generate({ ...input, complete: wrap(input.complete),
        ...(input.completeVision ? { completeVision: wrap(input.completeVision) } : {}) });
    };
  }
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

test("adopted PPT Master narrates the saved page when a draft-only subject is reported missing", async () => {
  const f = fixture("plain", [{ kind: "missing_required_content", message: "The draft requested another subject." }], true);
  f.input.frozenArtwork = true;
  const result = await generateSavedNarrationBatch(f.input);
  assert.equal(result.saved, true, JSON.stringify(result.failures));
  assert.equal(f.writes.length, 1);
  assert.match(f.requests[0].system, /page artwork has been accepted/);
});

for (const taskType of ["plain", "import", "scene"]) {
  test(`${taskType}: harmless visual differences keep narration and truthful object names`, async () => {
    const f = fixture(taskType, [{ kind: "visual_variation", message: "The kite is diamond-shaped rather than swallow-shaped; flying a kite is still teachable." }]);
    f.input.instruction = "Say I am flying the kite";
    const host = f.input.host.call;
    f.input.host.call = async (...args) => {
      const result = await host(...args);
      if (args[0] === "courseware.project.context") Object.assign(result.teachingRequirements[0].teaching,
        { objective: "Say I am flying the kite", requiredObjects: ["燕形风筝", "公园长椅"] });
      return result;
    };
    const result = await generateSavedNarrationBatch(f.input);
    assert.equal(result.saved, true, JSON.stringify(result.failures));
    assert.match(result.diagnostics.map(d => d.message).join("\n"), /diamond-shaped/);
    assert.match(f.requests[0].system, taskType === "scene" ? /artwork has been accepted/ : /shape.*color.*position/i);
    const observation = JSON.parse(f.requests[0].data);
    assert.equal(observation.teaching.objective, taskType === "import" ? "" : "Say I am flying the kite");
    assert.equal(observation.instruction, "Say I am flying the kite");
  });

  test(`${taskType}: a source-content finding blocks only a page without a frozen master`, async () => {
    const f = fixture(taskType, [{ kind: "missing_required_content", message: "The required family portrait is missing; only labels are visible." }], true);
    const result = await generateSavedNarrationBatch(f.input);
    if (taskType === "scene") {
      assert.equal(result.saved, true, JSON.stringify(result.failures));
      assert.equal(f.writes.length, 1);
      return;
    }
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

for (const [objective, requirement, message] of [
  ['Recognize a circle', 'circle', 'The required circle is absent; the picture shows a triangle.'],
  ['Count exactly three apples', '三个苹果', 'The counting task requires three apples but only two are visible.'],
]) test(`visual tolerance preserves essential content checks: ${objective}`, async () => {
  const f = fixture('plain', [{ kind: 'missing_required_content', message }], true);
  const host = f.input.host.call;
  f.input.host.call = async (...args) => {
    const result = await host(...args);
    if (args[0] === 'courseware.project.context') Object.assign(result.teachingRequirements[0].teaching,
      { objective, requiredObjects: [requirement] });
    return result;
  };
  const result = await generateSavedNarrationBatch(f.input);
  assert.equal(result.saved, false);
  assert.equal(f.writes.length, 0);
  assert(result.failures.some(f => f.error.includes(message)));
});

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

test("visual repair identifies an omitted issues field instead of silently accepting it", async () => {
  const f = fixture("scene");
  const observe = f.input.completeVision;
  let calls = 0;
  f.input.completeVision = async request => {
    calls++;
    const answer = await observe(request);
    if (calls === 1) { const raw = JSON.parse(answer.text); delete raw.issues; return { text: JSON.stringify(raw) }; }
    assert.match(JSON.parse(request.data).repair.error, /required fields.*issues.*received fields summary, objects/);
    return answer;
  };
  const result = await generateSavedNarrationBatch(f.input);
  assert.equal(calls, 2);
  assert.equal(result.saved, true, JSON.stringify(result.failures));
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
    assert.equal(data.repair, undefined);
    return { text: JSON.stringify({ summary: "Word labels on a card", issues: [], objects: [
      { objectId: "label", role: "Word label", aliases: ["father mother"], text: "father mother", teachingTarget: true },
      { objectId: "card", role: "White card", aliases: [], text: observations === 1 ? "father mother" : "", teachingTarget: false },
    ] }) };
  };
  const result = await generateSavedNarrationBatch(f.input);
  assert.equal(observations, 1, "Native text is authoritative without another paid observation");
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
  test(`${taskType}: resolves a backplate to the named text before semantic review and save`, async () => {
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
      return { text: JSON.stringify({ blocks: [{ type: "speech", text: "Read father and mother.", attention: {
        type: "highlight", objectIds: ["card", "father", "mother"], animation: "fadeIn",
      } }] }) };
    };
    const result = await generateSavedNarrationBatch(f.input);
    assert.equal(result.saved, true, JSON.stringify(result.failures));
    assert.equal(attempts, 1);
    assert.equal(f.writes.length, 1);
    assert.deepEqual(f.writes[0].actions[0].attention.objectIds, ["father", "mother"]);
    assert.equal(f.writes[0].actions[0].text, "Read father and mother.");
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

test("malformed brief fields get bounded page repair and a terminal page failure", async () => {
  const f = fixture("plain");
  const complete = f.input.complete;
  let attempts = 0;
  f.input.complete = async request => {
    const data = JSON.parse(request.messages[0].content);
    if (!data.outline) return complete(request);
    if (++attempts === 2) assert.match(data.repair.error, /mustMention/);
    return { text: JSON.stringify({ goal: "Teach family", pages: [{ pageNumber: 1, purpose: "Model", bridge: "Continue", focus: "father", mustMention: "father" }] }) };
  };
  const result = await generateSavedNarrationBatch(f.input);
  assert.match(result.failures[0].error, /mustMention/);
  assert.equal(result.failures[0].code, "COURSEWARE_NARRATION_PLAN_INVALID");
  assert.equal(result.failures[0].retriable, false);
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
  const result = await generateSavedNarrationBatch(f.input);
  assert.match(result.failures[0].error, /durationSeconds/);
  assert.equal(result.failures[0].code, "COURSEWARE_NARRATION_PLAN_INVALID");
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



function nativeRecoveryFixture(pageCount = 1, taskType = "plain") {
  const { generateNativeNarration } = load('./courseware-native-narration');
  let project = { schemaVersion: shared.COURSEWARE_CONTRACT_VERSION, projectId: 'native', taskType, title: 'Words',
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

for (const taskType of ["plain", "import", "scene"]) {
  test(`${taskType}: lesson-plan language is advisory and preserves generated words without another model call`, async () => {
    const f = fixture(taskType);
    const complete = f.input.complete;
    const text = "教师应该引导学生观察 father。设计意图是认识 family。";
    let speechCalls = 0;
    f.input.complete = async request => {
      if (JSON.parse(request.messages[0].content).outline) return complete(request);
      speechCalls++;
      return { text: JSON.stringify({ blocks: [{ type: "speech", text }] }) };
    };
    const result = await generateSavedNarrationBatch(f.input);
    assert.equal(result.saved, true, JSON.stringify(result));
    assert.equal(speechCalls, 1);
    assert.equal(f.writes[0].actions.find(a => a.type === "speech").text, text);
    assert.match(result.diagnostics.map(d => d.message).join("\n"), /Narration language review/);
  });
}

test("native generated narration receives the same advisory language review", async () => {
  const f = nativeRecoveryFixture();
  const complete = f.input.complete;
  const text = "教师应该引导学生观察 father。";
  f.input.complete = async request => JSON.parse(request.messages[0].content).outline ? complete(request) :
    { text: JSON.stringify({ blocks: [{ type: "speech", text }] }) };
  const result = await f.run();
  assert.equal(result.failures.length, 0, JSON.stringify(result));
  assert.equal(f.writes[0].actions.find(a => a.type === "speech").text, text);
  assert.match(result.diagnostics.map(d => d.message).join("\n"), /Narration language review/);
});

test("repair keeps existing speech and audio without applying generated-language review", async () => {
  const f = fixture("plain");
  const speech = { id: "original", type: "speech", text: "教师应该引导学生观察 father。", audioAssetId: "tts-" + "b".repeat(64) };
  f.input.project.pages[0].actions.push(speech);
  f.input.repairRequiredTeaching = true;
  f.input.complete = async () => assert.fail("existing speech must not be regenerated");
  const result = await generateSavedNarrationBatch(f.input);
  assert.equal(result.saved, true, JSON.stringify(result));
  assert.deepEqual(f.writes[0].actions.find(a => a.id === "original"), speech);
  assert.equal(result.diagnostics.some(d => /Narration language review/.test(d.message)), false);
});

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
  assert.equal(result.saved, true); assert.deepEqual(f.visions, [8]); assert.equal(f.plans[0].outline.length, 5); assert.deepEqual(f.writes.map(w => w.pageNumber), [8]);
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
  let stored = { revision: 0, failures: {} }; f.input.turnId = 'turn';
  f.input.retryStore = { read: async () => structuredClone(stored),
    writeNarration: async (_session, _project, previous, narration) => {
      assert.equal(previous.revision, stored.revision);
      stored = { ...stored, revision: stored.revision + 1, narration: structuredClone(narration) };
      return structuredClone(stored);
    } };
  const vision = f.input.completeVision;
  f.input.completeVision = async request => {
    const output = JSON.parse((await vision(request)).text);
    output.issues = [{ kind: 'missing_required_content', message: 'Page 8 has word cards but its plan requires two questions.' }];
    return { text: JSON.stringify(output) };
  };
  const first = await f.run(); assert.equal(first.failures[0].code, 'COURSEWARE_PAGE_CONTENT_MISMATCH');
  assert.equal(f.visions.length, 1); assert.equal(f.plans.length, 0);
  f.input.instruction = 'Please try different wording';
  f.input.contentFailures.clear(); f.input.retryState = new Map(); f.state.documentId = 'reopened';
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


test('native import with mapped separate activities repairs unrequested body questions before saving', async () => {
  const f = nativeRecoveryFixture(1, 'import'), native = f.input.teaching.native, complete = f.input.complete;
  f.input.teaching.native = async (...args) => {
    const result = await native(...args);
    if (result?.value?.view) result.value.view.enrichment = { plan: { units: [{ id: 'quiz', kind: 'quiz', pageIds: [] }] } };
    return result;
  };
  let speechCalls = 0;
  f.input.complete = async request => {
    const data = JSON.parse(request.messages[0].content);
    if (data.outline) return complete(request);
    if (++speechCalls === 1) return { text: JSON.stringify({ blocks: [
      { type: 'speech', text: 'Read father.' },
      { type: 'interaction', question: 'Who is father?', referenceAnswer: { summary: 'Father', keyPoints: ['Father'] } },
    ] }) };
    assert.match(data.repair.error, /separate assessment pages/);
    return complete(request);
  };
  const result = await f.run();
  assert.equal(result.saved, true, JSON.stringify(result.failures));
  assert.equal(speechCalls, 2);
  assert.deepEqual(f.writes[0].actions.map(a => a.type), ['speech']);
});

test('native narration grounds parent groups but excludes decorative text wrappers as targets', async () => {
  const f = nativeRecoveryFixture(), native = f.input.teaching.native, vision = f.input.completeVision;
  f.input.teaching.native = async (...args) => {
    const result = await native(...args);
    if (args[0] === 'narration-context') result.value.evidence.objects.push({ objectId: 'group', kind: 'group', text: '', bbox: [0, 0, 300, 200] });
    return result;
  };
  f.input.completeVision = async request => {
    assert.deepEqual(JSON.parse(request.data).objects.map(o => o.objectId), ['word1', 'group']);
    const result = await vision(request), observed = JSON.parse(result.text);
    Object.assign(observed.objects.find(o => o.objectId === 'group'), { role: 'Decorative text wrapper', aliases: ['frame'], teachingTarget: false });
    return { text: JSON.stringify(observed) };
  };
  const result = await f.run();
  assert.equal(result.saved, true, JSON.stringify(result.failures));
  assert.equal(f.writes[0].actions[0].text, 'Read father.');
});

test('native effect repair keeps saved durations local to each page when speech IDs repeat', async () => {
  const f = nativeRecoveryFixture(2);
  for (const n of [1, 2]) {
    const current = await f.input.teaching.native('narration-context', {}, n);
    await f.input.teaching.native('write', { expectedTeachingRevision: current.value.view.project.teachingRevision,
      actions: [{ id: 'repeated-speech', type: 'speech', text: 'Read father.', audioAssetId: 'tts-' + String(n).repeat(64), durationMs: n * 1200 }] }, n);
  }
  f.writes.length = 0; f.input.selected = [1, 2]; f.input.repairRequiredTeaching = true;
  const complete = f.input.complete;
  f.input.complete = async request => {
    const data = JSON.parse(request.messages[0].content);
    if (data.outline) return complete(request);
    assert.equal(data.speeches[0].id, 'repeated-speech');
    return { text: JSON.stringify({ focuses: [{ speechId: 'repeated-speech', type: 'highlight', objectIds: [data.objects[0].objectId] }] }) };
  };
  const reviewed = [];
  f.input.complete.reviewFixture = async (request, data) => {
    assert.match(request.system, /Timing is validated programmatically/);
    assert.deepEqual(data.savedAudioDurationsMs, { 'repeated-speech': data.pageNumber * 1200 });
    assert.equal(data.blocks[0].audioAssetId, 'tts-' + String(data.pageNumber).repeat(64));
    reviewed.push(data.pageNumber);
    return { text: '{"issues":[]}' };
  };
  const result = await f.run();
  assert.deepEqual(reviewed.sort(), [1, 2]);
  assert.equal(result.saved, true, JSON.stringify(result.failures));
  assert.deepEqual(f.writes.map(w => [w.pageNumber, w.actions[0].visualCues[0].endMs]), [[1, 1200], [2, 2400]]);
});

test('56 native pages run in small persisted batches with bounded neighboring summaries', async () => {
  const f = nativeRecoveryFixture(56), complete = f.input.complete;
  f.input.selected = Array.from({ length: 56 }, (_, i) => i + 1);
  let persisted = 0;
  f.input.persist = async () => { persisted = f.writes.length; };
  f.input.completeVision = async request => {
    const d = JSON.parse(request.data);
    assert(d.pageNumber <= persisted + 5, 'must persist the batch before observing the next');
    f.visions.push(d.pageNumber);
    return { text: JSON.stringify({ summary: 'father', issues: [], objects: d.objects.map(o => ({ ...o, role: 'label', aliases: ['father'], teachingTarget: true })).map(({objectId,role,aliases,text,teachingTarget})=>({objectId,role,aliases,text,teachingTarget})) }) };
  };
  f.input.complete = async request => {
    const d = JSON.parse(request.messages[0].content);
    if (d.outline) {
      assert(d.requestedPageNumbers.length <= 5);
      assert(d.outline.length <= 9, 'no full-deck relay payload');
      for (const p of d.outline.filter(p => !d.requestedPageNumbers.includes(p.pageNumber))) {
        assert(p.text.length <= 400); assert(p.notes.length <= 400);
      }
    }
    return complete(request);
  };
  const result = await f.run();
  assert.equal(result.saved, true, JSON.stringify(result.failures));
  assert.equal(persisted, 56); assert.equal(f.plans.length, 12);
  assert.deepEqual(f.plans[1].outline.map(p => p.pageNumber), [4, 5, 6, 7, 8, 9, 10, 11, 12]);
  assert.equal(f.writes.length, 56);
});

test('a later batch failure preserves persisted peers and stops instead of replaying the deck', async () => {
  const f = nativeRecoveryFixture(8), complete = f.input.complete;
  f.input.selected = [1,2,3,4,5,6,7,8];
  const persisted = [];
  f.input.persist = async () => { persisted.push(f.writes.map(w=>w.pageNumber)); };
  f.input.complete = async request => {
    const d = JSON.parse(request.messages[0].content);
    if (d.outline && d.requestedPageNumbers.includes(6)) throw Error('relay unavailable');
    return complete(request);
  };
  const result = await f.run();
  assert.equal(result.saved, false);
  assert.deepEqual(result.savedPages.map(p=>p.pageNumber), [1,2,3,4,5]);
  assert.deepEqual(persisted, [[1,2,3,4,5]]);
  assert.deepEqual(result.failures.map(p=>p.pageNumber), [6,7,8]);
  assert.match(result.failures[0].error, /relay unavailable/);
  assert.deepEqual(f.visions, [1,2,3,4,5,6,7,8]);
});

test('nonadjacent native selections never expand a relay batch across the whole deck', async () => {
  const f = nativeRecoveryFixture(56);
  f.input.selected = [1,28,56];
  const result = await f.run();
  assert.equal(result.saved, true, JSON.stringify(result.failures));
  assert.deepEqual(f.plans.map(p=>p.requestedPageNumbers), [[1],[28],[56]]);
  assert(f.plans.every(p=>p.outline.length<=5));
  assert.deepEqual(f.visions, [1,28,56]);
});

test('native batches reread a new source hash after persisting and pass prior speech as summary', async () => {
  const f = nativeRecoveryFixture(6);
  f.input.selected = [1,2,3,4,5,6];
  let project;
  f.state.afterWrite = (_n,p) => { project = p; };
  let saves = 0;
  f.input.persist = async () => { saves++; project.source.sha256 = String(saves).repeat(64); };
  const result = await f.run();
  assert.equal(result.saved, true, JSON.stringify(result.failures));
  assert.equal(saves, 2);
  assert.equal(f.plans[1].outline.find(p=>p.pageNumber===5).previousNarration, 'Read father.');
  assert.equal(f.writes.length, 6);
});

test('a rejected batch save prevents subsequent generation and never reports it persisted', async () => {
  const f = nativeRecoveryFixture(6);
  f.input.selected = [1,2,3,4,5,6];
  f.input.persist = async () => { throw Error('disk save rejected'); };
  const result = await f.run();
  assert.equal(result.saved, false); assert.deepEqual(result.savedPages, []);
  assert.equal(result.failures.length, 6);
  assert.match(result.failures[0].error, /disk save rejected/);
  assert.deepEqual(f.visions, [1,2,3,4,5]);
});

test('native batches pin the original document across persistence boundaries', async () => {
  const f = nativeRecoveryFixture(6);
  f.input.selected = [1,2,3,4,5,6];
  f.input.persist = async () => { f.state.documentId = 'a-different-deck'; };
  const result = await f.run();
  assert.equal(result.saved, false);
  assert.deepEqual(result.savedPages.map(p=>p.pageNumber), [1,2,3,4,5]);
  assert.deepEqual(f.visions, [1,2,3,4,5]);
  assert.match(result.failures[0].error, /owner changed/);
});

test('native safety deadline resets per batch rather than timing out the entire lesson', async () => {
  const f = nativeRecoveryFixture(6), now = Date.now;
  let clock = now(); Date.now = () => clock;
  f.input.selected = [1,2,3,4,5,6];
  f.input.persist = async () => { clock += 15 * 60_000; };
  try {
    const result = await f.run();
    assert.equal(result.saved, true, JSON.stringify(result.failures));
    assert.equal(f.writes.length, 6);
  } finally { Date.now = now; }
});

test('native deadline failure retains acknowledged speech and reports timeout rather than cancellation', async () => {
  const f = nativeRecoveryFixture(3), now = Date.now;
  let clock = now(); Date.now = () => clock;
  f.input.selected = [1,2,3];
  f.state.afterWrite = () => { clock += 15 * 60_000; };
  let saves = 0; f.input.persist = async () => { saves++; };
  try {
    const result = await f.run();
    assert.equal(result.saved, false); assert.equal(saves, 1);
    assert.deepEqual(result.savedPages.map(p=>p.pageNumber), [1]);
    assert(result.failures.every(p=>/timed out/.test(p.error) && !/Chat turn cancelled/.test(p.error)));
  } finally { Date.now = now; }
});

test('native autosave updates only the package hash without repeating observations, planning or speech', async () => {
  const f=nativeRecoveryFixture(2);f.input.selected=[1,2];
  let project, changed=false, speechCalls=0;
  f.state.afterWrite=(_n,p)=>{project=p;};
  const native=f.input.teaching.native, complete=f.input.complete;
  f.input.teaching.native=async(op,args,n)=>{
    if(project&&!changed&&op==='narration-context'){project.source.sha256='b'.repeat(64);changed=true;}
    return native(op,args,n);
  };
  f.input.complete=async request=>{if(!JSON.parse(request.messages[0].content).outline)speechCalls++;return complete(request);};
  const result=await f.run();
  assert.equal(result.saved,true,JSON.stringify(result));
  assert.deepEqual(f.visions,[1,2]);assert.equal(f.plans.length,1);assert.equal(speechCalls,2);
  assert.equal(result.diagnostics.some(d=>/regenerate only/.test(d.message)),false);
});

test('one malformed page brief repairs only that page while keeping the valid peer briefs', async () => {
  const f=fixture('plain',[],false,3);delete f.input.completeVision;f.input.selected=[1,2,3];
  const scopes=[],speechPages=[];
  f.input.complete=async request=>{
    const d=JSON.parse(request.messages[0].content);
    if(d.outline){
      scopes.push(d.requestedPageNumbers);
      return {text:JSON.stringify({goal:'Read family words',pages:d.requestedPageNumbers.map(n=>({pageNumber:n,purpose:'Read',focus:'father',bridge:'Continue',mustMention:n===2?'father':['father']}))})};
    }
    speechPages.push(d.coursePlan.page.pageNumber);
    return {text:JSON.stringify({blocks:[{type:'speech',text:'Read father.'}]})};
  };
  const result=await generateSavedNarrationBatch(f.input);
  assert.deepEqual(scopes,[[1,2,3],[2]]);
  assert.deepEqual(speechPages.sort(),[1,3]);assert.deepEqual(result.savedPages.map(p=>p.pageNumber),[1,3]);
  assert.equal(result.failures.length,1);assert.equal(result.failures[0].pageNumber,2);
  assert.equal(result.failures[0].code,'COURSEWARE_NARRATION_PLAN_INVALID');assert.equal(result.failures[0].retriable,false);
});

test('native output retry budget survives changed tool instructions and stops repeated paid work', async () => {
  const f=nativeRecoveryFixture();f.input.retryState=new Map();let speechCalls=0;
  const complete=f.input.complete;
  f.input.complete=async request=>{
    if(JSON.parse(request.messages[0].content).outline)return complete(request);
    speechCalls++;return {text:JSON.stringify({blocks:[{type:'wait',durationMs:4000},{type:'speech',text:'Read father.'}]})};
  };
  const first=await f.run();assert.equal(first.saved,false);assert.equal(speechCalls,3);assert.equal(first.failures[0].retriable,false);
  f.input.instruction='Try a shorter instruction';
  const second=await f.run();assert.equal(second.saved,false);assert.equal(speechCalls,3);
  assert.equal(f.visions.length,1);assert.equal(f.plans.length,1);assert.equal(second.failures[0].code,'COURSEWARE_NARRATION_OUTPUT_INVALID');
  assert.equal(second.failures[0].retriable, false);
  f.input.retryState.clear();
  await f.run();assert.equal(speechCalls,6,'a new explicit user turn gets a fresh bounded budget');
});

test('a page-local failure does not prevent an independent nonadjacent page from starting', async () => {
  const f=nativeRecoveryFixture(3);f.input.selected=[1,3];const complete=f.input.complete;
  f.input.complete=async request=>{
    const d=JSON.parse(request.messages[0].content);
    if(d.outline||d.pageText!=='father')return complete(request);
    if(d.evidence.objects[0].objectId==='word1')return {text:JSON.stringify({blocks:[{type:'wait',durationMs:4000},{type:'speech',text:'Read father.'}]})};
    return complete(request);
  };
  const result=await f.run();
  assert.deepEqual(result.savedPages.map(p=>p.pageNumber),[3]);assert.deepEqual(result.failures.map(p=>p.pageNumber),[1]);
  assert.deepEqual(f.plans.map(p=>p.requestedPageNumbers),[[1],[3]]);
});

test('a package hash change cannot hide a real pixel edit even when generation stays unchanged', async () => {
  const f = nativeRecoveryFixture();
  const complete = f.input.complete;
  let edited = false;
  f.input.complete = async request => {
    const data = JSON.parse(request.messages[0].content);
    if (!data.outline && !edited) {
      edited = true;
      f.state.pixels[0]++;
    }
    return complete(request);
  };
  // Return a new package hash without inventing an editGeneration bump.
  const native = f.input.teaching.native;
  f.input.teaching.native = async (op, args, n) => {
    const result = await native(op, args, n);
    if (edited && op === 'narration-context') result.value.view.project.source.sha256 = 'b'.repeat(64);
    return result;
  };
  const result = await f.run();
  assert.equal(result.saved, true, JSON.stringify(result));
  assert.deepEqual(f.visions, [1, 1]);
  assert.match(result.diagnostics.map(d => d.message).join('\n'), /appearance changed/);
});

test('a corrected page brief reuses validated peers and keeps the original course goal', async () => {
  const f = fixture('plain', [], false, 3);
  delete f.input.completeVision; f.input.selected = [1, 2, 3];
  let plans = 0;
  f.input.complete = async request => {
    const data = JSON.parse(request.messages[0].content);
    if (data.outline) {
      plans++;
      if (plans === 2) {
        assert.deepEqual(data.requestedPageNumbers, [2]);
        assert.deepEqual(data.acceptedPlan.pages.map(p => p.pageNumber), [1, 3]);
        assert.equal(data.acceptedPlan.goal, 'Original goal');
      }
      return { text: JSON.stringify({ goal: plans === 1 ? 'Original goal' : 'Replacement goal', pages: data.requestedPageNumbers.map(pageNumber => ({
        pageNumber, purpose: 'Read', focus: 'father', bridge: 'Continue', mustMention: plans === 1 && pageNumber === 2 ? 'father' : ['father'],
      })) }) };
    }
    assert.equal(data.coursePlan.goal, 'Original goal');
    return { text: JSON.stringify({ blocks: [{ type: 'speech', text: 'Read father.' }] }) };
  };
  const result = await generateSavedNarrationBatch(f.input);
  assert.equal(result.saved, true, JSON.stringify(result));
  assert.equal(plans, 2); assert.equal(f.writes.length, 3);
});

test('effect binding repair cannot replace already generated speech or waits', async () => {
  const f = fixture('plain'); delete f.input.completeVision;
  const complete = f.input.complete;
  let calls = 0;
  f.input.complete = async request => {
    const data = JSON.parse(request.messages[0].content);
    if (data.outline) return complete(request);
    calls++;
    if (calls === 1) return { text: JSON.stringify({ blocks: [
      { type: 'speech', text: 'Read father and mother.', attention: { type: 'highlight', objectIds: ['unknown'] } },
      { type: 'wait', durationMs: 4000 },
    ] }) };
    assert.equal(data.blocks[0].text, 'Read father and mother.');
    assert.deepEqual(data.blocks[1], { type: 'wait', durationMs: 4000 });
    if (calls === 2) return { text: JSON.stringify({ blocks: [{ type: 'speech', text: 'Replacement words.' }] }) };
    assert.match(data.repair.error, /speech cannot be rewritten/);
    const ref = data.evidence.objects.find(o => o.objectId === 'label').objectRef;
    assert.ok(data.schema.properties.focuses.items.properties.objectIds.anyOf[1].items.enum.includes(ref));
    return { text: JSON.stringify({ focuses: [{ blockIndex: 0, objectIds: [ref] }] }) };
  };
  const result = await generateSavedNarrationBatch(f.input);
  assert.equal(result.saved, true, JSON.stringify(result));
  assert.equal(calls, 3);
  assert.equal(f.writes[0].actions.map(a => a.text).join(''), 'Read father and mother.');
  assert.equal(f.writes[0].actions.at(-1).pauseAfterMs, 4000);
});

test('saving a successful peer does not renew an unchanged failed page retry budget', async () => {
  const f = nativeRecoveryFixture(2); f.input.selected = [1, 2]; f.input.retryState = new Map();
  const complete = f.input.complete;
  let failedCalls = 0;
  f.input.complete = async request => {
    const data = JSON.parse(request.messages[0].content);
    if (data.outline || data.evidence.objects[0].objectId !== 'word1') return complete(request);
    failedCalls++;
    return { text: JSON.stringify({ blocks: [{ type: 'wait', durationMs: 4000 }, { type: 'speech', text: 'Read father.' }] }) };
  };
  const first = await f.run();
  assert.deepEqual(first.savedPages.map(p => p.pageNumber), [2]); assert.equal(failedCalls, 3);
  const visions = f.visions.length, plans = f.plans.length;
  f.input.selected = [1];
  const second = await f.run();
  assert.equal(second.failures[0].code, 'COURSEWARE_NARRATION_OUTPUT_INVALID');
  assert.equal(second.failures[0].retriable, false);
  assert.equal(failedCalls, 3); assert.equal(f.visions.length, visions); assert.equal(f.plans.length, plans);
});

for (const taskType of ["plain", "import", "scene"]) test(`${taskType}: native body narration cannot turn an original slide into an assessment`, async () => {
  const f = nativeRecoveryFixture(1, taskType), complete = f.input.complete;
  f.input.complete = async request => {
    const data = JSON.parse(request.messages[0].content);
    if (data.outline) return complete(request);
    return { text: JSON.stringify({ blocks: [{ type: "speech", text: "Read father." },
      { type: "interaction", question: "What does father mean?", response: { kind: "short_answer", options: [], answerIndices: [] },
        referenceAnswer: { summary: "爸爸", keyPoints: ["爸爸"] } }] }) };
  };
  const result = await f.run();
  assert.equal(result.saved, false);
  assert.equal(f.writes.length, 0);
  assert.equal(result.failures[0].code, "COURSEWARE_NARRATION_OUTPUT_INVALID");
});

for (const taskType of ["plain", "import", "scene"]) test(`${taskType}: assessment-only narration reuses its question without rendering or generation`, async () => {
  const f = nativeRecoveryFixture(1, taskType);
  const native = f.input.teaching.native;
  f.input.teaching.native = async (...args) => {
    const result = await native(...args);
    if (args[0] === 'narration-context') {
      result.value.view.assessment = { nativeTeaching: true };
      result.value.view.project.pages[0].actions = [{ id: 'question', type: 'speech', text: 'Which word?' }];
    }
    return result;
  };
  const result = await f.run();
  assert.equal(result.saved, true); assert.deepEqual(result.failures, []);
  assert.equal(result.savedPages[0].retained, true);
  assert.equal(f.visions.length, 0); assert.equal(f.plans.length, 0); assert.equal(f.writes.length, 0);
});

test('content groups with internal lettering still reach grounding instead of leaving only a halo or label', async () => {
  const f = fixture('plain');
  const original = f.input.host.call;
  f.input.host.call = async (method, args) => {
    if (method === 'courseware.pageEvidence') return { ...f.sourceEvidence, elements: [
      ...f.sourceEvidence.elements,
      { id: 'circle', kind: 'group', name: 'p01-circle-shape', text: '', bbox: [300, 100, 200, 200] },
      { id: 'letter', kind: 'text', text: 'N', bbox: [350, 150, 30, 30] },
      { id: 'halo', kind: 'shape', name: 'p01-spotlight-halo', text: '', bbox: [250, 50, 300, 300] },
    ] };
    const result = await original(method, args);
    if (method === 'courseware.project.context') result.mapping.pages[0].objects.push(
      { objectId: 'circle-id', importElementId: 'circle' }, { objectId: 'letter-id', importElementId: 'letter' }, { objectId: 'halo-id', importElementId: 'halo' });
    return result;
  };
  f.input.completeVision = async request => {
    const data = JSON.parse(request.data);
    assert.equal(data.objects.find(o => o.objectId === 'circle-id')?.kind, 'group');
    assert.equal(data.objects.find(o => o.objectId === 'halo-id')?.name, 'p01-spotlight-halo');
    return { text: JSON.stringify({summary:'Circle and label', objects:data.objects.map(o=>({objectId:o.objectId,role:o.name || 'label',aliases:[o.name || 'father mother'],text:o.text,teachingTarget:['label', 'circle-id'].includes(o.objectId)})),issues:[]}) };
  };
  const complete = f.input.complete;
  f.input.complete = async request => {
    const data = JSON.parse(request.messages[0].content);
    if (data.evidence) {
      assert(data.evidence.objects.some(o => o.objectId === 'circle-id'));
      assert(!data.evidence.objects.some(o => o.objectId === 'halo-id'));
    }
    return complete(request);
  };
  const result = await generateSavedNarrationBatch(f.input);
  assert.equal(result.saved, true, JSON.stringify(result.failures));
});

test('a classroom prop issue without an explicit visual requirement does not block reading the existing task', async () => {
  const f = fixture('import', [{kind:'classroom_prop',message:'No physical word cards or placement frames on the slide.'}]);
  const result = await generateSavedNarrationBatch(f.input);
  assert.equal(result.saved,true,JSON.stringify(result.failures));
  assert(result.diagnostics.some(d=>/No physical word cards/.test(d.message)));
});

test("visual existence review receives object requirements, not effects that narration has yet to create", async () => {
  const f = fixture("scene");
  const hostCall = f.input.host.call;
  f.input.host.call = async (method, args) => {
    const result = await hostCall(method, args);
    if (method === "courseware.project.context") Object.assign(result.teachingRequirements[0].teaching, {
      ...result.teachingRequirements[0].teaching, requiredObjects: ["father mother"],
      objective: "Highlight father mother and fade in the label",
    });
    return result;
  };
  const vision = f.input.completeVision;
  f.input.completeVision = async request => {
    const data = JSON.parse(request.data);
    assert.deepEqual(data.teaching, { objective: "Highlight father mother and fade in the label", requiredObjects: ["father mother"] });
    assert.equal(data.approvedPage, undefined);
    assert.match(request.system, /artwork has been accepted/i);
    return vision(request);
  };
  const result = await generateSavedNarrationBatch(f.input);
  assert.equal(result.saved, true, JSON.stringify(result.failures));
});

test('objects-only repair updates visual semantics without any narration model call or action changes', async () => {
  const f = fixture('plain');
  const actions = [{ id: 'speech', type: 'speech', text: 'Father and mother.', audioAssetId: 'audio', durationMs: 1200,
    visualCues: [{ id: 'focus', atMs: 0, endMs: 1200, effect: { type: 'highlight', elementIds: ['label'] } }] }];
  f.input.project.pages[0].actions = structuredClone(actions);
  f.input.repairRequiredTeaching = true; f.input.repairObjectsOnly = true;
  f.input.complete = async () => assert.fail('Object repair must not call narration or planning');
  f.input.native = { context: await f.input.host.call('courseware.project.context'),
    evidence: async () => f.sourceEvidence,
    visuals: { page: async () => ({ images: [{ assetIds: ['p'], bytes: new Uint8Array([1]), width: 1280, height: 720, sha256: 'a'.repeat(64) }], imageBindings: [] }), dispose: async () => {} },
    save: async (expected, pageNumber, saved, semantics) => {
      assert.deepEqual(saved, actions); assert.equal(semantics[0].objectId, 'label');
      assert.deepEqual(semantics[0].aliases, ['father mother']);
      return (await f.input.host.call('courseware.narration.save', { write: { pageId: expected.pages[pageNumber - 1].pageId, actions: saved } })).project;
    } };
  f.input.native.context.teachingRequirements[0].teaching.requiredObjects = ['燕形风筝', '公园长椅'];
  const result = await generateSavedNarrationBatch(f.input);
  assert.equal(result.saved, true, JSON.stringify(result.failures));
  assert.match(result.diagnostics.map(d => d.message).join('\n'), /Object binding advisory/);
  assert.equal(f.writes.length, 1); assert.deepEqual(f.writes[0].actions, actions);
});

for (const taskType of ['scene', 'plain']) for (const metadata of [true, false]) test(`native Scene opened as ${taskType} uses pixel-bound metadata=${metadata} and retains independent semantic review`, async () => {
  const f = fixture(taskType);
  f.sourceEvidence.elements[0] = { id: 'text', kind: 'image', text: '', bbox: [0, 0, 200, 100],
    ...(metadata ? { layerMetadata: { name: 'father mother', description: 'Word labels only; the portrait is a separate layer' } } : {}) };
  f.input.frozenArtwork = true;
  f.input.native = { context: await f.input.host.call('courseware.project.context'),
    evidence: async () => structuredClone(f.sourceEvidence),
    visuals: { page: async () => ({ images: [{ assetIds: ['layer'], bytes: new Uint8Array([1]), width: 200, height: 100, sha256: 'a'.repeat(64) }],
      imageBindings: metadata ? [{ assetId: 'layer', importElementId: 'text' }] : [] }), dispose: async () => {} },
    save: async (expected, n, actions, semantics) => {
      if (metadata) {
        assert.equal(semantics[0].text, '', 'Supplier descriptions must not become exact OCR');
        assert.deepEqual(semantics[0].aliases, ['father mother']);
      }
      return (await f.input.host.call('courseware.narration.save', { write: { pageId: expected.pages[n - 1].pageId, actions } })).project;
    } };
  let reviewed = 0;
  f.input.reviewFixture = async (_request, data) => {
    reviewed++;
    if (metadata) assert.deepEqual(data.imageBindings, [{ assetId: 'layer', objectId: 'label' }]);
    return { text: JSON.stringify({ issues: [] }) };
  };
  const result = await generateSavedNarrationBatch(f.input);
  assert.equal(result.saved, true, JSON.stringify(result.failures));
  assert.ok(reviewed > 0);
  assert.equal(f.requests.filter(r => r.system?.startsWith('Identify teaching objects')).length, metadata ? 0 : 1);
});

test('supplier identities cannot bypass a failed independent semantic review', async () => {
  const f = fixture('scene');
  f.sourceEvidence.elements[0] = { id: 'text', kind: 'image', text: '', bbox: [0, 0, 200, 100],
    layerMetadata: { name: 'father mother', description: 'Supplier says these are the word labels' } };
  f.input.native = { context: await f.input.host.call('courseware.project.context'), evidence: async () => structuredClone(f.sourceEvidence),
    visuals: { page: async () => ({ images: [{ assetIds: ['layer'], bytes: new Uint8Array([1]), width: 200, height: 100, sha256: 'a'.repeat(64) }], imageBindings: [{ assetId: 'layer', importElementId: 'text' }] }), dispose: async () => {} },
    save: async () => assert.fail('A conflicting draft must not be saved') };
  f.input.reviewFixture = async () => ({ text: JSON.stringify({ issues: [{ blockIndex: 0, kind: 'content', message: 'The actual layer is inconsistent with this draft' }] }) });
  const result = await generateSavedNarrationBatch(f.input);
  assert.equal(result.saved, false);
  assert.equal(f.writes.length, 0);
  assert.ok(result.failures.length > 0);
});

test('one missing layer description cannot trigger rediscovery of known neighboring layers', async () => {
  const f = fixture('scene');
  f.sourceEvidence.elements[0] = { id: 'text', kind: 'image', text: '', bbox: [0, 0, 200, 100], layerMetadata: { name: 'father mother', description: 'Word labels' } };
  f.sourceEvidence.elements.push({ id: 'unknown', kind: 'image', text: '', bbox: [300, 0, 100, 100] });
  const context = await f.input.host.call('courseware.project.context');
  context.mapping.pages[0].objects.push({ objectId: 'unknown-object', importElementId: 'unknown' });
  f.input.native = { context, evidence: async () => structuredClone(f.sourceEvidence),
    visuals: { page: async () => ({ images: [{ assetIds: ['label-png'], bytes: new Uint8Array([1]), width: 200, height: 100, sha256: 'a'.repeat(64) }], imageBindings: [{ assetId: 'label-png', importElementId: 'text' }] }), dispose: async () => {} },
    save: async (expected, n, actions, semantics) => {
      assert.deepEqual(semantics.find(o => o.objectId === 'label').aliases, ['father mother']);
      return (await f.input.host.call('courseware.narration.save', { write: { pageId: expected.pages[n - 1].pageId, actions } })).project;
    } };
  let discoveries = 0;
  f.input.completeVision = async request => {
    const data = JSON.parse(request.data); discoveries++;
    assert.deepEqual(data.objects.map(o => o.objectId), ['unknown-object']);
    assert.equal(data.knownLayerObjects[0].name, 'father mother');
    assert(!('objectId' in data.knownLayerObjects[0])); assert.deepEqual(data.imageBindings, []);
    return { text: JSON.stringify({ summary: 'The other image is decoration', objects: [{ objectId: 'label', role: 'Wrong neighboring identity', aliases: ['wrong'], text: '', teachingTarget: true }, { objectId: 'unknown-object', role: 'Decoration', aliases: [], text: '', teachingTarget: false }], issues: [] }) };
  };
  assert.equal((await generateSavedNarrationBatch(f.input)).saved, true);
  assert.equal(discoveries, 1);
});

test('native object-only repair reports retained audio as ready without rewriting actions', async () => {
  const f = nativeRecoveryFixture();
  f.state.afterWrite = (n, project) => {
    for (const action of project.pages[n - 1].actions.filter(a => a.type === 'speech')) {
      action.audioAssetId = 'adopted'; action.durationMs = 1200;
    }
  };
  assert.equal((await f.run()).saved, true);
  const before = (await f.input.teaching.native('narration-context', {}, 1)).value.view.project.pages[0].actions;
  f.input.repairRequiredTeaching = true; f.input.repairObjectsOnly = true;
  f.input.complete = async () => assert.fail('Retained audio cannot require speech or planning generation');
  const result = await f.run();
  assert.equal(result.saved, true, JSON.stringify(result.failures));
  assert.equal(result.audioReady, true);
  assert.deepEqual(f.writes.at(-1).actions, before);
});

test('object-only repair can verify a counted content group without renaming its text label', async () => {
  const f = nativeRecoveryFixture(), native = f.input.teaching.native, vision = f.input.completeVision;
  f.input.repairObjectsOnly = true; f.input.repairRequiredTeaching = true;
  f.input.teaching.native = async (...args) => {
    const result = await native(...args);
    if (args[0] === 'narration-context') {
      result.value.evidence.objects.push({ objectId: 'column', kind: 'group', text: '', bbox: [0, 0, 300, 200] });
      result.value.view.teachingRequirements = [{ pageId: 'p1', teaching: { pageType: 'slide', phase: 'explore', objective: 'Observe a column', durationSeconds: 30, requiredObjects: ['一个状态列'] } }];
    }
    return result;
  };
  f.input.complete = async () => assert.fail('Group evidence repair cannot regenerate speech');
  f.input.completeVision = async request => {
    assert.deepEqual(JSON.parse(request.data).objects.map(o => o.objectId), ['word1', 'column']);
    const result = await vision(request), data = JSON.parse(result.text);
    data.objects.find(o => o.objectId === 'column').aliases = ['状态列'];
    return { text: JSON.stringify(data) };
  };
  const result = await f.run();
  assert.equal(result.saved, true, JSON.stringify(result.failures));
  assert.deepEqual(f.writes[0].actions, []);
});


for (const taskType of ["plain", "import", "scene"]) test(`${taskType}: semantic review repairs only a wrong binding and reviews it again before saving`, async () => {
  const f = fixture(taskType); delete f.input.completeVision;
  f.sourceEvidence.text = '熔化 → 吸热 冰';
  f.sourceEvidence.elements[0].text = '熔化 → 吸热';
  f.sourceEvidence.elements.push({ id: 'ice', kind: 'text', text: '冰', bbox: [210, 0, 100, 100] });
  const host = f.input.host.call;
  f.input.host.call = async (...args) => { const result = await host(...args); if (args[0] === 'courseware.project.context') result.mapping.pages[0].objects.push({ objectId: 'ice', importElementId: 'ice' }); return result; };
  const complete = f.input.complete;
  let generations = 0, reviews = 0;
  f.input.complete = async request => {
    const data = JSON.parse(request.messages[0].content);
    if (data.outline) return complete(request);
    generations++;
    if (data.blocks) {
      assert.equal(data.blocks[0].text, '冰化成水时，要从周围吸收热量。');
      return { text: JSON.stringify({ focuses: [{ blockIndex: 0, objectIds: ['label'] }] }) };
    }
    return { text: JSON.stringify({ blocks: [{ type: 'speech', text: '冰化成水时，要从周围吸收热量。', attention: { type: 'highlight', objectIds: ['ice'] } }] }) };
  };
  f.input.reviewFixture = async (_request, data) => {
    reviews++; assert.equal(f.writes.length, 0); assert.equal(data.pageText, f.sourceEvidence.text);
    assert.equal(data.blocks[0].text, '冰化成水时，要从周围吸收热量。');
    assert.deepEqual(data.blocks[0].attention.objectIds, [reviews === 1 ? 'ice' : 'label']);
    return { text: JSON.stringify({ issues: reviews === 1 ? [{ blockIndex: 0, kind: 'binding', message: 'Verify this melting relation rather than reading the arrow literally.', ...(taskType === 'scene' ? { objectIds: ['label'] } : {}) }] : [] }) };
  };
  const result = await generateSavedNarrationBatch(f.input);
  assert.equal(result.saved, true, JSON.stringify(result));
  assert.equal(generations, taskType === 'scene' ? 1 : 2); assert.equal(reviews, 2);
  assert.equal(f.writes[0].actions[0].text, '冰化成水时，要从周围吸收热量。');
});

for (const route of ['plain', 'scene', 'import']) test(route + ': an exact spoken correction rechecks the whole page without regenerating peer blocks', async () => {
  const f = fixture(route); delete f.input.completeVision;
  const complete = f.input.complete;
  let generations = 0, reviews = 0;
  f.input.complete = async request => {
    if (JSON.parse(request.messages[0].content).outline) return complete(request);
    generations++;
    return {text: JSON.stringify({blocks: [{type:'speech', text:'Observe the page.'}, {type:'speech', text:'Read mother.'}]})};
  };
  f.input.reviewFixture = async (_request, data) => {
    assert.equal(f.writes.length, 0);
    assert.deepEqual(data.blocks.map(b => b.text), ['Observe the page.', reviews ? 'Read father.' : 'Read mother.']);
    return {text: JSON.stringify({issues: reviews++ ? [] : [{blockIndex:1, kind:'content', message:'Use the visible word.', replacementText:'Read father.'}]})};
  };
  const result = await generateSavedNarrationBatch(f.input);
  assert.equal(result.saved, true, JSON.stringify(result.failures));
  assert.equal(generations, 1); assert.equal(reviews, 2);
  assert.deepEqual(f.writes[0].actions.map(a => a.text), ['Observe the page.', 'Read father.']);
});

test('a locally corrected speech is not saved when its second review is uncertain', async () => {
  const f = fixture('plain'); delete f.input.completeVision;
  let reviews = 0;
  f.input.reviewFixture = async (_request, data) => {
    if (++reviews === 1) return {text: JSON.stringify({issues: [{blockIndex: 0, kind: 'content', message: 'Correct this claim.', replacementText: 'Read father.'}]})};
    assert.equal(data.blocks[0].text, 'Read father.');
    return {text: JSON.stringify({issues: [{blockIndex: 0, kind: 'uncertain', message: 'The source is unclear.'}]})};
  };
  const result = await generateSavedNarrationBatch(f.input);
  assert.equal(result.failures[0].code, 'COURSEWARE_NARRATION_EVIDENCE_UNCERTAIN');
  assert.equal(reviews, 2); assert.equal(f.writes.length, 0);
});

test('semantic review repairs its own format without regenerating a valid narration draft', async () => {
  for (const invalid of ['invalid JSON', '{}', '```json\n{"issues":[]}\n```']) {
    const f = fixture('plain'); delete f.input.completeVision;
    const complete = f.input.complete; let generations = 0, reviews = 0;
    f.input.complete = async request => {
      if (!JSON.parse(request.messages[0].content).outline) generations++;
      return complete(request);
    };
    f.input.reviewFixture = async (_request, data) => {
      reviews++;
      if (reviews > 1) assert.match(data.repair.error, /review.*(JSON|issues)/);
      return { text: reviews === 1 ? invalid : JSON.stringify({ issues: [] }) };
    };
    const result = await generateSavedNarrationBatch(f.input);
    assert.equal(result.saved, true, JSON.stringify(result));
    assert.equal(generations, 1, 'A malformed reviewer verdict must not rewrite the draft');
    assert.equal(reviews, invalid.startsWith('```json') ? 1 : 2);
  }
});

test('semantic review remains bounded, and uncertain or malformed review never saves an unchecked draft', async () => {
  for (const kind of ['content', 'uncertain', 'malformed', 'invalid-json', 'provider-failure']) {
    const f = fixture('plain'); delete f.input.completeVision;
    let reviews = 0;
    f.input.reviewFixture = async () => { reviews++; if (kind === 'provider-failure') throw Error('Review transport failed'); return { text: kind === 'invalid-json' ? 'invalid JSON' : kind === 'malformed' ? '{}' : JSON.stringify({ issues: [{ blockIndex: 0, kind, message: 'Unsupported statement' }] }) }; };
    const result = await generateSavedNarrationBatch(f.input);
    assert.equal(result.saved, false, kind); assert.equal(f.writes.length, 0, kind);
    assert.equal(reviews, ['content', 'malformed', 'invalid-json'].includes(kind) ? 3 : 1, kind);
  }
});

test('semantic content repair uses review feedback and sends actual page images to the next review', async () => {
  const f = fixture('plain'), complete = f.input.complete;
  let generations = 0, reviews = 0;
  f.input.complete = async request => {
    const data = JSON.parse(request.messages[0].content);
    if (data.outline) return complete(request);
    generations++;
    if (generations > 1) assert.match(data.repair.error, /Unsupported family claim/);
    return { text: JSON.stringify({ blocks: [{ type: 'speech', text: generations === 1 ? 'Father means 妈妈.' : 'Father means 爸爸.' }] }) };
  };
  f.input.reviewFixture = async (request, data) => {
    assert(request.images.length > 0); assert(data.objects.length > 0); assert.equal(f.writes.length, 0);
    reviews++;
    return { text: JSON.stringify({ issues: reviews === 1 ? [{ blockIndex: 0, kind: 'content', message: 'Unsupported family claim; father means 爸爸.' }] : [] }) };
  };
  const result = await generateSavedNarrationBatch(f.input);
  assert.equal(result.saved, true, JSON.stringify(result)); assert.equal(reviews, 2);
  assert.equal(f.writes[0].actions[0].text, 'Father means 爸爸.');
});

test('a semantic failure retains a successful independent peer and never reviews an unknown UUID', async () => {
  const f = fixture('plain', [], false, 2); delete f.input.completeVision; f.input.selected = [1, 2];
  const complete = f.input.complete; let reviews = 0;
  f.input.complete = async request => {
    const data = JSON.parse(request.messages[0].content);
    if (data.outline) return { text: JSON.stringify({ goal: 'Words', pages: data.requestedPageNumbers.map(pageNumber => ({ pageNumber, purpose: 'Read labels', focus: 'father', bridge: 'Continue' })) }) };
    return complete(request);
  };
  f.input.reviewFixture = async (_request, data) => { reviews++; return { text: JSON.stringify({ issues: data.pageNumber === 1 ? [{ blockIndex: 0, kind: 'content', message: 'Wrong explanation' }] : [] }) }; };
  const result = await generateSavedNarrationBatch(f.input);
  assert.equal(result.saved, false); assert.deepEqual(result.savedPages.map(p => p.pageNumber), [2]);
  assert.equal(result.failures[0].pageNumber, 1); assert.equal(reviews, 4);
  const unknown = fixture('plain'); delete unknown.input.completeVision;
  const model = unknown.input.complete;
  unknown.input.complete = async request => JSON.parse(request.messages[0].content).outline ? model(request)
    : { text: JSON.stringify({ blocks: [{ type: 'speech', text: 'Father', attention: { type: 'highlight', objectIds: ['invented'] } }] }) };
  unknown.input.reviewFixture = async () => { throw Error('Unknown UUID reached semantic review'); };
  const rejected = await generateSavedNarrationBatch(unknown.input);
  assert.equal(rejected.saved, false); assert(!JSON.stringify(rejected).includes('Unknown UUID reached semantic review'));
});

test('semantic binding repair uses reviewed indices after a speech anchor splits the draft', async () => {
  const f = fixture('plain'); delete f.input.completeVision; const complete = f.input.complete;
  let reviews = 0;
  f.input.complete = async request => {
    const data = JSON.parse(request.messages[0].content);
    if (data.outline) return complete(request);
    if (data.blocks) {
      assert.equal(data.blocks.length, 2); assert.equal(data.blocks[1].text, 'Father means 爸爸.');
      return { text: JSON.stringify({ focuses: [{ blockIndex: 1, objectIds: ['label'] }] }) };
    }
    return { text: JSON.stringify({ blocks: [{ type: 'speech', text: 'Look. Father means 爸爸.',
      attention: { type: 'highlight', objectIds: ['label'], anchorText: 'Father means 爸爸.' } }] }) };
  };
  f.input.reviewFixture = async (_request, data) => {
    assert.equal(data.blocks.length, 2); reviews++;
    return { text: JSON.stringify({ issues: reviews === 1 ? [{ blockIndex: 1, kind: 'binding', message: 'Bind the explanation to its verified label' }] : [] }) };
  };
  const result = await generateSavedNarrationBatch(f.input);
  assert.equal(result.saved, true, JSON.stringify(result)); assert.equal(reviews, 2);
  assert.deepEqual(f.writes[0].actions.map(a => a.text), ['Look.', 'Father means 爸爸.']);
});

test('review format repair does not consume the two narration corrections', async () => {
  const f = fixture('plain'); delete f.input.completeVision;
  const complete = f.input.complete; let generations = 0, reviews = 0;
  f.input.complete = async request => {
    if (!JSON.parse(request.messages[0].content).outline) generations++;
    return complete(request);
  };
  f.input.reviewFixture = async () => ({ text: ++reviews === 1 ? '{}' : JSON.stringify({ issues: [{ blockIndex: 0, kind: 'content', message: 'Unsupported statement' }] }) });
  const result = await generateSavedNarrationBatch(f.input);
  assert.equal(result.saved, false); assert.equal(f.writes.length, 0);
  assert.equal(generations, 3); assert.equal(reviews, 4);
  assert.equal(result.failures[0].retriable, false);
});


for (const kind of ['malformed', 'uncertain']) test(`a ${kind} review on one native page does not block an independent page`, async () => {
  const f = nativeRecoveryFixture(3); f.input.selected = [1, 3];
  f.input.complete.reviewFixture = async (_request, data) => ({ text: data.pageNumber !== 1 ? '{"issues":[]}' : kind === 'malformed'
    ? '{}' : JSON.stringify({ issues: [{ blockIndex: 0, kind: 'uncertain', message: 'Current page evidence is insufficient' }] }) });
  const result = await f.run();
  assert.deepEqual(result.savedPages.map(page => page.pageNumber), [3]);
  assert.deepEqual(result.failures.map(page => page.pageNumber), [1]);
  assert.equal(result.failures[0].retriable, false);
});


test('neighbor OCR cannot overwrite native text or retain its wrong aliases', async () => {
  const f = fixture('plain');
  f.input.completeVision = async () => ({ text: JSON.stringify({ summary: 'Native labels', issues: [], objects: [
    { objectId: 'label', role: 'Wrong neighbor', aliases: ['wrong neighbor'], text: 'unrelated neighbor', teachingTarget: true },
  ] }) });
  const complete = f.input.complete;
  f.input.complete = async request => {
    const data = JSON.parse(request.messages[0].content);
    if (data.evidence) {
      assert.equal(data.evidence.objects[0].text, 'father mother');
      assert.deepEqual(data.evidence.objects[0].aliases, ['father mother']);
      assert.equal(data.evidence.objects[0].role, 'father mother');
    }
    return complete(request);
  };
  const result = await generateSavedNarrationBatch(f.input);
  assert.equal(result.saved, true, JSON.stringify(result.failures)); assert.equal(f.writes.length, 1);
});


for (const route of ['plain', 'scene', 'import']) test(route + ': malformed observations can recover a verified focus on existing speech', async () => {
  const f = nativeRecoveryFixture(2, route);
  f.state.words[0] = 'Evaporation';
  f.input.frozenArtwork = route === 'plain';
  f.input.repairRequiredTeaching = true;
  const speech = { id: 'phase-change', type: 'speech', text: 'Read Evaporation.', audioAssetId: 'tts-' + '1'.repeat(64), durationMs: 1800 };
  await f.input.teaching.native('write', {expectedTeachingRevision:'r1', actions:[speech]}, 1);
  f.writes.length = 0;
  const complete = f.input.complete;
  f.input.complete = async request => {
    const data = JSON.parse(request.messages[0].content);
    if (data.outline) return complete(request);
    return {text: JSON.stringify({focuses:[{speechId:speech.id, type:'highlight', objectIds:['word1']}]})};
  };
  const observations = f.input.completeVision;
  f.input.completeVision = async request => {
    const data = JSON.parse(request.data);
    if (data.repair) assert.match(data.repair.error, /issues\[0\]/);
    const verdict = JSON.parse((await observations(request)).text);
    verdict.issues = ['unstructured note'];
    return {text: JSON.stringify(verdict)};
  };
  const result = await f.run();
  assert.equal(result.saved, true, JSON.stringify(result.failures));
  assert.deepEqual(f.writes.map(p => p.pageNumber), [1]);
  assert.deepEqual(f.writes[0].actions[0], {...speech, visualCues: f.writes[0].actions[0].visualCues});
  assert.deepEqual(f.writes[0].actions[0].visualCues[0].effect.elementIds, ['word1']);
});

test('a verified missing-content finding still blocks import when a neighboring issue is malformed', async () => {
  const f = nativeRecoveryFixture(1, 'import');
  f.input.repairRequiredTeaching = true;
  await f.input.teaching.native('write', {expectedTeachingRevision: 'r1', actions: [{id: 'source', type: 'speech', text: 'Read the source.'}]}, 1);
  f.writes.length = 0;
  const observe = f.input.completeVision;
  f.input.completeVision = async request => {
    const verdict = JSON.parse((await observe(request)).text);
    verdict.issues = ['invalid note', {kind: 'missing_required_content', message: 'The source document is missing.'}];
    return {text: JSON.stringify(verdict)};
  };
  const result = await f.run();
  assert.match(result.failures[0].error, /Required visual content missing.*source document/);
  assert.equal(f.writes.length, 0);
});

for (const hasMappedText of [true, false]) test(`unreadable frozen observation uses available native text only (mapped text=${hasMappedText})`, async () => {
  const f = nativeRecoveryFixture();
  f.input.frozenArtwork = true;
  f.state.words[0] = 'Primary source';
  const native = f.input.teaching.native;
  f.input.teaching.native = async (op, args, n) => {
    const result = await native(op, args, n);
    if (op === 'narration-context') {
      const evidence = result.value.evidence;
      evidence.notes = 'An outdated plan mentions another portrait.';
      if (!hasMappedText) evidence.objects = [];
      evidence.objects.push({objectId: 'decoration', kind: 'shape', text: '', bbox: [0, 50, 80, 80]});
    }
    return result;
  };
  f.input.completeVision = async () => ({text:'malformed model reply'});
  const complete = f.input.complete;
  f.input.complete = async request => {
    const data = JSON.parse(request.messages[0].content);
    if (data.evidence) {
      assert.equal(data.evidence.notes, '');
      assert.deepEqual(data.evidence.objects.map(item => item.objectId), ['word1']);
    }
    return complete(request);
  };
  const result = await f.run();
  assert.equal(result.saved, hasMappedText, JSON.stringify(result.failures));
  if (hasMappedText) assert.match(f.writes[0].actions[0].text, /Primary source/);
  else {
    assert.equal(f.writes.length, 0);
    assert.match(result.failures[0].error, /no verified teaching target/);
  }
});

test('visual format exhaustion remains visual and never spends the narration budget', async () => {
  const f = nativeRecoveryFixture(); f.input.retryState = new Map(); let calls = 0;
  f.input.completeVision = async () => { calls++; return { text: 'invalid JSON' }; };
  const first = await f.run();
  assert.equal(first.failures[0].code, 'COURSEWARE_VISUAL_OUTPUT_INVALID');
  const again = await f.run();
  assert.equal(again.failures[0].code, 'COURSEWARE_VISUAL_OUTPUT_INVALID');
  assert.equal(calls, 2); assert.equal(f.writes.length, 0);
  assert.equal([...f.input.retryState.values()][0].attempts, 0);
});

test('an omitted visual layer stays unverified instead of aborting the narration batch', async () => {
  const f = fixture('scene');
  const original = f.input.host.call;
  let savedSemantics;
  f.input.host.call = async (method, args) => {
    if (method === 'courseware.pageEvidence') {
      return { ...f.sourceEvidence, elements: [...f.sourceEvidence.elements,
        { id: 'decor', kind: 'shape', name: 'background decoration', text: '', bbox: [300, 100, 80, 80] }] };
    }
    const result = await original(method, args);
    if (method === 'courseware.project.context') result.mapping.pages[0].objects.push({ objectId: 'decor-id', importElementId: 'decor' });
    if (method === 'courseware.narration.save') savedSemantics = args.semantics;
    return result;
  };
  f.input.completeVision = async request => {
    const data = JSON.parse(request.data);
    const label = data.objects.find(object => object.objectId === 'label');
    return { text: JSON.stringify({ summary: 'The page has one readable label.', objects: [{
      objectId: label.objectId, role: 'word label', aliases: ['father mother'], text: label.text, teachingTarget: true,
    }], issues: [] }) };
  };
  const result = await generateSavedNarrationBatch(f.input);
  assert.equal(result.saved, true, JSON.stringify(result.failures));
  assert.equal(savedSemantics.find(object => object.objectId === 'decor-id').teachingTarget, false);
  assert.match(result.diagnostics.map(item => item.message).join('\n'), /decor-id/);
});


test('failed retry reservation blocks speech generation without touching the document', async () => {
  const f = nativeRecoveryFixture(); f.input.turnId = 'turn'; let speech = 0;
  const complete = f.input.complete;
  f.input.complete = async request => {
    if (!JSON.parse(request.messages[0].content).outline) speech++;
    return complete(request);
  };
  f.input.retryStore = { read: async () => ({ revision: 0, failures: {} }),
    writeNarration: async () => { throw Error('retry storage unavailable'); } };
  const result = await f.run();
  assert.equal(speech, 0); assert.equal(f.writes.length, 0);
  assert(result.failures.some(f => f.error.includes('retry storage unavailable')));
  f.input.retryStore.read = async () => { throw Error('retry read unavailable'); };
  await assert.rejects(f.run(), /retry read unavailable/);
  assert.equal(speech, 0);
});


test('cancellation during a saved retry reservation cannot dispatch narration', async () => {
  const f = nativeRecoveryFixture(); f.input.turnId = 'turn'; let active = true, speech = 0;
  f.input.canDispatch = () => active;
  const complete = f.input.complete;
  f.input.complete = async request => {
    if (!JSON.parse(request.messages[0].content).outline) speech++;
    return complete(request);
  };
  f.input.retryStore = { read: async () => ({ revision: 0, failures: {} }),
    writeNarration: async (_session, _project, _previous, narration) => {
      active = false; return { revision: 1, failures: {}, narration };
    } };
  const result = await f.run();
  assert.equal(speech, 0); assert.equal(f.writes.length, 0); assert.equal(result.saved, false);
});

for (const visible of [true, false]) test(`a partial inventory cannot decide whole-page absence: visible=${visible}`, async () => {
  const f = fixture('plain');
  const call = f.input.host.call;
  f.sourceEvidence.elements = Array.from({length: 13}, (_, i) => ({id:`t${i}`, kind:'text', text:`label ${i}`, bbox:[i*20,0,18,12]}));
  f.input.host.call = async (method, args) => {
    const value = await call(method, args);
    if (method === 'courseware.project.context') value.mapping.pages[0].objects = f.sourceEvidence.elements.map(e => ({objectId:e.id, importElementId:e.id}));
    return value;
  };
  const chunks = [];
  f.input.completeVision = async req => {
    const data = JSON.parse(req.data);
    if (data.disputedFacts) return {text: JSON.stringify(visible ? {visible} : {visible,reason:'The unit is absent'})};
    chunks.push(data.objects.length);
    return {text:JSON.stringify({summary:'Numbered labels', issues: chunks.length === 1 ? [{kind:'missing_required_content',message:'The last label is outside the group'}] : [],objects:data.objects.map(o=>({objectId:o.objectId,role:'label',text:o.text,aliases:[o.text],teachingTarget:true}))})};
  };
  const result = await generateSavedNarrationBatch(f.input);
  assert.deepEqual(chunks,[12,1]); assert.equal(result.saved,visible, JSON.stringify(result.failures));
  if (!visible) assert.match(result.failures[0].error,/The unit is absent/);
});

test("an exhausted focus draft saves only independently checked speech on frozen native artwork", async () => {
  for (const wordsValid of [true,false]) {
    const f = nativeRecoveryFixture();
    f.input.frozenArtwork = true;
    const complete = f.input.complete;
    const words = "Listen to the word father.";
    f.input.complete = async request => {
      const data = JSON.parse(request.messages[0].content);
      if (data.outline) return complete(request);
      if (data.blocks) return {text: '{"focuses":[{"blockIndex":0,"objectIds":["invented"]}]}'};
      return {text: JSON.stringify({blocks:[{type:"speech",text:words,attention:{type:"spotlight",objectIds:["invented"]}}]})};
    };
    f.input.complete.reviewFixture = async (_req,data) => ({text:JSON.stringify({issues:wordsValid ? [] :
      [{kind:"content",blockIndex:0,message:"The spoken statement is unsupported."}]})});
    const result = await f.run();
    assert.equal(result.saved,wordsValid,JSON.stringify(result.failures));
    if (wordsValid) {
      assert.equal(f.writes[0].actions[0].text,words);
      assert.equal(f.writes[0].actions[0].attention,undefined);
    } else assert.equal(f.writes.length,0);
  }
});
