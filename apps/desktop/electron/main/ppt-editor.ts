import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { basename, dirname, extname, join, relative } from "node:path";
import { session, WebContentsView, type BrowserWindow, type IpcMain } from "electron";
import { resolveRealOpenablePath, resolveRealPathForCreateWithinRoot } from "./fs-panel";
import { installEditorHostProtocol } from "./editor-host-protocol";

const HOST_PAGE = "deckwise-editor://host/index.html";
const MAX_PPTX_BYTES = 256 * 1024 * 1024;
const REVISION_DIR = ".deckwise-ppt/revisions";

export type PptEditorState = {
  status: "opening" | "ready" | "saving" | "saved" | "error" | "closed";
  path?: string;
  revision?: number;
  revisionPath?: string;
  sha256?: string;
  message?: string;
};

type Revision = {
  revision: number;
  cause: "generated" | "edited";
  createdAt: string;
  file: string;
  size: number;
  sha256: string;
  pptxPath: string;
};

function validatePptxName(fileName: string): void {
  if (extname(fileName).toLowerCase() !== ".pptx") {
    throw new Error("编辑器只接受 PPTX 文件");
  }
}

function validatePptxBytes(value: Uint8Array): Buffer {
  if (!value.byteLength || value.byteLength > MAX_PPTX_BYTES) {
    throw new Error("PPTX 文件大小不允许");
  }
  const bytes = Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  if (bytes[0] !== 0x50 || bytes[1] !== 0x4b) {
    throw new Error("文件不是 OOXML ZIP");
  }
  if (!bytes.includes("[Content_Types].xml") || !bytes.includes("ppt/presentation.xml")) {
    throw new Error("文件不是有效的 PPTX 包");
  }
  return bytes;
}

function transferableBuffer(bytes: Buffer): ArrayBuffer {
  return bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
}

function jobIdFor(workspaceRoot: string, sourcePath: string): string {
  const rel = relative(workspaceRoot, sourcePath).replaceAll("\\", "/");
  const name = basename(sourcePath, extname(sourcePath))
    .replace(/[^a-zA-Z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40) || "presentation";
  return `${name}-${createHash("sha256").update(rel).digest("hex").slice(0, 12)}`;
}

async function listRevisions(root: string, jobId: string): Promise<Revision[]> {
  const revisionsRoot = join(root, jobId);
  let entries;
  try {
    entries = await fs.readdir(revisionsRoot, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const revisions: Revision[] = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isDirectory() || !/^r\d{4}$/.test(entry.name)) continue;
    const directory = join(revisionsRoot, entry.name);
    const manifest = JSON.parse(
      await fs.readFile(join(directory, "revision.json"), "utf8"),
    ) as Omit<Revision, "pptxPath">;
    revisions.push({ ...manifest, pptxPath: join(directory, manifest.file) });
  }
  return revisions;
}

async function publishRevision(input: {
  root: string;
  jobId: string;
  bytes: Uint8Array;
  cause: Revision["cause"];
  expectedRevision: number;
}): Promise<Revision> {
  const bytes = validatePptxBytes(input.bytes);
  const revisions = await listRevisions(input.root, input.jobId);
  const current = revisions.at(-1)?.revision ?? 0;
  if (current !== input.expectedRevision) {
    throw new Error(`Revision conflict: expected ${input.expectedRevision}, current ${current}`);
  }

  const revision = current + 1;
  const revisionName = `r${String(revision).padStart(4, "0")}`;
  const jobRoot = join(input.root, input.jobId);
  const finalDirectory = join(jobRoot, revisionName);
  const tempDirectory = join(jobRoot, `.${revisionName}.${randomUUID()}.tmp`);
  await fs.mkdir(tempDirectory, { recursive: true });
  try {
    const pptxPath = join(tempDirectory, "document.pptx");
    await fs.writeFile(pptxPath, bytes, { flag: "wx" });
    const manifest = {
      revision,
      cause: input.cause,
      createdAt: new Date().toISOString(),
      file: "document.pptx",
      size: bytes.byteLength,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    };
    await fs.writeFile(
      join(tempDirectory, "revision.json"),
      `${JSON.stringify(manifest, null, 2)}\n`,
      { flag: "wx" },
    );
    await fs.rename(tempDirectory, finalDirectory);
    return { ...manifest, pptxPath: join(finalDirectory, manifest.file) };
  } catch (error) {
    await fs.rm(tempDirectory, { recursive: true, force: true });
    throw error;
  }
}

async function replaceSourcePptx(sourcePath: string, bytes: Uint8Array): Promise<void> {
  const validated = validatePptxBytes(bytes);
  const temporaryPath = join(
    dirname(sourcePath),
    `.${basename(sourcePath)}.${randomUUID()}.tmp`,
  );
  await fs.writeFile(temporaryPath, validated, { flag: "wx" });
  try {
    if (process.platform === "win32") {
      await fs.copyFile(temporaryPath, sourcePath);
      await fs.rm(temporaryPath, { force: true });
    } else {
      await fs.rename(temporaryPath, sourcePath);
    }
  } catch (error) {
    await fs.rm(temporaryPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

export class PptEditorController {
  private view: WebContentsView | null = null;
  private window: BrowserWindow | null = null;
  private visible = false;
  private bounds = { x: 0, y: 0, width: 0, height: 0 };
  private current:
    | { workspaceRoot: string; sourcePath: string; revisionRoot: string; jobId: string; revision: Revision }
    | null = null;
  private pendingSave = false;
  private commandSequence = 0;
  private readonly editorUrl: URL;
  private readonly onDownload = (event: Electron.Event) => event.preventDefault();

  constructor(
    private readonly ipcMain: IpcMain,
    private readonly emit: (state: PptEditorState) => void,
    editorUrl = process.env.DECKWISE_EDITOR_URL || "https://edit.chaxus.com",
  ) {
    this.editorUrl = new URL(editorUrl);
    if (!/^https?:$/.test(this.editorUrl.protocol)) {
      throw new Error("DECKWISE_EDITOR_URL 必须使用 HTTP 或 HTTPS");
    }
    this.ipcMain.on("deckwise-editor:event", this.onEditorEvent);
  }

  async open(window: BrowserWindow, workspaceRoot: string, requestedPath: string) {
    const sourcePath = await resolveRealOpenablePath(requestedPath, workspaceRoot);
    if (!sourcePath) throw new Error("PPTX 文件不在当前工作区内");
    validatePptxName(sourcePath);
    if (
      this.current?.sourcePath === sourcePath &&
      this.view &&
      !this.view.webContents.isDestroyed()
    ) {
      this.window = window;
      const state = this.state("ready");
      this.emit(state);
      return state;
    }
    const sourceBytes = validatePptxBytes(await fs.readFile(sourcePath));
    const revisionRoot = await resolveRealPathForCreateWithinRoot(workspaceRoot, REVISION_DIR);
    if (!revisionRoot) throw new Error("Revision 目录无法安全创建");
    const jobId = jobIdFor(workspaceRoot, sourcePath);
    let revisions = await listRevisions(revisionRoot, jobId);
    if (revisions.length === 0) {
      await fs.mkdir(revisionRoot, { recursive: true });
      await publishRevision({
        root: revisionRoot,
        jobId,
        bytes: sourceBytes,
        cause: "generated",
        expectedRevision: 0,
      });
      revisions = await listRevisions(revisionRoot, jobId);
    }
    const revision = revisions.at(-1);
    if (!revision) throw new Error("无法建立 PPTX revision");

    this.closeView();
    this.window = window;
    this.current = { workspaceRoot, sourcePath, revisionRoot, jobId, revision };
    this.emit({ status: "opening", path: requestedPath, revision: revision.revision });
    const view = this.createView();
    this.view = view;
    const hostUrl = new URL(HOST_PAGE);
    hostUrl.searchParams.set("editor", this.editorUrl.href.replace(/\/$/, ""));
    hostUrl.searchParams.set("editorOrigin", this.editorUrl.origin);
    await view.webContents.loadURL(hostUrl.href);
    const revisionBytes = await fs.readFile(revision.pptxPath);
    this.sendCommand("document:open-buffer", {
      fileName: basename(sourcePath),
      buffer: transferableBuffer(revisionBytes),
      readonly: false,
    });
    if (this.visible) this.attach();
    const state = this.state("ready");
    this.emit(state);
    return state;
  }

  save(): void {
    if (!this.view || !this.current) throw new Error("没有打开的 PPTX 编辑会话");
    if (this.pendingSave) throw new Error("PPTX 正在保存");
    this.pendingSave = true;
    this.emit(this.state("saving"));
    this.sendCommand("document:save", { targetExt: "PPTX" });
  }

  setBounds(bounds: { x: number; y: number; width: number; height: number }): void {
    this.bounds = {
      x: Math.max(0, Math.round(Number(bounds.x) || 0)),
      y: Math.max(0, Math.round(Number(bounds.y) || 0)),
      width: Math.max(0, Math.round(Number(bounds.width) || 0)),
      height: Math.max(0, Math.round(Number(bounds.height) || 0)),
    };
    if (this.view && this.visible) this.view.setBounds(this.bounds);
  }

  setVisible(visible: boolean): void {
    this.visible = visible;
    if (visible) this.attach();
    else this.detach();
  }

  close(): void {
    const state = this.state("closed");
    this.closeView();
    this.current = null;
    this.emit(state);
  }

  dispose(): void {
    this.ipcMain.removeListener("deckwise-editor:event", this.onEditorEvent);
    this.close();
  }

  private readonly onEditorEvent = (
    event: Electron.IpcMainEvent,
    message: { type?: string; bytes?: ArrayBuffer; message?: string },
  ) => {
    if (!this.view || event.sender.id !== this.view.webContents.id || !message) return;
    if (message.type === "error") {
      this.emit({ ...this.state("error"), message: message.message || "编辑器加载失败" });
      return;
    }
    if (message.type !== "saved" || !this.pendingSave || !this.current) return;
    this.pendingSave = false;
    const current = this.current;
    const bytes = new Uint8Array(message.bytes ?? new ArrayBuffer(0));
    void publishRevision({
      root: current.revisionRoot,
      jobId: current.jobId,
      bytes,
      cause: "edited",
      expectedRevision: current.revision.revision,
    }).then(async (revision) => {
      current.revision = revision;
      await replaceSourcePptx(current.sourcePath, bytes);
      if (this.current !== current) return;
      this.emit(this.state("saved"));
    }).catch(
      (error) => {
        if (this.current !== current) return;
        this.emit({
          ...this.state("error"),
          message: error instanceof Error ? error.message : String(error),
        });
      },
    );
  };

  private state(status: PptEditorState["status"]): PptEditorState {
    const revision = this.current?.revision;
    return {
      status,
      ...(this.current ? { path: relative(this.current.workspaceRoot, this.current.sourcePath) } : {}),
      ...(revision
        ? {
            revision: revision.revision,
            revisionPath: relative(this.current!.workspaceRoot, revision.pptxPath),
            sha256: revision.sha256,
          }
        : {}),
    };
  }

  private sendCommand(type: string, payload: Record<string, unknown>): void {
    this.view?.webContents.send("deckwise-editor:command", {
      id: `deckwise-${++this.commandSequence}`,
      type,
      payload,
    });
  }

  private createView(): WebContentsView {
    const editorSession = session.fromPartition("persist:deckwise-editor", { cache: true });
    installEditorHostProtocol(editorSession.protocol);
    const view = new WebContentsView({
      webPreferences: {
        session: editorSession,
        preload: join(__dirname, "../preload/editor-host.js"),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webviewTag: false,
      },
    });
    const contents = view.webContents;
    contents.setWindowOpenHandler(() => ({ action: "deny" }));
    const blockNavigation = (event: Electron.Event, target: string) => {
      let url: URL;
      try {
        url = new URL(target);
      } catch {
        event.preventDefault();
        return;
      }
      if (url.origin !== this.editorUrl.origin && !target.startsWith(HOST_PAGE)) {
        event.preventDefault();
      }
    };
    contents.on("will-navigate", blockNavigation);
    contents.on("will-redirect", blockNavigation);
    contents.on("did-fail-load", (_event, code, description, _url, isMainFrame) => {
      if (isMainFrame === false) return;
      console.error(`[ppt-editor] did-fail-load code=${code} description=${description}`);
      this.emit({ ...this.state("error"), message: `编辑器加载失败 (${code}): ${description}` });
    });
    editorSession.on("will-download", this.onDownload);
    editorSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    return view;
  }

  private attach(): void {
    if (!this.window || this.window.isDestroyed() || !this.view) return;
    const children = this.window.contentView.children;
    if (!children.includes(this.view)) this.window.contentView.addChildView(this.view);
    this.view.setBounds(this.bounds);
  }

  private detach(): void {
    if (!this.window || this.window.isDestroyed() || !this.view) return;
    if (this.window.contentView.children.includes(this.view)) {
      this.window.contentView.removeChildView(this.view);
    }
  }

  private closeView(): void {
    this.pendingSave = false;
    this.detach();
    if (this.view && !this.view.webContents.isDestroyed()) {
      this.view.webContents.session.removeListener("will-download", this.onDownload);
      this.view.webContents.close();
    }
    this.view = null;
  }
}
