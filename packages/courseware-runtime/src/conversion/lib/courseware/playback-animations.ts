import type { ImportWarning, SlidePageIR } from '../import/types';
import type { FixedBuildInput } from './fixed-build-input';
import { projectNativeGroups } from './native-groups';
import { projectNativeTimeline, projectNativeTimelineGroups } from './native-timeline';
import { fallbackNativeTimeline } from './native-animation-fallback';
import { detachLinkedSpeechAnimations, hasGeneratedNativeMotions, projectNativeClicks } from './native-click-animations';
import { validateNativeAnimationBindings } from '../../../native-animation-node';
import { validSpeechAnimationSequence } from '../../../speech-animation-sequence';
import type { NativeClickAnimations } from '../../../native-click-animations';
import type { NativeTimeline } from '../../../native-timeline';

type Mapping = FixedBuildInput['mapping']['pages'][number];
type Actions = FixedBuildInput['teaching']['pages'][number]['actions'];
const requireValid = (value: unknown, code: string) => { if (!value) throw new Error(code); };

/** Shared by saved-generation preflight and fixed conversion. Never edits source PPTX bytes. */
export function projectPlaybackAnimations(page: SlidePageIR, actions: Actions, mapping: Mapping,
  sourceSha256: string, diagnostics: ImportWarning[], pageIndex: number) {
  const explicit = actions.some(action => action.type === 'native_animation');
  const speechTargets = new Set<string>(), speechGroups = new Set<string>();
  requireValid(validSpeechAnimationSequence(actions), 'ANIMATION_TARGET_CONFLICT');
  for (const action of actions) if (action.type === 'speech') for (const cue of action.visualCues ?? []) {
    const effect = cue.effect;
    const ids = effect.type === 'highlight' ? effect.elementIds : [effect.elementId, ...(effect.type === 'spotlight' ? effect.elementIds ?? [] : [])];
    for (const id of ids) {
      const group = mapping.groups?.find(group => group.objectId === id);
      const target = page.elements.find(element => element.id === mapping.objects.find(object => object.objectId === id)?.importElementId);
      requireValid(group || target, 'EFFECT_BINDING_MISMATCH');
      if (group) projectNativeGroups(page, [group]);
      else requireValid(target && target.type !== 'line' && target.width > 0 && target.height > 0 &&
        (effect.type !== 'element_animation' || !['audio', 'video'].includes(target.type)), 'EFFECT_TARGET_UNSUPPORTED');
      if (effect.type !== 'element_animation') continue;
      if (group) {
        speechGroups.add(group.sourceShapeId);
        for (const child of page.elements.filter(element => element.sourceGroupShapeIds?.includes(group.sourceShapeId))) speechTargets.add(child.id);
      } else speechTargets.add(target!.id);
    }
  }
  let remaining = detachLinkedSpeechAnimations(page, actions, mapping.objects);
  // A saved speech cue owns the animation clock for its target. Legacy unbound timing
  // may survive an old editor repair; keep source bytes, suppress only that competing clock.
  if (!explicit && remaining.pptxAnimation) remaining = { ...remaining, pptxAnimation: { steps: remaining.pptxAnimation.steps.flatMap(step => {
    const items = step.items.filter(item => {
      const targets = page.elements.filter(element => element.sourceShapeId === item.target?.shapeId || element.sourceGroupShapeIds?.includes(item.target?.shapeId ?? ''));
      const conflict = targets.some(target => speechTargets.has(target.id));
      if (conflict) diagnostics.push({ code: 'PPTX_ANIMATION_SPEECH_OWNED', severity: 'warning', pageIndex,
        message: `Saved speech controls shape ${item.target?.shapeId}; competing unbound native timing is omitted from playback only.` });
      return !conflict;
    });
    return items.length ? [{ ...step, items }] : [];
  }) } };
  let nativeAnimations: NativeClickAnimations | undefined, nativeTimeline: NativeTimeline | undefined;
  if (!hasGeneratedNativeMotions(remaining, actions, mapping.objects)) {
    try { nativeAnimations = projectNativeClicks(remaining); }
    catch (error) {
      if (explicit) throw error;
      try { nativeTimeline = projectNativeTimeline(remaining, mapping.groups ?? []); }
      catch { nativeTimeline = fallbackNativeTimeline(remaining, mapping.groups ?? [], speechTargets, diagnostics, pageIndex); }
    }
  }
  if (explicit) {
    requireValid(validateNativeAnimationBindings(actions, sourceSha256, nativeAnimations?.steps.length ?? 0), 'NATIVE_ANIMATION_BINDING_MISMATCH');
    nativeAnimations = { ...nativeAnimations!, version: 2, sequence: 'teaching-timeline' };
    const revealed = new Set<string>();
    for (const action of actions) {
      if (action.type === 'native_animation') revealed.add(nativeAnimations.steps[action.stepIndex].elementId);
      if (action.type === 'speech') for (const cue of action.visualCues ?? []) {
        const effect = cue.effect;
        const ids = effect.type === 'highlight' ? effect.elementIds : [effect.elementId, ...(effect.type === 'spotlight' ? effect.elementIds ?? [] : [])];
        requireValid(ids.every(id => {
          const imported = mapping.objects.find(object => object.objectId === id)?.importElementId;
          return !nativeAnimations!.steps.some(step => step.elementId === imported) || revealed.has(imported!);
        }), 'NATIVE_ANIMATION_TARGET_NOT_REVEALED');
      }
    }
  }
  const nativeTargets = new Set([...(nativeAnimations?.steps.map(step => step.elementId) ?? []),
    ...(nativeTimeline?.steps.flatMap(step => step.items.map(item => item.elementId)) ?? [])]);
  requireValid([...speechTargets].every(id => !nativeTargets.has(id)), 'NATIVE_ANIMATION_CUE_CONFLICT');
  if (speechGroups.size) {
    requireValid(!explicit, 'NATIVE_ANIMATION_GROUP_BINDING_UNSUPPORTED');
    if (nativeAnimations) {
      nativeTimeline = projectNativeTimeline(remaining, mapping.groups ?? []);
      nativeAnimations = undefined;
    }
    const aliases = [...(nativeTimeline?.groups ?? []).map(group => {
      const alias = mapping.groups?.find(alias => `native_group_${alias.objectId}` === group.elementId);
      return alias ?? { objectId: group.elementId.slice('native_group_'.length), sourceShapeId: group.elementId.slice('native_group_source_'.length) };
    }), ...(mapping.groups ?? []).filter(group => speechGroups.has(group.sourceShapeId))];
    const unique = [...new Map(aliases.map(group => [group.sourceShapeId, group])).values()];
    nativeTimeline = { version: 1, steps: nativeTimeline?.steps ?? [], groups: projectNativeTimelineGroups(page, unique) };
  }
  return { nativeAnimations, nativeTimeline };
}
