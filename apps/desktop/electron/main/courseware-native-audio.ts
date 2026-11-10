import { createHash, randomUUID } from "node:crypto";
import type { DesktopAuthSession } from "./auth-session";
import type { CoursewareTtsQuote, CoursewareTtsRequest, CoursewareTtsTask } from "./courseware-media";
import type { CoursewareTaskRef, CoursewareTeachingView } from "@pi-desktop/shared";

type Host = { call<T>(method: string, params: unknown): Promise<T> };
type Intent = { intentId: string; pageId: string; actionId: string; revision: string; request: CoursewareTtsRequest;
  key: string; hash: string; phase: "prepared" | "submission-unknown" | "submitted"; taskRef: CoursewareTaskRef | null;
  adoptedAssetId?: string; submissionScope?: { sessionId: string; teamProjectId: string | null } };
type Journal = { revision: number; value: { intents: Intent[] } };
type Route = (operation: string, args: Record<string, unknown>, page: number) => Promise<{ value: unknown } | undefined>;
const digest = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");

/** Private paid-task journal stays in Host; only verified adopted media enters native document history. */
export class CoursewareNativeAudio {
  private quotes = new Map<string, { intentId: string; quote: CoursewareTtsQuote }>();
  private inFlight = new Set<string>();
  constructor(private auth: Pick<DesktopAuthSession, "getCoursewarePrincipal" | "coursewareMedia">,
    private getHost: () => Host | null, private session: () => string | null, private route: Route,
    private decode: (bytes: Buffer, mime: "audio/wav" | "audio/mpeg") => Promise<number>) {}

  async execute(operation: string, args: Record<string, unknown>, page: number, view: CoursewareTeachingView): Promise<unknown> {
    if (args.viewId !== view.viewId || args.expectedTeachingRevision !== view.project.teachingRevision) throw new Error("Native teaching view changed");
    const principal = this.auth.getCoursewarePrincipal(), host = this.getHost(), sessionId = this.session();
    if (!host || !sessionId) throw new Error("Native media owner unavailable");
    const check = async () => {
      principal.assertCurrent();
      if (this.getHost() !== host || this.session() !== sessionId) throw new Error("Native media owner changed");
      const latest = await this.route("open", {}, page);
      const current = latest?.value as CoursewareTeachingView | undefined;
      if (!current || current.viewId !== view.viewId || current.project.teachingRevision !== view.project.teachingRevision ||
          (!["tts:models", "tts:list", "tts:status", "tts:archive"].includes(operation) && current.project.pages.find(p => p.pageId === view.pageId)?.locked)) throw new Error("Native teaching changed; read the current page");
      principal.assertCurrent();
    };
    await check();
    if (operation === "tts:models") { const models = await this.auth.coursewareMedia.getTtsModels(); await check(); return models; }
    const key = "task:native-" + digest(sessionId + ":" + view.project.projectId);
    let journal = await host.call<Journal | null>("courseware.mediaRelay.read", { principalKey: principal.key, key });
    let intents = journal?.value.intents ?? [];
    if (!Array.isArray(intents) || intents.length > 1000) throw new Error("Invalid native media journal");
    const save = async () => {
      principal.assertCurrent();
      journal = await host.call<Journal>("courseware.mediaRelay.write", { principalKey: principal.key, key,
        expectedRevision: journal?.revision ?? 0, value: { intents } });
    };
    const currentIntent = (i: Intent) => view.project.pages.find(p => p.pageId === i.pageId)?.actions.some(a => a.id === i.actionId && a.type === "speech" && a.text === i.request.input) ?? false;
    const publicView = (i: Intent, task: CoursewareTtsTask | null = null) => ({ intentId: i.intentId, pageId: i.pageId, actionId: i.actionId,
      model: i.request.model, voice: i.request.voice ?? null, phase: i.phase, current: currentIntent(i),
      audioReady: !!i.adoptedAssetId && view.project.pages.find(p => p.pageId === i.pageId)?.actions.some(a => a.id === i.actionId && a.audioAssetId === i.adoptedAssetId), task: task && { state: task.state, feeState: task.feeState, reservedPoints: task.reservedPoints,
        actualPoints: task.actualPoints, errorCode: task.errorCode } });
    if (operation === "tts:list") return intents.filter(i => i.pageId === view.pageId).map(i => publicView(i));
    if (operation === "tts:prepare") {
      const action = view.project.pages.find(p => p.pageId === view.pageId)?.actions.find(a => a.id === args.actionId);
      if (!action || action.type !== "speech" || typeof action.text !== "string" || !action.text.trim() || action.text.length > 4000 ||
          typeof args.model !== "string" || !/^[A-Za-z0-9._-]{1,128}$/.test(args.model) ||
          args.voice !== null && (typeof args.voice !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(args.voice))) throw new Error("Invalid native speech request");
      const request: CoursewareTtsRequest = { kind: "tts", model: args.model, input: action.text, voice: args.voice as string | null };
      const canonical = [request.kind, request.model, request.input, request.voice ?? null].reduce<string>((text, field) =>
        `${text}:${field === null ? -1 : field.length}:${field ?? ""}`, "courseware-media-v1");
      if (intents.length >= 1000) throw new Error("Native media journal is full");
      const intent: Intent = { intentId: randomUUID(), pageId: view.pageId, actionId: String(action.id), revision: view.project.teachingRevision,
        request, key: "native-" + randomUUID(), hash: digest(canonical), phase: "prepared", taskRef: null };
      await check(); intents = [...intents, intent]; await save(); return publicView(intent);
    }
    const intent = intents.find(i => i.intentId === args.intentId && i.pageId === view.pageId);
    if (!intent) throw new Error("Native speech task unavailable");
    if (operation === "tts:quote") {
      if (intent.phase !== "prepared" || !currentIntent(intent)) throw new Error("Native speech task is stale");
      const quote = await this.auth.coursewareMedia.getTtsQuote(intent.request.model); await check();
      if (intent.request.input.length > quote.maxChars) throw new Error("Narration exceeds model limit");
      for (const [id, offer] of this.quotes) if (Date.parse(offer.quote.expiresAt) <= Date.now()) this.quotes.delete(id);
      if (this.quotes.size >= 1000) throw new Error("Too many unconfirmed native speech quotes");
      const quoteId = randomUUID(); this.quotes.set(quoteId, { intentId: intent.intentId, quote });
      return { quoteId, intentId: intent.intentId, model: quote.model, voice: intent.request.voice ?? null,
        maxPoints: quote.maxPoints, maxChars: quote.maxChars, expiresAt: quote.expiresAt };
    }
    const refresh = async () => {
      const task = intent.taskRef ? await this.auth.coursewareMedia.get(intent.taskRef) : intent.phase === "submission-unknown"
        ? await this.auth.coursewareMedia.findTts({ idempotencyKey: intent.key, requestHash: intent.hash }) : null;
      if (task) {
        if (task.requestHash !== intent.hash || task.idempotencyKey !== intent.key || task.model !== intent.request.model) throw new Error("Invalid native speech receipt");
        intent.taskRef = { taskId: task.taskId, idempotencyKey: task.idempotencyKey, requestHash: task.requestHash };
        intent.phase = "submitted"; await save();
      }
      return task;
    };
    if (operation === "tts:status") { const task = await refresh(); await check(); return publicView(intent, task); }
    if (operation === "tts:submit") {
      if (intent.phase !== "prepared") return publicView(intent, await refresh());
      const offered = this.quotes.get(String(args.quoteId));
      if (!offered || offered.intentId !== intent.intentId || Date.parse(offered.quote.expiresAt) <= Date.now() ||
          !currentIntent(intent)) throw new Error("Confirm a current speech quote first");
      if (this.inFlight.has(intent.key)) throw new Error("Speech submission already in progress");
      this.inFlight.add(intent.key);
      try {
        await check();
        intent.submissionScope = await host.call("courseware.mediaRelay.scope", { sessionId });
        intent.phase = "submission-unknown"; await save(); this.quotes.delete(String(args.quoteId));
        const task = await this.auth.coursewareMedia.submitConfirmedTts(intent.key, intent.request, offered.quote, undefined,
          intent.submissionScope!.teamProjectId ?? undefined, check);
        if (task.requestHash !== intent.hash || task.idempotencyKey !== intent.key || task.model !== intent.request.model) throw new Error("Invalid native speech receipt");
        principal.assertCurrent();
        intent.taskRef = { taskId: task.taskId, idempotencyKey: task.idempotencyKey, requestHash: task.requestHash };
        intent.phase = "submitted"; await save(); await check(); return publicView(intent, task);
      } finally { this.inFlight.delete(intent.key); }
    }
    if (operation === "tts:archive" || operation === "tts:adopt") {
      if (!currentIntent(intent) || !intent.taskRef) throw new Error("Native speech result is stale");
      const { task, bytes } = await this.auth.coursewareMedia.download(intent.taskRef);
      if (!task.assetRef || task.model !== intent.request.model) throw new Error("Native speech audio unavailable");
      const durationMs = await this.decode(bytes, task.assetRef.mime); await check();
      if (operation === "tts:archive") return { intentId: intent.intentId, archived: true, durationMs, audioReady: false };
      const result = await this.route("adopt-audio", { ...args, command: { actionId: intent.actionId,
        assetId: "tts-" + task.assetRef.sha256, sha256: task.assetRef.sha256, mimeType: task.assetRef.mime,
        durationMs, bytes: Uint8Array.from(bytes).buffer } }, page);
      intent.adoptedAssetId = "tts-" + task.assetRef.sha256; await save();
      return result?.value;
    }
    throw new Error("Unsupported native media operation: " + operation);
  }
}
