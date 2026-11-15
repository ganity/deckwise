import { coursewareMediaRecovery } from "@pi-desktop/shared";
import type { AgentToolResult, AgentTurnContext } from "@earendil-works/pi-agent-core";
import { LocalRequestError } from "@earendil-works/pi-ai";
import { createHash } from "node:crypto";
import type { CoursewareWorkflowCheckpoint } from "@pi-desktop/shared";
import { CoursewareWorkflowError, coursewareFailureRecovery } from "./courseware-workflow-recovery.js";
import { coursewareStatusSummary } from "./courseware-workflow-tools.js";
import { delayWithAbort } from "./provider-retry.js";

const record = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);
const scenePlanPath = (value: unknown): boolean => typeof value === "string" &&
  /(?:^|[\\/])\.deckwise-ppt[\\/]scenes[\\/][A-Za-z0-9_-]+[\\/]plan\.json$/u.test(value);
const pending = (image: Record<string, unknown>) => image.current === true && !image.selected &&
  !["prepared", "rejected"].includes(String(image.phase));

type Checkpoints = {
  read(projectId: string): Promise<{ checkpoint: CoursewareWorkflowCheckpoint | null; completion: unknown }>;
  write(checkpoint: CoursewareWorkflowCheckpoint, expectedRevision: number): Promise<void>;
};
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const progressKey = (value: unknown) => digest(JSON.parse(JSON.stringify(value, (key, field) =>
  ["teachingRevision", "revision", "timestamp", "updatedAt", "lastRepairFailure"].includes(key) ? undefined : field)));

/** Saved scene jobs, rather than a model's closing prose, own completion. */
export class CoursewareTurnContinuation {
  private active = false;
  private planning = false;
  private planValidationFailures = 0;
  private lastPlanWrite?: string;
  private planRepeatedFailures = 0;
  private planRepairPending = false;
  private planSha256?: string;
  private lastResume?: string;
  private savedGoal?: "course" | "jobs";
  private sourceSha256?: string;
  private qualityRepairs = new Map<string, number>();
  private restored = false;
  private blockedJobs = new Map<string, Record<string, unknown>>();
  private progress?: string;
  private progressedAt = 0;
  private stopped = false;
  private reportRetryUsed = false;
  private imageRetries = new Set<string>();
  private mediaRetries = new Set<string>();
  private assessmentJobs = new Map<string, Record<string, unknown>>();
  private coursewareTask = false;
  private previewReads = new Map<string, number>();
  private previewBlocked = false;
  private previewStalled = false;

  get reportOnly(): boolean { return this.stopped; }

  draftWriteError(name: string, args: Record<string, unknown>): string | undefined {
    if (this.previewBlocked && name === "Browser" && ["screenshot", "snapshot", "console"].includes(String(args.action)))
      return "Repeated unchanged preview reads are blocked. Use an actual page click/navigation, repair the existing SVG, or continue finalize/export from the saved project. A URL hash alone may not change the displayed slide. After five identical previews, fix the existing source before another visual read. Do not create another project.";
    if (!scenePlanPath(args.path ?? args.file_path)) return;
    if (name === "Edit" && this.planRepairPending)
      return "The scene draft failed validation. Read the current draft and use one complete Write with corrected JSON, preserving all required fields and user requirements. Partial Edit repairs are disabled until validation succeeds.";
    if (name === "Write" && typeof args.content === "string") {
      try { JSON.parse(args.content); }
      catch (error) { return `Scene plan was not written: invalid JSON. Use one complete Write with valid JSON. ${String(error)}`; }
    }
  }

  private stop(): void { this.active = false; this.stopped = true; }

  private takeRepairBudget(issues: unknown[], kind: "required" | "advisory"): boolean {
    const legacy = digest(issues.map(issue => record(issue) ? [issue.pageId, issue.code, issue.repair] : null));
    const keys = [...new Set(issues.map(issue => record(issue) ? digest([kind, issue.pageId, issue.code, issue.repair]) : legacy))];
    const previous = this.qualityRepairs.get(legacy) ?? 0;
    if (previous >= 2 || keys.some(key => (this.qualityRepairs.get(key) ?? 0) >= 2) ||
        new Set([...this.qualityRepairs.keys(), ...keys]).size > 100) return false;
    // Fixing one page or reordering diagnostics cannot renew another page's durable budget.
    for (const key of keys) this.qualityRepairs.set(key, Math.max(previous, this.qualityRepairs.get(key) ?? 0) + 1);
    return true;
  }

  reset(): void {
    this.active = false;
    this.planning = false;
    this.planValidationFailures = 0;
    this.lastPlanWrite = undefined;
    this.planRepeatedFailures = 0;
    this.planRepairPending = false;
    this.planSha256 = undefined;
    this.lastResume = undefined;
    this.savedGoal = undefined;
    this.sourceSha256 = undefined;
    this.qualityRepairs.clear();
    this.restored = false;
    this.blockedJobs.clear();
    this.progress = undefined;
    this.progressedAt = 0;
    this.stopped = false;
    this.reportRetryUsed = false;
    this.imageRetries.clear();
    this.mediaRetries.clear();
    this.assessmentJobs.clear();
    this.coursewareTask = false;
    this.previewReads.clear();
    this.previewBlocked = false;
    this.previewStalled = false;
  }

  private matchesPlan(snapshot: Record<string, unknown>): boolean {
    const { task, plan } = snapshot;
    return record(task) && task.taskType === "scene" && !task.generated && record(plan) &&
      plan.sha256 === this.planSha256 && plan.approvedSha256 === plan.sha256;
  }

  private observe(turn: AgentTurnContext): void {
    for (const result of turn.toolResults) {
      const write = turn.message.content.find(block => block.type === "toolCall" && block.id === result.toolCallId);
      if (!result.isError && result.toolName === "courseware_workflow_get" && record(result.details) && record(result.details.task)) this.coursewareTask = true;
      if (this.coursewareTask && !result.isError) {
        if (["Write", "Edit"].includes(result.toolName)) { this.previewReads.clear(); this.previewBlocked = false; }
        if (result.toolName === "Browser" && write?.type === "toolCall") {
          if (["navigate", "click", "fill", "evaluate", "cdp"].includes(String(write.arguments.action)) &&
              ![...this.previewReads.values()].some(count => count >= 5)) this.previewBlocked = false;
          if (write.arguments.action === "screenshot") {
            const images = result.content.filter(block => block.type === "image");
            const key = progressKey(images.length ? images : record(result.details) ? result.details.images ?? result.details : result.content);
            const count = (this.previewReads.get(key) ?? 0) + 1;
            if (this.previewReads.size >= 32 && !this.previewReads.has(key)) this.previewReads.delete(this.previewReads.keys().next().value!);
            this.previewReads.set(key, count);
            if (count >= 3) { this.previewBlocked = true; this.previewStalled = true; }
          }
        }
      }
      const path = write?.type === "toolCall" ? write.arguments.path ?? write.arguments.file_path : undefined;
      // Shell arguments can merely read a reference plan; explicit submission covers shell-authored drafts.
      if (!result.isError && ["Write", "Edit"].includes(result.toolName) && scenePlanPath(path)) {
        const version = digest(write?.type === "toolCall" ? write.arguments : {});
        if (version !== this.lastPlanWrite) {
          if (this.planRepairPending) this.planValidationFailures++;
          this.lastPlanWrite = version;
          this.planRepeatedFailures = 0;
        }
        this.planning = true;
      }
      if (!result.toolName.startsWith("courseware_")) continue;
      if (result.toolName === "courseware_scene_plan_submit" && result.isError) this.planning = true;
      // A failed call does not erase the authorized goal or successful saved jobs.
      if (result.isError) continue;
      const value: unknown = result.details;
      if (!record(value)) continue;
      const call = turn.message.content.find(block => block.type === "toolCall" && block.id === result.toolCallId);
      if (result.toolName === "courseware_media_assessments" && call?.type === "toolCall" && ["prepare", "refresh"].includes(String(call.arguments.mode))) {
        const { mode, projectId, expectedRevision, expectedSourceRevision, ...target } = call.arguments;
        const key = digest(target);
        if (value.state === "adopted") this.assessmentJobs.delete(key);
        else this.assessmentJobs.set(key, { ...call.arguments, mode: "refresh" });
      }
      if (result.toolName === "courseware_scene_plan_submit" && value.awaitingPlanApproval === true) this.planning = true;
      if (["courseware_scene_compile", "courseware_presentation_adopt"].includes(result.toolName) && value.generated === true) {
        const continueTeaching = call?.type === "toolCall" && (result.toolName === "courseware_presentation_adopt"
          ? call.arguments.continueTeaching !== false : call.arguments.continueTeaching === true);
        if (!continueTeaching) { this.reset(); continue; }
        this.active = true;
        this.savedGoal = "course";
        if (typeof value.sourceSha256 === "string") this.sourceSha256 = value.sourceSha256;
      }
      if (result.toolName === "courseware_media_context" && call?.type === "toolCall" && call.arguments.continueTeaching === true) {
        this.active = true;
        this.savedGoal = "course";
        this.sourceSha256 = String(value.sourceSha256);
      }
      if ((result.toolName === "courseware_media_prepare" || result.toolName === "courseware_media_refresh" &&
          call?.type === "toolCall" && (call.arguments.waitForUpdate === true || call.arguments.retryFailed === true)) && (record(value.job) || Array.isArray(value.jobs))) {
        this.active = true;
        this.savedGoal ??= "jobs";
        this.sourceSha256 = String(record(value.job) ? value.job.sourceSha256 : value.sourceSha256);
        if (call?.type === "toolCall" && call.arguments.retryFailed === true && record(value.job)) this.mediaRetries.add(String(value.job.intentId));
      }
      if (result.toolName === "courseware_workflow_get") {
        const { task, plan } = value;
        if (record(task) && (task.generated === true || task.taskType !== "scene")) this.planning = false;
        // A status-only request must not start generation or compilation.
        this.active = this.active && record(task) && (this.savedGoal ? task.generated === true || task.imported === true :
          task.taskType === "scene" && !task.generated && record(plan) && plan.sha256 === this.planSha256 && plan.approvedSha256 === plan.sha256);
      }
      const requested = result.toolName === "courseware_scene_image_prepare" ||
        call?.type === "toolCall" && (call.arguments.waitForUpdate === true || call.arguments.generatePrepared === true || call.arguments.retryFailed === true || call.arguments.generateRemaining === true);
      if ((this.active || requested) &&
          ["courseware_scene_image_prepare", "courseware_scene_image_refresh"].includes(result.toolName) && record(value.image)) {
        this.active = value.requiresHumanSelection !== true &&
          (value.styleConfirmed === true || value.waitingFor === "service");
        this.planSha256 = String(value.image.planSha256);
        if (call?.type === "toolCall" && call.arguments.retryFailed === true) this.imageRetries.add(String(value.image.intentId));
      }
    }
  }

  async finish(turn: AgentTurnContext, controls: {
    execute: (name: string, args: Record<string, unknown>, signal?: AbortSignal) => Promise<AgentToolResult<unknown>>;
    canWait: () => boolean;
    checkpoints?: Checkpoints;
  }, signal?: AbortSignal): Promise<string | undefined> {
    if (this.stopped) {
      if (!this.reportRetryUsed && turn.message.stopReason !== "error" && turn.message.stopReason !== "aborted" &&
          controls.canWait() && turn.message.content.some(block => block.type === "toolCall")) {
        this.reportRetryUsed = true;
        return "The attempted tools in the final reporting pass were blocked; they performed no work and did not undo saved results. Now provide only a plain-language final answer using the latest saved workflow snapshot and its exact acceptance or error. Treat completion.ready and assessmentMedia.ready as authoritative for saved-state checks: report missing media only when the latest snapshot lists it, and keep non-blocking quality diagnostics separate. They do not prove that a fixed build played through every page or that all audio ended naturally. Do not claim playback acceptance unless an actual playback result is available. Do not infer unfinished generation or request another user message merely because a reporting tool was blocked. No tool calls, tool markup, new submissions or claims of unverified completion. This is the final reporting correction.";
      }
      return;
    }
    this.observe(turn);
    if (this.previewStalled && controls.canWait() && turn.message.stopReason !== "error" && turn.message.stopReason !== "aborted") {
      this.previewStalled = false;
      return "Three identical courseware previews show no visual progress. Do not screenshot this unchanged page again. If the page is wrong, repair its existing SVG; if it is correct, continue the same project's finalize/export. To inspect a different slide, click the actual viewer navigation or screenshot its exact SVG path; changing a URL hash is not proof of navigation. Preserve all saved assets and do not restart generation.";
    }
    if (this.planning && controls.canWait() && turn.message.stopReason !== "error" && turn.message.stopReason !== "aborted" &&
        (!turn.message.content.some(block => block.type === "toolCall") || turn.toolResults.some(result =>
          result.toolName === "courseware_scene_plan_submit" || !result.isError && ["Write", "Edit"].includes(result.toolName)))) {
      try {
        const result = [...turn.toolResults].reverse().find(result => result.toolName === "courseware_scene_plan_submit") ??
          await controls.execute("courseware_scene_plan_submit", {}, signal);
        if (result.isError || !record(result.details) || result.details.validated !== true)
          throw new Error(JSON.stringify(result.content));
        this.planRepairPending = false;
        this.planValidationFailures = 0;
        this.planRepeatedFailures = 0;
        if (result.details.awaitingPlanApproval === false) { this.planning = false; return; }
        // Keep tools through post-submit status reads; close on the model's final response without another tool-less pass.
        if (turn.message.content.some(block => block.type === "toolCall")) return;
        this.planning = false;
        this.stop();
        return;
      } catch (error) {
        signal?.throwIfAborted();
        if (!controls.canWait()) return;
        if (this.planValidationFailures >= 2 || ++this.planRepeatedFailures >= 3) {
          this.stop();
          return "Scene planning is unfinished: " + (this.planValidationFailures >= 2 ? "validation still fails after two corrections." : "repeated submission has not corrected the saved draft.") + " Explain the actual error to the user in plain language. Do not output tool calls, tool markup or repair code; no further repair runs in this pass. Do not claim completion or request approval of an invalid draft.\n" + String(error);
        }
        this.planRepairPending = true;
        return "The scene draft is not ready for review. Read this Chat's current plan.json and repair this exact product validation error using one complete Write with valid JSON, preserving all required fields and the user's explicit requirements, then submit again with courseware_scene_plan_submit. Do not resubmit unchanged bytes or use partial Edit repairs. Recheck every constraint, including the saved body-page budget and the user's total-page limit; opening, cover, activity setup and review consume body pages. Merge setup into existing body pages rather than adding a slide to fix an assessment. A file write or JSON parse is not completion.\n" + String(error);
      }
    }
    const readyResult = this.savedGoal ? [...turn.toolResults].reverse().find(result =>
      !result.isError && result.toolName === "courseware_media_context" && record(result.details) &&
      Array.isArray(result.details.jobs) && !result.details.jobs.length &&
      record(result.details.completion) && result.details.completion.ready === true &&
      !(record(result.details.assessmentMedia) && result.details.assessmentMedia.ready === false)) : undefined;
    if (!this.active || turn.message.stopReason === "error" || turn.message.stopReason === "aborted" || !controls.canWait()) return;
    const execute = async (name: string, args: Record<string, unknown>) => {
      signal?.throwIfAborted();
      for (let attempt = 0; ; attempt++) {
        try {
          const result = await controls.execute(name, args, signal);
          signal?.throwIfAborted();
          if (!record(result.details)) throw new LocalRequestError("context-validation");
          return result.details;
        } catch (cause) {
          signal?.throwIfAborted();
          // These calls only reconcile original jobs; prepare/compile are never replayed here.
          if (attempt < 2 && controls.canWait() && ["courseware_workflow_get", "courseware_media_context", "courseware_scene_image_refresh", "courseware_media_refresh"].includes(name) && coursewareFailureRecovery(cause) === "retry-read") {
            await delayWithAbort(1000 * 2 ** attempt, signal);
            if (!controls.canWait()) throw new LocalRequestError("request-preparation", { cause });
            continue;
          }
          if (cause instanceof CoursewareWorkflowError && ["PPT_EDITOR_NOT_READY", "PPT_EDITOR_SAVE_IN_PROGRESS"].includes(cause.code))
            throw new CoursewareWorkflowError(cause.code, "PPT editor is still opening or saving; this task is preserved and can continue when the editor is ready.", name, { cause });
          if (cause instanceof CoursewareWorkflowError)
            throw new CoursewareWorkflowError(cause.code, "Courseware automatic continuation failed.", name, { cause });
          if (record(cause) && ["PPT_EDITOR_NOT_READY", "PPT_EDITOR_SAVE_IN_PROGRESS"].includes(String(cause.code)))
            throw new CoursewareWorkflowError(String(cause.code), "PPT editor is still opening or saving; this task is preserved and can continue when the editor is ready.", name, { cause });
          throw new LocalRequestError("request-preparation", { cause });
        }
      }
    };
    if (this.savedGoal === "jobs" && readyResult && record(readyResult.details)) {
      // A successful final read can close authorized media work without broadening it into course repair.
      this.stop();
      return "Saved courseware checks are complete; report the saved result and any non-blocking diagnostics; full playback acceptance remains unverified unless actual playback evidence is available. Do not call more tools, ask about optional cosmetics, or start new generation.\n" + JSON.stringify(coursewareStatusSummary(readyResult.details));
    }
    if (turn.message.content.some(block => block.type === "toolCall") && !readyResult) {
      // Native-save transactions can only advance lineage for an already persisted checkpoint.
      if (this.savedGoal === "course" && !this.restored && controls.checkpoints)
        return this.finishSaved(execute, controls.canWait, signal, controls.checkpoints, undefined, true);
      return;
    }
    if (this.savedGoal) return this.finishSaved(execute, controls.canWait, signal, this.savedGoal === "course" ? controls.checkpoints : undefined, readyResult?.details as Record<string, unknown> | undefined);
    let snapshot = await execute("courseware_workflow_get", {});
    while (controls.canWait()) {
      if (!this.matchesPlan(snapshot)) { this.reset(); return; }
      if (!Array.isArray(snapshot.images)) throw new LocalRequestError("context-validation");
      const originals = snapshot.images.filter((image): image is Record<string, unknown> => record(image) &&
        image.planSha256 === this.planSha256 && pending(image) && (!this.imageRetries.size || this.imageRetries.has(String(image.intentId))));
      const images = originals.filter(image => !this.blockedJobs.has(String(image.intentId)));
      if (snapshot.requiresHumanSelection === true) { this.reset(); return this.resume(snapshot); }
      snapshot.blockedJobs = [...this.blockedJobs.values()];
      if (!images.length) {
        if (this.imageRetries.size) {
          this.stop();
          return "The explicitly requested image retries have been reconciled. Report only their saved results or remaining failures. A later explicit retry request can authorize another attempt on a confirmed failed job.\n" + JSON.stringify(coursewareStatusSummary({ ...snapshot,
            images: snapshot.images.filter(image => record(image) && this.imageRetries.has(String(image.intentId))) }));
        }
        if (this.blockedJobs.size) {
          const blockers = Array.isArray(snapshot.blockers) ? snapshot.blockers : [];
          const independent = snapshot.styleConfirmed === true && blockers.some(blocker => record(blocker) &&
            ![...this.blockedJobs.values()].some(value => record(value.image) && value.image.pageId === blocker.pageId &&
              record(value.image.target) && value.image.target.kind === blocker.kind));
          if (independent) return this.resume(snapshot);
          this.stop();
          return "The courseware job cannot advance: original image results are unknown or failed. Independent images have been reconciled. Report the actual blockers and preserve original requests. Another attempt on a confirmed failure requires a later explicit user retry request.\n" + JSON.stringify(coursewareStatusSummary(snapshot));
        }
        if (snapshot.styleConfirmed !== true) { this.reset(); return; }
        return this.resume(snapshot);
      }
      if (this.progress !== undefined && Date.now() - this.progressedAt >= 10 * 60_000) {
        this.stop();
        return "The authorized courseware request is unfinished: no progress for ten minutes. Preserve original image requests and report pending work.\n" + JSON.stringify(coursewareStatusSummary(snapshot));
      }
      const states: unknown[] = [];
      let progressed = false;
      for (const image of images) {
        if (!controls.canWait()) return;
        let value: Record<string, unknown>;
        try { value = await execute("courseware_scene_image_refresh", { intentId: image.intentId }); }
        catch (cause) {
          if (signal?.aborted || !controls.canWait()) throw cause;
          this.blockedJobs.set(String(image.intentId), { image, error: String(cause) });
          continue;
        }
        if (!controls.canWait()) return;
        if (!record(value.image)) throw new LocalRequestError("context-validation");
        if (value.requiresHumanSelection === true) { this.reset(); return this.resume(value); }
        const recovery = coursewareMediaRecovery(value);
        states.push({ intentId: image.intentId, recovery, phase: value.image.phase, asset: value.image.asset,
          selected: value.image.selected, task: record(value.image.task) ? { state: value.image.task.state, feeState: value.image.task.feeState } : null });
        if (["unknown", "failed", "prepared"].includes(recovery)) this.blockedJobs.set(String(image.intentId), value);
        else if (value.image.asset) progressed = true;
      }
      const key = progressKey(states);
      if (key !== this.progress) { this.progress = key; this.progressedAt = Date.now(); }
      snapshot = await execute("courseware_workflow_get", {});
      if (!controls.canWait()) return;
      if (!this.matchesPlan(snapshot)) { this.reset(); return; }
      if (progressed) { if (this.imageRetries.size) continue; snapshot.blockedJobs = [...this.blockedJobs.values()]; return this.resume(snapshot); }
      if (images.every(image => this.blockedJobs.has(String(image.intentId)))) continue;
      await delayWithAbort(3000, signal);
    }
  }

  private async finishSaved(execute: (name: string, args: Record<string, unknown>) => Promise<Record<string, unknown>>,
    canWait: () => boolean, signal?: AbortSignal, checkpoints?: Checkpoints, initial?: Record<string, unknown>, initializeOnly = false): Promise<string | undefined> {
    let snapshot: Record<string, unknown> | undefined;
    let checkpoint: CoursewareWorkflowCheckpoint | null = null;
    let repairFailure: Record<string, unknown> | undefined;
    let advisoryRepairFailed = false;
    let requiredRepairFailed = false;
    let lastSavedRefresh: string | undefined;
    const assessmentRefreshFailures = new Set<string>();
    const nativeRefreshFailures = new Set<string>();
    const save = async (status: CoursewareWorkflowCheckpoint["status"]) => {
      if (!checkpoints || !snapshot || snapshot.canonicalOnly === true || snapshot.nativeTeaching === true || !canWait()) return;
      const next: CoursewareWorkflowCheckpoint = { revision: (checkpoint?.revision ?? 0) + 1,
        projectId: String(snapshot.projectId), sourceSha256: String(snapshot.sourceSha256), status,
        repairAttempts: Object.fromEntries([...this.qualityRepairs].sort(([a], [b]) => a.localeCompare(b))), lastResume: this.lastResume ?? null };
      if (checkpoint && JSON.stringify({ ...checkpoint, revision: next.revision }) === JSON.stringify(next)) return;
      await checkpoints.write(next, checkpoint?.revision ?? 0);
      checkpoint = next;
    };
    try {
      while (canWait()) {
        snapshot = initial ?? await execute("courseware_media_context", {});
        initial = undefined;
        if (repairFailure) snapshot.lastRepairFailure = repairFailure;
        if (!canWait()) return;
        if (typeof snapshot.sourceSha256 !== "string" || !Array.isArray(snapshot.jobs)) throw new LocalRequestError("context-validation");
        const jobs = this.mediaRetries.size ? snapshot.jobs.filter(job => record(job) && this.mediaRetries.has(String(job.intentId))) : snapshot.jobs;
        if (checkpoints && snapshot.canonicalOnly !== true && snapshot.nativeTeaching !== true) {
          if (typeof snapshot.projectId !== "string") throw new LocalRequestError("context-validation");
          const durable = await checkpoints.read(snapshot.projectId);
          if (!canWait()) return;
          checkpoint = durable.checkpoint;
          if (checkpoint && (checkpoint.projectId !== snapshot.projectId || !Number.isSafeInteger(checkpoint.revision) ||
              checkpoint.revision < 1 || !record(checkpoint.repairAttempts))) throw new LocalRequestError("context-validation");
          if (!record(durable.completion) || durable.completion.sourceSha256 !== snapshot.sourceSha256 ||
              durable.completion.teachingRevision !== snapshot.teachingRevision) throw new LocalRequestError("context-validation");
          snapshot.completion = durable.completion;
          if (!this.restored) {
            this.qualityRepairs = new Map(Object.entries(checkpoint?.repairAttempts ?? {}));
            this.lastResume ??= checkpoint?.lastResume ?? undefined;
            this.restored = true;
          }
        }
        if (snapshot.nativeTeaching !== true && (checkpoint && checkpoint.sourceSha256 !== snapshot.sourceSha256 ||
            this.sourceSha256 && snapshot.sourceSha256 !== this.sourceSha256 && checkpoint?.sourceSha256 !== snapshot.sourceSha256)) {
          this.stop();
          return "COURSEWARE_CONFLICT: source changed without verified native-save continuation. The course remains unfinished. Preserve saved teaching and original media; read the current source and reconcile its bindings before resuming.\n" + JSON.stringify(coursewareStatusSummary(snapshot));
        }
        this.sourceSha256 = snapshot.sourceSha256;
        const key = progressKey(snapshot), changed = key !== this.progress;
        if (changed) { this.progress = key; this.progressedAt = Date.now(); }
        if (Date.now() - this.progressedAt >= 10 * 60_000) {
          await save("blocked"); this.stop();
          return "The authorized courseware request is unfinished: no progress for ten minutes. Preserve the original jobs and saved assets; report the pending work instead of polling indefinitely or submitting replacements.\n" + JSON.stringify(coursewareStatusSummary(snapshot));
        }
        await save("running");
        if (initializeOnly) return;
        if (!jobs.length) {
          if (Array.isArray(snapshot.unresolvedOriginals) && snapshot.unresolvedOriginals.length) {
            await save("blocked"); this.stop();
            return "Saved media contains unresolved legacy originals. Report their identifiers and binding issue; preserve those orders for explicit resolution before further generation.\n" + JSON.stringify(coursewareStatusSummary(snapshot));
          }
          if (this.savedGoal === "jobs") { this.reset(); return; }
          const completion = record(snapshot.completion) ? snapshot.completion : undefined;
          if (completion && completion.ready !== true && !(
            record(snapshot.assessmentMedia) && snapshot.assessmentMedia.ready === false &&
            Array.isArray(completion.issues) && completion.issues.length === 0)) {
            const allIssues = Array.isArray(completion.issues) ? completion.issues : [];
            // Resolve object evidence separately so an alias repair never rewrites speech or audio.
            const objectsOnly = allIssues.some(issue => record(issue) && issue.code === "OBJECT_REQUIREMENT_UNRESOLVED");
            const repairIssues = objectsOnly ? allIssues.filter(issue => record(issue) && issue.code === "OBJECT_REQUIREMENT_UNRESOLVED") : allIssues;
            const batchPages = new Set([...new Set(repairIssues.filter(record).map(issue => issue.pageNumber).filter(Number.isInteger))].slice(0, 5));
            const issues = repairIssues.filter(issue => !record(issue) || !Number.isInteger(issue.pageNumber) || batchPages.has(issue.pageNumber));
            if (requiredRepairFailed) {
              await save("blocked"); this.stop();
              return "Required teaching repair failed. Saved acceptance still has missing requirements. Report the affected pages and preserved successful assets; do not repeat the failed repair or claim completion.\n" + JSON.stringify(coursewareStatusSummary(snapshot));
            }
            if (!allIssues.length || allIssues.some(issue => !record(issue) || issue.repairable !== true)) {
              await save("blocked"); this.stop();
              return "The authorized courseware request is unfinished. Required teaching cannot be repaired automatically. Report these missing or locked requirements; preserve saved content and paid assets.\n" + JSON.stringify(coursewareStatusSummary(snapshot));
            }
            if (!this.takeRepairBudget(issues, "required")) {
              await save("blocked"); this.stop();
              return "The authorized courseware request is unfinished. Required teaching repair budget is exhausted (at most two repairs per requirement and 100 tracked requirements). Report the remaining requirements and affected pages; do not claim completion or regenerate successful media.\n" + JSON.stringify(coursewareStatusSummary(snapshot));
            }
            await save("running");
            const missingNarrationOnly = issues.every(issue => record(issue) && issue.code === "NARRATION_MISSING");
            if (missingNarrationOnly || snapshot.narrationReady === true && issues.every(issue => record(issue) &&
                ["QUESTION_MISSING", "QUESTION_TYPE_MISMATCH", "MUSIC_MISSING", "VIDEO_MISSING", "EFFECT_MISSING", "EFFECT_TARGET_MISSING", "OBJECT_REQUIREMENT_UNRESOLVED", "EFFECT_BINDING_MISMATCH", "EFFECT_TARGET_UNSUPPORTED", "ANIMATION_TARGET_CONFLICT", "NATIVE_SPEECH_ANIMATION_MISSING"].includes(String(issue.code)))) {
              const pageNumbers = [...new Set(issues.flatMap(issue => record(issue) && Number.isInteger(issue.pageNumber) ? [issue.pageNumber] : []))];
              if (pageNumbers.length) {
                try {
                  const repaired = await execute("courseware_narration_propose", { sourceSha256: this.sourceSha256, pageNumbers,
                    ...(missingNarrationOnly ? {} : { repairRequiredTeaching: true }),
                    ...(objectsOnly ? { repairObjectsOnly: true } : {}),
                    instruction: missingNarrationOnly
                      ? "Generate narration candidates only for these non-silent pages that have no saved speech. Use the current saved page text, independently mapped editable objects, retained lesson plan and adjacent-page context. Do not invent content that is absent; preserve every other page and all existing assets."
                      : objectsOnly ? "Verify only the required objects on these pages from current visual evidence. Bind each member of a compound description independently; counted collections require the stated number of distinct real targets. Never paste a collective description onto one member. Preserve all saved actions, speech, audio and effects exactly. If any required member is absent, report the source issue instead of inventing an alias."
                      : "Restore only missing approved teaching/effect bindings on these pages. Preserve existing speech text verbatim and in order, audio and media. Bind effects only to verified current page objects. For unresolved required-object descriptions, verify the current page visually and save the exact planned name as an alias only on its real target. If absent, report the source issue instead. Follow retained logical-page requirements." });
                  if (repaired.saved !== true) {
                    const failure = Array.isArray(repaired.failures) ? repaired.failures.find(record) : undefined;
                    const rawReason = failure && typeof failure.error === "string" ? failure.error
                      : typeof repaired.error === "string" ? repaired.error : undefined;
                    const reason = rawReason
                      ?.replace(/[\u0000-\u001f\u007f]/gu, " ").replace(/(api[_-]?key|token|password)\s*[:=]\s*\S+/giu, "$1=[REDACTED]").slice(0, 240);
                    repairFailure = { code: typeof repaired.code === "string" ? repaired.code : "REQUIRED_REPAIR_FAILED",
                      toolName: "courseware_narration_propose", pageNumbers, ...(reason ? { reason } : {}) };
                    requiredRepairFailed = true;
                  }
                } catch (cause) {
                  signal?.throwIfAborted();
                  if (!canWait()) return;
                  if (coursewareFailureRecovery(cause) === "cancelled") throw cause;
                  repairFailure = { code: "REQUIRED_REPAIR_FAILED", toolName: "courseware_narration_propose", pageNumbers };
                  requiredRepairFailed = true;
                }
                if (!canWait()) return;
                // Read saved acceptance before another bounded repair, including after a lost save receipt.
                continue;
              }
            }
            const instruction = this.resume(snapshot);
            await save(this.reportOnly ? "blocked" : "running");
            return instruction;
          }
          const quality = record(snapshot.quality) ? snapshot.quality : undefined;
          if (record(snapshot.assessmentMedia) && snapshot.assessmentMedia.ready === false) {
            const context = snapshot.assessmentMedia;
            if (this.assessmentJobs.size) {
              for (const [key, request] of this.assessmentJobs) {
                const missing = Array.isArray(context.targets) && context.targets.some(target => record(target) &&
                  ["kind", "sceneId", "actionId", "questionId", "optionValue"].every(field => target[field] === request[field]));
                if (!missing) { this.assessmentJobs.delete(key); continue; }
                let result: Record<string, unknown>;
                try {
                  result = await execute("courseware_media_assessments", { ...request, projectId: context.projectId,
                    expectedRevision: context.expectedRevision, expectedSourceRevision: context.expectedSourceRevision });
                } catch (cause) {
                  signal?.throwIfAborted();
                  if (!canWait()) return;
                  if (coursewareFailureRecovery(cause) === "cancelled") throw cause;
                  if (assessmentRefreshFailures.has(key)) {
                    await save("blocked"); this.stop();
                    return "Assessment media refresh failed after rereading saved state. Report the affected original task and preserve its order and saved assets; do not submit a replacement.\n" + JSON.stringify(request);
                  }
                  assessmentRefreshFailures.add(key);
                  // A native save or lost adoption receipt can invalidate this revision; reread before reconciling the original.
                  break;
                }
                if (result.state === "adopted") { this.assessmentJobs.delete(key); break; }
                if (["failed", "cancelled", "archive_failed", "not_submitted", "submission_unknown"].includes(String(result.state))) {
                  await save("blocked"); this.stop();
                  return "Assessment media is unfinished. Report this original task failure or unknown submission; preserve saved assets and do not submit a replacement.\n" + JSON.stringify(result);
                }
              }
              if (this.assessmentJobs.size) await delayWithAbort(3000, signal);
              continue;
            }
            await save("running");
            return this.resume(snapshot) + "\nComplete the missing question audio and multiple-choice option images with courseware_media_assessments context/prepare/refresh. Load configured models with context kind:tts/image. Re-read context before each operation. Preserve adopted assets; do not ask for per-question approval.";
          }
          const allIssues = quality && Array.isArray(quality.issues) ? quality.issues.filter(issue => record(issue) && issue.repairable === true) : [];
          const batchPages = new Set([...new Set(allIssues.filter(record).map(issue => issue.pageNumber).filter(Number.isInteger))].slice(0, 5));
          const issues = allIssues.filter(issue => !record(issue) || !Number.isInteger(issue.pageNumber) || batchPages.has(issue.pageNumber));
          if (snapshot.narrationReady === true && snapshot.audioReady === true && snapshot.teachingReady === true && snapshot.videoReady !== false) {
            if (issues.length && !advisoryRepairFailed) {
              if (this.takeRepairBudget(issues, "advisory")) {
                await save("running");
                if (issues.every(issue => record(issue) && issue.code === "FOCUS_MISSING" && Number.isInteger(issue.pageNumber))) {
                  const pageNumbers = [...new Set(issues.map(issue => (issue as Record<string, unknown>).pageNumber))];
                  try {
                    const repaired = await execute("courseware_narration_propose", { sourceSha256: this.sourceSha256, pageNumbers,
                      repairRequiredTeaching: true, instruction: "Repair only missing unambiguous focus on existing speech. Preserve all text, IDs, audio, effects and media." });
                    if (repaired.saved !== true) { repairFailure = { code: typeof repaired.code === "string" ? repaired.code : "ADVISORY_REPAIR_FAILED",
                      toolName: "courseware_narration_propose", pageNumbers }; advisoryRepairFailed = true; }
                  } catch (cause) {
                    signal?.throwIfAborted();
                    if (!canWait()) return;
                    if (coursewareFailureRecovery(cause) === "cancelled") throw cause;
                    // Reconcile a possibly partial save; advisory failure must not discard playable acceptance.
                    repairFailure = { code: "ADVISORY_REPAIR_FAILED", toolName: "courseware_narration_propose", pageNumbers };
                    advisoryRepairFailed = true;
                  }
                  if (!canWait()) return;
                  continue;
                }
                return "The saved course is technically playable, with non-blocking teaching diagnostics. Repair only the listed unlocked pages using existing narration/media tools, preserving existing assets and manual changes. Never regenerate adopted speech/audio to repair an advisory; if the available tool cannot preserve it, report that diagnostic. Re-read diagnostics after the repair; never regenerate successful media as a blanket retry. At most two attempts are allowed for unchanged diagnostics. Do not request per-page approval.\n" + JSON.stringify(coursewareStatusSummary(snapshot));
              }
            }
            await save("completed"); this.stop();
            if (advisoryRepairFailed || quality && Array.isArray(quality.issues) && quality.issues.length)
              return "The course remains playable. " + (advisoryRepairFailed ? "Automatic focus repair failed; saved narration and audio remain available. " : "") +
                "Stop automatic repairs and report the saved acceptance, unresolved teaching diagnostics and affected pages honestly; do not claim full teaching quality, ask for approval, or regenerate successful media.\n" + JSON.stringify(coursewareStatusSummary(snapshot));
            return "Saved courseware content, media and teaching checks are complete. Report those checks as complete, but state that full playback acceptance remains unverified unless this snapshot contains actual playback evidence for every page and natural audio completion. Do not call more tools. " +
              (snapshot.nativeTeaching === true ? "Saved spotlight/highlight cues are synchronized teaching overlays, distinct from native PowerPoint animation actions. Do not invent unsupported-capability claims or demand another approval for effects that already pass saved acceptance. Missing optional images excluded by the user are not unfinished generation. " : "") +
              "\n" + JSON.stringify(coursewareStatusSummary(snapshot));
          }
          const instruction = this.resume(snapshot);
          await save(this.reportOnly ? "blocked" : "running");
          return instruction;
        }
        let progressed = false;
        const refreshes: Record<string, unknown>[] = [];
        for (const job of jobs) {
          if (!record(job) || !["tts", "music", "video"].includes(String(job.kind)) || job.sourceSha256 !== this.sourceSha256)
            throw new LocalRequestError("context-validation");
          if (this.blockedJobs.has(String(job.intentId))) continue;
          if (job.kind !== "tts") { const { actionId, ...request } = job; refreshes.push(request); continue; }
          const batch = refreshes.find(value => value.kind === "tts" && value.pageNumber === job.pageNumber &&
            Array.isArray(value.intentIds) && value.intentIds.length < 100);
          if (batch && Array.isArray(batch.intentIds)) batch.intentIds.push(job.intentId);
          else refreshes.push({ kind: "tts", sourceSha256: this.sourceSha256, pageNumber: job.pageNumber, intentIds: [job.intentId] });
        }
        for (const refresh of refreshes) {
          const { intentIds, ...single } = refresh;
          const job = Array.isArray(intentIds) && intentIds.length === 1 ? { ...single, intentId: intentIds[0] } : refresh;
          if (!canWait()) return;
          let result: Record<string, unknown>;
          try { result = await execute("courseware_media_refresh", job); }
          catch (cause) {
            if (signal?.aborted || !canWait()) throw cause;
            const ids = Array.isArray(intentIds) ? intentIds : [job.intentId];
            // A native save can invalidate the captured version after adoption.
            // Reread once and query the same originals; this never buys a replacement.
            if (snapshot.nativeTeaching === true && ids.every(id => !nativeRefreshFailures.has(String(id)))) {
              for (const id of ids) nativeRefreshFailures.add(String(id));
              break;
            }
            for (const intentId of ids) {
              const original = jobs.find(value => record(value) && value.intentId === intentId);
              this.blockedJobs.set(String(intentId), { job: original ?? job, error: String(cause) });
            }
            continue;
          }
          if (!canWait()) return;
          const results = Array.isArray(result.results) ? result.results : [{ ...result, job }];
          for (const value of results) {
            if (!record(value) || !record(value.job) || value.saved === true) continue;
            if (["unknown", "failed", "prepared"].includes(coursewareMediaRecovery(value))) {
              const intentId = value.job.intentId;
              const original = jobs.find(job => record(job) && job.intentId === intentId);
              this.blockedJobs.set(String(intentId), { ...value, job: original ?? value.job });
            }
          }
          for (const failure of Array.isArray(result.failures) ? result.failures : []) {
            if (!record(failure) || typeof failure.intentId !== "string") continue;
            const original = jobs.find(value => record(value) && value.intentId === failure.intentId);
            if (record(original)) this.blockedJobs.set(failure.intentId, { ...failure, job: original });
          }
          if (result.saved === true || Array.isArray(result.results) && result.results.some(value => record(value) && value.saved === true)) {
            progressed = true;
            if (snapshot.nativeTeaching === true) break;
          }
        }
        if (!refreshes.length && this.blockedJobs.size) {
          const blocked = [...this.blockedJobs.values()];
          snapshot.blockedJobs = blocked;
          const completion = record(snapshot.completion) ? snapshot.completion : undefined;
          const missingRequirement = completion && Array.isArray(completion.issues) && completion.issues.some(issue => record(issue) && issue.repairable === true &&
            !blocked.some(value => record(value.job) && value.job.pageNumber === issue.pageNumber && value.job.kind === issue.repair &&
              (typeof issue.actionId !== "string" || value.job.actionId === issue.actionId || record(value.media) && value.media.actionId === issue.actionId)));
          const missingPage = Array.isArray(snapshot.pages) && snapshot.pages.some(page => {
            if (!record(page) || page.locked === true) return false;
            if (page.narrationReady === false) return true;
            return Array.isArray(page.speeches) && page.speeches.some(speech => record(speech) && speech.audioReady === false &&
              !blocked.some(value => record(value.job) && value.job.pageNumber === page.pageNumber &&
                (value.job.actionId === speech.actionId || record(value.media) && value.media.actionId === speech.actionId))) ||
              Array.isArray(page.actions) && page.actions.some(action => record(action) && ["music_slot", "video_slot"].includes(String(action.type)) &&
                !jobs.some(job => record(job) && job.pageNumber === page.pageNumber && job.kind === (action.type === "music_slot" ? "music" : "video")));
          });
          if ((missingRequirement || missingPage) && this.savedGoal === "course") {
            const instruction = this.resume(snapshot); await save(this.reportOnly ? "blocked" : "running"); return instruction;
          }
          await save("blocked"); this.stop();
          return "The authorized courseware request is unfinished. Original media results are unknown or failed and independent pending jobs have been reconciled. Stop automatic polling, report the affected original intents and actual errors, and preserve their accounting and assets. A local query or adoption exception does not confirm provider generation failure: distinguish these stages, and never advise purchasing a replacement without a terminal provider failure receipt. Report this run as unfinished. Another attempt on a confirmed failure requires a later explicit user retry request.\n" + JSON.stringify(coursewareStatusSummary(snapshot));
        }
        if (progressed && lastSavedRefresh !== key) { lastSavedRefresh = key; continue; }
        await delayWithAbort(3000, signal);
      }
    } catch (cause) {
      if (canWait() && !signal?.aborted && (!checkpoint || checkpoint.sourceSha256 === snapshot?.sourceSha256)) await save("blocked");
      throw cause;
    }
  }

  private resume(snapshot: Record<string, unknown>): string {
    const state = JSON.stringify(coursewareStatusSummary(snapshot));
    if (progressKey(snapshot) === this.lastResume) {
      this.stop();
      return "The authorized courseware request is unfinished: the previous continuation made no saved progress. End automatic continuation and report the actual blockers once. Preserve original jobs and paid assets; never claim completion.\n" + state;
    }
    this.lastResume = progressKey(snapshot);
    return "The authorized courseware request is unfinished. The runtime queried the saved jobs while keeping this Chat active. " +
      "This snapshot belongs to the current user turn; newer tool results supersede it. " +
      "Use this actual state to perform the next missing step now. Only an unselected first-page style needs user review. " +
      "Generate missing independent assets, decompose selected masters, or compile when no blockers remain. " +
      "Compilation is an intermediate PPTX state. For a complete course, generate and save missing detailed narration with courseware_narration_propose in sequential tool calls of at most 5 pages; await save and reread current sourceSha256 before the next unfinished batch, " +
      "Assessment pages already own their question reading: never regenerate their body narration. Use courseware_media_assessments for missing Quiz/interaction question audio. For body pages, create missing speech audio with courseware_media_prepare using the real catalog and speech IDs. Prefer one TTS call per page with actionIds for bounded parallel synthesis and archive; preserve existing narration/audio. " +
      "Both kindergarten and primary courses need their planned teaching actions, interaction, animation, highlight and spotlight, synchronized with actual audio and mapped objects. " +
      "Scene mode shares these capabilities across stages; complete video or music only when required by the course plan. A wait is not an assessment, a draft is not executable media, and audio readiness alone is not full MAIC parity. " +
      "For required video, create a video block with courseware_narration_propose, then use courseware_media_context(kind:video) and courseware_media_prepare(kind:video, actionId:<saved video_slot ID>) with a configured model. Use courseware_media_context to check actual actions and teachingReady, videoReady and audioReady. Finish required media, archive and mount its real output before reporting completion. Return the editable PPTX and teaching data; do not capture a publication snapshot or build PPTist until the user publishes. " +
      "Report the exact Host completion.counts and quality.counts; do not recalculate totals from memory or waive missing audio as usable completion. Saved-state completion requires completion.ready:true from Host acceptance of retained page requirements; missing required questions or music cannot be waived as advice. This is not playback acceptance: do not say the deck passed end-to-end playback without actual fixed-player evidence that every page was reached and each audio ended naturally. If detailed narration is already saved, use courseware_narration_propose with repairRequiredTeaching:true for missing required questions/music, preserving the exact current speech texts and their order. Repair only completion.issues on unlocked pages, preserving successful media; report locked or exhausted requirements as unfinished. " +
      "Read quality.issues as advisory, repair unlocked affected pages with the indicated narration/TTS/music tools, and recheck. A music_slot is an exact sequential playback position: generate music with its actionId and replace it in place; never append planned music to the end of the page. Report unresolved diagnostics without hiding the playable result. " +
      "Query original pending intents; do not create replacements for unknown submissions. blockedJobs have already been reconciled in this turn: leave them unchanged and complete only independent missing work.\n" + state;
  }
}
