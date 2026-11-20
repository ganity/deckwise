import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import ts from 'typescript';
import * as runtime from '../../../packages/courseware-runtime/dist/node.mjs';
const exports = {};
new Function('require', 'exports', ts.transpileModule(await readFile(new URL('../electron/main/courseware-assessment-media.ts', import.meta.url), 'utf8'), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText)(id => { assert.equal(id, '@pi-desktop/courseware-runtime/node'); return runtime; }, exports);
function fixture() {
  let view = { nativeTeaching: true, projectId: 'project', revision: 'r1', sourceRevision: 's1', classroom: {
    id: 'classroom', createdAt: '2026-01-01', stage: { id: 'stage', name: 'Math', createdAt: 1, updatedAt: 1 }, scenes: [{
      id: 'quiz', stageId: 'stage', type: 'quiz', title: 'Opposites', order: 0,
      content: { type: 'quiz', questions: [{ id: 'q', type: 'single', question: 'Opposite of 2?', options: [
        { value: 'A', label: '-2' }, { value: 'B', label: '2', image: { src: 'data:image/png;base64,AA==' } }], answer: ['A'] }] },
    }] } };
  view.classroom = runtime.prepareMaicAssessmentSpeech(view.classroom);
  for (const action of view.classroom.scenes[0].actions) if (action.type === 'speech') action.audioId = 'saved-' + action.id;
  const calls = [];
  const service = new exports.CoursewareAssessmentMedia({ open: async () => structuredClone(view), write: async args => {
    assert.equal(args.expectedRevision, view.revision); assert.equal(args.expectedSourceRevision, view.sourceRevision);
    calls.push(args); view = { ...view, revision: 'r' + (calls.length + 1), classroom: structuredClone(args.classroom) }; return structuredClone(view);
  } }, {}, {});
  return { service, calls, get view() { return view; }, configure: (extra = {}) => service.execute('chat', {
    mode: 'configure', projectId: view.projectId, expectedRevision: view.revision, expectedSourceRevision: view.sourceRevision,
    sceneIds: ['quiz'], optionImages: 'excluded', reason: 'User requested text-only choices', ...extra,
  }, () => true) };
}
test('explicit saved text-only scope removes only missing option images, preserving existing media and speech', async () => {
  const f = fixture(), before = structuredClone(f.view.classroom.scenes[0]);
  const original = await f.service.execute('chat', { mode: 'context' }, () => true);
  assert.deepEqual(original.configurableQuizSceneIds, ['quiz']);
  assert.equal(original.ready, false); assert.equal(original.targets[0].kind, 'image');
  const saved = await f.configure(); assert.equal(saved.applied, true); assert.equal(saved.ready, true);
  const reread = await f.service.execute('chat', { mode: 'context' }, () => true);
  assert.equal(reread.ready, true); assert.equal(reread.excludedTargets.length, 1);
  assert.deepEqual(f.view.classroom.scenes[0].actions, before.actions);
  assert.deepEqual(f.view.classroom.scenes[0].content.questions, before.content.questions);
  await assert.rejects(f.service.execute('chat', { mode: 'prepare', kind: 'image', projectId: f.view.projectId,
    expectedRevision: f.view.revision, expectedSourceRevision: f.view.sourceRevision, sceneId: 'quiz', questionId: 'q',
    optionValue: 'A', model: 'image' }, () => true), /excluded by the saved user requirement/);
  delete f.view.classroom.scenes[0].actions[0].audioId;
  const noAudio = await f.service.execute('chat', { mode: 'context' }, () => true);
  assert.equal(noAudio.ready, false); assert(noAudio.targets.every(t => t.kind === 'tts'));
  await f.configure({ optionImages: 'required', reason: 'User now requests picture choices' });
  assert((await f.service.execute('chat', { mode: 'context' }, () => true)).targets.some(t => t.kind === 'image'));
});
test('assessment scope changes reject stale revisions, unavailable scenes, malformed policies and ended turns', async () => {
  const f = fixture();
  for (const extra of [{ expectedRevision: 'old' }, { expectedSourceRevision: 'old' }, { sceneIds: ['missing'] },
    { sceneIds: ['quiz', 'quiz'] }, { sceneIds: [] }, { optionImages: 'skip' }, { reason: '' }, { unexpected: true }])
    await assert.rejects(f.configure(extra));
  await assert.rejects(f.service.execute('chat', { mode: 'context' }, () => false), /turn ended/);
  assert.equal(f.calls.length, 0);
});


test('non-Quiz scope returns a repairable field error without changing saved content', async () => {
  const f = fixture();
  f.view.classroom.scenes.push({ id: 'body', stageId: 'stage', type: 'slide', title: 'Body', order: 1,
    content: { type: 'slide', elements: [] }, actions: [] });
  const context = await f.service.execute('chat', { mode: 'context' }, () => true);
  assert.deepEqual(context.configurableQuizSceneIds, ['quiz']);
  await assert.rejects(f.configure({ sceneIds: ['quiz', 'body'] }), /COURSEWARE_INVALID_ASSESSMENT_SCOPE.*configurableQuizSceneIds/);
  assert.equal(f.calls.length, 0);
});
