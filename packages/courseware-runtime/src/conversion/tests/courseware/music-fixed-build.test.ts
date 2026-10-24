import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import JSZip from 'jszip';
import { expect, it } from 'vitest';
import { adaptCanonicalSnapshot } from '../../lib/courseware/adapt-canonical-snapshot';
import { buildFixedCourseware, sha256 } from '../../lib/courseware/fixed-build';
import { loadFixedBuild } from '../../../player/lib/courseware/load-fixed-build';

it('adapts, builds and loads verified sequential music beside unchanged narration', async () => {
  const fixture = path.resolve('tests/fixtures/fixed-courseware');
  const workerDirectory = path.resolve('../../apps/desktop/resources/pptx-worker');
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'fixed-music-'));
  try {
    const raw = JSON.parse(await readFile(path.join(fixture, 'canonical-desktop.json'), 'utf8'));
    // Keep this audio test independent from imported native animation compatibility.
    const source = await JSZip.loadAsync(await readFile(path.join(fixture, 'lesson-r8.pptx')));
    for (const entry of Object.values(source.files)) {
      if (/^ppt\/slides\/slide\d+\.xml$/.test(entry.name))
        source.file(entry.name, (await entry.async('string')).replace(/<p:timing\b[\s\S]*?<\/p:timing>/g, ''));
    }
    const bytes = await source.generateAsync({ type: 'nodebuffer' });
    raw.files.sourcePath = path.join(temporary, 'static.pptx');
    await writeFile(raw.files.sourcePath, bytes);
    raw.project.source.sha256 = raw.snapshot.source.sha256 = raw.files.mapping.sourceSha256 = sha256(bytes);
    raw.files.converter.manifestSha256 = sha256(await readFile(path.join(workerDirectory, 'manifest.json')));
    raw.files.assets.forEach((asset: { path: string }, index: number) => { asset.path = path.join(fixture, `page-${index + 1}.wav`); });
    const clip = { id: 'music-clip', type: 'audio_clip', audioAssetId: raw.files.assets[0].id };
    raw.project.pages[0].actions.push(clip);
    const input = adaptCanonicalSnapshot(raw.project, raw.snapshot, raw.files);
    const options = { workerDirectory, outputDirectory: path.join(temporary, 'builds') };
    const built = await buildFixedCourseware(input, options);
    const packageBytes = await readFile(path.join(built.directory, 'package.json'));
    const loaded = await loadFixedBuild(packageBytes, built.buildId, async asset => readFile(path.join(built.directory, asset.path)));
    try {
      expect(built.report.capabilities.teachingAudioClips).toBe('sequential/1');
      expect(loaded.scenes[0].actions?.at(-1)).toMatchObject({ ...clip, audioId: clip.audioAssetId, audioUrl: expect.stringMatching(/^blob:/) });
      expect(loaded.scenes[0].actions?.[0]).toMatchObject(raw.project.pages[0].actions[0]);
      expect(loaded.speechVisualCues.has(clip.id)).toBe(false);
    } finally { loaded.dispose(); }
    const adopted = input.teaching.pages[0].actions.at(-1)!;
    if (adopted.type !== 'audio_clip') throw new Error('Expected adopted clip');
    adopted.audioAssetId = 'missing';
    await expect(buildFixedCourseware(input, options)).rejects.toMatchObject({ code: 'AUDIO_ASSET_MISSING' });
    adopted.audioAssetId = clip.audioAssetId;
    input.assets[0].mimeType = 'image/png';
    await expect(buildFixedCourseware(input, options)).rejects.toMatchObject({ code: 'AUDIO_ASSET_MISSING' });
  } finally { await rm(temporary, { recursive: true, force: true }); }
}, 30_000);
