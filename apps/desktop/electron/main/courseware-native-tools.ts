import { createHash } from "node:crypto";
import { inspectCoursewareTeaching, isCoursewareSceneTeaching, isCoursewareProject, type CoursewareTeachingView } from "@pi-desktop/shared";
import type { CoursewareCandidateCoordinator } from "./courseware-candidates";
import type { CoursewareNativeAudio } from "./courseware-native-audio";
import type { CoursewareTeachingCoordinator } from "./courseware-teaching";

type Route = (operation: string, args: Record<string, unknown>, page: number) => Promise<{ value: unknown } | undefined>;
/** Chat tools share the exact open-document commands used by the teaching sidebar. */
export class CoursewareNativeTools {
  constructor(private teaching: CoursewareTeachingCoordinator, private candidates: CoursewareCandidateCoordinator,
    private audio: CoursewareNativeAudio, private route: Route, private session: () => string | null, private video?: import("./courseware-native-video").CoursewareNativeVideo,
    private music?: import("./courseware-native-music").CoursewareNativeMusic, private ensureOpen?: (sessionId: string, canDispatch: () => boolean) => Promise<void>,
    private ensureSaved?: (sessionId: string, canDispatch: () => boolean) => Promise<void>) {}

  async execute(sessionId: string, name: string, args: unknown, canDispatch: () => boolean): Promise<{ value: unknown } | undefined> {
    const result = await this.executeUnsaved(sessionId, name, args, canDispatch);
    const value = result?.value;
    if (this.ensureSaved && value && typeof value === "object" && !Array.isArray(value) &&
        (Reflect.get(value, "applied") === true || Array.isArray(Reflect.get(value, "pages")) &&
          Reflect.get(value, "pages").some((page: unknown) => page && typeof page === "object" && Reflect.get(page, "applied") === true))) {
      if (sessionId !== this.session() || !canDispatch()) throw new Error("Native teaching owner changed before save");
      await this.ensureSaved(sessionId, canDispatch);
      if (sessionId !== this.session() || !canDispatch()) throw new Error("Native teaching owner changed during save");
      return { value: { ...value, saved: true } };
    }
    return result;
  }

  private async executeUnsaved(sessionId: string, name: string, args: unknown, canDispatch: () => boolean): Promise<{ value: unknown } | undefined> {
    if (!/^(courseware_narration_|courseware_media_)/.test(name)) return;
    let opened = await this.teaching.native("open");
    if (!opened && this.ensureOpen) { await this.ensureOpen(sessionId, canDispatch); opened = await this.teaching.native("open"); }
    if (!opened) return;
    const check = () => { if (sessionId !== this.session() || !canDispatch()) throw new Error("Native teaching owner changed"); };
    check();
    if (!args || typeof args !== "object" || Array.isArray(args)) throw new Error("Invalid native tool arguments");
    const input = args as Record<string, unknown>, view = opened.value as CoursewareTeachingView, project = view.project;
    if (!isCoursewareProject(project)) throw new Error("Invalid native teaching view");
    if (name === "courseware_media_assessments") return { value: await this.assessments(input, view, check) };
    const numbers = input.pageNumbers ?? project.pages.map((_, index) => index + 1);
    if (!Array.isArray(numbers) || !numbers.length || numbers.length > 100 || new Set(numbers).size !== numbers.length ||
        numbers.some(n => !Number.isInteger(n) || n < 1 || n > project.pages.length)) throw new Error("Invalid native page numbers");
    if (name === "courseware_narration_context" || name === "courseware_media_context") {
      const pages = numbers.map(pageNumber => {
        const page = project.pages[pageNumber - 1], speeches = page.actions.filter(a => a.type === "speech");
        const audioReady = speeches.length > 0 && speeches.every(a => typeof a.audioAssetId === "string");
        return { ...page, pageNumber, hasNarration: !!speeches.length, narrationReady: !!speeches.length, audioReady,
          teachingReady: audioReady && !page.actions.some(a => a.attention !== undefined || ["music_slot", "video_slot"].includes(String(a.type))),
          speeches: speeches.map(a => ({ actionId: a.id, text: a.text, audioReady: typeof a.audioAssetId === "string", audioAssetId: a.audioAssetId })) };
      });
      const teachingByPage = new Map((view.teachingRequirements ?? []).map(({ pageId, teaching }) => {
        if (!isCoursewareSceneTeaching(teaching)) throw new Error("Invalid native teaching requirement");
        return [pageId, teaching] as const;
      }));
      const assessments = new Set([...teachingByPage].filter(([, t]) => t.pageType !== "slide").map(([id]) => id));
      const quality = inspectCoursewareTeaching(project, teachingByPage, assessments, true);
      const requiredIssues: Array<{ code: string; pageNumber: number; pageId: string; actionId?: string; repair: string; repairable: boolean }> = quality.issues.filter(i => i.code !== "FOCUS_MISSING");
      for (const [index, page] of project.pages.entries()) for (const action of page.actions) if (action.attention !== undefined)
        requiredIssues.push({ code: "ATTENTION_PENDING", pageNumber: index + 1, pageId: page.pageId, actionId: String(action.id), repair: "tts", repairable: !page.locked });
      const actions = project.pages.flatMap(p => p.actions), speeches = actions.filter(a => a.type === "speech"), audioCount = speeches.filter(a => typeof a.audioAssetId === "string").length;
      const counts = { pages: project.pages.length, speeches: speeches.length, audioReady: audioCount, audioMissing: speeches.length - audioCount,
        musicClips: actions.filter(a => a.type === "audio_clip").length, musicPending: actions.filter(a => a.type === "music_slot").length,
        questions: actions.filter(a => a.type === "interaction_checkpoint" && a.checkpointKind === "chapter_summary").length };
      const jobs = [];
      if (name === "courseware_media_context") for (const page of pages) {
        const current = (await this.route("open", {}, page.pageNumber))!.value as CoursewareTeachingView;
        const intents = await this.audio.execute("tts:list", { viewId: current.viewId, expectedTeachingRevision: current.project.teachingRevision }, page.pageNumber, current) as Array<{ intentId: string; current: boolean; audioReady: boolean }>;
        check();
        if (this.video) { jobs.push(...await this.video.jobs(page.pageNumber, current)); check(); }
        if (this.music) { jobs.push(...await this.music.jobs(page.pageNumber, current)); check(); }
        jobs.push(...intents.filter(i => i.current && !i.audioReady).map(i => ({ kind: "tts", intentId: i.intentId, pageNumber: page.pageNumber, sourceSha256: project.source.sha256 })));
      }
      const models = name === "courseware_media_context" && input.kind === "tts"
        ? await this.audio.execute("tts:models", { viewId: view.viewId, expectedTeachingRevision: project.teachingRevision }, view.pageNumber, view)
        : name === "courseware_media_context" && input.kind === "music" ? await this.music?.models()
        : name === "courseware_media_context" && input.kind === "video" ? await this.video?.models() : undefined;
      check();
      const assessmentMedia = name === "courseware_media_context" ? await this.assessments({ mode: "context" }, view, check) as { ready: boolean } : undefined;
      return { value: { nativeTeaching: true, ...(assessmentMedia ? { assessmentMedia } : {}), projectId: project.projectId, sourceRevision: project.source.revision, sourceSha256: project.source.sha256,
        teachingRevision: project.teachingRevision, educationContext: project.educationContext,
        quality, completion: { counts, ready: !requiredIssues.length && (!assessmentMedia || assessmentMedia.ready), issues: requiredIssues, sourceSha256: project.source.sha256, teachingRevision: project.teachingRevision },
        ...(models ? { models } : {}), videoReady: !pages.some(p => p.actions.some(a => a.type === "video_slot")), pageCount: project.pages.length, pages, jobs,
        narrationReady: pages.every(p => p.narrationReady), audioReady: pages.every(p => p.audioReady) && (!assessmentMedia || assessmentMedia.ready), teachingReady: pages.every(p => p.teachingReady) && (!assessmentMedia || assessmentMedia.ready) } };
    }
    if (input.sourceSha256 !== project.source.sha256) throw new Error("Native source changed; read teaching context again");
    if (name === "courseware_narration_propose") {
      if (typeof input.instruction !== "string" || !input.instruction.trim() || input.instruction.length > 8000) throw new Error("Invalid narration instruction");
      const results = [];
      for (const pageNumber of numbers) {
        check();
        const current = (await this.route("open", {}, pageNumber))!.value as CoursewareTeachingView;
        if (current.teaching?.pageType && current.teaching.pageType !== "slide") continue;
        results.push(await this.candidates.proposeNativeNarration(sessionId, pageNumber, input.instruction, canDispatch, input.repairRequiredTeaching === true));
      }
      return { value: { applied: true, saved: false, pages: results } };
    }
    if (!["courseware_media_prepare", "courseware_media_refresh"].includes(name) || !["tts", "video", "music"].includes(String(input.kind)) ||
        !Number.isInteger(input.pageNumber) || Number(input.pageNumber) < 1 || Number(input.pageNumber) > project.pages.length) throw new Error("Unsupported native media command");
    const pageNumber = Number(input.pageNumber), current = (await this.route("open", {}, pageNumber))!.value as CoursewareTeachingView;
    if (input.kind === "music") {
      if (!this.music) throw new Error("Native music service unavailable");
      return { value: await this.music.execute(input, name === "courseware_media_prepare", pageNumber, current, canDispatch) };
    }
    if (input.kind === "video") {
      if (!this.video) throw new Error("Native video service unavailable");
      return { value: await this.video.execute(input, name === "courseware_media_prepare", pageNumber, current, canDispatch) };
    }
    const scope = () => ({ viewId: current.viewId, expectedTeachingRevision: current.project.teachingRevision });
    if (name === "courseware_media_prepare") {
      const ids = input.actionIds ?? [input.actionId];
      if (!Array.isArray(ids) || !ids.length || ids.length > 100 || new Set(ids).size !== ids.length || ids.some(id => typeof id !== "string")) throw new Error("Invalid native speech actions");
      const jobs = [];
      for (const actionId of ids) {
        check();
        const intent = await this.audio.execute("tts:prepare", { ...scope(), actionId, model: input.model, voice: input.voice ?? null }, pageNumber, current) as { intentId: string };
        check();
        const quote = await this.audio.execute("tts:quote", { ...scope(), intentId: intent.intentId }, pageNumber, current) as { quoteId: string };
        check();
        await this.audio.execute("tts:submit", { ...scope(), intentId: intent.intentId, quoteId: quote.quoteId }, pageNumber, current);
        jobs.push({ kind: "tts", intentId: intent.intentId, pageNumber, sourceSha256: project.source.sha256 });
      }
      return { value: { jobs, job: jobs.length === 1 ? jobs[0] : undefined, saved: false, waitingFor: "service" } };
    }
    const ids = input.intentIds ?? [input.intentId];
    if (!Array.isArray(ids) || !ids.length || ids.length > 100 || new Set(ids).size !== ids.length || ids.some(id => typeof id !== "string")) throw new Error("Invalid native speech tasks");
    const results = [];
    for (const intentId of ids) {
      check();
      const latest = (await this.route("open", {}, pageNumber))!.value as CoursewareTeachingView;
      const args = { viewId: latest.viewId, expectedTeachingRevision: latest.project.teachingRevision, intentId };
      const status = await this.audio.execute("tts:status", args, pageNumber, latest) as { task: { state: string } | null };
      check();
      if (status.task?.state === "ready") { await this.audio.execute("tts:adopt", args, pageNumber, latest); results.push({ intentId, applied: true, audioReady: true }); }
      else results.push({ intentId, applied: false, audioReady: false, state: status.task?.state ?? "submission_unknown" });
    }
    return { value: { pages: results, audioReady: results.every(r => r.audioReady), saved: false } };
  }

  private async assessments(input: Record<string, unknown>, view: CoursewareTeachingView, check: () => void) {
    const project = view.project;
    const questionSpeech = (checkpoint: Record<string, unknown>) => "assessment-speech-" + createHash("sha256").update(String(checkpoint.id)).digest("hex").slice(0, 32);
    const readings = project.pages.flatMap((page, index) => page.actions.flatMap((action, actionIndex) => {
      if (action.type !== "interaction_checkpoint" || action.checkpointKind !== "chapter_summary" || typeof action.question !== "string" || !action.question.trim()) return [];
      const preceding = page.actions[actionIndex - 1];
      const response = action.response as { kind?: string; options?: unknown[] } | undefined;
      const fullReading = [action.question, ...(response?.options ?? []).map((option, index) => `${response?.kind === "judge" ? ["T", "F"][index] : String.fromCharCode(65 + index)}. ${option}`)].join("\n");
      const matches = (speech: typeof preceding | undefined) => speech?.type === "speech" &&
        (speech.text === action.question || speech.text === fullReading);
      const speech = page.actions.find(a => a.id === questionSpeech(action)) ??
        (matches(preceding) ? preceding : undefined);
      return [{ pageNumber: index + 1, sceneId: page.pageId, actionId: speech?.id ?? questionSpeech(action),
        checkpoint: action, speech, audioReady: matches(speech) && typeof speech?.audioAssetId === "string" }];
    }));
    if (input.mode === "context") {
      if (Object.keys(input).some(key => !["mode", "kind"].includes(key)) || input.kind !== undefined && !["tts", "image"].includes(String(input.kind)))
        throw new Error("Invalid native assessment context");
      // Native checkpoints use text options. They have no canonical classroom/image mirror.
      const targets = input.kind === "image" ? [] : readings.filter(r => !r.audioReady).map(({ sceneId, actionId, pageNumber }) => ({ kind: "tts", sceneId, actionId, pageNumber }));
      const models = input.kind === "tts" ? await this.audio.execute("tts:models", { viewId: view.viewId, expectedTeachingRevision: project.teachingRevision }, view.pageNumber, view) : undefined;
      check();
      return { projectId: project.projectId, expectedRevision: project.teachingRevision, expectedSourceRevision: project.source.revision,
        ready: !targets.length, targets, ...(models ? { models } : {}) };
    }
    if (!["prepare", "refresh"].includes(String(input.mode)) || input.kind !== "tts" ||
        Object.keys(input).some(key => !["mode", "kind", "projectId", "expectedRevision", "expectedSourceRevision", "sceneId", "actionId", "model", "voice"].includes(key)) ||
        input.projectId !== project.projectId || input.expectedRevision !== project.teachingRevision || input.expectedSourceRevision !== project.source.revision)
      throw new Error("Native assessment changed; read its context again");
    const reading = readings.find(r => r.sceneId === input.sceneId && r.actionId === input.actionId);
    if (!reading) throw new Error("Native assessment target unavailable");
    if (reading.audioReady) return { applied: true, audioReady: true, saved: false };
    let current = (await this.route("open", {}, reading.pageNumber))!.value as CoursewareTeachingView;
    if (input.mode === "prepare" && !reading.speech) {
      const page = current.project.pages[reading.pageNumber - 1];
      const speech = { id: reading.actionId, type: "speech", text: reading.checkpoint.question };
      const actions = page.actions.flatMap(action => action.id === reading.speech?.id ? [speech] :
        action.id === reading.checkpoint.id && !reading.speech ? [speech, action] : [action]);
      check();
      current = (await this.route("write", { viewId: current.viewId, expectedTeachingRevision: current.project.teachingRevision, actions }, reading.pageNumber))!.value as CoursewareTeachingView;
      check();
    }
    const scope = { viewId: current.viewId, expectedTeachingRevision: current.project.teachingRevision };
    let intents = await this.audio.execute("tts:list", scope, reading.pageNumber, current) as Array<{ intentId: string; actionId: string; current: boolean; model: string; voice: string | null }>;
    check();
    let intent = intents.findLast(i => i.actionId === reading.actionId && i.current &&
      (input.mode === "refresh" || i.model === input.model && i.voice === (input.voice ?? null)));
    if (input.mode === "prepare") {
      if (!intent) intent = await this.audio.execute("tts:prepare", { ...scope, actionId: reading.actionId, model: input.model, voice: input.voice ?? null }, reading.pageNumber, current) as typeof intent;
      check();
      const status = await this.audio.execute("tts:status", { ...scope, intentId: intent!.intentId }, reading.pageNumber, current) as { phase: string };
      check();
      if (status.phase === "prepared") {
        const quote = await this.audio.execute("tts:quote", { ...scope, intentId: intent!.intentId }, reading.pageNumber, current) as { quoteId: string };
        check(); await this.audio.execute("tts:submit", { ...scope, intentId: intent!.intentId, quoteId: quote.quoteId }, reading.pageNumber, current); check();
      }
      return { intentId: intent!.intentId, waitingFor: "service", saved: false };
    }
    if (!intent) throw new Error("Native assessment has no original speech task to refresh");
    const status = await this.audio.execute("tts:status", { ...scope, intentId: intent.intentId }, reading.pageNumber, current) as { task: { state: string } | null };
    check();
    if (status.task?.state === "ready") {
      await this.audio.execute("tts:adopt", { ...scope, intentId: intent.intentId }, reading.pageNumber, current); check();
      return { intentId: intent.intentId, state: "adopted", applied: true, audioReady: true, saved: false };
    }
    return { intentId: intent.intentId, applied: false, audioReady: false, state: status.task?.state ?? "submission_unknown" };
  }

}
