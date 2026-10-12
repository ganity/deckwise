import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { basename, dirname, extname, join, relative } from "node:path";
import { getOfficeExtension, type OfficeExtension } from "@pi-desktop/shared";
import { MAX_OFFICE_BYTES, validateOfficeBytes, officeSaveExtension } from "./office-file";
import { session, WebContentsView, type BrowserWindow, type IpcMain } from "electron";
import { resolveRealOpenablePath, resolveRealPathForCreateWithinRoot } from "./fs-panel";
import { installEditorHostProtocol } from "./editor-host-protocol";
import {
  PPT_EDITOR_HANDSHAKE_TIMEOUT_MS,
  waitForPptEditorMessage,
} from "./ppt-editor-handshake";

const HOST_PAGE = "deckwise-editor://host/index.html";
const REVISION_DIR = ".deckwise-ppt/revisions";

export type PptEditorState = {
  status: "opening" | "ready" | "saving" | "saved" | "error" | "closed";
  path?: string;
  revision?: number;
  revisionPath?: string;
  sha256?: string;
  message?: string;
  canRetry?: boolean;
  readOnly?: boolean;
  savedPath?: string;
};

type Revision = {
  revision: number;
  cause: "generated" | "edited";
  createdAt: string;
  file: string;
  size: number;
  sha256: string;
  documentPath: string;
};

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
    ) as Omit<Revision, "documentPath">;
    revisions.push({ ...manifest, documentPath: join(directory, manifest.file) });
  }
  return revisions;
}

async function publishRevision(input: {
  root: string;
  jobId: string;
  bytes: Uint8Array;
  extension: OfficeExtension;
  cause: Revision["cause"];
  expectedRevision: number;
}): Promise<Revision> {
  const bytes = validateOfficeBytes(input.bytes, input.extension);
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
    const documentPath = join(tempDirectory, `document.${input.extension}`);
    await fs.writeFile(documentPath, bytes, { flag: "wx" });
    const manifest = {
      revision,
      cause: input.cause,
      createdAt: new Date().toISOString(),
      file: `document.${input.extension}`,
      size: bytes.byteLength,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    };
    await fs.writeFile(
      join(tempDirectory, "revision.json"),
      `${JSON.stringify(manifest, null, 2)}\n`,
      { flag: "wx" },
    );
    await fs.rename(tempDirectory, finalDirectory);
    return { ...manifest, documentPath: join(finalDirectory, manifest.file) };
  } catch (error) {
    await fs.rm(tempDirectory, { recursive: true, force: true });
    throw error;
  }
}

async function replaceSourceFile(sourcePath: string, bytes: Uint8Array, extension: OfficeExtension): Promise<void> {
  const validated = validateOfficeBytes(bytes, extension);
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
    | { workspaceRoot: string; sourcePath: string; revisionRoot: string; jobId: string; revision: Revision; extension: OfficeExtension; readOnly: boolean; savedPath?: string }
    | null = null;
  private pendingSave = false;
  private commandSequence = 0;
  private ready = false;
  private opening = false;
  private openAbort: AbortController | null = null;
  private readonly editorUrl: URL;
  private readonly onDownload = (event: Electron.Event) => event.preventDefault();

  constructor(
    private readonly ipcMain: IpcMain,
    private readonly emit: (state: PptEditorState) => void,
    editorUrl = process.env.DECKWISE_EDITOR_URL || "https://trainwise.efrobot.com/wiseoffice",
  ) {
    this.editorUrl = new URL(editorUrl);
    if (!/^https?:$/.test(this.editorUrl.protocol)) {
      throw new Error("DECKWISE_EDITOR_URL 必须使用 HTTP 或 HTTPS");
    }
    this.ipcMain.on("deckwise-editor:event", this.onEditorEvent);
  }

  async open(window: BrowserWindow, workspaceRoot: string, requestedPath: string, mimeType?: string, extraRoots: string[] = []) {
    const sourcePath = await resolveRealOpenablePath(requestedPath, workspaceRoot, extraRoots);
    if (!sourcePath) throw new Error("Document is outside allowed roots");
    const extension = getOfficeExtension(sourcePath, mimeType);
    if (!extension) throw new Error("Unsupported WiseOffice document format");
    const readOnly = extension === "pdf" || !await resolveRealOpenablePath(sourcePath, workspaceRoot);
    if (
      this.current?.sourcePath === sourcePath &&
      this.view &&
      this.ready &&
      !this.view.webContents.isDestroyed()
    ) {
      this.window = window;
      const state = this.state("ready");
      this.emit(state);
      return state;
    }
    if ((await fs.stat(sourcePath)).size > MAX_OFFICE_BYTES) throw new Error("Document exceeds 256 MiB");
    const sourceBytes = validateOfficeBytes(await fs.readFile(sourcePath), extension);
    const revisionRoot = await resolveRealPathForCreateWithinRoot(workspaceRoot, extension === "pptx" ? REVISION_DIR : ".deckwise-office/revisions");
    if (!revisionRoot) throw new Error("Revision 目录无法安全创建");
    const jobId = jobIdFor(workspaceRoot, sourcePath);
    let revisions = await listRevisions(revisionRoot, jobId);
    if (revisions.length === 0) {
      await fs.mkdir(revisionRoot, { recursive: true });
      await publishRevision({
        root: revisionRoot,
        jobId,
        bytes: sourceBytes,
        extension,
        cause: "generated",
        expectedRevision: 0,
      });
      revisions = await listRevisions(revisionRoot, jobId);
    }
    const revision = revisions.at(-1);
    if (!revision) throw new Error("Cannot establish document revision");

    this.closeView();
    this.window = window;
    this.current = { workspaceRoot, sourcePath, revisionRoot, jobId, revision, extension, readOnly };
    this.opening = true;
    this.ready = false;
    this.emit({ status: "opening", path: requestedPath, revision: revision.revision });
    const view = this.createView();
    this.view = view;
    const hostUrl = new URL(HOST_PAGE);
    hostUrl.searchParams.set("editor", this.editorUrl.href.replace(/\/$/, ""));
    hostUrl.searchParams.set("editorOrigin", this.editorUrl.origin);
    if (extension === "pptx") hostUrl.searchParams.set("deckwise", "1");
    view.setBounds(this.bounds);
    const abort = new AbortController();
    this.openAbort = abort;
    const deadline = Date.now() + PPT_EDITOR_HANDSHAKE_TIMEOUT_MS;
    try {
      const ready = waitForPptEditorMessage(
        this.ipcMain,
        view.webContents.id,
        "document:ready",
        undefined,
        Math.max(1, deadline - Date.now()),
        abort.signal,
      );
      await Promise.all([ready, view.webContents.loadURL(hostUrl.href)]);
      const revisionBytes = await fs.readFile(revision.documentPath);
      if (this.view !== view || abort.signal.aborted) throw new Error("Editor opening was cancelled");
      const commandId = this.sendCommand("document:open-buffer", {
        fileName: `${basename(sourcePath, extname(sourcePath))}.${getOfficeExtension(revision.file) ?? extension}`,
        buffer: transferableBuffer(revisionBytes),
        readonly: readOnly,
      });
      await waitForPptEditorMessage(
        this.ipcMain,
        view.webContents.id,
        "document:opened",
        commandId,
        Math.max(1, deadline - Date.now()),
        abort.signal,
      );
      if (this.view !== view) throw new Error("Editor opening was cancelled");
      this.opening = false;
      this.ready = true;
      if (this.visible) this.attach();
      const state = this.state("ready");
      this.emit(state);
      return state;
    } catch (error) {
      if (this.view === view) {
        this.opening = false;
        this.ready = false;
        this.closeView();
        this.current = null;
        this.emit({
          status: "error",
          path: requestedPath,
          revision: revision.revision,
          canRetry: true,
          message: error instanceof Error ? error.message : String(error),
        });
      }
      throw error;
    } finally {
      abort.abort();
      if (this.openAbort === abort) this.openAbort = null;
    }
  }

  save(): void {
    if (!this.view || !this.current || !this.ready) throw new Error("No ready document editor session");
    if (this.current.readOnly) throw new Error("Document is read-only");
    if (this.pendingSave) throw new Error("Document is being saved");
    this.pendingSave = true;
    this.emit(this.state("saving"));
    this.sendCommand("document:save", { targetExt: officeSaveExtension(this.current.extension).toUpperCase() });
  }

  setBounds(bounds: { x: number; y: number; width: number; height: number }): void {
    this.bounds = {
      x: Math.max(0, Math.round(Number(bounds.x) || 0)),
      y: Math.max(0, Math.round(Number(bounds.y) || 0)),
      width: Math.max(0, Math.round(Number(bounds.width) || 0)),
      height: Math.max(0, Math.round(Number(bounds.height) || 0)),
    };
    if (this.view) this.view.setBounds(this.bounds);
  }

  setVisible(visible: boolean): void {
    this.visible = visible;
    if (visible && this.ready) this.attach();
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
    message: { type?: string; bytes?: ArrayBuffer; message?: string | { type?: string; payload?: { message?: string } } },
  ) => {
    if (!this.view || event.sender.id !== this.view.webContents.id || !message) return;
    if (message.type === "error" || (message.type === "message" && typeof message.message === "object" && message.message?.type === "document:error")) {
      this.pendingSave = false;
      this.emit({
        ...this.state("error"),
        canRetry: this.opening,
        message: typeof message.message === "string" ? message.message : message.message?.payload?.message || "编辑器加载失败",
      });
      return;
    }
    if (message.type === "save-requested") {
      if (!this.pendingSave && this.current && !this.current.readOnly && this.ready) this.save();
      return;
    }
    if (message.type !== "saved" || !this.pendingSave || !this.current) return;
    const current = this.current;
    const bytes = new Uint8Array(message.bytes ?? new ArrayBuffer(0));
    void publishRevision({
      root: current.revisionRoot,
      jobId: current.jobId,
      bytes,
      extension: officeSaveExtension(current.extension),
      cause: "edited",
      expectedRevision: current.revision.revision,
    }).then(async (revision) => {
      current.revision = revision;
      const extension = officeSaveExtension(current.extension);
      const target = extension === current.extension
        ? current.sourcePath
        : join(dirname(current.sourcePath), `${basename(current.sourcePath, extname(current.sourcePath))}-edited-r${revision.revision}.${extension}`);
      const safeTarget = await resolveRealPathForCreateWithinRoot(current.workspaceRoot, relative(current.workspaceRoot, target));
      if (!safeTarget || safeTarget !== target) throw new Error("Save target is outside the workspace");
      if (extension === current.extension) await replaceSourceFile(target, bytes, extension);
      else await fs.writeFile(target, bytes, { flag: "wx" });
      current.savedPath = relative(current.workspaceRoot, target);
      if (this.current !== current) return;
      this.pendingSave = false;
      this.emit(this.state("saved"));
    }).catch(
      (error) => {
        if (this.current !== current) return;
        this.pendingSave = false;
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
      ...(this.current ? { path: relative(this.current.workspaceRoot, this.current.sourcePath), readOnly: this.current.readOnly, savedPath: this.current.savedPath } : {}),
      ...(revision
        ? {
            revision: revision.revision,
            revisionPath: relative(this.current!.workspaceRoot, revision.documentPath),
            sha256: revision.sha256,
          }
        : {}),
    };
  }

  private sendCommand(type: string, payload: Record<string, unknown>): string {
    const id = `deckwise-${++this.commandSequence}`;
    this.view?.webContents.send("deckwise-editor:command", {
      id,
      type,
      payload,
    });
    return id;
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
    const editorPage = `${this.editorUrl.href.replace(/\/$/, "")}/editor`;
    contents.on("did-fail-load", (_event, code, description, url, isMainFrame) => {
      if (isMainFrame === false && url.split("?")[0] !== editorPage) return;
      if (this.view !== view) return;
      console.error(`[ppt-editor] did-fail-load code=${code} description=${description}`);
      const error = new Error(`Editor failed to load (${code}): ${description}`);
      if (this.opening) this.openAbort?.abort(error);
      else this.emit({ ...this.state("error"), message: error.message });
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
    this.openAbort?.abort();
    this.openAbort = null;
    this.opening = false;
    this.pendingSave = false;
    this.ready = false;
    this.detach();
    if (this.view && !this.view.webContents.isDestroyed()) {
      this.view.webContents.session.removeListener("will-download", this.onDownload);
      this.view.webContents.close();
    }
    this.view = null;
  }
}
