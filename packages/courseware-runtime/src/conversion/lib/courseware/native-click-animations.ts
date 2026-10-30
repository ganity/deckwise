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
export function hasGeneratedNativeMotions(page: SlidePageIR, actions: readonly { type: string; visualCues?: readonly { atMs: number; endMs: number; effect: { type: string; elementId?: string; effect?: string } }[] }[], mapping: readonly { objectId: string; importElementId: string }[]): boolean {
  const motions = actions.flatMap(action => action.type === 'speech' ? (action.visualCues ?? []).filter(cue => cue.effect.type === 'element_animation') : []);
  const steps = page.pptxAnimation?.steps;
  if (!motions.length || !steps || steps.length !== motions.length || actions.some(a => a.type === 'native_animation')) return false;
  return motions.every((cue, index) => {
    const preset = nativeMotionPreset(cue.effect.effect ?? ''), step = steps[index], item = step.items[0];
    const imported = mapping.find(o => o.objectId === cue.effect.elementId)?.importElementId;
    const targets = page.elements.filter(e => e.id === imported && e.sourceShapeId === item?.target?.shapeId);
    return cue.atMs === 0 && !!preset && step.trigger === 'click' && step.items.length === 1 && !!item &&
      targets.length === 1 && ['text', 'shape', 'image'].includes(targets[0].type) && !targets[0].sourceGroupShapeIds?.length &&
      item.startAtMs === 0 && item.durationMs === cue.endMs && !item.target?.paragraphIndexes && !item.target?.characterRange &&
      item.nativePreset?.version === 1 && item.nativePreset.class === preset.ooxmlClass && item.nativePreset.id === preset.presetId &&
      (item.nativePreset.subtype ?? 0) === preset.subtype;
  });
}
