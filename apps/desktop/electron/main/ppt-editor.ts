import { createHash, randomUUID } from "node:crypto";
import { createReadStream, promises as fs } from "node:fs";
import { basename, dirname, extname, join, relative } from "node:path";
import { getOfficeExtension, assertPptEditorCommand, assertPptEditorContext, assertPptEditorCommandResult, samePptEditorBinding, type PptEditorBinding, type OfficeExtension } from "@pi-desktop/shared";
import { jobIdFor, listRevisions, publishRevision, replaceSourceFile, type Revision } from "./ppt-editor-files";
import { requestPptEditor } from "./ppt-editor-request";
import { MAX_OFFICE_BYTES, validateOfficeBytes, officeSaveExtension } from "./office-file";
import { session, WebContentsView, type BrowserWindow, type IpcMain } from "electron";
import { resolveRealOpenablePath, resolveRealPathForCreateWithinRoot } from "./fs-panel";
import { installEditorHostProtocol } from "./editor-host-protocol";
import {
  PPT_EDITOR_HANDSHAKE_TIMEOUT_MS,
  waitForPptEditorMessage,
} from "./ppt-editor-handshake";
import { PptxInspector } from "./pptx-inspection";
import type { ReviewedImage, ReviewedImageTarget } from "./courseware-image-review";
import { captureSourcePagePreview, sourcePreviewTarget } from "./courseware-page-preview";

const HOST_PAGE = "deckwise-editor://host/index.html";
const REVISION_DIR = ".deckwise-ppt/revisions";

export type FadeAuthorization = { editGeneration: number; page: number; sourceHash: string; slideHash: string };

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
  dirty?: boolean;
  canSave?: boolean;
};

function transferableBuffer(bytes: Buffer): ArrayBuffer {
  return bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
}

export class PptEditorController {
  invalidateFade?: () => void;
  imageAssets?: { metadata(workspace: string | null): Promise<ReviewedImage | null>; load(assetId: string, workspace: string | null, command?: import("@pi-desktop/shared").PptEditorCommand): Promise<{ asset: ReviewedImage; bytes: Buffer; assertCurrent(): void }> };
  private imageMetadata = "null";
  readonly inspector = new PptxInspector();
  private view: WebContentsView | null = null;
  private window: BrowserWindow | null = null;
  private visible = false;
  private bounds = { x: 0, y: 0, width: 0, height: 0 };
  private current:
    | { workspaceRoot: string; sourcePath: string; revisionRoot: string; jobId: string; revision: Revision; savedRevision: Revision; extension: OfficeExtension; readOnly: boolean; sourceHash: string; savedPath?: string }
    | null = null;
  private pendingSave: { id: string; phase: "export" | "writing" | "ack"; error?: string } | null = null;
  private saveTimer: ReturnType<typeof setTimeout> | undefined;
  private dirty = false;
  private saveOutcomeUncertain = false;
  private commandSequence = 0;
  private ready = false;
  private opening = false;
  private openAbort: AbortController | null = null;
  private bridgeAbort = new AbortController();
  private bridgeBinding: PptEditorBinding | null = null;
  private readonly bridgeRequests = new Set<string>();
  private readonly activeBridgeRequests = new Set<string>();
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

  async open(window: BrowserWindow, workspaceRoot: string, requestedPath: string, mimeType?: string, extraRoots: string[] = [], forceReadOnly = false) {
    if (this.pendingSave) throw new Error("Finish the current save before opening another document");
    const sourcePath = await resolveRealOpenablePath(requestedPath, workspaceRoot, extraRoots);
    if (!sourcePath) throw new Error("Document is outside allowed roots");
    const extension = getOfficeExtension(sourcePath, mimeType);
    if (!extension) throw new Error("Unsupported WiseOffice document format");
    const readOnly = forceReadOnly || extension === "pdf" || !await resolveRealOpenablePath(sourcePath, workspaceRoot);
    if (
      this.current?.sourcePath === sourcePath &&
      this.current.readOnly === readOnly &&
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
    const sourceHash = createHash("sha256").update(sourceBytes).digest("hex");
    if (revisions.at(-1)?.sha256 !== sourceHash) {
      await fs.mkdir(revisionRoot, { recursive: true });
      await publishRevision({
        root: revisionRoot,
        jobId,
        bytes: sourceBytes,
        extension,
        cause: revisions.length ? "edited" : "generated",
        expectedRevision: revisions.at(-1)?.revision ?? 0,
      });
      revisions = await listRevisions(revisionRoot, jobId);
    }
    const revision = revisions.at(-1);
    if (!revision) throw new Error("Cannot establish document revision");

    this.closeView();
    this.window = window;
    this.current = { workspaceRoot, sourcePath, revisionRoot, jobId, revision, savedRevision: revision, extension, readOnly, sourceHash };
    this.bridgeAbort = new AbortController();
    this.bridgeBinding = {
      projectId: createHash("sha256").update(workspaceRoot).digest("hex"),
      documentId: jobId,
      sessionId: randomUUID(),
    };
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
        editorBinding: extension === "pptx" ? this.bridgeBinding : undefined,
        trackPageLineage: extension === "pptx" ? true : undefined,
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

  async getContext(workspaceRoot: string | null, signal?: AbortSignal) {
    signal?.throwIfAborted();
    const binding = this.requireBridge(workspaceRoot);
    const asset = await this.imageAssets?.metadata(workspaceRoot) ?? null;
    if (!samePptEditorBinding(binding, this.requireBridge(workspaceRoot))) throw new Error("Editor changed while reading image review");
    const metadata = JSON.stringify(asset);
    if (metadata !== this.imageMetadata) {
      const updated = await this.bridgeRequest("document:review-image", "document:context", { binding, asset }, undefined, signal);
      assertPptEditorContext(updated);
      if (!samePptEditorBinding(binding, updated)) throw new Error("Image review belongs to another editor");
      this.imageMetadata = metadata;
    }
    const response = await this.bridgeRequest("document:get-context", "document:context", { ...binding }, undefined, signal);
    assertPptEditorContext(response);
    if (!samePptEditorBinding(binding, response)) throw new Error("Editor context belongs to another session");
    return response;
  }

  async execute(command: unknown, workspaceRoot: string | null, canDispatch: () => boolean = () => true) {
    assertPptEditorCommand(command);
    if (command.tool === "set_slide_fade") throw new Error("Native fade requires retained Main inspection and dedicated dispatch");
    this.invalidateFade?.();
    const binding = this.requireBridge(workspaceRoot);
    if (!samePptEditorBinding(binding, command)) throw new Error("Editor command belongs to another session");
    if (command.tool !== "get_presentation_text" && this.current?.readOnly) throw new Error("Document is read-only");
    if (this.bridgeRequests.has(command.requestId)) throw new Error("Editor request was already consumed");
    if (this.bridgeRequests.size >= 4096) throw new Error("Editor request limit reached; reopen the document");
    this.bridgeRequests.add(command.requestId);
    let payload: Record<string, unknown> = command;
    let messageType = "document:execute";
    if (command.tool === "replace_slide_image_from_asset" || command.tool === "insert_slide_image_from_asset") {
      if (!this.imageAssets) throw new Error("Reviewed image service is unavailable");
      const image = await this.imageAssets.load(command.input.assetId, workspaceRoot, command);
      image.assertCurrent();
      if (!canDispatch()) throw new Error("Chat turn was cancelled before image dispatch");
      if (!samePptEditorBinding(binding, this.requireBridge(workspaceRoot)) || JSON.stringify(image.asset) !== this.imageMetadata) throw new Error("Image review changed before dispatch");
      payload = { command, bytes: new Uint8Array(image.bytes) };
      messageType = "document:execute-image";
    }
    if (!canDispatch()) throw new Error("Chat turn was cancelled before native dispatch");
    const response = await this.bridgeRequest(messageType, "document:command-result", payload, command.requestId);
    assertPptEditorCommandResult(response);
    if (!samePptEditorBinding(binding, response) || response.requestId !== command.requestId || response.editGeneration !== command.editGeneration || response.tool !== command.tool) {
      throw new Error("Editor result does not match the request");
    }
    return response;
  }

  async reviewImageTarget(asset: ReviewedImage, target: ReviewedImageTarget, workspaceRoot: string | null) {
    const snapshot = this.teachingSnapshot(workspaceRoot);
    await this.verifyTeachingSource(workspaceRoot);
    const response = await this.bridgeRequest("document:review-image-target", "document:image-target-reviewed",
      { binding: this.requireBridge(workspaceRoot), asset, target });
    assertPptEditorContext(response);
    const current = this.teachingSnapshot(workspaceRoot);
    if (!samePptEditorBinding(snapshot, response) || !samePptEditorBinding(snapshot, current) ||
        current.sha256 !== snapshot.sha256 || current.revision !== snapshot.revision || response.page !== target.page || response.readOnly)
      throw new Error("Canvas image target review changed");
    this.imageMetadata = JSON.stringify(asset);
    return response;
  }

  async reviewFade(authorization: FadeAuthorization, workspaceRoot: string | null, signal?: AbortSignal) {
    authorization = { ...authorization };
    const snapshot = this.teachingSnapshot(workspaceRoot);
    await this.verifyTeachingSource(workspaceRoot);
    const native = await this.getContext(workspaceRoot, signal);
    if (!samePptEditorBinding(snapshot, native) || native.editGeneration !== authorization.editGeneration || native.page !== authorization.page || authorization.sourceHash !== `sha256:${snapshot.sha256}`) throw new Error("Native fade inspection is stale");
    const current = this.teachingSnapshot(workspaceRoot);
    if (current.sha256 !== snapshot.sha256 || current.revision !== snapshot.revision || !samePptEditorBinding(current, snapshot)) throw new Error("Native fade saved source changed");
    const reviewed = await this.bridgeRequest("document:review-fade", "document:context", { binding: this.requireBridge(workspaceRoot), authorization }, undefined, signal);
    assertPptEditorContext(reviewed);
    if (!samePptEditorBinding(snapshot, reviewed) || reviewed.editGeneration !== authorization.editGeneration || reviewed.page !== authorization.page) throw new Error("Native fade review belongs to another context");
    return reviewed;
  }

  async executeFade(command: unknown, authorization: FadeAuthorization, workspaceRoot: string | null,
    assertCurrent: () => Promise<void>, canDispatch: () => boolean, signal?: AbortSignal) {
    command = structuredClone(command);
    authorization = { ...authorization };
    assertPptEditorCommand(command);
    if (command.tool !== "set_slide_fade" || command.editGeneration !== authorization.editGeneration) throw new Error("Invalid finite fade command");
    const binding = this.requireBridge(workspaceRoot), snapshot = this.teachingSnapshot(workspaceRoot);
    if (!samePptEditorBinding(binding, command) || authorization.sourceHash !== `sha256:${snapshot.sha256}`) throw new Error("Native fade source or binding changed");
    if (this.bridgeRequests.has(command.requestId)) throw new Error("Editor request was already consumed");
    if (this.bridgeRequests.size >= 4096) throw new Error("Editor request limit reached; reopen the document");
    this.bridgeRequests.add(command.requestId);
    await this.verifyTeachingSource(workspaceRoot);
    await assertCurrent();
    signal?.throwIfAborted();
    const current = this.teachingSnapshot(workspaceRoot);
    if (!samePptEditorBinding(snapshot, current) || current.sha256 !== snapshot.sha256 || current.revision !== snapshot.revision || !canDispatch()) throw new Error("Native fade source or Chat changed before dispatch");
    const response = await this.bridgeRequest("document:execute-fade", "document:command-result", { command, authorization }, command.requestId, signal);
    assertPptEditorCommandResult(response);
    if (!samePptEditorBinding(binding, response) || response.requestId !== command.requestId || response.editGeneration !== command.editGeneration || response.tool !== "set_slide_fade") throw new Error("Native fade result does not match request");
    return response;
  }

  async renderSavedPagePreview(workspaceRoot: string, page: number, omitNativeText = false, signal?: AbortSignal) {
    signal?.throwIfAborted();
    if (typeof omitNativeText !== "boolean") throw new Error("Invalid native text preview flag");
    const binding = this.requireBridge(workspaceRoot), document = this.current!;
    if (!document.readOnly || this.dirty || document.sourceHash !== document.savedRevision.sha256) throw new Error("Preview requires a newly opened readonly saved PPTX");
    const current = () => {
      signal?.throwIfAborted();
      if (this.current !== document || this.dirty || !samePptEditorBinding(binding, this.requireBridge(workspaceRoot))) throw new Error("Page preview editor changed");
    };
    const context = await this.getContext(workspaceRoot, signal);
    current();
    const target = sourcePreviewTarget(context, document.savedRevision.sha256, page);
    const response = await this.bridgeRequest("document:render-page-preview", "document:page-preview",
      { binding, editGeneration: context.editGeneration, page, ...(omitNativeText ? { omitNativeText: true } : {}) }, undefined, signal);
    current();
    const result = captureSourcePagePreview(response, target, omitNativeText, signal);
    const after = await this.getContext(workspaceRoot, signal);
    current();
    if (after.editGeneration !== context.editGeneration || JSON.stringify(sourcePreviewTarget(after, target.sourceSha256, page)) !== JSON.stringify(target)) throw new Error("Source changed during page preview");
    return result;
  }

  private requireBridge(workspaceRoot: string | null): PptEditorBinding {
    if (!this.ready || !this.view || this.current?.extension !== "pptx" || !this.bridgeBinding || this.pendingSave || this.saveOutcomeUncertain || this.current.workspaceRoot !== workspaceRoot) {
      throw new Error("No ready PPTX editor session, or a save is in progress");
    }
    return this.bridgeBinding;
  }

  private async bridgeRequest(type: string, responseType: "document:context" | "document:command-result" | "document:page-preview" | "document:image-target-reviewed", payload: Record<string, unknown>, id: string = randomUUID(), signal?: AbortSignal): Promise<unknown> {
    const view = this.view!;
    this.activeBridgeRequests.add(id);
    try {
      return await requestPptEditor(this.ipcMain, view.webContents.id, id, responseType, () => {
        view.webContents.send("deckwise-editor:command", { id, type, payload });
      }, signal ? AbortSignal.any([this.bridgeAbort.signal, signal]) : this.bridgeAbort.signal);
    } finally {
      this.activeBridgeRequests.delete(id);
    }
  }

  save(): void {
    if (!this.view || !this.current || !this.ready) throw new Error("No ready document editor session");
    if (this.current.readOnly) throw new Error("Document is read-only");
    if (this.pendingSave) throw new Error("Document is being saved");
    if (this.saveOutcomeUncertain) throw new Error("Save outcome is uncertain; reopen before saving again");
    if (this.activeBridgeRequests.size) throw new Error("Wait for the editor command to finish before saving");
    this.invalidateFade?.();
    const id = `deckwise-${++this.commandSequence}`;
    this.pendingSave = { id, phase: "export" };
    this.armSaveTimeout(210_000);
    this.inspector.stop();
    this.emit(this.state("saving"));
    this.sendCommand("document:save", { targetExt: officeSaveExtension(this.current.extension).toUpperCase(), requireHostCommit: true }, id);
  }

  savedPptxSnapshot(): { path: string; revision: number; sha256: string } {
    if (!this.current || !this.ready || this.opening || this.pendingSave || this.saveOutcomeUncertain ||
        this.current.readOnly || this.current.extension !== "pptx") {
      throw new Error("Open a writable PPTX and finish saving before inspection");
    }
    const revision = this.current.savedRevision;
    return { path: revision.documentPath, revision: revision.revision, sha256: revision.sha256 };
  }

  teachingSnapshot(workspaceRoot: string | null) {
    const binding = this.requireBridge(workspaceRoot);
    if (this.dirty || this.opening || this.saveOutcomeUncertain) {
      throw new Error("Save or reopen the PPTX before editing teaching");
    }
    return { ...this.savedPptxSnapshot(), ...binding };
  }

  sourceAdoptionSnapshot(workspaceRoot: string | null) {
    return { ...this.teachingSnapshot(workspaceRoot), sourcePath: this.current!.sourcePath };
  }

  freezeForSourceAdoption(workspaceRoot: string, expected: ReturnType<PptEditorController["sourceAdoptionSnapshot"]>): void {
    const current = this.sourceAdoptionSnapshot(workspaceRoot);
    if (!samePptEditorBinding(current, expected) || current.sha256 !== expected.sha256 ||
        current.revision !== expected.revision || current.sourcePath !== expected.sourcePath) throw new Error("Source adoption editor changed");
    this.close();
  }

  async verifyTeachingSource(workspaceRoot: string | null): Promise<void> {
    const snapshot = this.teachingSnapshot(workspaceRoot);
    const document = this.current!;
    const sourceHash = document.sourceHash;
    if (!workspaceRoot || await resolveRealOpenablePath(document.sourcePath, workspaceRoot) !== document.sourcePath) throw new Error("Teaching source is outside the current workspace");
    const hash = createHash("sha256");
    let size = 0;
    for await (const chunk of createReadStream(document.sourcePath)) {
      size += chunk.length;
      if (size > MAX_OFFICE_BYTES) throw new Error("Teaching source exceeds 256 MiB");
      hash.update(chunk);
    }
    const current = this.teachingSnapshot(workspaceRoot);
    if (this.current !== document || document.sourceHash !== sourceHash || hash.digest("hex") !== snapshot.sha256 ||
        sourceHash !== snapshot.sha256 || current.revision !== snapshot.revision || current.sha256 !== snapshot.sha256 ||
        !samePptEditorBinding(current, snapshot)) throw new Error("Source file changed outside the editor; reopen before editing teaching");
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
    if (this.pendingSave) throw new Error("Finish the current save before closing the editor");
    const state = this.state("closed");
    this.closeView();
    this.current = null;
    this.emit(state);
  }

  dispose(): void {
    this.ipcMain.removeListener("deckwise-editor:event", this.onEditorEvent);
    this.closeView();
    this.current = null;
  }

  private readonly onEditorEvent = (
    event: Electron.IpcMainEvent,
    message: { type?: string; id?: string; bytes?: ArrayBuffer; message?: string | { id?: string; type?: string; payload?: { message?: string; dirty?: boolean; success?: boolean } } },
  ) => {
    const senderId = event?.sender?.id;
    const viewContents = this.view?.webContents;
    if (senderId === undefined || !viewContents || senderId !== viewContents.id || !message) return;
    const reply = typeof message.message === "object" ? message.message : undefined;
    if (message.type === "message" && reply?.id && this.activeBridgeRequests.has(reply.id)) return;
    if (reply?.type === "document:dirty-changed" && typeof reply.payload?.dirty === "boolean") {
      this.dirty = reply.payload.dirty;
      if (this.dirty) this.invalidateFade?.();
      if (!this.pendingSave) this.emit(this.state("ready"));
      return;
    }
    if (reply?.type === "document:save-committed") {
      const pending = this.pendingSave;
      if (!pending || pending.phase !== "ack" || reply.id !== pending.id ||
          typeof reply.payload?.dirty !== "boolean" || reply.payload.success !== !pending.error) return;
      this.dirty = reply.payload.dirty;
      this.clearPendingSave();
      this.emit(pending.error
        ? { ...this.state("error"), message: pending.error }
        : this.state(this.dirty ? "ready" : "saved"));
      return;
    }
    if (message.type === "error" || reply?.type === "document:error") {
      if (this.pendingSave) {
        if ((reply && reply.id !== this.pendingSave.id) || this.pendingSave.phase === "writing") return;
        this.saveOutcomeUncertain = true;
        this.clearPendingSave();
      } else if (reply?.id && !this.opening) return;
      this.emit({
        ...this.state("error"),
        canRetry: this.opening,
        message: typeof message.message === "string" ? message.message : reply?.payload?.message || "Editor failed",
      });
      return;
    }
    if (message.type === "save-requested") {
      if (!this.pendingSave && !this.saveOutcomeUncertain && !this.activeBridgeRequests.size && this.current && !this.current.readOnly && this.ready) this.save();
      return;
    }
    const pending = this.pendingSave;
    if (message.type !== "saved" || !pending || pending.phase !== "export" || message.id !== pending.id || !this.current) return;
    const current = this.current;
    pending.phase = "writing";
    clearTimeout(this.saveTimer);
    const bytes = new Uint8Array(message.bytes ?? new ArrayBuffer(0));
    void (async () => {
      const sourceHash = createHash("sha256").update(await fs.readFile(current.sourcePath)).digest("hex");
      if (sourceHash !== current.sourceHash) throw new Error("Source file changed outside the editor; preserve both versions before retrying");
      const revision = await publishRevision({
        root: current.revisionRoot,
        jobId: current.jobId,
        bytes,
        extension: officeSaveExtension(current.extension),
        cause: "edited",
        expectedRevision: current.revision.revision,
      });
      current.revision = revision;
      const extension = officeSaveExtension(current.extension);
      const target = extension === current.extension
        ? current.sourcePath
        : join(dirname(current.sourcePath), `${basename(current.sourcePath, extname(current.sourcePath))}-edited-r${revision.revision}.${extension}`);
      const safeTarget = await resolveRealPathForCreateWithinRoot(current.workspaceRoot, relative(current.workspaceRoot, target));
      if (!safeTarget || safeTarget !== target) throw new Error("Save target is outside the workspace");
      if (extension === current.extension) {
        await replaceSourceFile(target, bytes, extension, current.sourceHash);
        current.sourceHash = revision.sha256;
      } else await fs.writeFile(target, bytes, { flag: "wx" });
      current.savedPath = relative(current.workspaceRoot, target);
      current.savedRevision = revision;
    })().catch((error) => {
      pending.error = error instanceof Error ? error.message : String(error);
    }).then(() => {
      if (this.current !== current || this.pendingSave !== pending) return;
      pending.phase = "ack";
      this.armSaveTimeout(15_000);
      this.sendCommand("document:commit-save", { success: !pending.error }, pending.id);
    });
  };

  private clearPendingSave(): void {
    clearTimeout(this.saveTimer);
    this.saveTimer = undefined;
    this.pendingSave = null;
  }

  private armSaveTimeout(timeout: number): void {
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => {
      this.saveOutcomeUncertain = true;
      this.clearPendingSave();
      this.emit({ ...this.state("error"), message: "Save confirmation timed out; inspect the file before reopening. Do not retry blindly." });
    }, timeout);
    this.saveTimer.unref();
  }

  private state(status: PptEditorState["status"]): PptEditorState {
    const revision = this.current?.revision;
    return {
      status,
      dirty: this.dirty,
      canSave: this.ready && !this.saveOutcomeUncertain && !this.current?.readOnly,
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

  private sendCommand(type: string, payload: Record<string, unknown>, id = `deckwise-${++this.commandSequence}`): string {
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
    this.invalidateFade?.();
    this.imageMetadata = "null";
    this.inspector.stop();
    this.bridgeAbort.abort();
    this.bridgeBinding = null;
    this.bridgeRequests.clear();
    this.openAbort?.abort();
    this.openAbort = null;
    this.opening = false;
    this.clearPendingSave();
    this.dirty = false;
    this.saveOutcomeUncertain = false;
    this.ready = false;
    this.detach();
    const viewContents = this.view?.webContents;
    if (viewContents && !viewContents.isDestroyed()) {
      viewContents.session.removeListener("will-download", this.onDownload);
      viewContents.close();
    }
    this.view = null;
  }
}
