import { coursewareMediaRecovery } from "@pi-desktop/shared";
import type { AgentToolResult, AgentTurnContext } from "@earendil-works/pi-agent-core";
import { LocalRequestError } from "@earendil-works/pi-ai";
import { createHash } from "node:crypto";
import type { CoursewareWorkflowCheckpoint } from "@pi-desktop/shared";
import { coursewareFailureRecovery } from "./courseware-workflow-recovery.js";
import { coursewareStatusSummary } from "./courseware-workflow-tools.js";
import { delayWithAbort } from "./provider-retry.js";

const record = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);
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
  private planRepairs = 0;
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
  private imageRetries = new Set<string>();
  private mediaRetries = new Set<string>();

  get reportOnly(): boolean { return this.stopped; }

  private stop(): void { this.active = false; this.stopped = true; }

  reset(): void {
    this.active = false;
    this.planning = false;
    this.planRepairs = 0;
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
    this.imageRetries.clear();
    this.mediaRetries.clear();
  }

  private matchesPlan(snapshot: Record<string, unknown>): boolean {
    const { task, plan } = snapshot;
    return record(task) && task.taskType === "scene" && !task.generated && record(plan) &&
      plan.sha256 === this.planSha256 && plan.approvedSha256 === plan.sha256;
  }

  private observe(turn: AgentTurnContext): void {
    for (const result of turn.toolResults) {
      const write = turn.message.content.find(block => block.type === "toolCall" && block.id === result.toolCallId);
      if (["Write", "Edit", "Bash"].includes(result.toolName) && write?.type === "toolCall" &&
          /\.deckwise-ppt[\\/]scenes[\\/][A-Za-z0-9_-]+[\\/]plan\.json/u.test(JSON.stringify(write.arguments))) {
        this.planning = true;
        if (!result.isError && this.planRepairPending) { this.planRepairs++; this.planRepairPending = false; }
      }
      if (!result.toolName.startsWith("courseware_")) continue;
      if (result.toolName === "courseware_scene_plan_submit" && result.isError) this.planning = true;
      // A failed call does not erase the authorized goal or successful saved jobs.
      if (result.isError) continue;
      const value: unknown = result.details;
      if (!record(value)) continue;
      const call = turn.message.content.find(block => block.type === "toolCall" && block.id === result.toolCallId);
      if (result.toolName === "courseware_scene_plan_submit" && value.awaitingPlanApproval === true) this.planning = true;
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
        call?.type === "toolCall" && (call.arguments.waitForUpdate === true || call.arguments.generatePrepared === true || call.arguments.retryFailed === true);
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
    if (this.stopped) return;
    this.observe(turn);
    if (this.planning && controls.canWait() && turn.message.stopReason !== "error" && turn.message.stopReason !== "aborted" &&
        (!turn.message.content.some(block => block.type === "toolCall") || turn.toolResults.some(result =>
          ["Write", "Edit", "Bash", "courseware_scene_plan_submit"].includes(result.toolName)))) {
      try {
        const result = await controls.execute("courseware_scene_plan_submit", {}, signal);
        if (result.isError || !record(result.details) || result.details.validated !== true)
          throw new Error(JSON.stringify(result.content));
        this.planRepairPending = false;
        const submitting = turn.toolResults.some(result => result.toolName === "courseware_scene_plan_submit" && !result.isError);
        if (turn.message.content.some(block => block.type === "toolCall") && !submitting) return;
        this.planning = false;
        this.stop();
        return "The scene draft passed product validation and is awaiting the existing human plan review. Report it as a draft, not a completed lesson. Do not prepare images or media before approval.\n" + JSON.stringify(result.details);
      } catch (error) {
        signal?.throwIfAborted();
        if (!controls.canWait()) return;
        if (this.planRepairs >= 2) {
          this.stop();
          return "Scene planning is unfinished: validation still fails after two corrections. Report the actual error; do not claim completion or request approval of an invalid draft.\n" + String(error);
        }
        this.planRepairPending = true;
        return "The scene draft is not ready for review. Repair this exact product validation error in this Chat's plan.json, preserve all required fields and the user's explicit requirements, then submit again with courseware_scene_plan_submit. If Edit failed, read the draft and use one complete Write instead of another partial replacement. A file write or JSON parse is not completion.\n" + String(error);
      }
    }
    const readyResult = this.savedGoal === "course" ? [...turn.toolResults].reverse().find(result =>
      !result.isError && result.toolName === "courseware_media_context" && record(result.details) &&
      Array.isArray(result.details.jobs) && !result.details.jobs.length &&
      record(result.details.completion) && result.details.completion.ready === true) : undefined;
    if (!this.active || turn.message.stopReason === "error" || turn.message.stopReason === "aborted" ||
        turn.message.content.some(block => block.type === "toolCall") && !readyResult || !controls.canWait()) return;
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
          throw new LocalRequestError("request-preparation", { cause });
        }
      }
    };
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
    canWait: () => boolean, signal?: AbortSignal, checkpoints?: Checkpoints, initial?: Record<string, unknown>): Promise<string | undefined> {
    let snapshot: Record<string, unknown> | undefined;
    let checkpoint: CoursewareWorkflowCheckpoint | null = null;
    let repairFailure: Record<string, unknown> | undefined;
    let lastSavedRefresh: string | undefined;
    const save = async (status: CoursewareWorkflowCheckpoint["status"]) => {
      if (!checkpoints || !snapshot || !canWait()) return;
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
        if (checkpoints) {
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
        if (this.sourceSha256 && snapshot.sourceSha256 !== this.sourceSha256 && checkpoint?.sourceSha256 !== snapshot.sourceSha256)
          throw new LocalRequestError("request-preparation", { cause: new Error("COURSEWARE_CONFLICT: source changed without verified native-save continuation") });
        this.sourceSha256 = snapshot.sourceSha256;
        const key = progressKey(snapshot), changed = key !== this.progress;
        if (changed) { this.progress = key; this.progressedAt = Date.now(); }
        if (Date.now() - this.progressedAt >= 10 * 60_000) {
          await save("blocked"); this.stop();
          return "The authorized courseware request is unfinished: no progress for ten minutes. Preserve the original jobs and saved assets; report the pending work instead of polling indefinitely or submitting replacements.\n" + JSON.stringify(coursewareStatusSummary(snapshot));
        }
        await save("running");
        if (!jobs.length) {
          if (Array.isArray(snapshot.unresolvedOriginals) && snapshot.unresolvedOriginals.length) {
            await save("blocked"); this.stop();
            return "Saved media contains unresolved legacy originals. Report their identifiers and binding issue; preserve those orders for explicit resolution before further generation.\n" + JSON.stringify(coursewareStatusSummary(snapshot));
          }
          if (this.savedGoal === "jobs") { this.reset(); return; }
          const completion = record(snapshot.completion) ? snapshot.completion : undefined;
          if (completion && completion.ready !== true) {
            const issues = Array.isArray(completion.issues) ? completion.issues : [];
            if (!issues.length || issues.some(issue => !record(issue) || issue.repairable !== true)) {
              await save("blocked"); this.stop();
              return "The authorized courseware request is unfinished. Required teaching cannot be repaired automatically. Report these missing or locked requirements; preserve saved content and paid assets.\n" + JSON.stringify(coursewareStatusSummary(snapshot));
            }
            const key = digest(issues.map(issue => record(issue) ? [issue.pageId, issue.code, issue.repair] : null));
            const attempts = this.qualityRepairs.get(key) ?? 0;
            if (attempts >= 2) {
              await save("blocked"); this.stop();
              return "The authorized courseware request is unfinished. Required teaching still fails acceptance after two repairs. Report the remaining requirements and affected pages; do not claim completion or regenerate successful media.\n" + JSON.stringify(coursewareStatusSummary(snapshot));
            }
            this.qualityRepairs.set(key, attempts + 1);
            await save("running");
            if (snapshot.narrationReady === true && issues.every(issue => record(issue) &&
                ["QUESTION_MISSING", "QUESTION_TYPE_MISMATCH", "MUSIC_MISSING", "VIDEO_MISSING"].includes(String(issue.code)))) {
              const pageNumbers = [...new Set(issues.flatMap(issue => record(issue) && Number.isInteger(issue.pageNumber) ? [issue.pageNumber] : []))];
              if (pageNumbers.length) {
                const repaired = await execute("courseware_narration_propose", { sourceSha256: this.sourceSha256, pageNumbers,
                  repairRequiredTeaching: true, instruction: "Restore only the missing approved questions/music/video at their teaching positions. Preserve all existing speech texts verbatim and in order, audio, effects and media. Follow retained logical-page requirements." });
                if (!canWait()) return;
                if (repaired.saved !== true) repairFailure = repaired;
                // Read saved acceptance before another bounded repair, including after a lost save receipt.
                continue;
              }
            }
            const instruction = this.resume(snapshot);
            await save(this.reportOnly ? "blocked" : "running");
            return instruction;
          }
          const quality = record(snapshot.quality) ? snapshot.quality : undefined;
          const issues = quality && Array.isArray(quality.issues) ? quality.issues.filter(issue => record(issue) && issue.repairable === true) : [];
          if (snapshot.narrationReady === true && snapshot.audioReady === true && snapshot.teachingReady === true && snapshot.videoReady !== false) {
            if (issues.length) {
              const key = digest(issues.map(issue => record(issue) ? [issue.pageId, issue.code, issue.repair] : null));
              const attempts = this.qualityRepairs.get(key) ?? 0;
              if (attempts < 2) {
                this.qualityRepairs.set(key, attempts + 1);
                await save("running");
                if (issues.every(issue => record(issue) && issue.code === "FOCUS_MISSING" && Number.isInteger(issue.pageNumber))) {
                  const repaired = await execute("courseware_narration_propose", { sourceSha256: this.sourceSha256,
                    pageNumbers: [...new Set(issues.map(issue => (issue as Record<string, unknown>).pageNumber))],
                    repairRequiredTeaching: true, instruction: "Repair only missing unambiguous focus on existing speech. Preserve all text, IDs, audio, effects and media." });
                  if (!canWait()) return;
                  if (repaired.saved !== true) repairFailure = repaired;
                  continue;
                }
                return "The saved course is technically playable, with non-blocking teaching diagnostics. Repair only the listed unlocked pages using existing narration/media tools, preserving existing assets and manual changes. Never regenerate adopted speech/audio to repair an advisory; if the available tool cannot preserve it, report that diagnostic. Re-read diagnostics after the repair; never regenerate successful media as a blanket retry. At most two attempts are allowed for unchanged diagnostics. Do not request per-page approval.\n" + JSON.stringify(coursewareStatusSummary(snapshot));
              }
            }
            await save("completed"); this.stop();
            if (quality && Array.isArray(quality.issues) && quality.issues.length)
              return "The course remains playable. Stop automatic repairs and report these unresolved teaching diagnostics and affected pages honestly; do not claim full teaching quality, ask for approval, or regenerate successful media.\n" + JSON.stringify(coursewareStatusSummary(snapshot));
            return "The authorized courseware request is completed. Give the final report using this saved acceptance; do not call more tools.\n" + JSON.stringify(coursewareStatusSummary(snapshot));
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
          if (result.saved === true || Array.isArray(result.results) && result.results.some(value => record(value) && value.saved === true)) progressed = true;
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
          return "The authorized courseware request is unfinished. Original media results are unknown or failed and independent pending jobs have been reconciled. Stop automatic polling, report the affected original intents and actual errors, and preserve their accounting and assets. Report this run as unfinished. Another attempt on a confirmed failure requires a later explicit user retry request.\n" + JSON.stringify(coursewareStatusSummary(snapshot));
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
      "Compilation is an intermediate PPTX state. For a complete course, generate and save missing detailed narration with courseware_narration_propose, " +
      "then create missing speech audio with courseware_media_prepare using the real catalog and speech IDs. Prefer one TTS call per page with actionIds for bounded parallel synthesis and archive; preserve existing narration/audio. " +
      "Both kindergarten and primary courses need their planned teaching actions, interaction, animation, highlight and spotlight, synchronized with actual audio and mapped objects. " +
      "Scene mode shares these capabilities across stages; complete video or music only when required by the course plan. A wait is not an assessment, a draft is not executable media, and audio readiness alone is not full MAIC parity. " +
      "For required video, create a video block with courseware_narration_propose, then use courseware_media_context(kind:video) and courseware_media_prepare(kind:video, actionId:<saved video_slot ID>) with a configured model. Use courseware_media_context to check actual actions and teachingReady, videoReady and audioReady. Finish required media, archive and mount its real output before reporting completion. Return the editable PPTX and teaching data; do not capture a publication snapshot or build PPTist until the user publishes. " +
      "Report the exact Host completion.counts and quality.counts; do not recalculate totals from memory or waive missing audio as usable completion. Completion requires completion.ready:true from Host acceptance of retained page requirements; missing required questions or music cannot be waived as advice. If detailed narration is already saved, use courseware_narration_propose with repairRequiredTeaching:true for missing required questions/music, preserving the exact current speech texts and their order. Repair only completion.issues on unlocked pages, preserving successful media; report locked or exhausted requirements as unfinished. " +
      "Read quality.issues as advisory, repair unlocked affected pages with the indicated narration/TTS/music tools, and recheck. A music_slot is an exact sequential playback position: generate music with its actionId and replace it in place; never append planned music to the end of the page. Report unresolved diagnostics without hiding the playable result. " +
      "Query original pending intents; do not create replacements for unknown submissions. blockedJobs have already been reconciled in this turn: leave them unchanged and complete only independent missing work.\n" + state;
  }
}
