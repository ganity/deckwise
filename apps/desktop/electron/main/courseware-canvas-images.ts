import { createHash, randomUUID } from "node:crypto";
import { coursewareMediaSubmissionProject, isCoursewareMediaPermissionRefusal } from "./courseware-media-scope";
import { isCoursewareTaskRef, type CoursewareCanvasImageView, type CoursewareCanvasImageQuoteView,
  type CoursewareCanvasImagePreview, type CoursewareCanvasImageReferencePreview, type CoursewareSceneImageAsset, type CoursewareTaskRef } from "@pi-desktop/shared";
import type { DesktopAuthSession } from "./auth-session";
import type { CoursewareImageQuote, CoursewareImageRequest, CoursewareImageTask } from "./courseware-media";
import { isSceneImageAsset, readSceneImageAsset, verifySceneImageAsset } from "./courseware-scene-image-assets";

type Host = { call<T>(method: string, params: unknown): Promise<T> };
type Journal = { current: boolean; intent: {
  intentId: string; draft: CoursewareCanvasImageView["draft"];
  request: Omit<CoursewareImageRequest, "referenceImage"> & { referenceImage?: Omit<NonNullable<CoursewareImageRequest["referenceImage"]>, "bytesBase64"> };
  idempotencyKey: string; requestHash: string; phase: "prepared" | "submission-unknown" | "submitted" | "rejected"; taskRef: CoursewareTaskRef | null;
  submissionScope?: unknown;
  asset?: (CoursewareSceneImageAsset & { taskRef: CoursewareTaskRef }) | null;
} };
type CanvasImageTaskView = CoursewareCanvasImageView;
type CanvasImageQuoteView = CoursewareCanvasImageQuoteView;
const id = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9._-]{1,128}$/u.test(value) && value !== "." && value !== "..";
const hash = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
function input(value: unknown, fields: string[] = []): Record<string, string> {
  const keys = ["sessionId", ...fields];
  if (!object(value) || Object.keys(value).length !== keys.length || keys.some(key => !id(value[key])))
    throw new Error("COURSEWARE_CANVAS_IMAGE_INVALID_REQUEST");
  return { ...value } as Record<string, string>;
}
function requestHash(request: Journal["intent"]["request"]): string {
  const fields: Array<string | null> = [request.kind, request.model, request.input, null];
  if (request.referenceImage) fields.push(request.referenceImage.sha256, request.referenceImage.mimeType, String(request.referenceImage.byteLength));
  return createHash("sha256").update(fields.reduce<string>((text, value) => `${text}:${value === null ? -1 : value.length}:${value ?? ""}`, "courseware-media-v1")).digest("hex");
}
function checked(value: Journal, expectedId?: string): Journal {
  const intent = value?.intent, draft = intent?.draft, request = intent?.request;
  const ref = request?.referenceImage;
  if (typeof value?.current !== "boolean" || !intent || !id(intent.intentId) || expectedId !== undefined && intent.intentId !== expectedId ||
      !draft || typeof draft.id !== "string" || !draft.id.trim() || draft.id.length > 160 || draft.kind !== "image" ||
      !Number.isSafeInteger(draft.revision) || draft.revision < 0 || typeof draft.title !== "string" || !draft.title.trim() || draft.title.length > 160 ||
      !Array.isArray(draft.references) || draft.references.length > 1 ||
      request?.kind !== "image" || !id(request.model) || typeof request.input !== "string" || !request.input.trim() || request.input.length > 4000 || request.input !== draft.prompt ||
      Buffer.from(request.input, "utf8").toString("utf8") !== request.input ||
      draft.references.some(reference => !reference || typeof reference.assetId !== "string" || !reference.assetId.trim() || reference.assetId.length > 512 ||
        !hash(reference.revision) || typeof reference.label !== "string" || !reference.label.trim() || reference.label.length > 512) ||
      !!ref !== (draft.references.length === 1) || ref && (!object(ref) || Object.keys(ref).sort().join(",") !== "byteLength,mimeType,sha256" ||
        !hash(ref.sha256) || !["image/png", "image/jpeg"].includes(ref.mimeType) || !Number.isSafeInteger(ref.byteLength) ||
        ref.byteLength < 1 || ref.byteLength > 8 * 1024 * 1024 || ref.sha256 !== draft.references[0].revision) ||
      !/^[a-f0-9-]{36}$/u.test(intent.idempotencyKey) || !hash(intent.requestHash) || intent.requestHash !== requestHash(request) ||
      !["prepared", "submission-unknown", "submitted", "rejected"].includes(intent.phase) || (intent.phase === "submitted") !== (intent.taskRef !== null) ||
      intent.taskRef !== null && (!isCoursewareTaskRef(intent.taskRef) || intent.taskRef.idempotencyKey !== intent.idempotencyKey || intent.taskRef.requestHash !== intent.requestHash) ||
      intent.asset != null && (!isSceneImageAsset(intent.asset) || !intent.taskRef || !isCoursewareTaskRef(intent.asset.taskRef) ||
        intent.asset.taskRef.taskId !== intent.taskRef.taskId || intent.asset.taskRef.idempotencyKey !== intent.idempotencyKey || intent.asset.taskRef.requestHash !== intent.requestHash))
    throw new Error("COURSEWARE_CANVAS_IMAGE_INVALID_JOURNAL");
  return value;
}
function view(journal: Journal, task: CoursewareImageTask | null = null): CanvasImageTaskView {
  const i = journal.intent;
  return { intentId: i.intentId, draft: i.draft, model: i.request.model, phase: i.phase, current: journal.current,
    ...(i.asset === undefined ? {} : { asset: i.asset ? { sha256: i.asset.sha256, mimeType: i.asset.mimeType,
      byteLength: i.asset.byteLength, width: i.asset.width, height: i.asset.height } : null }),
    task: task && { state: task.state, feeState: task.feeState, reservedPoints: task.reservedPoints, actualPoints: task.actualPoints, errorCode: task.errorCode } };
}

/** Canvas request lifecycle; only a valid explicit quote confirmation may POST. */
export class CoursewareCanvasImages {
  private quotes = new Map<string, { scope: string; hash: string; quote: CoursewareImageQuote }>();
  private submitting = new Set<string>();
  private archiving = new Set<string>();
  constructor(private getHost: () => Host | null, private getSession: () => string | null,
    private isRunning: (sessionId: string) => boolean,
    private auth: Pick<DesktopAuthSession, "getCoursewarePrincipal" | "coursewareMedia">) {}

  private async context(params: Record<string, string>, requireAgent = false) {
    const p = { ...params }, host = this.getHost(), principal = this.auth.getCoursewarePrincipal();
    const assertCurrent = () => {
      principal.assertCurrent();
      if (!host || this.getHost() !== host || this.getSession() !== p.sessionId || this.isRunning(p.sessionId))
        throw new Error("COURSEWARE_CANVAS_IMAGE_CONTEXT_CHANGED");
    };
    assertCurrent();
    if (!host) throw new Error("Host unavailable");
    const { session } = await host.call<{ session?: { projectPath?: string; mode?: string } }>("session.get", { id: p.sessionId });
    assertCurrent();
    if (!session?.projectPath || requireAgent && session.mode !== "agent") throw new Error("COURSEWARE_CANVAS_IMAGE_AGENT_REQUIRED");
    return { host, assertCurrent, scope: { sessionId: p.sessionId, principalKey: principal.key, ...(p.intentId ? { intentId: p.intentId } : {}) } };
  }

  async models(value: unknown) {
    const c = await this.context(input(value));
    const models = await this.auth.coursewareMedia.getImageModels(); c.assertCurrent();
    return models.map(({ model, supportsReferenceImage }) => ({ model, supportsReferenceImage: supportsReferenceImage === true }));
  }

  async prepare(value: unknown): Promise<CanvasImageTaskView> {
    if (!object(value) || Object.keys(value).sort().join(",") !== "draftId,expectedDraftRevision,expectedRevision,intentId,model,sessionId" ||
        typeof value.draftId !== "string" || !value.draftId.trim() || value.draftId.length > 160 ||
        typeof value.expectedRevision !== "string" || !value.expectedRevision || value.expectedRevision.length > 128 ||
        !Number.isSafeInteger(value.expectedDraftRevision) || Number(value.expectedDraftRevision) < 0)
      throw new Error("COURSEWARE_CANVAS_IMAGE_INVALID_REQUEST");
    const frozen = structuredClone(value), { expectedDraftRevision, expectedRevision, draftId, ...ids } = frozen;
    const p = input(ids, ["intentId", "model"]), c = await this.context(p, true);
    const result = checked(await c.host.call<Journal>("courseware.mediaCanvas.image.prepare", { ...c.scope, model: p.model, draftId, expectedRevision, expectedDraftRevision }), p.intentId);
    c.assertCurrent();
    if (!result.current || result.intent.draft.id !== draftId || result.intent.draft.revision !== expectedDraftRevision || result.intent.request.model !== p.model)
      throw new Error("COURSEWARE_CANVAS_IMAGE_INVALID_JOURNAL");
    return view(result);
  }

  async list(value: unknown): Promise<CanvasImageTaskView[]> {
    const c = await this.context(input(value));
    const saved = await c.host.call<{ intents: Journal[] }>("courseware.mediaCanvas.image.list", c.scope); c.assertCurrent();
    if (!Array.isArray(saved.intents) || saved.intents.length > 300) throw new Error("COURSEWARE_CANVAS_IMAGE_INVALID_JOURNAL");
    return saved.intents.map(journal => view(checked(journal)));
  }

  private async reference(c: Awaited<ReturnType<CoursewareCanvasImages["context"]>>, journal: Journal) {
    const ref = journal.intent.request.referenceImage;
    if (!ref) return;
    const models = await this.auth.coursewareMedia.getImageModels(); c.assertCurrent();
    if (!models.some(model => model.model === journal.intent.request.model && model.supportsReferenceImage === true))
      throw new Error("COURSEWARE_CANVAS_IMAGE_REFERENCE_UNSUPPORTED");
    const resolved = await c.host.call<{ reference: unknown }>("courseware.mediaCanvas.image.reference", c.scope); c.assertCurrent();
    if (JSON.stringify(resolved.reference) !== JSON.stringify(ref)) throw new Error("COURSEWARE_CANVAS_IMAGE_REFERENCE_CHANGED");
  }

  private async readReference(c: Awaited<ReturnType<CoursewareCanvasImages["context"]>>, journal: Journal) {
    const ref = journal.intent.request.referenceImage;
    if (!ref) throw new Error("COURSEWARE_CANVAS_IMAGE_REFERENCE_REQUIRED");
    c.assertCurrent();
    const saved = await c.host.call<{ reference: unknown; path: unknown; asset: unknown }>("courseware.mediaCanvas.image.reference", c.scope); c.assertCurrent();
    if (JSON.stringify(saved.reference) !== JSON.stringify(ref) || !isSceneImageAsset(saved.asset) || saved.asset.sha256 !== ref.sha256 ||
        saved.asset.mimeType !== ref.mimeType || saved.asset.byteLength !== ref.byteLength) throw new Error("COURSEWARE_CANVAS_IMAGE_REFERENCE_CHANGED");
    const bytes = await readSceneImageAsset(saved.path, saved.asset); c.assertCurrent();
    return bytes;
  }

  async referencePreview(value: unknown): Promise<CoursewareCanvasImageReferencePreview> {
    const p = input(value, ["intentId"]), c = await this.context(p);
    const journal = checked(await c.host.call<Journal>("courseware.mediaCanvas.image.get", c.scope), p.intentId); c.assertCurrent();
    const bytes = await this.readReference(c, journal); c.assertCurrent();
    const ref = journal.intent.request.referenceImage!;
    return { intentId: p.intentId, reference: { ...journal.intent.draft.references[0] }, dataUrl: `data:${ref.mimeType};base64,${bytes.toString("base64")}` };
  }

  async quote(value: unknown): Promise<CanvasImageQuoteView> {
    const p = input(value, ["intentId"]), c = await this.context(p, true);
    const journal = checked(await c.host.call<Journal>("courseware.mediaCanvas.image.get", c.scope), p.intentId); c.assertCurrent();
    if (!journal.current || journal.intent.phase !== "prepared") throw new Error("COURSEWARE_CANVAS_IMAGE_DRAFT_CHANGED");
    await this.reference(c, journal);
    const quote = { ...await this.auth.coursewareMedia.getImageQuote(journal.intent.request.model) }; c.assertCurrent();
    if (journal.intent.request.input.length > quote.maxChars) throw new Error("COURSEWARE_CANVAS_IMAGE_PROMPT_TOO_LONG");
    const latest = checked(await c.host.call<Journal>("courseware.mediaCanvas.image.get", c.scope), p.intentId); c.assertCurrent();
    if (!latest.current || latest.intent.phase !== "prepared" || JSON.stringify(latest.intent) !== JSON.stringify(journal.intent))
      throw new Error("COURSEWARE_CANVAS_IMAGE_DRAFT_CHANGED");
    const scope = JSON.stringify(c.scope);
    for (const [key, stored] of this.quotes) if (Date.parse(stored.quote.expiresAt) <= Date.now() || stored.scope === scope) this.quotes.delete(key);
    if (this.quotes.size >= 100) this.quotes.delete(this.quotes.keys().next().value!);
    const quoteId = randomUUID(); this.quotes.set(quoteId, { scope, hash: journal.intent.requestHash, quote });
    return { quoteId, intentId: p.intentId, model: quote.model, maxPoints: quote.maxPoints, maxChars: quote.maxChars, expiresAt: quote.expiresAt };
  }

  async submitConfirmed(value: unknown): Promise<CanvasImageTaskView> {
    const p = input(value, ["intentId", "quoteId"]), c = await this.context(p, true), key = JSON.stringify(c.scope);
    if (this.submitting.has(key)) throw new Error("COURSEWARE_CANVAS_IMAGE_IN_FLIGHT");
    this.submitting.add(key);
    try {
      const journal = checked(await c.host.call<Journal>("courseware.mediaCanvas.image.get", c.scope), p.intentId); c.assertCurrent();
      if (journal.intent.phase !== "prepared") return this.read(c, journal);
      if (!journal.current) throw new Error("COURSEWARE_CANVAS_IMAGE_DRAFT_CHANGED");
      const offer = this.quotes.get(p.quoteId);
      if (!offer || offer.scope !== key || offer.hash !== journal.intent.requestHash || Date.parse(offer.quote.expiresAt) <= Date.now())
        throw new Error("COURSEWARE_CANVAS_IMAGE_QUOTE_REQUIRED");
      await this.reference(c, journal);
      let referenceImage: CoursewareImageRequest["referenceImage"];
      if (journal.intent.request.referenceImage) {
        const bytes = await this.readReference(c, journal); c.assertCurrent();
        const ref = journal.intent.request.referenceImage;
        referenceImage = { ...ref, bytesBase64: bytes.toString("base64") };
      }
      this.quotes.delete(p.quoteId);
      const begun = checked(await c.host.call<Journal>("courseware.mediaCanvas.image.begin", c.scope), p.intentId); c.assertCurrent();
      if (begun.intent.phase !== "submission-unknown" || begun.intent.idempotencyKey !== journal.intent.idempotencyKey ||
          JSON.stringify(begun.intent.request) !== JSON.stringify(journal.intent.request) || begun.intent.requestHash !== journal.intent.requestHash)
        throw new Error("COURSEWARE_CANVAS_IMAGE_INVALID_JOURNAL");
      const teamProjectId = coursewareMediaSubmissionProject(begun.intent.submissionScope, p.sessionId);
      c.assertCurrent();
      let task: CoursewareImageTask;
      try {
        task = await this.auth.coursewareMedia.submitConfirmedImage(begun.intent.idempotencyKey,
          { kind: "image", model: begun.intent.request.model, input: begun.intent.request.input, ...(referenceImage ? { referenceImage } : {}) }, offer.quote, undefined, teamProjectId);
      } catch (failure) {
        if (!isCoursewareMediaPermissionRefusal(failure, teamProjectId)) throw failure;
        const rejected = checked(await c.host.call<Journal>("courseware.mediaCanvas.image.reject", { ...c.scope,
          rejectedRequest: { idempotencyKey: begun.intent.idempotencyKey, requestHash: begun.intent.requestHash } }), p.intentId);
        if (rejected.intent.phase !== "rejected" || rejected.intent.idempotencyKey !== begun.intent.idempotencyKey ||
            rejected.intent.requestHash !== begun.intent.requestHash) throw new Error("COURSEWARE_CANVAS_IMAGE_INVALID_JOURNAL");
        c.assertCurrent();
        return view(rejected);
      }
      // Persist a valid late receipt in its original scope before rejecting stale UI.
      const bound = await this.bind(c, begun, task); c.assertCurrent();
      return view(bound, task);
    } finally { this.submitting.delete(key); }
  }

  async status(value: unknown): Promise<CanvasImageTaskView> {
    const p = input(value, ["intentId"]), c = await this.context(p);
    const journal = checked(await c.host.call<Journal>("courseware.mediaCanvas.image.get", c.scope), p.intentId); c.assertCurrent();
    return this.read(c, journal);
  }

  async archive(value: unknown): Promise<CoursewareCanvasImagePreview> {
    return this.retrieve(value, false);
  }

  async restore(value: unknown): Promise<CoursewareCanvasImagePreview> {
    return this.retrieve(value, true);
  }

  private async retrieve(value: unknown, restore: boolean): Promise<CoursewareCanvasImagePreview> {
    const p = input(value, ["intentId"]), c = await this.context(p), key = JSON.stringify([c.scope.sessionId, c.scope.principalKey]);
    if (this.archiving.has(key)) throw new Error("COURSEWARE_CANVAS_IMAGE_IN_FLIGHT");
    this.archiving.add(key);
    try {
      const journal = checked(await c.host.call<Journal>("courseware.mediaCanvas.image.get", c.scope), p.intentId); c.assertCurrent();
      const taskRef = journal.intent.taskRef;
      if (!taskRef) throw new Error("COURSEWARE_CANVAS_IMAGE_TASK_REQUIRED");
      if (restore && !journal.intent.asset) throw new Error("COURSEWARE_CANVAS_IMAGE_ASSET_REQUIRED");
      if (!journal.intent.asset || restore) {
        const { task, bytes } = await this.auth.coursewareMedia.downloadImage(taskRef); c.assertCurrent();
        if (task.kind !== "image" || task.taskId !== taskRef.taskId || task.idempotencyKey !== journal.intent.idempotencyKey ||
            task.requestHash !== journal.intent.requestHash || task.model !== journal.intent.request.model ||
            task.state !== "ready" || task.feeState !== "settled" || !task.assetRef)
          throw new Error("COURSEWARE_CANVAS_IMAGE_INVALID_TASK");
        const a = task.assetRef, asset = { taskRef, sha256: a.sha256, mimeType: a.mime,
          byteLength: a.byteLength, width: a.width, height: a.height };
        const original = journal.intent.asset;
        if (original && (original.sha256 !== asset.sha256 || original.mimeType !== asset.mimeType ||
            original.byteLength !== asset.byteLength || original.width !== asset.width || original.height !== asset.height))
          throw new Error("COURSEWARE_CANVAS_IMAGE_INVALID_TASK");
        verifySceneImageAsset(bytes, asset);
        c.assertCurrent();
        checked(await c.host.call<Journal>(restore ? "courseware.mediaCanvas.image.asset.restore" : "courseware.mediaCanvas.image.asset.stage",
          { ...c.scope, asset, bytesBase64: bytes.toString("base64") }), p.intentId);
        c.assertCurrent();
      }
      const preview = await this.archived(c, p.intentId); c.assertCurrent();
      return preview;
    } finally { this.archiving.delete(key); }
  }

  async preview(value: unknown): Promise<CoursewareCanvasImagePreview> {
    const p = input(value, ["intentId"]), c = await this.context(p);
    return this.archived(c, p.intentId);
  }

  private async archived(c: Awaited<ReturnType<CoursewareCanvasImages["context"]>>, intentId: string): Promise<CoursewareCanvasImagePreview> {
    c.assertCurrent();
    const saved = await c.host.call<Journal & { path: unknown }>("courseware.mediaCanvas.image.asset.get", c.scope); c.assertCurrent();
    const journal = checked(saved, intentId), asset = journal.intent.asset;
    if (!asset) throw new Error("COURSEWARE_CANVAS_IMAGE_ASSET_REQUIRED");
    const bytes = await readSceneImageAsset(saved.path, asset); c.assertCurrent();
    return { image: view(journal), dataUrl: `data:${asset.mimeType};base64,${bytes.toString("base64")}` };
  }

  private async bind(c: Awaited<ReturnType<CoursewareCanvasImages["context"]>>, journal: Journal, task: CoursewareImageTask) {
    if (task.kind !== "image" || task.model !== journal.intent.request.model || task.idempotencyKey !== journal.intent.idempotencyKey || task.requestHash !== journal.intent.requestHash)
      throw new Error("COURSEWARE_CANVAS_IMAGE_INVALID_TASK");
    return checked(await c.host.call<Journal>("courseware.mediaCanvas.image.bind", { ...c.scope,
      taskRef: { taskId: task.taskId, idempotencyKey: task.idempotencyKey, requestHash: task.requestHash } }), journal.intent.intentId);
  }

  private async read(c: Awaited<ReturnType<CoursewareCanvasImages["context"]>>, journal: Journal): Promise<CanvasImageTaskView> {
    if (journal.intent.phase === "prepared" || journal.intent.phase === "rejected") { c.assertCurrent(); return view(journal); }
    c.assertCurrent();
    const task = journal.intent.taskRef ? await this.auth.coursewareMedia.getImage(journal.intent.taskRef)
      : await this.auth.coursewareMedia.findImage({ idempotencyKey: journal.intent.idempotencyKey, requestHash: journal.intent.requestHash });
    if (!task) { c.assertCurrent(); return view(journal); }
    const bound = await this.bind(c, journal, task); c.assertCurrent();
    return view(bound, task);
  }
}
