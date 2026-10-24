import { sceneAssetBlockers, type CoursewareEducationContext, type CoursewareWorkflowView } from "@pi-desktop/shared";
import type { DesktopAuthSession } from "./auth-session";
import { readSceneCourseDraft } from "./courseware-scene-draft";
import { CoursewareSceneImages } from "./courseware-scene-images";
import { CoursewareSceneGeneration, type SceneCourseGenerationServices } from "./courseware-scene-generation";

type Host = { call<T>(method: string, params: unknown): Promise<T> };
type Task = { taskType: "plain" | "scene" | "import"; educationContext?: CoursewareEducationContext;
  importPath?: string; generatedPath?: string };
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);

/** Main Chat and panel reuse the same durable jobs; model tools never grant paid submission or human approval. */
export class CoursewareChatWorkflow {
  private compiling = false;
  constructor(private getHost: () => Host | null, private getViewingSession: () => string | null,
    private auth: Pick<DesktopAuthSession, "getCoursewarePrincipal" | "coursewareMedia">,
    private generation: SceneCourseGenerationServices) {}

  async read(sessionId: string, canDispatch: () => boolean = () => true): Promise<CoursewareWorkflowView> {
    const host = this.getHost();
    const check = () => {
      if (!host || this.getHost() !== host || this.getViewingSession() !== sessionId || !canDispatch())
        throw new Error("Courseware conversation changed or turn ended");
    };
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
    return { task: task ? { taskType: task.taskType, ...(task.educationContext ? { educationContext: task.educationContext } : {}),
      imported: !!task.importPath, generated: !!task.generatedPath } : null, plan };
  }

  async execute(sessionId: string, name: string, args: unknown, canDispatch: () => boolean) {
    if (!record(args)) throw new Error("Invalid courseware workflow arguments");
    const input = structuredClone(args), host = this.getHost();
    const check = () => {
      if (!host || this.getHost() !== host || this.getViewingSession() !== sessionId || !canDispatch())
        throw new Error("Courseware conversation changed or turn ended");
    };
    const view = await this.read(sessionId, canDispatch);
    check();
    if (!host) throw new Error("Host is unavailable");
    const { session } = await host.call<{ session?: { mode?: string } }>("session.get", { id: sessionId, messageLimit: 1 });
    check();
    if (session?.mode !== "agent") throw new Error("Courseware workflow tools require Agent mode");
    if (name === "courseware_requirements_update") {
      if (!view.task || Object.keys(input).sort().join(",") !== "educationContext,expectedEducationContext")
        throw new Error("Invalid teaching requirements update");
      await host.call("courseware.task.updateEducation", { ...input, sessionId }); check();
      return this.read(sessionId, canDispatch);
    }
    const images = new CoursewareSceneImages(() => this.getHost(),
      () => { check(); return this.getViewingSession(); }, () => !canDispatch(), this.auth);
    if (name === "courseware_workflow_get") {
      if (Object.keys(input).length) throw new Error("Unexpected workflow read arguments");
      if (!view.plan || view.plan.approvedSha256 !== view.plan.sha256) return { ...view, images: [], models: [], blockers: [] };
      const rows = await images.list({ sessionId }); check();
      const models = await images.models({ sessionId }); check();
      return { ...view, images: rows, models, blockers: sceneAssetBlockers(view.plan, rows) };
    }
    if (view.task?.taskType !== "scene" || view.task.generated || !view.plan || view.plan.sha256 !== view.plan.approvedSha256)
      throw new Error("Review and approve the current scene plan in Chat before preparing assets or compiling");
    if (name === "courseware_scene_image_prepare") {
      const image = await images.prepare({ ...input, sessionId }); check();
      return { image, requiresHumanCostConfirmation: image.phase === "prepared" };
    }
    if (name === "courseware_scene_image_refresh") {
      if (Object.keys(input).join(",") !== "intentId") throw new Error("Invalid image refresh arguments");
      const image = await images.status({ ...input, sessionId }); check();
      if (!image.asset && image.task?.state === "ready" && image.task.feeState === "settled") {
        const archived = await images.archive({ ...input, sessionId }); check();
        return { image: archived.image, requiresHumanSelection: !archived.image.selected };
      }
      return { image };
    }
    if (name === "courseware_scene_compile") {
      if (Object.keys(input).join(",") !== "planSha256" || input.planSha256 !== view.plan.sha256)
        throw new Error("Scene plan changed; read the current workflow");
      if (this.compiling) throw new Error("Courseware compilation is already running");
      this.compiling = true;
      try {
        const result = await new CoursewareSceneGeneration(images, this.generation).generate({ ...input, sessionId });
        check();
        if (!result.path) throw new Error("Compilation returned no editable PPTX");
        return { generated: true, openEditorRequired: true };
      } finally { this.compiling = false; }
    }
    throw new Error("Unsupported courseware workflow tool");
  }
}
