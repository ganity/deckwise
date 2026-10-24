import PptxGen from '../../../vendor/pptxgenjs/index.cjs';
import type pptxgen from '../../../vendor/pptxgenjs/index.cjs';
import { candidateHash } from '../page-candidate-baseline';

export const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==', 'base64');
export async function pageFixture() {
  const deck = new PptxGen();
  deck.defineLayout({ name: 'B', width: 12.8, height: 8 });
  deck.layout = 'B';
  for (const text of ['Original first page', 'Target original', 'Preserved third page']) {
    const slide = deck.addSlide();
    slide.addText(text, { x: 1, y: 1, w: 10, h: 1, fontFace: 'Arial', fontSize: 30 });
    slide.addNotes(`Original notes: ${text}`);
  }
  const sourcePptx = Buffer.from(await deck.write({ outputType: 'nodebuffer' }) as Buffer);
  const pageText = 'Target original';
  const baseline = { projectId: 'project-b', documentId: 'document-b', pageId: 'logical-page-b', sourceRevision: 7, sourceHash: candidateHash(sourcePptx), teachingRevision: 3, contentHash: candidateHash(pageText), clean: true, readOnly: false, manualLocked: false };
  const scene = {
    version: 1, slideId: baseline.pageId, sourceHash: baseline.sourceHash,
    canvas: { width: 1280, height: 800 }, visualMasterAssetId: 'master', cleanPlateAssetId: 'clean',
    elements: [{ id: 'title-b', type: 'native_text', bboxPx: [80, 80, 1000, 160], zIndex: 1, content: 'B candidate — editable text', style: { fontFace: 'Arial', fontSizePt: 32, color: '#173B65', align: 'left' } }],
  };
  return { baseline, sourcePptx, pageText, scene, assets: { master: png, clean: png } };
}
