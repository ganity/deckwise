import { playbackActions } from './playback-actions';
import { z } from 'zod';
import type { ImportWarning, SlideIR } from '../import/types';
import { fixedBuildInputSchema } from './fixed-build-input';
import { resolveSingleChildSpeechAnimations } from './native-animation-fallback';
import { projectPlaybackAnimations } from './playback-animations';

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
      const matches = saved.objects.filter(object => object.sourceShapeId === element.sourceShapeId);
      if (matches.length !== 1) throw new Error(`OBJECT_BINDING_MISMATCH: page ${index + 1}, shape ${element.sourceShapeId}`);
      return { objectId: matches[0].logicalId, importElementId: element.id };
    });
    const groups = saved.objects.filter(object => page.elements.some(element => element.sourceGroupShapeIds?.includes(object.sourceShapeId)))
      .map(object => ({ objectId: object.logicalId, sourceShapeId: object.sourceShapeId }));
    return { pageId: saved.pageId, importPageId: page.id, objects, groups };
  }) };
  const diagnostics: ImportWarning[] = [];
  const errors: Array<{ code: string; pageNumber: number; pageId: string; message: string }> = [];
  for (const [index, page] of teaching.pages.entries()) {
    try {
      resolveSingleChildSpeechAnimations({ mapping: { ...mapping, pages: [mapping.pages[index]] }, teaching: { ...teaching, pages: [page] } }, [ir.pages[index]]);
      projectPlaybackAnimations(ir.pages[index], page.actions, mapping.pages[index], sha256, diagnostics, index);
    } catch (error) {
      const code = error instanceof Error ? error.message : 'PLAYBACK_PREFLIGHT_FAILED';
      errors.push({ code, pageNumber: index + 1, pageId: page.pageId, message: `Page ${index + 1}: ${code}` });
    }
  }
  return { sourceSha256: sha256, ready: errors.length === 0, issues: errors, diagnostics };
}
