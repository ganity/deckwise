import { dirname } from "node:path";
import { BrowserWindow, type IpcMain } from "electron";
import { PptEditorController } from "./ppt-editor";

export class PptxCandidatePreview {
  private window: BrowserWindow | null = null;
  private editor: PptEditorController | null = null;
  private resize: (() => void) | null = null;

  constructor(private ipcMain: IpcMain, private getMainWindow: () => BrowserWindow | null) {}

  async open(workspaceRoot: string, path: string, candidateId: string, expectedSha256: string): Promise<void> {
    this.close();
    const parent = this.getMainWindow();
    if (!parent || parent.isDestroyed()) throw new Error("Main window is unavailable");
    const window = new BrowserWindow({
      parent,
      title: `PPTX candidate ${candidateId}`,
      width: 1100,
      height: 760,
      show: false,
      webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
    });
    const editor = new PptEditorController(this.ipcMain, () => undefined);
    const resize = () => {
      const { width, height } = window.getContentBounds();
      editor.setBounds({ x: 0, y: 0, width, height });
    };
    this.window = window;
    this.editor = editor;
    this.resize = resize;
    window.on("resize", resize);
    window.once("closed", () => {
      window.removeListener("resize", resize);
      if (this.window === window) this.close();
    });
    try {
      const state = await editor.open(window, workspaceRoot, path, "application/vnd.openxmlformats-officedocument.presentationml.presentation", [dirname(path)]);
      if (state.sha256 !== expectedSha256 || state.readOnly !== true || state.canSave !== false) {
        throw new Error("PPTX candidate preview failed its read-only integrity check");
      }
      resize();
      editor.setVisible(true);
      window.show();
    } catch (error) {
      this.close();
      throw error;
    }
  }

  close(): void {
    const window = this.window;
    const editor = this.editor;
    const resize = this.resize;
    this.window = null;
    this.editor = null;
    this.resize = null;
    if (window && resize) window.removeListener("resize", resize);
    editor?.dispose();
    if (window && !window.isDestroyed()) window.destroy();
  }
}
