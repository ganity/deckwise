#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url));
const maic = resolve(process.env.MAIC_SERVER_ROOT || resolve(root, '../../evo-trainwise-maic-server'));
const require = createRequire(resolve(root, 'packages/courseware-runtime/package.json'));
const { build } = require('esbuild');
const JSZip = require('jszip');
const result = await build({ stdin: { contents: `export {ensureInteractionCheckpoint as authority} from '${maic}/lib/interaction/ensure-interaction-checkpoint.ts'; export {exportMaicClassroom} from '${root}/packages/courseware-runtime/src/conversion/lib/courseware/export-maic-classroom.ts';`, resolveDir: maic, loader: 'ts' }, bundle: true, write: false, platform: 'node', format: 'cjs', packages: 'external', plugins: [{ name: 'reference-alias', setup(builder) { builder.onResolve({ filter: /^@\// }, args => builder.resolve(resolve(maic, args.path.slice(2)), { resolveDir: maic, kind: args.kind })); } }] });
const module = { exports: {} };
new Function('require', 'module', 'exports', result.outputFiles[0].text)(require, module, module.exports);
const { authority, exportMaicClassroom } = module.exports;
const slide = (id, text) => ({ id, stageId: 'stage', type: 'slide', title: id, order: 1, content: { type: 'slide', canvas: { id, viewportSize: 1000, viewportRatio: 0.5625, theme: { backgroundColor: '#fff', themeColors: [], fontColor: '#000', fontName: 'Arial' }, elements: [{ id: `${id}_question`, type: 'text', content: `<p>${text}</p>`, left: 0, top: 0, width: 800, height: 100, rotate: 0, defaultFontName: 'Arial', defaultColor: '#000' }] } }, actions: [] });
for (const context of [{ chapterSummary: '', sourceSceneIds: [] }, { chapterSummary: 'My authored summary', sourceSceneIds: ['lesson'] }, { chapterSummary: 'Question & context', sourceSceneIds: [] }]) {
  const lesson = slide('lesson', 'Source &amp; lesson');
  lesson.actions = [{ id: 'intro', type: 'speech', text: 'Actual lesson narration' }];
  const interaction = slide('interaction', 'Question &amp; context');
  interaction.metadata = { interaction: { kind: 'chapter_summary', chapterId: 'chapter', chapterTitle: 'Lesson' } };
  const question = context.chapterSummary === 'Question & context' ? 'Old question' : 'Question & context';
  interaction.actions = [{ id: 'speech', type: 'speech', text: 'Keep my exact narration' }, { id: 'checkpoint', type: 'interaction_checkpoint', checkpointId: 'checkpoint', checkpointKind: 'chapter_summary', chapterId: 'chapter', chapterTitle: 'Lesson', question, referenceAnswer: { summary: '', keyPoints: [], label: 'My reference' }, constraintPrompt: 'My constraint', context }];
  const classroom = { id: 'classroom', createdAt: '2026-11-04', stage: { id: 'stage', name: 'Lesson', createdAt: 0, updatedAt: 0 }, scenes: [lesson, interaction], mediaManifest: [], audioManifest: [] };
  const original = structuredClone(classroom);
  const expected = authority(interaction, classroom.scenes);
  const zip = await JSZip.loadAsync(await exportMaicClassroom(classroom, async () => { throw Error('No media expected'); }));
  const exported = JSON.parse(await zip.file('meta.json').async('string')).classroom;
  assert.deepEqual(exported.scenes[1], expected, 'Local archive must contain the actual MAIC checkpoint projection');
  if (question === 'Question & context') assert.deepEqual(authority(exported.scenes[1], exported.scenes), exported.scenes[1], 'MAIC must not repair a synchronized canonical checkpoint');
  assert.deepEqual(classroom, original, 'Export must preserve the editable draft');
}
console.log('PASS MAIC interaction export equals actual single-pass authority and preserves authored drafts (3 context cases); synchronized checkpoints remain stable on republish. The mismatched-question edge follows upstream single-pass behavior.');
