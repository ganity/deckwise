import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { ImportWarning, SlideIR } from '../types';
import { fixedBuildInputSchema } from '../../courseware/fixed-build-input';
import { geometryFingerprint, reconcileIdentity } from './identity';

const id = z.string().min(1).max(200);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const fingerprint = (value: unknown) =>
  createHash('sha256')
    .update(
      JSON.stringify(value, (_key, item) =>
        item && typeof item === 'object' && !Array.isArray(item)
          ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b)))
          : item,
      ),
    )
    .digest('hex');
const objectSchema = z
  .object({
    logicalId: id,
    importElementId: id,
    type: id,
    contentFingerprint: hash,
    geometryFingerprint: hash,
    sourceShapeId: id.optional(),
  })
  .strict();
const identitySchema = z
  .object({
    schemaVersion: z.literal('maic-saved-source-identity/1'),
    sourceSha256: hash,
    mappingRevision: id.optional(),
    pages: z
      .array(
        z
          .object({
            logicalId: id,
            importPageId: id,
            contentFingerprint: hash,
            objects: z.array(objectSchema).max(10000),
          })
          .strict(),
      )
      .min(1)
      .max(100),
    diagnostics: z.array(
      z
        .object({
          code: id,
          message: z.string(),
          severity: z.enum(['info', 'warning', 'error']).optional(),
          pageIndex: z.number().int().nonnegative().optional(),
        })
        .strict(),
    ),
  })
  .strict();
export type SavedSourceIdentity = z.infer<typeof identitySchema>;

function requireIdentity(value: unknown, code: string): asserts value {
  if (!value) throw new Error(code);
}
function unique(values: string[]) {
  requireIdentity(new Set(values).size === values.length, 'IDENTITY_DUPLICATE_BINDING');
}
export function validateSavedSourceIdentity(raw: unknown): SavedSourceIdentity {
  requireIdentity(
    Buffer.byteLength(JSON.stringify(raw) ?? '') <= 16 * 1024 * 1024,
    'IDENTITY_SIZE_LIMIT',
  );
  const parsed = identitySchema.safeParse(raw);
  requireIdentity(parsed.success, 'IDENTITY_SCHEMA_INVALID');
  const result = parsed.data;
  unique(result.pages.map((p) => p.importPageId));
  unique(result.pages.flatMap((p) => [p.logicalId, ...p.objects.map((o) => o.logicalId)]));
  requireIdentity(
    result.pages.reduce((sum, p) => sum + p.objects.length, 0) <= 10000,
    'IDENTITY_SIZE_LIMIT',
  );
  result.pages.forEach((p) => unique(p.objects.map((o) => o.importElementId)));
  return result;
}

/** Called inside the offline worker, before its output can be adopted by Host. */
export async function exportSavedSourceIdentity(
  sourceSha256: string,
  ir: SlideIR,
  readAsset: (reference: string) => Promise<Uint8Array>,
): Promise<SavedSourceIdentity> {
  const diagnostics: ImportWarning[] = [...(ir.warnings ?? [])];
  const assets = new Map<string, string>();
  async function normalize(value: unknown): Promise<unknown> {
    if (typeof value === 'string' && value.startsWith('import-asset:')) {
      let digest = assets.get(value);
      if (!digest) {
        digest = createHash('sha256')
          .update(await readAsset(value))
          .digest('hex');
        assets.set(value, digest);
      }
      return { assetSha256: digest };
    }
    if (Array.isArray(value)) return Promise.all(value.map(normalize));
    if (value && typeof value === 'object') {
      const entries = await Promise.all(
        Object.entries(value).map(async ([key, item]) => {
          if (
            ['src', 'poster', 'pattern'].includes(key) &&
            typeof item === 'string' &&
            item &&
            !item.startsWith('import-asset:')
          ) {
            diagnostics.push({
              code: 'IDENTITY_RESOURCE_UNRESOLVED',
              severity: 'error',
              message: 'Identity cannot verify a resource outside the offline asset registry',
            });
          }
          return [key, await normalize(item)];
        }),
      );
      return Object.fromEntries(entries);
    }
    return value;
  }
  const pages = [];
  for (const page of ir.pages) {
    const pageId = `source:${sourceSha256}:page:${page.id}`;
    const objects = [];
    for (const element of page.elements) {
      const {
        id: importElementId,
        sourceShapeId,
        sourceGroupShapeIds: _groups,
        sourceOrder: _order,
        left,
        top,
        width,
        height,
        rotate = 0,
        ...content
      } = element;
      objects.push({
        logicalId: `object:${fingerprint([sourceSha256, page.id, importElementId])}`,
        importElementId,
        type: element.type,
        sourceShapeId,
        contentFingerprint: fingerprint(await normalize(content)),
        geometryFingerprint: geometryFingerprint({ left, top, width, height, rotate }),
      });
    }
    pages.push({
      logicalId: pageId,
      importPageId: page.id,
      objects,
      contentFingerprint: fingerprint({
        width: page.width,
        height: page.height,
        background: await normalize(page.background),
        notes: page.notes,
        objects: objects.map((o) => o.contentFingerprint).sort(),
      }),
    });
  }
  return validateSavedSourceIdentity({
    schemaVersion: 'maic-saved-source-identity/1',
    sourceSha256,
    pages,
    diagnostics,
  });
}

/** Only bind a complete Host-owned mapping from the exact same saved bytes. */
export function bindSavedSourceIdentity(raw: unknown, rawMapping: unknown): SavedSourceIdentity {
  const source = validateSavedSourceIdentity(raw);
  const mapping = fixedBuildInputSchema.shape.mapping.parse(rawMapping);
  requireIdentity(source.sourceSha256 === mapping.sourceSha256, 'IDENTITY_SOURCE_MISMATCH');
  unique(mapping.pages.map((p) => p.importPageId));
  requireIdentity(mapping.pages.length === source.pages.length, 'IDENTITY_BINDING_MISMATCH');
  const pages = source.pages.map((page) => {
    const binding = mapping.pages.find((p) => p.importPageId === page.importPageId);
    requireIdentity(binding, 'IDENTITY_BINDING_MISMATCH');
    unique(binding.objects.map((o) => o.importElementId));
    requireIdentity(binding.objects.length === page.objects.length, 'IDENTITY_BINDING_MISMATCH');
    return {
      ...page,
      logicalId: binding.pageId,
      objects: page.objects.map((object) => {
        const target = binding.objects.find((o) => o.importElementId === object.importElementId);
        requireIdentity(target, 'IDENTITY_BINDING_MISMATCH');
        return { ...object, logicalId: target.objectId };
      }),
    };
  });
  return validateSavedSourceIdentity({ ...source, mappingRevision: mapping.revision, pages });
}

const lineageSchema = z
  .object({
    previousSourceSha256: hash,
    currentSourceSha256: hash,
    pages: z.array(z.object({ oldLogicalId: id, importPageId: id }).strict()).max(100),
    copiedImportPageIds: z.array(id).max(100),
    replacements: z
      .array(
        z
          .object({
            oldLogicalId: id,
            importPageId: id,
            importElementId: id,
          })
          .strict(),
      )
      .max(10000),
  })
  .strict();

/** Lineage is supplied by Host's trusted journal, never by renderer/page ordinals. */
export function reconcileSavedSources(
  previousRaw: unknown,
  currentRaw: unknown,
  trustedLineage?: unknown,
) {
  const previous = validateSavedSourceIdentity(previousRaw);
  const current = validateSavedSourceIdentity(currentRaw);
  requireIdentity(previous.mappingRevision, 'IDENTITY_PREVIOUS_BINDING_REQUIRED');
  const lineage = trustedLineage === undefined ? undefined : lineageSchema.parse(trustedLineage);
  if (lineage) {
    requireIdentity(
      lineage.previousSourceSha256 === previous.sourceSha256 &&
        lineage.currentSourceSha256 === current.sourceSha256,
      'IDENTITY_STALE_LINEAGE',
    );
    unique(lineage.pages.map((p) => p.oldLogicalId));
    unique(lineage.pages.map((p) => p.importPageId));
    unique(lineage.copiedImportPageIds);
    unique(lineage.replacements.map((o) => o.oldLogicalId));
    unique(lineage.replacements.map((o) => `${o.importPageId}\0${o.importElementId}`));
    for (const hint of lineage.pages)
      requireIdentity(
        previous.pages.some((p) => p.logicalId === hint.oldLogicalId) &&
          current.pages.some((p) => p.importPageId === hint.importPageId) &&
          !lineage.copiedImportPageIds.includes(hint.importPageId),
        'IDENTITY_LINEAGE_TARGET_INVALID',
      );
    for (const copy of lineage.copiedImportPageIds)
      requireIdentity(
        current.pages.some((p) => p.importPageId === copy),
        'IDENTITY_LINEAGE_TARGET_INVALID',
      );
  }
  const pages = current.pages.map((page) => ({
    ...page,
    logicalIdHint: lineage?.pages.find((p) => p.importPageId === page.importPageId)?.oldLogicalId,
  }));
  const replacements = (lineage?.replacements ?? []).map((replacement) => {
    const oldPage = previous.pages.find((p) =>
      p.objects.some((o) => o.logicalId === replacement.oldLogicalId),
    );
    const page = pages.find((p) => p.importPageId === replacement.importPageId);
    const object = page?.objects.find((o) => o.importElementId === replacement.importElementId);
    requireIdentity(
      oldPage &&
        page &&
        object &&
        page.logicalIdHint === oldPage.logicalId &&
        oldPage.objects.find((o) => o.logicalId === replacement.oldLogicalId)?.type === object.type,
      'IDENTITY_LINEAGE_TARGET_INVALID',
    );
    return {
      oldLogicalId: replacement.oldLogicalId,
      newContentFingerprint: object.contentFingerprint,
    };
  });
  const report = reconcileIdentity(previous.pages, pages, {
    copiedPageLogicalIds: pages
      .filter((p) => lineage?.copiedImportPageIds.includes(p.importPageId))
      .map((p) => p.logicalId),
    replacements,
  });
  return {
    previousSourceSha256: previous.sourceSha256,
    currentSourceSha256: current.sourceSha256,
    // Fingerprint matches are proposals; source changes still invalidate audio/cues and require Host review.
    requiresHostReview:
      previous.sourceSha256 !== current.sourceSha256 ||
      [...report.pages, ...report.objects].some(
        (entry) => entry.decision !== 'matched' || entry.geometryChanged,
      ) ||
      [...previous.diagnostics, ...current.diagnostics].some((d) => d.severity !== 'info'),
    report,
    diagnostics: current.diagnostics,
  };
}
