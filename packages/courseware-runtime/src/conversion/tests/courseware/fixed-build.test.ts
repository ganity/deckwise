import { mkdtemp, readFile, readdir, rm, writeFile, cp } from 'node:fs/promises';
import os from 'node:os';
import JSZip from 'jszip';
import path from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { buildFixedCourseware, sha256, validateFixedMapping } from '../../lib/courseware/fixed-build';
import { adaptCanonicalSnapshot } from '../../lib/courseware/adapt-canonical-snapshot';
import type { FixedBuildInput } from '../../lib/courseware/fixed-build-input';
import { loadFixedBuild } from '../../../player/lib/courseware/load-fixed-build';

const fixture = path.resolve('tests/fixtures/fixed-courseware');
const workerDirectory = path.resolve('../../apps/desktop/resources/pptx-worker');
let input: FixedBuildInput;
let outputDirectory: string;
let valid: Awaited<ReturnType<typeof buildFixedCourseware>>;
beforeAll(async () => {
  input = JSON.parse(await readFile(path.join(fixture, 'snapshot.json'), 'utf8'));
  input.source.path = path.join(fixture, 'lesson-r8.pptx');
  input.assets.forEach((asset, i) => {
    asset.path = path.join(fixture, `page-${i + 1}.wav`);
  });
  input.converter.manifestSha256 = sha256(
    await readFile(path.join(workerDirectory, 'manifest.json')),
  );
  outputDirectory = await mkdtemp(path.join(os.tmpdir(), 'fixed-build-'));
  valid = await buildFixedCourseware(input, { workerDirectory, outputDirectory });
}, 30_000);
afterAll(async () => {
  await rm(outputDirectory, { recursive: true, force: true });
});

it('rejects an unknown schema before executing conversion', async () => {
  await expect(
    buildFixedCourseware(
      { ...input, schemaVersion: 'unknown' },
      { workerDirectory, outputDirectory },
    ),
  ).rejects.toMatchObject({ code: 'SNAPSHOT_SCHEMA_INVALID' });
});
it('rejects a bad source hash and leaves the previous package intact', async () => {
  const bad = structuredClone(input);
  bad.source.sha256 = '0'.repeat(64);
  bad.teaching.sourceSha256 = bad.mapping.sourceSha256 = bad.source.sha256;
  await expect(
    buildFixedCourseware(bad, { workerDirectory, outputDirectory }),
  ).rejects.toMatchObject({ code: 'HASH_MISMATCH' });
  expect(await readdir(outputDirectory)).toEqual([valid.buildId]);
});
it('rejects missing and corrupt fixed audio', async () => {
  const bad = structuredClone(input);
  bad.assets[0].path = path.join(outputDirectory, 'missing.wav');
  await expect(
    buildFixedCourseware(bad, { workerDirectory, outputDirectory }),
  ).rejects.toMatchObject({ code: 'ASSET_MISSING_OR_OVERSIZED' });
  bad.assets[0].path = input.assets[0].path;
  bad.assets[0].sha256 = '0'.repeat(64);
  await expect(
    buildFixedCourseware(bad, { workerDirectory, outputDirectory }),
  ).rejects.toMatchObject({ code: 'HASH_MISMATCH' });
});
it('counts embedded PPTX media in the playback budget before publishing', async () => {
  const budget = 256 * 1024 * 1024;
  const payload = JSON.parse(await readFile(path.join(valid.directory, 'package.json'), 'utf8'));
  let embeddedBytes = 0;
  for (const asset of payload.assets) {
    if (!input.assets.some((external) => external.id === asset.id))
      embeddedBytes += (await readFile(path.join(valid.directory, asset.path))).length;
  }
  expect(embeddedBytes).toBeGreaterThan(0);
  let narrationBytes = 0;
  for (const asset of input.assets) narrationBytes += (await readFile(asset.path)).length;
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'fixed-budget-'));
  const block = Buffer.alloc(4 * 1024 * 1024);
  const blockPath = path.join(temporary, 'block.png');
  await writeFile(blockPath, block);
  const originalManifest = await readFile(path.join(valid.directory, 'manifest.json'));
  try {
    for (const overflow of [0, 1]) {
      const candidate = structuredClone(input);
      let remaining = budget - narrationBytes - embeddedBytes + overflow;
      while (remaining >= block.length) {
        candidate.assets.push({
          id: `budget-${candidate.assets.length}`, path: blockPath,
          sha256: sha256(block), mimeType: 'image/png',
        });
        remaining -= block.length;
      }
      const tail = Buffer.alloc(remaining);
      const tailPath = path.join(temporary, `tail-${overflow}.png`);
      await writeFile(tailPath, tail);
      candidate.assets.push({
        id: 'budget-tail', path: tailPath, sha256: sha256(tail), mimeType: 'image/png',
      });
      const before = await readdir(outputDirectory);
      const result = buildFixedCourseware(candidate, { workerDirectory, outputDirectory });
      if (overflow) {
        await expect(result).rejects.toMatchObject({ code: 'ASSET_BUDGET_EXCEEDED' });
        expect(await readdir(outputDirectory)).toEqual(before);
      } else {
        const accepted = await result;
        expect(accepted.report.ready).toBe(true);
        expect(accepted.directory).not.toBe(valid.directory);
        await rm(accepted.directory, { recursive: true });
      }
    }
    expect(await readFile(path.join(valid.directory, 'manifest.json'))).toEqual(originalManifest);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}, 30_000);
it('rejects a different pinned converter and stale teaching/mapping revisions', async () => {
  const bad = structuredClone(input);
  bad.converter.manifestSha256 = '0'.repeat(64);
  await expect(
    buildFixedCourseware(bad, { workerDirectory, outputDirectory }),
  ).rejects.toMatchObject({ code: 'CONVERTER_HASH_MISMATCH' });
  bad.converter = input.converter;
  bad.teaching.sourceSha256 = '0'.repeat(64);
  await expect(
    buildFixedCourseware(bad, { workerDirectory, outputDirectory }),
  ).rejects.toMatchObject({ code: 'STALE_INPUT_REVISION' });
});
it('rejects incorrect page/object bindings', async () => {
  const bad = structuredClone(input);
  bad.mapping.pages[0].objects[0].importElementId = 'absent-object';
  await expect(
    buildFixedCourseware(bad, { workerDirectory, outputDirectory }),
  ).rejects.toMatchObject({ code: 'OBJECT_BINDING_MISMATCH' });
});
it('requires explicit review of warning diagnostics', async () => {
  await expect(
    buildFixedCourseware(
      { ...input, reviewedWarningCodes: [] },
      { workerDirectory, outputDirectory },
    ),
  ).rejects.toMatchObject({ code: 'CONTENT_REVIEW_REQUIRED' });
});
it('produces the same content identity from identical fixed inputs and archives media', async () => {
  const second = await buildFixedCourseware(input, { workerDirectory, outputDirectory });
  expect(second.buildId).toBe(valid.buildId);
  const payload = JSON.parse(await readFile(path.join(valid.directory, 'package.json'), 'utf8'));
  expect(payload.pages).toHaveLength(3);
  expect(
    payload.assets.filter((a: { mimeType: string }) => a.mimeType.startsWith('video/')),
  ).toHaveLength(1);
  expect(valid.report.visualFidelity).toBe('NOT_VERIFIED');
  expect(valid.report.capabilities.objectAnimations).toBe(false);
});
it('builds a canonical teacher-continue checkpoint into the fixed package', async () => {
  const candidate = structuredClone(input);
  candidate.teaching.pages[0].actions = [{ id: 'teacher-continue', type: 'interaction_checkpoint', checkpointId: 'teacher-continue', checkpointKind: 'teacher_continue' }];
  const built = await buildFixedCourseware(candidate, { workerDirectory, outputDirectory });
  const playback = JSON.parse(await readFile(path.join(built.directory, 'package.json'), 'utf8'));
  expect(playback.pages[0].actions[0]).toEqual(candidate.teaching.pages[0].actions[0]);
  await rm(built.directory, { recursive: true });
});
it('builds and loads repeated page-local narration IDs with independent visual cues', async () => {
  const raw = JSON.parse(await readFile(path.join(fixture, 'canonical-animations.json'), 'utf8'));
  raw.files.sourcePath = input.source.path;
  raw.files.assets = input.assets;
  raw.files.converter = input.converter;
  raw.project.pages = input.teaching.pages.map((page, index) => ({
    ...page, locked: false, reviewState: 'ready',
    actions: page.actions.map((action) => action.type !== 'speech' ? action : {
      ...action, id: 'narration-0', visualCues: [{
        id: 'cue-0', atMs: 0, endMs: 200,
        effect: { type: 'highlight', elementIds: [input.mapping.pages[index].objects[0].objectId],
          color: ['#112233', '#445566', '#778899'][index] },
      }],
    }),
  }));
  raw.project.teachingRevision = raw.snapshot.teachingRevision = input.teaching.revision;
  const before = JSON.stringify(raw);
  const candidate = adaptCanonicalSnapshot(raw.project, raw.snapshot, raw.files);
  const built = await buildFixedCourseware(candidate, { workerDirectory, outputDirectory });
  const bytes = await readFile(path.join(built.directory, 'package.json'));
  const loaded = await loadFixedBuild(bytes, built.buildId,
    async (asset) => readFile(path.join(built.directory, asset.path)));
  try {
    expect(loaded.scenes).toHaveLength(3);
    const speechIds: string[] = [];
    loaded.scenes.forEach((page, index) => {
      const speech = page.actions?.find((action) => action.type === 'speech');
      expect(speech?.type).toBe('speech');
      if (!speech || speech.type !== 'speech') throw new Error('Expected fixed speech');
      speechIds.push(speech.id);
      expect(speech.audioId).toBe(input.teaching.pages[index].actions[0].type === 'speech'
        ? input.teaching.pages[index].actions[0].audioAssetId : undefined);
      expect(loaded.speechVisualCues.get(speech.id)?.[0].effect).toMatchObject({
        kind: 'highlight', color: ['#112233', '#445566', '#778899'][index],
      });
    });
    expect(new Set(speechIds).size).toBe(3);
    expect(JSON.stringify(raw)).toBe(before);
  } finally {
    loaded.dispose();
    await rm(built.directory, { recursive: true });
  }
});
it('keeps R8 package bytes unchanged while a working file becomes R9', async () => {
  const working = path.join(outputDirectory, 'working.pptx');
  await cp(input.source.path, working);
  const before = await readFile(path.join(valid.directory, 'source.pptx'));
  await writeFile(working, Buffer.from('R9 edited working file'));
  expect(sha256(await readFile(path.join(valid.directory, 'source.pptx')))).toBe(sha256(before));
  const changed = structuredClone(input);
  changed.source.path = working;
  await expect(
    buildFixedCourseware(changed, { workerDirectory, outputDirectory }),
  ).rejects.toMatchObject({ code: 'HASH_MISMATCH' });
  await rm(working);
});

it('cannot acknowledge away linked-text content errors or replace the valid build', async () => {
  const zip = await JSZip.loadAsync(await readFile(input.source.path));
  const xml = await zip.file('ppt/slides/slide1.xml')!.async('string');
  const linked = xml.replace('</a:bodyPr>', '<a:linkedTxbx id="1" seq="0"/></a:bodyPr>');
  expect(linked).not.toBe(xml);
  zip.file('ppt/slides/slide1.xml', linked);
  const bytes = await zip.generateAsync({ type: 'nodebuffer' });
  const file = path.join(outputDirectory, 'linked.pptx');
  await writeFile(file, bytes);
  const bad = structuredClone(input);
  bad.source.path = file;
  bad.source.sha256 = bad.teaching.sourceSha256 = bad.mapping.sourceSha256 = sha256(bytes);
  bad.reviewedWarningCodes.push('PPTX_LINKED_TEXT_UNVERIFIED');
  await expect(
    buildFixedCourseware(bad, { workerDirectory, outputDirectory }),
  ).rejects.toMatchObject({
    code: 'CONTENT_ERROR',
    diagnostics: expect.arrayContaining([
      expect.objectContaining({ code: 'PPTX_LINKED_TEXT_UNVERIFIED', severity: 'error' }),
    ]),
  });
  await rm(file);
  expect(await readdir(outputDirectory)).toEqual([valid.buildId]);
});

it('archives fixed audio cues with logical bindings and advertises only player effects', async () => {
  const effects = JSON.parse(await readFile(path.join(fixture, 'snapshot-effects.json'), 'utf8'));
  effects.source = input.source;
  effects.assets = input.assets;
  effects.converter = input.converter;
  const result = await buildFixedCourseware(effects, { workerDirectory, outputDirectory });
  const repeated = await buildFixedCourseware(effects, { workerDirectory, outputDirectory });
  expect(repeated.buildId).toBe(result.buildId);
  expect(result.buildId).not.toBe(valid.buildId);
  expect(result.report.capabilities).toMatchObject({
    spotlight: true,
    speechVisualCues: 'fixed-audio/1',
    objectAnimations: false,
    transitions: false,
  });
  const payload = JSON.parse(await readFile(path.join(result.directory, 'package.json'), 'utf8'));
  expect(payload.pages[0].actions[0].visualCues[0].effect.elementIds).toEqual([
    'fixture-object-1-1',
  ]);
  await rm(result.directory, { recursive: true });
});
it('rejects cue intervals, duplicate cue IDs, and render/cross-page IDs used as logical targets', async () => {
  const effects: FixedBuildInput = JSON.parse(
    await readFile(path.join(fixture, 'snapshot-effects.json'), 'utf8'),
  );
  effects.source = input.source;
  effects.assets = input.assets;
  effects.converter = input.converter;
  const speech = effects.teaching.pages[0].actions[0];
  if (speech.type !== 'speech' || !speech.visualCues) throw new Error('Missing cue fixture');
  speech.visualCues[0].endMs = speech.visualCues[0].atMs;
  await expect(
    buildFixedCourseware(effects, { workerDirectory, outputDirectory }),
  ).rejects.toMatchObject({ code: 'SNAPSHOT_SCHEMA_INVALID' });
  speech.visualCues[0].endMs = 2000;
  // validateFixedMapping only needs these identity fields; real conversion is checked above.
  const ir = {
    pages: effects.mapping.pages.map((p) => ({
      id: p.importPageId,
      elements: p.objects.map((o) => ({
        id: o.importElementId,
        type: 'shape',
        width: 100,
        height: 100,
      })),
    })),
  } as Parameters<typeof validateFixedMapping>[1];
  speech.visualCues[1].id = speech.visualCues[0].id;
  expect(() => validateFixedMapping(effects, ir)).toThrow('DUPLICATE_VISUAL_CUE_ID');
  speech.visualCues[1].id = 'spotlight';
  if (speech.visualCues[0].effect.type !== 'highlight') throw new Error('Missing highlight');
  for (const id of ['pptx_shape_2', 'fixture-object-3-1']) {
    speech.visualCues[0].effect.elementIds = [id];
    expect(() => validateFixedMapping(effects, ir)).toThrow('EFFECT_BINDING_MISMATCH');
  }
  speech.visualCues[0].effect.elementIds = ['fixture-object-1-1'];
  ir.pages[0].elements[1].type = 'line';
  expect(() => validateFixedMapping(effects, ir)).toThrow('EFFECT_TARGET_UNSUPPORTED');
});

it('builds canonical fixed exports and limited player animations with stable identity', async () => {
  const bundle = JSON.parse(
    await readFile(path.join(fixture, 'canonical-animations.json'), 'utf8'),
  );
  bundle.files.sourcePath = input.source.path;
  bundle.files.assets = input.assets;
  bundle.files.converter = input.converter;
  const adapted = adaptCanonicalSnapshot(bundle.project, bundle.snapshot, bundle.files);
  const built = await buildFixedCourseware(adapted, { workerDirectory, outputDirectory });
  const repeated = await buildFixedCourseware(adapted, { workerDirectory, outputDirectory });
  expect(repeated.buildId).toBe(built.buildId);
  expect(built.report.capabilities).toMatchObject({
    objectAnimations: false,
    transitions: false,
    playerObjectAnimations: 'fade-pulse/1',
    speechVisualCues: 'fixed-audio/2',
  });
  await rm(built.directory, { recursive: true });
});
it('adapts authored multi-object attention cues into fixed audio playback without replacing narration or waits', async () => {
  const bundle = JSON.parse(await readFile(path.join(fixture, 'canonical-animations.json'), 'utf8'));
  bundle.files.sourcePath = input.source.path;
  bundle.files.assets = input.assets;
  bundle.files.converter = input.converter;
  bundle.project.taskType = 'scene';
  const speech = bundle.project.pages[0].actions[0];
  const original = structuredClone(speech);
  const checkpoint = { id: 'authored-wait', type: 'interaction_checkpoint', checkpointId: 'authored-wait', checkpointKind: 'teacher_continue' };
  const targets = ['fixture-object-1-1', 'fixture-object-1-2'];
  const cues = [
    { id: 'authored-highlight', atMs: 0, endMs: 1000, effect: { type: 'highlight', elementIds: targets } },
    { id: 'authored-spotlight', atMs: 1000, endMs: 2000, effect: { type: 'spotlight', elementId: targets[0], elementIds: targets.slice(1) } },
  ];
  speech.visualCues.push(...cues);
  bundle.project.pages[0].actions.push(checkpoint);
  const before = JSON.stringify(bundle);
  const candidate = adaptCanonicalSnapshot(bundle.project, bundle.snapshot, bundle.files);
  const built = await buildFixedCourseware(candidate, { workerDirectory, outputDirectory });
  const bytes = await readFile(path.join(built.directory, 'package.json'));
  const payload = JSON.parse(bytes.toString());
  const loaded = await loadFixedBuild(bytes, built.buildId,
    async (asset) => readFile(path.join(built.directory, asset.path)));
  try {
    expect(payload.pages[0].actions[0]).toEqual({ ...original, visualCues: [...original.visualCues, ...cues] });
    expect(payload.pages[0].actions.at(-1)).toEqual(checkpoint);
    const fixedSpeech = loaded.scenes[0].actions?.find((action) => action.id === speech.id);
    expect(fixedSpeech).toMatchObject({ type: 'speech', text: original.text, audioId: original.audioAssetId });
    const fixedCues = loaded.speechVisualCues.get(speech.id);
    expect(fixedCues?.find((cue) => cue.id === 'authored-highlight')).toMatchObject({
      atMs: 0, endMs: 1000, effect: { kind: 'highlight', targetIds: ['pptx_shape_2', 'pptx_text_3'] },
    });
    expect(fixedCues?.find((cue) => cue.id === 'authored-spotlight')).toMatchObject({
      atMs: 1000, endMs: 2000, effect: { kind: 'spotlight', targetId: 'pptx_shape_2', elementIds: ['pptx_text_3'] },
    });
    expect(loaded.scenes[0].actions?.at(-1)).toMatchObject({ type: 'interaction_checkpoint', checkpointKind: 'teacher_continue' });
    expect(built.report.capabilities).toMatchObject({ spotlight: true, objectAnimations: false, transitions: false });
    expect(JSON.stringify(bundle)).toBe(before);
  } finally {
    loaded.dispose();
    await rm(built.directory, { recursive: true });
  }
});
it('rejects unsupported player effects, duplicate animated targets and media animation targets', async () => {
  const animated: FixedBuildInput = JSON.parse(
    await readFile(path.join(fixture, 'snapshot-animations.json'), 'utf8'),
  );
  const action = animated.teaching.pages[0].actions[0];
  if (action.type !== 'speech' || !action.visualCues) throw new Error('Missing animation fixture');
  const ir = {
    pages: animated.mapping.pages.map((p) => ({
      id: p.importPageId,
      elements: p.objects.map((o) => ({
        id: o.importElementId,
        type: 'shape',
        width: 100,
        height: 100,
      })),
    })),
  } as Parameters<typeof validateFixedMapping>[1];
  const cue = action.visualCues.find((c) => c.effect.type === 'element_animation')!;
  action.visualCues.push({ ...cue, id: 'conflicting-target' });
  expect(() => validateFixedMapping(animated, ir)).toThrow('ANIMATION_TARGET_CONFLICT');
  action.visualCues.pop();
  ir.pages[0].elements[0].type = 'video';
  expect(() => validateFixedMapping(animated, ir)).toThrow('ANIMATION_TARGET_UNSUPPORTED');
  cue.endMs = cue.atMs + 5001;
  await expect(
    buildFixedCourseware(animated, { workerDirectory, outputDirectory }),
  ).rejects.toMatchObject({ code: 'SNAPSHOT_SCHEMA_INVALID' });
  cue.endMs = cue.atMs + 800;
  const unknown = JSON.parse(JSON.stringify(animated));
  unknown.teaching.pages[0].actions[0].visualCues.find(
    (c: { effect: { type: string } }) => c.effect.type === 'element_animation',
  ).effect.effect = 'arbitrary-effect';
  await expect(
    buildFixedCourseware(unknown, { workerDirectory, outputDirectory }),
  ).rejects.toMatchObject({ code: 'SNAPSHOT_SCHEMA_INVALID' });
});

it('builds actual A8 speech actions with explicit fixture audio and stable fixed identity', async () => {
  const bundle = JSON.parse(await readFile(
    path.resolve('tests/fixtures/a8-narration/canonical-fixed-audio.json'), 'utf8',
  ));
  bundle.files.sourcePath = input.source.path;
  bundle.files.assets = input.assets.slice(0, 2);
  bundle.files.converter = input.converter;
  const adapted = adaptCanonicalSnapshot(bundle.project, bundle.snapshot, bundle.files);
  const built = await buildFixedCourseware(adapted, { workerDirectory, outputDirectory });
  const repeated = await buildFixedCourseware(adapted, { workerDirectory, outputDirectory });
  expect(repeated.buildId).toBe(built.buildId);
  const payload = JSON.parse(await readFile(path.join(built.directory, 'package.json'), 'utf8'));
  expect(payload.pages[0].actions).toEqual(bundle.project.pages[0].actions);
  expect(payload.pages[0].actions[0].pauseAfterMs).toBe(4000);
  expect(payload.assets.filter((asset: { mimeType: string }) => asset.mimeType === 'audio/wav'))
    .toHaveLength(2);
  expect(built.report.visualFidelity).toBe('NOT_VERIFIED');
  expect(built.report.capabilities.objectAnimations).toBe(false);
  await rm(built.directory, { recursive: true });
});
