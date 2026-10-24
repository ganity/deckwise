import type { CoursewareAssetLocksView } from "@pi-desktop/shared";
import type { CoursewareTeachingCoordinator } from "./courseware-teaching";
import { readCandidateSource } from "./courseware-candidate-source";
import { coursewareAuthoringUrl } from "./courseware-runtime";

export type ImageProof = { sourceShapeId: string; assetSha256: string; pictureSha256: string; zIndex: number };
type LockedImage = { pageId: string; objectId: string; sourceSha256: string; mappingRevision: string; image: ImageProof };
type LockContext = { projectId: string; sourceSha256: string; mappingRevision: string; pageId: string;
  mapping: Parameters<typeof import("@pi-desktop/agent-runtime").resolvePageFadeTarget>[1];
  objects: Array<{ logicalId: string; type: string; sourceShapeId?: string }>;
  locks: { revision: string; images: LockedImage[] } | null };

function payload(value: unknown, keys: string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length !== keys.length ||
      keys.some(key => !Object.hasOwn(value, key))) throw new Error("Invalid saved-image lock request");
  return value as Record<string, unknown>;
}
const id = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 200;

/** Renderer selects a Host UUID; Main derives bytes and geometry from the exact saved source. */
export class CoursewareAssetLockCoordinator {
  constructor(private teaching: CoursewareTeachingCoordinator) {}

  async read(value: unknown): Promise<CoursewareAssetLocksView> {
    const request = payload(value, ["viewId", "expectedTeachingRevision"]);
    return (await this.inspect(request)).view;
  }

  async set(value: unknown): Promise<CoursewareAssetLocksView> {
    const request = payload(value, ["viewId", "expectedTeachingRevision", "expectedLockRevision", "objectId", "locked"]);
    if (!id(request.objectId) || typeof request.locked !== "boolean" || request.expectedLockRevision !== null && !id(request.expectedLockRevision))
      throw new Error("Invalid saved-image lock mutation");
    const state = await this.inspect(request);
    if (request.expectedLockRevision !== state.view.revision) throw new Error("Image locks changed; reload current page");
    let proof: ImageProof | undefined;
    if (request.locked) {
      const image = state.images.find(image => image.objectId === request.objectId);
      if (!image?.eligible || !image.assetSha256) throw new Error(image?.reason || "Only verified current saved images can be locked");
      proof = { sourceShapeId: image.sourceShapeId, assetSha256: image.assetSha256, pictureSha256: image.pictureSha256, zIndex: image.zIndex };
    } else if (!state.view.objects.some(object => object.objectId === request.objectId && object.locked) &&
        !state.view.staleLocks.some(object => object.objectId === request.objectId)) throw new Error("Image lock is not in the current view");
    await state.owner.assertCurrent();
    await state.owner.host.call("courseware.assetLocks.set", { ...state.identity, expectedLockRevision: request.expectedLockRevision,
      objectId: request.objectId, locked: request.locked, ...(proof ? { proof } : {}) });
    await state.owner.assertCurrent();
    return (await this.inspect(request)).view;
  }

  private async inspect(request: Record<string, unknown>) {
    if (!id(request.viewId) || !id(request.expectedTeachingRevision)) throw new Error("Invalid saved-image view");
    const owner = await this.teaching.assetLockContext({ viewId: request.viewId, expectedTeachingRevision: request.expectedTeachingRevision });
    const identity = { sessionId: owner.sessionId, projectId: owner.projectId, pageId: owner.pageId,
      expectedSourceRevision: owner.expectedSourceRevision, expectedTeachingRevision: owner.expectedTeachingRevision };
    const context = await owner.host.call<LockContext>("courseware.assetLocks.context", identity);
    await owner.assertCurrent();
    if (context.projectId !== owner.projectId || context.pageId !== owner.pageId || context.sourceSha256 !== owner.project.source.sha256 ||
        !id(context.mappingRevision) || !Array.isArray(context.objects) || context.objects.length > 10000 ||
        context.locks !== null && (!id(context.locks.revision) || !Array.isArray(context.locks.images))) throw new Error("Invalid Host image lock context");
    const source = await readCandidateSource(owner.sourcePath, context.sourceSha256, new AbortController().signal);
    const authoring = coursewareAuthoringUrl();
    if (!authoring) throw new Error("Installed courseware image inspector unavailable");
    const { inspectPageImageAssets } = await import(/* @vite-ignore */ authoring) as typeof import("@pi-desktop/courseware-runtime/authoring");
    const { resolvePageFadeTarget } = await import("@pi-desktop/agent-runtime");
    const target = await resolvePageFadeTarget(source, context.mapping, owner.pageId);
    const pictures = await inspectPageImageAssets(source, target.slidePart);
    const images = context.objects.flatMap((object, index) => {
      if (object.type !== "image") return [];
      const picture = pictures.find(picture => picture.sourceShapeId === object.sourceShapeId && picture.zIndex === index);
      return [{ objectId: object.logicalId, index: index + 1, ...(picture ?? { sourceShapeId: "", pictureSha256: "", zIndex: index,
        eligible: false, reason: "Saved image cannot be matched to an ordinary picture node" }) }];
    });
    const locks = context.locks?.images ?? [];
    const current = locks.filter(lock => lock.sourceSha256 === context.sourceSha256 && lock.mappingRevision === context.mappingRevision);
    const view: CoursewareAssetLocksView = { revision: context.locks?.revision ?? null, sourceSha256: context.sourceSha256,
      mappingRevision: context.mappingRevision, pageId: context.pageId,
      objects: images.map(image => ({ objectId: image.objectId, index: image.index, eligible: image.eligible,
        locked: current.some(lock => lock.pageId === context.pageId && lock.objectId === image.objectId),
        ...(image.assetSha256 ? { assetSha256: image.assetSha256 } : {}), ...(image.reason ? { reason: image.reason } : {}) })),
      staleLocks: locks.filter(lock => (lock.sourceSha256 !== context.sourceSha256 || lock.mappingRevision !== context.mappingRevision) &&
          (lock.pageId === context.pageId || !owner.project.pages.some(page => page.pageId === lock.pageId)))
        .map(lock => ({ objectId: lock.objectId, assetSha256: lock.image.assetSha256 })) };
    await owner.assertCurrent();
    return { owner, identity, context, images, view };
  }
}
