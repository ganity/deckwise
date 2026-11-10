import assert from 'node:assert/strict';
import test from 'node:test';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { tmpdir } from 'node:os';
import ts from 'typescript';
import * as runtime from '../../../packages/courseware-runtime/dist/node.mjs';

const load = async file => {
  const exports = {};
  new Function('require', 'exports', ts.transpileModule(await fs.readFile(new URL(`../electron/main/${file}.ts`, import.meta.url), 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText)(id => {
    if (id === 'node:crypto') return crypto;
    if (id === 'node:fs/promises') return fs;
    if (id === 'node:path') return path;
    if (id === './courseware-runtime') return { coursewareAuthoringUrl: () => { throw Error('Unexpected native compiler'); } };
    if (id === '@pi-desktop/courseware-runtime/node') return runtime;
    if (id === './fs-panel') return { resolveRealPathForCreateWithinRoot: async (root, value) => path.join(root, value) };
    if (id === './courseware-classroom-assets') return { readClassroomAsset: async (root, asset) => fs.readFile(path.join(root, asset.url)) };
    if (id === './courseware-media-scope') return { coursewareMediaSubmissionProject: scope => scope.teamProjectId };
    throw Error(id);
  }, exports);
  return exports;
};
const { CoursewareClassroomCoordinator } = await load('courseware-classroom');
const { CoursewareClassroomImages } = await load('courseware-classroom-images');
const { CoursewareAssessmentMedia } = await load('courseware-assessment-media');
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j5X0AAAAASUVORK5CYII=', 'base64');

async function fixture(t, taskType = 'scene') {
  const root = await fs.mkdtemp(path.join(tmpdir(), 'quiz-image-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  let view = { projectId: 'p', revision: 'r1', sourceRevision: 's1', classroom: {
    id: 'course', createdAt: '2026-11-06', stage: { id: 'stage', name: 'Lesson', createdAt: 1, updatedAt: 1 },
    scenes: [{ id: 'quiz', stageId: 'stage', type: 'quiz', title: 'Question', order: 0, content: { type: 'quiz',
      questions: [{ id: 'q', type: 'single', question: 'Which animal meows?', options: [{ value: 'A', label: 'Cat' }, { value: 'B', label: 'Dog' }], answer: ['A'] }] }, actions: [] }],
  } };
  const args = { sessionId: 's', projectId: 'p', expectedRevision: 'r1', expectedSourceRevision: 's1', sceneId: 'quiz', questionId: 'q', optionValue: 'A', model: 'm' };
  let principalKey = 'owner', submitted = 0;
  const tasks = new Map(), calls = [];
  const host = { async call(method, payload) {
    calls.push(method);
    if (method === 'session.get') return { session: { projectPath: root, mode: 'agent' } };
    if (method === 'courseware.task.get') return { task: { taskType, canonicalProjectId: 'p' } };
    if (method === 'courseware.classroom.get') return structuredClone(view);
    if (method === 'courseware.classroom.mediaScope') return { sessionId: 's', teamProjectId: 'team' };
    if (method === 'courseware.classroom.write') {
      assert.equal(payload.expectedRevision, view.revision); assert.equal(payload.expectedSourceRevision, view.sourceRevision);
      view = { ...view, revision: 'r2', classroom: payload.classroom }; return structuredClone(view);
    }
    throw Error(method);
  } };
  const classroom = new CoursewareClassroomCoordinator({ getHost: () => host, getSessionId: () => 's', getWorkspace: async () => root,
    assertOwned: session => assert.equal(session, 's'), openProject: async () => ({ project: { projectId: 'p' } }) });
  const media = {
    getImageModels: async () => [{ model: 'm' }],
    getImageQuote: async () => ({ maxPoints: 9, maxChars: 4000, expiresAt: new Date(Date.now() + 60000).toISOString() }),
    findImage: async ref => {
      const task = tasks.get(ref.idempotencyKey);
      if (task) assert.equal(task.requestHash, ref.requestHash);
      return task ?? null;
    },
    async submitConfirmedImage(key, request, quote, signal, projectId, check, admit) {
      await check(); assert.equal(await admit(), 'team'); submitted++;
      const fields = [request.kind, request.model, request.input, null];
      const canonical = fields.reduce((text, value) => `${text}:${value === null ? -1 : value.length}:${value ?? ''}`, 'courseware-media-v1');
      const task = { taskId: 'task', state: 'running', requestHash: crypto.createHash('sha256').update(canonical).digest('hex') };
      tasks.set(key, task); return task;
    },
    getImage: async ref => tasks.get(ref.idempotencyKey),
    downloadImage: async ref => ({ task: tasks.get(ref.idempotencyKey), bytes: png }),
  };
  const coordinator = new CoursewareClassroomImages({ classroom, auth: { coursewareMedia: media,
    getCoursewarePrincipal: () => { const captured = principalKey; return { key: captured, assertCurrent() { assert.equal(captured, principalKey); } }; } },
    getHost: () => host, getWorkspace: async () => root, assertOwned: session => assert.equal(session, 's') });
  return { root, args, coordinator, classroom, tasks, calls, get view() { return view; }, get submitted() { return submitted; },
    principal: value => { principalKey = value; }, revision: value => { view.revision = value; } };
}

for (const route of ['import', 'scene', 'ppt-master']) test(`${route}: saved Quiz option follows quote, confirmation, durable lookup and archive/adoption`, async t => {
  const f = await fixture(t, route);
  await assert.rejects(f.coordinator.submit(f.args), /Confirm a current Quiz image quote/);
  const quote = await f.coordinator.quote(f.args);
  await f.coordinator.submit({ ...f.args, quoteId: quote.quote.quoteId });
  assert.equal((await f.coordinator.refresh(f.args)).state, 'running');
  const retryQuote = await f.coordinator.quote(f.args);
  await f.coordinator.submit({ ...f.args, quoteId: retryQuote.quote.quoteId });
  assert.equal(f.submitted, 1);
  const task = f.tasks.get(quote.key); task.state = 'ready';
  task.assetRef = { mime: 'image/png', byteLength: png.length, sha256: crypto.createHash('sha256').update(png).digest('hex') };
  const adopted = await f.coordinator.refresh(f.args);
  assert.equal(adopted.state, 'adopted');
  const question = adopted.view.classroom.scenes[0].content.questions[0];
  assert(question.options[0].image.src.startsWith('.deckwise-ppt/classroom-assets/'));
  assert.equal(question.options[1].image, undefined);
  assert.equal(adopted.view.classroom.mediaManifest[0].elementId, 'quiz-option:q:A');
  assert.deepEqual(await fs.readFile(path.join(f.root, question.options[0].image.src)), png);
  assert(adopted.view.resourceUrls[question.options[0].image.src].startsWith('data:image/png;base64,'));
});

test('shared assessment workflow inventories missing media without submitting; generation prepares legacy speech and preserves images', async t => {
  const f = await fixture(t), calls = [];
  const tts = {
    models: async () => [{ model: 'voice-model', voices: ['v'] }],
    quote: async request => { calls.push(request); assert(f.view.classroom.scenes[0].actions.some(a => a.id === request.actionId)); return { quote: { quoteId: 'quote' } }; },
    submit: async request => { assert.equal(request.quoteId, 'quote'); return { state: 'running' }; },
    refresh: async () => ({ state: 'adopted', view: f.view }),
  };
  const workflow = new CoursewareAssessmentMedia(f.classroom, tts, f.coordinator);
  const context = await workflow.execute('s', { mode: 'context', kind: 'tts' }, () => true);
  assert.equal(context.ready, false); assert.equal(context.targets.length, 3);
  assert.equal(f.view.classroom.scenes[0].actions.length, 0, 'Context cannot mutate legacy classrooms');
  assert.equal(f.submitted, 0);
  assert.deepEqual(context.models, [{ model: 'voice-model', voices: ['v'] }]);
  const { ready, targets, models, ...selection } = context;
  await workflow.execute('s', { mode: 'prepare', ...selection, ...targets[0], model: 'voice-model', voice: 'v' }, () => true);
  assert.equal(calls[0].expectedRevision, 'r2', 'Prepared speech must be quoted against the saved CAS revision');
  const adopted = await workflow.execute('s', { mode: 'refresh', ...selection, ...targets[0], model: 'voice-model', voice: 'v' }, () => true);
  assert.deepEqual(adopted.view, { projectId: f.view.projectId, revision: f.view.revision, sourceRevision: f.view.sourceRevision },
    'Agent results retain saved revisions without returning the full presentation and inline images');
  await assert.rejects(workflow.execute('s', { mode: 'context' }, () => false), /turn ended/);
  await assert.rejects(workflow.execute('s', { mode: 'prepare', ...selection, ...targets[0], model: 'voice-model', voice: 'v' }, () => true), /changed/);
});

test('image quote cannot cross principal, classroom revision, question or option identities', async t => {
  const f = await fixture(t), quote = await f.coordinator.quote(f.args);
  await assert.rejects(f.coordinator.submit({ ...f.args, optionValue: 'B', quoteId: quote.quote.quoteId }), /Confirm a current/);
  f.principal('other');
  await assert.rejects(f.coordinator.submit({ ...f.args, quoteId: quote.quote.quoteId }), /Confirm a current/);
  f.principal('owner'); f.revision('r2');
  await assert.rejects(f.coordinator.refresh(f.args), /Classroom changed/);
  assert.equal(f.submitted, 0);
  assert.equal(f.calls.includes('courseware.classroom.write'), false);
});
