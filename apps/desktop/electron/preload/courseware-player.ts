import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("deckwiseFixedPlayer", {
  readPackage: () => ipcRenderer.invoke("deckwise-fixed-player:read", { kind: "package" }),
  readAsset: (id: string) => ipcRenderer.invoke("deckwise-fixed-player:read", { kind: "asset", id }),
  readTeamSelection: () => ipcRenderer.invoke("deckwise-fixed-player:read", { kind: "team-selection" }),
  readTeamFile: (path: string) => ipcRenderer.invoke("deckwise-fixed-player:read", { kind: "team-file", path }),
});
