import { fixedSlideSchema } from '../../../player/lib/courseware/load-fixed-build';
import { mapSlideIrToScenes } from '../import/mappers/import-ir-to-classroom';
import { playbackActions } from './playback-actions';
import { z } from 'zod';
import type { ImportWarning, SlideIR } from '../import/types';
import { fixedBuildInputSchema } from './fixed-build-input';
import { resolveSingleChildSpeechAnimations } from './native-animation-fallback';
import { projectPlaybackAnimations } from './playback-animations';
import { savedSourceObjectId } from '../import/pptx/saved-source-identity';
import { nativeMotionPreset } from '../../../generated-native-motion';

const identitySchema = z.object({ pages: z.array(z.object({ pageId: z.string(), objects: z.array(z.object({
  logicalId: z.string(), sourceShapeId: z.string(), sourceObjectName: z.string().optional(),
})) })) });

/** Read-only generation preflight; no snapshot publication, provider requests or source edits. */
export function inspectNativePlayback(source: SlideIR, sha256: string, pages: unknown, identity: unknown) {
  const savedPages = z.array(z.object({ pageId: z.string(), actions: z.array(z.record(z.string(), z.unknown())) })).parse(pages);
  const teaching = fixedBuildInputSchema.shape.teaching.parse({ revision: sha256, sourceSha256: sha256,
    pages: savedPages.map(page => ({ ...page, actions: playbackActions(page.actions) })) });
  const identities = identitySchema.parse(identity);
  const ir = structuredClone(source);
  if (ir.pages.length !== teaching.pages.length || identities.pages.length !== teaching.pages.length) throw new Error('PAGE_BINDING_MISMATCH');
  const mapping = { revision: sha256, sourceSha256: sha256, pages: ir.pages.map((page, index) => {
    const saved = identities.pages[index];
    if (saved.pageId !== teaching.pages[index].pageId) throw new Error('PAGE_BINDING_MISMATCH');
    const objects = page.elements.map(element => {
      if (!element.sourceShapeId && /^pptx_fallback_(?:layout|master)_/.test(element.id))
        return { objectId: savedSourceObjectId(sha256, page.id, element.id).replace(/^object:/, 'inherited-'), importElementId: element.id };
      const matches = saved.objects.filter(object => object.sourceShapeId === element.sourceShapeId);
      if (matches.length !== 1) throw new Error(`OBJECT_BINDING_MISMATCH: page ${index + 1}, shape ${element.sourceShapeId}`);
      return { objectId: matches[0].logicalId, importElementId: element.id };
    });
    const groups = saved.objects.filter(object => page.elements.some(element => element.sourceGroupShapeIds?.includes(object.sourceShapeId)))
      .map(object => ({ objectId: object.logicalId, sourceShapeId: object.sourceShapeId }));
    return { pageId: saved.pageId, importPageId: page.id, objects, groups };
  }) };
  const diagnostics: ImportWarning[] = [...(ir.warnings ?? [])];
  const errors: Array<{ code: string; pageNumber: number; pageId: string; message: string }> = diagnostics.filter(w => w.severity === 'error').map(w => ({
    code: w.code, pageNumber: w.pageIndex === undefined ? 0 : w.pageIndex + 1,
    pageId: w.pageIndex === undefined ? 'source' : teaching.pages[w.pageIndex]?.pageId ?? 'source', message: w.message,
  }));
  const scenes = mapSlideIrToScenes('preflight', ir);
  for (const [index, page] of teaching.pages.entries()) {
    try {
      const scene = scenes[index];
      if (scene.content.type !== 'slide' || !fixedSlideSchema.safeParse(scene.content.canvas).success) throw new Error('PACKAGE_SCHEMA_INVALID');
      const claimed = new Set<object>();
      const native = ir.pages[index].pptxAnimation?.steps.flatMap(step => step.items) ?? [];
      for (const action of page.actions) if (action.type === 'speech') for (const cue of action.visualCues ?? []) {
        const effect = cue.effect;
        if (effect.type !== 'element_animation' || cue.nativeAnimation || page.actions.some(action => action.type === 'native_animation')) continue;
        const shapeId = identities.pages[index].objects.find(object => object.logicalId === effect.elementId)?.sourceShapeId;
        if (!shapeId) continue; // Target validation below reports the more precise binding error.
        const target = ir.pages[index].elements.find(element => element.sourceShapeId === shapeId);
        const owners = new Set([shapeId, ...(target?.sourceGroupShapeIds ?? [])]);
        const preset = nativeMotionPreset(effect.effect);
        const mirror = native.find(item => !claimed.has(item) && item.target && owners.has(item.target.shapeId) &&
          !item.target.paragraphIndexes && !item.target.characterRange && item.durationMs === cue.endMs - cue.atMs &&
          preset && item.nativePreset?.class === preset.ooxmlClass && item.nativePreset.id === preset.presetId &&
          (item.nativePreset.subtype ?? 0) === preset.subtype);
        if (!mirror) throw new Error('NATIVE_SPEECH_ANIMATION_MISSING');
        claimed.add(mirror);
      }
      resolveSingleChildSpeechAnimations({ mapping: { ...mapping, pages: [mapping.pages[index]] }, teaching: { ...teaching, pages: [page] } }, [ir.pages[index]]);
      projectPlaybackAnimations(ir.pages[index], page.actions, mapping.pages[index], sha256, diagnostics, index);
    } catch (error) {
      const code = error instanceof Error ? error.message : 'PLAYBACK_PREFLIGHT_FAILED';
      errors.push({ code, pageNumber: index + 1, pageId: page.pageId, message: `Page ${index + 1}: ${code}` });
    }
  }
  return { sourceSha256: sha256, ready: errors.length === 0, issues: errors, diagnostics };
}
