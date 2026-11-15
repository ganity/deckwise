import type { BrowserWindow } from "electron";
import { IPC, IPC_WHITELIST, type HostStatusEvent } from "@pi-desktop/shared";
import type { RuntimeState } from "./context";

/** Retain runtime status independently of the renderer window's lifecycle. */
export function createRendererEventSender(dependencies: {
  getWindow: () => BrowserWindow | null;
  state: Pick<RuntimeState, "hostStatus">;
  onPluginChanged: () => void;
}): (channel: string, payload: unknown) => void {
  return (channel, payload) => {
    if (channel === IPC.event.hostStatus) {
      dependencies.state.hostStatus = payload as HostStatusEvent;
    }
    if (channel === IPC.event.pluginChanged) dependencies.onPluginChanged();
    if (!IPC_WHITELIST.has(channel)) return;
    const window = dependencies.getWindow();
    if (!window || window.isDestroyed() || window.webContents.isDestroyed()) return;
    try {
      window.webContents.send(channel, payload);
    } catch {
      // Frame disposal during close/reload must not interrupt backend supervision.
    }
  };
}
