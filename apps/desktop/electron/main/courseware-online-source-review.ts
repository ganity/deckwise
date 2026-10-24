import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { isDeepStrictEqual as equal } from "node:util";
import type { IpcMain } from "electron";
import { COURSEWARE_MAX_BYTES, isCoursewareProject, isCoursewareOnlineSourceMapping,
  type CoursewareOnlineSourceReviewView, type CoursewareOnlineSourceReviewResult, type CoursewareOnlineSourceCaptureResult,
  type CoursewareOnlineSourceMapping, type CoursewareSnapshot, type CoursewareProject } from "@pi-desktop/shared";
import type { CoursewareOnlineEditingClient, CoursewareOnlineSourceReview, CoursewareOnlineWritePause } from "./courseware-online-editing";
import type { CoursewareMediaClient } from "./courseware-media";
import type { OnlineTeachingBinding } from "./courseware-online-teaching";
import { stageOnlineSourceFiles } from "./courseware-online-source-files";
import { importOnlineCoursewareSnapshot } from "./courseware-online-snapshot";
import { renderCoursewareSourceVisuals } from "./courseware-source-visuals";

type Host = { call<T>(method: string, params: unknown): Promise<T> };
type Binding = OnlineTeachingBinding & { documentKey: string };
type Options = {
  binding(ownerId: string): Binding;
  client(): CoursewareOnlineEditingClient;
  media(): Pick<CoursewareMediaClient, "getTeamAsset" | "downloadTeamAsset">;
  principal(): { assertCurrent(): void };
  getHost(): Host | null;
  getWorkspaceRoot(): Promise<string | null>;
  getViewingSessionId(): string | null;
  ipcMain: IpcMain;
};
type Pin = {
  viewId: string; generation: number; binding: Binding; sessionId: string; workspace: string; host: Host;
  principal: ReturnType<Options["principal"]>; client: CoursewareOnlineEditingClient; abort: AbortController;
  pause?: CoursewareOnlineWritePause; barrierId?: string; saveRequestId?: string; baselineId?: string; reviewId?: string;
  target?: { source: CoursewareProject["source"]; byteLength: number; sessionEpoch: number; callbackId: string };
  files?: Awaited<ReturnType<typeof stageOnlineSourceFiles>>; view?: CoursewareOnlineSourceReviewView;
  resolved?: { project: CoursewareProject; mapping: CoursewareOnlineSourceMapping };
  captureAttempted?: boolean; captured?: CoursewareOnlineSourceReview; snapshot?: CoursewareSnapshot;
  cleanup?: Promise<void>;
};
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u;
const sha256 = /^[a-f0-9]{64}$/u;
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const identifier = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 200;
const changed = () => new Error("COURSEWARE_ONLINE_SOURCE_CHANGED");
const invalid = () => new Error("COURSEWARE_ONLINE_SOURCE_INVALID");

/** Review and capture an immutable saved source without changing live editing or publishing. */
export class CoursewareOnlineSourceReviewCoordinator {
  private pin: Pin | null = null;
  private generation = 0;
  private busy = false;
  private active?: Promise<unknown>;
  private cleanupQueue: Promise<void> = Promise.resolve();
  private cleanupFailed = false;
  private cleaning = 0;

  constructor(private readonly options: Options) {}

  assertNoPendingOperation(): void {
    if (this.busy || this.pin || this.cleaning > 0 || this.cleanupFailed) throw new Error("COURSEWARE_ONLINE_SOURCE_BUSY");
  }

  invalidate(): void {
    this.generation++;
    const pin = this.pin, active = this.active;
    this.pin = null;
    pin?.abort.abort();
    this.cleaning++;
    this.cleanupQueue = this.cleanupQueue.then(async () => {
      await active?.catch(() => {});
      if (pin) await this.cleanup(pin);
    }).catch(() => { this.cleanupFailed = true; console.error("COURSEWARE_ONLINE_SOURCE_CLEANUP_FAILED"); }).finally(() => { this.cleaning--; });
  }

  begin(ownerId: string, sessionId: string): Promise<CoursewareOnlineSourceReviewView> {
    if (!uuid.test(ownerId) || !/^[\w.-]{1,128}$/u.test(sessionId)) return Promise.reject(invalid());
    if (this.busy || this.pin) return Promise.reject(new Error("COURSEWARE_ONLINE_SOURCE_BUSY"));
    const generation = ++this.generation;
    return this.run(async () => {
      await this.cleanupQueue;
      if (this.cleanupFailed) throw new Error("COURSEWARE_ONLINE_SOURCE_CLEANUP_FAILED");
      const principal = this.options.principal(), host = this.options.getHost(), binding = this.options.binding(ownerId);
      const workspace = await this.options.getWorkspaceRoot();
      principal.assertCurrent();
      if (!host || !workspace || generation !== this.generation || this.options.getViewingSessionId() !== sessionId ||
          this.options.getHost() !== host || !equal(this.options.binding(ownerId), binding)) throw changed();
      const pin: Pin = { viewId: randomUUID(), generation, binding: structuredClone(binding), sessionId, workspace, host, principal,
        client: this.options.client(), abort: new AbortController() };
      this.pin = pin;
      try {
        await this.check(pin);
        const session = await this.step(pin, host.call<{ session?: { id: string; projectPath?: string } }>("session.get", { id: sessionId, messageLimit: 1 }));
        if (session.session?.id !== sessionId || session.session.projectPath !== workspace) throw changed();
        const current = await this.step(pin, pin.client.current(binding.projectId, pin.abort.signal));
        if (!current.active || current.epoch !== binding.sessionEpoch || current.sessionId !== binding.documentKey) throw changed();
        const pause = await this.step(pin, pin.client.currentWritePause(binding.projectId, binding.sessionEpoch, pin.abort.signal));
        if (!pause || pause.state !== "held" || !equal(pause.teaching.project.source, binding.source)) throw changed();
        pin.pause = structuredClone(pause);
        const barrier = await this.step(pin, pin.client.currentNativeBarrier(binding.projectId, binding.sessionEpoch, pin.abort.signal));
        if (!barrier || barrier.pauseId !== pause.pauseId || barrier.state !== "held" || barrier.coverage !== "managed" ||
            !barrier.allRegisteredClientsHeld || barrier.clients.length === 0 || barrier.clients.some(client => client.state !== "held" || !client.nativeReady))
          throw new Error("COURSEWARE_ONLINE_SOURCE_NOT_READY");
        pin.barrierId = barrier.barrierId;
        const mapping = await this.step(pin, pin.client.getTeachingMapping(binding.projectId, binding.source.revision,
          pause.teaching.mappingRevision, pin.abort.signal));
        if (!equal(mapping.source, binding.source)) throw changed();
        await this.assertFrozen(pin);
        const requestId = randomUUID(), timeout = AbortSignal.any([pin.abort.signal, AbortSignal.timeout(90_000)]);
        pin.saveRequestId = requestId;
        let saved = await this.step(pin, pin.client.requestBarrierForceSave(binding.projectId, binding.sessionEpoch,
          barrier.barrierId, requestId, binding.documentKey, timeout));
        while (saved.state !== "archived") {
          if (!["submitting", "command_unknown", "pending"].includes(saved.state)) throw new Error("COURSEWARE_ONLINE_SOURCE_NOT_READY");
          await this.step(pin, delay(250, undefined, { signal: timeout }));
          saved = await this.step(pin, pin.client.getForceSave(binding.projectId, binding.sessionEpoch, requestId, binding.documentKey, timeout));
        }
        if (!saved.callbackId) throw invalid();
        const target = await this.step(pin, pin.client.downloadCallbackArchive(binding.projectId, binding.sessionEpoch, saved.callbackId, binding.documentKey, pin.abort.signal));
        if (target.receipt.documentStatus !== 6) throw invalid();
        const original = await this.step(pin, pin.client.downloadSource(binding.projectId, binding.source.revision, pin.abort.signal));
        if (!equal(original.version.source, binding.source)) throw changed();
        pin.target = { source: { revision: randomUUID(), sha256: target.receipt.sha256 }, byteLength: target.receipt.byteLength,
          sessionEpoch: binding.sessionEpoch, callbackId: saved.callbackId };
        pin.files = await stageOnlineSourceFiles({ getHost: this.options.getHost, workspace, sessionId,
          original: { source: binding.source, bytes: original.bytes }, target: { source: pin.target.source, bytes: target.bytes },
          signal: pin.abort.signal, assertCurrent: () => this.check(pin) });
        await this.check(pin);
        const baseline = await pin.files.withParsed("original", async (host, jobId) => {
          const value = await host.call<unknown>("courseware.onlineSource.baseline", { sessionId, jobId,
            sourceByteLength: original.version.byteLength, project: pause.teaching.project, mapping: mapping.mapping });
          if (!record(value) || typeof value.baselineId !== "string" || !uuid.test(value.baselineId)) throw invalid();
          pin.baselineId = value.baselineId;
          await this.check(pin);
          if (value.projectId !== binding.projectId || !equal(value.source, binding.source) ||
              value.teachingRevision !== pause.teaching.project.teachingRevision || value.mappingRevision !== pause.teaching.mappingRevision) throw invalid();
          return value.baselineId;
        });
        const review = await pin.files.withParsed("target", (host, jobId) => this.step(pin,
          host.call<unknown>("courseware.onlineSource.review", { sessionId, baselineId: baseline, jobId, target: pin.target })));
        pin.view = this.publicView(pin, review);
        await this.assertFrozen(pin);
        return structuredClone(pin.view);
      } catch (error) {
        if (this.pin === pin) this.pin = null;
        pin.abort.abort();
        try { await this.cleanup(pin); } catch { this.cleanupFailed = true; throw new Error("COURSEWARE_ONLINE_SOURCE_CLEANUP_FAILED"); }
        throw error;
      }
    });
  }

  resolve(viewId: string, decisions: unknown): Promise<CoursewareOnlineSourceReviewResult> {
    const pin = this.require(viewId);
    let snapshot: Record<string, unknown>;
    try {
      if (!record(decisions) || Object.keys(decisions).length !== 3 || !["pages", "removedPages", "cues"].every(key => Array.isArray(decisions[key]))) throw invalid();
      const serialized = JSON.stringify(decisions);
      if (Buffer.byteLength(serialized) > COURSEWARE_MAX_BYTES) throw invalid();
      snapshot = JSON.parse(serialized) as Record<string, unknown>;
      if (!equal(snapshot, decisions)) throw invalid();
    } catch { return Promise.reject(invalid()); }
    return this.run(async () => {
      if (pin.captureAttempted) throw new Error("COURSEWARE_ONLINE_SOURCE_BUSY");
      pin.resolved = undefined;
      await this.assertFrozen(pin);
      const result = await pin.files!.withParsed("target", (host, jobId) => this.step(pin,
        host.call<unknown>("courseware.onlineSource.resolve", { sessionId: pin.sessionId, baselineId: pin.baselineId,
          reviewId: pin.reviewId, jobId, target: pin.target, ...snapshot })));
      if (!record(result) || result.reviewId !== pin.reviewId || !isCoursewareProject(result.project) ||
          result.project.projectId !== pin.binding.projectId || !equal(result.project.source, pin.target!.source) ||
          !isCoursewareOnlineSourceMapping(result.mapping) || result.mapping.sourceSha256 !== pin.target!.source.sha256 ||
          result.mapping.pages.length !== result.project.pages.length) throw invalid();
      const project = result.project;
      if (result.mapping.pages.some((page, index) => page.pageId !== project.pages[index]!.pageId)) throw invalid();
      await this.assertFrozen(pin);
      pin.resolved = { project: structuredClone(result.project), mapping: structuredClone(result.mapping) };
      return { viewId, ownerId: pin.binding.ownerId, status: "reviewed", readyPages: result.project.pages.filter(page => page.reviewState === "ready").length,
        totalPages: result.project.pages.length };
    });
  }

  capture(viewId: string): Promise<CoursewareOnlineSourceCaptureResult> {
    const pin = this.require(viewId);
    return this.run(async () => {
      await this.check(pin);
      if (pin.snapshot) return { viewId, ownerId: pin.binding.ownerId, snapshot: structuredClone(pin.snapshot) };
      if (!pin.resolved || pin.resolved.project.pages.some(page => page.reviewState !== "ready"))
        throw new Error("COURSEWARE_ONLINE_SOURCE_NOT_READY");
      if (!pin.captureAttempted) await this.assertFrozen(pin);
      const { project, mapping } = pin.resolved, b = pin.binding;
      if (!pin.captured) {
        let captured: CoursewareOnlineSourceReview;
        if (pin.captureAttempted) {
          try { captured = await pin.client.getVerifiedSourceReview(b.projectId, pin.target!.source.revision, pin.abort.signal); }
          catch (error) {
            await this.check(pin);
            if (error instanceof Error && /COURSEWARE_ONLINE_(?:PLATFORM_(?:404|46606)|HTTP_404)$/u.test(error.message))
              throw new Error("COURSEWARE_ONLINE_SOURCE_CAPTURE_UNCERTAIN");
            throw error;
          }
        } else {
          // Retain the exact intent before POST; an uncertain response permits only GET recovery.
          pin.captureAttempted = true;
          try {
            captured = await pin.client.captureVerifiedSourceReview(b.projectId, {
              requestId: pin.target!.source.revision, sessionEpoch: b.sessionEpoch, pauseId: pin.pause!.pauseId,
              barrierId: pin.barrierId!, forceSaveRequestId: pin.saveRequestId!, expectedSourceRevision: b.source.revision,
              expectedTeachingRevision: pin.pause!.teaching.project.teachingRevision, project, mapping,
            }, pin.abort.signal);
          } catch {
            await this.check(pin);
            throw new Error("COURSEWARE_ONLINE_SOURCE_CAPTURE_UNCERTAIN");
          }
        }
        await this.check(pin);
        if (!captured || captured.snapshotId !== pin.target!.source.revision || captured.sessionEpoch !== b.sessionEpoch ||
            captured.forceSaveRequestId !== pin.saveRequestId || captured.callbackId !== pin.target!.callbackId ||
            captured.sourceByteLength !== pin.target!.byteLength || captured.baselineSourceRevision !== b.source.revision ||
            captured.baselineTeachingRevision !== pin.pause!.teaching.project.teachingRevision ||
            !isCoursewareProject(captured.teaching?.project) || !uuid.test(captured.teaching.project.teachingRevision) ||
            captured.teaching.project.teachingRevision === captured.baselineTeachingRevision ||
            captured.teaching.mappingRevision !== mapping.revision || !equal(captured.mapping, mapping) ||
            !equal(captured.teaching.project, { ...project, teachingRevision: captured.teaching.project.teachingRevision })) throw invalid();
        // The verified receipt owns its saved R8 even if another client has resumed R9.
        pin.captured = structuredClone(captured);
      }
      pin.snapshot = await importOnlineCoursewareSnapshot({
        workspace: pin.workspace, sessionId: pin.sessionId, review: pin.captured,
        expected: { projectId: b.projectId, sessionEpoch: b.sessionEpoch, forceSaveRequestId: pin.saveRequestId!,
          callbackId: pin.target!.callbackId, source: pin.target!.source, sourceByteLength: pin.target!.byteLength },
        files: pin.files!, media: this.options.media(), getHost: this.options.getHost,
        assertCurrent: () => this.check(pin), signal: pin.abort.signal,
      });
      await this.check(pin);
      return { viewId, ownerId: b.ownerId, snapshot: structuredClone(pin.snapshot) };
    });
  }

  preview(viewId: string, side: "original" | "target", page: number): Promise<string> {
    const pin = this.require(viewId);
    return this.run(async () => {
      await this.check(pin);
      const pages = side === "original" ? pin.view!.previousPages : side === "target" ? pin.view!.targetPages : [];
      if (!Number.isSafeInteger(page) || page < 1 || page > pages.length) throw invalid();
      const visuals = await pin.files!.preview(side, page, input => renderCoursewareSourceVisuals({ ...input, ipcMain: this.options.ipcMain }));
      await this.check(pin);
      return `data:image/png;base64,${Buffer.from(visuals.normal.image.bytes).toString("base64")}`;
    });
  }

  async clear(viewId: string): Promise<void> {
    const pin = this.require(viewId), active = this.active;
    this.generation++; this.pin = null; pin.abort.abort();
    await active?.catch(() => {});
    try { await this.cleanup(pin); } catch { this.cleanupFailed = true; throw new Error("COURSEWARE_ONLINE_SOURCE_CLEANUP_FAILED"); }
  }

  private require(viewId: string): Pin {
    const pin = this.pin;
    if (!pin || pin.viewId !== viewId || !pin.view || !pin.files || !pin.target || !pin.reviewId) throw changed();
    return pin;
  }

  private run<T>(operation: () => Promise<T>): Promise<T> {
    if (this.busy) return Promise.reject(new Error("COURSEWARE_ONLINE_SOURCE_BUSY"));
    this.busy = true;
    const result = operation().finally(() => { this.busy = false; });
    this.active = result;
    return result;
  }

  private async check(pin: Pin): Promise<void> {
    const check = () => {
      pin.abort.signal.throwIfAborted(); pin.principal.assertCurrent();
      if (this.pin !== pin || this.generation !== pin.generation || this.options.getHost() !== pin.host ||
          this.options.getViewingSessionId() !== pin.sessionId || !equal(this.options.binding(pin.binding.ownerId), pin.binding)) throw changed();
    };
    check();
    if (await this.options.getWorkspaceRoot() !== pin.workspace) throw changed();
    check();
  }
  private async step<T>(pin: Pin, operation: Promise<T>): Promise<T> { const value = await operation; await this.check(pin); return value; }

  private async assertFrozen(pin: Pin): Promise<void> {
    await this.check(pin);
    const b = pin.binding;
    const pause = await this.step(pin, pin.client.getWritePause(b.projectId, b.sessionEpoch, pin.pause!.pauseId, pin.abort.signal));
    if (!equal(pause, pin.pause) || pause.state !== "held") throw changed();
    const barrier = await this.step(pin, pin.client.getNativeBarrier(b.projectId, b.sessionEpoch, pin.barrierId!, pin.abort.signal));
    if (barrier.state !== "held" || barrier.pauseId !== pin.pause!.pauseId || barrier.coverage !== "managed" ||
        !barrier.allRegisteredClientsHeld || barrier.clients.length === 0 || barrier.clients.some(client => client.state !== "held" || !client.nativeReady)) throw changed();
  }

  private async cleanup(pin: Pin): Promise<void> {
    if (!pin.cleanup) pin.cleanup = (async () => {
      let failed = false;
      if (pin.baselineId) {
        try { await pin.host.call("courseware.onlineSource.clear", { sessionId: pin.sessionId, baselineId: pin.baselineId }); }
        catch { failed = true; }
      }
      try { await pin.files?.dispose(); } catch { failed = true; }
      if (failed) throw new Error("COURSEWARE_ONLINE_SOURCE_CLEANUP_FAILED");
    })();
    await pin.cleanup;
  }

  private publicView(pin: Pin, raw: unknown): CoursewareOnlineSourceReviewView {
    if (!record(raw) || raw.baselineId !== pin.baselineId || typeof raw.reviewId !== "string" || !sha256.test(raw.reviewId) ||
        raw.requiresExplicitAssociations !== true || !record(raw.original) || !equal(raw.original.project, pin.pause!.teaching.project) ||
        !record(raw.target) || !equal(raw.target.source, pin.target!.source) || raw.target.byteLength !== pin.target!.byteLength ||
        raw.target.sessionEpoch !== pin.target!.sessionEpoch || raw.target.callbackId !== pin.target!.callbackId ||
        !Array.isArray(raw.previousPages) || !Array.isArray(raw.target.pages)) throw invalid();
    const previousPages = raw.previousPages.map((page, index) => {
      if (!record(page) || page.pageNumber !== index + 1 || page.pageId !== pin.pause!.teaching.project.pages[index]?.pageId || !Array.isArray(page.objects)) throw invalid();
      return { pageId: page.pageId as string, pageNumber: index + 1, objects: page.objects.map(object => {
        if (!record(object) || !identifier(object.objectId) || !identifier(object.kind) || !Number.isSafeInteger(object.index)) throw invalid();
        return { objectId: object.objectId, index: Number(object.index), kind: object.kind };
      }) };
    });
    if (previousPages.length !== pin.pause!.teaching.project.pages.length || raw.target.pages.length < 1 || raw.target.pages.length > 100) throw invalid();
    const targetPages = raw.target.pages.map((page, index) => {
      if (!record(page) || page.pageNumber !== index + 1 || !identifier(page.importPageId) || !Array.isArray(page.objects)) throw invalid();
      return { importPageId: page.importPageId, pageNumber: index + 1, objects: page.objects.map(object => {
        if (!record(object) || !identifier(object.importElementId) || !identifier(object.kind) || !Number.isSafeInteger(object.index)) throw invalid();
        return { importElementId: object.importElementId, index: Number(object.index), kind: object.kind };
      }) };
    });
    pin.reviewId = raw.reviewId;
    return { viewId: pin.viewId, ownerId: pin.binding.ownerId, original: { project: structuredClone(pin.pause!.teaching.project) }, previousPages, targetPages };
  }
}
