import { createHash } from 'node:crypto';

export type IdentityDecision = 'matched' | 'created' | 'deleted' | 'review';

export interface IdentityObjectSnapshot {
  logicalId: string;
  type: string;
  contentFingerprint: string;
  geometryFingerprint: string;
  sourceShapeId?: string;
}

export interface IdentityPageSnapshot {
  logicalId: string;
  contentFingerprint: string;
  objects: IdentityObjectSnapshot[];
  /** Set only by the persisted sidecar; never guessed from a copied page. */
  logicalIdHint?: string;
}

export interface IdentityReplacement {
  oldLogicalId: string;
  newContentFingerprint: string;
}

export interface IdentityReconcileOptions {
  copiedPageLogicalIds?: string[];
  replacements?: IdentityReplacement[];
}

export interface IdentityMapping {
  oldLogicalId?: string;
  newLogicalId?: string;
  decision: IdentityDecision;
  reason: string;
  geometryChanged?: boolean;
}

export interface IdentityReconcileReport {
  pages: IdentityMapping[];
  objects: IdentityMapping[];
}

const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

/** Geometry is intentionally separate from content so movement does not look like replacement. */
export const geometryFingerprint = (geometry: {
  left: number;
  top: number;
  width: number;
  height: number;
  rotate?: number;
}) => digest(geometry);

export const contentFingerprint = (content: unknown) => digest(content);

const unique = <T>(items: T[]) => (items.length === 1 ? items[0] : undefined);

export function reconcileIdentity(
  previous: IdentityPageSnapshot[],
  current: IdentityPageSnapshot[],
  options: IdentityReconcileOptions = {},
): IdentityReconcileReport {
  const copied = new Set(options.copiedPageLogicalIds ?? []);
  const replacements = new Map(
    (options.replacements ?? []).map((entry) => [entry.oldLogicalId, entry.newContentFingerprint]),
  );
  const usedPages = new Set<string>();
  const pagePairs: Array<[IdentityPageSnapshot, IdentityPageSnapshot]> = [];
  const pages: IdentityMapping[] = [];
  const objects: IdentityMapping[] = [];
  const ambiguousPages = new Set<string>();

  for (const oldPage of previous) {
    const hinted = current.filter(
      (page) =>
        page.logicalIdHint === oldPage.logicalId &&
        !usedPages.has(page.logicalId) &&
        !copied.has(page.logicalId),
    );
    const exact = current.filter(
      (page) =>
        !usedPages.has(page.logicalId) &&
        !copied.has(page.logicalId) &&
        (!page.logicalIdHint || page.logicalIdHint === oldPage.logicalId) &&
        page.contentFingerprint === oldPage.contentFingerprint,
    );
    const candidates = hinted.length ? hinted : exact;
    const ambiguous =
      candidates.length > 1 ||
      (!hinted.length &&
        candidates.length > 0 &&
        previous.filter((page) => page.contentFingerprint === oldPage.contentFingerprint).length >
          1);
    const candidate = ambiguous ? undefined : unique(candidates);
    if (candidate) {
      usedPages.add(candidate.logicalId);
      pagePairs.push([oldPage, candidate]);
      pages.push({
        oldLogicalId: oldPage.logicalId,
        newLogicalId: candidate.logicalId,
        decision: 'matched',
        reason: hinted.length ? 'persisted-page-lineage' : 'unique-page-content',
      });
    } else if (ambiguous) {
      for (const page of candidates) ambiguousPages.add(page.logicalId);
      pages.push({
        oldLogicalId: oldPage.logicalId,
        decision: 'review',
        reason: 'ambiguous-page-match',
      });
    } else {
      pages.push({
        oldLogicalId: oldPage.logicalId,
        decision: 'deleted',
        reason: 'page-not-found',
      });
    }
  }
  for (const page of current) {
    if (
      !usedPages.has(page.logicalId) &&
      !pages.some((entry) => entry.newLogicalId === page.logicalId)
    ) {
      pages.push({
        newLogicalId: page.logicalId,
        decision: ambiguousPages.has(page.logicalId) ? 'review' : 'created',
        reason: ambiguousPages.has(page.logicalId) ? 'ambiguous-page-match' : 'new-page',
      });
    }
  }

  for (const [oldPage, newPage] of pagePairs) {
    const usedObjects = new Set<string>();
    const ambiguousObjects = new Set<string>();
    for (const oldObject of oldPage.objects) {
      const replacementFingerprint = replacements.get(oldObject.logicalId);
      const candidates = newPage.objects.filter(
        (object) =>
          !usedObjects.has(object.logicalId) &&
          object.type === oldObject.type &&
          (replacementFingerprint
            ? object.contentFingerprint === replacementFingerprint
            : object.contentFingerprint === oldObject.contentFingerprint),
      );
      const matchingPrevious = oldPage.objects.filter(
        (object) =>
          object.type === oldObject.type &&
          (replacements.get(object.logicalId) ?? object.contentFingerprint) ===
            (replacementFingerprint ?? oldObject.contentFingerprint),
      );
      const ambiguous =
        candidates.length > 1 || (candidates.length > 0 && matchingPrevious.length > 1);
      const candidate = ambiguous ? undefined : unique(candidates);
      if (candidate) {
        usedObjects.add(candidate.logicalId);
        reportObject(objects, oldObject, candidate, Boolean(replacementFingerprint));
      } else if (ambiguous) {
        for (const object of candidates) ambiguousObjects.add(object.logicalId);
        reportObject(objects, oldObject, undefined, false, 'ambiguous-object-match');
      } else {
        reportObject(objects, oldObject, undefined, false, 'object-not-found');
      }
    }
    for (const object of newPage.objects) {
      if (!usedObjects.has(object.logicalId)) {
        if (ambiguousObjects.has(object.logicalId)) {
          objects.push({
            newLogicalId: object.logicalId,
            decision: 'review',
            reason: 'ambiguous-object-match',
          });
        } else {
          reportObject(objects, undefined, object, false, 'new-object');
        }
      }
    }
  }
  return { pages, objects };
}

function reportObject(
  target: IdentityMapping[],
  oldObject: IdentityObjectSnapshot | undefined,
  newObject: IdentityObjectSnapshot | undefined,
  changed: boolean,
  reason?: string,
) {
  target.push({
    oldLogicalId: oldObject?.logicalId,
    newLogicalId: newObject?.logicalId,
    decision:
      reason === 'new-object'
        ? 'created'
        : !newObject
          ? reason === 'ambiguous-object-match'
            ? 'review'
            : 'deleted'
          : changed
            ? 'review'
            : 'matched',
    reason: reason ?? (changed ? 'content-replaced' : 'unique-object-content'),
    geometryChanged:
      oldObject && newObject
        ? oldObject.geometryFingerprint !== newObject.geometryFingerprint
        : undefined,
  });
}
