import { contextBridge, ipcRenderer } from "electron";

if (process.isMainFrame) {
  const listeners = new Set<(command: unknown) => void>();
  ipcRenderer.on("deckwise-online:command", (_event, command: unknown) => {
    for (const listener of listeners) listener(command);
  });
  contextBridge.exposeInMainWorld("deckwiseOnlineHost", {
    onCommand(listener: (command: unknown) => void) {
      if (typeof listener !== "function") throw new TypeError("online command listener is required");
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    sendEvent(message: unknown) { ipcRenderer.send("deckwise-online:event", message); },
  });
}
