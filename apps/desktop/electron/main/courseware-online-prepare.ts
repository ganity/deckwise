import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { basename } from "node:path";
import { isDeepStrictEqual as same } from "node:util";
import { isCoursewareProject, type CoursewareOnlineLaunch, type CoursewareOnlinePreparationResult, type CoursewareOnlinePreparationReview } from "@pi-desktop/shared";
import type { DesktopAuthSession } from "./auth-session";
import type { PptEditorController } from "./ppt-editor";
import { COURSEWARE_ONLINE_MAX_SOURCE_BYTES, type CoursewareOnlineEditingClient, type CoursewareOnlineSourceVersion } from "./courseware-online-editing";
import { readLiveSource, sourceHash } from "./courseware-source-files";
import { onlineTeachingSeed, projectOnlineMapping, projectOnlineTeaching, type CoursewareOnlineTeachingPins, type CoursewareOnlineTeachingSeed } from "./courseware-online-seed";
import { preflightCoursewareOnlineAudio, adoptCoursewareOnlineAudio } from "./courseware-online-audio";

type Host = { call<T>(method: string, params: unknown): Promise<T> };
type Snapshot = ReturnType<PptEditorController["sourceAdoptionSnapshot"]>;
type Phase = "upload-pending" | "uploaded" | "start-pending" | "started" | "bound";
type Receipt = {
  projectId: string; requestId: string; expectedEpoch: number; expectedSourceRevision: string | null;
  sourceSha256: string; byteLength: number; phase: Phase; uploadedRevision?: string; sessionEpoch?: number;
  teaching?: CoursewareOnlineTeachingPins;
};
type Options = {
  editor: Pick<PptEditorController, "sourceAdoptionSnapshot" | "verifyTeachingSource">;
  auth: Pick<DesktopAuthSession, "getCoursewarePrincipal" | "getCoursewareOnlineClient" | "joinCoursewareOnline" | "coursewareMedia">;
  getHost(): Host | null;
  getWorkspace(): Promise<string | null>;
  getSessionId(): string | null;
  assertOwned(sessionId: string): void;
};
type Review = {
  public: CoursewareOnlinePreparationReview; host: Host; workspace: string; snapshot: Snapshot;
  principal: ReturnType<DesktopAuthSession["getCoursewarePrincipal"]>; client: CoursewareOnlineEditingClient;
  expectedSourceRevision: string | null; receipt: Receipt | null; expires: number;
  seed?: CoursewareOnlineTeachingSeed;
};
type Pin = { principal: Review["principal"]; sessionId: string; workspace: string; result: CoursewareOnlinePreparationResult };
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u;
const conflict = () => new Error("COURSEWARE_ONLINE_PREPARATION_CHANGED");

/** Explicit review/confirm orchestration. Host owns non-secret recovery receipts. */
export class CoursewareOnlinePreparation {
  private current: Review | null = null;
  private busy = false;
  private generation = 0;
  private pins = new Map<string, Pin>();

  constructor(private readonly options: Options) {}

  invalidate(): void { this.generation++; this.current = null; this.pins.clear(); }
  cancel(reviewId: string): void {
    if (this.current?.public.reviewId === reviewId) { this.generation++; this.current = null; }
  }

  async review(sessionId: string, projectId: string, includeTeaching = false): Promise<CoursewareOnlinePreparationReview> {
    if (this.busy) throw new Error("COURSEWARE_ONLINE_PREPARATION_BUSY");
    if (!/^[\w.-]{1,128}$/u.test(sessionId) || !uuid.test(projectId) || typeof includeTeaching !== "boolean") throw new Error("COURSEWARE_ONLINE_INVALID_REQUEST");
    const generation = ++this.generation;
    this.current = null;
    const principal = this.options.auth.getCoursewarePrincipal(), host = this.options.getHost();
    this.options.assertOwned(sessionId);
    const workspace = await this.options.getWorkspace();
    principal.assertCurrent();
    if (!host || !workspace || this.options.getHost() !== host || this.options.getSessionId() !== sessionId || generation !== this.generation) throw conflict();
    const captured: Review = {
      public: { reviewId: randomUUID(), projectId, sessionId, fileName: "", byteLength: 0, sha256: "", expectedEpoch: 0, replacesSource: false },
      host, workspace, principal, snapshot: this.options.editor.sourceAdoptionSnapshot(workspace),
      client: this.options.auth.getCoursewareOnlineClient(), expectedSourceRevision: null, receipt: null, expires: Date.now() + 600_000,
    };
    this.current = captured;
    try {
      await this.assertTask(captured);
      await this.assertOwner(captured);
      const bytes = await this.readSource(captured);
      await this.step(captured, this.options.editor.verifyTeachingSource(workspace));
      if (includeTeaching) captured.seed = await this.readSeed(captured);
      const { receipt } = await this.step(captured, host.call<{ receipt: Receipt | null }>("courseware.onlinePrepare.get", this.identity(captured)));
      if (receipt && receipt.phase !== "bound") {
        if (receipt.projectId !== projectId || receipt.sourceSha256 !== captured.snapshot.sha256 || receipt.byteLength !== bytes.length) throw conflict();
        captured.receipt = receipt;
      }
      if (captured.receipt && !same(captured.receipt.teaching, captured.seed?.pins)) throw conflict();
      const source = await this.step(captured, captured.client.currentSource(projectId));
      const session = await this.step(captured, captured.client.current(projectId));
      if (captured.seed) {
        const teaching = await this.step(captured, captured.client.currentTeaching(projectId));
        if (!captured.receipt && (source || teaching)) throw new Error("COURSEWARE_ONLINE_TEACHING_CONFLICT");
        if (teaching && (!source || !await this.matchesSeed(captured, source.source, teaching))) throw new Error("COURSEWARE_ONLINE_TEACHING_CONFLICT");
      }
      if (captured.receipt) this.assertRemote(captured.receipt, source, session);
      else if (session.active) throw new Error("COURSEWARE_ONLINE_SESSION_ACTIVE");
      captured.expectedSourceRevision = captured.receipt?.expectedSourceRevision ?? source?.source.revision ?? null;
      captured.public = { ...captured.public, fileName: basename(captured.snapshot.sourcePath), byteLength: bytes.length,
        sha256: captured.snapshot.sha256, expectedEpoch: captured.receipt?.expectedEpoch ?? session.epoch,
        replacesSource: captured.receipt ? captured.receipt.expectedSourceRevision !== null : source !== null,
        ...(captured.seed ? { teaching: { pageCount: captured.seed.project.pages.length,
          narrationCount: captured.seed.project.pages.reduce((sum, page) => sum + page.actions.filter(action => action.type === "speech").length, 0),
          ...(captured.seed.audio ? { audioCount: new Set(captured.seed.audio.assets.map(asset => asset.assetId)).size } : {}) } } : {}),
        ...(captured.receipt ? { recovering: true } : {}) };
      await this.assertContext(captured);
      return { ...captured.public };
    } catch (error) { if (this.current === captured) this.current = null; throw error; }
  }

  async confirm(reviewId: string): Promise<CoursewareOnlinePreparationResult> {
    if (this.busy) throw new Error("COURSEWARE_ONLINE_PREPARATION_BUSY");
    const captured = this.current;
    if (!captured || captured.public.reviewId !== reviewId) throw conflict();
    this.busy = true;
    try {
      await this.assertContext(captured);
      await this.assertTask(captured);
      await this.assertOwner(captured);
      const bytes = await this.readSource(captured);
      await this.step(captured, this.options.editor.verifyTeachingSource(captured.workspace));
      const { receipt: saved } = await this.step(captured, captured.host.call<{ receipt: Receipt | null }>("courseware.onlinePrepare.get", this.identity(captured)));
      if (captured.receipt ? !same(saved, captured.receipt) : saved && saved.phase !== "bound") throw conflict();
      let receipt = captured.receipt;
      const source = await this.step(captured, captured.client.currentSource(captured.public.projectId));
      const session = await this.step(captured, captured.client.current(captured.public.projectId));
      if (receipt) this.assertRemote(receipt, source, session);
      else {
        if (session.active) throw new Error("COURSEWARE_ONLINE_SESSION_ACTIVE");
        if (session.epoch !== captured.public.expectedEpoch || (source?.source.revision ?? null) !== captured.expectedSourceRevision) throw conflict();
        receipt = await this.step(captured, captured.host.call<Receipt>("courseware.onlinePrepare.begin", {
          ...this.identity(captured), selection: { projectId: captured.public.projectId, requestId: randomUUID(),
            expectedEpoch: session.epoch, expectedSourceRevision: captured.expectedSourceRevision,
            sourceSha256: captured.snapshot.sha256, byteLength: bytes.length,
            ...(captured.seed ? { teaching: captured.seed.pins } : {}) },
        }));
        captured.receipt = receipt;
      }
      if (receipt.phase === "upload-pending") {
        let uploaded = source;
        if (!this.isUploaded(receipt, uploaded)) {
          await this.beforeWrite(captured);
          uploaded = await this.step(captured, captured.client.uploadSource(receipt.projectId, {
            requestId: receipt.requestId, ...(receipt.expectedSourceRevision ? { expectedSourceRevision: receipt.expectedSourceRevision } : {}),
            sourceSha256: receipt.sourceSha256, bytes, filename: captured.public.fileName,
          }));
        }
        if (!uploaded || !this.isUploaded(receipt, uploaded)) throw conflict();
        receipt = await this.advance(captured, receipt, "uploaded", { uploadedRevision: uploaded.source.revision });
      }
      if (captured.seed && receipt.uploadedRevision) await this.ensureTeaching(captured, receipt);
      if (receipt.phase === "uploaded") receipt = await this.advance(captured, receipt, "start-pending");
      if (receipt.phase === "start-pending") {
        const latestSource = await this.step(captured, captured.client.currentSource(receipt.projectId));
        let latest = await this.step(captured, captured.client.current(receipt.projectId));
        this.assertRemote(receipt, latestSource, latest);
        if (!latest.active) {
          await this.beforeWrite(captured);
          // Every confirm dispatches at most once; an interrupted attempt is reviewed again first.
          latest = await this.step(captured, captured.client.start(receipt.projectId, receipt.expectedEpoch, undefined, receipt.uploadedRevision));
        }
        if (!latest.active || latest.epoch !== receipt.expectedEpoch + 1) throw conflict();
        receipt = await this.advance(captured, receipt, "started", { sessionEpoch: latest.epoch });
      }
      if (receipt.phase === "started") {
        await this.assertOwner(captured);
        const latestSource = await this.step(captured, captured.client.currentSource(receipt.projectId));
        const latest = await this.step(captured, captured.client.current(receipt.projectId));
        this.assertRemote(receipt, latestSource, latest);
        await this.beforeWrite(captured);
        const binding = await this.step(captured, captured.client.bind(receipt.projectId, receipt.sessionEpoch!));
        if (binding.key !== latest.sessionId) throw conflict();
        receipt = await this.advance(captured, receipt, "bound");
      }
      if (receipt.phase !== "bound" || !receipt.uploadedRevision || !receipt.sessionEpoch) throw conflict();
      const result = { projectId: receipt.projectId, sessionEpoch: receipt.sessionEpoch,
        source: { revision: receipt.uploadedRevision, sha256: receipt.sourceSha256 } };
      this.pins.set(receipt.projectId, { principal: captured.principal, sessionId: captured.public.sessionId, workspace: captured.workspace, result });
      this.current = null;
      return structuredClone(result);
    } finally { this.busy = false; }
  }

  async join(projectId: string, signal?: AbortSignal, clientId?: string): Promise<CoursewareOnlineLaunch> {
    let pin = this.pins.get(projectId);
    if (pin && this.options.getSessionId() !== pin.sessionId) { this.pins.delete(projectId); pin = undefined; }
    if (pin) await this.assertPin(pin);
    const launch = await this.options.auth.joinCoursewareOnline(projectId, signal, clientId);
    if (pin) {
      await this.assertPin(pin);
      if (launch.sessionEpoch !== pin.result.sessionEpoch || !same(launch.source, pin.result.source)) throw conflict();
      this.pins.delete(projectId);
    }
    return launch;
  }

  private async assertPin(pin: Pin): Promise<void> {
    pin.principal.assertCurrent();
    if (this.options.getSessionId() !== pin.sessionId || await this.options.getWorkspace() !== pin.workspace) throw conflict();
    pin.principal.assertCurrent();
    if (this.options.getSessionId() !== pin.sessionId) throw conflict();
  }
  private identity(captured: Review) { return { sessionId: captured.public.sessionId, principalKey: captured.principal.key }; }
  private async assertContext(captured: Review): Promise<void> {
    const check = () => {
      captured.principal.assertCurrent();
      this.options.assertOwned(captured.public.sessionId);
      if (this.current !== captured || Date.now() >= captured.expires || this.options.getHost() !== captured.host ||
          this.options.getSessionId() !== captured.public.sessionId || !same(this.options.editor.sourceAdoptionSnapshot(captured.workspace), captured.snapshot)) throw conflict();
    };
    check();
    if (await this.options.getWorkspace() !== captured.workspace) throw conflict();
    check();
  }
  private async step<T>(captured: Review, promise: Promise<T>): Promise<T> {
    const result = await promise;
    await this.assertContext(captured);
    return result;
  }
  private async assertTask(captured: Review): Promise<void> {
    const { session } = await this.step(captured, captured.host.call<{ session?: { projectPath?: string } }>("session.get", { id: captured.public.sessionId }));
    if (session?.projectPath !== captured.workspace) throw conflict();
    const { task } = await this.step(captured, captured.host.call<{ task: { teamProjectId?: string } | null }>("courseware.task.get", { sessionId: captured.public.sessionId }));
    if (!task || task.teamProjectId && task.teamProjectId !== captured.public.projectId) throw conflict();
  }
  private async assertOwner(captured: Review): Promise<void> {
    const projects = await this.step(captured, this.options.auth.coursewareMedia.getTeamProjects());
    if (!projects.some(project => project.projectId === captured.public.projectId && project.role === "OWNER")) throw new Error("COURSEWARE_ONLINE_OWNER_REQUIRED");
  }
  private async beforeWrite(captured: Review): Promise<void> {
    await this.assertTask(captured);
    await this.assertOwner(captured);
    await this.step(captured, this.options.editor.verifyTeachingSource(captured.workspace));
    if (captured.seed && !same((await this.readSeed(captured)).pins, captured.seed.pins)) throw conflict();
    if (captured.seed?.audio) await this.step(captured, this.options.editor.verifyTeachingSource(captured.workspace));
  }
  private async readSeed(captured: Review): Promise<CoursewareOnlineTeachingSeed> {
    const projectId = `office-${captured.snapshot.documentId}`;
    let raw: unknown;
    try { raw = await this.step(captured, captured.host.call("courseware.project.context", { sessionId: captured.public.sessionId, projectId })); }
    catch (error) { await this.assertContext(captured); throw new Error("COURSEWARE_ONLINE_TEACHING_NOT_READY", { cause: error }); }
    const project = raw && typeof raw === "object" && "project" in raw && isCoursewareProject(raw.project) ? raw.project : undefined;
    const hasAudio = project?.pages.some(page => page.actions.some(action => action.type === "audio_clip" ||
      ["audioAssetId", "audioId", "audioUrl"].some(key => Object.hasOwn(action, key))));
    let audio;
    try {
      audio = hasAudio ? await this.step(captured, preflightCoursewareOnlineAudio({
        sessionId: captured.public.sessionId, project: project!, teamProjectId: captured.public.projectId,
        host: captured.host, media: this.options.auth.coursewareMedia,
        principal: { key: captured.principal.key, assertCurrent: () => this.assertContext(captured) },
      })) : undefined;
    } catch (error) {
      await this.assertContext(captured);
      if (error instanceof Error && error.message.startsWith("COURSEWARE_ONLINE_AUDIO_"))
        throw new Error("COURSEWARE_ONLINE_TEACHING_MEDIA_UNAVAILABLE", { cause: error });
      throw error;
    }
    return onlineTeachingSeed(raw, projectId, captured.snapshot.sha256, audio);
  }
  private async matchesSeed(captured: Review, source: { revision: string; sha256: string }, value: { project: import("@pi-desktop/shared").CoursewareProject; mappingRevision: string }): Promise<boolean> {
    const projected = projectOnlineTeaching(captured.seed!, captured.public.projectId, source);
    if (value.mappingRevision !== captured.seed!.mappingRevision ||
        !same({ ...value.project, teachingRevision: projected.teachingRevision }, projected)) return false;
    const fixed = await this.step(captured, captured.client.getTeachingMapping(captured.public.projectId, source.revision, captured.seed!.mappingRevision));
    return fixed.projectId === captured.public.projectId && same(fixed.source, source) && same(fixed.mapping, projectOnlineMapping(captured.seed!));
  }
  private async ensureTeaching(captured: Review, receipt: Receipt): Promise<void> {
    await this.beforeWrite(captured);
    if (captured.seed!.audio) {
      const audio = await this.step(captured, adoptCoursewareOnlineAudio({
        sessionId: captured.public.sessionId, project: captured.seed!.project, teamProjectId: receipt.projectId,
        host: captured.host, media: this.options.auth.coursewareMedia,
        principal: { key: captured.principal.key, assertCurrent: () => this.assertContext(captured) },
        expectedProjection: captured.seed!.audio, beforeAdopt: () => this.beforeWrite(captured),
      }));
      if (!same(audio.project, captured.seed!.audio.project)) throw conflict();
      await this.beforeWrite(captured);
    }
    const source = { revision: receipt.uploadedRevision!, sha256: receipt.sourceSha256 };
    const current = await this.step(captured, captured.client.currentTeaching(receipt.projectId));
    if (current && !await this.matchesSeed(captured, source, current)) throw new Error("COURSEWARE_ONLINE_TEACHING_CONFLICT");
    const initialized = await this.step(captured, captured.client.initializeTeaching(receipt.projectId, {
      requestId: receipt.requestId, mappingRevision: captured.seed!.mappingRevision,
      project: projectOnlineTeaching(captured.seed!, receipt.projectId, source),
      mapping: projectOnlineMapping(captured.seed!),
    }));
    const latest = await this.step(captured, captured.client.currentTeaching(receipt.projectId));
    if (!latest || !await this.matchesSeed(captured, source, initialized) || !same(latest, initialized))
      throw new Error("COURSEWARE_ONLINE_TEACHING_CONFLICT");
  }
  private async readSource(captured: Review): Promise<Buffer> {
    const live = await this.step(captured, fs.lstat(captured.snapshot.sourcePath));
    if (!live.isFile() || live.size > COURSEWARE_ONLINE_MAX_SOURCE_BYTES) throw new Error("COURSEWARE_ONLINE_SOURCE_TOO_LARGE");
    const stat = await this.step(captured, fs.lstat(captured.snapshot.path));
    if (!stat.isFile() || stat.size > COURSEWARE_ONLINE_MAX_SOURCE_BYTES) throw new Error("COURSEWARE_ONLINE_SOURCE_TOO_LARGE");
    const bytes = await this.step(captured, readLiveSource(captured.workspace, captured.snapshot.path));
    if (bytes.length > COURSEWARE_ONLINE_MAX_SOURCE_BYTES) throw new Error("COURSEWARE_ONLINE_SOURCE_TOO_LARGE");
    if (sourceHash(bytes) !== captured.snapshot.sha256) throw conflict();
    return bytes;
  }
  private isUploaded(receipt: Receipt, source: CoursewareOnlineSourceVersion | null): boolean {
    return !!source && source.projectId === receipt.projectId && source.requestId === receipt.requestId &&
      source.source.sha256 === receipt.sourceSha256 && source.byteLength === receipt.byteLength &&
      (receipt.uploadedRevision === undefined || source.source.revision === receipt.uploadedRevision);
  }
  private assertRemote(receipt: Receipt, source: CoursewareOnlineSourceVersion | null, session: { active: boolean; epoch: number }): void {
    const uploaded = this.isUploaded(receipt, source);
    if (receipt.phase === "upload-pending" ? !uploaded && (source?.source.revision ?? null) !== receipt.expectedSourceRevision : !uploaded) throw conflict();
    if (session.active) {
      if (!["start-pending", "started"].includes(receipt.phase) || session.epoch !== receipt.expectedEpoch + 1) throw new Error("COURSEWARE_ONLINE_SESSION_ACTIVE");
    } else if (receipt.phase === "started" || session.epoch !== receipt.expectedEpoch) throw conflict();
  }
  private async advance(captured: Review, receipt: Receipt, phase: Phase, extra: { uploadedRevision?: string; sessionEpoch?: number } = {}): Promise<Receipt> {
    const next = await this.step(captured, captured.host.call<Receipt>("courseware.onlinePrepare.advance", {
      ...this.identity(captured), requestId: receipt.requestId, expectedPhase: receipt.phase, phase, ...extra,
    }));
    captured.receipt = next;
    return next;
  }
}
