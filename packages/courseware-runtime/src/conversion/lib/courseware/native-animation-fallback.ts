import type { ImportWarning, SlidePageIR } from '../import/types';
import { projectNativeTimeline } from './native-timeline';
import { nativeTimelineSchema, type NativeTimeline } from '../../../native-timeline';
import type { FixedBuildInput } from './fixed-build-input';

/** Master may wrap one visible object in a group; animate that exact child, not its invisible anchor. */
export function resolveSingleChildSpeechAnimations(input: FixedBuildInput, pages: SlidePageIR[]) {
  for (const page of input.teaching.pages) {
    const mapping = input.mapping.pages.find(p => p.pageId === page.pageId);
    const source = pages.find(p => p.id === mapping?.importPageId);
    if (!mapping || !source) continue;
    for (const action of page.actions) if (action.type === 'speech') for (const cue of action.visualCues ?? []) {
      const effect = cue.effect;
      if (effect.type !== 'element_animation' || cue.nativeAnimation) continue;
      const group = mapping.groups?.find(group => group.objectId === effect.elementId);
      if (!group) continue;
      const children = source.elements.filter(element => element.sourceGroupShapeIds?.includes(group.sourceShapeId));
      const child = children.length === 1 && mapping.objects.find(object => object.importElementId === children[0].id);
      if (child) effect.elementId = child.objectId;
    }
  }
}

/** Playback-only degradation; source timing and explicit teaching bindings stay untouched. */
export function fallbackNativeTimeline(page: SlidePageIR, aliases: readonly { objectId: string; sourceShapeId: string }[],
  speechTargets: ReadonlySet<string>, diagnostics: ImportWarning[], pageIndex: number): NativeTimeline | undefined {
  const steps: NativeTimeline['steps'] = [];
  const groups = new Map<string, NonNullable<NativeTimeline['groups']>[number]>();
  for (const step of page.pptxAnimation?.steps ?? []) {
    const items: NativeTimeline['steps'][number]['items'] = [];
    for (const item of step.items) {
      const single = (candidate: typeof item) => projectNativeTimeline({ ...page,
        pptxAnimation: { steps: [{ ...step, items: [candidate] }] } }, aliases)!;
      let projected: NativeTimeline | undefined;
      try { projected = single(item); }
      catch {
        const targets = page.elements.filter(element => element.sourceShapeId === item.target?.shapeId);
        const target = targets[0];
        // Never invent an object or compete with an existing speech animation clock.
        if (targets.length === 1 && target && !speechTargets.has(target.id) &&
            !target.sourceGroupShapeIds?.length && !item.target?.paragraphIndexes && !item.target?.characterRange &&
            ['text', 'shape', 'image'].includes(target.type) && target.width > 0 && target.height > 0 &&
            Number.isInteger(item.startAtMs) && item.startAtMs >= 0 && item.startAtMs <= 30000) {
          projected = single({ id: item.id, target: item.target, animationType: 'in', effect: 'fade',
            startAtMs: item.startAtMs, durationMs: 500,
            nativePreset: { version: 1, class: 'entr', id: 10, verifiedSpeechMotion: true } });
        }
        diagnostics.push({ code: projected ? 'PPTX_ANIMATION_FALLBACK_FADE' : 'PPTX_ANIMATION_SKIPPED',
          severity: 'warning', pageIndex, message: projected
            ? 'An unsupported native effect was replaced by a 500 ms whole-object fade for playback.'
            : 'An unsupported native effect was skipped; its target is unavailable, unsafe or already animated by speech.' });
      }
      if (projected) {
        items.push(...projected.steps[0].items);
        for (const group of projected.groups ?? []) groups.set(group.elementId, group);
      }
    }
    if (items.length) steps.push({ ...step, items });
  }
  return steps.length ? nativeTimelineSchema.parse({ version: 1, steps,
    ...(groups.size ? { groups: [...groups.values()] } : {}) }) : undefined;
}
