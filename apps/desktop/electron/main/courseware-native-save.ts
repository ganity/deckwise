import { readFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { createHash } from "node:crypto";
import { jobIdFor } from "./ppt-editor-files";
import type { NativeSaveInput, NativeSaveCommit } from "./ppt-editor";

type Host = { call<T>(method: string, params: unknown): Promise<T> };
type Receipt = { saveId: string; sourcePath: string; sourceSha256: string; outputSha256: string; status: string };

/** The durable Host receipt is prepared before live bytes change and resolved before Office acknowledges them. */
export class CoursewareNativeSave {
  private verified: { host: Host; sessionId: string; path: string; sha256: string } | null = null;
  constructor(private getHost: () => Host | null, private getSession: () => string | null,
    private getWorkspace: () => Promise<string | null>, private assertOwner: (session: string) => void,
    private exclusive: <T>(operation: () => Promise<T>) => Promise<T>) {}

  async recover(workspace: string, sourcePath: string, sessionId: string | null): Promise<void> {
    if (!sessionId || !sourcePath.toLowerCase().endsWith(".pptx")) return;
    const host = this.getHost();
    if (!host) throw new Error("Host unavailable during PPT save recovery");
    const { save } = await host.call<{ save: Receipt | null }>("courseware.nativeSave.forPath", { sessionId, sourcePath });
    if (save) await host.call("courseware.nativeSave.resolve", { sessionId, saveId: save.saveId });
    if (this.getHost() !== host || this.getSession() !== sessionId || await this.getWorkspace() !== workspace)
      throw new Error("PPT save recovery owner changed");
  }

  async prepare(input: NativeSaveInput): Promise<NativeSaveCommit> {
    return this.exclusive(async () => {
      const host = this.getHost(), sessionId = this.getSession();
      if (!host || !sessionId) throw new Error("Open a courseware conversation before saving teaching");
      const assertOwner = async () => {
        this.assertOwner(sessionId);
        if (this.getHost() !== host || this.getSession() !== sessionId || await this.getWorkspace() !== input.workspace)
          throw new Error("PPT save owner changed");
      };
      await assertOwner();
      const proof = input.lineage as Record<string, unknown> | undefined;
      if (!proof || !["deckwise-office-page-lineage/1", "deckwise-office-page-lineage/2"].includes(String(proof.protocol)) || proof.projectId !== input.binding.projectId ||
          proof.documentId !== input.binding.documentId || proof.sessionId !== input.binding.sessionId ||
          proof.saveRequestId !== input.saveRequestId || proof.sourceSha256 !== input.sourceSha256 || proof.outputSha256 !== input.outputSha256 ||
          input.binding.documentId !== jobIdFor(input.workspace, input.sourcePath) ||
          input.binding.projectId !== createHash("sha256").update(input.workspace).digest("hex"))
        throw new Error("PPT export identity is unavailable; retry saving after the editor finishes loading");
      if (input.nativeTeaching) {
        const outputBytes = await readFile(input.outputPath);
        if (createHash("sha256").update(outputBytes).digest("hex") !== input.outputSha256) throw new Error("Native export changed before validation");
        await assertOwner();
        const verify = async (expected: string) => {
          await assertOwner();
          if (createHash("sha256").update(await readFile(input.sourcePath)).digest("hex") !== expected) throw new Error("Native teaching save needs recovery");
        };
        return { commit: () => verify(input.outputSha256), cancel: () => verify(input.sourceSha256) };
      }
      let jobId: string | undefined, terminal = false;
      const release = async () => {
        if (!jobId) return;
        if (!terminal) {
          await host.call("courseware.parseCancel", { jobId });
          while ((await host.call<{ status: string }>("courseware.parseStatus", { jobId })).status === "RUNNING") await delay(100);
        }
        await host.call("courseware.parseRelease", { jobId });
        jobId = undefined; terminal = false;
      };
      const parse = async (path: string, sha256: string) => {
        await release(); await assertOwner();
        ({ jobId } = await host.call<{ jobId: string }>("courseware.parseStart", { sessionId, path }));
        while (true) {
          const status = await host.call<{ status: string; message?: string; summary?: { sourceSha256: string } }>("courseware.parseStatus", { jobId });
          if (status.status === "RUNNING") { await delay(100); continue; }
          terminal = true;
          if (status.status !== "SUCCEEDED" || status.summary?.sourceSha256 !== sha256)
            throw new Error(status.message || "Saved PPT identity verification failed");
          await assertOwner(); return jobId;
        }
      };
      let receipt: Receipt | undefined;
      try {
        const verified = this.verified;
        if (!verified || verified.host !== host || verified.sessionId !== sessionId || verified.path !== input.sourcePath || verified.sha256 !== input.sourceSha256) {
          const oldJob = await parse(input.sourceRevisionPath, input.sourceSha256);
          await host.call("courseware.project.attach", { sessionId, jobId: oldJob, sourcePath: input.sourcePath });
          await host.call("courseware.project.openSaved", { sessionId, jobId: oldJob });
          this.verified = { host, sessionId, path: input.sourcePath, sha256: input.sourceSha256 };
        }
        const newJob = await parse(input.outputPath, input.outputSha256);
        receipt = await host.call<Receipt>("courseware.nativeSave.prepare", { sessionId, jobId: newJob, sourcePath: input.sourcePath, lineage: proof, ...(input.classroomSave ? { classroomSave: input.classroomSave } : {}) });
        if (!receipt || receipt.status !== "pending" || receipt.sourcePath !== input.sourcePath ||
            receipt.sourceSha256 !== input.sourceSha256 || receipt.outputSha256 !== input.outputSha256 || !receipt.saveId)
          throw new Error("Invalid native PPT save receipt");
      } finally { await release(); }
      const resolve = async (status: string) => {
        await assertOwner();
        const result = await host.call<Receipt>("courseware.nativeSave.resolve", { sessionId, saveId: receipt!.saveId });
        if (result.saveId !== receipt!.saveId || result.status !== status) throw new Error("PPT save needs recovery before editing teaching");
        this.verified = { host, sessionId, path: input.sourcePath, sha256: status === "committed" ? input.outputSha256 : input.sourceSha256 };
      };
      return { commit: () => resolve("committed"), cancel: () => resolve("cancelled") };
    });
  }
}
