import { randomUUID } from "node:crypto";
import { isDeepStrictEqual as equal } from "node:util";
import type { CoursewareOnlineBarrierView, CoursewareOnlineNativeBarrier } from "@pi-desktop/shared";
import type { CoursewareOnlineEditingClient, CoursewareOnlineWritePause } from "./courseware-online-editing";
import type { OnlineTeachingBinding } from "./courseware-online-teaching";

type Options = {
  binding(ownerId: string): OnlineTeachingBinding;
  selection?(ownerId: string): { ownerId: string; projectId: string };
  client(): CoursewareOnlineEditingClient;
  principal(): { assertCurrent(): void };
};
type Pin = {
  binding: OnlineTeachingBinding;
  selection?: { ownerId: string; projectId: string };
  principal: ReturnType<Options["principal"]>;
  client: CoursewareOnlineEditingClient;
  viewId: string;
  pauseId: string;
  barrierId: string;
  pause: CoursewareOnlineWritePause | null;
  barrier: CoursewareOnlineNativeBarrier | null;
  startPending: boolean;
};
const changed = () => new Error("COURSEWARE_ONLINE_BARRIER_CHANGED");

/** Coordinates registered clients only. Their reports cannot authorize consistent publication. */
export class CoursewareOnlineBarrierCoordinator {
  private pin: Pin | null = null;
  private generation = 0;
  private busy = false;
  constructor(private readonly options: Options) {}

  invalidate(): void { this.generation++; this.pin = null; }

  async read(ownerId: string): Promise<CoursewareOnlineBarrierView> {
    return this.exclusive(async () => {
      const principal = this.options.principal(), client = this.options.client();
      const generation = this.generation;
      let binding: OnlineTeachingBinding, selection: Pin["selection"];
      const assertSelection = () => {
        principal.assertCurrent();
        if (generation !== this.generation || !equal(this.options.selection?.(ownerId), selection)) throw changed();
      };
      try { binding = this.options.binding(ownerId); }
      catch {
        if (!this.options.selection) throw changed();
        selection = this.options.selection(ownerId);
        const session = await client.current(selection.projectId); assertSelection();
        const source = await client.currentSource(selection.projectId); assertSelection();
        if (!session.active || !source || source.projectId !== selection.projectId || session.projectId !== selection.projectId) throw changed();
        binding = { ...selection, sessionEpoch: session.epoch, source: source.source };
      }
      const assert = () => {
        principal.assertCurrent();
        if (generation !== this.generation || (selection ? !equal(this.options.selection?.(ownerId), selection) :
          !equal(this.options.binding(ownerId), binding))) throw changed();
      };
      const pause = await client.currentWritePause(binding.projectId, binding.sessionEpoch); assert();
      const barrier = await client.currentNativeBarrier(binding.projectId, binding.sessionEpoch); assert();
      if (pause) this.assertPause(binding, pause);
      if (barrier) this.assertBarrier(binding, barrier);
      if (barrier && barrier.state !== "released" && (!pause || barrier.pauseId !== pause.pauseId)) throw changed();
      const previous = this.pin && equal(this.pin.binding, binding) ? this.pin : null;
      if (previous?.startPending && pause && pause.pauseId !== previous.pauseId) throw changed();
      // A lost POST keeps its request identities; a negative read cannot prove it never committed.
      const matching = barrier && (previous?.startPending ? barrier.barrierId === previous.barrierId :
        barrier.state !== "released" || !pause || barrier.pauseId === pause.pauseId) ? barrier : null;
      const pending = previous?.startPending && matching?.barrierId !== previous.barrierId;
      const pin: Pin = { binding, ...(selection ? { selection } : {}), principal, client, viewId: randomUUID(),
        pauseId: pause?.pauseId ?? (pending ? previous!.pauseId : randomUUID()),
        barrierId: matching?.barrierId ?? (pending ? previous!.barrierId : randomUUID()),
        pause, barrier: matching, startPending: !!pending };
      this.pin = pin;
      return this.view(pin);
    });
  }

  async start(viewId: string): Promise<CoursewareOnlineBarrierView> {
    const pin = this.require(viewId);
    return this.exclusive(async () => {
      this.assert(pin);
      if (pin.selection) throw new Error("COURSEWARE_ONLINE_BARRIER_CHANGED");
      if (pin.barrier?.state === "released" && pin.pause?.state !== "held" && !pin.startPending) {
        pin.barrier = null; pin.pauseId = randomUUID(); pin.barrierId = randomUUID();
      }
      if (pin.barrier) throw changed();
      pin.startPending = true;
      const pause = await pin.client.pauseWrites(pin.binding.projectId, pin.binding.sessionEpoch, pin.pauseId);
      this.assert(pin); this.assertPause(pin.binding, pause);
      if (pause.pauseId !== pin.pauseId || pause.state !== "held") throw changed();
      pin.pause = pause;
      const barrier = await pin.client.startNativeBarrier(pin.binding.projectId, pin.binding.sessionEpoch, pin.barrierId, pin.pauseId);
      this.assert(pin); this.assertBarrier(pin.binding, barrier);
      if (barrier.barrierId !== pin.barrierId || barrier.pauseId !== pin.pauseId || barrier.state === "released") throw changed();
      pin.barrier = barrier;
      pin.startPending = false;
      return this.view(pin);
    });
  }

  async resume(viewId: string): Promise<CoursewareOnlineBarrierView> {
    const pin = this.require(viewId);
    return this.exclusive(async () => {
      this.assert(pin);
      if (pin.startPending) throw new Error("COURSEWARE_ONLINE_BARRIER_UNCERTAIN");
      if (pin.barrier && pin.barrier.state !== "released") {
        const barrier = await pin.client.releaseNativeBarrier(pin.binding.projectId, pin.binding.sessionEpoch, pin.barrierId);
        this.assert(pin); this.assertBarrier(pin.binding, barrier);
        if (barrier.barrierId !== pin.barrierId || barrier.pauseId !== pin.pauseId || barrier.state !== "released") throw changed();
        pin.barrier = barrier;
      }
      if (pin.pause?.state === "held") {
        const pause = await pin.client.resumeWrites(pin.binding.projectId, pin.binding.sessionEpoch, pin.pauseId);
        this.assert(pin); this.assertPause(pin.binding, pause);
        if (pause.pauseId !== pin.pauseId || pause.state !== "released" || !equal(pause.teaching, pin.pause.teaching)) throw changed();
        pin.pause = pause;
      }
      return this.view(pin);
    });
  }

  private view(pin: Pin): CoursewareOnlineBarrierView {
    return { ownerId: pin.binding.ownerId, viewId: pin.viewId, sessionEpoch: pin.binding.sessionEpoch,
      state: pin.barrier?.state ?? "idle", teachingPaused: pin.pause?.state === "held", uncertain: pin.startPending,
      canStart: !pin.selection,
      held: pin.barrier?.clients.filter(client => client.state === "held").length ?? 0,
      total: pin.barrier?.clients.length ?? 0, consistentPublicationReady: false };
  }
  private require(viewId: string): Pin {
    const pin = this.pin;
    if (!pin || pin.viewId !== viewId) throw changed();
    this.assert(pin);
    return pin;
  }
  private assert(pin: Pin): void {
    pin.principal.assertCurrent();
    if (this.pin !== pin || (pin.selection ? !equal(this.options.selection?.(pin.binding.ownerId), pin.selection) :
      !equal(this.options.binding(pin.binding.ownerId), pin.binding))) throw changed();
  }
  private assertPause(binding: OnlineTeachingBinding, pause: CoursewareOnlineWritePause): void {
    if (pause.projectId !== binding.projectId || pause.sessionEpoch !== binding.sessionEpoch ||
        pause.teaching.project.projectId !== binding.projectId || !equal(pause.teaching.project.source, binding.source)) throw changed();
  }
  private assertBarrier(binding: OnlineTeachingBinding, barrier: CoursewareOnlineNativeBarrier): void {
    if (barrier.projectId !== binding.projectId || barrier.sessionEpoch !== binding.sessionEpoch ||
        barrier.authoritativeCoverage !== false || barrier.consistentPublicationReady !== false || barrier.proof !== "client-reported") throw changed();
  }
  private async exclusive<T>(operation: () => Promise<T>): Promise<T> {
    if (this.busy) throw new Error("COURSEWARE_ONLINE_BARRIER_BUSY");
    this.busy = true;
    try { return await operation(); } finally { this.busy = false; }
  }
}
