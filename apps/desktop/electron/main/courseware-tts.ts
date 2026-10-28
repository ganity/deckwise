import { randomUUID } from "node:crypto";
import { coursewareMediaSubmissionProject, isCoursewareMediaPermissionRefusal } from "./courseware-media-scope";
import type { CoursewareTaskRef, CoursewareTtsArchiveView, CoursewareTtsQuoteView, CoursewareTtsView } from "@pi-desktop/shared";
import type { DesktopAuthSession } from "./auth-session";
import type { CoursewareTeachingCoordinator } from "./courseware-teaching";
import type { CoursewareTtsQuote, CoursewareTtsRequest, CoursewareTtsTask } from "./courseware-media";

type Context = Awaited<ReturnType<CoursewareTeachingCoordinator["ttsContext"]>>;
type Selection = Pick<Context, "projectId" | "pageId" | "expectedSourceRevision" | "expectedTeachingRevision"> & {
  intentId: string; principalKey: string; actionId: string; model: string; voice: string | null;
};
type Summary = { selection: Selection; phase: CoursewareTtsView["phase"]; idempotencyKey: string;
  requestHash: string; taskRef: CoursewareTaskRef | null; current: boolean; audioReady: false };
type Journal = { intent: Omit<Summary, "current" | "audioReady"> & { request: CoursewareTtsRequest; sourceSha256: string; submissionScope?: unknown };
  current: boolean; audioReady: false };
type Audio = { taskRef: CoursewareTaskRef; sha256: string; mimeType: "audio/wav" | "audio/mpeg"; byteLength: number; durationMs: number };
type TtsSnapshotAudio = { asset: { id: string; sha256: string; mimeType: string }; tts: { principalKey: string; intentId: string } };
type MusicSnapshotAudio = { asset: { id: string; sha256: string; mimeType: string }; music: { principalKey: string; intentId: string } };
type VideoSnapshotAsset = { asset: { id: string; sha256: string; mimeType: string }; video: { principalKey: string; intentId: string } };
type SnapshotAudio = TtsSnapshotAudio | MusicSnapshotAudio | VideoSnapshotAsset;
const id = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9._-]{1,128}$/u.test(value) && value !== "." && value !== "..";
function payload(value: unknown, extra: string[]): Record<string, unknown> {
  const keys = ["viewId", "expectedTeachingRevision", ...extra];
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length !== keys.length ||
      keys.some((key) => !Object.hasOwn(value, key)) || !id(Reflect.get(value, "viewId")) || !id(Reflect.get(value, "expectedTeachingRevision"))) throw new Error("COURSEWARE_TTS_INVALID_REQUEST");
  return value as Record<string, unknown>;
}
function view(summary: Summary, task: CoursewareTtsTask | null = null): CoursewareTtsView {
  const { selection } = summary;
  return { intentId: selection.intentId, pageId: selection.pageId, actionId: selection.actionId, model: selection.model,
    voice: selection.voice, phase: summary.phase, current: summary.current, audioReady: false,
    task: task && { state: task.state, feeState: task.feeState, reservedPoints: task.reservedPoints,
      actualPoints: task.actualPoints, errorCode: task.errorCode } };
}
const summary = (journal: Journal): Summary => ({ ...journal.intent, current: journal.current, audioReady: false });

/** Explicit submission only; status and recovery never POST or generate a key. */
export class CoursewareTtsCoordinator {
  private quotes = new Map<string, { scope: string; requestHash: string; quote: CoursewareTtsQuote }>();
  private submitting = new Set<string>();
  private archiving = new Set<string>();
  constructor(private teaching: Pick<CoursewareTeachingCoordinator, "ttsContext"> & Partial<Pick<CoursewareTeachingCoordinator, "captureSnapshot">>,
    private auth: Pick<DesktopAuthSession, "getCoursewarePrincipal" | "coursewareMedia">,
    private decodeAudio: (bytes: Buffer, mime: Audio["mimeType"]) => Promise<number>) {}

  private async context(input: Record<string, unknown>) {
    const principal = this.auth.getCoursewarePrincipal();
    const context = await this.teaching.ttsContext({ viewId: input.viewId, expectedTeachingRevision: input.expectedTeachingRevision });
    principal.assertCurrent();
    const assertCurrent = async () => { await context.assertCurrent(); principal.assertCurrent(); };
    const scope = { sessionId: context.sessionId, projectId: context.projectId, principalKey: principal.key };
    return { ...context, principal, assertCurrent, scope };
  }

  async prepare(value: unknown): Promise<CoursewareTtsView> {
    const input = payload(value, ["actionId", "model", "voice"]);
    if (!id(input.actionId) || !id(input.model) || (input.voice !== null && (typeof input.voice !== "string" || !/^[A-Za-z0-9_-]{1,64}$/u.test(input.voice)))) throw new Error("COURSEWARE_TTS_INVALID_REQUEST");
    const context = await this.context(input);
    const selection: Selection = { intentId: randomUUID(), principalKey: context.principal.key, projectId: context.projectId,
      pageId: context.pageId, actionId: input.actionId, expectedSourceRevision: context.expectedSourceRevision,
      expectedTeachingRevision: context.expectedTeachingRevision, model: input.model, voice: input.voice as string | null };
    const journal = await context.host.call<Journal>("courseware.tts.prepare", { sessionId: context.sessionId, selection });
    if (Object.keys(selection).some((key) => Reflect.get(journal.intent.selection, key) !== Reflect.get(selection, key))) throw new Error("COURSEWARE_TTS_INVALID_JOURNAL");
    await context.assertCurrent();
    return view(summary(journal));
  }

  async list(value: unknown): Promise<CoursewareTtsView[]> {
    const context = await this.context(payload(value, []));
    const { intents } = await context.host.call<{ intents: Summary[] }>("courseware.tts.list", context.scope);
    if (!Array.isArray(intents) || intents.length > 1000) throw new Error("COURSEWARE_TTS_INVALID_JOURNAL");
    await context.assertCurrent();
    return intents.filter((intent) => intent.selection.pageId === context.pageId).map((intent) => {
      this.assertScope(intent.selection, context);
      return view(intent);
    });
  }

  async status(value: unknown): Promise<CoursewareTtsView> {
    const { context, scope } = await this.operation(value);
    const journal = await context.host.call<Journal>("courseware.tts.get", scope);
    this.assertScope(journal.intent.selection, context, scope.intentId);
    return this.read(context, journal);
  }

  async models(value: unknown) {
    const context = await this.context(payload(value, []));
    const models = await this.auth.coursewareMedia.getTtsModels();
    await context.assertCurrent();
    return models;
  }

  async quote(value: unknown): Promise<CoursewareTtsQuoteView> {
    const { context, scope } = await this.operation(value);
    const journal = await context.host.call<Journal>("courseware.tts.get", scope);
    this.assertScope(journal.intent.selection, context, scope.intentId);
    if (journal.intent.phase !== "prepared" || !journal.current ||
        journal.intent.selection.expectedSourceRevision !== context.expectedSourceRevision ||
        journal.intent.selection.expectedTeachingRevision !== context.expectedTeachingRevision) throw new Error("COURSEWARE_TTS_STALE");
    const quote = await this.auth.coursewareMedia.getTtsQuote(journal.intent.selection.model);
    await context.assertCurrent();
    if (journal.intent.request.input.length > quote.maxChars) throw new Error("COURSEWARE_TTS_TEXT_TOO_LONG");
    for (const [key, saved] of this.quotes) {
      if (Date.parse(saved.quote.expiresAt) <= Date.now() || saved.scope === JSON.stringify(scope)) this.quotes.delete(key);
    }
    if (this.quotes.size >= 100) this.quotes.delete(this.quotes.keys().next().value!);
    const quoteId = randomUUID();
    this.quotes.set(quoteId, { scope: JSON.stringify(scope), requestHash: journal.intent.requestHash, quote });
    return { quoteId, intentId: scope.intentId, model: quote.model, voice: journal.intent.selection.voice,
      maxPoints: quote.maxPoints, maxChars: quote.maxChars, expiresAt: quote.expiresAt };
  }

  async submitConfirmed(value: unknown): Promise<CoursewareTtsView> {
    const input = payload(value, ["intentId", "quoteId"]);
    if (!id(input.quoteId)) throw new Error("COURSEWARE_TTS_INVALID_REQUEST");
    const { quoteId, ...operation } = input;
    return this.submitOperation(operation, quoteId as string);
  }

  async submit(value: unknown): Promise<CoursewareTtsView> {
    return this.submitOperation(value);
  }

  private async submitOperation(value: unknown, quoteId?: string): Promise<CoursewareTtsView> {
    const { context, scope } = await this.operation(value);
    const key = JSON.stringify(scope);
    if (this.submitting.has(key)) throw new Error("COURSEWARE_TTS_IN_FLIGHT");
    this.submitting.add(key);
    try {
      const journal = await context.host.call<Journal>("courseware.tts.get", scope);
      this.assertScope(journal.intent.selection, context, scope.intentId);
      if (journal.intent.phase !== "prepared") return await this.read(context, journal);
      const selection = journal.intent.selection;
      if (!journal.current || selection.expectedSourceRevision !== context.expectedSourceRevision ||
          selection.expectedTeachingRevision !== context.expectedTeachingRevision) throw new Error("COURSEWARE_TTS_STALE");
      const saved = quoteId === undefined ? undefined : this.quotes.get(quoteId);
      if (quoteId !== undefined && (!saved || saved.scope !== key || saved.requestHash !== journal.intent.requestHash ||
          Date.parse(saved.quote.expiresAt) <= Date.now())) throw new Error("COURSEWARE_TTS_QUOTE_REQUIRED");
      await context.assertCurrent();
      if (quoteId !== undefined) this.quotes.delete(quoteId);
      const begun = await context.host.call<Journal>("courseware.tts.begin", scope);
      if (begun.intent.phase !== "submission-unknown" || begun.intent.idempotencyKey !== journal.intent.idempotencyKey ||
          begun.intent.requestHash !== journal.intent.requestHash || JSON.stringify(begun.intent.request) !== JSON.stringify(journal.intent.request)) throw new Error("COURSEWARE_TTS_INVALID_JOURNAL");
      await context.assertCurrent();
      const teamProjectId = coursewareMediaSubmissionProject(begun.intent.submissionScope, context.sessionId);
      await context.assertCurrent();
      let task: CoursewareTtsTask;
      try {
        task = saved
          ? await this.auth.coursewareMedia.submitConfirmedTts(begun.intent.idempotencyKey, begun.intent.request, saved.quote, undefined, teamProjectId)
          : await this.auth.coursewareMedia.submitTts(begun.intent.idempotencyKey, begun.intent.request, undefined, teamProjectId);
      } catch (failure) {
        if (!isCoursewareMediaPermissionRefusal(failure, teamProjectId)) throw failure;
        const rejected = await context.host.call<Journal>("courseware.tts.reject", { ...scope,
          rejectedRequest: { idempotencyKey: begun.intent.idempotencyKey, requestHash: begun.intent.requestHash } });
        this.assertScope(rejected.intent.selection, context, scope.intentId);
        if (rejected.intent.phase !== "rejected" || rejected.intent.idempotencyKey !== begun.intent.idempotencyKey ||
            rejected.intent.requestHash !== begun.intent.requestHash) throw new Error("COURSEWARE_TTS_INVALID_JOURNAL");
        await context.assertCurrent();
        return view(summary(rejected));
      }
      if (task.requestHash !== begun.intent.requestHash || task.idempotencyKey !== begun.intent.idempotencyKey || task.model !== selection.model) throw new Error("COURSEWARE_TTS_INVALID_TASK");
      // Retain a valid late receipt even if the editor moved; never attach its audio here.
      const bound = await context.host.call<Journal>("courseware.tts.bind", { ...scope,
        taskRef: { taskId: task.taskId, idempotencyKey: task.idempotencyKey, requestHash: task.requestHash } });
      await context.assertCurrent();
      return view(summary(bound), task);
    } finally { this.submitting.delete(key); }
  }

  async archive(value: unknown): Promise<CoursewareTtsArchiveView> {
    const { context, scope } = await this.operation(value);
    const key = JSON.stringify(scope);
    if (this.archiving.has(key)) throw new Error("COURSEWARE_TTS_IN_FLIGHT");
    this.archiving.add(key);
    try {
      const journal = await context.host.call<Journal>("courseware.tts.get", scope);
      this.assertScope(journal.intent.selection, context, scope.intentId);
      const reference = journal.intent.taskRef;
      if (!reference) throw new Error("COURSEWARE_TTS_TASK_REQUIRED");
      let archived: { audio: Audio } | undefined;
      try { archived = await context.host.call("courseware.tts.audio.get", scope); }
      catch (error) {
        if (!error || typeof error !== "object" || Reflect.get(error, "errorCode") !== "COURSEWARE_NOT_FOUND") throw error;
      }
      if (!archived) {
        await context.assertCurrent();
        const { task, bytes } = await this.auth.coursewareMedia.download(reference);
        if (task.model !== journal.intent.selection.model || !task.assetRef) throw new Error("COURSEWARE_TTS_INVALID_TASK");
        await context.assertCurrent();
        const durationMs = await this.decodeAudio(bytes, task.assetRef.mime);
        await context.assertCurrent();
        const audio: Audio = { taskRef: reference, sha256: task.assetRef.sha256, mimeType: task.assetRef.mime,
          byteLength: bytes.length, durationMs };
        archived = await context.host.call("courseware.tts.audio.stage", { ...scope, audio, bytesBase64: bytes.toString("base64") });
      }
      await context.assertCurrent();
      if (!archived || archived.audio.taskRef.taskId !== reference.taskId || archived.audio.taskRef.idempotencyKey !== reference.idempotencyKey ||
          archived.audio.taskRef.requestHash !== reference.requestHash || !/^[a-f0-9]{64}$/u.test(archived.audio.sha256) ||
          !["audio/wav", "audio/mpeg"].includes(archived.audio.mimeType) || !Number.isSafeInteger(archived.audio.byteLength) ||
          archived.audio.byteLength < 1 || archived.audio.byteLength > 16 * 1024 * 1024 || !Number.isSafeInteger(archived.audio.durationMs) ||
          archived.audio.durationMs < 1 || archived.audio.durationMs > 86_400_000) throw new Error("COURSEWARE_TTS_INVALID_JOURNAL");
      return { intentId: scope.intentId, archived: true, durationMs: archived.audio.durationMs, audioReady: false };
    } finally { this.archiving.delete(key); }
  }

  async adopt(value: unknown): Promise<Awaited<ReturnType<Context["adoptAudio"]>>> {
    const { context, scope } = await this.operation(value);
    const journal = await context.host.call<Journal>("courseware.tts.get", scope);
    this.assertScope(journal.intent.selection, context, scope.intentId);
    const { selection, taskRef } = journal.intent;
    if (journal.intent.phase !== "submitted" || !taskRef || selection.projectId !== context.projectId || selection.pageId !== context.pageId)
      throw new Error("COURSEWARE_TTS_TASK_REQUIRED");
    const saved = await context.host.call<{ audio: Audio; asset: { id: string }; adoptedTeachingRevision: string | null }>(
      "courseware.tts.audio.get", scope);
    const audio = saved.audio;
    if (audio.taskRef.taskId !== taskRef.taskId || audio.taskRef.idempotencyKey !== taskRef.idempotencyKey ||
        audio.taskRef.requestHash !== taskRef.requestHash || saved.asset.id !== `tts-${audio.sha256}` ||
        !/^[a-f0-9]{64}$/u.test(audio.sha256) || !Number.isSafeInteger(audio.durationMs) ||
        audio.durationMs < 1 || audio.durationMs > 86_400_000) throw new Error("COURSEWARE_TTS_INVALID_JOURNAL");
    await context.assertCurrent();
    return context.adoptAudio({ principalKey: context.principal.key, intentId: scope.intentId,
      actionId: selection.actionId, assetId: saved.asset.id });
  }

  async captureSnapshot(value: unknown): Promise<import("@pi-desktop/shared").CoursewareSnapshot> {
    if (!this.teaching.captureSnapshot) throw new Error("COURSEWARE_SNAPSHOT_CAPTURE_UNAVAILABLE");
    const input = payload(value, []);
    const pinned = await this.teaching.ttsContext({ viewId: input.viewId, expectedTeachingRevision: input.expectedTeachingRevision });
    const speeches = pinned.project.pages.flatMap((page) => page.actions
      .filter((action) => action.type === "speech")
      .map((action) => ({ pageId: page.pageId, actionId: action.id, text: action.text, assetId: action.audioAssetId })));
    const clipAssetIds = pinned.project.pages.flatMap(page => page.actions)
      .filter(action => action.type === "audio_clip").map(action => action.audioAssetId);
    const videoClips = pinned.project.pages.flatMap(page => page.actions.filter(action => action.type === "video_clip").map(action => ({ pageId: page.pageId, action })));
    if (!speeches.length && !clipAssetIds.length && !videoClips.length) return this.teaching.captureSnapshot(value);
    const context = await this.context(input);
    const assets = new Map<string, SnapshotAudio>();
    if (speeches.length) {
      const { intents } = await context.host.call<{ intents: Array<{ selection: Selection; phase: string }> }>("courseware.tts.list", context.scope);
      if (!Array.isArray(intents) || intents.length > 1000) throw new Error("COURSEWARE_TTS_INVALID_JOURNAL");
      for (const speech of speeches) {
        if (!id(speech.actionId) || typeof speech.text !== "string" || !speech.text.trim() ||
            typeof speech.assetId !== "string" || !/^tts-[a-f0-9]{64}$/u.test(speech.assetId))
          throw new Error("COURSEWARE_AUDIO_REQUIRED");
        const matches = intents.filter(({ selection, phase }) => selection.pageId === speech.pageId &&
          selection.actionId === speech.actionId && phase === "submitted");
        let matched: TtsSnapshotAudio | undefined;
        for (const { selection } of matches) {
          if (selection.projectId !== context.projectId || selection.principalKey !== context.principal.key || !id(selection.intentId))
            throw new Error("COURSEWARE_TTS_INVALID_JOURNAL");
          const scope = { ...context.scope, intentId: selection.intentId };
          const journal = await context.host.call<Journal>("courseware.tts.get", scope);
          if (journal.intent.selection.actionId !== speech.actionId || journal.intent.selection.pageId !== speech.pageId ||
              journal.intent.request.input !== speech.text ||
              !journal.intent.taskRef) continue;
          let saved: { audio: Audio; asset: SnapshotAudio["asset"]; adoptedTeachingRevision: string | null;
            boundSource?: { revision: string; sha256: string } | null };
          try { saved = await context.host.call("courseware.tts.audio.get", scope); }
          catch (error) {
            if (error && typeof error === "object" && Reflect.get(error, "errorCode") === "COURSEWARE_NOT_FOUND") continue;
            throw error;
          }
          const boundSource = saved.boundSource ?? { revision: journal.intent.selection.expectedSourceRevision, sha256: journal.intent.sourceSha256 };
          if (boundSource.revision !== context.project.source.revision || boundSource.sha256 !== context.project.source.sha256 ||
              saved.adoptedTeachingRevision === null || saved.asset.id !== speech.assetId ||
              saved.asset.id !== `tts-${saved.audio.sha256}` || saved.audio.taskRef.taskId !== journal.intent.taskRef.taskId ||
              saved.audio.taskRef.requestHash !== journal.intent.taskRef.requestHash ||
              saved.audio.taskRef.idempotencyKey !== journal.intent.taskRef.idempotencyKey) continue;
          matched = { asset: saved.asset, tts: { principalKey: context.principal.key, intentId: selection.intentId } };
          break;
        }
        if (!matched) throw new Error("COURSEWARE_AUDIO_REQUIRED: adopted audio does not match current speech");
        assets.set(matched.asset.id, matched);
      }
    }
    if (clipAssetIds.length) {
      if (clipAssetIds.some(assetId => typeof assetId !== "string" || !/^music-[a-f0-9]{64}$/u.test(assetId)))
        throw new Error("COURSEWARE_AUDIO_REQUIRED: invalid music clip asset");
      const music = await context.host.call<{ assets: MusicSnapshotAudio[] }>("courseware.mediaCanvas.music.snapshotAssets", {
        ...context.scope, expectedSourceRevision: context.expectedSourceRevision, expectedTeachingRevision: context.expectedTeachingRevision,
      });
      await context.assertCurrent();
      if (!Array.isArray(music.assets) || music.assets.length > 1000 || music.assets.some(entry =>
          !entry || !entry.asset || entry.asset.id !== `music-${entry.asset.sha256}` ||
          !/^[a-f0-9]{64}$/u.test(entry.asset.sha256) || entry.asset.mimeType !== "audio/mpeg" ||
          !entry.music || entry.music.principalKey !== context.principal.key || !id(entry.music.intentId)) ||
          new Set(music.assets.map(entry => entry.asset.id)).size !== music.assets.length ||
          JSON.stringify(music.assets.map(entry => entry.asset.id).sort()) !== JSON.stringify([...new Set(clipAssetIds)].sort()))
        throw new Error("COURSEWARE_AUDIO_REQUIRED: adopted music does not match current teaching");
      for (const entry of music.assets) assets.set(entry.asset.id, entry);
    }
    if (videoClips.length) {
      const { intents } = await context.host.call<{ intents: import("./courseware-saved-video").SavedVideoIntent[] }>("courseware.video.list", context.scope);
      for (const { pageId, action } of videoClips) {
        const matched = intents.find(intent => intent.phase === "adopted" && intent.pageId === pageId && intent.slotId === action.id &&
          intent.source.sha256 === context.project.source.sha256 && intent.source.revision === context.project.source.revision &&
          intent.asset && action.videoAssetId === `video-${intent.asset.sha256}`);
        if (!matched?.asset) throw new Error("COURSEWARE_VIDEO_REQUIRED: adopted video does not match current teaching");
        const asset = { id: `video-${matched.asset.sha256}`, sha256: matched.asset.sha256, mimeType: "video/mp4" };
        assets.set(asset.id, { asset, video: { principalKey: context.principal.key, intentId: matched.intentId } });
      }
    }
    await context.assertCurrent();
    return this.teaching.captureSnapshot(value, [...assets.values()], () => context.principal.assertCurrent());
  }

  private async operation(value: unknown) {
    const input = payload(value, ["intentId"]);
    if (!id(input.intentId)) throw new Error("COURSEWARE_TTS_INVALID_REQUEST");
    const context = await this.context(input);
    return { context, scope: { ...context.scope, intentId: input.intentId } };
  }

  private assertScope(selection: Selection, context: Awaited<ReturnType<CoursewareTtsCoordinator["context"]>>, intentId?: string) {
    if (selection.projectId !== context.projectId || selection.pageId !== context.pageId || selection.principalKey !== context.principal.key ||
        (intentId !== undefined && selection.intentId !== intentId)) throw new Error("COURSEWARE_TTS_INVALID_JOURNAL");
  }

  private async read(context: Awaited<ReturnType<CoursewareTtsCoordinator["context"]>>, journal: Journal) {
    await context.assertCurrent();
    let task: CoursewareTtsTask | null = null;
    if (journal.intent.taskRef) task = await this.auth.coursewareMedia.get(journal.intent.taskRef);
    else if (journal.intent.phase === "submission-unknown") {
      task = await this.auth.coursewareMedia.findTts({ idempotencyKey: journal.intent.idempotencyKey, requestHash: journal.intent.requestHash });
      if (task) {
        if (task.idempotencyKey !== journal.intent.idempotencyKey || task.requestHash !== journal.intent.requestHash ||
            task.model !== journal.intent.selection.model) throw new Error("COURSEWARE_TTS_INVALID_TASK");
        // Keep the receipt for the original journal even if the editor moved during lookup.
        context.principal.assertCurrent();
        await context.host.call("courseware.tts.bind", { ...context.scope, intentId: journal.intent.selection.intentId,
          taskRef: { taskId: task.taskId, idempotencyKey: task.idempotencyKey, requestHash: task.requestHash } });
      }
    }
    if (task && task.model !== journal.intent.selection.model) throw new Error("COURSEWARE_TTS_INVALID_TASK");
    const latest = await context.host.call<Journal>("courseware.tts.get", { ...context.scope, intentId: journal.intent.selection.intentId });
    this.assertScope(latest.intent.selection, context, journal.intent.selection.intentId);
    await context.assertCurrent();
    return view(summary(latest), task);
  }
}
