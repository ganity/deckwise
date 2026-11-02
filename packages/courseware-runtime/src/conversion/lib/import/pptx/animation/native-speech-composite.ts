import type { AnimationComposite, TimingNode } from './parse-pptx-timing';

type Pattern = { local: string; attrs: Record<string, string>; children: Pattern[]; text?: string };
const n = (local: string, attrs: Record<string, string> = {}, children: Pattern[] = [], text?: string): Pattern => ({ local, attrs, children, ...(text ? { text } : {}) });

/** Exact SDK preset behaviors; preset IDs alone do not prove an unmodified animation. */
export function nativeSpeechComposite(effect: TimingNode): AnimationComposite | undefined {
  if (effect.children.length !== 2 || effect.children[0].local !== 'stCondLst' || effect.children[1].local !== 'childTnLst' ||
      Object.keys(effect.attrs).some(key => !['id', 'presetID', 'presetClass', 'presetSubtype', 'fill', 'grpId', 'nodeType'].includes(key)) ||
      effect.attrs.fill !== 'hold' || effect.attrs.grpId !== '0') return;
  const list = effect.children.find(c => c.local === 'childTnLst');
  if (!list?.children.length) return;
  const all = (node: TimingNode): TimingNode[] => [node, ...node.children.flatMap(all)];
  const descendants = list.children.flatMap(all);
  const targets = descendants.filter(c => c.local === 'spTgt');
  const target = targets[0];
  if (!target?.attrs.spid || targets.some(t => t.attrs.spid !== target.attrs.spid)) return;
  const times = descendants.filter(c => c.local === 'cTn');
  const duration = Math.max(...times.map(t => Number(t.attrs.dur) + Number(t.children.find(c => c.local === 'stCondLst')?.children[0]?.attrs.delay ?? 0)));
  if (!Number.isInteger(duration) || duration < 1 || duration > 5000) return;
  const time = (dur: number, attrs: Record<string, string> = {}, delay?: number) => n('cTn', { dur: String(dur), ...attrs }, delay === undefined ? [] : [n('stCondLst', {}, [n('cond', { delay: String(delay) })])]);
  const behavior = (timing: Pattern, attr?: string, additive = false) => n('cBhvr', additive ? { additive: 'base' } : {}, [timing,
    n('tgtEl', {}, [n('spTgt', { spid: target.attrs.spid })]), ...(attr ? [n('attrNameLst', {}, [n('attrName', {}, [], attr)])] : [])]);
  const visibility = (visible: boolean) => n('set', {}, [behavior(time(1, { fill: 'hold' }, visible ? 0 : duration - 1), 'style.visibility'), n('to', {}, [n('strVal', { val: visible ? 'visible' : 'hidden' })])]);
  const fade = (transition: string, pulse = false) => n('animEffect', { transition, filter: 'fade' }, [behavior(time(duration, pulse ? { tmFilter: '0, 0; .2, .5; .8, .5; 1, 0' } : {}))]);
  const property = (name: string, from: string, to: string) => n('anim', { calcmode: 'lin', valueType: 'num' }, [behavior(time(duration, { fill: 'hold' }), name, name === 'ppt_x' || name === 'ppt_y'),
    n('tavLst', {}, [n('tav', { tm: '0' }, [n('val', {}, [n(from === '0' ? 'fltVal' : 'strVal', { val: from })])]), n('tav', { tm: '100000' }, [n('val', {}, [n('strVal', { val: to })])])])]);
  const key = `${effect.attrs.presetClass}/${effect.attrs.presetID}/${effect.attrs.presetSubtype ?? '0'}`;
  let expected: Pattern[], name: string;
  switch (key) {
    case 'entr/10/0': expected = [visibility(true), fade('in')]; name = 'fade'; break;
    case 'exit/10/0': expected = [fade('out'), visibility(false)]; name = 'fade'; break;
    case 'entr/53/16': expected = [visibility(true), property('ppt_w', '0', '#ppt_w'), property('ppt_h', '0', '#ppt_h'), fade('in')]; name = 'zoom'; break;
    case 'entr/2/8': case 'entr/2/2':
      expected = [visibility(true), property('ppt_x', key.endsWith('/8') ? '0-#ppt_w/2' : '1+#ppt_w/2', '#ppt_x'), property('ppt_y', '#ppt_y', '#ppt_y')];
      name = key.endsWith('/8') ? 'fly(left)' : 'fly(right)'; break;
    case 'emph/26/0': expected = [fade('out', true), n('animScale', {}, [behavior(time(duration / 2, { autoRev: '1', fill: 'hold' })), n('by', { x: '105000', y: '105000' })])]; name = 'pulse'; break;
    case 'emph/32/0': expected = [120000, -240000, 240000, -240000, 120000].map((by, i) => n('animRot', { by: String(by) }, [behavior(time(duration * (i === 0 ? .1 : .2), { fill: 'hold' }, duration * i * .2), 'r')])); name = 'teeter'; break;
    default: return;
  }
  const matches = (actual: TimingNode, pattern: Pattern): boolean => {
    if (actual.uri !== effect.uri || actual.local !== pattern.local || (actual.text?.trim() ?? '') !== (pattern.text ?? '') || actual.children.length !== pattern.children.length) return false;
    const attrs = Object.entries(actual.attrs).filter(([key]) => !(actual.local === 'cTn' && key === 'id'));
    return attrs.length === Object.keys(pattern.attrs).length && attrs.every(([key, value]) => {
      if ((actual.local === 'cTn' && key === 'dur') || (actual.local === 'cond' && key === 'delay'))
        return /^\d+$/.test(value) && Math.abs(Number(value) - Number(pattern.attrs[key])) <= 1;
      return value === pattern.attrs[key];
    }) && actual.children.every((child, i) => matches(child, pattern.children[i]));
  };
  if (list.children.length !== expected.length || !list.children.every((child, i) => matches(child, expected[i]))) return;
  return { primaryNode: list.children[0], nodes: list.children, targetNode: target, effect: name, durationMs: duration,
    referenceIds: times.map(t => t.attrs.id).filter(Boolean), nativeVerified: true };
}
