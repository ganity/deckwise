import { expect, it, vi } from 'vitest';
import { assessmentBackground, assessmentPptxScene } from '../classroom-pptx';
import { compileScenesToPptx } from '../kindergarten/scene-to-pptx';
import { createMaicInteractionCanvas } from '../../maic-interaction-canvas';
import { parseMaicClassroom } from '../../maic-classroom';
import { importPptxFromBuffer } from '../../conversion/lib/import/pptx/import-pptx-from-buffer';

vi.mock('../../../vendor/pptxtojson/index.cjs', () => {
  const parse = () => { throw new Error('Exercise the OOXML recovery path'); };
  return { parse, default: { parse } };
});

it('retains saved object names when the main parser falls back to OOXML', async () => {
  const classroom = parseMaicClassroom({ id: 'course', stage: { id: 'stage', name: 'Lesson', createdAt: 1, updatedAt: 1 }, createdAt: new Date(0).toISOString(), scenes: [
    { id: 'interaction', stageId: 'stage', title: 'Discussion', type: 'slide', order: 0,
      content: { type: 'slide', canvas: createMaicInteractionCanvas('interaction', 'Discussion', 'This is my family!') },
      actions: [{ id: 'checkpoint', type: 'interaction_checkpoint', checkpointKind: 'chapter_summary', checkpointId: 'checkpoint', chapterId: 'chapter', chapterTitle: 'Discussion', question: 'This is my family!', referenceAnswer: { summary: 'Reference', keyPoints: [] }, context: { chapterSummary: 'Lesson', sourceSceneIds: [] } }] },
  ] });
  const compiled = await compileScenesToPptx(classroom.scenes.map(scene => assessmentPptxScene(scene, 'sha256:test', { width: 1000, height: 562.5 })), { [assessmentBackground.id]: assessmentBackground.bytes });
  const ir = await importPptxFromBuffer({ arrayBuffer: Uint8Array.from(compiled.pptx).buffer, fileName: 'fallback.pptx' });
  for (const object of compiled.mapping.pages[0].elements) {
    expect(ir.pages[0].elements.find(element => element.sourceShapeId === object.sourceShapeId)?.sourceObjectName).toBe(object.objectName);
  }
});
