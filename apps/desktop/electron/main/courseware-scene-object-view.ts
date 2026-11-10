import { isCoursewareSceneTeaching, isCoursewareProject, isCoursewareAttentionCue, type CoursewareProject, type CoursewareTeachingView } from "@pi-desktop/shared";

const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const text = (value: unknown, max: number): value is string =>
  typeof value === "string" && value.trim().length > 0 && value.length <= max;
const sameProjectRevision = (raw: unknown, project: CoursewareProject): boolean =>
  isCoursewareProject(raw) && raw.projectId === project.projectId && raw.taskType === project.taskType &&
  raw.source.sha256 === project.source.sha256 && raw.source.revision === project.source.revision &&
  raw.teachingRevision === project.teachingRevision && raw.pages.length === project.pages.length &&
  raw.pages.every((page, index) => page.pageId === project.pages[index].pageId && page.locked === project.pages[index].locked);

/** All task types use current Host-bound UUIDs; display order is never an identity. */
export function objectsForTeaching(raw: unknown, project: CoursewareProject, pageId: string): CoursewareTeachingView["teachingObjects"] {
  const semantic = project.taskType === "scene" ? sceneObjectsForTeaching(raw, project, pageId) : undefined;
  if (!record(raw) || !sameProjectRevision(raw.project, project))
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
        ...(text(object.sourceShapeId, 200) ? { sourceShapeId: object.sourceShapeId } : {}),
        ...(text(object.sourceObjectName, 200) ? { sourceObjectName: object.sourceObjectName } : {}),
        savedKind: object.kind, savedIndex: position + 1, effectTargetEligible: ["text", "shape", "image"].includes(object.kind) };
    });
    if (page.pageId === pageId) current = objects;
  });
  if (!current) throw new Error("Saved object page is missing");
  if (project.taskType === "scene" && raw.nativeSaved === true) {
    return current.map(object => {
      const meaning = semantic?.find(previous => previous.objectId === object.objectId && previous.status === "mapped");
      return { ...object, ...(meaning ? { name: meaning.name, aliases: meaning.aliases, role: meaning.role } : {}) };
    });
  }
  if (project.taskType === "scene") {
    // A canonical cue can reference a new UUID only after explicit source-effect review.
    // Preserve all other scene semantic guards and expose no inferred re-associations.
    const referenced = new Set(project.pages.find(page => page.pageId === pageId)?.actions.flatMap(action =>
      Array.isArray(action.visualCues) ? action.visualCues.flatMap(cue => isCoursewareAttentionCue(cue) ?
        cue.effect.type === "highlight" ? cue.effect.elementIds : [cue.effect.elementId, ...(cue.effect.elementIds ?? [])] : []) : []));
    const reviewed = current.filter(object => referenced.has(object.objectId) && object.effectTargetEligible).map(object => {
      const proof = semantic?.find(candidate => candidate.objectId === object.objectId && candidate.status === "mapped");
      return { ...object, ...(proof ? { name: proof.name, role: proof.role, aliases: proof.aliases } : {}), ...(proof?.sourceShapeId ? { sourceShapeId: proof.sourceShapeId } : {}),
        ...(proof?.sourceObjectName ? { sourceObjectName: proof.sourceObjectName } : {}) };
    });
    return [...(semantic ?? []).filter(object => !reviewed.some(target => target.objectId === object.objectId)), ...reviewed];
  }
  return current;
}

/** Project only Host-validated semantics for this saved page, never prompts or authority. */
export function sceneObjectsForTeaching(raw: unknown, project: CoursewareProject, pageId: string): CoursewareTeachingView["teachingObjects"] {
  if (!record(raw) || !sameProjectRevision(raw.project, project))
    throw new Error("Scene object context changed; reload teaching");
  if (raw.sceneObjects === undefined) return undefined;
  const scene = raw.sceneObjects;
  if (!record(scene) || scene.schemaVersion !== "deckwise-scene-objects/1" || scene.sourceSha256 !== project.source.sha256 ||
      scene.requiresReview !== true || !Array.isArray(scene.pages) || scene.pages.length > 100)
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
      ...(object.status === "mapped" && text(object.element.objectName, 200) ? { sourceObjectName: object.element.objectName } : {}),
      ...(object.status === "mapped" && text(object.currentSourceShapeId, 200) ? { sourceShapeId: object.currentSourceShapeId } : {}),
      effectTargetEligible: object.status === "mapped" && ["native_text", "native_shape", "image_layer"].includes(String(object.element.type)) };
  });
}

/** Metadata follows logical page identity across native reorder/save, never the current ordinal. */
export function sceneTeachingForPage(raw: unknown, project: CoursewareProject, pageId: string): CoursewareTeachingView["teaching"] {
  if (project.taskType !== "scene") return undefined;
  sceneObjectsForTeaching(raw, project, pageId);
  if (!record(raw) || !record(raw.sceneObjects) || !Array.isArray(raw.sceneObjects.pages)) return undefined;
  const page = raw.sceneObjects.pages.find((p: unknown) => record(p) && p.pageId === pageId);
  if (!record(page) || page.teaching == null) return undefined;
  if (!isCoursewareSceneTeaching(page.teaching)) throw new Error("Invalid saved teaching page metadata");
  return page.teaching;
}

/** Current Host-validated canonical assessment bindings, independent of display order. */
export function assessmentPageIds(raw: unknown, project: CoursewareProject): ReadonlySet<string> {
  if (raw === undefined) return new Set();
  if (!record(raw) || !sameProjectRevision(raw.project, project))
    throw new Error("Assessment context changed; reload teaching");
  if (raw.assessmentPageIds === undefined) return new Set();
  if (!Array.isArray(raw.assessmentPageIds) || raw.assessmentPageIds.length > project.pages.length ||
      raw.assessmentPageIds.some(id => typeof id !== "string" || !project.pages.some(page => page.pageId === id)) ||
      new Set(raw.assessmentPageIds).size !== raw.assessmentPageIds.length)
    throw new Error("Invalid saved assessment bindings");
  return new Set(raw.assessmentPageIds as string[]);
}
