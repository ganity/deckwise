import { coursewareMediaRecovery } from "@pi-desktop/shared";
import { createHash, randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import type { CoursewareCanvasMusicView, CoursewareTtsView, MediaCanvasDocument } from "@pi-desktop/shared";
import type { DesktopAuthSession } from "./auth-session";
import { hasDetailedNarration, type CoursewareSavedNarration, type SavedCourseware } from "./courseware-saved-narration";
import { CoursewareTtsCoordinator } from "./courseware-tts";
import { CoursewareCanvasMusic } from "./courseware-canvas-music";
import { sceneTeachingForPage } from "./courseware-scene-object-view";
import { savedMediaPage } from "./courseware-saved-media-page";
import { COURSEWARE_GENERATION_LIMITS } from "./courseware-generation-queue";
import { musicRequestHash, type MusicOptions } from "./courseware-music-request";
import { savedVideo, type SavedVideoIntent } from "./courseware-saved-video";
import { assertCoursewareRetryable, coursewareRetryIntentId, currentCoursewareAttempts } from "./courseware-retry";

type Auth = Pick<DesktopAuthSession, "getCoursewarePrincipal" | "coursewareMedia">;
type Job = { actionId?: string; kind: "tts" | "music" | "video"; intentId: string; pageNumber: number; sourceSha256: string };
const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const id = (v: unknown): v is string => typeof v === "string" && /^[\w.-]{1,128}$/u.test(v) && ![".", ".."].includes(v);
const slotKey = (id: string) => createHash("sha256").update(id).digest("hex").slice(0, 16);
const musicPrefix = (sha: string, page: number) => `auto-music-${sha}-p${page}-`;
const waiting = (v: CoursewareTtsView | CoursewareCanvasMusicView) => coursewareMediaRecovery({ media: v }) === "pending";

/** All requests and verified archives remain in the existing Host media journals. */
export class CoursewareSavedMedia {
  constructor(private saved: CoursewareSavedNarration, private auth: Auth,
    private decodeAudio: (bytes: Buffer, mime: "audio/wav" | "audio/mpeg") => Promise<number>,
    private decodeVideo?: (bytes: Buffer) => Promise<{ durationMs: number; width: number; height: number }>) {}

  private scope(sessionId: string, projectId: string) {
    const principal = this.auth.getCoursewarePrincipal();
    principal.assertCurrent();
    return { sessionId, projectId, principalKey: principal.key };
  }

  async execute(sessionId: string, name: string, args: unknown, canDispatch: () => boolean): Promise<unknown> {
    if (!record(args)) throw new Error("Invalid saved media arguments");
    const input = structuredClone(args);
    if (name === "courseware_media_context") {
      if (Object.keys(input).some(k => !["kind", "continueTeaching"].includes(k)) ||
          input.continueTeaching !== undefined && typeof input.continueTeaching !== "boolean" || input.kind !== undefined && !["tts", "music", "video"].includes(String(input.kind)))
        throw new Error("Invalid saved media context");
      const narration = await this.saved.execute(sessionId, "courseware_narration_context", {}, canDispatch);
      return this.saved.withSaved(sessionId, canDispatch, async saved => {
        const { host, project } = saved, jobs: Job[] = [];
        const principal = this.auth.getCoursewarePrincipal();
        if (!record(narration) || narration.projectId !== project.projectId || narration.sourceSha256 !== project.source.sha256 ||
            narration.teachingRevision !== project.teachingRevision) throw new Error("Saved media context changed; read it again");
        const scope = this.scope(sessionId, project.projectId);
        const { intents } = await host.call<{ intents: Array<{ selection: { intentId: string; pageId: string; actionId: string }; phase: string }> }>("courseware.tts.list", scope);
        if (!Array.isArray(intents) || intents.length > 1000) throw new Error("Invalid saved TTS jobs");
        const activeIntents = currentCoursewareAttempts(intents.map(intent => ({ ...intent, intentId: intent.selection.intentId })));
        for (const [index, page] of project.pages.entries()) for (const action of page.actions) {
          if (action.type !== "speech" || action.audioAssetId) continue;
          for (const intent of activeIntents.filter(i => i.selection.pageId === page.pageId && i.selection.actionId === action.id)) {
            const journal = await host.call<{ intent: { sourceSha256: string; boundSource?: { sha256: string }; request: { input: string } } }>("courseware.tts.get", { ...scope, intentId: intent.selection.intentId });
            if ((journal.intent.boundSource?.sha256 ?? journal.intent.sourceSha256) === project.source.sha256 && journal.intent.request.input === action.text && !["prepared", "rejected"].includes(intent.phase))
              jobs.push({ kind: "tts", actionId: action.id as string, intentId: intent.selection.intentId, pageNumber: index + 1, sourceSha256: project.source.sha256 });
          }
        }
        const music = this.music(saved, sessionId, 1, canDispatch);
        const tracks = currentCoursewareAttempts(await music.list({ sessionId }));
        const unresolvedOriginals = tracks.filter(t => t.unresolvedProjectId === project.projectId && t.operation === "music" && !["prepared", "rejected"].includes(t.phase))
          .map(t => ({ kind: "music", intentId: t.intentId, recovery: "unknown", reason: "Legacy original has no verified saved target" }));
        for (const [index, page] of project.pages.entries()) {
          const matching = tracks.filter(t => t.target ? t.target.projectId === project.projectId && t.target.pageId === page.pageId : t.draft.id.startsWith(musicPrefix(project.source.sha256, index + 1)));
          for (const track of matching.filter(t => t.operation === "music" && !["prepared", "rejected"].includes(t.phase))) {
            const exported = matching.find(t => t.operation === "music-export" && t.sourceIntentId === track.intentId);
            const suffix = track.draft.id.slice(musicPrefix(project.source.sha256, index + 1).length);
            const slot = track.target ? slotKey(track.target.actionId) : /^[a-f0-9]{16}-[a-f0-9]{24,32}$/u.test(suffix) ? suffix.slice(0, 16) : undefined;
            if (slot && page.actions.some(a => a.type === "audio_clip" && slotKey(String(a.id)) === slot)) continue;
            if (exported?.asset && page.actions.some(a => a.type === "audio_clip" && a.audioAssetId === `music-${exported.asset!.sha256}` && (!slot || slotKey(String(a.id)) === slot))) continue;
            const actionId = slot ? page.actions.find(a => slotKey(String(a.id)) === slot)?.id as string | undefined : undefined;
            jobs.push({ kind: "music", ...(actionId ? { actionId } : {}), intentId: track.intentId, pageNumber: index + 1, sourceSha256: project.source.sha256 });
          }
        }
        if (project.pages.some(page => page.actions.some(a => a.type === "video_slot" || a.type === "video_clip"))) {
          const videos = await host.call<{ intents: SavedVideoIntent[] }>("courseware.video.list", scope);
          for (const intent of currentCoursewareAttempts(videos.intents)) {
            const index = project.pages.findIndex(page => page.pageId === intent.pageId && page.actions.some(a => a.id === intent.slotId && a.type === "video_slot" && a.prompt === intent.prompt));
            if (index >= 0 && (intent.boundSource ?? intent.source).sha256 === project.source.sha256 && intent.phase !== "prepared" && intent.phase !== "adopted")
              jobs.push({ kind: "video", actionId: intent.slotId, intentId: intent.intentId, pageNumber: index + 1, sourceSha256: project.source.sha256 });
          }
        }
        const models = input.kind === "video" ? await this.auth.coursewareMedia.video.models() : input.kind === "tts" ? await this.auth.coursewareMedia.getTtsModels()
          : input.kind === "music" ? await music.models({ sessionId }) : undefined;
        await saved.check(); principal.assertCurrent();
        return { ...(record(narration) ? narration : {}), jobs, unresolvedOriginals, videoReady: !project.pages.some(page => page.actions.some(a => a.type === "video_slot")), ...(models ? { models } : {}) };
      });
    }
    if (!["courseware_media_prepare", "courseware_media_refresh"].includes(name) ||
        !["tts", "music", "video"].includes(String(input.kind)) || !Number.isInteger(input.pageNumber) || Number(input.pageNumber) < 1 ||
        typeof input.sourceSha256 !== "string" || !/^[a-f0-9]{64}$/u.test(input.sourceSha256)) throw new Error("Invalid saved media request");
    const prepare = name === "courseware_media_prepare";
    const allowed = prepare ? ["kind", "pageNumber", "sourceSha256", "model", ...(input.kind === "tts" ? ["actionId", "actionIds", "voice"] : input.kind === "video" ? ["actionId"] : ["prompt", "music", "actionId"])]
      : ["kind", "pageNumber", "sourceSha256", "intentId", ...(input.kind === "tts" ? ["intentIds"] : []), "waitForUpdate", "retryFailed"];
    if (Object.keys(input).some(k => !allowed.includes(k)) || prepare && !id(input.model) ||
        !prepare && input.intentIds === undefined && !id(input.intentId) ||
        input.waitForUpdate !== undefined && typeof input.waitForUpdate !== "boolean" ||
        input.retryFailed !== undefined && typeof input.retryFailed !== "boolean" ||
        input.retryFailed === true && (!id(input.intentId) || input.intentIds !== undefined)) throw new Error("Invalid saved media fields");
    return this.saved.withSaved(sessionId, canDispatch, async saved => {
      if (saved.project.source.sha256 !== input.sourceSha256) throw new Error("Saved media source changed");
      if (input.kind === "video") {
        if (!this.decodeVideo) throw new Error("Video decoder unavailable");
        return savedVideo(input, saved, sessionId, this.auth, this.decodeVideo);
      }
      const pageNumber = Number(input.pageNumber), page = saved.project.pages[pageNumber - 1];
      if (!page || page.locked) throw new Error("Saved media page missing or locked");
      if (input.kind === "tts") {
        if (prepare && saved.project.taskType === "scene" && !hasDetailedNarration(page))
          throw new Error("Save detailed narration for this page before TTS; initial outline speech is not ready");
        if (prepare ? input.actionIds !== undefined : input.intentIds !== undefined) return this.ttsBatch(saved, sessionId, input, prepare);
        if (prepare && page.actions.some(a => a.type === "speech" && a.id === input.actionId && a.audioAssetId))
          return { saved: true, audioReady: true, pageNumber, actionId: input.actionId };
        const value = await this.tts(saved, sessionId, input, prepare);
        if (value.archived) return this.adoptTts(saved, sessionId, value.job);
        return { job: value.job, media: value.media, saved: false, waitingFor: waiting(value.media) ? "service" : null };
      }
      const bound = savedMediaPage(saved, sessionId, pageNumber);
      let job: Job;
      const slot = input.actionId === undefined ? undefined : page.actions.find(a => ["music_slot", "audio_clip"].includes(String(a.type)) && a.id === input.actionId);
      if (prepare && input.actionId !== undefined && (!id(input.actionId) || !slot)) throw new Error("Saved music slot changed");
      if (prepare && page.actions.some(a => a.type === "music_slot") && !slot) throw new Error("Music requires its saved slot actionId");
      let musicSlotId = slot?.id as string | undefined;
      const music = this.music(saved, sessionId, pageNumber, canDispatch);
      const allRows = await music.list({ sessionId });
      const rows = currentCoursewareAttempts(allRows);
      let row: CoursewareCanvasMusicView;
      if (prepare) {
        if (typeof input.prompt !== "string" || input.prompt.length > 4000 || !record(input.music)) throw new Error("Invalid music prompt/options");
        if (slot?.type === "audio_clip") return { saved: true, audioReady: true, pageNumber, actionId: slot.id };
        if (saved.project.taskType === "scene") {
          const context = await saved.host.call("courseware.project.context", { sessionId, projectId: saved.project.projectId });
          const teaching = sceneTeachingForPage(context, saved.project, page.pageId);
          await bound.check();
          if (teaching && !teaching.music) throw new Error("Music is not approved on this logical page; repair its unsubmitted slot instead");
        }
        if (rows.some(r => r.unresolvedProjectId === saved.project.projectId && !["prepared", "rejected"].includes(r.phase)))
          throw new Error("Original legacy music binding is unresolved; inspect its original intent before another submission");
        const requestHash = musicRequestHash({ kind: "music", model: input.model as string,
          input: input.prompt, music: input.music as MusicOptions });
        const draftId = musicPrefix(saved.project.source.sha256, pageNumber) + (musicSlotId ? `${slotKey(musicSlotId)}-` : "") + requestHash.slice(0, musicSlotId ? 24 : 32);
        const matching = rows.filter(r => r.operation === "music" && r.phase !== "rejected" && (musicSlotId
          ? r.target ? r.target.projectId === saved.project.projectId && r.target.pageId === page.pageId && r.target.actionId === musicSlotId : r.draft.id.startsWith(musicPrefix(saved.project.source.sha256, pageNumber) + slotKey(musicSlotId) + "-")
          : r.draft.id === draftId));
        // Only a never-submitted request can yield to corrected parameters; paid identities always win.
        row = (matching.find(r => r.phase !== "prepared") ?? matching.find(r => r.music &&
          musicRequestHash({ kind: "music", model: r.model, input: r.draft.prompt, music: r.music }) === requestHash))!;
        if (row?.target && row.target.source.sha256 !== saved.project.source.sha256) throw new Error("Original music source binding is unresolved; retain its intent");
        const exported = row && rows.find(r => r.operation === "music-export" && r.sourceIntentId === row.intentId);
        if (exported?.asset && page.actions.some(a => a.type === "audio_clip" && a.audioAssetId === `music-${exported.asset!.sha256}` && (!musicSlotId || a.id === musicSlotId)))
          return { saved: true, audioReady: true, pageNumber, intentId: row.intentId };
        if (!row) {
          const projectId = `canvas:${sessionId}`;
          const canvas = await saved.host.call<{ revision: string | null; document: MediaCanvasDocument | null }>("courseware.mediaCanvas.get", { sessionId, projectId });
          const document = canvas.document ?? { version: 1, projectId, revision: 0, viewport: { x: 0, y: 0, zoom: 1 }, drafts: [] };
          let draft = document.drafts.find(d => d.id === draftId);
          let revision = canvas.revision;
          if (!draft) {
            draft = { id: draftId, revision: 0, kind: "music", title: String(input.music.title), prompt: input.prompt, references: [], x: 0, y: 0 };
            const updated = await saved.host.call<{ revision: string }>("courseware.mediaCanvas.set", { sessionId, projectId,
              expectedRevision: revision, document: { ...document, revision: document.revision + 1, drafts: [...document.drafts, draft] } });
            revision = updated.revision;
          }
          await bound.check();
          row = await music.prepare({ sessionId, intentId: randomUUID(), draftId, expectedRevision: revision,
            expectedDraftRevision: draft.revision, model: input.model, music: input.music as MusicOptions,
            ...(slot?.type === "music_slot" ? { target: { version: 1, projectId: saved.project.projectId, pageId: page.pageId, actionId: slot.id, source: saved.project.source, prompt: slot.prompt } } : {}) });
        }
        if (row.phase === "prepared") {
          const quote = await music.quote({ sessionId, intentId: row.intentId });
          try { row = await music.submitConfirmed({ sessionId, intentId: row.intentId, quoteId: quote.quoteId }); }
          catch (error) {
            if (!(error instanceof Error) || error.message !== "COURSEWARE_MEDIA_TRANSPORT_FAILED") throw error;
            await bound.check();
            row = await music.status({ sessionId, intentId: row.intentId });
          }
        }
      } else {
        const requested = allRows.find(r => r.intentId === input.intentId);
        row = requested?.operation === "music-export"
          ? allRows.find(r => r.intentId === requested.sourceIntentId && r.operation === "music" && r.draft.id === requested.draft.id)!
          : requested!;
        if (!row || (row.target ? row.target.projectId !== saved.project.projectId || row.target.pageId !== page.pageId || row.target.source.sha256 !== saved.project.source.sha256 : !row.draft.id.startsWith(musicPrefix(saved.project.source.sha256, pageNumber)))) throw new Error("Music job belongs to another saved page");
        if (row.target) {
          musicSlotId = row.target.actionId;
          if (page.actions.some(a => a.type === "audio_clip" && a.id === musicSlotId)) return { saved: true, audioReady: true, pageNumber, intentId: row.intentId };
        }
        const suffix = row.draft.id.slice(musicPrefix(saved.project.source.sha256, pageNumber).length);
        if (!row.target && /^[a-f0-9]{16}-[a-f0-9]{24,32}$/u.test(suffix)) {
          const matches = page.actions.filter(a => ["music_slot", "audio_clip"].includes(String(a.type)) && slotKey(String(a.id)) === suffix.slice(0, 16));
          if (matches.length !== 1) throw new Error("Original music slot changed; retain the generated asset without reassigning it");
          musicSlotId = matches[0].id as string;
          if (matches[0].type === "audio_clip") return { saved: true, audioReady: true, pageNumber, intentId: row.intentId };
        }
        if (input.retryFailed === true) {
          const failed = await (requested!.operation === "music-export" ? music.exportStatus({ sessionId, intentId: requested!.intentId }) : music.status({ sessionId, intentId: requested!.intentId }));
          assertCoursewareRetryable(failed.task);
          const retryId = coursewareRetryIntentId(failed.intentId);
          let retried = allRows.find(value => value.intentId === retryId);
          if (!retried) {
            if (failed.operation === "music-export") {
              retried = await music.exportPrepare({ sessionId, intentId: row.intentId, exportIntentId: retryId,
                candidateId: failed.candidateId, model: failed.model });
            } else {
              const canvas = await saved.host.call<{ revision: string | null }>("courseware.mediaCanvas.get", { sessionId, projectId: `canvas:${sessionId}` });
              retried = await music.prepare({ sessionId, intentId: retryId, draftId: failed.draft.id, expectedRevision: canvas.revision,
                expectedDraftRevision: failed.draft.revision, model: failed.model, music: failed.music, ...(failed.target ? { target: failed.target } : {}) });
            }
          }
          if (failed.operation === "music-export") {
            rows.splice(0, rows.length, ...currentCoursewareAttempts([...allRows, retried]));
          } else {
            row = retried;
            if (row.phase === "prepared") {
              const quote = await music.quote({ sessionId, intentId: row.intentId });
              row = await music.submitConfirmed({ sessionId, intentId: row.intentId, quoteId: quote.quoteId });
            }
          }
        }
        row = await music.status({ sessionId, intentId: row.intentId });
      }
      job = { kind: "music", intentId: row.intentId, pageNumber, sourceSha256: saved.project.source.sha256 };
      for (let attempt = 0; !prepare && input.waitForUpdate === true && attempt < 10 && waiting(row) && row.task?.state !== "ready"; attempt++) {
        await delay(3000); await bound.check(); row = await music.status({ sessionId, intentId: row.intentId });
      }
      const candidate = row.candidates.find(c => c.exportable && c.state === "completed");
      if (row.task?.state === "ready" && row.task.feeState === "settled" && candidate) {
        const exports = rows.filter(r => r.operation === "music-export" && r.sourceIntentId === row.intentId && r.phase !== "rejected");
        let exported = exports.find(r => r.phase !== "prepared");
        if (!exported) {
          const models = await music.models({ sessionId });
          if (!models.export.length) throw new Error("No configured music export model");
          exported = exports.find(r => models.export.some(model => model.model === r.model)) ??
            await music.exportPrepare({ sessionId, intentId: row.intentId, exportIntentId: randomUUID(), candidateId: candidate.candidateId, model: models.export[0].model });
        }
        if (exported.phase === "prepared") {
          const quote = await music.exportQuote({ sessionId, intentId: exported.intentId });
          try { exported = await music.exportSubmitConfirmed({ sessionId, intentId: exported.intentId, quoteId: quote.quoteId }); }
          catch (error) {
            if (!(error instanceof Error) || error.message !== "COURSEWARE_MEDIA_TRANSPORT_FAILED") throw error;
            await bound.check();
            exported = await music.exportStatus({ sessionId, intentId: exported.intentId });
          }
        } else exported = await music.exportStatus({ sessionId, intentId: exported.intentId });
        if (exported.task?.state === "ready" && exported.task.feeState === "settled") {
          await music.exportArchive({ sessionId, intentId: exported.intentId });
          const targetMusic = musicSlotId ? this.music(saved, sessionId, pageNumber, canDispatch, musicSlotId) : music;
          const adopted = await targetMusic.adopt({ sessionId, intentId: exported.intentId, ...bound.input() });
          return { job, saved: true, audioReady: true, teachingRevision: adopted.project.teachingRevision };
        }
        return { job, media: exported, saved: false, waitingFor: waiting(exported) ? "service" : null };
      }
      return { job, media: row, saved: false, waitingFor: waiting(row) ? "service" : null };
    });
  }

  private async tts(saved: SavedCourseware, sessionId: string, input: Record<string, unknown>, prepare: boolean) {
    const pageNumber = Number(input.pageNumber), page = saved.project.pages[pageNumber - 1];
    const bound = savedMediaPage(saved, sessionId, pageNumber);
    const tts = new CoursewareTtsCoordinator(bound, this.auth, this.decodeAudio);
    const params = () => bound.input();
    let row: CoursewareTtsView;
    if (prepare) {
      const speech = page.actions.find(a => a.type === "speech" && a.id === input.actionId);
      if (!id(input.actionId) || !speech || !String(speech.text).trim()) throw new Error("Generate saved narration before TTS");
      const rows = currentCoursewareAttempts(await tts.list(params()));
      const matching = [];
      for (const existing of rows.filter(r => r.actionId === input.actionId && r.model === input.model && r.voice === (input.voice ?? null))) {
        const journal = await saved.host.call<{ intent: { sourceSha256: string; boundSource?: { sha256: string }; request: { input: string } } }>("courseware.tts.get", {
          ...this.scope(sessionId, saved.project.projectId), intentId: existing.intentId,
        });
        if ((journal.intent.boundSource?.sha256 ?? journal.intent.sourceSha256) === saved.project.source.sha256 && journal.intent.request.input === speech.text &&
            (existing.phase !== "prepared" || existing.current)) matching.push(existing);
      }
      row = matching.at(-1) ?? await tts.prepare({ ...params(), actionId: input.actionId, model: input.model, voice: input.voice ?? null });
      if (row.phase === "prepared") {
        const quote = await tts.quote({ ...params(), intentId: row.intentId });
        try { row = await tts.submitConfirmed({ ...params(), intentId: row.intentId, quoteId: quote.quoteId }); }
        catch (error) {
          if (!(error instanceof Error) || error.message !== "COURSEWARE_MEDIA_TRANSPORT_FAILED") throw error;
          await bound.check();
          row = await tts.status({ ...params(), intentId: row.intentId });
        }
      } else row = row.phase === "submission-unknown"
        ? await tts.submit({ ...params(), intentId: row.intentId })
        : await tts.status({ ...params(), intentId: row.intentId });
    } else {
      row = await tts.status({ ...params(), intentId: input.intentId });
      if (input.retryFailed === true) {
        const speech = page.actions.find(a => a.type === "speech" && a.id === row.actionId);
        if (!speech || speech.audioAssetId) throw new Error("TTS retry target is already satisfied or changed");
        assertCoursewareRetryable(row.task);
        const journal = await saved.host.call<{ intent: { sourceSha256: string; boundSource?: { sha256: string }; request: { input: string } } }>("courseware.tts.get", {
          ...this.scope(sessionId, saved.project.projectId), intentId: row.intentId,
        });
        if ((journal.intent.boundSource?.sha256 ?? journal.intent.sourceSha256) !== saved.project.source.sha256 || journal.intent.request.input !== speech.text)
          throw new Error("TTS retry source or speech changed");
        const retryId = coursewareRetryIntentId(row.intentId);
        const existing = (await tts.list(params())).find(value => value.intentId === retryId);
        row = existing ?? await tts.prepare({ ...params(), actionId: row.actionId, model: row.model, voice: row.voice }, retryId);
        if (row.phase === "prepared") {
          const quote = await tts.quote({ ...params(), intentId: row.intentId });
          row = await tts.submitConfirmed({ ...params(), intentId: row.intentId, quoteId: quote.quoteId });
        } else row = await tts.status({ ...params(), intentId: row.intentId });
      }
    }
    const job: Job = { kind: "tts", intentId: row.intentId, pageNumber, sourceSha256: saved.project.source.sha256 };
    for (let attempt = 0; !prepare && input.waitForUpdate === true && attempt < 10 && waiting(row) && row.task?.state !== "ready"; attempt++) {
      await delay(3000); await bound.check();
      row = await tts.status({ ...params(), intentId: row.intentId });
    }
    if (row.task?.state === "ready" && row.task.feeState === "settled") {
      await tts.archive({ ...params(), intentId: row.intentId });
      return { job, media: row, archived: true };
    }
    return { job, media: row, archived: false };
  }

  private async adoptTts(saved: SavedCourseware, sessionId: string, job: Job) {
    const bound = savedMediaPage(saved, sessionId, job.pageNumber);
    const tts = new CoursewareTtsCoordinator(bound, this.auth, this.decodeAudio);
    const adopted = await tts.adopt({ ...bound.input(), intentId: job.intentId });
    saved.project = adopted.project;
    return { job, saved: true, audioReady: true, teachingRevision: adopted.project.teachingRevision };
  }

  private async ttsBatch(saved: SavedCourseware, sessionId: string, input: Record<string, unknown>, prepare: boolean) {
    const pageNumber = Number(input.pageNumber), page = saved.project.pages[pageNumber - 1];
    const key = prepare ? "actionId" : "intentId";
    const ids = input[prepare ? "actionIds" : "intentIds"] as string[];
    if (!Array.isArray(ids) || !ids.length || ids.length > 100 || new Set(ids).size !== ids.length ||
        input[key] !== undefined || ids.some(value => !id(value) || prepare && !page.actions.some(a =>
          a.id === value && a.type === "speech" && typeof a.text === "string" && a.text.trim())))
      throw new Error("Invalid saved TTS batch");
    const results: Array<{ actionId?: string; intentId?: string; saved: boolean; job?: Job; media?: CoursewareTtsView; waitingFor?: string | null }> = [];
    const failures: Array<{ actionId?: string; intentId?: string; error: string }> = [];
    const missing = ids.filter(value => {
      if (!prepare || !page.actions.some(a => a.id === value && a.audioAssetId)) return true;
      results.push({ actionId: value, saved: true }); return false;
    });
    for (let offset = 0; offset < missing.length; offset += COURSEWARE_GENERATION_LIMITS.tts) {
      await saved.check();
      const wave = missing.slice(offset, offset + COURSEWARE_GENERATION_LIMITS.tts);
      const settled = await Promise.allSettled(wave.map(value => this.tts(saved, sessionId, { ...input, [key]: value }, prepare)));
      // All remote work and decoding finish before revision-checked adoption advances the shared project.
      for (const [index, result] of settled.entries()) {
        const identity = { [key]: wave[index] };
        try {
          if (result.status === "rejected") throw result.reason;
          const value = result.value;
          if (value.archived) results.push({ ...identity, ...await this.adoptTts(saved, sessionId, value.job) });
          else results.push({ ...identity, job: value.job, media: value.media, saved: false, waitingFor: waiting(value.media) ? "service" : null });
        } catch (error) { failures.push({ ...identity, error: error instanceof Error ? error.message : String(error) }); }
      }
    }
    await saved.check();
    return { sourceSha256: saved.project.source.sha256, pageNumber, results, failures,
      jobs: results.filter(r => !r.saved && r.job).map(r => r.job!),
      saved: failures.length === 0 && results.every(r => r.saved),
      waitingFor: failures.length === 0 && results.some(r => !r.saved) && results.every(r => r.saved || r.waitingFor === "service") ? "service" : null,
      teachingRevision: saved.project.teachingRevision };
  }

  private music(saved: SavedCourseware, sessionId: string, page: number, canDispatch: () => boolean, slotId?: string) {
    return new CoursewareCanvasMusic(() => saved.host, () => sessionId, () => !canDispatch(), this.auth,
      { teaching: savedMediaPage(saved, sessionId, page, slotId), decodeAudio: this.decodeAudio });
  }
}
