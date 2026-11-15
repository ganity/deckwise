import { isCoursewareTeamAssetRef, type CoursewareTeamAssetRef } from "@pi-desktop/shared";
import type { CoursewareSceneImage } from "./courseware-scene-context";
import type { SceneCoursePlanPage } from "./courseware-scene-plan";

type Assignment = { pageId: string; visualMaster: CoursewareTeamAssetRef; cleanPlate: CoursewareTeamAssetRef; layers: CoursewareTeamAssetRef[] };
type Resolve = (references: readonly CoursewareTeamAssetRef[], signal?: AbortSignal) => Promise<CoursewareSceneImage[]>;

/** Bind authorized PNG references to the exact planned page; aliases from other pages stay hidden. */
export async function resolveSceneCourseVisuals(input: {
  pages: readonly SceneCoursePlanPage[];
  assignments: readonly Assignment[];
  canvas: { width: number; height: number };
  signal?: AbortSignal;
}, resolve: Resolve) {
  if (!Array.isArray(input.pages) || !Array.isArray(input.assignments) ||
      input.pages.length < 1 || input.pages.length > 30 || input.assignments.length !== input.pages.length ||
      new Set(input.pages.map((page) => page.pageId)).size !== input.pages.length ||
      new Set(input.assignments.map((assignment) => assignment.pageId)).size !== input.assignments.length)
    throw new Error("Invalid scene visual assignments");
  const all = new Map<string, CoursewareTeamAssetRef>();
  for (const assignment of input.assignments) {
    if (!input.pages.some((page) => page.pageId === assignment.pageId) || !Array.isArray(assignment.layers) || assignment.layers.length > 200)
      throw new Error("Scene visual assignment differs from planned pages");
    for (const reference of [assignment.visualMaster, assignment.cleanPlate, ...assignment.layers]) {
      if (!isCoursewareTeamAssetRef(reference) || reference.assetRef.mime !== "image/png")
        throw new Error("Scene visual assets must be authorized PNG references");
      const id = reference.assetRef.assetId;
      const previous = all.get(id);
      if (previous && JSON.stringify(previous) !== JSON.stringify(reference)) throw new Error("Scene visual asset reference changed");
      all.set(id, reference);
    }
  }
  input.signal?.throwIfAborted();
  const resolved = await resolve([...all.values()], input.signal);
  input.signal?.throwIfAborted();
  const byId = new Map(resolved.flatMap((image) => image.assetIds.map((id) => [id, image] as const)));
  return input.pages.map((page) => {
    const assignment = input.assignments.find((value) => value.pageId === page.pageId)!;
    const ids = [assignment.visualMaster, assignment.cleanPlate, ...assignment.layers].map((reference) => reference.assetRef.assetId);
    const master = byId.get(ids[0]), clean = byId.get(ids[1]);
    if (!master || !clean || master.width !== clean.width || master.height !== clean.height ||
        master.width !== input.canvas.width || master.height !== input.canvas.height || ids.some((id) => !byId.has(id)))
      throw new Error("Scene visual background differs from the selected canvas");
    const images = [...new Set(ids.map((id) => byId.get(id)!))].map((image) => ({
      ...image, assetIds: image.assetIds.filter((id) => ids.includes(id)), bytes: Buffer.from(image.bytes),
    }));
    return { pageId: page.pageId, visualMasterAssetId: ids[0], cleanPlateAssetId: ids[1], images };
  });
}
