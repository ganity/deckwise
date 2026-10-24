import type { CoursewareOnlineBarrierReceipt, CoursewareOnlineClientBinding, CoursewareOnlineNativeBarrier } from "@pi-desktop/shared";
import type { CoursewareOnlineEditingClient } from "./courseware-online-editing";

type Client = Pick<CoursewareOnlineEditingClient, "heartbeatNativeClient" | "getNativeBarrier" | "reportNativeBarrier" | "leaveNativeClient">;
type State = { nativeReady: boolean; barrier: CoursewareOnlineNativeBarrier | null; errorCode?: string };
type Options = {
  binding: CoursewareOnlineClientBinding;
  client: Client;
  assertCurrent(): void;
  capability(): Promise<{ available: boolean }>;
  native(operation: "quiesce" | "status" | "resume", barrierId: string): Promise<CoursewareOnlineBarrierReceipt>;
};
const changed = () => new Error("COURSEWARE_ONLINE_CLIENT_CHANGED");

/** Each native mount owns one worker; missing evidence never releases its native restriction. */
export class CoursewareOnlineClientsWorker {
  private readonly abort = new AbortController();
  private timer?: ReturnType<typeof setTimeout>;
  private running = false;
  private started = false;
  private local: { barrierId: string; state: "draining" | "held" | "uncertain" | "resumed" } | null = null;
  private reported: { barrierId: string; state: "draining" | "held" | "uncertain" | "resumed" } | null = null;
  private value: State = { nativeReady: false, barrier: null };

  constructor(private readonly options: Options) {}

  binding(): CoursewareOnlineClientBinding { this.check(); return { ...this.options.binding }; }
  state(): State { this.check(); return structuredClone(this.value); }

  start(): void {
    if (this.started || this.abort.signal.aborted) return;
    this.started = true;
    void this.poll();
  }

  /** A serialized public tick also lets the coordinator request fresh client evidence. */
  async poll(): Promise<void> {
    if (this.running || this.abort.signal.aborted) return;
    this.running = true;
    if (this.timer !== undefined) { clearTimeout(this.timer); this.timer = undefined; }
    try {
      this.check();
      let available = false, capabilityError: unknown;
      try { available = (await this.options.capability()).available; }
      catch (error) { capabilityError = error; }
      this.check();
      this.value.nativeReady = available;
      const b = this.options.binding;
      let barrier = await this.options.client.heartbeatNativeClient(b.projectId, b.sessionEpoch, b.clientId, available, this.abort.signal);
      this.check();
      // A missing current response cannot release a barrier already observed by this mount.
      if (this.local && (!barrier || barrier.barrierId !== this.local.barrierId) && this.local.state !== "resumed") {
        barrier = await this.options.client.getNativeBarrier(b.projectId, b.sessionEpoch, this.local.barrierId, this.abort.signal);
        this.check();
      }
      if (barrier) {
        this.assertBarrier(barrier);
        this.value.barrier = structuredClone(barrier);
        await this.apply(barrier, available);
      } else this.value.barrier = null;
      if (capabilityError) throw capabilityError;
      delete this.value.errorCode;
    } catch (error) {
      if (!this.abort.signal.aborted) {
        this.value.errorCode = error instanceof Error && /^COURSEWARE_ONLINE_[A-Z0-9_]+$/u.test(error.message)
          ? error.message : "COURSEWARE_ONLINE_CLIENT_EVIDENCE_UNAVAILABLE";
      }
    } finally {
      this.running = false;
      if (this.started && !this.abort.signal.aborted) this.timer = setTimeout(() => { this.timer = undefined; void this.poll(); }, 5_000);
    }
  }

  stop(): void {
    if (this.abort.signal.aborted) return;
    this.abort.abort();
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
    // Leave is informational: the server keeps the mount in the evidence set.
    try {
      this.options.assertCurrent();
      const b = this.options.binding;
      void this.options.client.leaveNativeClient(b.projectId, b.sessionEpoch, b.clientId).catch(() => {});
    } catch { /* Never send an old mount identity with another account. */ }
  }

  private async apply(barrier: CoursewareOnlineNativeBarrier, nativeReady: boolean): Promise<void> {
    const known = this.local?.barrierId === barrier.barrierId ? this.local : null;
    if (barrier.state === "released") {
      if (known && known.state !== "resumed") {
        const result = await this.options.native("resume", barrier.barrierId);
        this.check();
        if (result.barrierId !== barrier.barrierId || result.state !== "resumed") throw new Error("COURSEWARE_ONLINE_CLIENT_RESUME_UNKNOWN");
      }
      this.local = { barrierId: barrier.barrierId, state: "resumed" };
      await this.report(barrier.barrierId, "resumed");
      return;
    }
    if (!nativeReady) {
      await this.report(barrier.barrierId, "uncertain");
      return;
    }
    if (!known) {
      await this.report(barrier.barrierId, "draining");
      this.local = { barrierId: barrier.barrierId, state: "draining" };
      let result: CoursewareOnlineBarrierReceipt;
      try { result = await this.options.native("quiesce", barrier.barrierId); }
      catch (error) {
        this.check(); this.local.state = "uncertain";
        await this.report(barrier.barrierId, "uncertain");
        throw error;
      }
      this.check();
      await this.record(barrier.barrierId, result);
    } else if (known.state !== "resumed") {
      let result: CoursewareOnlineBarrierReceipt;
      try { result = await this.options.native("status", barrier.barrierId); }
      catch (error) {
        this.check(); this.local!.state = "uncertain";
        await this.report(barrier.barrierId, "uncertain");
        throw error;
      }
      this.check();
      await this.record(barrier.barrierId, result);
    } else throw new Error("COURSEWARE_ONLINE_CLIENT_BARRIER_CHANGED");
  }

  private async record(barrierId: string, result: CoursewareOnlineBarrierReceipt): Promise<void> {
    if (result.barrierId !== barrierId || !["draining", "held", "uncertain-held"].includes(result.state) ||
        result.state === "held" && (!Number.isSafeInteger(result.serverIndex) || Number(result.serverIndex) < 0))
      throw new Error("COURSEWARE_ONLINE_CLIENT_ACK_UNKNOWN");
    const state = result.state === "uncertain-held" ? "uncertain" : result.state as "draining" | "held";
    this.local = { barrierId, state };
    await this.report(barrierId, state);
  }

  private async report(barrierId: string, state: "draining" | "held" | "uncertain" | "resumed"): Promise<void> {
    this.check();
    if (state === "held" && (this.reported?.barrierId !== barrierId || !["draining", "held"].includes(this.reported.state)))
      await this.report(barrierId, "draining");
    const b = this.options.binding;
    const result = await this.options.client.reportNativeBarrier(b.projectId, b.sessionEpoch, barrierId, b.clientId, state, this.abort.signal);
    this.check(); this.assertBarrier(result);
    if (result.barrierId !== barrierId) throw changed();
    this.reported = { barrierId, state };
    this.value.barrier = structuredClone(result);
  }

  private assertBarrier(value: CoursewareOnlineNativeBarrier): void {
    const b = this.options.binding;
    const member = value.clients.find(client => client.clientId === b.clientId);
    if (value.projectId !== b.projectId || value.sessionEpoch !== b.sessionEpoch || !member || member.docsUserId !== b.docsUserId)
      throw changed();
  }

  private check(): void { this.abort.signal.throwIfAborted(); this.options.assertCurrent(); }
}
