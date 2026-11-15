import { randomUUID } from "node:crypto";
import type { CoursewareDeliveryView } from "@pi-desktop/shared";

type Current = { documentId: string; fingerprint: string };
type Remote = Omit<CoursewareDeliveryView, "dirty" | "pending">;
type Pending = { operationId: string; source: Current; fileUrl: string; packageHash: string; title: string; expectedRevisionId: string | null };
type Journal = { syncedFingerprint?: string; revisionId?: string; pending?: Pending; publish?: { operationId: string; revisionId: string; version: number; releaseSequence: number } };
type Host = { call<T>(method: string, params: unknown): Promise<T> };

/** Durable local intent and server receipts fence retries, document edits and account changes. */
export class CoursewareDelivery {
  private running = false;
  private review: { id: string; principalKey: string; source: Current; codes: string[]; diagnostics: Array<{ code: string; message: string }> } | null = null;
  constructor(private input: {
    assertOwned?(sessionId: string): void;
    principal(): { key: string; assertCurrent(): void };
    host(): Host;
    current(sessionId: string): Promise<Current>;
    archive(sessionId: string, reviewedWarningCodes?: string[]): Promise<{ bytes: Buffer; source: Current }>;
    upload(bytes: Buffer): Promise<{ fileUrl: string; packageHash: string }>;
    request<T>(action: "state" | "sync" | "publish", payload: Record<string, unknown>): Promise<T>;
  }) {}
  async execute(value: unknown): Promise<CoursewareDeliveryView> {
    if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some(k => !["action", "sessionId", "title", "expectedCloudRevisionId", "reviewId"].includes(k))) throw new Error("Invalid delivery request");
    const expectedCloudRevisionId = Reflect.get(value, "expectedCloudRevisionId");
    if (expectedCloudRevisionId !== undefined && (typeof expectedCloudRevisionId !== "string" || !/^[\w.-]{1,128}$/.test(expectedCloudRevisionId))) throw new Error("Invalid cloud draft revision");
    const action = Reflect.get(value, "action"), sessionId = Reflect.get(value, "sessionId"), title = Reflect.get(value, "title");
    if (!["state", "sync", "publish"].includes(action) || typeof sessionId !== "string" || !sessionId || action === "sync" && (typeof title !== "string" || !title.trim() || title.length > 200)) throw new Error("Invalid delivery request");
    if (this.running) throw new Error("Courseware delivery is already running");
    this.running = true;
    try {
      const principal = this.input.principal(), host = this.input.host();
      const assert = () => { this.input.assertOwned?.(sessionId); principal.assertCurrent(); if (this.input.host() !== host) throw new Error("Courseware Host changed"); };
      const current = await this.input.current(sessionId); assert();
      const key = { sessionId, principal: principal.key, documentId: current.documentId };
      let journal = await host.call<Journal | null>("courseware.delivery.read", key); assert();
      const save = async (next: Journal) => { assert(); const result = await host.call<Journal>("courseware.delivery.write", { ...key, expected: journal, value: next }); assert(); journal = result; };
      const send = async <T>(kind: "sync" | "publish", payload: Record<string, unknown>): Promise<T> => {
        try { return await this.input.request<T>(kind, payload); }
        catch (error) {
          const code = error && typeof error === "object" ? Reflect.get(error, "code") : undefined;
          if ([400, 409].includes(code)) await save({ syncedFingerprint: journal?.syncedFingerprint, revisionId: journal?.revisionId });
          throw error;
        }
      };
      const remote = async () => { const result = await this.input.request<Remote>("state", { documentId: current.documentId }); assert(); return result; };
      const view = (state: Remote): CoursewareDeliveryView => ({ ...state, pending: !!journal?.pending || !!journal?.publish, pendingAction: journal?.publish ? "publish" : journal?.pending ? "sync" : undefined,
        dirty: !journal?.syncedFingerprint || journal.syncedFingerprint !== current.fingerprint || journal.revisionId !== state.revisionId || state.cloudRevisionId !== state.revisionId });
      if (action === "state") return view(await remote());
      const reviewId = Reflect.get(value, "reviewId");
      if (reviewId !== undefined && (!this.review || reviewId !== this.review.id || this.review.principalKey !== principal.key || this.review.source.documentId !== current.documentId || this.review.source.fingerprint !== current.fingerprint))
        throw new Error("Courseware conversion review expired; synchronize again");
      if (journal?.publish) {
        const state = await remote(), publish = journal.publish;
        if (!state.courseId) throw new Error("Platform course binding is unavailable");
        await send("publish", { courseId: state.courseId, published: true, operationId: publish.operationId,
          expectedRevisionId: publish.revisionId, expectedVersion: publish.version, expectedReleaseSequence: publish.releaseSequence }); assert();
        await save({ syncedFingerprint: journal.syncedFingerprint, revisionId: journal.revisionId });
      }
      if (action === "sync") {
        // Resolve a lost sync response before adopting another local revision.
        if (journal?.pending) {
          const pending = journal.pending;
          const result = await send<Remote>("sync", { documentId: pending.source.documentId, operationId: pending.operationId, fileUrl: pending.fileUrl, packageHash: pending.packageHash, title: pending.title, expectedRevisionId: pending.expectedRevisionId }); assert();
          await save({ syncedFingerprint: pending.source.fingerprint, revisionId: result.revisionId });
        }
        let state = await remote();
        if (journal?.syncedFingerprint === current.fingerprint && journal.revisionId === state.revisionId && state.cloudRevisionId === state.revisionId) return view(state);
        if (state.cloudRevisionId && state.cloudRevisionId !== state.revisionId && expectedCloudRevisionId !== state.cloudRevisionId)
          throw new Error("COURSEWARE_CONFLICT: cloud draft changed; resolve it before synchronizing");
        let archive: { bytes: Buffer; source: Current };
        try { archive = await this.input.archive(sessionId, reviewId ? this.review!.codes : []); }
        catch (error) {
          assert();
          const code = error && typeof error === "object" ? Reflect.get(error, "code") : undefined;
          const diagnostics = error && typeof error === "object" ? Reflect.get(error, "diagnostics") : undefined;
          if (code === "CONTENT_REVIEW_REQUIRED" && Array.isArray(diagnostics) && diagnostics.length && diagnostics.every(d => d.severity !== "error" && typeof d.code === "string" && typeof d.message === "string")) {
            const review = { id: randomUUID(), principalKey: principal.key, source: current, codes: [...new Set(diagnostics.map(d => String(d.code)))], diagnostics: diagnostics.map(d => ({ code: String(d.code), message: String(d.message) })) };
            this.review = review;
            return { ...view(state), review: { id: review.id, diagnostics: review.diagnostics } };
          }
          throw error;
        }
        assert(); this.review = null;
        if (archive.source.documentId !== current.documentId || archive.source.fingerprint !== current.fingerprint) throw new Error("Courseware changed during export");
        const uploaded = await this.input.upload(archive.bytes); assert();
        const beforeSubmit = await this.input.current(sessionId); assert();
        if (beforeSubmit.documentId !== current.documentId || beforeSubmit.fingerprint !== current.fingerprint) throw new Error("COURSEWARE_SYNC_REQUIRED: courseware changed during upload; synchronize again");
        const pending: Pending = { operationId: randomUUID(), source: current, ...uploaded, title: title.trim(), expectedRevisionId: expectedCloudRevisionId ?? state.revisionId ?? null };
        await save({ ...journal, pending });
        state = await send<Remote>("sync", { documentId: current.documentId, operationId: pending.operationId,
          title: pending.title, fileUrl: pending.fileUrl, packageHash: pending.packageHash, expectedRevisionId: pending.expectedRevisionId }); assert();
        await save({ syncedFingerprint: current.fingerprint, revisionId: state.revisionId });
        const latest = await this.input.current(sessionId); assert();
        return { ...view(state), dirty: latest.documentId !== current.documentId || latest.fingerprint !== current.fingerprint };
      }
      let state = await remote();
      if (journal?.pending || !journal?.syncedFingerprint || journal.syncedFingerprint !== current.fingerprint || !state.synced || !state.courseId || !state.revisionId || journal.revisionId !== state.revisionId || state.cloudRevisionId !== state.revisionId)
        throw new Error("COURSEWARE_SYNC_REQUIRED: synchronize the latest draft before publishing");
      const latest = await this.input.current(sessionId); assert();
      if (latest.documentId !== current.documentId || latest.fingerprint !== current.fingerprint) throw new Error("COURSEWARE_SYNC_REQUIRED: courseware changed; synchronize first");
      const publish = journal.publish ?? { operationId: randomUUID(), revisionId: state.revisionId, version: state.version ?? 0, releaseSequence: state.releaseSequence ?? 0 };
      await save({ ...journal, publish });
      await send("publish", { courseId: state.courseId, published: true, operationId: publish.operationId,
        expectedRevisionId: publish.revisionId, expectedVersion: publish.version, expectedReleaseSequence: publish.releaseSequence }); assert();
      await save({ syncedFingerprint: current.fingerprint, revisionId: state.revisionId });
      state = await remote();
      return view(state);
    } finally { this.running = false; }
  }
}
