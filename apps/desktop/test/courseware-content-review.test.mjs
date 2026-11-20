import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import ts from "typescript";

const require = createRequire(import.meta.url);
const shared = await import('@pi-desktop/shared');
function load(id) {
  if (id === '@pi-desktop/shared') return shared;
  if (!id.startsWith("./")) return require(id);
  const exports = {};
  new Function("require", "exports", ts.transpileModule(readFileSync(new URL(`../electron/main/${id.slice(2)}.ts`, import.meta.url), "utf8"), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true },
  }).outputText)(load, exports);
  return exports;
}
const { CoursewareContentReview, ContentReviewTurns } = load("./courseware-content-review");

test('a finding survives a later pass until that page evidence changes', () => {
  let turn = 'turn-1';
  const turns = new ContentReviewTurns(() => turn);
  const issue = (pageId, message) => ({ pageId, pageNumber: pageId === 'body' ? 1 : 2, code: 'CONTENT_REVIEW_FAILED', message, repair: 'source', repairable: false });
  const result = issues => ({ ready: !issues.length, applied: false, issues, sourceSha256: 'a'.repeat(64), teachingRevision: 'T1' });
  const pages = [{ pageId: 'body', pageNumber: 1, fingerprint: 'body-v1' }, { pageId: 'quiz', pageNumber: 2, fingerprint: 'quiz-v1' }];
  turns.record('chat', 'p', result([issue('body', 'The title is missing.'), issue('quiz', 'The answer is inconsistent.')]), pages);
  const samePixels = turns.record('chat', 'p', result([issue('quiz', 'The answer is inconsistent.')]), pages);
  assert.deepEqual(samePixels.issues.map(item => item.message), ['The title is missing.', 'The answer is inconsistent.']);
  const correctedBody = turns.record('chat', 'p', result([]), [{ ...pages[0], fingerprint: 'body-v2' }, pages[1]]);
  assert.deepEqual(correctedBody.issues.map(item => item.message), ['The answer is inconsistent.']);
  assert.equal(correctedBody.ready, false);
  turn = 'turn-2';
  assert.equal(turns.status('chat', { project: { projectId: 'p', source: { sha256: 'a'.repeat(64) }, teachingRevision: 'T1', pages: [] } }).contentReview, undefined);
});

function fixture(checkSpeech) {
  const png = Buffer.alloc(24); png.writeUInt32BE(0x89504e47); png.writeUInt32BE(1280, 16); png.writeUInt32BE(720, 20);
  const actions = [{ id: "speech", type: "speech", text: "Area is length times width.", audioAssetId: "paid-audio", durationMs: 10000 }];
  const view = { project: { projectId: "p", taskType: "plain", source: { revision: "R1", sha256: "a".repeat(64) }, teachingRevision: "T1",
    pages: [{ pageId: "body", locked: false, actions }, { pageId: "quiz", locked: false, actions: [] }] },
    enrichment: { originalPages: [{ pageId: "body" }, { pageId: "quiz" }] } };
  let classroom = { scenes: [{ id: "body", content: { type: "slide" }, actions }, { id: "quiz", actions: [], content: { type: "quiz", questions: [{
    id: "question", type: "single", question: "6 cm by 2 cm: area?", answer: ["A"], options: [{ value: "A", label: "12 square cm" }, { value: "B", label: "8 square cm" }],
    analysis: "8 square cm omits the width.", referenceAnswer: "12 square cm" }] } }] };
  const state = { active: true, model: "model", writes: 0, expectedTitle: undefined, expectedReference: undefined, expectedRefresh: false, expectedHint: undefined, saveFails: false, requests: [], operations: [], answer: () => ({ issues: [], analysisCorrections: [] }) };
  const turns = new ContentReviewTurns(() => state.turn ?? 'first-turn');
  const reviewer = new CoursewareContentReview({
    checkSpeech,
    getTurnId: () => state.turn ?? 'first-turn',
    teaching: { async native(operation, _args, number) {
      state.operations.push(operation);
      if (operation === 'write') {
        assert.equal(_args.expectedTeachingRevision, view.project.teachingRevision);
        assert.equal(_args.viewId, 'p.body'); assert.equal(number, 1);
        view.project.pages[0].actions = structuredClone(_args.actions);
        view.project.teachingRevision = 'speech-repaired'; view.project.source.sha256 = 'f'.repeat(64);
        return { value: structuredClone(view) };
      }
      if (operation === "open") return { value: structuredClone(view) };
      if (operation === "narration-context") return { value: { view: { ...structuredClone(view), teaching: { pageType: number === 2 ? "quiz" : "slide" } }, text: number === 1 ? "Area = length × width" : "6 cm by 2 cm", evidence: { width: 254, height: 143, objects: state.layer ? [{ objectId: "layer", kind: "image", text: "", bbox: [0, 0, 200, 100], layerMetadata: { name: "Evaporation", description: "Upward arrows and label" } }] : [] } } };
      assert.equal(operation, "narration-visual"); return { value: { dataUrl: `data:image/png;base64,${png.toString("base64")}`, ...(state.layer ? { layers: [{ objectId: "layer", dataUrl: state.layer }] } : {}) } };
    } },
    classroom: { async open() { return { classroom: structuredClone(classroom), projectId: "p", revision: view.project.teachingRevision, sourceRevision: "R1" }; },
      async write(request) {
        assert.equal(request.expectedRevision, view.project.teachingRevision); assert.equal(request.expectedSourceRevision, "R1");
        const expected = structuredClone(classroom); if (state.expectedTitle) expected.scenes[1].title = state.expectedTitle;
        else if (state.expectedCheckpointSummary) expected.scenes[1].actions[0].referenceAnswer.summary = state.expectedCheckpointSummary;
        else if (state.expectedHint) expected.scenes[1].actions[0].constraintPrompt = state.expectedHint;
        else if (state.expectedReference) expected.scenes[1].content.questions[0].referenceAnswer = state.expectedReference;
        else if (state.expectedRefresh) assert.deepEqual(request.refreshPageIds, ["quiz"]);
        else {
          expected.scenes[1].content.questions[0].analysis = "8 comes from addition; area requires multiplication.";
          if (typeof expected.scenes[1].content.questions[0].explanation === "string") expected.scenes[1].content.questions[0].explanation = expected.scenes[1].content.questions[0].analysis;
        }
        assert.deepEqual(request.classroom, expected, "Only the requested generated field may change");
        classroom = structuredClone(request.classroom); state.writes++;
        for (const action of view.project.pages[1].actions) if (action.type === "interaction_checkpoint") {
          if (state.expectedCheckpointSummary) { if (!state.staleCarrier) action.referenceAnswer.summary = state.expectedCheckpointSummary; }
          else if (!state.expectedHint) action.referenceAnswer.summary = classroom.scenes[1].content.questions[0].referenceAnswer;
        }
        view.project.teachingRevision = "T2"; view.project.source.sha256 = "b".repeat(64);
      } },
    taskRoute: async () => state.hostRoute ?? view.project.taskType,
    save: async () => { if (state.saveFails) throw new Error('Save failed'); },
    resolveModel: async () => ({ modelKey: state.model }),
    complete: async request => {
      const data = JSON.parse(request.data);
      if (data.spoken) return { text: JSON.stringify({ contradictions: state.verify ? state.verify(data) :
        data.spoken.map(s => ({ id: s.id, quote: s.text, evidence: "The supplied unit contradicts the saved measurement." })) }) };
      state.requests.push(request);
      const result = await state.answer(data, request);
      return { text: typeof result === "string" ? result : JSON.stringify(result) };
    },
  }, turns);
  return { state, view, turns, run: (repairSpeech = false) => reviewer.run("chat", () => state.active, repairSpeech), classroom: () => classroom };
}

test('corrects one factual speech error only in an authorized course, preserving its paid peers', async () => {
  const f = fixture(), actions = f.view.project.pages[0].actions;
  const wrong = 'Both the scale and contour interval are 20 metres.', right = 'The contour interval is 20 metres.';
  actions[0].text = wrong;
  const peer = { id: 'peer', type: 'speech', text: 'The two maps use the same scale.', audioAssetId: 'keep', durationMs: 3000 };
  actions.push(peer);
  f.state.answer = data => data.page.actions.some(a => a.text === wrong) ? { issues: [], analysisCorrections: [], speechCorrection: { actionId: 'speech', originalText: wrong, text: right } } : { issues: [], analysisCorrections: [] };
  assert.equal((await f.run()).ready, false); assert.equal(actions[0].audioAssetId, 'paid-audio');
  const r = await f.run(true);
  assert.equal(r.applied, true); assert.equal(r.ready, true);
  assert.deepEqual(f.view.project.pages[0].actions, [{ id: 'speech', type: 'speech', text: right }, peer]);
  assert(f.state.requests.some(req => JSON.parse(req.data).page.actions.some(a => a.text === right)));
});

test('review after TTS reports a different speech finding without a second write or a second replacement', async () => {
  const f = fixture(), actions = f.view.project.pages[0].actions;
  actions.push({ ...actions[0], id: 'peer', text: 'Peer.', audioAssetId: 'peer-audio' });
  let target = 'speech';
  f.state.answer = d => {
    const a = d.page.actions.find(a => a.id === target);
    return a && a.text !== 'Corrected.' ? { issues: [], speechCorrection: {actionId:a.id,originalText:a.text,text:'Corrected.'} } : {issues: [],analysisCorrections: []};
  };
  assert.equal((await f.run(true)).ready, true);
  assert.equal(f.turns.status('chat',f.view).speechRepair.pendingAudio, 1);
  Object.assign(f.view.project.pages[0].actions[0],{audioAssetId:'new-tts',durationMs:4100});
  f.view.project.pages[0].actions[1].text = 'New statement.';
  f.view.project.teachingRevision='after-tts'; target='peer';
  assert.equal(f.turns.status('chat',f.view).contentReview, undefined);
  const r=await f.run(true); assert.equal(r.ready,false); assert.equal(r.applied,false);
  assert.deepEqual(f.turns.status('chat',f.view).speechRepair,{changedSpeech:2,replacedAudio:1,pendingAudio:0});
  assert.equal(f.turns.status('chat',f.view).contentReview.ready,false);
  assert.equal(f.view.project.pages[0].actions[1].text, 'New statement.');
  f.state.turn='next-turn'; assert.equal(f.turns.status('chat',f.view).speechRepair,undefined);
  assert.equal((await f.run(true)).applied,true);
});

test('an independent literal speech finding survives a visual pass; malformed evidence stays unresolved', async () => {
  for (const output of ['not json', JSON.stringify({issues:[{id:'speech',quote:'square metres long',reason:'Area is not a length.'}]})]) {
    const f = fixture(async request => {
      assert.equal(request.includeSessionContext,false);
      assert.match(request.messages[0].content,/square metres long/);
      return {text:output};
    });
    f.view.project.pages[0].actions[0].text = 'The field is 10 square metres long.';
    const review = await f.run(true);
    assert.equal(review.ready,false); assert.equal(review.applied,false);
    assert.equal(review.issues[0].code,output.startsWith('{') ? 'CONTENT_REVIEW_FAILED' : 'CONTENT_REVIEW_INVALID');
    if (output.startsWith('{')) {
      assert.equal(review.issues[0].actionId,'speech');
      assert.equal(review.issues[0].segmentNumber,1);
      assert(f.state.requests.some(req => JSON.parse(req.data).repair?.previousOutput.includes('square metres long')));
      assert.equal(review.issues[0].quote,'square metres long');
      assert.match(review.issues[0].message,/Area is not a length/);
    }
  }
});

test('a malformed speech finding is rechecked against the same saved words before blocking delivery', async () => {
  let attempts = 0;
  const f = fixture(async request => {
    const data = JSON.parse(request.messages[0].content);
    assert.equal(data.spoken[0].text, 'Area is length times width.');
    if (++attempts === 1) return {text: JSON.stringify({issues:[{id:'speech',quote:'invented words',reason:'Wrong unit.'}]})};
    assert.match(data.formatCorrection, /literal substring/);
    return {text: JSON.stringify({issues:[]})};
  });
  assert.equal((await f.run(true)).ready, true);
  assert.equal(attempts, 2);
  assert.equal(f.state.operations.includes('write'), false);
});

test('a prose-only finding can become a targeted edit, but an unsupported dismissal is not a pass', async () => {
  for (const hasCorrection of [true, false]) {
    const f = fixture(), originalText = f.view.project.pages[0].actions[0].text;
    f.state.answer = d => d.page.pageId !== 'body' || d.page.actions[0].text !== originalText ? { issues: [] } :
      !d.repair ? { issues: [{ actionId: 'speech', kind: 'content', message: 'The spoken unit conflicts with the saved page.' }] } :
      hasCorrection ? {issues: [], speechCorrection: {actionId: 'speech', originalText, text: 'The area is measured in square centimetres.'}} : {issues: []};
    const r = await f.run(true); assert.equal(r.applied, hasCorrection);
    assert.equal(r.issues.some(i => i.pageId === 'body'), !hasCorrection);
    if (!hasCorrection) {
      const finding = r.issues.find(i => i.pageId === 'body');
      assert.equal(finding.actionId, 'speech');
      assert.equal(finding.segmentNumber, 1);
      assert.equal(finding.quote, originalText);
      assert.equal(finding.message, 'The supplied unit contradicts the saved measurement.');
    }
  }
});

test('a correction cannot rewrite protected speech or target stale words', async () => {
  for (const mode of ['locked', 'preserve', 'import', 'stale']) {
    const f = fixture(), a = structuredClone(f.view.project.pages[0].actions[0]);
    if (mode === 'locked') f.view.project.pages[0].locked = true;
    if (mode === 'preserve') f.view.enrichment.script = {policy: 'preserve', silentPageIds: []};
    if (mode === 'import') f.state.hostRoute = 'import';
    f.state.answer = d => ({issues: [], analysisCorrections: [], ...(d.page.pageId === 'body' ? {speechCorrection: {
      actionId: a.id, originalText: mode === 'stale' ? 'old text' : a.text, text: 'Changed.'}} : {})});
    const r = await f.run(true); assert.equal(r.ready, false); assert.equal(r.applied, false);
    assert.deepEqual(f.view.project.pages[0].actions[0], a);
  }
});

test("final review checks real page images and corrects/rechecks only generated Quiz analysis", async () => {
  const f = fixture(), originalActions = structuredClone(f.view.project.pages.map(p => p.actions));
  f.state.answer = data => {
    assert.equal(data.lesson.length, data.page.pageId === "body" ? 1 : 2);
    if (data.questions[0]?.analysis.includes("omits")) return { issues: [], analysisCorrections: [{ questionId: "question", text: "8 comes from addition; area requires multiplication." }] };
    return { issues: [], analysisCorrections: [] };
  };
  const result = await f.run();
  assert.equal(result.ready, true); assert.equal(result.applied, true); assert.equal(f.state.writes, 1);
  assert.equal(f.state.requests.length, 3, "Both pages and the corrected analysis must be reviewed");
  assert(f.state.requests.every(request => request.images.length === 1));
  assert.deepEqual(f.view.project.pages.map(p => p.actions), originalActions);
  const again = await f.run(); assert.equal(again.ready, true); assert.equal(again.applied, false);
  assert.equal(f.state.requests.length, 3, "Unchanged saved bytes reuse the result");
  f.view.project.source.sha256 = "c".repeat(64); await f.run(); assert.equal(f.state.requests.length, 4);
});

test("final-review format repair retains the saved course before analysis correction", async () => {
  const f = fixture(); let quizReviews = 0;
  f.state.answer = data => {
    if (data.page.pageId !== "quiz") return { issues: [], analysisCorrections: [] };
    quizReviews++;
    if (quizReviews === 1) return "invalid JSON";
    if (quizReviews === 2) {
      assert.match(data.repair.error, /SyntaxError/);
      return { issues: [], analysisCorrections: [{ questionId: "question", text: "8 comes from addition; area requires multiplication." }] };
    }
    return { issues: [], analysisCorrections: [] };
  };
  assert.equal((await f.run()).ready, true); assert.equal(quizReviews, 3); assert.equal(f.state.writes, 1);
});

for (const kind of ["visual", "content", "uncertain"]) test(`import final review blocks ${kind} problems and continues independent pages`, async () => {
  const f = fixture();
  f.state.hostRoute = "import";
  f.state.answer = data => ({ issues: data.page.pageId === "body" ? [{ kind, message: "Essential count/unit/readability needs correction" }] : [], analysisCorrections: [] });
  const result = await f.run();
  assert.equal(result.ready, false); assert.equal(result.issues[0].pageNumber, 1);
  assert.equal(f.state.requests.length, 2); assert.equal(f.state.writes, 0);
});

for (const protectedPage of ["original-import", "locked", "read-only"]) test(`final review preserves ${protectedPage} analysis`, async () => {
  const f = fixture();
  if (protectedPage === "original-import") f.view.project.taskType = "import";
  if (protectedPage === "locked") f.view.project.pages[1].locked = true;
  if (protectedPage === "read-only") f.view.readOnly = true;
  f.state.answer = data => ({ issues: [], analysisCorrections: data.questions.length ? [{ questionId: "question", text: "8 comes from addition; area requires multiplication." }] : [] });
  assert.equal((await f.run()).ready, false); assert.equal(f.state.writes, 0);
});

for (const invalid of ["broken JSON", { issues: [], analysisCorrections: [{ questionId: "unknown", text: "invented" }] }]) test("final review rejects malformed or invented corrections within a bounded budget", async () => {
  const f = fixture(); f.state.answer = () => invalid;
  const result = await f.run(); assert.equal(result.ready, false); assert.equal(f.state.writes, 0);
  assert.equal(f.state.requests.length, 6); assert.equal(result.issues.length, 2);
  await f.run(); assert.equal(f.state.requests.length, 6, "Status rereads must not reset a failed review budget");
});

for (const change of ["source", "model", "cancel"]) test(`final review rejects ${change} changes during the model call`, async () => {
  const f = fixture(); f.state.answer = () => {
    if (change === "source") f.view.project.source.sha256 = "b".repeat(64);
    if (change === "model") f.state.model = "other";
    if (change === "cancel") f.state.active = false;
    return { issues: [], analysisCorrections: [] };
  };
  await assert.rejects(f.run(), /changed/); assert.equal(f.state.writes, 0);
});

test('final review aborts an in-flight completion promptly when the turn ends', async () => {
  const f = fixture();
  f.state.answer = (_data, request) => new Promise((_resolve, reject) => {
    f.state.active = false;
    request.signal.addEventListener('abort', () => reject(request.signal.reason), { once: true });
  });
  await assert.rejects(f.run(), /owner changed/); assert.equal(f.state.writes, 0);
});

test('an imported page without original-page metadata remains protected', async () => {
  const f = fixture(); f.view.project.taskType = 'import'; delete f.view.enrichment;
  f.state.answer = data => ({ issues: [], analysisCorrections: data.questions.length
    ? [{ questionId: 'question', text: '8 comes from addition; area requires multiplication.' }] : [] });
  assert.equal((await f.run()).ready, false); assert.equal(f.state.writes, 0);
});


test('generated Quiz title is corrected through the existing save and reviewed again without changing audio', async () => {
  const f = fixture(); f.view.project.taskType = 'import';
  f.view.enrichment.originalPages = [{ pageId: 'body' }];
  f.state.expectedTitle = '练习：计算面积';
  const original = structuredClone(f.view.project.pages);
  f.state.answer = data => ({ issues: [], analysisCorrections: [],
    titleCorrection: data.page.pageId === 'quiz' && !f.state.writes ? f.state.expectedTitle : undefined });
  const result = await f.run();
  assert.equal(result.ready, true); assert.equal(result.applied, true);
  assert.equal(f.state.writes, 1); assert.equal(f.classroom().scenes[1].title, f.state.expectedTitle);
  assert.deepEqual(f.view.project.pages, original);
  assert.equal(f.state.requests.length, 3);
});

for (const protection of ['original-import', 'locked', 'read-only']) test(`title correction preserves ${protection}`, async () => {
  const f = fixture(); f.state.expectedTitle = '练习';
  if (protection === 'original-import') f.view.project.taskType = 'import';
  if (protection === 'locked') f.view.project.pages[1].locked = true;
  if (protection === 'read-only') f.view.readOnly = true;
  f.state.answer = data => ({ issues: [], analysisCorrections: [], titleCorrection: data.page.pageId === 'quiz' ? '练习' : undefined });
  assert.equal((await f.run()).ready, false); assert.equal(f.state.writes, 0);
});

test('two invalid review responses do not prevent correcting and rechecking generated content', async () => {
  const f = fixture(); let reviews = 0;
  f.state.answer = data => {
    if (data.page.pageId !== 'quiz') return { issues: [], analysisCorrections: [] };
    if (++reviews <= 2) return '{}';
    return { issues: [], analysisCorrections: f.state.writes ? [] : [{ questionId: 'question', text: '8 comes from addition; area requires multiplication.' }] };
  };
  assert.equal((await f.run()).ready, true); assert.equal(f.state.writes, 1); assert.equal(reviews, 4);
});


test('an objective reference answer can be repaired without changing the question or grading key', async () => {
  const f = fixture(); f.state.expectedReference = '12 square cm';
  f.state.answer = data => ({ issues: [], analysisCorrections: [], referenceAnswerCorrections:
    data.questions.length && !f.state.writes ? [{ questionId: 'question', text: f.state.expectedReference }] : [] });
  assert.equal((await f.run()).ready, true); assert.equal(f.state.writes, 1);
  assert.deepEqual(f.classroom().scenes[1].content.questions[0].answer, ['A']);
});


test('a stale generated Quiz hint is refreshed and rechecked without changing question data', async () => {
  const f = fixture(); f.state.expectedRefresh = true;
  f.state.answer = data => ({ issues: [], analysisCorrections: [], refreshProjection: data.questions.length && !f.state.writes ? true : undefined });
  assert.equal((await f.run()).ready, true); assert.equal(f.state.writes, 1); assert.equal(f.state.requests.length, 3);
});


test('repairs legacy explanation content instead of rejecting the missing canonical analysis field', async () => {
  const f = fixture(), question = f.classroom().scenes[1].content.questions[0];
  question.explanation = question.analysis; delete question.analysis;
  f.state.answer = data => ({ issues: [], analysisCorrections: data.questions[0]?.explanation?.includes('omits')
    ? [{ questionId: 'question', text: '8 comes from addition; area requires multiplication.' }] : [] });
  assert.equal((await f.run()).ready, true); assert.equal(f.state.writes, 1);
  assert.equal(f.classroom().scenes[1].content.questions[0].analysis, f.classroom().scenes[1].content.questions[0].explanation);
});


test('review reads repaired checkpoint evidence before checking adjacent original content', async () => {
  const f = fixture(); f.state.expectedReference = '12 square cm';
  f.classroom().scenes[1].content.questions[0].referenceAnswer = '8 square cm';
  f.view.project.pages[1].actions = [{ id: 'checkpoint', type: 'interaction_checkpoint', referenceAnswer: { summary: '8 square cm', keyPoints: [] } }];
  f.state.answer = data => {
    if (data.page.pageId === 'quiz' && !f.state.writes) return { issues: [], analysisCorrections: [], referenceAnswerCorrections: [{ questionId: 'question', text: '12 square cm' }] };
    assert.equal(data.lesson.find(p => p.pageId === 'quiz').actions[0].referenceAnswer.summary, '12 square cm', 'Recheck and adjacent pages must see the saved checkpoint, not its pre-repair snapshot');
    return { issues: [], analysisCorrections: [] };
  };
  assert.equal((await f.run()).ready, true);
  assert.deepEqual(f.state.requests.map(r => JSON.parse(r.data).page.pageId), ['quiz', 'quiz', 'body']);
  assert.equal(f.state.writes, 1);
});

function checkpointFixture() {
  const f = fixture();
  f.classroom().scenes[1].content = { type: "slide", canvas: {} };
  const checkpoint = { id: "checkpoint", type: "interaction_checkpoint", checkpointKind: "chapter_summary",
    question: "Which process returns river water to the sea?", referenceAnswer: { summary: "Surface runoff", keyPoints: ["Surface runoff"] },
    constraintPrompt: "Return to page 2 and follow the arrows." };
  f.classroom().scenes[1].actions = [checkpoint];
  f.view.project.pages[1].actions = [structuredClone(checkpoint)];
  delete f.view.project.pages[1].actions[0].constraintPrompt;
  f.state.expectedHint = "Return to page 1 and follow the arrows.";
  f.state.answer = data => ({ issues: [], analysisCorrections: [], checkpointHintCorrections:
    data.page.pageId === "quiz" && !f.state.writes ? [{ actionId: "checkpoint", text: f.state.expectedHint }] : [] });
  return f;
}

for (const route of ["plain", "scene"]) test(`teacher-led oral review requires saved evidence for an unanswerable question (${route})`, async () => {
  const f = checkpointFixture();
  f.state.hostRoute = route;
  const question = f.classroom().scenes[1].actions[0].question;
  f.state.answer = (data, request) => {
    if (!data.checkpoints.length) return { issues: [] };
    assert.match(request.system, /teacher-led oral/i);
    assert.ok(data.lesson.some(p => p.pageId === "body"));
    return { issues: [{ kind: "content", actionId: "checkpoint", quote: question, message: "The requested diagram's arrows cannot be located." }] };
  };
  const result = await f.run();
  assert.equal(result.ready, false);
  assert.equal(result.issues[0].code, "CONTENT_REVIEW_FAILED");
  assert.equal(result.issues[0].repair, "assessment");
  assert.equal(f.state.writes, 0);
});

test('review repairs a generated checkpoint hint, preserves the question/answer/audio and rechecks saved content', async () => {
  const f = checkpointFixture();
  const before = structuredClone(f.classroom().scenes[1].actions[0]);
  const audio = structuredClone(f.view.project.pages[0].actions);
  const result = await f.run();
  assert.equal(result.ready, true); assert.equal(result.applied, true); assert.equal(f.state.writes, 1);
  assert.deepEqual(f.classroom().scenes[1].actions[0], { ...before, constraintPrompt: f.state.expectedHint });
  assert.deepEqual(f.view.project.pages[0].actions, audio);
  assert.equal(f.state.requests.length, 3);
  assert.equal(JSON.parse(f.state.requests[1].data).checkpoints[0].constraintPrompt, f.state.expectedHint);
});

for (const protection of ['original-import', 'locked', 'read-only']) test(`checkpoint hint repair preserves ${protection}`, async () => {
  const f = checkpointFixture();
  if (protection === 'original-import') f.view.project.taskType = 'import';
  if (protection === 'locked') f.view.project.pages[1].locked = true;
  if (protection === 'read-only') f.view.readOnly = true;
  assert.equal((await f.run()).ready, false); assert.equal(f.state.writes, 0);
});

for (const correction of [
  [{ actionId: "other", text: "Return to page 1." }],
  [{ actionId: "checkpoint", text: "" }],
  [{ actionId: "checkpoint", text: "Return to page 1.", referenceAnswer: "Wrong" }],
  [{ actionId: "checkpoint", text: "One" }, { actionId: "checkpoint", text: "Two" }],
]) test('checkpoint repair rejects unknown identities, empty hints, extra fields and duplicates', async () => {
  const f = checkpointFixture();
  f.state.answer = data => ({ issues: [], analysisCorrections: [], checkpointHintCorrections: data.page.pageId === 'quiz' ? correction : [] });
  const result = await f.run();
  assert.equal(result.ready, false); assert.equal(f.state.writes, 0);
  assert.equal(f.state.requests.length, 4);
});

test('checkpoint hints use the existing bounded content-repair budget and retain failure on reread', async () => {
  const f = checkpointFixture();
  f.state.answer = data => ({ issues: [], analysisCorrections: [], checkpointHintCorrections:
    data.page.pageId === 'quiz' ? [{ actionId: 'checkpoint', text: f.state.expectedHint }] : [] });
  assert.equal((await f.run()).ready, false); assert.equal(f.state.writes, 2);
  const calls = f.state.requests.length;
  assert.equal((await f.run()).ready, false); assert.equal(f.state.requests.length, calls);
});

test('checkpoint hints do not invent missing teacher guidance', async () => {
  const f = checkpointFixture(); delete f.classroom().scenes[1].actions[0].constraintPrompt;
  assert.equal((await f.run()).ready, false); assert.equal(f.state.writes, 0);
});

for (const change of ['source', 'model', 'cancel']) test(`checkpoint correction rejects ${change} change before write`, async () => {
  const f = checkpointFixture();
  f.state.answer = data => {
    if (change === 'source') f.view.project.source.sha256 = 'c'.repeat(64);
    if (change === 'model') f.state.model = 'other';
    if (change === 'cancel') f.state.active = false;
    return { issues: [], analysisCorrections: [], checkpointHintCorrections: [{ actionId: 'checkpoint', text: f.state.expectedHint }] };
  };
  await assert.rejects(f.run(), /changed/); assert.equal(f.state.writes, 0);
});

test('correcting the hint does not clear a separate missing background-layer coverage failure', async () => {
  const f = checkpointFixture(), hintReview = f.state.answer;
  f.state.answer = data => data.page.pageId === 'quiz' ? hintReview(data) : {
    issues: [{ actionId:'speech', kind: 'binding', message: 'River remains in the background outside the animated foreground targets.' }],
    analysisCorrections: [],
  };
  const result = await f.run();
  assert.equal(result.applied, true); assert.equal(result.ready, false); assert.equal(f.state.writes, 1);
  assert.equal(result.issues.length, 1); assert.equal(result.issues[0].pageId, 'body');
  assert.match(result.issues[0].message, /River remains/);
});

for (const route of ['scene','plain']) test(`${route} ignores obsolete crop proposals without blocking delivery`, async () => {
  const f = fixture(); f.state.hostRoute = route; f.view.backgroundRegionRepair = true;
  f.state.answer = data => data.page.pageId === 'body'
    ? { issues: [], analysisCorrections: [], backgroundRegionCorrection: { actionId: 'speech', bounds: [0.1, 0.25, 0.8, 0.7], description: 'River region' } }
    : { issues: [], analysisCorrections: [] };
  const result = await f.run();
  assert.equal(result.ready, true); assert.equal(result.applied, false); assert.equal(f.state.writes, 0);
  assert.equal(f.state.operations.includes('repair-background-region'), false);
  const request = f.state.requests.find(r => JSON.parse(r.data).page.pageId === 'body');
  assert.equal(JSON.parse(request.data).page.backgroundRegionRepair, undefined);
  assert.doesNotMatch(request.system, /backgroundRegionCorrection/);
  assert.match(request.system, /saved teaching actions/);
});


test("final review receives current isolated layers with their UUIDs and supplier descriptions", async () => {
  const f = fixture();
  const png = Buffer.alloc(33); png.writeUInt32BE(0x89504e47); png.writeUInt32BE(200, 16); png.writeUInt32BE(100, 20);
  f.state.layer = `data:image/png;base64,${png.toString("base64")}`;
  f.state.answer = (data, request) => {
    assert.equal(request.images.length, 2);
    assert.deepEqual(data.imageBindings, [{ assetId: "native-layer-layer", objectId: "layer" }]);
    assert.equal(data.page.evidence.objects[0].layerMetadata.name, "Evaporation");
    assert.match(request.system, /not instructions or verified OCR/);
    return { issues: [], analysisCorrections: [] };
  };
  assert.equal((await f.run()).ready, true);
});

test('an invalid reviewer response can be retried against the unchanged lesson', async () => {
  const f = fixture();
  f.state.answer = data => data.page.pageId === 'body' ? 'invalid' : { issues: [], analysisCorrections: [] };
  const failed = await f.run();
  assert.equal(failed.ready, false);
  assert.equal(failed.issues[0].repair, 'review');
  f.state.turn = 'next-turn';
  f.state.answer = () => ({ issues: [], analysisCorrections: [] });
  assert.equal((await f.run()).ready, true);
  assert.equal(f.state.writes, 0);
});


test('unquoted reviewer keys retain the finding and cannot turn uncertainty into approval', async () => {
  const f = fixture();
  f.state.hostRoute = 'import';
  f.state.answer = () => "{issues:[{kind:'uncertain',message:'The unit is unreadable'}], analysisCorrections:[]}";
  const review = await f.run();
  assert.equal(review.ready, false);
  assert.equal(review.issues[0].message, 'The unit is unreadable');
  assert.equal(f.state.requests.length, 2);
});


for (const route of ['scene','plain']) test(`${route} art findings cannot mask an actual spotlight binding failure`, async () => {
  const f = fixture(); f.state.hostRoute = 'scene';
  f.state.hostRoute = route;
  f.view.teachingObjects = [{ objectId:'river', name:'River', aliases:[], status:'mapped', effectTargetEligible:true }];
  f.state.answer = data => ({ issues: data.page.pageId === 'body' ? [
    {kind:'visual', message:'The composition differs from the draft'},
    {actionId:'speech', kind:'binding', message:'The saved spotlight points at the cloud when the speech names the river'}
  ] : [], analysisCorrections: [] });
  const result = await f.run();
  assert.equal(f.state.requests.length, 2); assert.equal(result.ready, false);
  assert.equal(f.state.operations.includes('repair-background-region'), false);
  assert.equal(result.issues.length, 1);
  assert.equal(result.issues[0].code, 'EFFECT_TARGET_MISSING');
  assert.equal(result.issues[0].repair, 'narration');
});

for (const protect of [false, true]) test(`route verified effect findings without unlocking protected pages: ${protect}`, async () => {
  const f = fixture(); f.view.project.pages[0].locked = protect;
  f.view.teachingObjects = [{ objectId: 'arrow', name: 'Arrow', aliases: [], status: 'mapped', effectTargetEligible: true }];
  f.state.answer = data => data.page.pageId === 'body' ? { issues: [{ actionId:'speech', kind: 'binding', message: 'The arrow is missing from the saved spotlight.' }] } : { issues: [], analysisCorrections: [] };
  const result = await f.run(); assert.equal(result.ready, false);
  assert.equal(result.issues[0].code, protect ? 'CONTENT_REVIEW_FAILED' : 'EFFECT_TARGET_MISSING');
  assert.equal(result.issues[0].repairable, !protect);
  const page = f.state.requests.map(r => JSON.parse(r.data).page).find(p => p.pageId === 'body');
  assert.equal(page.evidence.width,254); assert.equal(page.evidence.height,143);
});

test('review joins primary and additional targets to their actual labels in the saved speech window', async () => {
  const f = fixture(); f.view.teachingObjects = ['runoff','ocean'].map(id => ({objectId:id,name:id,aliases:[id+' label'],status:'mapped',effectTargetEligible:true}));
  f.view.project.pages[0].actions[0].visualCues = [{id:'both',atMs:900,endMs:2800,effect:{type:'spotlight',elementId:'runoff',elementIds:['ocean']}}];
  f.state.answer = data => { if(data.page.pageId === 'body') assert.deepEqual(data.focusTimeline,[{speechId:'speech',cueId:'both',atMs:900,endMs:2800,type:'spotlight',targets:[{id:'runoff',name:'runoff label'},{id:'ocean',name:'ocean label'}]}]); return {issues:[],analysisCorrections:[]}; };
  assert.equal((await f.run()).ready,true);
});

test('Scene delivery uses saved pixels for speech and effects while retaining independent assessment review', async () => {
  const f = fixture(); f.state.hostRoute = 'scene';
  f.view.teachingRequirements = [{pageId:'body',teaching:{requiredEffects:['spotlight'],requiredObjects:['discarded design detail']}}];
  assert.equal((await f.run()).ready, true);
  const body = f.state.requests.find(r => JSON.parse(r.data).page.pageId === 'body');
  const quiz = f.state.requests.find(r => JSON.parse(r.data).page.pageId === 'quiz');
  assert.match(body.system, /saved teaching actions/);
  assert.ok(body.images[0].bytes.length);
  assert.equal(JSON.parse(body.data).teachingRequirements, undefined);
  assert.deepEqual(JSON.parse(body.data).requiredEffects, ['spotlight']);
  assert.equal(JSON.parse(body.data).plan, undefined);
  assert.equal(JSON.parse(quiz.data).questions.length, 1);
  assert.match(quiz.system, /correct answer/);
});

for (const route of ['unknown','import']) test(`host route ${route} protects original content even when the reopened editor says plain`, async () => {
  const f = fixture(); f.state.hostRoute = route;
  f.state.answer = data => ({issues:[],analysisCorrections:data.questions.length ? [{questionId:'question',text:'Proposed correction'}] : []});
  const result = await f.run(); assert.equal(result.ready,false); assert.equal(f.state.writes,0);
});


for (const staleCarrier of [false, true]) test(`checkpoint summary correction verifies saved teaching (stale=${staleCarrier})`, async () => {
  const f = checkpointFixture(); f.state.staleCarrier = staleCarrier;
  f.view.project.taskType = 'import'; f.view.enrichment.originalPages = [{pageId:'body'}];
  f.state.expectedCheckpointSummary = 'The poet infers fallen blossoms from the rain.';
  const original = structuredClone(f.classroom().scenes[1].actions[0]);
  f.state.answer = data => ({issues: [], analysisCorrections: [], checkpointSummaryCorrections:
    data.page.pageId === 'quiz' && !f.state.writes ? [{actionId: 'checkpoint', text:f.state.expectedCheckpointSummary}] : []});
  if (staleCarrier) { await assert.rejects(f.run(), /saved.*summary/i); return; }
  const review = await f.run(); assert.equal(review.ready, true); assert.equal(review.applied, true);
  assert.equal(f.state.writes, 1); assert.deepEqual(f.classroom().scenes[1].actions[0], {...original, referenceAnswer: {...original.referenceAnswer, summary:f.state.expectedCheckpointSummary}});
});

test("another page or turn cannot reopen an accepted unchanged frozen body for a speculative rewrite", async () => {
  const f = fixture(), original = structuredClone(f.view.project.pages[0].actions);
  await f.run(true);
  f.state.turn = "repair-another-page";
  f.view.project.teachingRevision = "other-page-saved";
  f.view.project.pages[1].actions = [{ type: "speech", id: "other", text: "Listen." }];
  f.state.answer = data => {
    assert.notEqual(data.page.pageId, "body", "unchanged accepted body must not be regraded");
    return { issues: [], analysisCorrections: [] };
  };
  assert.equal((await f.run(true)).ready, true);
  assert.deepEqual(f.view.project.pages[0].actions, original);
});

test("an unsupported visual inference cannot rewrite a valid sentence or spend its audio", async () => {
  const f = fixture(), speech = structuredClone(f.view.project.pages[0].actions[0]);
  f.state.answer = d => d.page.pageId === "body" ? { issues: [{kind:"content",actionId:speech.id,message:"Needs a more precise measurement."}],
    speechCorrection:{actionId:speech.id, originalText:speech.text,text:"A more specific measurement."} } : {issues:[],analysisCorrections:[]};
  f.state.verify = () => [];
  const result = await f.run(true);
  assert.equal(result.ready,true);
  assert.equal(result.applied,false);
  assert.deepEqual(f.view.project.pages[0].actions[0],speech);
});
