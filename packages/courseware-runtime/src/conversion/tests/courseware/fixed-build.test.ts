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
const workerDirectory = path.resolve(process.env.DECKWISE_NATIVE_WORKER_DIRECTORY ?? '../../apps/desktop/resources/pptx-worker');
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
it('builds and loads an unsupported unbound native preset as a reported fade', async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'fixed-native-fallback-'));
  try {
    const zip = await JSZip.loadAsync(await readFile(input.source.path));
    const xml = await zip.file('ppt/slides/slide1.xml')!.async('string');
    const timing = (await readFile(path.join(fixture, 'native-fade-timing.xml'), 'utf8')).replace('presetID="10"', 'presetID="999"');
    zip.file('ppt/slides/slide1.xml', xml.replace('</p:sld>', `${timing}</p:sld>`));
    const bytes = await zip.generateAsync({ type: 'nodebuffer' }), candidate = structuredClone(input);
    candidate.source.path = path.join(temporary, 'native.pptx'); await writeFile(candidate.source.path, bytes);
    candidate.source.sha256 = candidate.mapping.sourceSha256 = candidate.teaching.sourceSha256 = sha256(bytes);
    const built = await buildFixedCourseware(candidate, { workerDirectory, outputDirectory: path.join(temporary, 'builds') });
    expect(built.report.ready).toBe(true);
    expect(built.report.diagnostics.some(d => d.code === 'PPTX_ANIMATION_FALLBACK_FADE')).toBe(true);
    const loaded = await loadFixedBuild(await readFile(path.join(built.directory, 'package.json')), built.buildId,
      async asset => new Uint8Array(await readFile(path.join(built.directory, asset.path))));
    const payload = JSON.parse(await readFile(path.join(built.directory, 'package.json'), 'utf8'));
    expect(payload.pages[0].nativeTimeline.steps[0].items[0]).toMatchObject({ effect: 'fadeIn', durationMs: 500 });
    expect(loaded.nativeTimeline).toBe(true);
    loaded.dispose();
  } finally { await rm(temporary, { recursive: true, force: true }); }
});
it('builds and loads attention after saved native entrance clicks but rejects a second animation owner', async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'fixed-native-attention-'));
  try {
    const zip = await JSZip.loadAsync(await readFile(input.source.path));
    const xml = await zip.file('ppt/slides/slide1.xml')!.async('string');
    const timing = await readFile(path.join(fixture, 'native-fade-timing.xml'), 'utf8');
    zip.file('ppt/slides/slide1.xml', xml.replace('</p:sld>', `${timing}</p:sld>`));
    const bytes = await zip.generateAsync({ type: 'nodebuffer' });
    const candidate = structuredClone(input);
    candidate.source.path = path.join(temporary, 'native.pptx');
    await writeFile(candidate.source.path, bytes);
    candidate.source.sha256 = candidate.mapping.sourceSha256 = candidate.teaching.sourceSha256 = sha256(bytes);
    const target = candidate.mapping.pages[0].objects.find(object => object.importElementId === 'pptx_text_1')!;
    expect(target).toBeDefined();
    const speech = candidate.teaching.pages[0].actions[0];
    if (speech.type !== 'speech') throw new Error('Expected fixed speech');
    speech.visualCues = [
      { id: 'highlight-native', atMs: 0, endMs: 200, effect: { type: 'highlight', elementIds: [target.objectId] } },
      { id: 'spotlight-native', atMs: 200, endMs: 400, effect: { type: 'spotlight', elementId: target.objectId } },
    ];
    const options = { workerDirectory, outputDirectory: path.join(temporary, 'builds') };
    const built = await buildFixedCourseware(candidate, options);
    const packageBytes = await readFile(path.join(built.directory, 'package.json'));
    const loaded = await loadFixedBuild(packageBytes, built.buildId, async asset => readFile(path.join(built.directory, asset.path)));
    try {
      expect(loaded.nativeAnimations?.get(candidate.mapping.pages[0].pageId)?.steps).toEqual([
        expect.objectContaining({ effect: 'fade', elementId: target.importElementId, durationMs: 500 }),
      ]);
      expect(loaded.scenes[0].actions?.slice(0, 3).map(action => action.type)).toEqual([
        'interaction_checkpoint', 'element_animation', 'speech',
      ]);
      expect(loaded.speechVisualCues.get(speech.id)?.map(cue => cue.effect)).toEqual([
        expect.objectContaining({ kind: 'highlight', targetIds: [target.importElementId] }),
        expect.objectContaining({ kind: 'spotlight', targetId: target.importElementId }),
      ]);
    } finally { loaded.dispose(); }
    speech.visualCues = [{ id: 'linked-native', atMs: 0, endMs: 600, trigger: { version: 1, kind: 'end' },
      nativeAnimation: target.objectId, effect: { type: 'element_animation', elementId: target.objectId, effect: 'fadeOut' } }];
    const linkedBuild = await buildFixedCourseware(candidate, { workerDirectory, outputDirectory: path.join(temporary, 'linked-builds') });
    const linkedBytes = await readFile(path.join(linkedBuild.directory, 'package.json'));
    const linked = await loadFixedBuild(linkedBytes, linkedBuild.buildId, async asset => readFile(path.join(linkedBuild.directory, asset.path)));
    try {
      expect(linked.nativeAnimations?.get(candidate.mapping.pages[0].pageId)).toBeUndefined();
      expect(linked.speechVisualCues.get(speech.id)).toEqual([expect.objectContaining({
        id: 'linked-native', atMs: 0, endMs: 500, trigger: { version: 1, kind: 'end' }, nativeAnimation: target.objectId,
        effect: expect.objectContaining({ kind: 'element_animation', action: expect.objectContaining({ effect: 'fadeIn', duration: 500 }) })
      })]);
      expect(linked.scenes[0].actions?.[0].type).toBe('speech');
    } finally { linked.dispose(); }
    for (const effect of ['fadeIn', 'fadeOut', 'pulse'] as const) {
      speech.visualCues = [{ id: 'competing-owner', atMs: 0, endMs: 200,
        effect: { type: 'element_animation', elementId: target.objectId, effect } }];
      await expect(buildFixedCourseware(candidate, options)).rejects.toMatchObject({ code: 'NATIVE_ANIMATION_CUE_CONFLICT' });
      expect(await readFile(path.join(built.directory, 'package.json'))).toEqual(packageBytes);
    }
    expect(await readdir(options.outputDirectory)).toEqual([built.buildId]);
  } finally { await rm(temporary, { recursive: true, force: true }); }
}, 30_000);
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
  const repeat = { ...action, id: 'repeat-speech', visualCues: [{ ...cue, id: 'repeat-pulse',
    effect: { type: 'element_animation' as const, elementId: cue.effect.type === 'element_animation' ? cue.effect.elementId : '', effect: 'pulse' as const } }] };
  animated.teaching.pages[0].actions.push(repeat);
  expect(() => validateFixedMapping(animated, ir)).not.toThrow();
  animated.teaching.pages[0].actions[animated.teaching.pages[0].actions.length - 1] = { ...action, id: 'repeat-entrance', visualCues: [{ ...cue, id: 'repeat-entrance-cue' }] };
  expect(() => validateFixedMapping(animated, ir)).toThrow('ANIMATION_TARGET_CONFLICT');
  animated.teaching.pages[0].actions.pop();
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

it('preserves an explicit delay through conversion and verified player loading', async () => {
  const candidate = structuredClone(input);
  candidate.teaching.pages[0].actions.push({ id: 'explicit-delay', type: 'delay', durationMs: 1200 });
  const result = await buildFixedCourseware(candidate, { workerDirectory, outputDirectory });
  const bytes = await readFile(path.join(result.directory, 'package.json'));
  const manifest = JSON.parse(bytes.toString('utf8'));
  expect(manifest.pages[0].actions.at(-1)).toEqual({ id: 'explicit-delay', type: 'delay', durationMs: 1200 });
  const loaded = await loadFixedBuild(new Uint8Array(bytes), sha256(bytes), async asset =>
    new Uint8Array(await readFile(path.join(result.directory, asset.path))));
  expect(loaded.scenes[0].actions!.at(-1)).toEqual({ id: 'explicit-delay', type: 'delay', durationMs: 1200 });
  loaded.dispose();
});

it('exports source-bound native nodes between speech and teacher waits, rejecting stale or incomplete bindings', async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'fixed-native-timeline-'));
  try {
    const zip = await JSZip.loadAsync(await readFile(input.source.path));
    const xml = await zip.file('ppt/slides/slide1.xml')!.async('string');
    const timing = await readFile(path.join(fixture, 'native-fade-timing.xml'), 'utf8');
    const block = timing.slice(timing.indexOf('                <p:par>'), timing.lastIndexOf('\n              </p:childTnLst>'));
    const second = block.replace(/id="([345])"/g, (_, id) => `id="${Number(id) + 3}"`).replace('spid="2"', 'spid="3"');
    zip.file('ppt/slides/slide1.xml', xml.replace('</p:sld>', `${timing.replace(block, block + second)}</p:sld>`));
    const bytes = await zip.generateAsync({ type: 'nodebuffer' });
    const candidate = structuredClone(input);
    candidate.source.path = path.join(temporary, 'native.pptx'); await writeFile(candidate.source.path, bytes);
    candidate.source.sha256 = candidate.mapping.sourceSha256 = candidate.teaching.sourceSha256 = sha256(bytes);
    const node = (stepIndex: number) => ({ id: `native-${stepIndex}`, type: 'native_animation' as const, version: 1 as const,
      sourceSha256: candidate.source.sha256, stepIndex });
    const speech = candidate.teaching.pages[0].actions[0];
    if (speech.type !== 'speech') throw new Error('Expected speech');
    const mapping = candidate.mapping.pages[0].objects;
    const first = mapping.find(object => object.importElementId === 'pptx_text_1')!;
    const secondTarget = mapping.find(object => object.importElementId === 'pptx_shape_2')!;
    const middle = { ...speech, id: 'middle', visualCues: [{ id: 'h', atMs: 0, endMs: 200,
      effect: { type: 'highlight' as const, elementIds: [first.objectId] } }] };
    const end = { ...speech, id: 'last', visualCues: [{ id: 's', atMs: 0, endMs: 200,
      effect: { type: 'spotlight' as const, elementId: secondTarget.objectId } }] };
    candidate.teaching.pages[0].actions = [speech, node(0), middle,
      { id: 'wait', type: 'interaction_checkpoint', checkpointId: 'wait', checkpointKind: 'teacher_continue' },
      { id: 'delay', type: 'delay', durationMs: 300 }, node(1), end];
    const options = { workerDirectory, outputDirectory: path.join(temporary, 'builds') };
    const built = await buildFixedCourseware(candidate, options);
    const packageBytes = await readFile(path.join(built.directory, 'package.json'));
    const loaded = await loadFixedBuild(packageBytes, built.buildId, async asset => readFile(path.join(built.directory, asset.path)));
    try {
      expect(built.report.capabilities.nativeObjectAnimations).toBe('click-appear-fade/2');
      expect(loaded.nativeAnimations?.get(candidate.mapping.pages[0].pageId)).toMatchObject({ version: 2, sequence: 'teaching-timeline',
        steps: [{ elementId: first.importElementId }, { elementId: secondTarget.importElementId }] });
      expect(loaded.scenes[0].actions?.map(action => action.type)).toEqual([
        'speech', 'element_animation', 'speech', 'interaction_checkpoint', 'delay', 'element_animation', 'speech',
      ]);
      expect(loaded.scenes[0].actions?.[1]).toMatchObject({ id: 'native-0', elementId: first.importElementId, duration: 500 });
      expect(loaded.scenes[0].actions?.[5]).toMatchObject({ id: 'native-1', elementId: secondTarget.importElementId, duration: 500 });
    } finally { loaded.dispose(); }
    const original = structuredClone(candidate.teaching.pages[0].actions);
    for (const kind of ['stale', 'missing', 'reordered', 'hidden'] as const) {
      const actions = candidate.teaching.pages[0].actions = structuredClone(original);
      if (kind === 'stale') Object.assign(actions[1], { sourceSha256: 'f'.repeat(64) });
      if (kind === 'missing') actions.splice(5, 1);
      if (kind === 'reordered') [actions[1], actions[5]] = [actions[5], actions[1]];
      if (kind === 'hidden') [actions[0], actions[6]] = [actions[6], actions[0]];
      await expect(buildFixedCourseware(candidate, options)).rejects.toMatchObject({ code:
        kind === 'hidden' ? 'NATIVE_ANIMATION_TARGET_NOT_REVEALED' : 'NATIVE_ANIMATION_BINDING_MISMATCH' });
      expect(await readFile(path.join(built.directory, 'package.json'))).toEqual(packageBytes);
    }
    expect(await readdir(options.outputDirectory)).toEqual([built.buildId]);
  } finally { await rm(temporary, { recursive: true, force: true }); }
}, 30_000);

it('builds saved WiseOffice motion groups with exactly one speech animation owner', async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'fixed-generated-native-'));
  try {
    let timing = await readFile(path.resolve('src/conversion/tests/fixtures/wise-generated-motion-sequence.xml'), 'utf8');
    const nativeTargets = [...new Set([...timing.matchAll(/spid="([^"]+)"/g)].map(m => m[1]))];
    nativeTargets.forEach((id, i) => { timing = timing.replaceAll(`spid="${id}"`, `spid="${i + 2}"`); });
    const zip = await JSZip.loadAsync(await readFile(input.source.path));
    zip.file('ppt/slides/slide1.xml', (await zip.file('ppt/slides/slide1.xml')!.async('string')).replace('</p:sld>', `${timing}</p:sld>`));
    const bytes = await zip.generateAsync({ type: 'nodebuffer' });
    const candidate = structuredClone(input);
    candidate.source.path = path.join(temporary, 'generated.pptx');
    await writeFile(candidate.source.path, bytes);
    candidate.source.sha256 = candidate.mapping.sourceSha256 = candidate.teaching.sourceSha256 = sha256(bytes);
    const objects = candidate.mapping.pages[0].objects.slice(0, 2);
    candidate.teaching.pages[0].actions = (['fadeIn', 'pulse', 'gentleRotate', 'fadeOut'] as const).map((effect, i) => ({
      id: `motion-speech-${i}`, type: 'speech', text: 'Look here.', audioAssetId: 'voice-1', visualCues: objects.map((object, j) => ({
        id: `motion-${i}-${j}`, atMs: 0, endMs: 600, effect: { type: 'element_animation', elementId: object.objectId,
          effect } })) }));
    const built = await buildFixedCourseware(candidate, { workerDirectory, outputDirectory: path.join(temporary, 'builds') });
    const loaded = await loadFixedBuild(await readFile(path.join(built.directory, 'package.json')), built.buildId, async asset => readFile(path.join(built.directory, asset.path)));
    try {
      expect(loaded.nativeAnimations?.get(candidate.mapping.pages[0].pageId)).toBeUndefined();
      expect(loaded.scenes[0].actions?.filter(a => a.type === 'speech')).toHaveLength(4);
      expect(loaded.scenes[0].actions?.filter(a => a.type === 'element_animation')).toHaveLength(0);
      for (const speech of candidate.teaching.pages[0].actions) expect(loaded.speechVisualCues.get(speech.id)).toHaveLength(2);
    } finally { loaded.dispose(); }
  } finally { await rm(temporary, { recursive: true, force: true }); }
}, 30_000);

it('archives edited native quiz images and loads the result as a quiz with the saved answer', async () => {
  const pageId = input.teaching.pages[0].pageId;
  const quiz = { type: 'quiz', interactionMode: 'classroom_instant_feedback', questions: [{ id: 'edited', type: 'single', question: 'Choose two',
    options: [{ value: 'A', label: 'One' }, { value: 'B', label: 'Two', image: { src: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=', mimeType: 'image/png' } }], answer: ['B'], referenceAnswer: 'Two' }] };
  const build = await buildFixedCourseware(input, { workerDirectory, outputDirectory, nativeAssessments: { [pageId]: quiz } });
  const bytes = await readFile(path.join(build.directory, 'package.json'));
  const loaded = await loadFixedBuild(bytes, build.packageHash, async asset => new Uint8Array(await readFile(path.join(build.directory, asset.path))));
  expect(loaded.scenes[0].content.type).toBe('quiz');
  const content: any = loaded.scenes[0].content;
  expect(content.questions[0].answer).toEqual(['B']);
  expect(content.questions[0].options[1].image.src).toMatch(/^blob:/);
  loaded.dispose();
}, 30000);
