import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import ts from "typescript";
const shared = await import("../../../packages/shared/dist/index.js");
const module = { exports: {} };
new Function("require", "exports", "module", ts.transpileModule(readFileSync(new URL("../electron/main/courseware-native-sidebar.ts", import.meta.url), "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS },
}).outputText)(id => id === "@pi-desktop/shared" ? shared : createRequire(import.meta.url)(id), module.exports, module);
const { createNativeTeachingHandler } = module.exports;
const context = { projectId: "project", documentId: "document", sessionId: "editor-session", page: 1, editGeneration: 2, readOnly: false };
function setup() {
  const calls = [];
  const handler = createNativeTeachingHandler({
    context: async () => context, sessionId: () => "conversation",
    teaching: { open: async sessionId => { calls.push(["open", sessionId]); return "view"; },
      update: async (...args) => { calls.push(["write", ...args]); return "saved"; },
      draft: async (...args) => { calls.push(["draft", ...args]); return "draft"; } },
    media: { list: async args => { calls.push(["catalog", args]); return []; },
      adopt: async args => { calls.push(["adopt", args]); return "adopted"; }, preview: async args => { calls.push(["media", args]); return "local-media"; } },
    tts: { list: async args => { calls.push(["list", args]); return []; },
      submitConfirmed: async args => { calls.push(["submit", args]); return "submitted"; } },
  });
  return { handler, calls };
}
const request = (operation, args = {}, overrides = {}) => ({ operation, args, context: { ...context, ...overrides } });
test("embedded checkpoint tools preserve the native narration draft", async () => {
  const handler = createNativeTeachingHandler({context: async()=>context, sessionId:()=>"conversation",
    assessmentContext: async()=>({current:false,embedded:true}),
    teaching:{open:async()=>({viewId:"native-view"}),draft:async()=>({actions:[{id:"body",type:"speech",text:"Original narration"}]})},
    classroom:{openNative:async()=>({classroom:{scenes:[]}})}});
  const view=await handler(request("open"));
  assert.equal(view.assessment,undefined);
  assert.equal(view.nativeDraft.actions[0].text,"Original narration");
  assert.deepEqual(view.embeddedAssessment,{classroom:{scenes:[]}});
});
test("assessment forms load through the native teaching panel and derive the owning Chat", async () => {
  const calls = [], assessment = { projectId: "course", classroom: { scenes: [] } };
  const handler = createNativeTeachingHandler({ context: async () => context, sessionId: () => "conversation",
    teaching: { open: async () => ({ viewId: "native-view", project: {}, pageId: "quiz" }) },
    assessmentContext: async () => ({current: true}),
    classroom: { openNative: async (sessionId, view) => { assert.equal(view.viewId,"native-view"); calls.push(["open", {sessionId}]); return assessment; },
      write: async args => { calls.push(["write", args]); return assessment; } },
  });
  assert.deepEqual((await handler(request("open"))).assessment, assessment);
  assert.deepEqual(await handler(request("classroom:write", { projectId: "course", classroom: {} })), assessment);
  assert.deepEqual(calls, [["open", { sessionId: "conversation" }], ["write", { projectId: "course", classroom: {}, sessionId: "conversation" }]]);
  await assert.rejects(handler(request("classroom:write", { sessionId: "foreign" })), /Invalid assessment/);
  await assert.rejects(handler(request("classroom:write", {}, { page: 2 })), /target changed/);
});
test("native assessment TTS uses the bound Chat session and forwards quote, submit and refresh", async () => {
  const calls = [];
  const handler = createNativeTeachingHandler({ context: async () => context, sessionId: () => "conversation",
    teaching: {}, classroom: { open: async () => ({}) },
    classroomTts: Object.fromEntries(["models", "quote", "submit", "refresh"].map(method => [method, async args => {
      calls.push([method, args]); return method;
    }])),
  });
  assert.equal(await handler(request("classroom:tts:models", {})), "models");
  const args = { projectId: "course", expectedRevision: "r1", expectedSourceRevision: "s1", sceneId: "quiz", actionId: "speech", model: "m", voice: null };
  for (const method of ["quote", "submit", "refresh"])
    assert.equal(await handler(request(`classroom:tts:${method}`, args)), method);
  assert.deepEqual(calls, [["models", { sessionId: "conversation" }], ...["quote", "submit", "refresh"].map(method => [method, { ...args, sessionId: "conversation" }])]);
  await assert.rejects(handler(request("classroom:tts:quote", { ...args, sessionId: "foreign" })), /Invalid assessment request/);
});
test("native teaching bridge cannot open a separate MAIC playback window", async () => {
  const { handler } = setup();
  for (const operation of ["classroom:play", "classroom:preview-course"])
    await assert.rejects(handler(request(operation)), /Invalid assessment request|Unsupported assessment operation/);
});

test('option image generation and question audio preview keep the native document binding and owning Chat', async () => {
  const calls = [];
  const handler = createNativeTeachingHandler({ context: async () => context, sessionId: () => 'conversation', teaching: {},
    classroom: { previewAudio: async args => { calls.push(['audio', args]); return 'audio'; } },
    classroomImages: Object.fromEntries(['models','quote','submit','refresh'].map(method => [method, async args => { calls.push([method,args]); return method; }])),
  });
  const target = { projectId: 'course', sceneId: 'quiz', questionId: 'q', optionValue: 'A', model: 'm' };
  for (const method of ['models','quote','submit','refresh'])
    assert.equal(await handler(request('classroom:image:' + method, target)), method);
  assert.equal(await handler(request('classroom:audio:preview', { actionId: 'speech' })), 'audio');
  assert(calls.every(([, args]) => args.sessionId === 'conversation'));
  await assert.rejects(handler(request('classroom:image:submit', target, {page:2})), /target changed/);
  await assert.rejects(handler(request('classroom:audio:preview', {sessionId:'foreign'})), /Invalid assessment/);
  assert.equal(calls.length, 5);
});
test("native teaching shares the current conversation and existing write/TTS authorities", async () => {
  const { handler, calls } = setup();
  assert.equal(await handler(request("open")), "view");
  const args = { viewId: "view", expectedTeachingRevision: "revision", actions: [] };
  assert.equal(await handler(request("write", args)), "saved");
  await handler(request("tts:list", { viewId: "view" }));
  assert.deepEqual(calls, [["open", "conversation"], ["write", args, false], ["list", { viewId: "view" }]]);
  assert.equal(calls.some(([name]) => name === "submit"), false);
});
test("stale page, edit, document and read-only requests never reach teaching or paid submission", async () => {
  for (const override of [{ page: 2 }, { editGeneration: 1 }, { documentId: "foreign" }, { sessionId: "foreign" }]) {
    const { handler, calls } = setup();
    await assert.rejects(handler(request("tts:submit", {}, override)), /target changed/);
    assert.deepEqual(calls, []);
  }
  const { handler, calls } = setup(); context.readOnly = true;
  try { await assert.rejects(handler(request("write")), /target changed/); } finally { context.readOnly = false; }
  assert.deepEqual(calls, []);
});
test("queued recovery drafts may finish after navigation without authorizing a teaching write", async () => {
  const { handler, calls } = setup();
  assert.equal(await handler(request("draft:set", { viewId: "old-page-view" }, { page: 2 })), "draft");
  assert.deepEqual(calls, [["draft", { viewId: "old-page-view" }, true]]);
  await assert.rejects(handler(request("write", {}, { page: 2 })), /target changed/);
});
test("unsupported, malformed and oversized native requests are refused", async () => {
  const { handler, calls } = setup();
  for (const input of [null, [], {}, { ...request("open"), injected: true }, request("write", []), request("open", { text: "x".repeat(2_000_000) }), request("shell:run")])
    await assert.rejects(handler(input));
  assert.deepEqual(calls, []);
});

test("adopted media preview uses the same native binding fence", async () => {
  const { handler, calls } = setup();
  assert.equal(await handler(request("media:preview", { actionId: "music" })), "local-media");
  await assert.rejects(handler(request("media:preview", {}, { page: 2 })), /target changed/);
  assert.deepEqual(calls, [["media", { actionId: "music" }]]);
});

test("catalog and explicit adoption share native binding fences without forwarding unsupported operations", async () => {
  const { handler, calls } = setup();
  assert.deepEqual(await handler(request("media:list", { viewId: "view" })), []);
  assert.equal(await handler(request("media:adopt", { kind: "video", intentId: "saved" })), "adopted");
  await assert.rejects(handler(request("media:adopt", {}, { editGeneration: 100 })), /target changed/);
  assert.deepEqual(calls.map(([operation]) => operation), ["catalog", "adopt"]);
});


test("native sidebar does not expose per-page teaching confirmation", async () => {
  const { handler, calls } = setup();
  await assert.rejects(handler(request("confirm", { viewId: "view", expectedTeachingRevision: "rev" })));
  assert.deepEqual(calls, []);
});

test("native page loads wait for assessment saves and revalidate the renewed document", async () => {
  let finishSave, saving = false;
  const calls = [];
  const handler = createNativeTeachingHandler({context:async()=>context,sessionId:()=>"conversation",
    classroom:{write:async()=>{saving=true;calls.push('save');await new Promise(resolve=>{finishSave=resolve;});saving=false;calls.push('saved');return 'saved';}},
    teaching:{open:async()=>{if(saving)throw Error('Teaching is already opening');calls.push('open');return 'view';}}
  });
  const save = handler(request('classroom:write'));
  await new Promise(resolve=>setImmediate(resolve));
  const load = handler(request('open'));
  // Observe rejection immediately while holding the save, so the regression is deterministic.
  const result = load.then(value=>({value}),error=>({error:error.message}));
  await new Promise(resolve=>setImmediate(resolve));
  finishSave(); await save;
  assert.deepEqual(await result,{value:'view'});
  assert.deepEqual(calls,['save','saved','open']);
});

test('slow model reads do not hold later teaching loads or draft writes', async () => {
  let release;
  const started = Promise.withResolvers();
  const handler = createNativeTeachingHandler({
    context: async () => context, sessionId: () => 'conversation',
    teaching: { open: async () => 'view', draft: async () => 'draft' },
    tts: { models: async () => { started.resolve(); return new Promise(resolve => { release = resolve; }); } },
  });
  const models = handler(request('tts:models'));
  await started.promise;
  try {
    const editing = Promise.all([handler(request('open')), handler(request('draft:set'))]);
    const nextTurn = new Promise(resolve => setImmediate(() => resolve('blocked')));
    assert.deepEqual(await Promise.race([editing, nextTurn]), ['view', 'draft']);
  } finally { release([]); }
  assert.deepEqual(await models, []);
});

test('read admission remains bounded and read fences are revalidated after a save', async () => {
  const save = Promise.withResolvers(), started = Promise.withResolvers();
  const releases = [];
  const handler = createNativeTeachingHandler({
    context: async () => context, sessionId: () => 'conversation',
    teaching: { update: async () => { started.resolve(); await save.promise; return 'saved'; } },
    tts: { models: () => new Promise(resolve => releases.push(resolve)) },
  });
  const writing = handler(request('write'));
  await started.promise;
  const stale = handler(request('tts:models'));
  const rejected = assert.rejects(stale, /target changed/);
  context.editGeneration++;
  save.resolve();
  await writing; await rejected;
  context.editGeneration--;
  const reads = Array.from({length:4}, () => handler(request('tts:models')));
  try { await assert.rejects(handler(request('tts:models')), /READ_BUSY/); }
  finally {
    await new Promise(resolve => setImmediate(resolve));
    releases.forEach(resolve => resolve([]));
    await Promise.all(reads);
  }
});
