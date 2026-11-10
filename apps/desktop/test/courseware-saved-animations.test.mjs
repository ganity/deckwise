import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import ts from 'typescript';
import * as authoring from '../../../packages/courseware-runtime/dist/authoring.mjs';

async function fixture() {
  const scene = { id: 'page', title: 'Hello', content: { type: 'slide', canvas: authoring.createMaicInteractionCanvas('page', 'Hello', 'Say hello') },
    actions: [{ type: 'interaction_checkpoint', checkpointKind: 'chapter_summary' }] };
  const source = await authoring.compileSceneToPptx(authoring.assessmentPptxScene(scene, 'sha256:test', { width: 1000, height: 562.5 }),
    { [authoring.assessmentBackground.id]: authoring.assessmentBackground.bytes });
  const project = { projectId: 'project', source: { sha256: 'a'.repeat(64) }, teachingRevision: 'teaching', pages: [{ pageId: 'page', locked: false,
    actions: [{ id: 'speech', type: 'speech', text: 'Say hello', audioAssetId: 'archived-audio', visualCues: [{ atMs: 0, endMs: 600,
      effect: { type: 'element_animation', elementId: 'logical-question', effect: 'fadeIn' } }] }] }] };
  const commits = [], calls = [], state = { current: true };
  const host = { async call(method) {
    calls.push(method);
    if (method === 'courseware.classroom.source') return { project, ir: { pages: [{ elements: [{ id: 'imported-question', sourceObjectName: 'page_question' }] }] },
      mapping: { pages: [{ objects: [{ objectId: 'logical-question', importElementId: 'imported-question' }] }] } };
    if (method === 'session.get') return { session: { projectPath: '/workspace' } };
    if (method === 'courseware.task.get') return { task: { generatedPath: '/workspace/course.pptx' } };
    if (method === 'courseware.project.get') return { project };
    assert.fail(method);
  } };
  const code = ts.transpileModule(await readFile(new URL('../electron/main/courseware-saved-animations.ts', import.meta.url), 'utf8'),
    { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
  const exports = {};
  new Function('require', 'exports', code)(name => {
    if (name === './courseware-runtime') return { coursewareAuthoringUrl: () => 'test-authoring' };
    if (name === 'test-authoring') return authoring;
    if (name === './courseware-classroom-save') return { commitSavedPptx: async input => {
      await input.saved.check(); input.assertCurrent(); commits.push(input);
    } };
    assert.fail(name);
  }, exports);
  const saved = { host, project, jobId: 'job', bytes: source.pptx, check: async () => { assert(state.current, 'source changed'); } };
  return { saved, project, commits, calls, state,
    run: () => exports.persistSavedSpeechAnimations(saved, 'session', () => assert(state.current)) };
}

test('final TTS adoption commits real native animation bytes while preserving logical IDs and audio', async () => {
  const f = await fixture(), before = structuredClone(f.project);
  await f.run();
  assert.equal(f.commits.length, 1);
  const commit = f.commits[0];
  assert.notDeepEqual(commit.bytes, f.saved.bytes);
  assert.deepEqual(commit.lineage.animationUnchanged, [false]);
  assert.deepEqual(commit.lineage.objects, [[{ name: 'page_question', sourceName: 'page_question', sourcePageToken: 'page' }]]);
  assert.deepEqual(f.project, before);
  f.saved.bytes = commit.bytes;
  await f.run();
  assert.equal(f.commits.length, 1, 'replaying completion must not create another animation or native save');
});

test('missing audio, locked targets, stale source and absent object bindings cannot write a PPTX', async () => {
  const missing = await fixture(); delete missing.project.pages[0].actions[0].audioAssetId;
  await missing.run(); assert.equal(missing.calls.length, 0);
  const locked = await fixture(); locked.project.pages[0].locked = true;
  await assert.rejects(locked.run(), /Unlock/); assert.equal(locked.commits.length, 0);
  const stale = await fixture(); stale.state.current = false;
  await assert.rejects(stale.run(), /source changed/); assert.equal(stale.commits.length, 0);
  const absent = await fixture(); absent.project.pages[0].actions[0].visualCues[0].effect.elementId = 'missing';
  await assert.rejects(absent.run(), /target/); assert.equal(absent.commits.length, 0);
});
