import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
const exports = {};
new Function('exports', ts.transpileModule(readFileSync(new URL('../electron/main/courseware-native-repairs.ts', import.meta.url), 'utf8'), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText)(exports);
const { nativeRepairStore } = exports;
test('native repair adapter pins scope, forwards CAS and fences stale ownership', async () => {
  let owned = true, state = { revision: 0, failures: {} }, writes = 0;
  const host = { async call(method, args) {
    assert.equal(args.sourcePath, '/workspace/lesson.pptx'); assert.equal(args.sessionId, 'chat'); assert.equal(args.projectId, 'native');
    if (method.endsWith('.write')) { assert.equal(args.expectedRevision, state.revision); writes++; state = { revision: state.revision + 1, failures: args.failures }; }
    return structuredClone(state);
  } };
  const create = () => nativeRepairStore(host, '/workspace/lesson.pptx', async () => { if (!owned) throw Error('owner changed'); });
  const first = await create().read('chat', 'native');
  await create().write('chat', 'native', first, { p1: 'Required repair pending' });
  assert.deepEqual(await create().read('chat', 'native'), state);
  await assert.rejects(create().write('chat', 'native', first, {})); assert.equal(writes, 1);
  owned = false; await assert.rejects(create().read('chat', 'native'), /owner changed/);
});
test('corrupt or unavailable repair state cannot become an empty successful read', async () => {
  for (const value of [null, {}, { revision: -1, failures: {} }, { revision: 1, failures: [] }, { revision: 1, failures: { p: '' } }]) {
    const store = nativeRepairStore({ call: async () => value }, '/workspace/lesson.pptx', async () => {});
    await assert.rejects(store.read('chat', 'native'), /Invalid saved/);
  }
  const store = nativeRepairStore({ call: async () => { throw Error('disk unavailable'); } }, '/workspace/lesson.pptx', async () => {});
  await assert.rejects(store.read('chat', 'native'), /disk unavailable/);
});


test('narration reservations retain semantic failures and reject corrupt budgets', async () => {
  let state = { revision: 3, failures: { p1: 'Required repair pending' } };
  const store = nativeRepairStore({ call: async (_method, args) => {
    assert.equal(args.expectedRevision, 3);
    assert.deepEqual(args.failures, state.failures);
    return { ...state, revision: 4, narration: args.narration };
  } }, '/workspace/lesson.pptx', async () => {});
  const budget = { turnId: 'turn', pages: { ['a'.repeat(64)]: { attempts: 2 } } };
  assert.deepEqual((await store.writeNarration('chat', 'native', state, budget)).narration, budget);
  for (const narration of [null, {}, { turnId: 't', pages: { bad: { attempts: 1 } } },
    { turnId: 't', pages: { ['a'.repeat(64)]: { attempts: 4 } } }]) {
    const broken = nativeRepairStore({ call: async () => ({ ...state, narration }) }, '/workspace/lesson.pptx', async () => {});
    await assert.rejects(broken.read('chat', 'native'), /Invalid saved native repair state/);
  }
});
