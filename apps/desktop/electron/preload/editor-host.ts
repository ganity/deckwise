import { contextBridge, ipcRenderer } from "electron";

const commandListeners = new Set<(command: unknown) => void>();

ipcRenderer.on("deckwise-editor:command", (_event, command) => {
  for (const listener of commandListeners) listener(command);
});

contextBridge.exposeInMainWorld("deckwiseEditorHost", {
  onCommand(listener: (command: unknown) => void) {
    if (typeof listener !== "function") throw new TypeError("editor command listener is required");
    commandListeners.add(listener);
    return () => commandListeners.delete(listener);
  },
  sendEvent(message: unknown) {
    ipcRenderer.send("deckwise-editor:event", message);
  },
});
