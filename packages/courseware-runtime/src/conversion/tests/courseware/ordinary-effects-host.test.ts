import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';
import { adaptCanonicalSnapshot } from '../../lib/courseware/adapt-canonical-snapshot';
import { buildFixedCourseware, sha256 } from '../../lib/courseware/fixed-build';
import { loadFixedBuild } from '../../../player/lib/courseware/load-fixed-build';

const hostTestBinary = process.env.DECKWISE_HOST_TEST_BIN;
const execute = promisify(execFile);

it.skipIf(!hostTestBinary)('loads actual Host-bound plain/import attention targets through worker, snapshot, compiler and player', async () => {
  if (!hostTestBinary) throw new Error('Set DECKWISE_HOST_TEST_BIN to the compiled Host test binary');
  const directory = await mkdtemp(path.join(os.tmpdir(), 'ordinary-effects-host-'));
  try {
    const fixture = path.resolve('tests/fixtures/fixed-courseware');
    const workerDirectory = path.resolve('../../apps/desktop/resources/pptx-worker');
    const sourcePath = path.join(fixture, 'lesson-r8.pptx');
    const parsed = path.join(directory, 'parsed');
    await execute(process.execPath, [path.join(workerDirectory, 'pptx-worker.mjs'), sourcePath, parsed],
      { timeout: 90_000, maxBuffer: 1024 * 1024, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } });
    const identity = JSON.parse(await readFile(path.join(parsed, 'identity.json'), 'utf8'));
    const audio = path.join(fixture, 'page-1.wav');
    const assets = [{ id: 'voice-1', path: audio, sha256: sha256(await readFile(audio)), mimeType: 'audio/wav' }];
    const hostInput = path.join(directory, 'host-input.json');
    await writeFile(hostInput, JSON.stringify({ identity, assets: assets.map(({ path: _path, ...asset }) => asset) }));
    const result = await execute(hostTestBinary, ['--exact',
      'db::courseware_projects::snapshots::tests::ordinary_attention_context_to_snapshot_fixture', '--nocapture'],
    { timeout: 30_000, maxBuffer: 4 * 1024 * 1024, env: { ...process.env, DECKWISE_EFFECT_HOST_INPUT: hostInput } });
    const prefix = 'DECKWISE_EFFECT_SNAPSHOT ';
    const snapshots = result.stdout.split('\n').filter(line => line.startsWith(prefix)).map(line => JSON.parse(line.slice(prefix.length)));
    expect(snapshots.map(snapshot => snapshot.project.taskType)).toEqual(['plain', 'import']);
    const fixtureInput = JSON.parse(await readFile(path.join(fixture, 'snapshot.json'), 'utf8'));
    for (const snapshot of snapshots) {
      const candidate = adaptCanonicalSnapshot(snapshot.project, snapshot.snapshot, {
        sourcePath, mapping: snapshot.mapping, assets,
        converter: { version: 'maic-pptx-import-ir/1', manifestSha256: sha256(await readFile(path.join(workerDirectory, 'manifest.json'))) },
        reviewedWarningCodes: fixtureInput.reviewedWarningCodes,
      });
      const built = await buildFixedCourseware(candidate, { workerDirectory, outputDirectory: path.join(directory, snapshot.project.taskType) });
      const bytes = await readFile(path.join(built.directory, 'package.json'));
      const payload = JSON.parse(bytes.toString());
      const loaded = await loadFixedBuild(bytes, built.buildId, async asset => readFile(path.join(built.directory, asset.path)));
      try {
        expect(built.report.capabilities).toMatchObject({ spotlight: true, objectAnimations: false, transitions: false });
        loaded.scenes.forEach((scene, index) => {
          const targets: string[] = snapshot.targets[index];
          const bindings: Array<{ objectId: string; importElementId: string }> = snapshot.mapping.pages[index].objects;
          const rendered = targets.map(target => {
            const binding = bindings.find(object => object.objectId === target);
            expect(binding).toBeDefined();
            expect(target).not.toBe(binding?.importElementId);
            expect(identity.pages[index].objects.some((object: { logicalId: string }) => object.logicalId === target)).toBe(false);
            return binding!.importElementId;
          });
          const speech = scene.actions?.find(action => action.type === 'speech');
          if (!speech || speech.type !== 'speech') throw new Error('Missing fixed narration');
          expect(speech.audioId).toBe('voice-1');
          expect(speech.text).toBe('Find the current objects.');
          expect(loaded.speechVisualCues.get(speech.id)).toMatchObject([
            { id: 'highlight', atMs: 0, endMs: 800, effect: { kind: 'highlight', targetIds: rendered } },
            { id: 'spotlight', atMs: 800, endMs: 1900, effect: { kind: 'spotlight', targetId: rendered[0], elementIds: rendered.slice(1) } },
          ]);
          expect(payload.pages[index].actions[0].visualCues[0].effect.elementIds).toEqual(targets);
          expect(scene.actions?.at(-1)).toMatchObject({ type: 'interaction_checkpoint', checkpointKind: 'teacher_continue' });
        });
      } finally { loaded.dispose(); }
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
}, 60_000);
