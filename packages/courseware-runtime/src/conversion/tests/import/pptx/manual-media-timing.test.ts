import { expect, it } from 'vitest';
import { parsePptxTiming } from '../../../lib/import/pptx/animation/parse-pptx-timing';

const mediaTiming = (kind: 'video' | 'audio') => `<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:timing><p:tnLst><p:par><p:cTn id="1" dur="indefinite" restart="never" nodeType="tmRoot"><p:childTnLst><p:${kind}><p:cMediaNode vol="80000"><p:cTn id="2" fill="hold" display="0"><p:stCondLst><p:cond delay="indefinite"/></p:stCondLst></p:cTn><p:tgtEl><p:spTgt spid="3"/></p:tgtEl></p:cMediaNode></p:${kind}></p:childTnLst></p:cTn></p:par></p:tnLst></p:timing></p:sld>`;

it.each(['video', 'audio'] as const)('keeps standalone manual %s in page-media controls without inventing an object animation', kind => {
  expect(parsePptxTiming(mediaTiming(kind))).toEqual({ accepted: true, animation: { steps: [] } });
});

it.each([
  ['automatic', 'delay="indefinite"', 'delay="0"'],
  ['delayed', 'delay="indefinite"', 'delay="500"'],
  ['scheduled', 'nodeType="tmRoot"', 'nodeType="mainSeq"'],
  ['inherited delay', '<p:childTnLst>', '<p:stCondLst><p:cond delay="500"/></p:stCondLst><p:childTnLst>'],
  ['duration', 'id="2"', 'id="2" dur="1000"'],
  ['looping', 'id="2"', 'id="2" repeatCount="indefinite"'],
  ['paragraph', '<p:spTgt spid="3"/>', '<p:spTgt spid="3"><p:txEl><p:pRg st="0" end="0"/></p:txEl></p:spTgt>'],
  ['click target', 'delay="indefinite"', 'delay="indefinite" evt="onClick"'],
])('does not discard unsupported %s media timing', (_kind, before, after) => {
  const result = parsePptxTiming(mediaTiming('video').replace(before, after));
  expect(result.accepted && !result.animation.steps.length && !result.warnings?.length).toBe(false);
});
