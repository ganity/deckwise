import { randomUUID } from "node:crypto";
import { isDeepStrictEqual as equal } from "node:util";
import type { CoursewareOnlinePauseView } from "@pi-desktop/shared";
import type { CoursewareOnlineEditingClient, CoursewareOnlineWritePause } from "./courseware-online-editing";
import type { OnlineTeachingBinding } from "./courseware-online-teaching";

type Options = {
  binding(ownerId: string): OnlineTeachingBinding;
  client(): CoursewareOnlineEditingClient;
  principal(): { assertCurrent(): void };
};
type Pin = {
  binding: OnlineTeachingBinding;
  principal: ReturnType<Options["principal"]>;
  client: CoursewareOnlineEditingClient;
  pause: CoursewareOnlineWritePause;
  view: CoursewareOnlinePauseView;
};
const changed = () => new Error("COURSEWARE_ONLINE_PAUSE_CHANGED");

/** Recovery only: a teaching pause does not stop native PPTX edits. */
export class CoursewareOnlinePauseCoordinator {
  private pin: Pin | null = null;
  private generation = 0;
  private busy = false;
  constructor(private readonly options: Options) {}

  invalidate(): void { this.generation++; this.pin = null; }

  async read(ownerId: string): Promise<CoursewareOnlinePauseView | null> {
    if (this.busy) throw new Error("COURSEWARE_ONLINE_PAUSE_BUSY");
    this.busy = true;
    const generation = ++this.generation;
    this.pin = null;
    try {
      const binding = this.options.binding(ownerId), principal = this.options.principal(), client = this.options.client();
      const pause = await client.currentWritePause(binding.projectId, binding.sessionEpoch);
      principal.assertCurrent();
      if (generation !== this.generation || !equal(this.options.binding(ownerId), binding)) throw changed();
      if (!pause) return null;
      this.assertPause(binding, pause);
      if (pause.state !== "held") throw changed();
      const view = { ownerId, viewId: randomUUID(), sessionEpoch: binding.sessionEpoch,
        teachingRevision: pause.teaching.project.teachingRevision };
      this.pin = { binding, principal, client, pause, view };
      return { ...view };
    } finally { this.busy = false; }
  }

  async resume(viewId: string): Promise<{ ok: true }> {
    const pin = this.pin, generation = this.generation;
    if (!pin || pin.view.viewId !== viewId) throw changed();
    this.assert(pin);
    if (this.busy) throw new Error("COURSEWARE_ONLINE_PAUSE_BUSY");
    this.busy = true;
    try {
      const result = await pin.client.resumeWrites(pin.binding.projectId, pin.binding.sessionEpoch, pin.pause.pauseId);
      this.assert(pin);
      if (generation !== this.generation) throw changed();
      this.assertPause(pin.binding, result);
      if (result.state !== "released" || result.pauseId !== pin.pause.pauseId || !equal(result.teaching, pin.pause.teaching)) throw changed();
      this.pin = null;
      return { ok: true };
    } finally { this.busy = false; }
  }

  private assert(pin: Pin): void {
    pin.principal.assertCurrent();
    if (this.pin !== pin || !equal(this.options.binding(pin.binding.ownerId), pin.binding)) throw changed();
  }
  private assertPause(binding: OnlineTeachingBinding, pause: CoursewareOnlineWritePause): void {
    if (pause.projectId !== binding.projectId || pause.sessionEpoch !== binding.sessionEpoch ||
        pause.teaching.project.projectId !== binding.projectId || !equal(pause.teaching.project.source, binding.source)) throw changed();
  }
}
