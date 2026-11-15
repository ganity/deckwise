import { COURSEWARE_MAX_BYTES } from "./courseware-contract.js";

/** Complete mapping for one immutable source, before subsequent native edits. */
export type CoursewareOnlineSourceMapping = {
  revision: string;
  sourceSha256: string;
  pages: Array<{
    pageId: string;
    importPageId: string;
    objects: Array<{ objectId: string; importElementId: string }>;
  }>;
};
export type CoursewareOnlineTeachingMapping = {
  projectId: string;
  source: { revision: string; sha256: string };
  mapping: CoursewareOnlineSourceMapping;
};

const exact = (value: unknown, keys: string[]): value is Record<string, unknown> => !!value && typeof value === "object" &&
  !Array.isArray(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const logicalId = (value: unknown): value is string => typeof value === "string" && /^[\w.-]{1,128}$/u.test(value) && value !== "." && value !== "..";
const importId = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0 &&
  value.length <= 200 && !/[\u0000-\u001f\u007f]/u.test(value);

/** Validate transport structure; only a verified parser can attest its association. */
export function isCoursewareOnlineSourceMapping(value: unknown): value is CoursewareOnlineSourceMapping {
  if (!exact(value, ["revision", "sourceSha256", "pages"]) || !logicalId(value.revision) ||
      typeof value.sourceSha256 !== "string" || !/^[a-f0-9]{64}$/u.test(value.sourceSha256) ||
      !Array.isArray(value.pages) || value.pages.length < 1 || value.pages.length > 100) return false;
  const logicalIds = new Set<string>(), importedPages = new Set<string>();
  let objectCount = 0;
  for (const page of value.pages) {
    if (!exact(page, ["pageId", "importPageId", "objects"]) || !logicalId(page.pageId) || !importId(page.importPageId) ||
        logicalIds.has(page.pageId) || importedPages.has(page.importPageId) || !Array.isArray(page.objects)) return false;
    logicalIds.add(page.pageId); importedPages.add(page.importPageId);
    objectCount += page.objects.length;
    if (objectCount > 10_000) return false;
    const importedObjects = new Set<string>();
    for (const object of page.objects) {
      if (!exact(object, ["objectId", "importElementId"]) || !logicalId(object.objectId) || !importId(object.importElementId) ||
          logicalIds.has(object.objectId) || importedObjects.has(object.importElementId)) return false;
      logicalIds.add(object.objectId); importedObjects.add(object.importElementId);
    }
  }
  try { return new TextEncoder().encode(JSON.stringify(value)).byteLength <= COURSEWARE_MAX_BYTES; }
  catch { return false; }
}
