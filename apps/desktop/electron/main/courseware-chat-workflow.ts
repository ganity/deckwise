import { coursewareMediaRecovery } from "@pi-desktop/shared";
import { adoptPresentation } from "./courseware-presentation";
import { preparePresentation } from "./courseware-presentation-prepare";
import { setTimeout as delay } from "node:timers/promises";
import { sceneAssetBlockers, type CoursewareEducationContext, type CoursewareSceneImageView, type CoursewareWorkflowView } from "@pi-desktop/shared";
import type { DesktopAuthSession } from "./auth-session";
import { readSceneCourseDraft } from "./courseware-scene-draft";
import { CoursewareSceneImages } from "./courseware-scene-images";
import { runSceneImagePipeline } from "./courseware-scene-image-pipeline";
import { CoursewareSceneGeneration, type SceneCourseGenerationServices } from "./courseware-scene-generation";

type Host = { call<T>(method: string, params: unknown): Promise<T> };
type Task = { storyFirst?: boolean; taskType: "plain" | "scene" | "import"; educationContext?: CoursewareEducationContext;
  importPath?: string; generatedPath?: string; canonicalProjectId?: string };
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);

function assertWorkflowScope(host: Host | null, currentHost: Host | null, sessionId: string, viewingSession: string | null, canDispatch?: () => boolean) {
  if (!host || currentHost !== host) throw new Error("Courseware runtime changed; read saved workflow before continuing");
  if (!canDispatch && viewingSession !== sessionId) throw new Error("Courseware conversation changed; return to this Chat and read saved workflow");
  if (canDispatch && !canDispatch()) throw new Error("Courseware Chat turn ended or was cancelled; read saved workflow in a new turn");
}

/** Main Chat and panel reuse the same durable jobs; image generation keeps billing internal and preserves first-page style review. */
export class CoursewareChatWorkflow {
  nativeTeaching?: { execute(sessionId: string, name: string, args: unknown, canDispatch: () => boolean): Promise<{ value: unknown } | undefined> };
  private compiling = false;
  private readonly imagePipelines = new Set<string>();
  private compilation?: { sessionId: string } & NonNullable<CoursewareWorkflowView["compilation"]>;
  narration?: { execute(sessionId: string, name: string, args: unknown, canDispatch: () => boolean): Promise<unknown> };
  media?: { execute(sessionId: string, name: string, args: unknown, canDispatch: () => boolean): Promise<unknown> };
  assessments?: Pick<import("./courseware-assessment-media").CoursewareAssessmentMedia, "execute">;
  constructor(private getHost: () => Host | null, private getViewingSession: () => string | null,
    private auth: Pick<DesktopAuthSession, "getCoursewarePrincipal" | "coursewareMedia">,
    private generation: SceneCourseGenerationServices) {}

  // Main supplies a turn guard for Agent work; panel reads retain foreground ownership.
  async read(sessionId: string, canDispatch?: () => boolean): Promise<CoursewareWorkflowView> {
    const host = this.getHost();
    const check = () => assertWorkflowScope(host, this.getHost(), sessionId, this.getViewingSession(), canDispatch);
    if (!/^[A-Za-z0-9_-]{1,128}$/u.test(sessionId)) throw new Error("Invalid courseware session");
    check();
    if (!host) throw new Error("Host is unavailable");
    const { session } = await host.call<{ session?: { projectPath?: string; mode?: string } }>("session.get", { id: sessionId, messageLimit: 1 });
    check();
    if (!session?.projectPath) throw new Error("Courseware requires a saved workspace");
    const { task } = await host.call<{ task: Task | null }>("courseware.task.get", { sessionId });
    check();
    const { story } = task?.storyFirst
      ? await host.call<{ story: CoursewareWorkflowView["story"] }>("courseware.story.get", { sessionId }) : { story: null };
    check();
    const storyPending = !!story && (!story.sha256 || story.sha256 !== story.approvedSha256);
    const { plan } = !storyPending && task?.taskType === "scene" && !task.generatedPath && !task.canonicalProjectId
      ? await readSceneCourseDraft(host, { sessionId }) : { plan: null };
    check();
    const compilation = this.compilation?.sessionId === sessionId && this.compilation.planSha256 === plan?.sha256
      ? { planSha256: this.compilation.planSha256, state: this.compilation.state, ...(this.compilation.message ? { message: this.compilation.message } : {}) } : undefined;
    return { ...(task?.storyFirst ? { story } : {}), ...(compilation ? { compilation } : {}), task: task ? { taskType: task.taskType, ...(task.storyFirst ? { storyFirst: true } : {}), ...(task.educationContext ? { educationContext: task.educationContext } : {}),
      imported: !!task.importPath, generated: !!task.generatedPath || !!task.canonicalProjectId,
      ...(task.canonicalProjectId ? { canonicalProjectId: task.canonicalProjectId } : {}),
      ...((task.generatedPath ?? task.importPath) ? { sourcePath: task.generatedPath ?? task.importPath } : {}) } : null, plan };
  }

  async execute(sessionId: string, name: string, args: unknown, canDispatch: () => boolean): Promise<unknown> {
    if (!record(args)) throw new Error("Invalid courseware workflow arguments");
    const input = structuredClone(args), host = this.getHost();
    const check = () => assertWorkflowScope(host, this.getHost(), sessionId, this.getViewingSession(), canDispatch);
    const view = await this.read(sessionId, canDispatch);
    check();
    if (!host) throw new Error("Host is unavailable");
    const { session } = await host.call<{ session?: { mode?: string } }>("session.get", { id: sessionId, messageLimit: 1 });
    check();
    if (session?.mode !== "agent") throw new Error("Courseware workflow tools require Agent mode");
    const native = await this.nativeTeaching?.execute(sessionId, name, input, canDispatch);
    if (native) { check(); return native.value; }
    if (name === "courseware_story_begin" || name === "courseware_story_save") {
      const method = name === "courseware_story_begin" ? "courseware.story.begin" : "courseware.story.save";
      if (Object.hasOwn(input, "sessionId")) throw new Error("Story session is Host-owned");
      const result = await host.call(method, { ...input, sessionId }); check(); return result;
    }
    if (view.story && (!view.story.sha256 || view.story.sha256 !== view.story.approvedSha256) &&
        !["courseware_workflow_get", "courseware_requirements_update"].includes(name))
      throw new Error("Review and confirm the teaching story before courseware generation");
    if (name === "courseware_scene_plan_submit") {
      if (Object.keys(input).length || view.task?.taskType !== "scene" || view.task.generated || !view.plan)
        throw new Error("Write a valid scene plan for this ungenerated Chat before submitting it");
      return { validated: true, awaitingPlanApproval: view.plan.approvedSha256 !== view.plan.sha256, ...view };
    }
    if (name === "courseware_presentation_adopt" || name === "courseware_presentation_prepare") {
      if (view.task?.taskType !== "plain") throw new Error("Presentation adoption requires the ordinary task");
      const owner = await host.call<{ session?: { projectPath?: string } }>("session.get", { id: sessionId, messageLimit: 1 }); check();
      if (!owner.session?.projectPath) throw new Error("Presentation workspace is unavailable");
      if (name === "courseware_presentation_prepare") {
        if (view.task.generated || view.task.imported) throw new Error("Resume saved teaching; do not replace adopted Office content with SVG");
        return preparePresentation({ workspace: owner.session.projectPath, args: input,
          bodyPageLimit: view.task.educationContext?.bodyPageLimit, check });
      }
      return adoptPresentation({ host, workspace: owner.session.projectPath, sessionId, args: input, check });
    }
    if (name.startsWith("courseware_media_")) {
      if (name === "courseware_media_assessments") {
        if (!this.assessments) throw new Error("Assessment media is unavailable");
        return this.assessments.execute(sessionId, input, canDispatch);
      }
      if (!this.media) throw new Error("Saved courseware media is unavailable");
      if (name === "courseware_media_context" && view.task?.canonicalProjectId && this.assessments) {
        if (Object.keys(input).some(key => !["kind", "continueTeaching"].includes(key)) ||
            input.continueTeaching !== undefined && typeof input.continueTeaching !== "boolean" ||
            input.kind !== undefined && !["tts", "image", "music", "video"].includes(String(input.kind))) throw new Error("Invalid canonical media context");
        const assessmentMedia = await this.assessments.execute(sessionId, { mode: "context", ...(["tts", "image"].includes(String(input.kind)) ? { kind: input.kind } : {}) }, canDispatch);
        if (!("ready" in assessmentMedia)) throw new Error("Invalid assessment media context");
        return { canonicalOnly: true, projectId: assessmentMedia.projectId, teachingRevision: assessmentMedia.expectedRevision,
          sourceSha256: assessmentMedia.expectedSourceRevision.replace(/^sha256:/u, ""), pages: [], jobs: [],
          narrationReady: true, audioReady: assessmentMedia.ready, teachingReady: assessmentMedia.ready, videoReady: true, assessmentMedia };
      }
      const result = await this.media.execute(sessionId, name, input, canDispatch);
      if (name === "courseware_media_context" && this.assessments && record(result)) {
        const assessments = await this.assessments.execute(sessionId, { mode: "context" }, canDispatch);
        return { ...result, assessmentMedia: assessments, teachingReady: result.teachingReady === true && "ready" in assessments && assessments.ready };
      }
      return result;
    }
    if (["courseware_narration_context", "courseware_narration_propose"].includes(name)) {
      if (!this.narration) throw new Error("Saved courseware narration is unavailable");
      return this.narration.execute(sessionId, name, input, canDispatch);
    }
    if (name === "courseware_requirements_update") {
      if (!view.task || Object.keys(input).sort().join(",") !== "educationContext,expectedEducationContext")
        throw new Error("Invalid teaching requirements update");
      await host.call("courseware.task.updateEducation", { ...input, sessionId }); check();
      return this.read(sessionId, canDispatch);
    }
    const images = new CoursewareSceneImages(() => this.getHost(),
      () => { check(); return sessionId; }, () => !canDispatch(), this.auth, this.generation?.planVisualMaster, this.generation?.layerFallback);
    if (name === "courseware_workflow_get") {
      if (Object.keys(input).length) throw new Error("Unexpected workflow read arguments");
      if (!view.plan || view.plan.approvedSha256 !== view.plan.sha256) return { ...view, images: [], models: [], blockers: [] };
      const rows = await images.list({ sessionId }); check();
      const models = await images.models({ sessionId }); check();
      const firstVisualPage = view.plan.pages.find(page => !page.quiz && !page.teaching?.question);
      const cover = rows.find(row => row.current && row.planSha256 === view.plan!.sha256 &&
        row.pageId === firstVisualPage?.pageId && row.target.kind === "visualMaster" && row.selected && row.asset);
      return { ...view, images: rows, models, blockers: sceneAssetBlockers(view.plan, rows),
        styleConfirmed: !firstVisualPage || !!cover, requiresHumanSelection: !cover && rows.some(row => row.current &&
          row.planSha256 === view.plan!.sha256 && row.pageId === firstVisualPage?.pageId && row.target.kind === "visualMaster" && row.asset) };
    }
    if (view.task?.taskType !== "scene" || view.task.generated || !view.plan || view.plan.sha256 !== view.plan.approvedSha256)
      throw new Error("Review and approve the current scene plan in Chat before preparing assets or compiling");
    const rows = await images.list({ sessionId }); check();
    const firstPage = view.plan.pages.find(page => !page.quiz && !page.teaching?.question)?.pageId;
    const styleConfirmed = !firstPage || rows.some(row => row.current && row.planSha256 === view.plan!.sha256 &&
      row.pageId === firstPage && row.target.kind === "visualMaster" && row.selected && row.asset);
    const canGenerate = (pageId: unknown, target: unknown) => {
      if (!styleConfirmed && (pageId !== firstPage || !record(target) || target.kind !== "visualMaster"))
        throw new Error("Preview and confirm the first page visual master style before generating other pages or layers");
    };
    const finishImage = async (initial: CoursewareSceneImageView) => {
      let image = initial;
      check();
      if (!image.current || image.planSha256 !== view.plan!.sha256) throw new Error("Scene plan changed; read the current workflow");
      if (!image.asset && image.decomposition && image.task?.state === "failed") {
        canGenerate(image.pageId, image.target);
        image = await images.fallback({ sessionId, intentId: image.intentId }); check();
      }
      if (!image.asset && image.task?.state === "ready" && image.task.feeState === "settled") {
        image = (await images.archive({ sessionId, intentId: image.intentId })).image; check();
      }
      if (!image.asset) return { image, styleConfirmed, requiresHumanSelection: false, requiresGeneration: image.phase === "prepared",
        recovery: coursewareMediaRecovery({ image }), waitingFor: coursewareMediaRecovery({ image }) === "pending" ? "service" : null };
      if (image.selected && !image.decomposition) return { image, styleConfirmed, requiresHumanSelection: false };
      if (image.pageId === firstPage && image.target.kind === "visualMaster")
        return { image, styleConfirmed: false, requiresHumanSelection: true };
      if (!styleConfirmed) return { image, styleConfirmed: false, requiresHumanSelection: false, waitingFor: "coverStyle" };
      const candidates = await images.list({ sessionId }); check();
      const group = candidates.filter(row => row.current && row.planSha256 === view.plan!.sha256 && row.asset &&
        (row.intentId === image.intentId || image.decomposition && row.intentId.startsWith(`${image.intentId}-layer-`)));
      for (const row of group) {
        check();
        const current = await images.list({ sessionId }); check();
        const peers = current.filter(peer => peer.current && peer.planSha256 === row.planSha256 && peer.pageId === row.pageId &&
          peer.target.kind === row.target.kind && (row.target.kind !== "layer" || peer.target.kind === "layer" && peer.target.name === row.target.name));
        const previous = peers.find(peer => peer.selected);
        if (previous?.intentId === row.intentId) continue;
        if (peers.at(-1)?.intentId !== row.intentId) throw new Error("Newer scene asset exists; refresh the latest saved image job");
        await images.adopt({ sessionId, intentId: row.intentId, expectedSelectedIntentId: previous?.intentId ?? null }); check();
      }
      const selected = await images.list({ sessionId }); check();
      image = selected.find(row => row.intentId === image.intentId) ?? image;
      return { image, styleConfirmed, requiresHumanSelection: false };
    };
    if (name === "courseware_scene_image_prepare") {
      canGenerate(input.pageId, input.target);
      const image = await images.prepare({ ...input, sessionId }); check();
      const submitted = image.phase === "prepared" ? await images.generate({ sessionId, intentId: image.intentId }) :
        await images.status({ sessionId, intentId: image.intentId });
      check();
      return finishImage(submitted);
    }
    if (name === "courseware_scene_image_refresh") {
      if (!Object.hasOwn(input, "intentId") || Object.keys(input).some(key => !["intentId", "generatePrepared", "waitForUpdate", "retryFailed", "generateRemaining"].includes(key)) ||
          [input.generatePrepared, input.waitForUpdate, input.retryFailed, input.generateRemaining].some(value => value !== undefined && typeof value !== "boolean") ||
          input.retryFailed === true && input.generatePrepared === true ||
          input.generateRemaining === true && [input.retryFailed, input.generatePrepared, input.waitForUpdate].some(value => value === true)) throw new Error("Invalid image refresh arguments");
      let image = await images.status({ intentId: input.intentId, sessionId }); check();
      if (input.generateRemaining === true) {
        if (!styleConfirmed || !image.current || !image.selected || !image.asset || image.planSha256 !== view.plan.sha256 ||
            image.pageId !== firstPage || image.target.kind !== "visualMaster")
          throw new Error("Confirm the current first-page visual master before generating all scene images");
        if (this.imagePipelines.has(sessionId)) throw new Error("Scene image pipeline is already running for this Chat");
        this.imagePipelines.add(sessionId);
        const coverIntentId = image.intentId, coverSha256 = image.asset.sha256;
        try {
          const currentImages = async () => {
            const latest = await this.read(sessionId, canDispatch); check();
            if (latest.plan?.sha256 !== view.plan!.sha256 || latest.plan.approvedSha256 !== view.plan!.sha256 || latest.task?.generated)
              throw new Error("Scene plan changed; read the current workflow");
            const current = await images.list({ sessionId }); check();
            if (!current.some(row => row.intentId === coverIntentId && row.current && row.selected && row.asset?.sha256 === coverSha256))
              throw new Error("First-page style selection changed; read the current workflow");
            return current;
          };
          const pipeline = await runSceneImagePipeline(view.plan, {
            check, images: currentImages,
            execute: async (operation, parameters) => {
              await currentImages();
              return await this.execute(sessionId, operation, parameters, canDispatch) as { image: CoursewareSceneImageView };
            },
          });
          return { image, styleConfirmed: true, requiresHumanSelection: false, pipeline };
        } finally { this.imagePipelines.delete(sessionId); }
      }
      if (input.retryFailed === true && !(image.decomposition && image.task?.state === "failed")) {
        if (!image.current || image.planSha256 !== view.plan.sha256) throw new Error("Scene plan changed; read the current workflow");
        canGenerate(image.pageId, image.target);
        image = await images.retry({ intentId: input.intentId, sessionId }); check();
        image = image.phase === "prepared" ? await images.generate({ sessionId, intentId: image.intentId }) :
          await images.status({ sessionId, intentId: image.intentId });
        check();
      }
      for (let attempt = 0; input.waitForUpdate === true && attempt < 10 && !image.asset &&
          image.current && image.planSha256 === view.plan.sha256 && !image.task?.errorCode &&
          (image.task?.state === "ready" ? image.task.feeState !== "settled" :
            ["queued", "submitting", "submitted", "archiving"].includes(image.task?.state ?? image.phase)); attempt++) {
        await delay(3000); check();
        image = await images.status({ intentId: image.intentId, sessionId }); check();
      }
      if (!image.current || image.planSha256 !== view.plan.sha256) throw new Error("Scene plan changed; read the current workflow");
      if (input.generatePrepared === true && image.phase === "prepared") {
        canGenerate(image.pageId, image.target);
        image = await images.generate({ sessionId, intentId: image.intentId }); check();
      }
      return finishImage(image);
    }
    if (name === "courseware_scene_compile") {
      if (Object.keys(input).some(key => !["planSha256", "continueTeaching"].includes(key)) || input.planSha256 !== view.plan.sha256 ||
          input.continueTeaching !== undefined && typeof input.continueTeaching !== "boolean")
        throw new Error("Scene plan changed; read the current workflow");
      if (this.compiling) throw new Error("Courseware compilation is already running");
      this.compiling = true;
      this.compilation = { sessionId, planSha256: view.plan.sha256, state: "running" };
      try {
        const result = await new CoursewareSceneGeneration(images, this.generation).generate({ planSha256: input.planSha256, sessionId });
        check();
        if (!result.path) {
          const saved = await this.read(sessionId, canDispatch);
          check();
          if (!saved.task?.canonicalProjectId || !saved.task.generated) throw new Error("Compilation returned no saved editable courseware");
          return { generated: true, openClassroomRequired: true, canonicalProjectId: saved.task.canonicalProjectId };
        }
        return { generated: true, openEditorRequired: true };
      } catch (error) {
        this.compilation = { sessionId, planSha256: view.plan.sha256,
          state: !canDispatch() || /CANCELLED|cancelled|turn ended/.test(String(error)) ? "stopped" : "failed", message: String(error) };
        throw error;
      } finally { this.compiling = false; if (this.compilation?.state === "running") this.compilation = undefined; }
    }
    throw new Error("Unsupported courseware workflow tool");
  }
}
