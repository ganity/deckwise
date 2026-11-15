import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { parsePptxTiming } from '../import/pptx/animation/parse-pptx-timing';
import { hasGeneratedNativeMotions } from './native-click-animations';
import type { SlidePageIR } from '../import/types';

it('recognizes speech motion groups in a PPTX slide actually saved by WiseOffice', () => {
  const xml = readFileSync(new URL('../../tests/fixtures/wise-generated-motions-slide.xml', import.meta.url), 'utf8');
  const parsed = parsePptxTiming(xml);
  expect(parsed.accepted).toBe(true);
  if (!parsed.accepted) return;
  expect(parsed.warnings).toBeUndefined();
  expect(parsed.animation.steps).toHaveLength(7);
  const shapes = [...new Set(parsed.animation.steps.flatMap(s => s.items.map(i => i.target!.shapeId)))];
  const page: SlidePageIR = { id: 'page', width: 960, height: 540,
    elements: shapes.map(id => ({ id, sourceShapeId: id, type: 'text', left: 0, top: 0, width: 100, height: 100 })), pptxAnimation: parsed.animation };
  const actions = ['fadeIn','zoomIn','slideInLeft','slideInRight','pulse','gentleRotate','fadeOut'].map((effect, i) => ({ id: `speech-${i}`, type: 'speech',
    visualCues: shapes.map(id => ({ atMs: 0, endMs: 600, effect: { type: 'element_animation', elementId: id, effect } })) }));
  const mapping = shapes.map(id => ({ objectId: id, importElementId: id }));
  expect(hasGeneratedNativeMotions(page, actions, mapping)).toBe(true);
  page.pptxAnimation!.steps[0].items[0].durationMs = 601;
  expect(hasGeneratedNativeMotions(page, actions, mapping)).toBe(false);
});

it.each(['x="105000"', 'by="120000"', 'val="1+#ppt_w/2"', 'val="#ppt_h"'])(
  'does not suppress a native animation whose saved %s behavior was edited', token => {
    const xml = readFileSync(new URL('../../tests/fixtures/wise-generated-motions-slide.xml', import.meta.url), 'utf8');
    const changed = xml.replace(token, token.replace(/\d/, '9').replace('#ppt_h', '#ppt_w'));
    expect(changed).not.toBe(xml);
    const parsed = parsePptxTiming(changed);
    if (!parsed.accepted) return;
    expect(parsed.warnings?.length || parsed.animation.steps.some(s => s.items.some(i => !i.nativePreset?.verifiedSpeechMotion))).toBeTruthy();
  });
