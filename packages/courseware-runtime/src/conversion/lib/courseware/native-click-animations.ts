import { nativeMotionPreset } from '../../../generated-native-motion';
import type { SlidePageIR } from "../import/types";
import { nativeClickAnimationsSchema, type NativeClickAnimations } from "../../../native-click-animations";

/** No partial projection: every saved native step and target must fit this finite policy. */
export function projectNativeClicks(page: SlidePageIR): NativeClickAnimations | undefined {
  if (!page.pptxAnimation?.steps.length) return undefined;
  const steps = page.pptxAnimation.steps.map(step => {
    const item = step.items[0];
    const targets = item?.target ? page.elements.filter(element => element.sourceShapeId === item.target!.shapeId) : [];
    const target = targets[0];
    if (step.trigger !== "click" || step.items.length !== 1 || !item || item.startAtMs !== 0 ||
        item.animationType !== "in" || item.target?.paragraphIndexes || item.target?.characterRange ||
        item.motion || item.rotation || item.nativePreset?.version !== 1 || item.nativePreset.class !== "entr" ||
        !((item.nativePreset.id === 1 && item.effect === "appear") || (item.nativePreset.id === 10 && item.effect === "fade")) ||
        targets.length !== 1 || !target || !["text", "shape", "image"].includes(target.type) ||
        target.sourceGroupShapeIds?.length || target.width <= 0 || target.height <= 0)
      throw new Error("NATIVE_ANIMATION_UNSUPPORTED");
    return { id: step.id, trigger: "click" as const, elementId: target.id,
      effect: item.effect as "appear" | "fade", durationMs: item.durationMs };
  });
  const parsed = nativeClickAnimationsSchema.safeParse({ version: 1, sequence: "before-narration", steps });
  if (!parsed.success) throw new Error("NATIVE_ANIMATION_UNSUPPORTED");
  return parsed.data;
}

/** Exact native mirrors of speech cues have one owner: the canonical speech clock. */
export function hasGeneratedNativeMotions(page: SlidePageIR, actions: readonly { id?: string; type: string; visualCues?: readonly { atMs: number; endMs: number; effect: { type: string; elementId?: string; effect?: string } }[] }[], mapping: readonly { objectId: string; importElementId: string }[]): boolean {
  const groups = actions.filter(action => action.type === 'speech').map(action =>
    (action.visualCues ?? []).filter(cue => cue.effect.type === 'element_animation')).filter(cues => cues.length);
  const steps = page.pptxAnimation?.steps;
  if (!groups.length || !steps || steps.length !== groups.length || actions.some(a => a.type === 'native_animation')) return false;
  return groups.every((cues, index) => {
    const step = steps[index];
    return step.trigger === 'click' && step.items.length === cues.length && cues.every((cue, itemIndex) => {
      const preset = nativeMotionPreset(cue.effect.effect ?? ''), item = step.items[itemIndex];
      const imported = mapping.find(o => o.objectId === cue.effect.elementId)?.importElementId;
      const targets = page.elements.filter(e => e.id === imported && e.sourceShapeId === item?.target?.shapeId);
      return cue.atMs === 0 && Number.isInteger(cue.endMs) && cue.endMs >= 1 && cue.endMs <= 5000 && !!preset && !!item &&
        targets.length === 1 && ['text', 'shape', 'image'].includes(targets[0].type) && !targets[0].sourceGroupShapeIds?.length &&
        item.startAtMs === 0 && item.durationMs === cue.endMs && !item.target?.paragraphIndexes && !item.target?.characterRange &&
        item.nativePreset?.version === 1 && item.nativePreset.verifiedSpeechMotion === true && item.nativePreset.class === preset.ooxmlClass && item.nativePreset.id === preset.presetId &&
        (item.nativePreset.subtype ?? 0) === preset.subtype;
    });
  });
}

/** Speech owns exact persisted mirrors; explicit links additionally follow native preset and duration edits. */
export function detachLinkedSpeechAnimations<T extends { type: string; visualCues?: Array<{ nativeAnimation?: string; atMs: number; endMs: number; effect: { type: string; elementId?: string; effect?: string } }> }>(
  page: SlidePageIR, actions: T[], mapping: readonly { objectId: string; importElementId: string }[],
): SlidePageIR {
  const claimed = new Set<object>();
  for (const action of actions) for (const cue of action.visualCues ?? []) {
    if (!cue.nativeAnimation) {
      if (action.type !== 'speech' || cue.effect.type !== 'element_animation' || actions.some(a => a.type === 'native_animation')) continue;
      const preset = nativeMotionPreset(cue.effect.effect ?? '');
      const imported = mapping.find(object => object.objectId === cue.effect.elementId)?.importElementId;
      const targets = page.elements.filter(element => element.id === imported);
      const duration = cue.endMs - cue.atMs;
      if (!preset || targets.length !== 1 || !targets[0].sourceShapeId || !Number.isInteger(duration) || duration < 1 || duration > 5000) continue;
      const mirror = page.pptxAnimation?.steps.flatMap(step => step.items).find(item => !claimed.has(item) &&
        !!item.target && item.target.shapeId === targets[0].sourceShapeId && !item.target.paragraphIndexes && !item.target.characterRange &&
        item.startAtMs === 0 && item.durationMs === duration && item.nativePreset?.version === 1 && item.nativePreset.verifiedSpeechMotion === true &&
        item.nativePreset.class === preset.ooxmlClass && item.nativePreset.id === preset.presetId && (item.nativePreset.subtype ?? 0) === preset.subtype);
      if (mirror) claimed.add(mirror);
      continue;
    }
    if (action.type !== 'speech' || cue.effect.type !== 'element_animation' || cue.nativeAnimation !== cue.effect.elementId) throw new Error('NATIVE_ANIMATION_LINK_INVALID');
    const id = mapping.find(object => object.objectId === cue.nativeAnimation)?.importElementId;
    const target = page.elements.find(element => element.id === id);
    const matches = page.pptxAnimation?.steps.flatMap(step => step.items).filter(item => item.target?.shapeId === target?.sourceShapeId) ?? [];
    const item = matches[0];
    if (!target?.sourceShapeId || matches.length !== 1 || !item || claimed.has(item) || item.startAtMs !== 0 || item.durationMs < 1 || item.durationMs > 5000 ||
        item.target?.paragraphIndexes || item.target?.characterRange || item.motion || item.rotation) throw new Error('NATIVE_ANIMATION_LINK_STALE');
    const effects = ['fadeIn', 'fadeOut', 'pulse', 'zoomIn', 'slideInLeft', 'slideInRight', 'gentleRotate'];
    const effect = effects.find(effect => { const preset = nativeMotionPreset(effect)!; return item.nativePreset?.class === preset.ooxmlClass &&
      item.nativePreset.id === preset.presetId && (item.nativePreset.subtype ?? 0) === preset.subtype; });
    if (!effect) throw new Error('NATIVE_ANIMATION_LINK_UNSUPPORTED');
    cue.effect.effect = effect; cue.endMs = cue.atMs + item.durationMs;
    claimed.add(item);
  }
  return !claimed.size || !page.pptxAnimation ? page : { ...page, pptxAnimation: { ...page.pptxAnimation,
    steps: page.pptxAnimation.steps.map(step => ({ ...step, items: step.items.filter(item => !claimed.has(item)) })).filter(step => step.items.length),
  } };
}
