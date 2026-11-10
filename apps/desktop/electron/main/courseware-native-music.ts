import { createHash, randomUUID } from "node:crypto";
import { CoursewareCanvasMusic } from "./courseware-canvas-music";
import { musicRequestHash, type MusicOptions } from "./courseware-music-request";
import type { CoursewareTeachingView, MediaCanvasDocument } from "@pi-desktop/shared";
import type { DesktopAuthSession } from "./auth-session";
type Host = { call<T>(method: string, params: unknown): Promise<T> };
type Route = (operation: string, args: Record<string, unknown>, page: number) => Promise<{ value: unknown } | undefined>;

/** Reuse the existing private music generation/export journal; adopt bytes through the native document. */
export class CoursewareNativeMusic {
  constructor(private auth: Pick<DesktopAuthSession, "getCoursewarePrincipal" | "coursewareMedia">, private host: () => Host | null,
    private session: () => string | null, private route: Route, private decode: (bytes: Buffer, mime: "audio/mpeg") => Promise<number>) {}
  async models() {
    const sessionId = this.session();
    if (!sessionId) throw new Error("Native music owner unavailable");
    return new CoursewareCanvasMusic(this.host, this.session, () => false, this.auth).models({ sessionId });
  }
  async jobs(pageNumber: number, view: CoursewareTeachingView) {
    const sessionId = this.session();
    if (!sessionId) throw new Error("Native music owner unavailable");
    const page = view.project.pages[pageNumber - 1];
    const prefix = "native-" + createHash("sha256").update(view.project.projectId + ":" + page.pageId).digest("hex").slice(0, 32) + "-";
    const music = new CoursewareCanvasMusic(this.host, this.session, () => false, this.auth);
    const rows = await music.list({ sessionId });
    return rows.filter(r => r.operation === "music" && r.draft.id.startsWith(prefix) && r.phase !== "rejected" &&
      !page.actions.some(a => a.id === r.draft.id.slice(prefix.length, -21) && a.type === "audio_clip" && a.audioAssetId))
      .map(r => ({ kind: "music", intentId: r.intentId, actionId: r.draft.id.slice(prefix.length, -21), pageNumber, sourceSha256: view.project.source.sha256 }));
  }

  async execute(input: Record<string, unknown>, prepare: boolean, pageNumber: number, view: CoursewareTeachingView, canDispatch: () => boolean) {
    const host = this.host(), sessionId = this.session(), principal = this.auth.getCoursewarePrincipal();
    if (!host || !sessionId) throw new Error("Native music owner unavailable");
    const check = async () => {
      principal.assertCurrent();
      if (!canDispatch() || this.host() !== host || this.session() !== sessionId ||
          JSON.stringify((await this.route("open", {}, pageNumber))?.value) !== JSON.stringify(view)) throw new Error("Native music page changed");
    };
    await check();
    const page = view.project.pages[pageNumber - 1];
    if (!page || page.locked) throw new Error("Native music page locked");
    const prefix = "native-" + createHash("sha256").update(view.project.projectId + ":" + page.pageId).digest("hex").slice(0, 32) + "-";
    const music = new CoursewareCanvasMusic(this.host, this.session, () => !canDispatch(), this.auth, { decodeAudio: this.decode,
      teaching: { musicAdoptionContext: async args => {
        await check();
        if (args.viewId !== view.viewId || args.expectedTeachingRevision !== view.project.teachingRevision) throw new Error("Native music revision changed");
        return { host, sessionId, projectId: view.project.projectId, pageId: page.pageId, project: view.project,
          expectedSourceRevision: view.project.source.revision, expectedTeachingRevision: view.project.teachingRevision, assertCurrent: check,
          adoptAudio: async () => { throw new Error("Music adoption expected"); },
          adoptMusic: async asset => {
            await check(); if (!asset.bytes || !asset.sha256) throw new Error("Verified music bytes required");
            const slotId = row.draft.id.slice(prefix.length, -21);
            if (input.actionId !== undefined && input.actionId !== slotId) throw new Error("Native music task belongs to another action");
            const slot = page.actions.find(action => action.id === slotId);
            if (slot?.type === "music_slot" && slot.prompt !== row.draft.prompt) throw new Error("Native music prompt changed");
            const result = await this.route("adopt-audio", { viewId: view.viewId, expectedTeachingRevision: view.project.teachingRevision,
              command: { kind: "music", actionId: slotId, assetId: asset.assetId, sha256: asset.sha256, mimeType: "audio/mpeg", durationMs: asset.durationMs,
                bytes: Uint8Array.from(asset.bytes).buffer } }, pageNumber);
            return result!.value as CoursewareTeachingView;
          } };
      } } });
    const rows = await music.list({ sessionId }); await check();
    let row: Awaited<ReturnType<CoursewareCanvasMusic["prepare"]>>;
    if (prepare) {
      if (typeof input.model !== "string" || typeof input.prompt !== "string" || !input.prompt.trim() || input.prompt.length > 4000 ||
          !input.music || typeof input.music !== "object" || Array.isArray(input.music)) throw new Error("Invalid native music request");
      const slot = input.actionId === undefined ? undefined : page.actions.find(a => a.id === input.actionId && ["music_slot", "audio_clip"].includes(String(a.type)));
      if (input.actionId !== undefined && !slot) throw new Error("Native music slot changed");
      const hash = musicRequestHash({ kind: "music", model: input.model, input: input.prompt, music: input.music as MusicOptions });
      const actionId = slot?.id as string | undefined;
      const draftId = prefix + (actionId ?? "music-" + hash.slice(0, 20)) + "." + hash.slice(0, 20);
      row = rows.find(r => r.operation === "music" && r.draft.id === draftId && r.phase !== "rejected")!;
      if (!row) {
        const projectId = "canvas:" + sessionId;
        const canvas = await host.call<{ revision: string | null; document: MediaCanvasDocument | null }>("courseware.mediaCanvas.get", { sessionId, projectId });
        const document = canvas.document ?? { version: 1, projectId, revision: 0, viewport: { x: 0, y: 0, zoom: 1 }, drafts: [] };
        const draft = { id: draftId, revision: 0, kind: "music" as const, title: String(Reflect.get(input.music, "title")), prompt: input.prompt, references: [], x: 0, y: 0 };
        const updated = document.drafts.some(d => d.id === draftId) ? canvas : await host.call<{ revision: string }>("courseware.mediaCanvas.set", {
          sessionId, projectId, expectedRevision: canvas.revision, document: { ...document, revision: document.revision + 1, drafts: [...document.drafts, draft] } });
        await check();
        row = await music.prepare({ sessionId, intentId: randomUUID(), draftId, expectedRevision: updated.revision,
          expectedDraftRevision: document.drafts.find(d => d.id === draftId)?.revision ?? 0, model: input.model, music: input.music });
      }
      if (row.phase === "prepared") { const quote = await music.quote({ sessionId, intentId: row.intentId }); await check(); row = await music.submitConfirmed({ sessionId, intentId: row.intentId, quoteId: quote.quoteId }); }
    } else {
      const selected = rows.find(r => r.intentId === input.intentId);
      row = (selected?.operation === "music-export" ? rows.find(r => r.intentId === selected.sourceIntentId) : selected)!;
      if (!row || !row.draft.id.startsWith(prefix)) throw new Error("Native music task belongs to another page");
      row = await music.status({ sessionId, intentId: row.intentId });
    }
    await check();
    const job = { kind: "music", intentId: row.intentId, pageNumber, sourceSha256: view.project.source.sha256 };
    const candidate = row.candidates.find(c => c.exportable && c.state === "completed");
    if (row.task?.state !== "ready" || row.task.feeState !== "settled" || !candidate) return { job, saved: false, waitingFor: "service", media: row };
    let exported = rows.find(r => r.operation === "music-export" && r.sourceIntentId === row.intentId && r.phase !== "rejected");
    if (!exported) {
      const models = await music.models({ sessionId }); await check();
      if (!models.export.length) throw new Error("No music export model configured");
      exported = await music.exportPrepare({ sessionId, intentId: row.intentId, exportIntentId: randomUUID(), candidateId: candidate.candidateId, model: models.export[0].model });
    }
    if (exported.phase === "prepared") {
      const quote = await music.exportQuote({ sessionId, intentId: exported.intentId }); await check();
      exported = await music.exportSubmitConfirmed({ sessionId, intentId: exported.intentId, quoteId: quote.quoteId });
    } else exported = await music.exportStatus({ sessionId, intentId: exported.intentId });
    await check();
    if (exported.task?.state !== "ready" || exported.task.feeState !== "settled") return { job, saved: false, waitingFor: "service", media: exported };
    await music.exportArchive({ sessionId, intentId: exported.intentId }); await check();
    await music.adopt({ sessionId, intentId: exported.intentId, viewId: view.viewId, expectedTeachingRevision: view.project.teachingRevision });
    return { job, applied: true, saved: false, audioReady: true };
  }
}
