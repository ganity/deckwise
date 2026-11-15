import { expect, it } from 'vitest';
import { mapSlideIrToScenes } from './import-ir-to-classroom';
import type { SlideIR } from '../types';
it('prefers the actual named page heading over a misclassified content label', () => {
  const ir: SlideIR = { schemaVersion: 'slide-ir/1', title: 'source', pages: [{ id: 'ir', width: 960, height: 540, elements: [
    { id: 'label', sourceObjectName: 'solid-label', type: 'text', textType: 'title', content: '固态·冰', left: 40, top: 200, width: 200, height: 60 },
    { id: 'heading', sourceObjectName: 'page-title', type: 'text', content: '状态会随冷热变化', left: 30, top: 20, width: 800, height: 70 },
  ] }] };
  expect(mapSlideIrToScenes('fixed', ir)[0].title).toBe('状态会随冷热变化');
});
it('uses a page label instead of an internal source filename when no heading exists', () => {
  const ir: SlideIR = { schemaVersion: 'slide-ir/1', title: 'source', pages: [{ id: 'ir', width: 960, height: 540, elements: [] }] };
  expect(mapSlideIrToScenes('fixed', ir)[0].title).toBe('第 1 页');
});
