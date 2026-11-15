import { createHash, randomUUID } from "node:crypto";
import { nativeImage } from "electron";
import { isCoursewareTaskRef, samePptEditorBinding, type CoursewareSceneImageAsset, type CoursewareTaskRef, type CoursewareTeamAssetRef, type PptEditorBinding, type PptEditorCommand, type PptEditorContext } from "@pi-desktop/shared";
import type { DesktopAuthSession } from "./auth-session";
import { isSceneImageAsset, readSceneImageAsset, verifySceneImageAsset } from "./courseware-scene-image-assets";

export type ReviewedImage = { assetId: string; sha256: string; mime: "image/png"; byteLength: number; width: number; height: number };
export type ReviewedImageTarget = { page: number; editGeneration: number; operation: "replace" | "insert" };
type Host = { call<T>(method: string, params: unknown): Promise<T> };
type CanvasAsset = CoursewareSceneImageAsset & { taskRef: CoursewareTaskRef };
type ImageSource = { kind: "team"; reference: CoursewareTeamAssetRef } |
  { kind: "canvas"; host: Host; intentId: string; asset: CanvasAsset; bytes: Buffer };
const imageTool = (operation: ReviewedImageTarget["operation"]) => operation === "replace" ? "replace_slide_image_from_asset" : "insert_slide_image_from_asset";
type Editor = {
  teachingSnapshot(workspace: string | null): PptEditorBinding & { sha256: string; revision: number };
  verifyTeachingSource(workspace: string | null): Promise<void>;
  getContext(workspace: string | null): Promise<PptEditorContext>;
  reviewImageTarget(asset: ReviewedImage, target: ReviewedImageTarget, workspace: string | null): Promise<PptEditorContext>;
};

/** One explicit review binds an immutable image to this saved PPTX and owning Chat only. */
export class CoursewareImageReview {
  private review: { id: string; sessionId: string; workspace: string; snapshot: ReturnType<Editor["teachingSnapshot"]>;
    principal: ReturnType<DesktopAuthSession["getCoursewarePrincipal"]>; source: ImageSource;
    asset: ReviewedImage; target?: ReviewedImageTarget; approved: boolean } | null = null;
  private sequence = 0;

  constructor(private editor: Editor, private auth: DesktopAuthSession, private getWorkspace: () => Promise<string | null>,
    private assertOwner: (sessionId: string) => void, private getHost?: () => Host | null) {}

  clear(): void { this.sequence++; this.review = null; }

  async prepare(payload: unknown) {
    this.clear();
    const sequence = this.sequence;
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new Error("Invalid image review request");
    const keys = Object.keys(payload).sort().join(",");
    const canvas = keys === "intentId,operation,sessionId";
    if (canvas ? typeof Reflect.get(payload, "sessionId") !== "string" || typeof Reflect.get(payload, "intentId") !== "string" ||
        !/^[A-Za-z0-9._-]{1,128}$/u.test(Reflect.get(payload, "intentId")) || [".", ".."].includes(Reflect.get(payload, "intentId")) ||
        !["replace", "insert"].includes(Reflect.get(payload, "operation")) :
        keys !== "assetId,projectId,sessionId" || !["sessionId", "projectId", "assetId"].every(key => typeof Reflect.get(payload, key) === "string"))
      throw new Error("Invalid image review request");
    const sessionId: string = Reflect.get(payload, "sessionId");
    this.assertOwner(sessionId);
    const principal = this.auth.getCoursewarePrincipal();
    const workspace = await this.getWorkspace();
    if (!workspace) throw new Error("No active courseware workspace");
    const snapshot = this.editor.teachingSnapshot(workspace);
    let source: ImageSource, asset: ReviewedImage, bytes: Buffer, projectId: string, target: ReviewedImageTarget | undefined;
    if (canvas) {
      const host = this.getHost?.();
      if (!host) throw new Error("Host is unavailable");
      const context = await this.editor.getContext(workspace);
      if (!samePptEditorBinding(context, snapshot) || context.readOnly || !Number.isSafeInteger(context.page) || Number(context.page) < 1)
        throw new Error("Select an editable slide before reviewing a canvas image");
      target = { page: context.page!, editGeneration: context.editGeneration, operation: Reflect.get(payload, "operation") };
      const intentId: string = Reflect.get(payload, "intentId");
      const image = await this.canvasAsset(host, sessionId, principal.key, intentId);
      bytes = image.asset.mimeType === "image/png" ? image.bytes : nativeImage.createFromBuffer(image.bytes).toPNG();
      if (!bytes.length || bytes.length > 4 * 1024 * 1024) throw new Error("The reviewed PNG exceeds the native editor's 4 MiB image limit");
      asset = { assetId: `canvas-${randomUUID()}`, sha256: createHash("sha256").update(bytes).digest("hex"), mime: "image/png",
        byteLength: bytes.length, width: image.asset.width, height: image.asset.height };
      verifySceneImageAsset(bytes, { ...asset, mimeType: asset.mime });
      source = { kind: "canvas", host, intentId, asset: image.asset, bytes: Buffer.from(bytes) };
      projectId = snapshot.projectId;
    } else {
      const reference = await this.auth.coursewareMedia.getTeamAsset(Reflect.get(payload, "projectId"), Reflect.get(payload, "assetId"));
      if (reference.assetRef.mime !== "image/png" || reference.assetRef.byteLength > 4 * 1024 * 1024) throw new Error("Only PNG images up to 4 MiB can replace slide images");
      const [image] = await this.auth.resolveTeamSceneImages([reference]);
      bytes = Buffer.from(image.bytes);
      asset = { assetId: reference.assetRef.assetId, sha256: image.sha256, mime: "image/png",
        byteLength: bytes.length, width: image.width, height: image.height };
      source = { kind: "team", reference }; projectId = reference.projectId;
    }
    this.assertOwner(sessionId); principal.assertCurrent();
    if (sequence !== this.sequence || await this.getWorkspace() !== workspace) throw new Error("Image review expired");
    await this.editor.verifyTeachingSource(workspace);
    this.assertOwner(sessionId); principal.assertCurrent();
    const current = this.editor.teachingSnapshot(workspace);
    if (sequence !== this.sequence || source.kind === "canvas" && this.getHost?.() !== source.host ||
        !samePptEditorBinding(current, snapshot) || current.sha256 !== snapshot.sha256 || current.revision !== snapshot.revision) throw new Error("Image review source changed");
    const id = randomUUID();
    this.review = { id, sessionId, workspace, snapshot, principal, source, asset, target, approved: false };
    return { reviewId: id, projectId, asset, preview: `data:image/png;base64,${bytes.toString("base64")}`,
      ...(target ? { target: { page: target.page, operation: target.operation } } : {}) };
  }

  async approve(reviewId: unknown) {
    const review = this.review;
    if (!review || review.id !== reviewId) throw new Error("Image review expired");
    await this.current(review);
    if (review.target) {
      try {
        const context = await this.editor.reviewImageTarget(review.asset, review.target, review.workspace);
        await this.current(review);
        if (!samePptEditorBinding(context, review.snapshot) || context.readOnly || context.page !== review.target.page ||
            !context.capabilities.some(capability => capability.name === imageTool(review.target!.operation)))
          throw new Error("The selected target does not support this image operation");
        review.target = { ...review.target, editGeneration: context.editGeneration };
      } catch (error) { if (this.review === review) this.clear(); throw error; }
    }
    review.approved = true;
    return { assetId: review.asset.assetId };
  }

  async metadata(workspace: string | null): Promise<ReviewedImage | null> {
    const review = this.review;
    if (!review?.approved || review.workspace !== workspace) return null;
    try { await this.current(review); return { ...review.asset }; }
    catch { this.clear(); return null; }
  }

  async load(assetId: string, workspace: string | null, command?: PptEditorCommand) {
    const review = this.review;
    if (!review?.approved || review.workspace !== workspace || review.asset.assetId !== assetId) throw new Error("Image has not been reviewed for this PPTX");
    await this.current(review);
    let bytes: Buffer;
    if (review.source.kind === "canvas") {
      const target = review.target;
      if (!target || !command || !samePptEditorBinding(command, review.snapshot) ||
          command.tool !== imageTool(target.operation) || command.editGeneration !== target.editGeneration)
        throw new Error("Canvas image target changed; preview and approve it again");
      const image = await this.canvasAsset(review.source.host, review.sessionId, review.principal.key, review.source.intentId);
      const original = review.source.asset;
      if (["sha256", "mimeType", "byteLength", "width", "height"].some(key => Reflect.get(image.asset, key) !== Reflect.get(original, key)) ||
          ["taskId", "idempotencyKey", "requestHash"].some(key => Reflect.get(image.asset.taskRef, key) !== Reflect.get(original.taskRef, key)))
        throw new Error("Canvas image archive changed after review");
      bytes = Buffer.from(review.source.bytes);
    } else {
      const [image] = await this.auth.resolveTeamSceneImages([review.source.reference]);
      bytes = Buffer.from(image.bytes);
    }
    await this.current(review);
    return { asset: { ...review.asset }, bytes, assertCurrent: () => {
      this.assertOwner(review.sessionId); review.principal.assertCurrent();
      const now = this.editor.teachingSnapshot(review.workspace);
      if (this.review !== review || !review.approved || review.source.kind === "canvas" && this.getHost?.() !== review.source.host ||
          !samePptEditorBinding(now, review.snapshot) || now.sha256 !== review.snapshot.sha256 || now.revision !== review.snapshot.revision) throw new Error("Image review expired before native dispatch");
    } };
  }

  private async canvasAsset(host: Host, sessionId: string, principalKey: string, intentId: string) {
    if (this.getHost?.() !== host) throw new Error("Canvas image Host changed");
    const saved = await host.call<{ path: unknown; intent: { intentId: string; phase: string; taskRef: CoursewareTaskRef; asset: CanvasAsset } }>(
      "courseware.mediaCanvas.image.asset.get", { sessionId, principalKey, intentId });
    const intent = saved?.intent, asset = intent?.asset;
    if (this.getHost?.() !== host || intent?.intentId !== intentId || intent.phase !== "submitted" || !isSceneImageAsset(asset) ||
        !isCoursewareTaskRef(intent.taskRef) || !isCoursewareTaskRef(asset.taskRef) ||
        ["taskId", "idempotencyKey", "requestHash"].some(key => Reflect.get(asset.taskRef, key) !== Reflect.get(intent.taskRef, key)))
      throw new Error("Invalid canvas image archive");
    const bytes = await readSceneImageAsset(saved.path, asset);
    if (this.getHost?.() !== host) throw new Error("Canvas image Host changed");
    return { asset, bytes };
  }

  private async current(review: NonNullable<CoursewareImageReview["review"]>) {
    this.assertOwner(review.sessionId); review.principal.assertCurrent();
    if (this.review !== review || review.source.kind === "canvas" && this.getHost?.() !== review.source.host ||
        await this.getWorkspace() !== review.workspace) throw new Error("Image review expired");
    await this.editor.verifyTeachingSource(review.workspace);
    this.assertOwner(review.sessionId); review.principal.assertCurrent();
    const now = this.editor.teachingSnapshot(review.workspace);
    if (this.review !== review || !samePptEditorBinding(now, review.snapshot) || now.sha256 !== review.snapshot.sha256 || now.revision !== review.snapshot.revision) throw new Error("Image review source changed");
  }
}
