import type { BrowserWindow } from "electron";
import { IPC } from "@pi-desktop/shared";
import { PptEditorController, type PptEditorState } from "../ppt-editor";
import type { IpcRegistrar } from "./types";

export function registerPptEditorIpc(input: {
  registrar: IpcRegistrar;
  getMainWindow: () => BrowserWindow | null;
  getWorkspaceRoot: () => Promise<string | null>;
  getExtraRoots: (workspaceRoot: string | null) => Promise<string[]>;
  sendToRenderer: (channel: string, payload: unknown) => void;
}): void {
  const { registrar, getMainWindow, getWorkspaceRoot, getExtraRoots, sendToRenderer } = input;
  const editor = new PptEditorController(registrar.ipcMain, (state: PptEditorState) => {
    sendToRenderer(IPC.event.pptEditorState, state);
  });
  const assertSender = (event: Electron.IpcMainInvokeEvent) => {
    registrar.assertMainWindowSender(event);
  };

  registrar.handleWithEvent(
    IPC.invoke.pptEditorOpen,
    async (event, payload: { path?: string; mimeType?: string } = {}) => {
      assertSender(event);
      const window = getMainWindow();
      const workspaceRoot = await getWorkspaceRoot();
      const path = String(payload.path ?? "").trim();
      if (!window || !workspaceRoot || !path) throw new Error("No document is available in the current workspace");
      return editor.open(window, workspaceRoot, path, payload.mimeType, await getExtraRoots(workspaceRoot));
    },
  );
  registrar.handleWithEvent(IPC.invoke.pptEditorSave, async (event) => {
    assertSender(event);
    editor.save();
    return { ok: true };
  });
  registrar.handleWithEvent(IPC.invoke.pptEditorClose, async (event) => {
    assertSender(event);
    editor.close();
    return { ok: true };
  });
  registrar.handleWithEvent(
    IPC.invoke.pptEditorSetBounds,
    async (event, bounds: { x: number; y: number; width: number; height: number }) => {
      assertSender(event);
      editor.setBounds(bounds);
      return { ok: true };
    },
  );
  registrar.handleWithEvent(
    IPC.invoke.pptEditorSetVisible,
    async (event, payload: { visible?: boolean } = {}) => {
      assertSender(event);
      editor.setVisible(payload.visible === true);
      return { ok: true };
    },
  );
}
