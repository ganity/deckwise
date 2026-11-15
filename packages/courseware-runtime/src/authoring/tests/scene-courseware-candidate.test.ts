import JSZip from 'jszip';
import { describe, expect, it } from 'vitest';
import { candidateHash } from '../page-candidate-baseline';
import { coursewareNarrationActions } from '../page-narration-actions';
import { compileSceneCoursewareCandidate } from '../scene-courseware-candidate';

const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==',
  'base64',
);
function fixture() {
  return {
    assets: { master: Buffer.from(png), clean: Buffer.from(png) },
    pages: ['first', 'second', 'third'].map((sceneId) => ({
      scene: {
        version: 1,
        slideId: sceneId,
        sourceHash: `sha256:${sceneId}`,
        canvas: { width: 1280, height: 800 },
        visualMasterAssetId: 'master',
        cleanPlateAssetId: 'clean',
        elements: [
          {
            id: 'title',
            type: 'native_text',
            bboxPx: [80, 80, 1000, 160],
            zIndex: 1,
            content: `Child-facing ${sceneId}`,
            style: { fontFace: 'Arial', fontSizePt: 32, color: '#173B65' },
          },
        ],
      },
      narration: {
        blocks: [
          { type: 'speech', text: `Teacher narration ${sceneId}` },
          { type: 'wait', durationMs: 1000 },
          { type: 'wait', durationMs: 2000 },
          { type: 'praise', text: '谢谢你的尝试。' },
        ],
      },
    })),
  };
}

describe('new scene courseware candidate assembly', () => {
  it('keeps ordered native PPTX pages and separate reviewed teaching without audio or adoption', async () => {
    const { pages, assets } = fixture();
    const result = await compileSceneCoursewareCandidate(pages, assets);
    expect(result).toMatchObject({
      taskType: 'scene',
      reviewState: 'needs-review',
      applied: false,
      audioReady: false,
    });
    expect(result.outputSha256).toBe(candidateHash(result.pptx).slice(7));
    expect(result.teachingPages.map((page) => page.sceneId)).toEqual(['first', 'second', 'third']);
    expect(result.mapping.pages.map((page) => page.slideId)).toEqual(['first', 'second', 'third']);
    const actionIds = result.teachingPages.flatMap((page) =>
      page.actions.map((action) => action.id),
    );
    expect(new Set(actionIds).size).toBe(actionIds.length);
    const zip = await JSZip.loadAsync(result.pptx);
    for (let index = 0; index < pages.length; index++) {
      const page = result.teachingPages[index];
      expect(page.slidePart).toBe(result.mapping.pages[index].slidePart);
      expect(page).toMatchObject({
        locked: false,
        reviewState: 'review',
        actions: [
          { type: 'speech', text: `Teacher narration ${page.sceneId}`, pauseAfterMs: 3000 },
          { type: 'speech', text: '谢谢你的尝试。' },
        ],
      });
      expect(JSON.stringify(page)).not.toContain('audioAssetId');
      const xml = await zip.file(page.slidePart)!.async('string');
      expect(xml).toContain(`Child-facing ${page.sceneId}`);
      expect(xml).not.toContain('Teacher narration');
      expect(xml).toContain('<p:sp>');
    }
    for (const file of Object.values(zip.files).filter((file) =>
      /notesSlide\d+\.xml$/.test(file.name),
    ))
      expect(await file.async('string')).not.toContain('Teacher narration');
  });

  it('captures later-page scene, narration and referenced image bytes before awaits', async () => {
    const { pages, assets } = fixture();
    const pending = compileSceneCoursewareCandidate(pages, assets);
    pages[2].scene.elements[0].content = 'Substituted page';
    pages[2].scene.slideId = 'foreign';
    pages[2].narration.blocks[0].text = 'Substituted speech';
    pages.reverse();
    assets.clean.fill(0);
    assets.master.fill(0);
    const result = await pending;
    expect(result.teachingPages[2].actions[0].text).toBe('Teacher narration third');
    const zip = await JSZip.loadAsync(result.pptx);
    expect(await zip.file('ppt/slides/slide3.xml')!.async('string')).toContain(
      'Child-facing third',
    );
    for (const file of Object.values(zip.files).filter(
      (file) => file.name.startsWith('ppt/media/') && !file.dir,
    ))
      expect(await file.async('nodebuffer')).toEqual(png);
  });

  it('refuses pre-aborted and late-cancelled candidates without returning partial output', async () => {
    const { pages, assets } = fixture();
    const controller = new AbortController();
    controller.abort(new Error('cancelled'));
    await expect(compileSceneCoursewareCandidate(pages, assets, controller.signal)).rejects.toThrow(
      'cancelled',
    );
    const late = new AbortController();
    const pending = compileSceneCoursewareCandidate(pages, assets, late.signal);
    late.abort(new Error('late cancellation'));
    await expect(pending).rejects.toThrow('late cancellation');
  });

  it.each([
    [],
    Array.from({ length: 101 }, () => fixture().pages[0]),
    { pages: fixture().pages, sourcePath: '/open.pptx' },
  ])('refuses empty, excessive and editing-shaped requests', async (input) => {
    await expect(compileSceneCoursewareCandidate(input, fixture().assets)).rejects.toThrow();
  });

  it('refuses a missing page narration, unknown fields and supplied ready audio', async () => {
    const { pages, assets } = fixture();
    const { narration: _narration, ...without } = pages[1];
    await expect(compileSceneCoursewareCandidate([pages[0], without], assets)).rejects.toThrow();
    await expect(
      compileSceneCoursewareCandidate([{ ...pages[0], sourcePath: '/open.pptx' }], assets),
    ).rejects.toThrow();
    await expect(
      compileSceneCoursewareCandidate(
        [
          {
            ...pages[0],
            narration: { blocks: [{ type: 'speech', text: 'Speech', audioAssetId: 'unverified' }] },
          },
        ],
        assets,
      ),
    ).rejects.toThrow();
  });

  it('refuses raster-only pages and excessive native object counts', async () => {
    const { pages, assets } = fixture();
    const raster = { ...pages[0], scene: { ...pages[0].scene, elements: [] } };
    await expect(compileSceneCoursewareCandidate([raster], assets)).rejects.toThrow(
      'native objects',
    );
    const crowded = {
      ...pages[0],
      scene: {
        ...pages[0].scene,
        elements: Array.from({ length: 201 }, (_, index) => ({
          ...pages[0].scene.elements[0],
          id: `object-${index}`,
        })),
      },
    };
    await expect(compileSceneCoursewareCandidate([crowded], assets)).rejects.toThrow(
      '200-object budget',
    );
  });

  it('retains compiler refusal of duplicate IDs, mixed canvases and corrupt or missing assets', async () => {
    const { pages, assets } = fixture();
    await expect(compileSceneCoursewareCandidate([pages[0], pages[0]], assets)).rejects.toThrow(
      'unique slide IDs',
    );
    pages[1].scene.canvas.width = 1300;
    await expect(compileSceneCoursewareCandidate(pages, assets)).rejects.toThrow(
      'one shared canvas',
    );
    await expect(compileSceneCoursewareCandidate([pages[0]], {})).rejects.toThrow(
      'Missing scene asset',
    );
    await expect(
      compileSceneCoursewareCandidate([pages[0]], { ...assets, clean: png.subarray(0, 40) }),
    ).rejects.toThrow('Invalid scene PNG');
  });

  it('bounds aggregate teaching before invoking the compiler', async () => {
    const { pages } = fixture();
    const narration = {
      blocks: Array.from({ length: 100 }, () => ({ type: 'speech', text: 'x'.repeat(8000) })),
    };
    await expect(
      compileSceneCoursewareCandidate(
        pages.map((page) => ({ ...page, narration })),
        {},
      ),
    ).rejects.toThrow('2 MiB');
  });

  it.each([
    [
      { type: 'wait', durationMs: 1000 },
      { type: 'speech', text: 'Later' },
    ],
    [
      { type: 'speech', text: 'Speak' },
      { type: 'wait', durationMs: 30000 },
      { type: 'wait', durationMs: 500 },
    ],
    [{ type: 'speech', text: '[wait 1000]' }],
    [{ type: 'praise', text: 'Correct! I understood your answer.' }],
  ])('preserves existing structured wait/praise refusal for %j', async (blocks) => {
    const { pages, assets } = fixture();
    expect(() => coursewareNarrationActions({ blocks }, 'candidate')).toThrow();
    await expect(
      compileSceneCoursewareCandidate([{ ...pages[0], narration: { blocks } }], assets),
    ).rejects.toThrow();
  });

  it('keeps the existing single-page action IDs and exact 30-second wait boundary', () => {
    expect(
      coursewareNarrationActions(
        {
          blocks: [
            { type: 'speech', text: '  Speak  ' },
            { type: 'wait', durationMs: 30000 },
            { type: 'praise', text: 'Thank you for joining in.' },
          ],
        },
        'existing-candidate',
      ),
    ).toEqual([
      { id: 'speech-existing-candidate-0', type: 'speech', text: 'Speak', pauseAfterMs: 30000 },
      { id: 'speech-existing-candidate-1', type: 'speech', text: 'Thank you for joining in.' },
    ]);
  });
});
