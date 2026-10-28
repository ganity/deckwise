import type { AgentToolResult, AgentTurnContext } from "@earendil-works/pi-agent-core";
import { LocalRequestError } from "@earendil-works/pi-ai";
import { delayWithAbort } from "./provider-retry.js";

const record = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);
const pending = (image: Record<string, unknown>) => image.current === true && !image.selected &&
  !["prepared", "rejected"].includes(String(image.phase));

/** Saved scene jobs, rather than a model's closing prose, own completion. */
export class CoursewareTurnContinuation {
  private active = false;
  private planSha256?: string;
  private lastResume?: string;
  private savedGoal?: "course" | "jobs";
  private sourceSha256?: string;

  reset(): void {
    this.active = false;
    this.planSha256 = undefined;
    this.lastResume = undefined;
    this.savedGoal = undefined;
    this.sourceSha256 = undefined;
  }

  private matchesPlan(snapshot: Record<string, unknown>): boolean {
    const { task, plan } = snapshot;
    return record(task) && task.taskType === "scene" && !task.generated && record(plan) &&
      plan.sha256 === this.planSha256 && plan.approvedSha256 === plan.sha256;
  }

  private observe(turn: AgentTurnContext): void {
    for (const result of turn.toolResults) {
      if (!result.toolName.startsWith("courseware_")) continue;
      if (result.isError) { this.reset(); continue; }
      const value: unknown = result.details;
      if (!record(value)) continue;
      const call = turn.message.content.find(block => block.type === "toolCall" && block.id === result.toolCallId);
      if (result.toolName === "courseware_scene_compile" && value.generated === true) {
        if (call?.type !== "toolCall" || call.arguments.continueTeaching !== true) { this.reset(); continue; }
        this.active = true;
        this.savedGoal = "course";
      }
      if (result.toolName === "courseware_media_context" && call?.type === "toolCall" && call.arguments.continueTeaching === true) {
        this.active = true;
        this.savedGoal = "course";
        this.sourceSha256 = String(value.sourceSha256);
      }
      if ((result.toolName === "courseware_media_prepare" || result.toolName === "courseware_media_refresh" &&
          call?.type === "toolCall" && call.arguments.waitForUpdate === true) && record(value.job)) {
        this.active = true;
        this.savedGoal ??= "jobs";
        this.sourceSha256 = String(value.job.sourceSha256);
      }
      if (result.toolName === "courseware_workflow_get") {
        const { task, plan } = value;
        // A status-only request must not start generation or compilation.
        this.active = this.active && record(task) && (this.savedGoal ? task.generated === true || task.imported === true :
          task.taskType === "scene" && !task.generated && record(plan) && plan.sha256 === this.planSha256 && plan.approvedSha256 === plan.sha256);
      }
      const requested = result.toolName === "courseware_scene_image_prepare" ||
        call?.type === "toolCall" && (call.arguments.waitForUpdate === true || call.arguments.generatePrepared === true);
      if ((this.active || requested) &&
          ["courseware_scene_image_prepare", "courseware_scene_image_refresh"].includes(result.toolName) && record(value.image)) {
        this.active = value.requiresHumanSelection !== true &&
          (value.styleConfirmed === true || value.waitingFor === "service");
        this.planSha256 = String(value.image.planSha256);
      }
    }
  }

  async finish(turn: AgentTurnContext, controls: {
    execute: (name: string, args: Record<string, unknown>, signal?: AbortSignal) => Promise<AgentToolResult<unknown>>;
    canWait: () => boolean;
  }, signal?: AbortSignal): Promise<string | undefined> {
    this.observe(turn);
    if (!this.active || turn.message.stopReason === "error" || turn.message.stopReason === "aborted" ||
        turn.message.content.some(block => block.type === "toolCall") || !controls.canWait()) return;
    const execute = async (name: string, args: Record<string, unknown>) => {
      signal?.throwIfAborted();
      let result: AgentToolResult<unknown>;
      try { result = await controls.execute(name, args, signal); }
      catch (cause) {
        signal?.throwIfAborted();
        throw new LocalRequestError("request-preparation", { cause });
      }
      signal?.throwIfAborted();
      if (!record(result.details)) throw new LocalRequestError("context-validation");
      return result.details;
    };
    if (this.savedGoal) return this.finishSaved(execute, controls.canWait, signal);
    let snapshot = await execute("courseware_workflow_get", {});
    while (controls.canWait()) {
      if (!this.matchesPlan(snapshot)) { this.reset(); return; }
      if (!Array.isArray(snapshot.images)) throw new LocalRequestError("context-validation");
      const images = snapshot.images.filter((image): image is Record<string, unknown> => record(image) &&
        image.planSha256 === this.planSha256 && pending(image));
      if (snapshot.requiresHumanSelection === true) {
        this.reset();
        return this.resume(snapshot);
      }
      if (!images.length) {
        if (snapshot.styleConfirmed !== true) { this.reset(); return; }
        return this.resume(snapshot);
      }
      let progressed = false;
      for (const image of images) {
        if (!controls.canWait()) return;
        const value = await execute("courseware_scene_image_refresh", { intentId: image.intentId });
        if (!controls.canWait()) return;
        if (!record(value.image)) throw new LocalRequestError("context-validation");
        if (value.requiresHumanSelection === true) {
          this.reset();
          return this.resume(value);
        }
        if (value.image.asset) progressed = true;
        else if (value.waitingFor !== "service") {
          this.reset();
          return "The courseware job cannot advance. Report this actual failure or missing precondition; " +
            "do not claim completion, request confirmation, or submit a replacement for an unknown job.\n" + JSON.stringify(value);
        }
      }
      if (progressed) {
        snapshot = await execute("courseware_workflow_get", {});
        if (!controls.canWait()) return;
        if (!this.matchesPlan(snapshot)) { this.reset(); return; }
        return this.resume(snapshot);
      }
      await delayWithAbort(3000, signal);
    }
  }

  private async finishSaved(execute: (name: string, args: Record<string, unknown>) => Promise<Record<string, unknown>>,
    canWait: () => boolean, signal?: AbortSignal): Promise<string | undefined> {
    while (canWait()) {
      const snapshot = await execute("courseware_media_context", {});
      if (!canWait()) return;
      if (typeof snapshot.sourceSha256 !== "string" || !Array.isArray(snapshot.jobs)) throw new LocalRequestError("context-validation");
      if (this.sourceSha256 && snapshot.sourceSha256 !== this.sourceSha256) { this.reset(); return; }
      this.sourceSha256 = snapshot.sourceSha256;
      if (!snapshot.jobs.length) {
        if (this.savedGoal === "jobs" || snapshot.narrationReady === true && snapshot.audioReady === true && snapshot.teachingReady === true && snapshot.videoReady !== false) { this.reset(); return; }
        return this.resume(snapshot);
      }
      let progressed = false;
      for (const job of snapshot.jobs) {
        if (!record(job) || !["tts", "music", "video"].includes(String(job.kind)) || job.sourceSha256 !== this.sourceSha256)
          throw new LocalRequestError("context-validation");
        if (!canWait()) return;
        const result = await execute("courseware_media_refresh", job);
        if (!canWait()) return;
        if (result.saved === true) progressed = true;
        else if (result.waitingFor !== "service") {
          this.reset();
          return "The original media job could not finish. Report its actual state and error; do not claim completion, ask for confirmation, or submit a replacement.\n" + JSON.stringify(result);
        }
      }
      if (progressed) return this.resume(await execute("courseware_media_context", {}));
      await delayWithAbort(3000, signal);
    }
  }

  private resume(snapshot: Record<string, unknown>): string {
    const state = JSON.stringify(snapshot);
    if (state === this.lastResume) throw new LocalRequestError("request-preparation", {
      cause: new Error("COURSEWARE_WORKFLOW_NO_PROGRESS: unfinished courseware cannot be reported as completed"),
    });
    this.lastResume = state;
    return "The authorized courseware request is unfinished. The runtime queried the saved jobs while keeping this Chat active. " +
      "This snapshot belongs to the current user turn; newer tool results supersede it. " +
      "Use this actual state to perform the next missing step now. Only an unselected first-page style needs user review. " +
      "Generate missing independent assets, decompose selected masters, or compile when no blockers remain. " +
      "Compilation is an intermediate PPTX state. For a complete course, generate and save missing detailed narration with courseware_narration_propose, " +
      "then create missing speech audio with courseware_media_prepare using the real catalog and speech IDs. Preserve existing narration/audio. " +
      "Both kindergarten and primary courses need their planned teaching actions, interaction, animation, highlight and spotlight, synchronized with actual audio and mapped objects. " +
      "Scene mode shares these capabilities across stages; complete video or music only when required by the course plan. A wait is not an assessment, a draft is not executable media, and audio readiness alone is not full MAIC parity. " +
      "For required video, create a video block with courseware_narration_propose, then use courseware_media_context(kind:video) and courseware_media_prepare(kind:video, actionId:<saved video_slot ID>) with a configured model. Use courseware_media_context to check actual actions and teachingReady, videoReady and audioReady. Finish required media, archive and mount its real output before reporting completion. Return the editable PPTX and teaching data; do not capture a publication snapshot or build PPTist until the user publishes. " +
      "Query original pending intents; do not create replacements for unknown submissions.\n" + state;
  }
}
