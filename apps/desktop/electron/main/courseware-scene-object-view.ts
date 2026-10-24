import { isCoursewareProject, isCoursewareAttentionCue, type CoursewareProject, type CoursewareTeachingView } from "@pi-desktop/shared";

const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const text = (value: unknown, max: number): value is string =>
  typeof value === "string" && value.trim().length > 0 && value.length <= max;

/** All task types use current Host-bound UUIDs; display order is never an identity. */
export function objectsForTeaching(raw: unknown, project: CoursewareProject, pageId: string): CoursewareTeachingView["teachingObjects"] {
  const semantic = project.taskType === "scene" ? sceneObjectsForTeaching(raw, project, pageId) : undefined;
  if (!record(raw) || !isCoursewareProject(raw.project) || JSON.stringify(raw.project) !== JSON.stringify(project))
    throw new Error("Saved object context changed; reload teaching");
  if (raw.savedObjects === undefined) return semantic;
  const saved = raw.savedObjects, mapping = raw.mapping;
  if (!record(saved) || !record(mapping) || saved.sourceSha256 !== project.source.sha256 ||
      mapping.sourceSha256 !== project.source.sha256 || !text(saved.mappingRevision, 200) ||
      saved.mappingRevision !== mapping.revision || !Array.isArray(saved.pages) || saved.pages.length !== project.pages.length ||
      !Array.isArray(mapping.pages) || mapping.pages.length !== project.pages.length)
    throw new Error("Invalid current saved object context");
  const pageIds = new Set<string>();
  const ids = new Set<string>();
  const mappedPages = mapping.pages;
  let current: NonNullable<CoursewareTeachingView["teachingObjects"]> | undefined;
  saved.pages.forEach((page: unknown, index: number) => {
    const bound = mappedPages[index];
    if (!record(page) || !record(bound) || page.pageId !== project.pages[index].pageId || page.pageId !== bound.pageId ||
        pageIds.has(page.pageId) || !Array.isArray(page.objects) || page.objects.length > 10000 ||
        !Array.isArray(bound.objects) || bound.objects.length !== page.objects.length)
      throw new Error("Invalid saved page object mapping");
    pageIds.add(page.pageId);
    const boundObjects = bound.objects;
    const objects = page.objects.map((object: unknown, position: number) => {
      const binding = boundObjects[position];
      if (!record(object) || !record(binding) || !text(object.objectId, 200) || ids.has(object.objectId) ||
          object.objectId !== binding.objectId || !text(object.kind, 200) || object.index !== position + 1)
        throw new Error("Invalid saved teaching object");
      ids.add(object.objectId);
      return { objectId: object.objectId, name: String(position + 1), aliases: [], status: "mapped" as const,
        savedKind: object.kind, savedIndex: position + 1, effectTargetEligible: ["text", "shape", "image"].includes(object.kind) };
    });
    if (page.pageId === pageId) current = objects;
  });
  if (!current) throw new Error("Saved object page is missing");
  if (project.taskType === "scene") {
    // A canonical cue can reference a new UUID only after explicit source-effect review.
    // Preserve all other scene semantic guards and expose no inferred re-associations.
    const referenced = new Set(project.pages.find(page => page.pageId === pageId)?.actions.flatMap(action =>
      Array.isArray(action.visualCues) ? action.visualCues.flatMap(cue => isCoursewareAttentionCue(cue) ?
        cue.effect.type === "highlight" ? cue.effect.elementIds : [cue.effect.elementId, ...(cue.effect.elementIds ?? [])] : []) : []));
    const reviewed = current.filter(object => referenced.has(object.objectId) && object.effectTargetEligible);
    return [...(semantic ?? []).filter(object => !reviewed.some(target => target.objectId === object.objectId)), ...reviewed];
  }
  return current;
}

/** Project only Host-validated semantics for this saved page, never prompts or authority. */
export function sceneObjectsForTeaching(raw: unknown, project: CoursewareProject, pageId: string): CoursewareTeachingView["teachingObjects"] {
  if (!record(raw) || !isCoursewareProject(raw.project) || JSON.stringify(raw.project) !== JSON.stringify(project))
    throw new Error("Scene object context changed; reload teaching");
  if (raw.sceneObjects === undefined) return undefined;
  const scene = raw.sceneObjects;
  if (!record(scene) || scene.schemaVersion !== "deckwise-scene-objects/1" || scene.sourceSha256 !== project.source.sha256 ||
      scene.requiresReview !== true || !Array.isArray(scene.pages) || scene.pages.length > 30)
    throw new Error("Invalid saved scene object context");
  const pages = scene.pages.filter(page => record(page) && page.pageId === pageId);
  if (pages.length > 1) throw new Error("Duplicate saved scene page");
  if (!pages.length) return [];
  const page = pages[0];
  if (!Array.isArray(page.objects) || page.objects.length > 200) throw new Error("Invalid saved scene objects");
  const ids = new Set<string>();
  return page.objects.map((object: unknown) => {
    if (!record(object) || !text(object.objectId, 200) || ids.has(object.objectId) || !record(object.element) ||
        !text(object.element.elementId, 200) ||
        (object.element.semanticRole !== undefined && !text(object.element.semanticRole, 8000)) ||
        !Array.isArray(object.element.spokenAliases) || object.element.spokenAliases.length > 50 ||
        !object.element.spokenAliases.every((alias: unknown) => text(alias, 500)) ||
        (object.status !== "mapped" && object.status !== "missing" && object.status !== "content_changed" && object.status !== "identity_mismatch"))
      throw new Error("Invalid saved scene teaching object");
    ids.add(object.objectId);
    return { objectId: object.objectId, name: object.element.elementId,
      ...(object.element.semanticRole ? { role: object.element.semanticRole } : {}),
      aliases: [...object.element.spokenAliases], status: object.status,
      effectTargetEligible: object.status === "mapped" && ["native_text", "native_shape", "image_layer"].includes(String(object.element.type)) };
  });
}
