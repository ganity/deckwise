import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('../../../scripts/stage-pptx-worker.mjs', import.meta.url));
const stage = (bundle, destination) =>
  execFileSync(process.execPath, [script, bundle, destination], { stdio: 'ignore' });

async function makeBundle(root) {
  const bundle = path.join(root, 'bundle');
  await mkdir(bundle);
  const content = Buffer.from('worker');
  await writeFile(path.join(bundle, 'pptx-worker.mjs'), content);
  await writeFile(
    path.join(bundle, 'manifest.json'),
    JSON.stringify({
      status: 'LOCAL_LINUX_WORKER_BUNDLE',
      platform: 'linux',
      arch: 'x64',
      files: [
        {
          path: 'pptx-worker.mjs',
          bytes: content.length,
          sha256: createHash('sha256').update(content).digest('hex'),
        },
      ],
    }),
  );
  return bundle;
}

test('stages a manifest-verified Linux worker bundle into a new directory', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'pptx-worker-stage-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const bundle = await makeBundle(root);
  const destination = path.join(root, 'resources', 'pptx-worker');

  stage(bundle, destination);

  assert.equal(await readFile(path.join(destination, 'pptx-worker.mjs'), 'utf8'), 'worker');
  assert.equal(
    await readFile(path.join(destination, 'manifest.json'), 'utf8'),
    await readFile(path.join(bundle, 'manifest.json'), 'utf8'),
  );
});

test('rejects modified bundle files without creating a destination', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'pptx-worker-stage-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const bundle = await makeBundle(root);
  await writeFile(path.join(bundle, 'pptx-worker.mjs'), 'modified');
  const destination = path.join(root, 'resources', 'pptx-worker');

  assert.throws(() => stage(bundle, destination));
  await assert.rejects(readFile(destination));
});

test('preserves an existing staging destination', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'pptx-worker-stage-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const bundle = await makeBundle(root);
  const destination = path.join(root, 'resources', 'pptx-worker');
  await mkdir(destination, { recursive: true });
  await writeFile(path.join(destination, 'sentinel'), 'preserve');

  assert.throws(() => stage(bundle, destination));
  assert.equal(await readFile(path.join(destination, 'sentinel'), 'utf8'), 'preserve');
});

test('checks staged resources without changing them and rejects same-size corruption', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'pptx-worker-stage-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const bundle = await makeBundle(root);
  const manifest = await readFile(path.join(bundle, 'manifest.json'), 'utf8');
  const check = () => execFileSync(process.execPath, [script, '--check', bundle], { stdio: 'pipe' });

  assert.equal(JSON.parse(check().toString()).status, 'VERIFIED');
  assert.equal(await readFile(path.join(bundle, 'manifest.json'), 'utf8'), manifest);
  await writeFile(path.join(bundle, 'pptx-worker.mjs'), 'broken');
  assert.throws(check, /Hash mismatch/);
});

test('rejects unlisted files, unsafe paths, and a missing worker entry', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'pptx-worker-stage-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const bundle = await makeBundle(root);
  const destination = path.join(root, 'staged');
  await writeFile(path.join(bundle, 'unlisted'), 'extra');
  assert.throws(() => stage(bundle, destination));
  await rm(path.join(bundle, 'unlisted'));
  const manifest = JSON.parse(await readFile(path.join(bundle, 'manifest.json'), 'utf8'));
  manifest.files[0].path = '../outside';
  await writeFile(path.join(bundle, 'manifest.json'), JSON.stringify(manifest));
  assert.throws(() => stage(bundle, destination));
  manifest.files[0].path = 'other.mjs';
  await writeFile(path.join(bundle, 'other.mjs'), 'worker');
  await writeFile(path.join(bundle, 'manifest.json'), JSON.stringify(manifest));
  assert.throws(() => stage(bundle, destination));
  await assert.rejects(readFile(destination));
});

test('courseware Linux packaging checks the worker before using existing release commands', async () => {
  const { scripts, build } = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  assert.match(scripts['check:pptx-worker'], /stage-pptx-worker\.mjs --check/);
  assert.match(scripts['pack:courseware:linux'], /test:authoring-bundle/);
  assert.match(scripts['dist:courseware:linux'], /test:authoring-bundle/);
  assert(build.extraResources.some(resource => resource.from === 'resources/pptx-worker' && resource.to === 'pptx-worker'));
  for (const platform of ['linux', 'mac', 'win'])
    assert(!build[platform].extraResources.some(resource => /authoring\.mjs$/.test(resource.from)), 'Do not overwrite an inventoried worker file');
  assert.equal(build.beforePack, './build/courseware-release.mjs');
  assert.equal(build.afterPack, './build/courseware-release.mjs');
});
