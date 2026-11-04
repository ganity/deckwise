import { randomUUID } from "node:crypto";
import { assertCoursewareRetryable, coursewareRetryIntentId, currentCoursewareAttempts } from "./courseware-retry";
import { coursewareMediaSubmissionProject, isCoursewareMediaPermissionRefusal } from "./courseware-media-scope";
import { isCoursewareTaskRef, isCoursewareSceneImageTarget, type CoursewareSceneImageTarget, type CoursewareTaskRef, type CoursewareSceneImageView, type CoursewareSceneImageQuoteView, type CoursewareSceneImageAsset, type CoursewareSceneImagePreview } from "@pi-desktop/shared";
import type { DesktopAuthSession } from "./auth-session";
import type { CoursewareImageQuote, CoursewareImageRequest, CoursewareImageTask } from "./courseware-media";
import { readSceneCourseDraft } from "./courseware-scene-draft";
import { decodeSceneImageBundle, downloadSceneImageBundle, isSceneImageAsset, readSceneImageAsset, verifySceneImageAsset, sceneDecompositionReference, sceneLocalDecompositionReference } from "./courseware-scene-image-assets";
import type { VisualMasterPlanner } from "./courseware-visual-master";
import type { MagicLayersFallback } from "./courseware-magic-layers";

type Host = { call<T>(method: string, params: unknown): Promise<T> };
type Reference = NonNullable<CoursewareSceneImageView["referenceImage"]>;
type Journal = { current: boolean; intent: {
  intentId: string; planSha256: string; pageId: string; request: Omit<CoursewareImageRequest, "referenceImage"> & { referenceImage?: Omit<Reference, "intentId"> };
  referenceIntentId?: string;
  sourceReferenceImage?: Omit<Reference, "intentId">;
  target?: CoursewareSceneImageTarget;
  idempotencyKey: string; requestHash: string; phase: CoursewareSceneImageView["phase"]; taskRef: CoursewareTaskRef | null;
  sourcePrompt?: string;
  planningRequired?: boolean;
  planningInstructions?: string;
  submissionScope?: unknown;
  asset?: (CoursewareSceneImageAsset & { taskRef: CoursewareTaskRef }) | null; selected?: boolean;
} };
const id = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9._-]{1,128}$/u.test(value) && value !== "." && value !== "..";
const hash = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
function input(value: unknown, extra: string[] = []): Record<string, string> {
  const keys = ["sessionId", ...extra];
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length !== keys.length ||
      keys.some((key) => !Object.hasOwn(value, key) || !id(Reflect.get(value, key)))) throw new Error("COURSEWARE_SCENE_IMAGE_INVALID_REQUEST");
  return value as Record<string, string>;
}
function checked(value: Journal, intentId?: string): Journal {
  const i = value?.intent;
  if (!i || !id(i.intentId) || (intentId !== undefined && i.intentId !== intentId) || !hash(i.planSha256) ||
      (i.planningRequired !== undefined && typeof i.planningRequired !== "boolean") ||
      (i.sourcePrompt !== undefined && (typeof i.sourcePrompt !== "string" || !i.sourcePrompt.trim() || i.sourcePrompt.length > 4000)) ||
      (i.planningInstructions !== undefined && (typeof i.planningInstructions !== "string" || i.planningInstructions.length > 1200)) ||
      (i.sourceReferenceImage !== undefined && (i.request?.kind !== "image-layers" || i.request.referenceImage?.mimeType !== "image/jpeg" ||
        Object.keys(i.sourceReferenceImage).sort().join(",") !== "byteLength,mimeType,sha256" || !hash(i.sourceReferenceImage.sha256) ||
        !["image/png", "image/jpeg"].includes(i.sourceReferenceImage.mimeType) || !Number.isSafeInteger(i.sourceReferenceImage.byteLength) ||
        i.sourceReferenceImage.byteLength < 1 || i.sourceReferenceImage.byteLength > 8 * 1024 * 1024)) ||
      !/^scene-[0-9]{3}$/u.test(i.pageId) || !["image", "image-layers"].includes(i.request?.kind) || !id(i.request.model) ||
      (i.request.kind === "image-layers" && (!i.request.referenceImage || (i.target?.kind ?? "visualMaster") === "visualMaster")) ||
      (i.request.referenceImage !== undefined && (!id(i.referenceIntentId) || !hash(i.request.referenceImage.sha256) ||
        Object.keys(i.request.referenceImage).sort().join(",") !== "byteLength,mimeType,sha256" ||
        !["image/png", "image/jpeg"].includes(i.request.referenceImage.mimeType) || !Number.isSafeInteger(i.request.referenceImage.byteLength) ||
        i.request.referenceImage.byteLength < 1 || i.request.referenceImage.byteLength > 8 * 1024 * 1024)) ||
      (i.request.referenceImage === undefined && i.referenceIntentId !== undefined) ||
      (i.target !== undefined && !isCoursewareSceneImageTarget(i.target)) ||
      typeof i.request.input !== "string" || !i.request.input.trim() || i.request.input.length > 4000 ||
      !/^[a-f0-9-]{36}$/u.test(i.idempotencyKey) || !hash(i.requestHash) || typeof value.current !== "boolean" ||
      !["prepared", "submission-unknown", "submitted", "rejected"].includes(i.phase) ||
      (i.phase === "submitted") !== (i.taskRef !== null) || (i.taskRef !== null && (!isCoursewareTaskRef(i.taskRef) ||
        i.taskRef.idempotencyKey !== i.idempotencyKey || i.taskRef.requestHash !== i.requestHash)) ||
      (i.asset != null && (!isSceneImageAsset(i.asset) || !i.taskRef || !isCoursewareTaskRef(i.asset.taskRef) ||
        i.asset.taskRef.taskId !== i.taskRef.taskId || i.asset.taskRef.idempotencyKey !== i.idempotencyKey || i.asset.taskRef.requestHash !== i.requestHash)) ||
      (i.selected !== undefined && typeof i.selected !== "boolean") || (i.selected && !i.asset))
    throw new Error("COURSEWARE_SCENE_IMAGE_INVALID_JOURNAL");
  return value;
}
function view(j: Journal, task: CoursewareImageTask | null = null): CoursewareSceneImageView {
  return { intentId: j.intent.intentId, planSha256: j.intent.planSha256, pageId: j.intent.pageId,
    ...(j.intent.request.kind === "image-layers" ? { decomposition: true } : {}),
    target: j.intent.target ?? { kind: "visualMaster" },
    ...(j.intent.request.referenceImage ? { referenceImage: { ...(j.intent.sourceReferenceImage ?? j.intent.request.referenceImage), intentId: j.intent.referenceIntentId! } } : {}),
    model: j.intent.request.model, prompt: j.intent.request.input, phase: j.intent.phase, current: j.current,
    asset: j.intent.asset ? { sha256: j.intent.asset.sha256, mimeType: j.intent.asset.mimeType,
      byteLength: j.intent.asset.byteLength, width: j.intent.asset.width, height: j.intent.asset.height,
      ...(j.intent.asset.normalizedBoundingBox ? { normalizedBoundingBox: j.intent.asset.normalizedBoundingBox } : {}),
      ...(j.intent.asset.sourceZIndex === undefined ? {} : { sourceZIndex: j.intent.asset.sourceZIndex }) } : null,
    selected: j.intent.selected ?? false,
    task: task && { state: task.state, feeState: task.feeState, reservedPoints: task.reservedPoints,
      actualPoints: task.actualPoints, errorCode: task.errorCode,
      ...(task.upstreamResponse ? { upstreamResponse: task.upstreamResponse } : {}) } };
}

/** The Host owns durable requests; generation obtains server billing proofs internally. */
export class CoursewareSceneImages {
  private quotes = new Map<string, { scope: string; hash: string; quote: CoursewareImageQuote }>();
  private submitting = new Set<string>();
  private archiving = new Set<string>();
  constructor(private getHost: () => Host | null, private getSession: () => string | null,
    private isRunning: (sessionId: string) => boolean,
    private auth: Pick<DesktopAuthSession, "getCoursewarePrincipal" | "coursewareMedia">,
    private planVisualMaster?: VisualMasterPlanner, private layerFallback?: MagicLayersFallback) {}

  private context(p: Record<string, string>, allowDuringTurn = false) {
    const host = this.getHost();
    if (!host) throw new Error("host unavailable");
    const principal = this.auth.getCoursewarePrincipal();
    const assertCurrent = () => {
      principal.assertCurrent();
      if (this.getHost() !== host || this.getSession() !== p.sessionId || (!allowDuringTurn && this.isRunning(p.sessionId)))
        throw new Error("COURSEWARE_SCENE_IMAGE_CONTEXT_CHANGED");
    };
    assertCurrent();
    return { host, assertCurrent, scope: { sessionId: p.sessionId, principalKey: principal.key,
      ...(p.intentId ? { intentId: p.intentId } : {}) } };
  }

  private async approved(host: Host, sessionId: string, sha256: string) {
    const { plan } = await readSceneCourseDraft(host, { sessionId });
    if (!plan || plan.sha256 !== sha256 || plan.approvedSha256 !== sha256)
      throw new Error("COURSEWARE_SCENE_IMAGE_PLAN_CHANGED");
    return plan;
  }

  async models(value: unknown): Promise<{ model: string; supportsReferenceImage?: boolean; layerDecomposition?: boolean }[]> {
    const c = this.context(input(value));
    const [models, layers] = await Promise.all([this.auth.coursewareMedia.getImageModels(), this.auth.coursewareMedia.getLayerModels()]);
    c.assertCurrent();
    return [...models.map(({ model, supportsReferenceImage }) => ({ model, ...(supportsReferenceImage === undefined ? {} : { supportsReferenceImage }) })),
      ...layers.map(({ model }) => ({ model, supportsReferenceImage: true, layerDecomposition: true }))];
  }

  private async reference(c: ReturnType<CoursewareSceneImages["context"]>, j: Journal): Promise<Journal | null> {
    const ref = j.intent.sourceReferenceImage ?? j.intent.request.referenceImage;
    if (!ref) return null;
    const models = await (j.intent.request.kind === "image-layers" ? this.auth.coursewareMedia.getLayerModels() : this.auth.coursewareMedia.getImageModels());
    c.assertCurrent();
    if (!models.some(model => model.model === j.intent.request.model && model.supportsReferenceImage === true))
      throw new Error("COURSEWARE_SCENE_IMAGE_REFERENCE_UNSUPPORTED");
    const { intents } = await c.host.call<{ intents: Journal[] }>("courseware.sceneImage.list", {
      sessionId: c.scope.sessionId, principalKey: c.scope.principalKey });
    c.assertCurrent();
    if (!Array.isArray(intents) || intents.length > 300) throw new Error("COURSEWARE_SCENE_IMAGE_INVALID_JOURNAL");
    const selected = intents.map(value => checked(value)).find(row => row.intent.intentId === j.intent.referenceIntentId);
    const asset = selected?.intent.asset;
    if (!selected?.current || !selected.intent.selected || selected.intent.planSha256 !== j.intent.planSha256 ||
        selected.intent.pageId !== ((j.intent.target?.kind ?? "visualMaster") === "visualMaster" ? "scene-001" : j.intent.pageId) ||
        selected.intent.intentId === j.intent.intentId || (selected.intent.target?.kind ?? "visualMaster") !== "visualMaster" ||
        !asset || asset.sha256 !== ref.sha256 || asset.mimeType !== ref.mimeType || asset.byteLength !== ref.byteLength)
      throw new Error("COURSEWARE_SCENE_IMAGE_REFERENCE_CHANGED");
    return selected;
  }

  async list(value: unknown): Promise<CoursewareSceneImageView[]> {
    const c = this.context(input(value), true);
    const { intents } = await c.host.call<{ intents: Journal[] }>("courseware.sceneImage.list", c.scope);
    if (!Array.isArray(intents) || intents.length > 300) throw new Error("COURSEWARE_SCENE_IMAGE_INVALID_JOURNAL");
    c.assertCurrent();
    const rows = intents.map((j) => view(checked(j)));
    const current = new Set(currentCoursewareAttempts(rows).map(row => row.intentId));
    return rows.map(row => ({ ...row, current: row.current && current.has(row.intentId) }));
  }

  /** Main-only compiler input. Private archives never become team assets or renderer paths. */
  async captureSelected(value: unknown, resolveModel?: (sessionId: string) => Promise<{ modelKey: string; thinkingLevel?: string }>) {
    const p = input(value, ["planSha256"]), c = this.context(p);
    if (!hash(p.planSha256)) throw new Error("COURSEWARE_SCENE_IMAGE_INVALID_REQUEST");
    const plan = await this.approved(c.host, p.sessionId, p.planSha256);
    const session = async () => {
      const { session } = await c.host.call<{ session?: { projectPath?: string; providerId?: string; modelId?: string; thinkingLevel?: string; mode?: string } }>(
        "session.get", { id: p.sessionId, messageLimit: 1 });
      if (!session?.projectPath || session.mode !== "agent")
        throw new Error("COURSEWARE_SCENE_GENERATION_MODEL_REQUIRED");
      const model = session.providerId && session.modelId
        ? { modelKey: `${session.providerId}/${session.modelId}`, thinkingLevel: session.thinkingLevel }
        : await resolveModel?.(p.sessionId);
      if (!model) throw new Error("COURSEWARE_SCENE_GENERATION_MODEL_REQUIRED");
      return { workspace: session.projectPath, ...model };
    };
    const model = await session();
    const selected = async () => (await this.list({ sessionId: p.sessionId }))
      .filter(row => row.current && row.selected && row.planSha256 === p.planSha256)
      .sort((a, b) => a.intentId.localeCompare(b.intentId));
    const rows = await selected();
    for (const row of rows.filter(row => row.target.kind === "visualMaster" && row.referenceImage)) {
      const journal = checked(await c.host.call<Journal>("courseware.sceneImage.get", { ...c.scope, intentId: row.intentId }), row.intentId);
      await this.reference(c, journal);
    }
    const all = await this.list({ sessionId: p.sessionId });
    for (const row of rows.filter(row => row.decomposition)) {
      const clean = row.target.kind === "cleanPlate" ? row : rows.find(base => base.target.kind === "cleanPlate" && row.intentId.startsWith(`${base.intentId}-layer-`));
      if (!clean || !all.filter(peer => peer.intentId.startsWith(`${clean.intentId}-layer-`)).every(peer => rows.some(selected => selected.intentId === peer.intentId)) ||
          !rows.some(master => master.target.kind === "visualMaster" && master.intentId === clean.referenceImage?.intentId && master.asset?.sha256 === clean.referenceImage.sha256) ||
          rows.some(layer => layer.pageId === clean.pageId && layer.target.kind === "layer" && !layer.intentId.startsWith(`${clean.intentId}-layer-`)))
        throw new Error("COURSEWARE_SCENE_GENERATION_DECOMPOSITION_CHANGED");
    }
    for (const page of plan.pages.filter(page => !page.quiz)) {
      const assets = rows.filter(row => row.pageId === page.pageId);
      const master = assets.filter(row => row.target.kind === "visualMaster"), clean = assets.filter(row => row.target.kind === "cleanPlate");
      if (master.length !== 1 || clean.length !== 1 || !assets.some(row => row.target.kind === "layer") ||
          !master[0].asset || !clean[0].asset || master[0].asset.sha256 === clean[0].asset.sha256 ||
          new Set(assets.filter(row => row.target.kind === "layer").map(row => row.target.kind === "layer" && row.target.name)).size !== assets.filter(row => row.target.kind === "layer").length)
        throw new Error(`COURSEWARE_SCENE_GENERATION_ASSETS_REQUIRED: ${page.pageId}`);
    }
    if (rows.some(row => !row.asset || !plan.pages.some(page => page.pageId === row.pageId)))
      throw new Error("COURSEWARE_SCENE_GENERATION_ASSETS_REQUIRED");
    const baseline = JSON.stringify(rows);
    const assertCurrent = async () => {
      c.assertCurrent();
      await this.approved(c.host, p.sessionId, p.planSha256);
      if (JSON.stringify(await session()) !== JSON.stringify(model) || JSON.stringify(await selected()) !== baseline)
        throw new Error("COURSEWARE_SCENE_GENERATION_INPUT_CHANGED");
      c.assertCurrent();
    };
    const images = [];
    for (const row of rows) {
      c.assertCurrent();
      const saved = await c.host.call<Journal & { path: string }>("courseware.sceneImage.asset.get", { ...c.scope, intentId: row.intentId });
      const j = checked(saved, row.intentId);
      if (!j.current || !j.intent.selected || JSON.stringify(view(j)) !== JSON.stringify(row) || !j.intent.asset)
        throw new Error("COURSEWARE_SCENE_GENERATION_INPUT_CHANGED");
      const bytes = await readSceneImageAsset(saved.path, j.intent.asset, row.target);
      c.assertCurrent();
      images.push({ pageId: row.pageId, intentId: row.intentId, target: row.target, asset: row.asset!, bytes });
    }
    await assertCurrent();
    return { plan, ...model, images, assertCurrent, assertScope: c.assertCurrent,
      proof: { planSha256: p.planSha256, principalKey: c.scope.principalKey, selectedIntentIds: rows.map(row => row.intentId) } };
  }

  async prepare(value: unknown): Promise<CoursewareSceneImageView> {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("COURSEWARE_SCENE_IMAGE_INVALID_REQUEST");
    const { target = { kind: "visualMaster" }, instructions = "", referenceIntentId: requestedReference, ...payload } = structuredClone(value) as Record<string, unknown>;
    if (!isCoursewareSceneImageTarget(target) || typeof instructions !== "string" || instructions.length > 1200 ||
        /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u.test(instructions))
      throw new Error("COURSEWARE_SCENE_IMAGE_INVALID_REQUEST");
    if (requestedReference !== undefined && !id(requestedReference))
      throw new Error("COURSEWARE_SCENE_IMAGE_INVALID_REQUEST");
    const available = await this.models({ sessionId: payload.sessionId });
    const candidates = available.filter(m => target.kind === "visualMaster" ? !m.layerDecomposition : target.kind === "cleanPlate" ? m.layerDecomposition : !m.layerDecomposition && m.supportsReferenceImage);
    const chosen = payload.model === undefined ? candidates[0] : available.find(m => m.model === payload.model);
    if (!chosen || (chosen.layerDecomposition && target.kind !== "cleanPlate")) throw new Error("COURSEWARE_SCENE_IMAGE_MODEL_UNAVAILABLE");
    const p = input({ ...payload, model: chosen.model }, ["planSha256", "pageId", "model"]), c = this.context(p);
    if (!hash(p.planSha256)) throw new Error("COURSEWARE_SCENE_IMAGE_INVALID_REQUEST");
    const plan = await this.approved(c.host, p.sessionId, p.planSha256);
    if (!plan.pages.some((page) => page.pageId === p.pageId)) throw new Error("COURSEWARE_SCENE_IMAGE_INVALID_REQUEST");
    let referenceIntentId = requestedReference;
    if (target.kind === "visualMaster") {
      if (p.pageId === plan.pages[0].pageId) {
        if (requestedReference !== undefined) throw new Error("COURSEWARE_SCENE_IMAGE_INVALID_REQUEST");
      } else {
        const rows = await this.list({ sessionId: p.sessionId });
        c.assertCurrent();
        const style = rows.find(row => row.current && row.selected && row.asset && row.planSha256 === p.planSha256 &&
          row.pageId === plan.pages[0].pageId && row.target.kind === "visualMaster");
        if (!style || requestedReference !== undefined && requestedReference !== style.intentId)
          throw new Error("COURSEWARE_SCENE_IMAGE_REFERENCE_CHANGED");
        if (!chosen.supportsReferenceImage) throw new Error("COURSEWARE_SCENE_IMAGE_REFERENCE_UNSUPPORTED");
        referenceIntentId = style.intentId;
      }
    }
    c.assertCurrent();
    let referenceInput: { sourceSha256: string; bytesBase64: string } | undefined;
    if (chosen.layerDecomposition && referenceIntentId) {
      const archived = await c.host.call<Journal & { path: string }>("courseware.sceneImage.asset.get", { ...c.scope, intentId: referenceIntentId });
      const reference = checked(archived, referenceIntentId);
      if (!reference.current || !reference.intent.selected || !reference.intent.asset) throw new Error("COURSEWARE_SCENE_IMAGE_REFERENCE_CHANGED");
      const bytes = await readSceneImageAsset(archived.path, reference.intent.asset, { kind: "visualMaster" });
      referenceInput = { sourceSha256: reference.intent.asset.sha256, bytesBase64: sceneDecompositionReference(bytes, reference.intent.asset).toString("base64") };
      c.assertCurrent();
    }
    const request = { ...c.scope,
      planSha256: p.planSha256, pageId: p.pageId, model: p.model, target, instructions,
      ...(referenceInput ? { referenceInput } : {}),
      ...(target.kind === "visualMaster" && this.planVisualMaster ? { planningRequired: true } : {}),
      ...(referenceIntentId === undefined ? {} : { referenceIntentId }), ...(chosen.layerDecomposition ? { decomposition: true } : {}) };
    let j = checked(await c.host.call<Journal>("courseware.sceneImage.prepare", request));
    c.assertCurrent();
    if (target.kind === "visualMaster" && j.intent.phase === "prepared" && j.intent.sourcePrompt === undefined && this.planVisualMaster) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(new Error("COURSEWARE_VISUAL_PLANNING_TIMEOUT")), 120_000);
      const guard = setInterval(() => { try { c.assertCurrent(); } catch (error) { controller.abort(error); } }, 100);
      let prompt = j.intent.request.input;
      try {
        prompt = await this.planVisualMaster({ sessionId: p.sessionId, plan,
          page: plan.pages.find(page => page.pageId === p.pageId)!, instructions,
          courseStyleReferenceSupplied: referenceIntentId !== undefined, signal: controller.signal });
      } catch {
        c.assertCurrent();
        console.warn("Visual-master planning failed; using the deterministic page prompt");
      } finally { clearTimeout(timeout); clearInterval(guard); }
      c.assertCurrent();
      await this.approved(c.host, p.sessionId, p.planSha256);
      await this.reference(c, j);
      c.assertCurrent();
      j = checked(await c.host.call<Journal>("courseware.sceneImage.prepare", { ...request,
        plannedPrompt: { sourceRequestHash: j.intent.requestHash, input: prompt } }));
      c.assertCurrent();
    }
    const actualTarget = view(j).target;
    if (j.intent.planSha256 !== p.planSha256 || j.intent.pageId !== p.pageId || j.intent.request.model !== p.model ||
        actualTarget.kind !== target.kind || (target.kind === "layer" &&
          (actualTarget.kind !== "layer" || actualTarget.name !== target.name)))
      throw new Error("COURSEWARE_SCENE_IMAGE_INVALID_JOURNAL");
    if (j.intent.referenceIntentId !== referenceIntentId) throw new Error("COURSEWARE_SCENE_IMAGE_INVALID_JOURNAL");
    await this.reference(c, j);
    c.assertCurrent();
    return view(j);
  }

  async quote(value: unknown): Promise<CoursewareSceneImageQuoteView> {
    const p = input(value, ["intentId"]), c = this.context(p);
    let j = checked(await c.host.call<Journal>("courseware.sceneImage.get", c.scope), p.intentId);
    if (!j.current || j.intent.phase !== "prepared") throw new Error("COURSEWARE_SCENE_IMAGE_PLAN_CHANGED");
    if (j.intent.planningRequired && j.intent.sourcePrompt === undefined) throw new Error("COURSEWARE_VISUAL_PLANNING_REQUIRED");
    await this.approved(c.host, p.sessionId, j.intent.planSha256);
    const available = await this.models({ sessionId: p.sessionId });
    c.assertCurrent();
    const compatible = available.filter(model => !!model.layerDecomposition === (j.intent.request.kind === "image-layers") &&
      (!j.intent.request.referenceImage || model.supportsReferenceImage === true));
    if (!compatible.some(model => model.model === j.intent.request.model)) {
      const chosen = compatible[0];
      if (!chosen) throw new Error("COURSEWARE_SCENE_IMAGE_MODEL_UNAVAILABLE");
      const previous = j;
      j = checked(await c.host.call<Journal>("courseware.sceneImage.rebindModel", {
        ...c.scope, expectedRequestHash: previous.intent.requestHash, model: chosen.model,
      }), p.intentId);
      c.assertCurrent();
      const { requestHash: _oldHash, idempotencyKey: _oldKey, request: oldRequest, ...oldPins } = previous.intent;
      const { requestHash: _newHash, idempotencyKey: _newKey, request: newRequest, ...newPins } = j.intent;
      if (!j.current || j.intent.request.model !== chosen.model || JSON.stringify(newPins) !== JSON.stringify(oldPins) ||
          JSON.stringify({ ...newRequest, model: oldRequest.model }) !== JSON.stringify(oldRequest) ||
          j.intent.requestHash === previous.intent.requestHash || j.intent.idempotencyKey === previous.intent.idempotencyKey)
        throw new Error("COURSEWARE_SCENE_IMAGE_INVALID_JOURNAL");
    }
    await this.reference(c, j);
    c.assertCurrent();
    const quote = { ...await this.auth.coursewareMedia.getImageQuote(j.intent.request.model, undefined, j.intent.request.kind) };
    await this.reference(c, j);
    c.assertCurrent();
    if (j.intent.request.input.length > quote.maxChars) throw new Error("COURSEWARE_SCENE_IMAGE_PROMPT_TOO_LONG");
    const scope = JSON.stringify(c.scope);
    for (const [key, saved] of this.quotes) {
      if (Date.parse(saved.quote.expiresAt) <= Date.now() || saved.scope === scope) this.quotes.delete(key);
    }
    if (this.quotes.size >= 100) this.quotes.delete(this.quotes.keys().next().value!);
    const quoteId = randomUUID();
    this.quotes.set(quoteId, { scope, hash: j.intent.requestHash, quote });
    return { quoteId, intentId: p.intentId, model: quote.model, maxPoints: quote.maxPoints,
      maxChars: quote.maxChars, expiresAt: quote.expiresAt };
  }

  async generate(value: unknown): Promise<CoursewareSceneImageView> {
    const p = input(value, ["intentId"]), c = this.context(p);
    let j = checked(await c.host.call<Journal>("courseware.sceneImage.get", c.scope), p.intentId);
    c.assertCurrent();
    if (j.intent.phase !== "prepared") return this.read(c, j);
    if (j.intent.planningRequired && j.intent.sourcePrompt === undefined) {
      await this.prepare({ sessionId: p.sessionId, planSha256: j.intent.planSha256, pageId: j.intent.pageId,
        model: j.intent.request.model, instructions: j.intent.planningInstructions ?? "" });
      c.assertCurrent();
      j = checked(await c.host.call<Journal>("courseware.sceneImage.get", c.scope), p.intentId);
      if (j.intent.sourcePrompt === undefined) throw new Error("COURSEWARE_VISUAL_PLANNING_REQUIRED");
    }
    const quote = await this.quote(value);
    c.assertCurrent();
    return this.submitConfirmed({ ...p, quoteId: quote.quoteId });
  }

  async submitConfirmed(value: unknown): Promise<CoursewareSceneImageView> {
    const p = input(value, ["intentId", "quoteId"]), c = this.context(p), key = JSON.stringify(c.scope);
    if (this.submitting.has(key)) throw new Error("COURSEWARE_SCENE_IMAGE_IN_FLIGHT");
    this.submitting.add(key);
    try {
      const j = checked(await c.host.call<Journal>("courseware.sceneImage.get", c.scope), p.intentId);
      if (j.intent.phase !== "prepared") return await this.read(c, j);
      if (!j.current) throw new Error("COURSEWARE_SCENE_IMAGE_PLAN_CHANGED");
      const saved = this.quotes.get(p.quoteId);
      if (!saved || saved.scope !== key || saved.hash !== j.intent.requestHash || Date.parse(saved.quote.expiresAt) <= Date.now())
        throw new Error("COURSEWARE_SCENE_IMAGE_QUOTE_REQUIRED");
      await this.approved(c.host, p.sessionId, j.intent.planSha256);
      const reference = await this.reference(c, j);
      let referenceImage: CoursewareImageRequest["referenceImage"];
      if (reference) {
        const normalized = j.intent.sourceReferenceImage !== undefined;
        const archived = await c.host.call<Journal & { path: string }>(normalized ? "courseware.sceneImage.reference.get" : "courseware.sceneImage.asset.get", {
          ...c.scope, intentId: normalized ? j.intent.intentId : reference.intent.intentId });
        checked(archived, normalized ? j.intent.intentId : reference.intent.intentId);
        if (JSON.stringify(archived.intent) !== JSON.stringify(normalized ? j.intent : reference.intent))
          throw new Error("COURSEWARE_SCENE_IMAGE_REFERENCE_CHANGED");
        const metadata = normalized ? j.intent.request.referenceImage! : archived.intent.asset!;
        const bytes = await readSceneImageAsset(archived.path, { ...metadata, width: reference.intent.asset!.width, height: reference.intent.asset!.height }, { kind: "visualMaster" });
        referenceImage = { ...j.intent.request.referenceImage!, bytesBase64: bytes.toString("base64") };
      }
      c.assertCurrent();
      this.quotes.delete(p.quoteId);
      const request: CoursewareImageRequest = { kind: j.intent.request.kind, model: j.intent.request.model, input: j.intent.request.input,
        ...(j.intent.request.parameters ? { parameters: j.intent.request.parameters } : {}),
        ...(referenceImage ? { referenceImage } : {}) };
      let begun = j, teamProjectId: string | undefined;
      const admit = async () => {
        begun = checked(await c.host.call<Journal>("courseware.sceneImage.begin", c.scope), p.intentId);
      if (begun.intent.phase !== "submission-unknown" || begun.intent.idempotencyKey !== j.intent.idempotencyKey ||
          begun.intent.requestHash !== j.intent.requestHash || JSON.stringify(begun.intent.request) !== JSON.stringify(j.intent.request))
        throw new Error("COURSEWARE_SCENE_IMAGE_INVALID_JOURNAL");
      await this.approved(c.host, p.sessionId, begun.intent.planSha256);
      await this.reference(c, begun);
      c.assertCurrent();
        teamProjectId = coursewareMediaSubmissionProject(begun.intent.submissionScope, p.sessionId);
      c.assertCurrent();
        return teamProjectId;
      };
      let task: CoursewareImageTask;
      try {
        task = await this.auth.coursewareMedia.submitConfirmedImage(j.intent.idempotencyKey, request, saved.quote, undefined, undefined, async () => {
          c.assertCurrent();
          await this.approved(c.host, p.sessionId, j.intent.planSha256);
          await this.reference(c, j);
          c.assertCurrent();
        }, admit);
      } catch (failure) {
        if (begun.intent.phase !== "submission-unknown" || !isCoursewareMediaPermissionRefusal(failure, teamProjectId)) throw failure;
        const rejected = checked(await c.host.call<Journal>("courseware.sceneImage.reject", { ...c.scope,
          rejectedRequest: { idempotencyKey: begun.intent.idempotencyKey, requestHash: begun.intent.requestHash } }), p.intentId);
        if (rejected.intent.phase !== "rejected" || rejected.intent.idempotencyKey !== begun.intent.idempotencyKey ||
            rejected.intent.requestHash !== begun.intent.requestHash) throw new Error("COURSEWARE_SCENE_IMAGE_INVALID_JOURNAL");
        c.assertCurrent();
        return view(rejected);
      }
      const bound = await this.bind(c.host, c.scope, begun, task);
      c.assertCurrent();
      return view(bound, task);
    } finally { this.submitting.delete(key); }
  }

  async retry(value: unknown): Promise<CoursewareSceneImageView> {
    const p = input(value, ["intentId"]), c = this.context(p);
    const original = checked(await c.host.call<Journal>("courseware.sceneImage.get", c.scope), p.intentId);
    if (!original.current || original.intent.asset || original.intent.selected) throw new Error("COURSEWARE_SCENE_IMAGE_PLAN_CHANGED");
    await this.approved(c.host, p.sessionId, original.intent.planSha256);
    await this.reference(c, original);
    const receipt = await this.read(c, original);
    assertCoursewareRetryable(receipt.task);
    c.assertCurrent();
    const retried = checked(await c.host.call<Journal>("courseware.sceneImage.retry", c.scope), coursewareRetryIntentId(p.intentId));
    // Host rebuilds legacy decomposition instructions with the current MAIC prompt.
    const expectedRequest = original.intent.request.kind === "image-layers"
      ? { ...original.intent.request, input: retried.intent.request.input } : original.intent.request;
    if (original.intent.request.kind !== "image-layers" && retried.intent.requestHash !== original.intent.requestHash ||
        JSON.stringify(retried.intent.request) !== JSON.stringify(expectedRequest) ||
        retried.intent.planSha256 !== original.intent.planSha256 || retried.intent.pageId !== original.intent.pageId ||
        retried.intent.referenceIntentId !== original.intent.referenceIntentId || JSON.stringify(retried.intent.target) !== JSON.stringify(original.intent.target) ||
        !retried.current || retried.intent.idempotencyKey === original.intent.idempotencyKey)
      throw new Error("COURSEWARE_SCENE_IMAGE_INVALID_JOURNAL");
    c.assertCurrent();
    return view(retried);
  }

  async status(value: unknown): Promise<CoursewareSceneImageView> {
    const p = input(value, ["intentId"]), c = this.context(p, true);
    return this.read(c, checked(await c.host.call<Journal>("courseware.sceneImage.get", c.scope), p.intentId));
  }

  async fallback(value: unknown): Promise<CoursewareSceneImageView> {
    const p = input(value, ["intentId"]), c = this.context(p), key = JSON.stringify(c.scope);
    if (!this.layerFallback) throw new Error("COURSEWARE_MAGICLAYERS_NOT_CONFIGURED");
    if (this.archiving.has(key)) throw new Error("COURSEWARE_SCENE_IMAGE_IN_FLIGHT");
    this.archiving.add(key);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(new Error("COURSEWARE_MAGICLAYERS_TIMEOUT: resume the saved job")), 14 * 60_000);
    const guard = setInterval(() => { try { c.assertCurrent(); } catch (error) { controller.abort(error); } }, 100);
    try {
      const j = checked(await c.host.call<Journal>("courseware.sceneImage.get", c.scope), p.intentId);
      if (j.intent.asset) return view(j);
      if (!j.current || j.intent.request.kind !== "image-layers" || j.intent.target?.kind !== "cleanPlate" || !j.intent.taskRef)
        throw new Error("COURSEWARE_SCENE_IMAGE_INVALID_REQUEST");
      const receipt = await this.read(c, j);
      assertCoursewareRetryable(receipt.task);
      if (receipt.task?.state !== "failed") throw new Error("COURSEWARE_MAGICLAYERS_REQUIRES_UPSTREAM_FAILURE");
      const check = async () => {
        controller.signal.throwIfAborted(); c.assertCurrent();
        await this.approved(c.host, p.sessionId, j.intent.planSha256);
        await this.reference(c, j);
        const latest = checked(await c.host.call<Journal>("courseware.sceneImage.get", c.scope), p.intentId);
        if (!latest.current || JSON.stringify(latest.intent) !== JSON.stringify(j.intent))
          throw new Error("COURSEWARE_SCENE_IMAGE_CONTEXT_CHANGED");
        c.assertCurrent(); controller.signal.throwIfAborted();
      };
      await check();
      const reference = (await this.reference(c, j))!;
      const archived = await c.host.call<Journal & { path: string }>("courseware.sceneImage.asset.get", {
        ...c.scope, intentId: reference.intent.intentId });
      const asset = reference.intent.asset!;
      const original = await readSceneImageAsset(archived.path, asset, { kind: "visualMaster" });
      const bytes = sceneLocalDecompositionReference(original, asset);
      const plan = await this.approved(c.host, p.sessionId, j.intent.planSha256);
      const result = await this.layerFallback({ sessionId: p.sessionId, key: j.intent.idempotencyKey,
        requestHash: j.intent.requestHash, sourceSha256: asset.sha256,
        projectId: coursewareMediaSubmissionProject(j.intent.submissionScope, p.sessionId),
        page: plan.pages.find(page => page.pageId === j.intent.pageId)!, bytes, width: asset.width, height: asset.height,
        check, signal: controller.signal });
      await check();
      const images = decodeSceneImageBundle(result, j.intent.taskRef);
      const metadata = [];
      for (const image of images) {
        await check();
        checked(await c.host.call<Journal>("courseware.sceneImage.bundle.stage", { ...c.scope, stageOnly: true, images: [image] }), p.intentId);
        const { bytesBase64: _, ...entry } = image;
        metadata.push(entry);
      }
      await check();
      const saved = checked(await c.host.call<Journal>("courseware.sceneImage.bundle.stage", { ...c.scope, images: metadata }), p.intentId);
      c.assertCurrent();
      return { ...view(saved), task: receipt.task };
    } finally { clearTimeout(timeout); clearInterval(guard); this.archiving.delete(key); }
  }

  async archive(value: unknown): Promise<CoursewareSceneImagePreview> {
    const p = input(value, ["intentId"]), c = this.context(p, true), key = JSON.stringify(c.scope);
    if (this.archiving.has(key)) throw new Error("COURSEWARE_SCENE_IMAGE_IN_FLIGHT");
    this.archiving.add(key);
    try {
      const j = checked(await c.host.call<Journal>("courseware.sceneImage.get", c.scope), p.intentId);
      if (!j.intent.taskRef) throw new Error("COURSEWARE_SCENE_IMAGE_TASK_REQUIRED");
      if (!j.intent.asset) {
        c.assertCurrent();
        const { task, bytes } = await this.auth.coursewareMedia.downloadImage(j.intent.taskRef, undefined, j.intent.request.kind);
        if (task.kind !== j.intent.request.kind || task.taskId !== j.intent.taskRef.taskId ||
            task.idempotencyKey !== j.intent.idempotencyKey || task.requestHash !== j.intent.requestHash ||
            task.model !== j.intent.request.model || task.state !== "ready" || task.feeState !== "settled" || !task.assetRef)
          throw new Error("COURSEWARE_SCENE_IMAGE_INVALID_TASK");
        if (task.kind === "image-layers") {
          if (j.intent.target?.kind !== "cleanPlate") throw new Error("COURSEWARE_SCENE_IMAGE_INVALID_TASK");
          const images = await downloadSceneImageBundle(bytes, j.intent.taskRef, async image => {
            c.assertCurrent();
            checked(await c.host.call<Journal>("courseware.sceneImage.bundle.stage", { ...c.scope, stageOnly: true, images: [image] }), p.intentId);
            c.assertCurrent();
          });
          c.assertCurrent();
          checked(await c.host.call<Journal>("courseware.sceneImage.bundle.stage", { ...c.scope, images }), p.intentId);
          return await this.preview(value);
        }
        const a = task.assetRef;
        const asset = { taskRef: j.intent.taskRef, sha256: a.sha256, mimeType: a.mime,
          byteLength: a.byteLength, width: a.width, height: a.height };
        verifySceneImageAsset(bytes, asset, j.intent.target);
        c.assertCurrent();
        checked(await c.host.call<Journal>("courseware.sceneImage.asset.stage", { ...c.scope, asset, bytesBase64: bytes.toString("base64") }), p.intentId);
      }
      c.assertCurrent();
      return await this.preview(value);
    } finally { this.archiving.delete(key); }
  }

  async preview(value: unknown): Promise<CoursewareSceneImagePreview> {
    const p = input(value, ["intentId"]), c = this.context(p, true);
    const saved = await c.host.call<Journal & { path: string }>("courseware.sceneImage.asset.get", c.scope);
    const j = checked(saved, p.intentId), asset = j.intent.asset;
    if (!asset) throw new Error("COURSEWARE_SCENE_IMAGE_INVALID_JOURNAL");
    c.assertCurrent();
    const bytes = await readSceneImageAsset(saved.path, asset, j.intent.target);
    c.assertCurrent();
    return { image: view(j), dataUrl: `data:${asset.mimeType};base64,${bytes.toString("base64")}` };
  }

  async adopt(value: unknown): Promise<CoursewareSceneImageView[]> {
    if (!value || typeof value !== "object" || !Object.hasOwn(value, "expectedSelectedIntentId") ||
        (Reflect.get(value, "expectedSelectedIntentId") !== null && !id(Reflect.get(value, "expectedSelectedIntentId"))))
      throw new Error("COURSEWARE_SCENE_IMAGE_INVALID_REQUEST");
    const { expectedSelectedIntentId, ...payload } = value as Record<string, unknown>;
    const p = input(payload, ["intentId"]), c = this.context(p);
    const saved = await this.preview(payload);
    if (!saved.image.current) throw new Error("COURSEWARE_SCENE_IMAGE_PLAN_CHANGED");
    await this.approved(c.host, p.sessionId, saved.image.planSha256);
    c.assertCurrent();
    checked(await c.host.call<Journal>("courseware.sceneImage.asset.adopt", { ...c.scope, expectedSelectedIntentId }), p.intentId);
    c.assertCurrent();
    return this.list({ sessionId: p.sessionId });
  }

  private async bind(host: Host, scope: object, j: Journal, task: CoursewareImageTask) {
    if (task.kind !== j.intent.request.kind || task.idempotencyKey !== j.intent.idempotencyKey ||
        task.requestHash !== j.intent.requestHash || task.model !== j.intent.request.model)
      throw new Error("COURSEWARE_SCENE_IMAGE_INVALID_TASK");
    // Retain an accepted receipt in its original partition even after a Chat/plan change.
    return checked(await host.call<Journal>("courseware.sceneImage.bind", { ...scope, taskRef: {
      taskId: task.taskId, idempotencyKey: task.idempotencyKey, requestHash: task.requestHash } }), j.intent.intentId);
  }

  private async read(c: ReturnType<CoursewareSceneImages["context"]>, j: Journal): Promise<CoursewareSceneImageView> {
    if (j.intent.asset || j.intent.phase === "prepared" || j.intent.phase === "rejected") { c.assertCurrent(); return view(j); }
    c.assertCurrent();
    const task = j.intent.taskRef ? await this.auth.coursewareMedia.getImage(j.intent.taskRef, undefined, j.intent.request.kind)
      : await this.auth.coursewareMedia.findImage({ idempotencyKey: j.intent.idempotencyKey, requestHash: j.intent.requestHash }, undefined, j.intent.request.kind);
    if (!task) { c.assertCurrent(); return view(j); }
    const bound = await this.bind(c.host, c.scope, j, task);
    c.assertCurrent();
    return view(bound, task);
  }
}
