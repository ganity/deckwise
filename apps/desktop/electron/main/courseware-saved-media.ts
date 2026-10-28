import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import type { CoursewareCanvasMusicView, CoursewareTtsView, MediaCanvasDocument } from "@pi-desktop/shared";
import type { DesktopAuthSession } from "./auth-session";
import type { CoursewareSavedNarration, SavedCourseware } from "./courseware-saved-narration";
import { CoursewareTtsCoordinator } from "./courseware-tts";
import { CoursewareCanvasMusic } from "./courseware-canvas-music";
import { savedMediaPage } from "./courseware-saved-media-page";
import { musicRequestHash, type MusicOptions } from "./courseware-music-request";
import { savedVideo, type SavedVideoIntent } from "./courseware-saved-video";

type Auth = Pick<DesktopAuthSession, "getCoursewarePrincipal" | "coursewareMedia">;
type Job = { kind: "tts" | "music" | "video"; intentId: string; pageNumber: number; sourceSha256: string };
const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const id = (v: unknown): v is string => typeof v === "string" && /^[\w.-]{1,128}$/u.test(v) && ![".", ".."].includes(v);
const musicPrefix = (sha: string, page: number) => `auto-music-${sha}-p${page}-`;
const waiting = (v: CoursewareTtsView | CoursewareCanvasMusicView) => !["prepared", "rejected"].includes(v.phase) &&
  !["failed", "cancelled", "archive_failed"].includes(v.task?.state ?? "");

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
        for (const [index, page] of project.pages.entries()) for (const action of page.actions) {
          if (action.type !== "speech" || action.audioAssetId) continue;
          for (const intent of intents.filter(i => i.selection.pageId === page.pageId && i.selection.actionId === action.id)) {
            const journal = await host.call<{ intent: { sourceSha256: string; request: { input: string } } }>("courseware.tts.get", { ...scope, intentId: intent.selection.intentId });
            if (journal.intent.sourceSha256 === project.source.sha256 && journal.intent.request.input === action.text && !["prepared", "rejected"].includes(intent.phase))
              jobs.push({ kind: "tts", intentId: intent.selection.intentId, pageNumber: index + 1, sourceSha256: project.source.sha256 });
          }
        }
        const music = this.music(saved, sessionId, 1, canDispatch);
        const tracks = await music.list({ sessionId });
        for (const [index, page] of project.pages.entries()) {
          const matching = tracks.filter(t => t.draft.id.startsWith(musicPrefix(project.source.sha256, index + 1)));
          for (const track of matching.filter(t => t.operation === "music" && !["prepared", "rejected"].includes(t.phase))) {
            const exported = matching.find(t => t.operation === "music-export" && t.sourceIntentId === track.intentId);
            if (exported?.asset && page.actions.some(a => a.type === "audio_clip" && a.audioAssetId === `music-${exported.asset!.sha256}`)) continue;
            jobs.push({ kind: "music", intentId: track.intentId, pageNumber: index + 1, sourceSha256: project.source.sha256 });
          }
        }
        if (project.pages.some(page => page.actions.some(a => a.type === "video_slot" || a.type === "video_clip"))) {
          const videos = await host.call<{ intents: SavedVideoIntent[] }>("courseware.video.list", scope);
          for (const intent of videos.intents) {
            const index = project.pages.findIndex(page => page.pageId === intent.pageId && page.actions.some(a => a.id === intent.slotId && a.type === "video_slot" && a.prompt === intent.prompt));
            if (index >= 0 && intent.source.sha256 === project.source.sha256 && intent.phase !== "prepared" && intent.phase !== "adopted")
              jobs.push({ kind: "video", intentId: intent.intentId, pageNumber: index + 1, sourceSha256: project.source.sha256 });
          }
        }
        const models = input.kind === "video" ? await this.auth.coursewareMedia.video.models() : input.kind === "tts" ? await this.auth.coursewareMedia.getTtsModels()
          : input.kind === "music" ? await music.models({ sessionId }) : undefined;
        await saved.check(); principal.assertCurrent();
        return { ...(record(narration) ? narration : {}), jobs, videoReady: !project.pages.some(page => page.actions.some(a => a.type === "video_slot")), ...(models ? { models } : {}) };
      });
    }
    if (!["courseware_media_prepare", "courseware_media_refresh"].includes(name) ||
        !["tts", "music", "video"].includes(String(input.kind)) || !Number.isInteger(input.pageNumber) || Number(input.pageNumber) < 1 ||
        typeof input.sourceSha256 !== "string" || !/^[a-f0-9]{64}$/u.test(input.sourceSha256)) throw new Error("Invalid saved media request");
    const prepare = name === "courseware_media_prepare";
    const allowed = prepare ? ["kind", "pageNumber", "sourceSha256", "model", ...(input.kind === "tts" ? ["actionId", "voice"] : input.kind === "video" ? ["actionId"] : ["prompt", "music"])]
      : ["kind", "pageNumber", "sourceSha256", "intentId", "waitForUpdate"];
    if (Object.keys(input).some(k => !allowed.includes(k)) || prepare && !id(input.model) || !prepare && !id(input.intentId) ||
        input.waitForUpdate !== undefined && typeof input.waitForUpdate !== "boolean") throw new Error("Invalid saved media fields");
    return this.saved.withSaved(sessionId, canDispatch, async saved => {
      if (saved.project.source.sha256 !== input.sourceSha256) throw new Error("Saved media source changed");
      if (input.kind === "video") {
        if (!this.decodeVideo) throw new Error("Video decoder unavailable");
        return savedVideo(input, saved, sessionId, this.auth, this.decodeVideo);
      }
      const pageNumber = Number(input.pageNumber), page = saved.project.pages[pageNumber - 1];
      if (!page || page.locked) throw new Error("Saved media page missing or locked");
      const bound = savedMediaPage(saved, sessionId, pageNumber);
      const tts = new CoursewareTtsCoordinator(bound, this.auth, this.decodeAudio);
      let job: Job;
      if (input.kind === "tts") {
        const params = () => bound.input();
        let row: CoursewareTtsView;
        if (prepare) {
          const speech = page.actions.find(a => a.type === "speech" && a.id === input.actionId);
          if (!id(input.actionId) || !speech || !String(speech.text).trim()) throw new Error("Generate saved narration before TTS");
          if (speech.audioAssetId) return { saved: true, audioReady: true, pageNumber, actionId: input.actionId };
          const rows = await tts.list(params());
          const matching = [];
          for (const existing of rows.filter(r => r.actionId === input.actionId && r.model === input.model && r.voice === (input.voice ?? null))) {
            const journal = await saved.host.call<{ intent: { sourceSha256: string; request: { input: string } } }>("courseware.tts.get", {
              ...this.scope(sessionId, saved.project.projectId), intentId: existing.intentId,
            });
            if (journal.intent.sourceSha256 === saved.project.source.sha256 && journal.intent.request.input === speech.text &&
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
          }
        } else row = await tts.status({ ...params(), intentId: input.intentId });
        job = { kind: "tts", intentId: row.intentId, pageNumber, sourceSha256: saved.project.source.sha256 };
        for (let attempt = 0; !prepare && input.waitForUpdate === true && attempt < 10 && waiting(row) && row.task?.state !== "ready"; attempt++) {
          await delay(3000); await bound.check();
          row = await tts.status({ ...params(), intentId: row.intentId });
        }
        if (row.task?.state === "ready" && row.task.feeState === "settled") {
          await tts.archive({ ...params(), intentId: row.intentId });
          const adopted = await tts.adopt({ ...params(), intentId: row.intentId });
          return { job, saved: true, audioReady: true, teachingRevision: adopted.project.teachingRevision };
        }
        return { job, media: row, saved: false, waitingFor: waiting(row) ? "service" : null };
      }
      const music = this.music(saved, sessionId, pageNumber, canDispatch);
      const rows = await music.list({ sessionId });
      let row: CoursewareCanvasMusicView;
      if (prepare) {
        if (typeof input.prompt !== "string" || input.prompt.length > 4000 || !record(input.music)) throw new Error("Invalid music prompt/options");
        const requestHash = musicRequestHash({ kind: "music", model: input.model as string,
          input: input.prompt, music: input.music as MusicOptions });
        const draftId = musicPrefix(saved.project.source.sha256, pageNumber) + requestHash.slice(0, 32);
        row = rows.find(r => r.draft.id === draftId && r.operation === "music")!;
        const exported = row && rows.find(r => r.operation === "music-export" && r.sourceIntentId === row.intentId);
        if (exported?.asset && page.actions.some(a => a.type === "audio_clip" && a.audioAssetId === `music-${exported.asset!.sha256}`))
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
            expectedDraftRevision: draft.revision, model: input.model, music: input.music as MusicOptions });
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
        row = rows.find(r => r.intentId === input.intentId && r.operation === "music")!;
        if (!row || !row.draft.id.startsWith(musicPrefix(saved.project.source.sha256, pageNumber))) throw new Error("Music job belongs to another saved page");
        row = await music.status({ sessionId, intentId: row.intentId });
      }
      job = { kind: "music", intentId: row.intentId, pageNumber, sourceSha256: saved.project.source.sha256 };
      for (let attempt = 0; !prepare && input.waitForUpdate === true && attempt < 10 && waiting(row) && row.task?.state !== "ready"; attempt++) {
        await delay(3000); await bound.check(); row = await music.status({ sessionId, intentId: row.intentId });
      }
      const candidate = row.candidates.find(c => c.exportable && c.state === "completed");
      if (row.task?.state === "ready" && row.task.feeState === "settled" && candidate) {
        let exported = rows.find(r => r.operation === "music-export" && r.sourceIntentId === row.intentId);
        if (!exported) {
          const models = await music.models({ sessionId });
          if (!models.export.length) throw new Error("No configured music export model");
          exported = await music.exportPrepare({ sessionId, intentId: row.intentId, exportIntentId: randomUUID(), candidateId: candidate.candidateId, model: models.export[0].model });
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
          const adopted = await music.adopt({ sessionId, intentId: exported.intentId, ...bound.input() });
          return { job, saved: true, audioReady: true, teachingRevision: adopted.project.teachingRevision };
        }
        return { job, media: exported, saved: false, waitingFor: waiting(exported) ? "service" : null };
      }
      return { job, media: row, saved: false, waitingFor: waiting(row) ? "service" : null };
    });
  }

  private music(saved: SavedCourseware, sessionId: string, page: number, canDispatch: () => boolean) {
    return new CoursewareCanvasMusic(() => saved.host, () => sessionId, () => !canDispatch(), this.auth,
      { teaching: savedMediaPage(saved, sessionId, page), decodeAudio: this.decodeAudio });
  }
}
