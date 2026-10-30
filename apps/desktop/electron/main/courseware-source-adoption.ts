import { setTimeout as delay } from "node:timers/promises";
import { getOfficeExtension, isCoursewareProject } from "@pi-desktop/shared";
import { resolveRealPathForCreateWithinRoot } from "./fs-panel";
import { relative } from "node:path";
import { adoptionRevision, installSourceCandidate, readLiveSource, restoreMissingSource, rollBackSourceCandidate, sourceHash } from "./courseware-source-files";
import type { CoursewareTeachingCoordinator } from "./courseware-teaching";
import type { PptEditorController } from "./ppt-editor";

type Host = { call<T>(method: string, params: unknown): Promise<T> };
type Receipt = { adoptionId: string; projectId: string; sourcePath: string | null; sourceSha256: string; outputSha256: string; status: "pending" | "committed" | "cancelled"; project: unknown };

export class CoursewareSourceAdoption {
  private busy = false;
  constructor(private editor: PptEditorController, private teaching: CoursewareTeachingCoordinator,
    private getHost: () => Host | null, private getWorkspace: () => Promise<string | null>,
    private getSessionId: () => string | null, private clearChat: () => void) {}

  assertIdle(): void { if (this.busy) throw new Error("Finish source adoption before opening, saving or closing Office"); }

  private async receipt(host: Host, sessionId: string, path: string): Promise<Receipt | null> {
    const result = await host.call<{ adoption: Receipt | null }>("courseware.sourceAdoption.forPath", { sessionId, sourcePath: path });
    if (!result || Object.keys(result).length !== 1 || !("adoption" in result)) throw new Error("Invalid adoption recovery response");
    const value = result.adoption;
    if (value === null) return null;
    if (!value || !/^[\w.-]{1,128}$/u.test(value.projectId) || value.sourcePath !== path || !/^[\w.-]{1,128}$/u.test(value.adoptionId) ||
        value.status !== "pending" ||
        ![value.sourceSha256, value.outputSha256].every(hash => typeof hash === "string" && /^[a-f0-9]{64}$/u.test(hash))) throw new Error("Invalid adoption recovery receipt");
    return value;
  }

  private async assertScope(host: Host, workspace: string, sessionId: string): Promise<void> {
    if (await this.getWorkspace() !== workspace || this.getHost() !== host || this.getSessionId() !== sessionId)
      throw new Error("Source adoption owner changed; recover in the original workspace");
  }

  private async resolve(host: Host, workspace: string, path: string, sessionId: string): Promise<void> {
    await this.assertScope(host, workspace, sessionId);
    const receipt = await this.receipt(host, sessionId, path);
    await this.assertScope(host, workspace, sessionId);
    if (!receipt) return;
    await restoreMissingSource(workspace, path, receipt.adoptionId, receipt.sourceSha256);
    const bytes = await readLiveSource(workspace, path);
    const hash = sourceHash(bytes);
    if (hash !== receipt.sourceSha256 && hash !== receipt.outputSha256) throw new Error("Live file has third-party changes; adoption remains pending and all versions are retained");
    const revision = await adoptionRevision(workspace, path, bytes);
    let jobId: string | undefined;
    let terminal = false;
    try {
      jobId = (await host.call<{ jobId: string }>("courseware.parseStart", { sessionId, path: revision.documentPath })).jobId;
      while (true) {
        const result = await host.call<{ status: string; message?: string; summary?: { sourceSha256: string } }>("courseware.parseStatus", { jobId });
        if (result.status === "RUNNING") { await delay(100); continue; }
        terminal = true;
        if (result.status !== "SUCCEEDED" || result.summary?.sourceSha256 !== hash) throw new Error(result.message || "Adoption saved-source parsing failed");
        break;
      }
      const attached = await host.call<{ attached: boolean }>("courseware.project.attach", { sessionId, jobId, sourcePath: path });
      if (!attached || Object.keys(attached).length !== 1 || attached.attached !== receipt.projectId.startsWith("portable-"))
        throw new Error("Source adoption project attachment changed");
      await this.assertScope(host, workspace, sessionId);
      if (sourceHash(await readLiveSource(workspace, path)) !== hash) throw new Error("Live source changed during adoption recovery");
      const result = await host.call<Receipt>(hash === receipt.outputSha256 ? "courseware.sourceAdoption.commit" : "courseware.sourceAdoption.cancel", { sessionId, jobId, adoptionId: receipt.adoptionId });
      await this.assertScope(host, workspace, sessionId);
      if (result.adoptionId !== receipt.adoptionId || result.projectId !== receipt.projectId || result.status !== (hash === receipt.outputSha256 ? "committed" : "cancelled") ||
          (result.status === "committed" && (!isCoursewareProject(result.project) || result.project.projectId !== receipt.projectId || result.project.source.sha256 !== hash))) throw new Error("Invalid adoption resolution receipt; recover before reopening");
      if (sourceHash(await readLiveSource(workspace, path)) !== hash) throw new Error("Live source changed after adoption; reopen only after review");
    } finally {
      if (jobId) {
        if (!terminal) {
          await host.call("courseware.parseCancel", { jobId });
          while ((await host.call<{ status: string }>("courseware.parseStatus", { jobId })).status === "RUNNING") await delay(100);
        }
        await host.call("courseware.parseRelease", { jobId });
      }
    }
  }

  async beforeOpen(workspace: string, path: string, sessionId: string | null, mimeType?: string): Promise<void> {
    this.assertIdle();
    if (getOfficeExtension(path, mimeType) !== "pptx" || !sessionId) return;
    this.busy = true;
    try {
      const host = this.getHost(); if (!host) throw new Error("Host is unavailable");
      const canonical = await resolveRealPathForCreateWithinRoot(workspace, path);
      if (canonical) await this.resolve(host, workspace, canonical, sessionId);
    } finally { this.busy = false; }
  }

  async adopt(reviewId: unknown, reopen: (path: string) => Promise<void>, effectBindings: unknown = []): Promise<void> {
    effectBindings = structuredClone(effectBindings);
    this.assertIdle(); this.busy = true;
    let frozen = false;
    let resolved = false;
    try {
      const workspace = await this.getWorkspace(); const host = this.getHost(); const sessionId = this.getSessionId();
      if (!workspace || !host || !sessionId) throw new Error("No active source adoption workspace");
      const snapshot = this.editor.sourceAdoptionSnapshot(workspace);
      try {
        const prepared = await this.teaching.preparePptxAdoption(reviewId, snapshot.sourcePath, effectBindings);
        if (prepared.host !== host || prepared.sessionId !== sessionId || this.getHost() !== host ||
            this.getSessionId() !== sessionId || await this.getWorkspace() !== workspace) throw new Error("Source adoption owner changed");
        await this.teaching.assertCurrent(prepared.snapshot, prepared.context, sessionId, host);
        this.editor.freezeForSourceAdoption(workspace, snapshot); frozen = true; this.clearChat();
        await installSourceCandidate(workspace, snapshot.sourcePath, prepared.adoption.adoptionId,
          prepared.path, prepared.adoption.sourceSha256, prepared.adoption.outputSha256);
        await this.resolve(host, workspace, snapshot.sourcePath, sessionId);
        resolved = true;
      } catch (error) {
        try { await this.resolve(host, workspace, snapshot.sourcePath, sessionId); resolved = true; }
        catch (recovery) {
          try {
            const receipt = await this.receipt(host, sessionId, snapshot.sourcePath);
            await this.assertScope(host, workspace, sessionId);
            if (!receipt || receipt.status !== "pending" || receipt.sourcePath !== snapshot.sourcePath) throw recovery;
            await rollBackSourceCandidate(workspace, snapshot.sourcePath, receipt.adoptionId, receipt.sourceSha256, receipt.outputSha256);
            await this.resolve(host, workspace, snapshot.sourcePath, sessionId); resolved = true;
          } catch (rollback) { throw new Error(`Source adoption needs recovery: ${String(error)}; ${String(recovery)}; ${String(rollback)}`); }
        }
        throw error;
      } finally {
        if (frozen && resolved && this.getHost() === host && this.getSessionId() === sessionId && await this.getWorkspace() === workspace) {
          // Reopening is controlled by this operation; ordinary open/save/close remain fenced.
          await reopen(relative(workspace, snapshot.sourcePath));
        }
      }
    } finally { this.busy = false; }
  }
}
