// Run from the repository root; the argument is an existing PPTX copied into an isolated profile.
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, copyFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
const { Host } = await import(pathToFileURL(resolve('scripts/e2e/host.mjs')).href);
assert(process.argv[2], 'Supply an existing PPTX fixture');
const root = await mkdtemp(join(tmpdir(), 'courseware-retry-rpc-'));
const profile = join(root, 'profile'), workspace = join(root, 'workspace');
const sourcePath = join(workspace, '.deckwise-ppt/imports/lesson.pptx');
const host = new Host(resolve('target/release/pi-desktop-host-core'), profile);
try {
  await mkdir(join(profile, 'plugins/market'), { recursive: true });
  await mkdir(join(workspace, '.deckwise-ppt/imports'), { recursive: true });
  await writeFile(join(profile, 'plugins/market/catalog.json'), JSON.stringify({ schemaVersion: 2, providerId: 'official', plugins: [] }));
  await copyFile(process.argv[2], sourcePath);
  await host.start();
  const { session } = await host.call('session.create', { title: 'Retry lifecycle fixture', mode: 'agent', projectPath: workspace });
  await host.call('courseware.task.set', { sessionId: session.id, taskType: 'import' });
  await host.call('courseware.task.attachImport', { sessionId: session.id, path: sourcePath });
  const key = { sessionId: session.id, projectId: 'native-fixture', sourcePath };
  assert.equal((await host.call('courseware.nativeRepairs.read', key)).revision, 0);
  const narration = { turnId: 'turn-fixture', pages: { ['a'.repeat(64)]: { attempts: 0, error: 'Visual JSON invalid', code: 'COURSEWARE_VISUAL_OUTPUT_INVALID' }, ['b'.repeat(64)]: { attempts: 3 } } };
  const saved = await host.call('courseware.nativeRepairs.write', { ...key, expectedRevision: 0, failures: { page: 'Required repair pending' }, narration });
  await host.stop(); await host.start();
  assert.deepEqual(await host.call('courseware.nativeRepairs.read', key), saved);
  await assert.rejects(host.call('courseware.nativeRepairs.write', { ...key, expectedRevision: 0, failures: {} }));
  const cleared = await host.call('courseware.nativeRepairs.write', { ...key, expectedRevision: saved.revision, failures: {} });
  assert.deepEqual(cleared.narration, narration);
  console.log('PASS: release Host RPC, task-owned PPTX, actual process restart, budget persistence, stale CAS rejection, guard clear preserves budget.');
} finally {
  await host.stop(); await rm(root, { recursive: true, force: true });
}
