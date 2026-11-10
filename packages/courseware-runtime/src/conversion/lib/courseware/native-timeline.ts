import { projectNativeGroups } from './native-groups';
import { nativeTimelineSchema, type NativeTimeline } from '../../../native-timeline';
import type { SlidePageIR } from '../import/types';

/** Preserve supported native auto/parallel/delayed steps instead of dropping them. */
export function projectNativeTimeline(page: SlidePageIR, aliases: readonly { objectId: string; sourceShapeId: string }[] = []): NativeTimeline | undefined {
  if (!page.pptxAnimation?.steps.length) return;
  const groupIds = [...new Set(page.pptxAnimation.steps.flatMap(step => step.items.flatMap(item =>
    page.elements.some(element => element.sourceShapeId === item.target?.shapeId) ? [] : item.target?.shapeId ? [item.target.shapeId] : [])))];
  const groups = projectNativeGroups(page, groupIds.map(sourceShapeId => aliases.find(group => group.sourceShapeId === sourceShapeId) ??
    { objectId: `source_${sourceShapeId}`, sourceShapeId }));
  const steps = page.pptxAnimation.steps.map(step => ({
    id: step.id, trigger: step.trigger,
    items: step.items.map(item => {
      const groupIndex = groupIds.indexOf(item.target?.shapeId ?? '');
      const targets = groupIndex >= 0 ? [groups[groupIndex].element] : page.elements.filter(element => element.sourceShapeId === item.target?.shapeId);
      const target = targets[0], preset = item.nativePreset;
      const key = preset && `${preset.class}/${preset.id}/${preset.subtype ?? 0}`;
      const effects: Record<string, { effect: string; animationType: string }> = {
        'entr/37/0': { effect: 'bounceInBottom', animationType: 'in' },
        'entr/22/4': { effect: 'wipeDown', animationType: 'in' },
        'entr/23/16': { effect: 'scaleIn', animationType: 'in' },
        'entr/1/0': { effect: 'appear', animationType: 'in' },
        'entr/10/0': { effect: 'fadeIn', animationType: 'in' },
        'exit/10/0': { effect: 'fadeOut', animationType: 'out' },
        'emph/6/0': { effect: 'grow150', animationType: 'attention' },
        'emph/26/0': { effect: 'pulse', animationType: 'attention' },
        'entr/53/16': { effect: 'zoomIn', animationType: 'in' },
        'entr/2/8': { effect: 'slideInLeft', animationType: 'in' },
        'entr/2/2': { effect: 'slideInRight', animationType: 'in' },
        'emph/32/0': { effect: 'gentleRotate', animationType: 'attention' },
      };
      const effect = key && effects[key];
      if (!effect || preset?.verifiedSpeechMotion !== true || targets.length !== 1 || !target ||
          !['text', 'shape', 'image'].includes(target.type) || target.width <= 0 || target.height <= 0 ||
          item.motion || item.rotation || item.target?.paragraphIndexes || item.target?.characterRange ||
          item.animationType !== effect.animationType) throw new Error('NATIVE_ANIMATION_UNSUPPORTED');
      return { elementId: target.id, ...effect, ...(effect.effect === 'bounceInBottom' ? { distance: page.height } : {}), durationMs: item.durationMs, startAtMs: item.startAtMs };
    }),
  }));
  const parent = (shapeId: string) => {
    const child = page.elements.find(element => element.sourceGroupShapeIds?.includes(shapeId));
    const ancestors = child?.sourceGroupShapeIds ?? [];
    return ancestors.slice(0, ancestors.indexOf(shapeId)).findLast(id => groupIds.includes(id));
  };
  const wrappers = groups.map((group, index) => ({ elementId: group.element.id,
    children: [...page.elements.filter(element => element.sourceGroupShapeIds?.filter(id => groupIds.includes(id)).at(-1) === groupIds[index]).map(element => element.id),
      ...groups.filter((_, childIndex) => parent(groupIds[childIndex]) === groupIds[index]).map(child => child.element.id)] }));
  const parsed = nativeTimelineSchema.safeParse({ version: 1, steps, ...(wrappers.length ? { groups: wrappers } : {}) });
  if (!parsed.success) throw new Error('NATIVE_ANIMATION_UNSUPPORTED');
  return parsed.data;
}
