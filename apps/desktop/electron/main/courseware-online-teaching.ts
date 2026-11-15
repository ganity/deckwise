import { randomUUID } from "node:crypto";
import { isDeepStrictEqual as equal } from "node:util";
import { isTeachingWrite, replaceNarrationText, type CoursewareOnlineTeachingView, type CoursewareProject } from "@pi-desktop/shared";
import type { CoursewareOnlineEditingClient, CoursewareOnlinePageLease, CoursewareOnlineTeachingVersion } from "./courseware-online-editing";

export type OnlineTeachingBinding = { ownerId: string; projectId: string; sessionEpoch: number; source: CoursewareProject["source"] };
type Options = {
  binding(ownerId: string): OnlineTeachingBinding;
  client(): CoursewareOnlineEditingClient;
  principal(): { assertCurrent(): void };
};
type Pin = {
  binding: OnlineTeachingBinding; principal: ReturnType<Options["principal"]>; client: CoursewareOnlineEditingClient;
  view: CoursewareOnlineTeachingView; lease?: CoursewareOnlinePageLease;
  pending?: { requestId: string; lease: { sessionEpoch: number; leaseEpoch: number; leaseToken: string }; write: import("@pi-desktop/shared").TeachingWrite };
};
const changed = () => new Error("COURSEWARE_ONLINE_TEACHING_CHANGED");
const conflict = () => new Error("COURSEWARE_ONLINE_TEACHING_CONFLICT");
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u;
const id = /^[\w.-]{1,128}$/u;

/** A page draft may change narration; opaque actions and audio provenance stay intact. */
export function assertOnlineNarrationEdits(previous: CoursewareProject["pages"][number]["actions"], next: typeof previous): void {
  const opaque = previous.filter(action => action.type !== "speech");
  if (!equal(opaque, next.filter(action => action.type !== "speech"))) throw new Error("COURSEWARE_ONLINE_TEACHING_INVALID_ACTIONS");
  for (const action of next) {
    if (action.type !== "speech") continue;
    if (typeof action.text !== "string" || action.text.length > 2500 ||
        (Object.hasOwn(action, "pauseAfterMs") && (!Number.isInteger(action.pauseAfterMs) || Number(action.pauseAfterMs) < 0 || Number(action.pauseAfterMs) > 30000)))
      throw new Error("COURSEWARE_ONLINE_TEACHING_INVALID_ACTIONS");
    const old = previous.find(item => item.id === action.id);
    const expected = old ? replaceNarrationText(old, action.text) : { id: action.id, type: "speech", text: action.text };
    if (Object.hasOwn(action, "pauseAfterMs")) expected.pauseAfterMs = action.pauseAfterMs;
    else delete expected.pauseAfterMs;
    if (!equal(expected, action)) throw new Error("COURSEWARE_ONLINE_TEACHING_INVALID_ACTIONS");
  }
}

/** Platform owns teaching. Renderer only receives page data and a lease deadline. */
export class CoursewareOnlineTeachingCoordinator {
  private pin: Pin | null = null;
  private generation = 0;
  private busy = false;
  constructor(private readonly options: Options) {}

  invalidate(): void { this.generation++; this.pin = null; }

  assertNoPendingOperation(): void {
    if (this.busy || this.pin?.pending) throw new Error("COURSEWARE_ONLINE_TEACHING_BUSY");
  }

  async read(ownerId: string, pageId?: string): Promise<CoursewareOnlineTeachingView | null> {
    if (!uuid.test(ownerId) || (pageId !== undefined && (!id.test(pageId) || pageId === "." || pageId === ".."))) throw changed();
    if (this.busy || this.pin?.lease || this.pin?.pending) throw new Error("COURSEWARE_ONLINE_TEACHING_BUSY");
    const generation = ++this.generation;
    this.pin = null;
    const binding = this.options.binding(ownerId), principal = this.options.principal(), client = this.options.client();
    const check = () => {
      principal.assertCurrent();
      if (generation !== this.generation || !equal(this.options.binding(ownerId), binding)) throw changed();
    };
    const session = await client.current(binding.projectId); check();
    if (!session.active || session.epoch !== binding.sessionEpoch) throw changed();
    const teaching = await client.currentTeaching(binding.projectId); check();
    if (!teaching) return null;
    this.assertSource(binding, teaching);
    const index = pageId === undefined ? 0 : teaching.project.pages.findIndex(page => page.pageId === pageId);
    if (index < 0) throw changed();
    const pin: Pin = { binding, principal, client, view: { ...structuredClone(teaching), ownerId, viewId: randomUUID(),
      sessionEpoch: binding.sessionEpoch, pageId: teaching.project.pages[index]!.pageId, pageNumber: index + 1 } };
    this.pin = pin;
    return this.view(pin);
  }

  async acquire(viewId: string): Promise<CoursewareOnlineTeachingView> {
    const pin = this.require(viewId);
    if (this.busy || pin.pending || pin.lease) throw new Error("COURSEWARE_ONLINE_TEACHING_BUSY");
    if (this.page(pin).locked) throw new Error("COURSEWARE_ONLINE_TEACHING_LOCKED");
    this.busy = true;
    let acquired: CoursewareOnlinePageLease | undefined;
    try {
      acquired = await pin.client.acquirePageLease(pin.binding.projectId, pin.view.pageId, pin.binding.sessionEpoch);
      this.assert(pin, viewId);
      pin.lease = acquired;
      const current = await pin.client.currentTeaching(pin.binding.projectId); this.assert(pin, viewId);
      if (!current) throw changed();
      this.assertSource(pin.binding, current);
      if (current.mappingRevision !== pin.view.mappingRevision ||
          !equal(current.project.pages.find(page => page.pageId === pin.view.pageId), this.page(pin))) throw conflict();
      pin.view.project = structuredClone(current.project);
      return this.view(pin);
    } catch (error) {
      if (acquired) await pin.client.releasePageLease(pin.binding.projectId, pin.view.pageId, this.proof(acquired)).catch(() => {});
      delete pin.lease;
      throw error;
    } finally { this.busy = false; }
  }

  async renew(viewId: string): Promise<CoursewareOnlineTeachingView> {
    const pin = this.require(viewId);
    if (this.busy) throw new Error("COURSEWARE_ONLINE_TEACHING_BUSY");
    const proof = this.validLease(pin);
    this.busy = true;
    try {
      const lease = await pin.client.renewPageLease(pin.binding.projectId, pin.view.pageId, proof); this.assert(pin, viewId);
      pin.lease = lease;
      return this.view(pin);
    } finally { this.busy = false; }
  }

  async release(viewId: string): Promise<CoursewareOnlineTeachingView> {
    const pin = this.require(viewId);
    if (this.busy || pin.pending) throw new Error("COURSEWARE_ONLINE_TEACHING_BUSY");
    this.busy = true;
    try {
      if (pin.lease) {
        try { await pin.client.releasePageLease(pin.binding.projectId, pin.view.pageId, this.proof(pin.lease)); }
        catch (error) { if (!(error instanceof Error) || error.message !== "COURSEWARE_ONLINE_PLATFORM_46202") throw error; }
        this.assert(pin, viewId);
      }
      delete pin.lease;
      return this.view(pin);
    } finally { this.busy = false; }
  }

  async save(viewId: string, actions: unknown): Promise<CoursewareOnlineTeachingView> {
    const pin = this.require(viewId);
    if (this.busy) throw new Error("COURSEWARE_ONLINE_TEACHING_BUSY");
    const write = { projectId: pin.binding.projectId, pageId: pin.view.pageId,
      expectedSourceRevision: pin.view.project.source.revision, expectedTeachingRevision: pin.view.project.teachingRevision, actions };
    if (!isTeachingWrite(write)) throw new Error("COURSEWARE_ONLINE_TEACHING_INVALID_ACTIONS");
    assertOnlineNarrationEdits(this.page(pin).actions, write.actions);
    const proposed = structuredClone(write.actions);
    if (pin.pending && !equal(pin.pending.write.actions, proposed)) throw new Error("COURSEWARE_ONLINE_TEACHING_PENDING_WRITE");
    this.busy = true;
    try {
      if (!pin.pending) {
        const proof = this.validLease(pin);
        const current = await pin.client.currentTeaching(pin.binding.projectId); this.assert(pin, viewId);
        if (!current) throw changed();
        this.assertSource(pin.binding, current);
        if (current.mappingRevision !== pin.view.mappingRevision ||
            !equal(current.project.pages.find(page => page.pageId === pin.view.pageId), this.page(pin))) throw conflict();
        pin.pending = { requestId: randomUUID(), lease: proof, write: { ...write, actions: proposed,
          expectedTeachingRevision: current.project.teachingRevision } };
      }
      let result: CoursewareOnlineTeachingVersion;
      try { result = await pin.client.writeTeaching(pin.binding.projectId, pin.pending); }
      catch (error) {
        if (error instanceof Error && (/^COURSEWARE_ONLINE_PLATFORM_\d+$/u.test(error.message) || error.message === "COURSEWARE_ONLINE_INVALID_REQUEST")) throw error;
        this.assert(pin, viewId);
        throw new Error("COURSEWARE_ONLINE_TEACHING_PENDING_WRITE", { cause: error });
      }
      this.assert(pin, viewId);
      this.assertSource(pin.binding, result);
      if (result.mappingRevision !== pin.view.mappingRevision ||
          !equal(result.project.pages.find(page => page.pageId === pin.view.pageId)?.actions, proposed)) throw conflict();
      pin.view.project = structuredClone(result.project);
      pin.view.viewId = randomUUID();
      delete pin.pending;
      return this.view(pin);
    } catch (error) {
      // A definite rejection can be corrected; an uncertain write keeps its exact id/body for explicit replay.
      if (error instanceof Error && (/^COURSEWARE_ONLINE_PLATFORM_\d+$/u.test(error.message) ||
          error.message === "COURSEWARE_ONLINE_INVALID_REQUEST" || error.message === "COURSEWARE_ONLINE_TEACHING_CONFLICT")) delete pin.pending;
      throw error;
    } finally { this.busy = false; }
  }

  private require(viewId: string): Pin {
    const pin = this.pin;
    if (!pin || !uuid.test(viewId)) throw changed();
    this.assert(pin, viewId);
    return pin;
  }
  private assert(pin: Pin, viewId: string): void {
    pin.principal.assertCurrent();
    if (this.pin !== pin || pin.view.viewId !== viewId || !equal(this.options.binding(pin.binding.ownerId), pin.binding)) throw changed();
  }
  private assertSource(binding: OnlineTeachingBinding, value: CoursewareOnlineTeachingVersion): void {
    if (value.project.projectId !== binding.projectId || !equal(value.project.source, binding.source)) throw conflict();
  }
  private page(pin: Pin) { return pin.view.project.pages.find(page => page.pageId === pin.view.pageId)!; }
  private proof(lease: CoursewareOnlinePageLease) { return { sessionEpoch: lease.sessionEpoch, leaseEpoch: lease.leaseEpoch, leaseToken: lease.leaseToken }; }
  private validLease(pin: Pin) {
    if (!pin.lease || pin.lease.expiresAtEpochMillis <= Date.now()) throw new Error("COURSEWARE_ONLINE_TEACHING_LEASE_EXPIRED");
    return this.proof(pin.lease);
  }
  private view(pin: Pin): CoursewareOnlineTeachingView {
    const value = structuredClone(pin.view);
    if (pin.lease) value.leaseExpiresAtEpochMillis = pin.lease.expiresAtEpochMillis;
    return value;
  }
}
