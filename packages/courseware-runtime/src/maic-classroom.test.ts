import { describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import JSZip from 'jszip';
import { parseMaicClassroom } from './maic-classroom';
import { exportMaicClassroom } from './conversion/lib/courseware/export-maic-classroom';
import { loadMaicClassroom } from './player/lib/courseware/load-maic-classroom';
import { scoreMaicQuiz } from './player/components/courseware/MaicQuiz';
import { loadTeamFixedBuild } from './player/lib/courseware/load-team-fixed-build';
const png = new Uint8Array(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWZsAAAAASUVORK5CYII=', 'base64'));
const fixture = () => ({ id: 'class', createdAt: '2026-11-04', stage: { id: 'stage', name: 'Greetings', createdAt: 0, updatedAt: 0 },
  scenes: [{ id: 'quiz', stageId: 'stage', type: 'quiz', title: 'Hello', order: 1, actions: [],
    content: { type: 'quiz', interactionMode: 'classroom_instant_feedback', questions: [{ id: 'q', type: 'single', question: 'Greeting?',
      options: [{ value: 'A', label: 'Hello', image: { src: 'local:image', assetId: 'image', mimeType: 'image/png' } }, { value: 'B', label: 'Bye' }], answer: ['A'], analysis: 'Hello is a greeting.' }] } }],
  mediaManifest: [{ sceneId: 'quiz', elementId: 'quiz-option:q:A', assetId: 'image', assetType: 'image', mimeType: 'image/png', src: 'local:image', originalSrc: 'local:image' }], metadata: { custom: { preserved: true } } });
describe('MAIC content through export and preview', () => {
  it('retains structured Quiz image/answer and optional data through the archive', async () => {
    const original = { ...fixture(), scenes: fixture().scenes.map(scene => ({ ...scene, metadata: { nativePageId: 'private-page', nativeNarrationText: 'private narration baseline', nativeQuestionText: 'private question baseline', nativeQuestionElementId: 'selected-frame', nativeTeachingRevision: 'private-teaching-revision', interaction: { kind: 'chapter_summary', extra: 'preserve' }, custom: true } })) };
    const bytes = await exportMaicClassroom(original, async () => png);
    const zip = await JSZip.loadAsync(bytes); const meta = JSON.parse(await zip.file('meta.json')!.async('string'));
    const classroom = parseMaicClassroom(meta.classroom);
    expect(classroom.scenes[0].type).toBe('quiz');
    if (classroom.scenes[0].content.type !== 'quiz') throw Error('Wrong scene');
    const q = classroom.scenes[0].content.questions[0];
    expect(q.answer).toEqual(['A']); expect(q.options![0].image!.src).toMatch(/^assets\//);
    expect(Array.from(await zip.file(q.options![0].image!.src)!.async('uint8array'))).toEqual(Array.from(png));
    expect(classroom.metadata).toEqual(original.metadata); expect(original.scenes[0].content.questions[0].options[0].image?.src).toBe('local:image');
    expect(classroom.scenes[0].metadata).toEqual({ interaction: { kind: 'chapter_summary', extra: 'preserve' }, custom: true });
    expect(original.scenes[0].metadata.nativePageId).toBe('private-page');
    const loaded = await loadMaicClassroom(classroom, 'build', async () => 'blob:resolved');
    expect(loaded.scenes[0].content.type).toBe('quiz');
    if (loaded.scenes[0].content.type === 'quiz') expect(loaded.scenes[0].content.questions[0].options![0].image!.src).toBe('blob:resolved');
  });
  it('rejects dangling answers, mismatched scenes and local teaching action extensions', () => {
    const c = fixture(); c.scenes[0].content.questions[0].answer = ['missing']; expect(() => parseMaicClassroom(c)).toThrow();
    const c2 = fixture(); c2.scenes[0].type = 'slide'; expect(() => parseMaicClassroom(c2)).toThrow();
    const c3 = fixture(); (c3.scenes[0].actions as unknown[]).push({ id: 'legacy', type: 'interaction_checkpoint', checkpointKind: 'teacher_continue' });
    expect(() => parseMaicClassroom(c3)).toThrow();
  });
  it('fails missing images rather than exporting a broken archive', async () => {
    const c = fixture(); c.mediaManifest = [];
    await expect(exportMaicClassroom(c, async () => new Uint8Array([1]))).rejects.toThrow('Unarchived');
  });
  it('grades stable values as a set and leaves short answers ungraded', () => {
    const q = { id: 'q', type: 'multiple' as const, question: 'Pick', answer: ['A', 'B'] };
    expect(scoreMaicQuiz(q, ['B', 'A'])).toBe(true); expect(scoreMaicQuiz(q, ['A', 'A'])).toBe(false);
    expect(scoreMaicQuiz({ ...q, type: 'short_answer' }, ['A'])).toBeNull();
  });
  it('rejects orphan manifests, invalid action fields, mismatched bytes and filesystem paths', async () => {
    const c = fixture(); c.mediaManifest[0].sceneId = 'missing';
    expect(() => parseMaicClassroom(c)).toThrow('Missing MAIC media target');
    const invalidAction = fixture(); (invalidAction.scenes[0].actions as unknown[]).push({ id: 'bad', type: 'wb_draw_text', content: 'Missing coordinates' });
    expect(() => parseMaicClassroom(invalidAction)).toThrow('Invalid MAIC wb_draw_text');
    await expect(exportMaicClassroom(fixture(), async () => new Uint8Array([1, 2, 3]))).rejects.toThrow('MIME mismatch');
    const local = fixture(); local.mediaManifest[0].originalSrc = '/home/private/image.png';
    await expect(exportMaicClassroom(local, async () => png)).rejects.toThrow('Local filesystem path');
    const orphan = { ...fixture(), audioManifest: [{ sceneId: 'quiz', actionId: 'missing', assetId: 'audio', audioId: 'audio', mimeType: 'audio/mpeg', url: 'asset:audio', originalUrl: 'asset:audio' }] };
    expect(() => parseMaicClassroom(orphan)).toThrow('Missing MAIC speech target');
  });
  it('archives and resolves background, shape pattern and video poster projections', async () => {
    const c = { ...fixture(), scenes: [{ id: 'slide', stageId: 'stage', type: 'slide', title: 'Media', order: 1, actions: [], content: {
      type: 'slide', canvas: { id: 'canvas', viewportSize: 1000, viewportRatio: .5625,
        theme: { backgroundColor: '#fff', fontColor: '#000', fontName: 'Arial', themeColors: [] },
        background: { type: 'image', image: { src: 'asset:background', resolvedSrc: 'asset:background' } },
        elements: [{ id: 'shape', type: 'shape', left: 0, top: 0, width: 100, height: 100, pattern: 'asset:pattern', resolvedPattern: 'asset:pattern' },
          { id: 'video', type: 'video', left: 100, top: 0, width: 100, height: 100, src: 'asset:video', poster: 'asset:poster', resolvedPoster: 'asset:poster' }] } } }],
      mediaManifest: [
        { sceneId: 'slide', elementId: 'background', assetId: 'bg', assetType: 'image', mimeType: 'image/png', src: 'asset:background', originalSrc: 'asset:background' },
        { sceneId: 'slide', elementId: 'shape', assetId: 'pattern', assetType: 'image', mimeType: 'image/png', src: 'asset:pattern', originalSrc: 'asset:pattern' },
        { sceneId: 'slide', elementId: 'video', assetId: 'video', assetType: 'video', mimeType: 'video/mp4', src: 'asset:video', originalSrc: 'asset:video', posterAssetId: 'poster', posterUrl: 'asset:poster' },
      ] };
    const zip = await JSZip.loadAsync(await exportMaicClassroom(c, async asset => asset.assetId === 'video' ? new Uint8Array([0, 0, 0, 16, 102, 116, 121, 112, 105, 115, 111, 109]) : new Uint8Array([...png, asset.assetId.length])));
    const meta = JSON.parse(await zip.file('meta.json')!.async('string'));
    const loaded = await loadMaicClassroom(meta.classroom, 'build', async asset => `blob:${asset.assetId}`);
    const slide = loaded.scenes[0].content;
    expect(JSON.stringify(slide)).not.toContain('asset:');
    expect(JSON.stringify(slide)).toContain('blob:poster');
    expect(JSON.stringify(slide)).toContain('blob:pattern');
  });
  it('loads canonical team delivery only from hash-verified finite files and revokes its URLs', async () => {
    const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
    const json = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
    const zip = await JSZip.loadAsync(await exportMaicClassroom(fixture(), async () => png));
    const { classroom } = JSON.parse(await zip.file('meta.json')!.async('string'));
    const path = classroom.mediaManifest[0].src, source = new Uint8Array([1]);
    const report = { sourceSha256: digest(source) };
    const pkg = json({ schemaVersion: 'deckwise-maic/1', classroom, report, assets: [{ id: 'image', path, sha256: digest(png), mimeType: 'image/png' }] });
    const buildId = digest(pkg), expected = { buildId, packageSha256: buildId, snapshotId: 'snapshot' };
    const files = new Map([['package.json', pkg], ['report.json', json(report)], ['source.pptx', source], [path, png]]);
    files.set('manifest.json', json({ schemaVersion: 'deckwise-build-manifest/1', buildId, packageHash: buildId,
      files: [...files].map(([path, bytes]) => ({ path, sha256: digest(bytes) })) }));
    const selection = { build: expected, manifestSha256: digest(files.get('manifest.json')!), expiresAt: '2027-01-01',
      files: [...files].map(([path, bytes]) => ({ file: { path, sha256: digest(bytes), byteLength: bytes.length,
        mimeType: path.startsWith('assets/') ? 'image/png' : path === 'source.pptx' ? 'application/vnd.openxmlformats-officedocument.presentationml.presentation' : 'application/json' }, downloadUrl: 'https://unused.example' })) };
    const download = vi.fn(async (path: string) => files.get(path)!);
    const revoke = vi.spyOn(URL, 'revokeObjectURL');
    const loaded = await loadTeamFixedBuild(selection, expected, download);
    expect(loaded.scenes[0].type).toBe('quiz'); expect(download.mock.calls.map(([path]) => path).sort()).toEqual([...files.keys()].sort());
    expect(JSON.stringify(loaded.scenes[0].content)).toContain('blob:');
    loaded.dispose(); expect(revoke).toHaveBeenCalledOnce(); revoke.mockRestore();
  });
});

it('refuses incomplete native teaching exports instead of silently dropping music or cues', async () => {
  const c = fixture();
  c.scenes[0].metadata = { nativeTeachingSyncPending: true };
  await expect(exportMaicClassroom(c, async () => png)).rejects.toThrow('Native teaching is not fully synchronized: Hello: media, pauses or cues');
  const resolve = vi.fn(async () => 'blob:unused');
  await expect(loadMaicClassroom(c, 'pending', resolve)).rejects.toThrow('Native teaching is not fully synchronized: Hello: unsupported native teaching action');
  expect(resolve).not.toHaveBeenCalled();
});
