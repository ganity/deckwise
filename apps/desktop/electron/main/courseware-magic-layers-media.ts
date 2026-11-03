import { setTimeout as delay } from "node:timers/promises";
import { CoursewareMediaTransport, mediaSubmissionPath } from "./courseware-media-transport";
import type { MagicLayersManifest } from "./courseware-magic-layers";

type Job = { id: string; status: "queued" | "running" | "succeeded" | "failed"; error?: string | null };
type Saved = { requestHash: string; sourceSha256: string; projectId?: string; manifest: MagicLayersManifest; jobId?: string };
const inFlight = new WeakMap<object, Map<string, Promise<{ bytes: Buffer; manifest: MagicLayersManifest }>>>();
const invalid = () => new Error("COURSEWARE_MAGICLAYERS_INVALID_RESPONSE");

/** DeckWise owns recovery; the gateway only forwards the stable, identity-scoped request. */
export class CoursewareMagicLayersMedia extends CoursewareMediaTransport {
  async split(input: { key: string; requestHash: string; sourceSha256: string; image: Buffer; projectId?: string;
    plan(): Promise<MagicLayersManifest>; check(): Promise<void>; signal: AbortSignal }) {
    const principal = this.principal();
    if (!/^[a-f0-9-]{36}$/u.test(input.key) || !/^[a-f0-9]{64}$/u.test(input.requestHash) ||
        !/^[a-f0-9]{64}$/u.test(input.sourceSha256) || input.image.length > 8 * 1024 * 1024) throw invalid();
    let jobs = inFlight.get(principal);
    if (!jobs) { jobs = new Map(); inFlight.set(principal, jobs); }
    const existing = jobs.get(input.key);
    if (existing) return existing;
    const operation = this.run(input, principal);
    jobs.set(input.key, operation);
    try { return await operation; } finally { jobs.delete(input.key); }
  }

  private async run(input: Parameters<CoursewareMagicLayersMedia["split"]>[0], principal: object) {
    const journal = this.options.relayJournal;
    if (!journal) throw new Error("COURSEWARE_MEDIA_JOURNAL_UNAVAILABLE");
    const key = `candidate:magiclayers:${input.key}`;
    const current = async () => { input.signal.throwIfAborted(); this.assertPrincipal(principal); await input.check(); this.assertPrincipal(principal); input.signal.throwIfAborted(); };
    await current();
    let row = await journal("read", key) as { revision: number; value: Saved } | null;
    await current();
    if (!row) {
      const manifest = await input.plan();
      await current();
      row = await journal("write", key, { requestHash: input.requestHash, sourceSha256: input.sourceSha256,
        ...(input.projectId ? { projectId: input.projectId } : {}), manifest }, 0) as NonNullable<typeof row>;
    }
    const saved = row.value;
    if (!saved || saved.requestHash !== input.requestHash || saved.sourceSha256 !== input.sourceSha256 || saved.projectId !== input.projectId || !saved.manifest?.objects?.length)
      throw new Error("COURSEWARE_MAGICLAYERS_SOURCE_CHANGED");
    const path = `${mediaSubmissionPath(input.projectId).replace(/\/tasks$/u, "")}/magiclayers/jobs/${input.key}`;
    const receive = async (suffix = "", init: RequestInit = {}) => {
      await current();
      const response = await this.receive(path + suffix, principal, input.signal, suffix ? 64 * 1024 * 1024 : 64 * 1024,
        init, suffix ? "application/zip" : "application/json", 30_000, true, true);
      await current();
      if (response.status < 200 || response.status >= 300)
        throw new Error(`COURSEWARE_MAGICLAYERS_HTTP_${response.status}: ${response.bytes.toString("utf8").slice(0, 16000)}`);
      if (response.mime !== (suffix ? "application/zip" : "application/json")) throw invalid();
      return response.bytes;
    };
    const status = async (): Promise<Job | null> => {
      try {
        const value = JSON.parse((await receive()).toString("utf8"));
        if (!value || !/^[a-f0-9]{32}$/u.test(value.id) || saved.jobId && value.id !== saved.jobId ||
            !["queued", "running", "succeeded", "failed"].includes(value.status) ||
            value.error != null && typeof value.error !== "string") throw invalid();
        return value;
      } catch (error) {
        if (error instanceof Error && error.message.startsWith("COURSEWARE_MAGICLAYERS_HTTP_404:") && !saved.jobId) return null;
        throw error;
      }
    };
    const mapped = (job: Job | null) => job && ({ state: job.status === "succeeded" ? "ready" : job.status === "failed" ? "failed" : "submitted" });
    let job = await status();
    if (!job) {
      await this.generate("image-layers", principal, async () => {
        // Another invocation may have recovered the same stable job while this request queued.
        let known = await status();
        if (!known) {
          const body = new FormData();
          body.set("image", new Blob([new Uint8Array(input.image)], { type: "image/png" }), "input.png");
          body.set("manifest", JSON.stringify(saved.manifest));
          const value = JSON.parse((await receive("", { method: "POST", body })).toString("utf8"));
          if (!value || !/^[a-f0-9]{32}$/u.test(value.jobId)) throw invalid();
          saved.jobId = value.jobId;
          row = await journal("write", key, saved, row!.revision) as NonNullable<typeof row>;
          known = await status();
        }
        if (!known) throw invalid();
        job = known;
        return mapped(known)!;
      }, async () => mapped(await status()), input.signal, current);
    }
    while (job?.status === "queued" || job?.status === "running") {
      await delay(3000, undefined, { signal: input.signal });
      job = await status();
    }
    if (!job || job.status !== "succeeded") throw new Error(`COURSEWARE_MAGICLAYERS_FAILED: ${job?.error?.slice(0, 1000) ?? "missing job"}`);
    return { bytes: await receive("/result"), manifest: saved.manifest };
  }
}
