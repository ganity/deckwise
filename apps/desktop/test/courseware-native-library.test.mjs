import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import ts from 'typescript';
const exports = {};
new Function('exports', ts.transpileModule(readFileSync(new URL('../electron/main/courseware-native-library.ts', import.meta.url), 'utf8'), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText)(exports);
const { routeNativeMediaLibrary } = exports;
test('sidebar lists pending tasks without submitting and adopts into the existing native slot', async () => {
  const view = { viewId: 'doc.page', project: { teachingRevision: 'r1' } }, calls = [];
  const service = kind => ({ jobs: async () => [{ kind, intentId: kind + '-task' }], execute: async (args, prepare) => {
    assert.equal(prepare, false); assert.equal(args.actionId, undefined); calls.push(kind); view.project.teachingRevision = 'r2'; return { applied: true };
  } });
  const input = { page: 1, args: {}, open: async () => ({ value: structuredClone(view) }), music: service('music'), video: service('video'), result: { value: { nativeService: true, embedded: [{ intentId: 'saved' }] } } };
  const list = await routeNativeMediaLibrary({ ...input, operation: 'media:list' });
  assert.deepEqual(list.value.map(m => m.intentId), ['saved', 'music-task', 'video-task']); assert.deepEqual(calls, []);
  const saved = await routeNativeMediaLibrary({ ...input, operation: 'media:adopt', args: { kind: 'video', intentId: 'video-task', actionId: 'new-sidebar-id' } });
  assert.equal(saved.value.project.teachingRevision, 'r2'); assert.deepEqual(calls, ['video']);
  await assert.rejects(routeNativeMediaLibrary({ ...input, operation: 'media:adopt', video: { ...input.video, execute: async () => ({ applied: false }) }, args: { kind: 'video' } }), /尚未完成/);
});
