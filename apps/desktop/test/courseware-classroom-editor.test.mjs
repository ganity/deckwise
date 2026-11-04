import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import ts from 'typescript';

const source = await readFile(new URL('../src/lib/courseware-classroom.ts', import.meta.url), 'utf8');
const { outputText } = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } });
const editor = {};
new Function('exports', outputText)(editor);
const image = { src: '.deckwise-ppt/classroom-assets/image.png', assetId: 'image-1' };
const question = { id: 'q', type: 'multiple', question: 'Choose', options: [
  { value: 'D', label: '', image }, { value: 'B', label: 'Two' }, { value: 'A', label: 'One' },
], answer: ['D', 'A'] };
const classroom = { id: 'course', stage: { id: 'course' }, scenes: [{ id: 'scene', content: { type: 'quiz', questions: [question] } }],
  mediaManifest: [ { sceneId: 'scene', elementId: 'quiz-option:q:D', assetId: 'image-1' },
    { sceneId: 'other', elementId: 'canvas-image', assetId: 'image-1' } ] };

test('option deletion removes its answer and image binding without relabeling remaining choices; undo restores both', () => {
  const undo = editor.clone(classroom);
  const modified = editor.clone(classroom);
  modified.scenes[0].content.questions[0] = editor.removeQuestionOption(question, 'D');
  const saved = editor.pruneQuizImageBindings(modified);
  assert.deepEqual(saved.scenes[0].content.questions[0].options.map(o => o.value), ['B', 'A']);
  assert.deepEqual(saved.scenes[0].content.questions[0].answer, ['A']);
  assert.deepEqual(saved.mediaManifest.map(m => m.elementId), ['canvas-image']);
  assert.equal(editor.newOptionValue(saved.scenes[0].content.questions[0]), 'C');
  assert.deepEqual(undo.scenes[0].content.questions[0].answer, ['D', 'A']);
  assert.equal(undo.scenes[0].content.questions[0].options[0].image.assetId, 'image-1');
  assert.equal(undo.mediaManifest.length, 2);
});

test('draft recovery cannot cross project, content or native-source revisions', () => {
  const current = { projectId: 'p', revision: 'r', sourceRevision: 'source', classroom };
  assert.deepEqual(editor.recoverClassroomDraft(current, editor.clone(current)), classroom);
  for (const key of ['projectId', 'revision', 'sourceRevision']) {
    assert.equal(editor.recoverClassroomDraft(current, { ...current, [key]: 'different' }), null);
  }
});

test('checkpoint question and selected canvas element change atomically and preserve other narration/actions', () => {
  const slide = { id: 's', content: { type: 'slide', canvas: { elements: [
    { id: 'title', type: 'text', content: '<p>Title</p>' }, { id: 'bound', type: 'text', content: '<p>Old</p>' },
  ] } }, actions: [ { id: 'speech', type: 'speech', text: 'Before' },
    { id: 'checkpoint', type: 'interaction_checkpoint', checkpointKind: 'chapter_summary', question: 'Old' } ] };
  const updated = editor.updateCheckpointQuestion(slide, 'checkpoint', 'A < B & C', 'bound');
  assert.equal(updated.actions[1].question, 'A < B & C');
  assert.equal(updated.content.canvas.elements[1].content, '<p>A &lt; B &amp; C</p>');
  assert.equal(updated.metadata.nativeQuestionElementId, 'bound');
  assert.deepEqual(updated.actions[0], slide.actions[0]);
  assert.equal(slide.actions[1].question, 'Old');
  assert.throws(() => editor.updateCheckpointQuestion(slide, 'checkpoint', 'New', 'absent'));
  assert.throws(() => editor.updateCheckpointQuestion(slide, 'missing', 'New', 'bound'));
});

test('failed image attachment retains the already-committed revision for retries', async () => {
  const previous = { projectId: 'p', revision: 'before', sourceRevision: 'source', classroom };
  const saved = { ...previous, revision: 'after-save' };
  let current = previous;
  await assert.rejects(editor.saveBeforeImageAttachment({
    save: async () => saved, current: () => true, saved: value => { current = value; },
    attach: async value => { assert.equal(current.revision, 'after-save'); assert.equal(value.revision, 'after-save'); throw Error('image failed'); },
  }), /image failed/);
  assert.equal(current.revision, 'after-save');
  let retryRevision;
  await editor.saveBeforeImageAttachment({ save: async () => { retryRevision = current.revision; return saved; },
    current: () => true, saved: value => { current = value; }, attach: async value => ({ ...value, revision: 'image-saved' }) });
  assert.equal(retryRevision, 'after-save');
});

test('image attachment is cancelled if the editor owner changes while content save is pending', async () => {
  let resolve;
  const saved = new Promise(ready => { resolve = ready; });
  let active = true, attached = false, installed = false;
  const operation = editor.saveBeforeImageAttachment({ save: () => saved, current: () => active,
    saved: () => { installed = true; }, attach: async value => { attached = true; return value; } });
  active = false; resolve({ revision: 'r', classroom });
  assert.equal(await operation, null); assert.equal(attached, false); assert.equal(installed, false);
});

test('all-Quiz to interaction uses valid MAIC slide dimensions/theme and preserves 16:10 course canvas', async () => {
  const { parseMaicClassroom } = await import('@pi-desktop/courseware-runtime/node');
  const document = { id:'course', createdAt:new Date(0).toISOString(), stage:{id:'course',name:'Test',createdAt:0,updatedAt:0,
    canvas:{preset:'KINDERGARTEN_16_10',viewportSize:1280,viewportRatio:10/16}}, scenes:[] };
  const canvas = editor.createInteractionCanvas(document, 'interaction');
  assert.equal(canvas.viewportSize, 1280); assert.equal(canvas.viewportRatio, 10/16);
  const scene = {id:'interaction',stageId:'course',type:'slide',title:'Interaction',order:1,content:{type:'slide',canvas},actions:[]};
  assert.equal(parseMaicClassroom({...document,scenes:[scene]}).scenes[0].content.canvas.theme.fontName, 'Arial');
});

test('short answer reference survives the pinned cloud-web answer[0] consumer without trimming authored text', () => {
  const patch = editor.shortAnswerReferencePatch('  Keep my exact words.  ');
  assert.equal(patch.answer[0], '  Keep my exact words.  ');
  assert.equal(patch.referenceAnswer, patch.answer[0]);
  assert.equal(patch.hasAnswer, false);
  assert.deepEqual(editor.shortAnswerReferencePatch('   ').answer, []);
});

test('scene deletion clears only its owned media/audio and removes its interaction context references', () => {
  const previous = { ...classroom, scenes: [...classroom.scenes, {id:'removed',content:{type:'slide'}}, {id:'interaction',content:{type:'slide'},
    actions:[{type:'interaction_checkpoint',checkpointKind:'chapter_summary',context:{sourceSceneIds:['removed','scene']}}]}],
    mediaManifest:[...classroom.mediaManifest,{sceneId:'removed',elementId:'native-image'}],
    audioManifest:[{sceneId:'removed',actionId:'speech'},{sceneId:'scene',actionId:'kept'}] };
  const next = editor.pruneRemovedSceneBindings({...previous, scenes:previous.scenes.filter(scene=>scene.id!=='removed')},previous);
  assert.equal(next.mediaManifest.some(entry=>entry.sceneId==='removed'),false);
  assert.deepEqual(next.audioManifest.map(entry=>entry.actionId),['kept']);
  assert.deepEqual(next.scenes.at(-1).actions[0].context.sourceSceneIds,['scene']);
  assert.equal(previous.scenes.at(-1).actions[0].context.sourceSceneIds.length,2);
});
