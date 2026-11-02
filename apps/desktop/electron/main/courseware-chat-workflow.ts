import { coursewareMediaRecovery } from "@pi-desktop/shared";
import { setTimeout as delay } from "node:timers/promises";
import { sceneAssetBlockers, type CoursewareEducationContext, type CoursewareSceneImageView, type CoursewareWorkflowView } from "@pi-desktop/shared";
import type { DesktopAuthSession } from "./auth-session";
import { readSceneCourseDraft } from "./courseware-scene-draft";
import { CoursewareSceneImages } from "./courseware-scene-images";
import { CoursewareSceneGeneration, type SceneCourseGenerationServices } from "./courseware-scene-generation";

type Host = { call<T>(method: string, params: unknown): Promise<T> };
type Task = { taskType: "plain" | "scene" | "import"; educationContext?: CoursewareEducationContext;
  importPath?: string; generatedPath?: string };
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);

function assertWorkflowScope(host: Host | null, currentHost: Host | null, sessionId: string, viewingSession: string | null, canDispatch?: () => boolean) {
  if (!host || currentHost !== host) throw new Error("Courseware runtime changed; read saved workflow before continuing");
  if (!canDispatch && viewingSession !== sessionId) throw new Error("Courseware conversation changed; return to this Chat and read saved workflow");
  if (canDispatch && !canDispatch()) throw new Error("Courseware Chat turn ended or was cancelled; read saved workflow in a new turn");
}

/** Main Chat and panel reuse the same durable jobs; image generation keeps billing internal and preserves first-page style review. */
export class CoursewareChatWorkflow {
  private compiling = false;
  private compilation?: { sessionId: string } & NonNullable<CoursewareWorkflowView["compilation"]>;
  narration?: { execute(sessionId: string, name: string, args: unknown, canDispatch: () => boolean): Promise<unknown> };
  media?: { execute(sessionId: string, name: string, args: unknown, canDispatch: () => boolean): Promise<unknown> };
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
    const { plan } = task?.taskType === "scene" && !task.generatedPath
      ? await readSceneCourseDraft(host, { sessionId }) : { plan: null };
    check();
    const compilation = this.compilation?.sessionId === sessionId && this.compilation.planSha256 === plan?.sha256
      ? { planSha256: this.compilation.planSha256, state: this.compilation.state, ...(this.compilation.message ? { message: this.compilation.message } : {}) } : undefined;
    return { ...(compilation ? { compilation } : {}), task: task ? { taskType: task.taskType, ...(task.educationContext ? { educationContext: task.educationContext } : {}),
      imported: !!task.importPath, generated: !!task.generatedPath,
      ...((task.generatedPath ?? task.importPath) ? { sourcePath: task.generatedPath ?? task.importPath } : {}) } : null, plan };
  }

  async execute(sessionId: string, name: string, args: unknown, canDispatch: () => boolean) {
    if (!record(args)) throw new Error("Invalid courseware workflow arguments");
    const input = structuredClone(args), host = this.getHost();
    const check = () => assertWorkflowScope(host, this.getHost(), sessionId, this.getViewingSession(), canDispatch);
    const view = await this.read(sessionId, canDispatch);
    check();
    if (!host) throw new Error("Host is unavailable");
    const { session } = await host.call<{ session?: { mode?: string } }>("session.get", { id: sessionId, messageLimit: 1 });
    check();
    if (session?.mode !== "agent") throw new Error("Courseware workflow tools require Agent mode");
    if (name === "courseware_scene_plan_submit") {
      if (Object.keys(input).length || view.task?.taskType !== "scene" || view.task.generated || !view.plan)
        throw new Error("Write a valid scene plan for this ungenerated Chat before submitting it");
      return { validated: true, awaitingPlanApproval: view.plan.approvedSha256 !== view.plan.sha256, ...view };
    }
    if (name.startsWith("courseware_media_")) {
      if (!this.media) throw new Error("Saved courseware media is unavailable");
      return this.media.execute(sessionId, name, input, canDispatch);
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
      () => { check(); return sessionId; }, () => !canDispatch(), this.auth);
    if (name === "courseware_workflow_get") {
      if (Object.keys(input).length) throw new Error("Unexpected workflow read arguments");
      if (!view.plan || view.plan.approvedSha256 !== view.plan.sha256) return { ...view, images: [], models: [], blockers: [] };
      const rows = await images.list({ sessionId }); check();
      const models = await images.models({ sessionId }); check();
      const cover = rows.find(row => row.current && row.planSha256 === view.plan!.sha256 &&
        row.pageId === view.plan!.pages[0].pageId && row.target.kind === "visualMaster" && row.selected && row.asset);
      return { ...view, images: rows, models, blockers: sceneAssetBlockers(view.plan, rows),
        styleConfirmed: !!cover, requiresHumanSelection: !cover && rows.some(row => row.current &&
          row.planSha256 === view.plan!.sha256 && row.pageId === view.plan!.pages[0].pageId && row.target.kind === "visualMaster" && row.asset) };
    }
    if (view.task?.taskType !== "scene" || view.task.generated || !view.plan || view.plan.sha256 !== view.plan.approvedSha256)
      throw new Error("Review and approve the current scene plan in Chat before preparing assets or compiling");
    const rows = await images.list({ sessionId }); check();
    const firstPage = view.plan.pages[0].pageId;
    const styleConfirmed = rows.some(row => row.current && row.planSha256 === view.plan!.sha256 &&
      row.pageId === firstPage && row.target.kind === "visualMaster" && row.selected && row.asset);
    const canGenerate = (pageId: unknown, target: unknown) => {
      if (!styleConfirmed && (pageId !== firstPage || !record(target) || target.kind !== "visualMaster"))
        throw new Error("Preview and confirm the first page visual master style before generating other pages or layers");
    };
    const finishImage = async (initial: CoursewareSceneImageView) => {
      let image = initial;
      check();
      if (!image.current || image.planSha256 !== view.plan!.sha256) throw new Error("Scene plan changed; read the current workflow");
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
        if (row.selected) continue;
        const previous = candidates.find(peer => peer.current && peer.selected && peer.pageId === row.pageId &&
          peer.target.kind === row.target.kind && (row.target.kind !== "layer" || peer.target.kind === "layer" && peer.target.name === row.target.name));
        if (previous) throw new Error("Scene asset selection changed; review the current image before replacing it");
        await images.adopt({ sessionId, intentId: row.intentId, expectedSelectedIntentId: null }); check();
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
      if (!Object.hasOwn(input, "intentId") || Object.keys(input).some(key => !["intentId", "generatePrepared", "waitForUpdate", "retryFailed"].includes(key)) ||
          [input.generatePrepared, input.waitForUpdate, input.retryFailed].some(value => value !== undefined && typeof value !== "boolean") ||
          input.retryFailed === true && input.generatePrepared === true) throw new Error("Invalid image refresh arguments");
      let image = await images.status({ intentId: input.intentId, sessionId }); check();
      if (input.retryFailed === true) {
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
        if (!result.path) throw new Error("Compilation returned no editable PPTX");
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
