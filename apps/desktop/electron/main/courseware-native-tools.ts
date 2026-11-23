import type { NativeRepairStore, NativeRepairState } from "./courseware-native-repairs";
import { validSpeechAnimationSequence } from "@pi-desktop/courseware-runtime/node";
import { insertNativeActivity } from "./courseware-native-activities";
import { recoverNativeAudio } from "./courseware-native-audio-recovery";
import { adoptNativeMaterials, type NativeMaterials } from "./courseware-native-materials";
import { createHash } from "node:crypto";
import { waitForPptEditorTeachingReady } from "./ppt-editor-handshake";
import { resolveCoursewareRequiredObjects, inspectCoursewareEnrichment, inspectCoursewareTeaching, isCoursewareAttentionCue, isCoursewareAttentionIntent, isCoursewareSceneTeaching, isCoursewareProject, type CoursewareTeachingView } from "@pi-desktop/shared";
import type { CoursewareCandidateCoordinator } from "./courseware-candidates";
import type { CoursewareNativeAudio } from "./courseware-native-audio";
import type { CoursewareTeachingCoordinator } from "./courseware-teaching";

type Route = (operation: string, args: Record<string, unknown>, page: number) => Promise<{ value: unknown } | undefined>;
/** Chat tools share the exact open-document commands used by the teaching sidebar. */
export class CoursewareNativeTools {
  private lessonPreviews = new Map<string, Awaited<ReturnType<CoursewareCandidateCoordinator["planNativeLesson"]>>>();
  private repairStates = new Map<string, NativeRepairState>();
  constructor(private teaching: CoursewareTeachingCoordinator, private candidates: CoursewareCandidateCoordinator,
    private audio: CoursewareNativeAudio, private route: Route, private session: () => string | null, private video?: import("./courseware-native-video").CoursewareNativeVideo,
    private music?: import("./courseware-native-music").CoursewareNativeMusic, private ensureOpen?: (sessionId: string, canDispatch: () => boolean) => Promise<void>,
    private ensureSaved?: (sessionId: string, canDispatch: () => boolean) => Promise<void>,
    private assessmentMedia?: Pick<import("./courseware-assessment-media").CoursewareAssessmentMedia, "execute">,
    private materials?: { verifyInline(sessionId: string, text: string): Promise<boolean>; read(sessionId: string, sourceId: string): Promise<{ text: string }>; list(sessionId: string): Promise<unknown>; record?(sessionId: string, name: string, text: string): Promise<unknown> },
    private playbackPreflight?: (view: CoursewareTeachingView, check: () => void) => Promise<{ ready: boolean; sourceSha256: string;
      issues: Array<{ code: string; pageNumber: number; pageId: string; message: string }>; diagnostics: unknown[] }>,
    private contentReview?: (sessionId: string, canDispatch: () => boolean, repairSpeech: boolean) => Promise<import("./courseware-content-review").ContentReviewResult>, private repairs?: NativeRepairStore,
    private reviewTurns?: import('./courseware-content-review').ContentReviewTurns) {}

  private async repairState(sessionId: string, projectId: string): Promise<NativeRepairState> {
    return this.repairs ? this.repairs.read(sessionId, projectId) : this.repairStates.get(JSON.stringify([sessionId, projectId])) ?? { revision: 0, failures: {} };
  }

  private async saveRepairs(sessionId: string, projectId: string, previous: NativeRepairState, failures: Record<string, string>) {
    const next = this.repairs ? await this.repairs.write(sessionId, projectId, previous, failures) : { revision: previous.revision + 1, failures };
    this.repairStates.set(JSON.stringify([sessionId, projectId]), next);
    return next;
  }

  async execute(sessionId: string, name: string, args: unknown, canDispatch: () => boolean): Promise<{ value: unknown } | undefined> {
    let result: { value: unknown } | undefined;
    try { result = await this.executeUnsaved(sessionId, name, args, canDispatch); }
    catch (error) {
      if (error && typeof error === "object" && ["PPT_EDITOR_NOT_READY", "PPT_EDITOR_SAVE_IN_PROGRESS"].includes(String(Reflect.get(error, "code"))))
        console.warn(JSON.stringify({ event: "courseware.editor_readiness_deferred", errorCode: String(Reflect.get(error, "code")),
          operation: name, phase: ["saving", "focus"].includes(String(Reflect.get(error, "phase"))) ? Reflect.get(error, "phase") : "opening" }));
      throw error;
    }
    const value = result?.value;
    if (this.ensureSaved && value && typeof value === "object" && !Array.isArray(value) &&
        (Reflect.get(value, "applied") === true || Array.isArray(Reflect.get(value, "pages")) &&
          Reflect.get(value, "pages").some((page: unknown) => page && typeof page === "object" && Reflect.get(page, "applied") === true))) {
      if (sessionId !== this.session() || !canDispatch()) throw new Error("Native teaching owner changed before save");
      await this.ensureSaved(sessionId, canDispatch);
      if (sessionId !== this.session() || !canDispatch()) throw new Error("Native teaching owner changed during save");
      const complete = !Array.isArray(Reflect.get(value, "failures")) || Reflect.get(value, "failures").length === 0;
      const pages = Reflect.get(value, "pages");
      const results = Reflect.get(value, "results");
      const latest = (await this.teaching.native("open"))?.value as CoursewareTeachingView | undefined;
      if (sessionId !== this.session() || !canDispatch()) throw new Error("Native teaching owner changed after save");
      return { value: { ...value, ...(latest ? { sourceSha256: latest.project.source.sha256, teachingRevision: latest.project.teachingRevision } : {}), saved: complete, ...(Array.isArray(pages)
        ? { pages: pages.map(page => ({ ...page, saved: page.applied === true })) } : {}), ...(Array.isArray(results)
        ? { results: results.map(result => ({ ...result, saved: result.applied === true })) } : {}) } };
    }
    return result;
  }

  private async executeUnsaved(sessionId: string, name: string, args: unknown, canDispatch: () => boolean, readingAfterReview = false): Promise<{ value: unknown } | undefined> {
    if (!/^(courseware_narration_|courseware_media_|courseware_activity_)/.test(name)) return;
    // Wait only before dispatch: an in-flight ownership change must still reject without replaying writes.
    await waitForPptEditorTeachingReady({ ready: () => sessionId === this.session(), phase: () => "focus", timeoutMs: 60_000,
      check: () => { if (!canDispatch()) throw new Error("Native teaching owner changed: turn ended"); } });
    await this.ensureOpen?.(sessionId, canDispatch);
    const opened = await this.teaching.native("open");
    if (!opened) return;
    const check = () => { if (sessionId !== this.session() || !canDispatch()) throw new Error("Native teaching owner changed"); };
    check();
    if (!args || typeof args !== "object" || Array.isArray(args)) throw new Error("Invalid native tool arguments");
    const input = args as Record<string, unknown>, view = opened.value as CoursewareTeachingView, project = view.project;
    if (!isCoursewareProject(project)) throw new Error("Invalid native teaching view");
    if (name === "courseware_media_context" && input.reviewContent === true) {
      if (!this.contentReview) throw new Error("Saved content review requires an authorized vision model");
      const contentReview = await this.contentReview(sessionId, () => sessionId === this.session() && canDispatch(), input.continueTeaching === true);
      check();
      const refreshed = await this.executeUnsaved(sessionId, name, { ...input, reviewContent: false }, canDispatch, true);
      const status = refreshed?.value as { sourceSha256: string; teachingRevision: string; teachingReady: boolean;
        completion: { ready: boolean; issues: unknown[] } } | undefined;
      if (!status || status.sourceSha256 !== contentReview.sourceSha256 || status.teachingRevision !== contentReview.teachingRevision)
        throw new Error("Saved content changed after review; reread before claiming completion");
      return { value: { ...status, contentReview, applied: contentReview.applied,
        teachingReady: status.teachingReady && contentReview.ready,
        completion: { ...status.completion, ready: status.completion.ready && contentReview.ready,
          issues: [...status.completion.issues, ...contentReview.issues] } } };
    }
    if (name === "courseware_media_assessments") return { value: await this.assessments(input, view, check) };
    if (name === "courseware_activity_insert") {
      if (input.sourceSha256 !== project.source.sha256) throw new Error(`COURSEWARE_SOURCE_CHANGED: Native source changed; read courseware_narration_context again. Current sourceSha256: ${project.source.sha256}. Do not repeat the old SHA`);
      return { value: await insertNativeActivity({ teaching: this.teaching, view, args: input, check,
        review: data => this.candidates.reviewNativeActivity(sessionId, data, canDispatch) }) };
    }
    if (name === "courseware_narration_import" || name === "courseware_narration_plan") {
      if (input.sourceSha256 !== project.source.sha256) throw new Error(`COURSEWARE_SOURCE_CHANGED: Native source changed; read courseware_narration_context again. Current sourceSha256: ${project.source.sha256}. Do not repeat the old SHA`);
      const supplied = structuredClone(input);
      const inline: Array<{ name: string; text: string }> = [];
      for (const key of ["script", "lessonPlan"]) {
        const source = supplied[key];
        if (!source || typeof source !== "object" || Array.isArray(source)) continue;
        const sourceId = Reflect.get(source, "sourceId");
        if (sourceId === undefined) {
          const text = Reflect.get(source, "text");
          if (typeof text !== "string" || !await this.materials?.verifyInline(sessionId, text))
            throw new Error(`Inline ${key} must quote text supplied by the user in this Chat. Use sourceId for an attachment. To generate or repair one page, use courseware_narration_propose with its pageNumbers and repairRequiredTeaching:true for existing speech effects.`);
          check();
          inline.push({name: key === "script" ? "inline-script.txt" : "inline-lesson-plan.txt", text});
          continue;
        }
        if (Reflect.get(source, "text") !== undefined || typeof sourceId !== "string" || !/^[a-f0-9]{64}$/u.test(sourceId) || !this.materials)
          throw new Error("Use exactly one immutable source ID or supplied text");
        const stored = await this.materials.read(sessionId, sourceId); check();
        Reflect.set(source, "text", stored.text); Reflect.deleteProperty(source, "sourceId");
      }
      if (input.apply === true) for (const item of inline) {
        await this.materials?.record?.(sessionId, item.name, item.text); check();
      }
      if (name === "courseware_narration_plan") {
        const source = supplied.lessonPlan as { text?: unknown } | undefined;
        if (typeof source?.text !== "string" || !source.text.trim() || source.text.length > 100000 || typeof input.apply !== "boolean" ||
            input.instruction !== undefined && (typeof input.instruction !== "string" || input.instruction.length > 8000)) throw new Error("Invalid lesson planning request");
        const sha256 = createHash("sha256").update(source.text).digest("hex");
        if (view.enrichment?.plan) return { value: { applied: false, saved: false, reused: true, plan: view.enrichment.plan,
          requiresExplicitReplacement: view.enrichment.plan.sha256 !== sha256,
          coverage: inspectCoursewareEnrichment(view.enrichment, project.pages) } };
        if (view.enrichmentCapabilities?.version !== 1 || view.readOnly || input.apply && project.pages.every(p => p.locked))
          throw new Error("An editable native PPT with material support is required for lesson planning");
        const previewKey = JSON.stringify([sessionId, project, sha256, input.instruction ?? ""]);
        const proposal = this.lessonPreviews.get(previewKey) ?? await this.candidates.planNativeLesson(sessionId, source.text, String(input.instruction ?? ""), () => sessionId === this.session() && canDispatch());
        check();
        if (proposal.view.project.projectId !== project.projectId || proposal.view.project.source.sha256 !== project.source.sha256 ||
            JSON.stringify(proposal.view.project) !== JSON.stringify(project) || proposal.view.enrichment?.plan)
          throw new Error("Native teaching changed before lesson-plan adoption");
        const result = await adoptNativeMaterials({ teaching: this.teaching, view: proposal.view, check,
          materials: { apply: input.apply, lessonPlan: { text: source.text, units: proposal.units } } });
        if (input.apply) this.lessonPreviews.delete(previewKey);
        else { if (this.lessonPreviews.size >= 16) this.lessonPreviews.clear(); this.lessonPreviews.set(previewKey, structuredClone(proposal)); }
        return { value: { ...result, plan: { sha256, units: proposal.units } } };
      }
      return { value: await adoptNativeMaterials({ teaching: this.teaching, view, materials: supplied as NativeMaterials, check }) };
    }
    if (input.repairObjectsOnly !== undefined && (typeof input.repairObjectsOnly !== "boolean" || input.repairObjectsOnly && input.repairRequiredTeaching !== true))
      throw new Error("Objects-only repair requires repairRequiredTeaching:true");
    if (name === "courseware_narration_propose" && (!Array.isArray(input.pageNumbers) || input.pageNumbers.length > 5))
      throw new Error("Narration generation accepts at most 5 pages per tool call. Submit only the next unfinished batch, await its saved result, then read fresh context/sourceSha256 before continuing");
    const numbers = input.pageNumbers ?? project.pages.map((_, index) => index + 1);
    if (!Array.isArray(numbers) || !numbers.length || numbers.length > 100 || new Set(numbers).size !== numbers.length ||
        numbers.some(n => !Number.isInteger(n) || n < 1 || n > project.pages.length)) throw new Error("Invalid native page numbers");
    if (name === "courseware_narration_context" || name === "courseware_media_context") {
      const materials = await this.materials?.list(sessionId); check();
      const enrichment = inspectCoursewareEnrichment(view.enrichment, project.pages);
      const silent = new Set(view.enrichment?.script?.silentPageIds ?? []);
      const pages = await Promise.all(numbers.map(async pageNumber => {
        const page = project.pages[pageNumber - 1], speeches = page.actions.filter(a => a.type === "speech");
        const audioReady = (speeches.length > 0 || silent.has(page.pageId)) && speeches.every(a => typeof a.audioAssetId === "string");
        const effects = { highlight: new Set<string>(), spotlight: new Set<string>(), animation: new Set<string>() };
        for (const speech of speeches) {
          const attention = speech.attention;
          if (isCoursewareAttentionIntent(attention)) {
            for (const id of attention.objectIds) effects[attention.type].add(id);
            if (attention.animation) for (const id of attention.objectIds) effects.animation.add(id);
          }
          for (const cue of Array.isArray(speech.visualCues) ? speech.visualCues : []) if (isCoursewareAttentionCue(cue)) {
            const effect = cue.effect, kind = effect.type === "element_animation" ? "animation" : effect.type;
            for (const id of effect.type === "highlight" ? effect.elementIds : [effect.elementId, ...(effect.elementIds ?? [])]) effects[kind].add(id);
          }
        }
        const durationMs = speeches.length && speeches.every(a => typeof a.audioAssetId === "string" && Number.isSafeInteger(a.durationMs) && Number(a.durationMs) > 0)
          ? speeches.reduce((sum, a) => sum + Number(a.durationMs), 0) : null;
        const budgetSeconds = view.teachingRequirements?.find(t => t.pageId === page.pageId)?.teaching.durationSeconds ?? null;
        let evidence: Record<string, unknown> = {};
        if (name === "courseware_narration_context" && input.pageNumbers !== undefined) {
          const captured = (await this.teaching.native("narration-context", {}, pageNumber))?.value as {
            view: CoursewareTeachingView; text: string; evidence: { notes: string; objects: unknown[] };
          } | undefined;
          check();
          if (!captured?.view || JSON.stringify(captured.view.project) !== JSON.stringify(project)) throw new Error("Native page changed while reading material mapping context");
          evidence = { pageText: captured.text, notes: captured.evidence.notes, objects: captured.evidence.objects };
        }
        return { ...page, ...evidence, pageNumber, effects: Object.fromEntries(Object.entries(effects).map(([kind, ids]) => [kind, [...ids]])),
          narrationTiming: { durationMs, budgetSeconds, overBudget: durationMs !== null && budgetSeconds !== null && durationMs > budgetSeconds * 1000 },
          hasNarration: !!speeches.length, narrationReady: !!speeches.length || silent.has(page.pageId), intentionalSilence: silent.has(page.pageId), audioReady,
          teachingReady: audioReady && !page.actions.some(a => a.attention !== undefined || ["music_slot", "video_slot"].includes(String(a.type))),
          speeches: speeches.map(a => ({ actionId: a.id, text: a.text, audioReady: typeof a.audioAssetId === "string", audioAssetId: a.audioAssetId })) };
      }));
      const teachingByPage = new Map((view.teachingRequirements ?? []).map(({ pageId, teaching }) => {
        if (!isCoursewareSceneTeaching(teaching)) throw new Error("Invalid native teaching requirement");
        return [pageId, teaching] as const;
      }));
      const assessments = new Set([...teachingByPage].filter(([, t]) => t.pageType !== "slide").map(([id]) => id));
      const quality = inspectCoursewareTeaching(project, teachingByPage, assessments, true);
      const requiredIssues: Array<{ code: string; pageNumber: number; pageId: string; actionId?: string; repair: string; repairable: boolean; message?: string }> = quality.issues.filter(i => i.code !== "FOCUS_MISSING" && !(silent.has(i.pageId) && ["NARRATION_MISSING", "AUDIO_MISSING"].includes(i.code)));
      const repairState = await this.repairState(sessionId, project.projectId); check();
      for (const [index, page] of project.pages.entries()) {
        const unresolved = repairState.failures[page.pageId];
        if (unresolved) requiredIssues.push({ code: "NARRATION_REPAIR_UNRESOLVED", pageNumber: index + 1, pageId: page.pageId,
          message: unresolved, repair: "narration", repairable: false });
        // The shared advisory skips assessment pages; native question speech still needs actionable audio diagnostics.
        if (assessments.has(page.pageId) && !silent.has(page.pageId)) for (const action of page.actions)
          if (action.type === "speech" && typeof action.audioAssetId !== "string")
            requiredIssues.push({ code: "AUDIO_MISSING", pageNumber: index + 1, pageId: page.pageId,
              actionId: String(action.id), repair: "tts", repairable: !page.locked });
        if (!silent.has(page.pageId) && !page.actions.some(a => a.type === "speech" && typeof a.text === "string" && a.text.trim()))
          requiredIssues.push({ code: "NARRATION_MISSING", pageNumber: index + 1, pageId: page.pageId, repair: "narration",
            repairable: !page.locked, message: `Page ${index + 1} has no saved narration candidate.` });
      }
      for (const [index, page] of project.pages.entries()) if (!validSpeechAnimationSequence(page.actions.map(a => ({ type: String(a.type),
        visualCues: Array.isArray(a.visualCues) ? a.visualCues : undefined }))))
        requiredIssues.push({ code: "ANIMATION_TARGET_CONFLICT", pageNumber: index + 1, pageId: page.pageId,
          repair: "narration", repairable: !page.locked });
      for (const issue of enrichment.issues) requiredIssues.push({ ...issue, pageId: issue.pageId ?? "unmatched", pageNumber: issue.pageId ? project.pages.findIndex(p => p.pageId === issue.pageId) + 1 : 0,
        repair: "materials", repairable: false, message: `${issue.code}${issue.sourceId ? ` (${issue.sourceId})` : ""}${issue.pageId ? ` on page ${project.pages.findIndex(p => p.pageId === issue.pageId) + 1}` : ""}` });
      for (const [index, page] of project.pages.entries()) for (const action of page.actions) if (action.attention !== undefined)
        requiredIssues.push({ code: "ATTENTION_PENDING", pageNumber: index + 1, pageId: page.pageId, actionId: String(action.id), repair: "tts", repairable: !page.locked });
      const actions = project.pages.flatMap(p => p.actions), speeches = actions.filter(a => a.type === "speech"), audioCount = speeches.filter(a => typeof a.audioAssetId === "string").length;
      const counts = { pages: project.pages.length, speeches: speeches.length, audioReady: audioCount, audioMissing: speeches.length - audioCount,
        musicClips: actions.filter(a => a.type === "audio_clip").length, musicPending: actions.filter(a => a.type === "music_slot").length,
        questions: actions.filter(a => a.type === "interaction_checkpoint" && a.checkpointKind === "chapter_summary").length };
      const jobs = [], unresolvedOriginals = [];
      const requiredObjectBindings = [];
      const objectWarnings = [];
      for (const page of pages) {
        const current = (await this.route("open", {}, page.pageNumber))!.value as CoursewareTeachingView;
        const planned = teachingByPage.get(page.pageId);
        const mapped = (current.teachingObjects ?? []).filter(object => object.status === "mapped");
        if (planned?.requiredObjects.length) {
          const resolved = resolveCoursewareRequiredObjects(planned.requiredObjects, mapped);
          requiredObjectBindings.push({ pageId: page.pageId, pageNumber: page.pageNumber, requirements: resolved });
          const missing = resolved.filter(binding => !binding.resolved).map(binding => binding.requirement);
          if (missing.length) objectWarnings.push({ code: "OBJECT_BINDING_ADVISORY", pageNumber: page.pageNumber, pageId: page.pageId,
            message: `Planned descriptions are not independently bound: ${missing.join(", ")}. This is advisory; narrate the actual picture and bind effects only to verified eligible targets. Visual grounding checks essential teaching content separately. Do not regenerate images or invent aliases to match design details.` });
        }
        const validTargetIds = new Set(mapped.filter(object => object.effectTargetEligible).map(object => object.objectId));
        for (const action of page.actions.filter(a => a.type === "speech")) {
          const targets = new Set<string>();
          const attention = action.attention;
          if (attention && typeof attention === "object" && !Array.isArray(attention) && Array.isArray(Reflect.get(attention, "objectIds")))
            for (const id of Reflect.get(attention, "objectIds") as unknown[]) if (typeof id === "string") targets.add(id);
          for (const cue of Array.isArray(action.visualCues) ? action.visualCues : []) if (isCoursewareAttentionCue(cue)) {
            const effect = cue.effect;
            for (const id of effect.type === "highlight" ? effect.elementIds : [effect.elementId, ...(effect.elementIds ?? [])]) targets.add(id);
          }
          for (const objectId of targets) if (!validTargetIds.has(objectId)) requiredIssues.push({ code: "EFFECT_TARGET_MISSING",
            pageNumber: page.pageNumber, pageId: page.pageId, actionId: String(action.id), repair: "narration", repairable: !page.locked,
            message: `Page ${page.pageNumber} narration ${String(action.id)} targets ${objectId}, which is not a currently mapped graphic or independent text object on this page.` });
        }
        if (name !== "courseware_media_context") continue;
        const intents = await this.audio.execute("tts:list", { viewId: current.viewId, expectedTeachingRevision: current.project.teachingRevision }, page.pageNumber, current) as Array<{ intentId: string; actionId: string; current: boolean; audioReady: boolean }>;
        check();
        if (this.video) { jobs.push(...await this.video.jobs(page.pageNumber, current)); check(); }
        if (this.music) { jobs.push(...await this.music.jobs(page.pageNumber, current)); check(); }
        const pending = intents.filter(i => i.current && !i.audioReady && !page.speeches.some(s => s.actionId === i.actionId && s.audioReady));
        for (const intent of pending) {
          const job = { kind: "tts", intentId: intent.intentId, pageNumber: page.pageNumber, sourceSha256: project.source.sha256 };
          if (pending.filter(i => i.actionId === intent.actionId).length > 1)
            unresolvedOriginals.push({ ...job, actionId: intent.actionId, error: "Multiple matching speech tasks; select an original intent explicitly" });
          else jobs.push(job);
        }
      }
      const playback = name === "courseware_media_context" && pages.length === project.pages.length && pages.every(page => page.teachingReady) && !jobs.length
        ? await this.playbackPreflight?.(view, check) : undefined;
      check();
      for (const issue of playback?.issues ?? []) {
        const repairable = ["EFFECT_BINDING_MISMATCH", "EFFECT_TARGET_UNSUPPORTED", "ANIMATION_TARGET_CONFLICT", "NATIVE_SPEECH_ANIMATION_MISSING"].includes(issue.code) &&
          !project.pages.find(page => page.pageId === issue.pageId)?.locked;
        requiredIssues.push({ ...issue, repair: repairable ? "narration" : "source", repairable });
      }
      const models = name === "courseware_media_context" && input.kind === "tts"
        ? await this.audio.execute("tts:models", { viewId: view.viewId, expectedTeachingRevision: project.teachingRevision }, view.pageNumber, view)
        : name === "courseware_media_context" && input.kind === "music" ? await this.music?.models()
        : name === "courseware_media_context" && input.kind === "video" ? await this.video?.models() : undefined;
      check();
      const assessmentMedia = await this.assessments({ mode: "context" }, view, check) as { ready: boolean; targets?: Array<{ kind: string }> };
      const assessmentReady = assessmentMedia.ready;
      const { contentReview, speechRepair } = this.reviewTurns?.status(sessionId, view) ?? {};
      if (!readingAfterReview && contentReview) requiredIssues.push(...contentReview.issues);
      return { value: { nativeTeaching: true, contentReviewAvailable: !!this.contentReview, ...(playback ? { playbackPreflight: playback } : {}), ...(materials ? { materials } : {}), ...(assessmentMedia ? { assessmentMedia } : {}), projectId: project.projectId, sourceRevision: project.source.revision, sourceSha256: project.source.sha256,
        teachingRevision: project.teachingRevision, educationContext: project.educationContext, requiredObjectBindings,
        ...(!readingAfterReview && contentReview ? { contentReview } : {}), ...(speechRepair ? { speechRepair } : {}),
        enrichment: { ...enrichment, policy: view.enrichment?.script?.policy, originalPages: view.enrichment?.originalPages, plan: view.enrichment?.plan, unmatchedSegments: view.enrichment?.script?.segments.filter(s => !s.pageId).map(s => ({ id: s.id, sourceLine: s.sourceLine })) }, quality, completion: { counts, ready: !requiredIssues.length && assessmentReady, issues: requiredIssues, warnings: objectWarnings, sourceSha256: project.source.sha256, teachingRevision: project.teachingRevision },
        ...(models ? { models } : {}), videoReady: !pages.some(p => p.actions.some(a => a.type === "video_slot")), pageCount: project.pages.length, pages, jobs, unresolvedOriginals,
        narrationReady: enrichment.ready && pages.every(p => p.narrationReady), audioReady: pages.every(p => p.audioReady), teachingReady: !requiredIssues.length && pages.every(p => p.teachingReady) && assessmentReady } };
    }
    if (input.sourceSha256 !== project.source.sha256) throw new Error(`COURSEWARE_SOURCE_CHANGED: Native source changed; read courseware_narration_context again. Current sourceSha256: ${project.source.sha256}. Do not repeat the old SHA`);
    if (name === "courseware_media_refresh" && input.kind === "tts" && input.recover === true) {
      if (input.pageNumber !== undefined || input.intentId !== undefined || input.intentIds !== undefined || input.retryFailed !== undefined ||
          input.model !== undefined && typeof input.model !== "string" ||
          input.voice !== undefined && input.voice !== null && typeof input.voice !== "string") throw new Error("Invalid full-deck audio recovery scope");
      return { value: await recoverNativeAudio({ route: this.route, audio: this.audio, view, pageNumbers: numbers,
        model: input.model as string | undefined, voice: input.voice as string | null | undefined, check }) };
    }
    if (name === "courseware_narration_propose") {
      if (!input.repairRequiredTeaching && this.reviewTurns?.current(sessionId, project.projectId)?.baseline &&
          numbers.some(n => project.pages[n - 1].actions.some(a => a.type === 'speech')))
        throw new Error('The current review preserves saved narration. Report additional speech findings; use required teaching repair only for effects that preserve the saved words and audio.');
      if (input.speechCount !== undefined && (!Number.isInteger(input.speechCount) || Number(input.speechCount) < 1 || Number(input.speechCount) > 100 || input.repairRequiredTeaching)) throw new Error("Exact speech count requires a narration rewrite with a count from 1 to 100");
      if (typeof input.instruction !== "string" || !input.instruction.trim() || input.instruction.length > 8000) throw new Error("Invalid narration instruction");
      if (numbers.some(n => view.enrichment?.script?.silentPageIds.includes(project.pages[n - 1].pageId)))
        throw new Error("This page is intentionally silent; change its source policy before generating speech");
      if (!input.repairRequiredTeaching && view.enrichment?.script?.policy === "preserve") {
        const protectedIds = new Set(view.enrichment.originalPages.map(p => p.pageId));
        if (numbers.some(n => protectedIds.has(project.pages[n - 1].pageId))) throw new Error("Accepted script is protected; use verbatim repair or explicitly revise its source policy");
      }
      let state = await this.repairState(sessionId, project.projectId); check();
      const pageIds = new Map(numbers.map(n => [n, project.pages[n - 1].pageId]));
      if (input.repairRequiredTeaching === true && input.repairObjectsOnly !== true) {
        const pending = { ...state.failures };
        for (const id of pageIds.values()) pending[id] = "Required teaching repair has not been verified and saved.";
        state = await this.saveRepairs(sessionId, project.projectId, state, pending); check();
      }
      const result = await this.candidates.proposeNativeNarrationBatch(sessionId, numbers, input.instruction, canDispatch, input.repairRequiredTeaching === true,
        this.ensureSaved ? () => this.ensureSaved!(sessionId, canDispatch) : undefined, input.repairObjectsOnly === true, input.speechCount as number | undefined);
      check();
      const latestState = await this.repairState(sessionId, project.projectId); check();
      if (JSON.stringify(latestState.failures) !== JSON.stringify(state.failures))
        throw new Error("Native repair state changed during generation; read saved teaching before continuing");
      state = latestState;
      // Persist the document before clearing failures; an uncertain save must leave the guard intact.
      if (input.repairObjectsOnly !== true && result.savedPages.some(page => !page.retained && state.failures[pageIds.get(page.pageNumber) ?? ""])) {
        await this.ensureSaved?.(sessionId, canDispatch); check();
      }
      const failures = { ...state.failures };
      for (const page of result.savedPages) if (!page.retained && input.repairObjectsOnly !== true) {
        const id = pageIds.get(page.pageNumber);
        if (id) delete failures[id];
      }
      if (JSON.stringify(failures) !== JSON.stringify(state.failures)) {
        await this.saveRepairs(sessionId, project.projectId, state, failures); check();
      }
      return { value: { ...result, saved: false, pages: result.savedPages.map(page => ({ ...page, applied: true, saved: false })) } };
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
    if (name === "courseware_media_prepare") {
      const ids = input.actionIds ?? [input.actionId];
      if (!Array.isArray(ids) || !ids.length || ids.length > 100 || new Set(ids).size !== ids.length || ids.some(id => typeof id !== "string")) throw new Error("Invalid native speech actions");
      const jobs = [], pages = [];
      for (const actionId of ids) {
        check();
        const latest = (await this.route("open", {}, pageNumber))!.value as CoursewareTeachingView;
        if (latest.project.projectId !== project.projectId || latest.project.source.sha256 !== project.source.sha256 || latest.pageId !== current.pageId)
          throw new Error("Native media target changed");
        const action = latest.project.pages[pageNumber - 1].actions.find(a => a.id === actionId && a.type === "speech");
        if (!action) throw new Error("Native speech action unavailable");
        if (typeof action.audioAssetId === "string") { pages.push({ actionId, applied: false, audioReady: true, retained: true }); continue; }
        const scope = { viewId: latest.viewId, expectedTeachingRevision: latest.project.teachingRevision };
        const intent = await this.audio.execute("tts:prepare", { ...scope, actionId, model: input.model, voice: input.voice ?? null, reuseExisting: true }, pageNumber, latest) as { intentId: string; phase: string };
        check();
        if (intent.phase === "prepared") {
          const quote = await this.audio.execute("tts:quote", { ...scope, intentId: intent.intentId }, pageNumber, latest) as { quoteId: string };
          check();
          await this.audio.execute("tts:submit", { ...scope, intentId: intent.intentId, quoteId: quote.quoteId }, pageNumber, latest);
          check();
        }
        jobs.push({ kind: "tts", intentId: intent.intentId, pageNumber, sourceSha256: project.source.sha256 });
      }
      return { value: { jobs, pages, job: jobs.length === 1 ? jobs[0] : undefined, saved: false, audioReady: !jobs.length,
        ...(jobs.length ? { waitingFor: "service" } : {}) } };
    }
    const ids = input.intentIds ?? [input.intentId];
    if (!Array.isArray(ids) || !ids.length || ids.length > 100 || new Set(ids).size !== ids.length || ids.some(id => typeof id !== "string")) throw new Error("Invalid native speech tasks");
    const results = [], failures = [];
    for (const requestedId of ids) {
      let intentId = requestedId;
      const job = { kind: "tts", sourceSha256: project.source.sha256, pageNumber, intentId };
      try {
        check();
        let latest = (await this.route("open", {}, pageNumber))!.value as CoursewareTeachingView;
        if (latest.pageId !== current.pageId || latest.project.projectId !== project.projectId || latest.project.source.sha256 !== project.source.sha256)
          throw new Error("Native media target changed");
        let args = { viewId: latest.viewId, expectedTeachingRevision: latest.project.teachingRevision, intentId };
        const readStatus = () => this.audio.execute("tts:status", args, job.pageNumber, latest) as Promise<{ phase: string; task: { state: string; errorCode?: string | null } | null }>;
        let status;
        try { status = await readStatus(); }
        catch (error) {
          if (!(error instanceof Error && "code" in error && error.code === "COURSEWARE_TTS_RECEIPT_NOT_FOUND")) throw error;
          const candidates = await this.audio.execute("tts:lookup", args, pageNumber, latest) as { intentId: string; pageId: string; actionId: string }[];
          check();
          if (candidates.length !== 1) {
            const state = candidates.length ? "ambiguous_receipt" : "receipt_not_found";
            const message = candidates.length ? "Select an original receipt from candidates" : "No matching receipt in the current course; read saved speech and task records";
            failures.push({ intentId, pageNumber, state, candidates, error: message });
            results.push({ intentId, job, applied: false, audioReady: false, state });
            continue;
          }
          const match = candidates[0];
          job.intentId = intentId = match.intentId;
          job.pageNumber = project.pages.findIndex(p => p.pageId === match.pageId) + 1;
          if (!job.pageNumber) throw new Error("Original speech page is no longer present; inspect the saved course");
          latest = (await this.route("open", {}, job.pageNumber))!.value as CoursewareTeachingView;
          if (latest.pageId !== match.pageId || latest.project.projectId !== project.projectId || latest.project.source.sha256 !== project.source.sha256) throw new Error("Native media target changed");
          args = { viewId: latest.viewId, expectedTeachingRevision: latest.project.teachingRevision, intentId };
          check(); status = await readStatus();
        }
        check();
        if (status.task?.state === "ready") { await this.audio.execute("tts:adopt", args, job.pageNumber, latest); check(); results.push({ intentId, job, media: status, applied: true, audioReady: true }); }
        else results.push({ intentId, job, media: status, applied: false, audioReady: false, state: status.task?.state ?? status.phase ?? "submission_unknown" });
      } catch (error) {
        check(); failures.push({ intentId, pageNumber: job.pageNumber || pageNumber, state: "refresh_unconfirmed", error: String(error) });
        results.push({ intentId, job, applied: false, audioReady: false, state: "refresh_unconfirmed" });
      }
    }
    return { value: { pages: results, results, failures, audioReady: results.every(r => r.audioReady), saved: false } };
  }

  private async assessments(input: Record<string, unknown>, view: CoursewareTeachingView, check: () => void) {
    if (this.assessmentMedia) return this.assessmentMedia.execute(this.session()!, input, () => { check(); return true; });
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
      return { configurableQuizSceneIds: [], projectId: project.projectId, expectedRevision: project.teachingRevision, expectedSourceRevision: project.source.revision,
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
