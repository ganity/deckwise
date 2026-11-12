import type { ImportWarning, SlidePageIR } from '../import/types';
import { projectNativeTimeline } from './native-timeline';
import { detachLinkedSpeechAnimations } from './native-click-animations';
import { projectNativeGroups } from './native-groups';
import { createHash } from 'node:crypto';
import { nativeTimelineSchema, type NativeTimeline } from '../../../native-timeline';
import type { FixedBuildInput } from './fixed-build-input';

/** Resolve saved group speech motion onto real components; group attention keeps its shared bounds. */
export function resolveSingleChildSpeechAnimations(input: Pick<FixedBuildInput, 'mapping' | 'teaching'>, pages: SlidePageIR[]) {
  for (const page of input.teaching.pages) {
    const mapping = input.mapping.pages.find(p => p.pageId === page.pageId);
    const source = pages.find(p => p.id === mapping?.importPageId);
    if (!mapping || !source) continue;
    for (const action of page.actions) if (action.type === 'speech') {
      type Cue = NonNullable<typeof action.visualCues>[number];
      const projected = new Set<Cue>();
      action.visualCues = action.visualCues?.flatMap(cue => {
        const effect = cue.effect;
        if (effect.type !== 'element_animation' || cue.nativeAnimation) return [cue];
        const group = mapping.groups?.find(group => group.objectId === effect.elementId);
        if (!group) return [cue];
        const children = source.elements.filter(element => element.sourceGroupShapeIds?.includes(group.sourceShapeId));
        const bound = children.map(child => mapping.objects.find(object => object.importElementId === child.id));
        if (!children.length || bound.some(child => !child) || children.some(child =>
          !['text', 'shape', 'image'].includes(child.type) || child.width <= 0 || child.height <= 0)) return [cue];
        // Remove only a verified native mirror before projecting the same opacity clock onto all components.
        const [anchor] = projectNativeGroups(source, [group]);
        const remaining = detachLinkedSpeechAnimations({ ...source, elements: [...source.elements,
          { ...anchor.element, sourceShapeId: group.sourceShapeId }] }, [{ ...action, visualCues: [cue] }],
          [{ objectId: group.objectId, importElementId: anchor.element.id }]);
        source.pptxAnimation = remaining.pptxAnimation;
        // Transform multi-part geometry around its shared center, not each child's center.
        if (children.length > 1 && !['fadeIn', 'fadeOut'].includes(effect.effect)) return [cue];
        return bound.map(child => {
          const component = { ...cue,
          id: bound.length === 1 ? cue.id : 'group-motion-' + createHash('sha256').update(JSON.stringify([cue.id, child!.objectId])).digest('hex'),
          effect: { ...effect, elementId: child!.objectId },
          };
          projected.add(component);
          return component;
        });
      });
      // A group and its child can name the same opacity clock. Only coalesce
      // exact duplicates introduced by projection; distinct source clocks still fail.
      const clocks = new Map<string, Cue>();
      action.visualCues = action.visualCues?.filter(cue => {
        if (cue.effect.type !== 'element_animation') return true;
        const key = JSON.stringify([cue.effect.elementId, cue.effect.effect, cue.atMs,
          cue.endMs, cue.trigger, cue.nativeAnimation]);
        const previous = clocks.get(key);
        if (previous && (projected.has(previous) || projected.has(cue))) return false;
        clocks.set(key, cue);
        return true;
      });
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
