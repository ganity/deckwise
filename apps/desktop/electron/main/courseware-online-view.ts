import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { session, WebContentsView, type BrowserWindow, type IpcMain, type IpcMainEvent } from "electron";
import type { CoursewareOnlineBarrierReceipt, CoursewareOnlineDeployment, CoursewareOnlineEditorState, CoursewareOnlineLaunch } from "@pi-desktop/shared";
import { installEditorHostProtocol } from "./editor-host-protocol";
import { isCoursewareDocsApiPath } from "./courseware-online-deployment";
import type { CoursewareOnlineEditingClient } from "./courseware-online-editing";
import { CoursewareOnlineClientsWorker } from "./courseware-online-clients";

const HOST = "deckwise-editor://host/online.html";
const PROTOCOL = "deckwise-docs-online/1";
const EVENTS = "deckwise-online:event";
const COMMANDS = "deckwise-online:command";
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u;
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const exact = (value: unknown, keys: string[]): value is Record<string, unknown> => record(value) &&
  Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const nativeErrors = new Set(["INVALID", "BUSY", "UNAVAILABLE", "NOT_FOUND", "ACK_UNKNOWN", "DISCONNECTED", "SAVE_UNAVAILABLE",
  "SAVE_UNKNOWN", "RESTRICTION_LOST", "STATE_CHANGED", "SETUP_FAILED"].map(code => `NATIVE_BARRIER_${code}`));
const barrierErrors = new Set([...nativeErrors, "ONLINE_NATIVE_BARRIER_UNAVAILABLE", "ONLINE_NATIVE_BARRIER_BUSY",
  "ONLINE_NATIVE_BARRIER_FAILED", "ONLINE_NATIVE_BARRIER_ACK_UNKNOWN"]);
const replyKeys = ["protocol", "channelId", "requestId", "type", "generation", "projectId", "sessionEpoch", "documentKey", "docsUserId"];
function barrierReceipt(value: unknown, barrierId: string): value is CoursewareOnlineBarrierReceipt {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  if (Object.keys(v).some(key => !["barrierId", "state", "serverIndex", "error"].includes(key)) || v.barrierId !== barrierId ||
      v.serverIndex !== undefined && (!Number.isSafeInteger(v.serverIndex) || Number(v.serverIndex) < 0)) return false;
  if (v.state === "draining") return v.serverIndex === undefined && v.error === undefined;
  if (v.state === "held" || v.state === "resumed") return Number.isSafeInteger(v.serverIndex) && Number(v.serverIndex) >= 0 && v.error === undefined;
  return v.state === "uncertain-held" && typeof v.error === "string" && nativeErrors.has(v.error);
}
const joinErrorCode = (error: unknown): string => error instanceof Error && [
  "COURSEWARE_ONLINE_SESSION_INACTIVE", "COURSEWARE_ONLINE_PLATFORM_46200", "COURSEWARE_ONLINE_PLATFORM_46901", "COURSEWARE_ONLINE_READ_ONLY",
].includes(error.message) ? error.message : "COURSEWARE_ONLINE_EDITOR_UNAVAILABLE";
type Bounds = { x: number; y: number; width: number; height: number };
type Options = {
  ipcMain: IpcMain;
  getMainWindow(): BrowserWindow | null;
  emit(state: CoursewareOnlineEditorState): void;
  onAccessEnded?(): void;
  authorize(): { assertCurrent(): void };
  join(projectId: string, signal: AbortSignal, clientId: string): Promise<CoursewareOnlineLaunch>;
  client?(): CoursewareOnlineEditingClient;
  deployment: CoursewareOnlineDeployment | null;
};
type Attempt = {
  ownerId: string; projectId: string; clientId: string; clients?: CoursewareOnlineClientsWorker; generation: number; channelId: string; requestId: string;
  abort: AbortController; account: { assertCurrent(): void }; window: BrowserWindow;
  view?: WebContentsView; launch?: CoursewareOnlineLaunch; configured: boolean; sent: boolean; ready: boolean;
  timer: ReturnType<typeof setTimeout>; resolve(state: CoursewareOnlineEditorState): void; reject(error: Error): void;
  cleanup: Array<() => void>;
  barrier?: { requestId: string; barrierId?: string; timer: ReturnType<typeof setTimeout>;
    resolve(value: { available: boolean } | CoursewareOnlineBarrierReceipt): void; reject(error: Error): void };
};

function deploymentPins(value: CoursewareOnlineDeployment): CoursewareOnlineDeployment {
  const remote = (input: string) => {
    const url = new URL(input);
    if (url.username || url.password || url.search || url.hash || !(url.protocol === "https:" ||
        (url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)))) throw new Error();
    return url;
  };
  try {
    const host = remote(value.hostUrl), api = remote(value.apiUrl);
    if (!host.pathname.endsWith("/courseware-online.html") || !isCoursewareDocsApiPath(api.pathname)) throw new Error();
    if (value.communityPluginConfigUrl !== undefined) {
      const plugin = remote(value.communityPluginConfigUrl);
      if (plugin.origin !== host.origin || !plugin.pathname.endsWith("/config.json")) throw new Error();
    }
    return { hostUrl: host.href, apiUrl: api.href,
      ...(value.communityPluginConfigUrl === undefined ? {} : { communityPluginConfigUrl: value.communityPluginConfigUrl }) };
  } catch { throw new Error("COURSEWARE_ONLINE_INVALID_DEPLOYMENT"); }
}

/** A separate online surface. No local buffers, Office save patches or team-session writes. */
export class CoursewareOnlineViewController {
  private readonly deployment: CoursewareOnlineDeployment | null;
  private current: Attempt | null = null;
  private selection: { ownerId: string; projectId: string; account: Attempt["account"] } | null = null;
  private generation = 0;
  private disposed = false;
  private visible = false;
  private bounds: Bounds = { x: 0, y: 0, width: 0, height: 0 };
  private value: CoursewareOnlineEditorState;

  constructor(private readonly options: Options) {
    this.deployment = options.deployment === null ? null : deploymentPins(options.deployment);
    this.value = { available: !!this.deployment, ownerId: null, projectId: null, status: "closed" };
    options.ipcMain.on(EVENTS, this.receive);
  }

  state(): CoursewareOnlineEditorState { return { ...this.value }; }

  /** Recovery may read a selected project after admission refuses a new native mount. */
  recoverySelection(ownerId: string): { ownerId: string; projectId: string } {
    const selection = this.selection;
    if (this.disposed || !selection || selection.ownerId !== ownerId || this.value.ownerId !== ownerId ||
        this.value.projectId !== selection.projectId || this.value.status === "closed")
      throw new Error("COURSEWARE_ONLINE_RECOVERY_CHANGED");
    try { selection.account.assertCurrent(); } catch { throw new Error("COURSEWARE_ONLINE_RECOVERY_CHANGED"); }
    return { ownerId, projectId: selection.projectId };
  }

  teachingBinding(ownerId: string) {
    const attempt = this.current;
    if (!attempt || attempt.ownerId !== ownerId || !attempt.ready || !attempt.launch || this.value.status === "error")
      throw new Error("COURSEWARE_ONLINE_TEACHING_CHANGED");
    this.assertCurrent(attempt);
    return { ownerId, projectId: attempt.projectId, sessionEpoch: attempt.launch.sessionEpoch, source: { ...attempt.launch.source } };
  }

  registryBinding(ownerId: string) {
    this.teachingBinding(ownerId);
    const worker = this.current?.clients;
    if (!worker) throw new Error("COURSEWARE_ONLINE_CLIENT_REGISTRY_UNAVAILABLE");
    return worker.binding();
  }

  registryState(ownerId: string) {
    this.registryBinding(ownerId);
    return this.current!.clients!.state();
  }

  /** Internal coordinator API. Never derives save completion from native dirty events. */
  async nativeBarrierCapability(ownerId: string): Promise<{ available: boolean }> {
    return await this.requestBarrier(ownerId, "barrier-capability") as { available: boolean };
  }

  async nativeBarrier(ownerId: string, operation: "quiesce" | "status" | "resume", barrierId: string): Promise<CoursewareOnlineBarrierReceipt> {
    if (!["quiesce", "status", "resume"].includes(operation) || typeof barrierId !== "string" || !uuid.test(barrierId)) throw new Error("COURSEWARE_ONLINE_INVALID_REQUEST");
    return await this.requestBarrier(ownerId, `barrier-${operation}`, barrierId) as CoursewareOnlineBarrierReceipt;
  }

  private requestBarrier(ownerId: string, type: string, barrierId?: string): Promise<{ available: boolean } | CoursewareOnlineBarrierReceipt> {
    this.teachingBinding(ownerId);
    const attempt = this.current!;
    if (attempt.barrier) throw new Error("COURSEWARE_ONLINE_BARRIER_BUSY");
    return new Promise((resolve, reject) => {
      const requestId = randomUUID();
      const timer = setTimeout(() => {
        if (attempt.barrier?.requestId !== requestId) return;
        attempt.barrier = undefined;
        reject(new Error("COURSEWARE_ONLINE_BARRIER_ACK_UNKNOWN"));
      }, 30_000);
      attempt.barrier = { requestId, barrierId, timer, resolve, reject };
      try {
        attempt.view!.webContents.send(COMMANDS, { protocol: PROTOCOL, channelId: attempt.channelId, requestId, type,
          generation: attempt.generation, ...(barrierId === undefined ? {} : { barrierId }) });
      } catch {
        clearTimeout(timer); attempt.barrier = undefined;
        reject(new Error("COURSEWARE_ONLINE_BARRIER_ACK_UNKNOWN"));
      }
    });
  }

  open(ownerId: string, projectId: string): Promise<CoursewareOnlineEditorState> {
    if (this.disposed || !uuid.test(ownerId) || !uuid.test(projectId)) return Promise.reject(new Error("COURSEWARE_ONLINE_INVALID_REQUEST"));
    if (!this.deployment) return Promise.reject(new Error("COURSEWARE_ONLINE_DISABLED"));
    this.release();
    this.selection = null;
    this.visible = false;
    this.bounds = { x: 0, y: 0, width: 0, height: 0 };
    this.publish({ available: true, ownerId, projectId, status: "opening" });
    let account: Attempt["account"], window: BrowserWindow | null;
    try { account = this.options.authorize(); account.assertCurrent(); window = this.options.getMainWindow(); }
    catch { return this.rejectOpen("COURSEWARE_ONLINE_AUTH_CHANGED"); }
    this.selection = { ownerId, projectId, account };
    if (!window || window.isDestroyed()) return this.rejectOpen("COURSEWARE_ONLINE_WINDOW_UNAVAILABLE");
    return new Promise((resolve, reject) => {
      const attempt: Attempt = { ownerId, projectId, clientId: randomUUID(), generation: ++this.generation, channelId: randomUUID(), requestId: randomUUID(),
        abort: new AbortController(), account, window, configured: false, sent: false, ready: false,
        timer: setTimeout(() => this.fail(attempt, "COURSEWARE_ONLINE_MOUNT_TIMEOUT"), 30_000), resolve, reject, cleanup: [] };
      this.current = attempt;
      const closed = () => this.fail(attempt, "COURSEWARE_ONLINE_WINDOW_UNAVAILABLE");
      const hidden = () => this.detach(attempt);
      const shown = () => { if (this.current === attempt && this.visible) this.attach(attempt); };
      const mainContents = window.webContents;
      window.on("closed", closed); window.on("hide", hidden); window.on("show", shown);
      mainContents.on("render-process-gone", closed);
      attempt.cleanup.push(() => {
        window.removeListener("closed", closed); window.removeListener("hide", hidden); window.removeListener("show", shown);
        if (!mainContents.isDestroyed()) mainContents.removeListener("render-process-gone", closed);
      });
      void this.mount(attempt).catch(error => { if (this.current === attempt) this.fail(attempt, joinErrorCode(error)); });
    });
  }

  setBounds(ownerId: string, bounds: Bounds): void {
    if (ownerId !== this.value.ownerId || !exact(bounds, ["x", "y", "width", "height"]) ||
        !Object.values(bounds).every(value => typeof value === "number" && Number.isFinite(value))) return;
    this.bounds = Object.fromEntries(Object.entries(bounds).map(([key, value]) => [key, Math.min(32767, Math.max(0, Math.round(value)))])) as Bounds;
    this.current?.view?.setBounds(this.bounds);
  }

  setVisible(ownerId: string, visible: boolean): void {
    if (ownerId !== this.value.ownerId || typeof visible !== "boolean") return;
    this.visible = visible;
    const attempt = this.current;
    if (!attempt?.view) return;
    if (visible) this.attach(attempt); else this.detach(attempt);
  }

  close(ownerId: string): void {
    if (ownerId !== this.value.ownerId) return;
    this.invalidate();
  }

  invalidate(): void {
    this.release();
    this.selection = null;
    this.visible = false;
    this.publish({ available: !!this.deployment, ownerId: null, projectId: null, status: "closed" });
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.options.ipcMain.removeListener(EVENTS, this.receive);
    this.invalidate();
  }

  private rejectOpen(code: string): Promise<never> {
    this.publish({ ...this.value, status: "error", errorCode: code });
    return Promise.reject(new Error(code));
  }

  private assertCurrent(attempt: Attempt): void {
    attempt.abort.signal.throwIfAborted();
    attempt.account.assertCurrent();
    if (this.current !== attempt || this.options.getMainWindow() !== attempt.window || attempt.window.isDestroyed())
      throw new Error("COURSEWARE_ONLINE_OWNER_CHANGED");
  }

  private async mount(attempt: Attempt): Promise<void> {
    const launch = await this.options.join(attempt.projectId, attempt.abort.signal, attempt.clientId);
    this.assertCurrent(attempt);
    if (launch.projectId !== attempt.projectId || !Number.isSafeInteger(launch.sessionEpoch) || launch.sessionEpoch < 1 ||
        !/^[A-Za-z0-9_.=-]{1,128}$/u.test(launch.documentKey) || !new RegExp(`^tenant-[1-9]\\d*-user-[1-9]\\d*${launch.clientId === undefined ? "" : `-client-${attempt.clientId}`}$`, "u").test(launch.docsUserId) ||
        launch.clientId !== undefined && launch.clientId !== attempt.clientId ||
        typeof launch.configJson !== "string" || launch.configJson.length > 65536 ||
        !Number.isSafeInteger(launch.expiresAtEpochMillis) || launch.expiresAtEpochMillis <= Date.now() ||
        launch.expiresAtEpochMillis > Date.now() + 120000) throw new Error();
    attempt.launch = launch;
    if (launch.clientId && this.options.client) {
      attempt.clients = new CoursewareOnlineClientsWorker({
        binding: { ownerId: attempt.ownerId, projectId: attempt.projectId, sessionEpoch: launch.sessionEpoch,
          documentKey: launch.documentKey, docsUserId: launch.docsUserId, clientId: launch.clientId },
        client: this.options.client(), assertCurrent: () => this.assertCurrent(attempt),
        close: code => {
          if (this.current !== attempt) return;
          this.selection = null;
          this.fail(attempt, code);
          this.options.onAccessEnded?.();
        },
        capability: () => this.nativeBarrierCapability(attempt.ownerId),
        native: (operation, barrierId) => this.nativeBarrier(attempt.ownerId, operation, barrierId),
      });
    }
    const isolated = session.fromPartition(`courseware-online-${randomUUID()}`, { cache: false });
    installEditorHostProtocol(isolated.protocol);
    isolated.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    isolated.setPermissionCheckHandler(() => false);
    isolated.setDevicePermissionHandler(() => false);
    isolated.on("will-download", event => event.preventDefault());
    attempt.cleanup.push(() => { void isolated.clearStorageData().catch(() => {}); });
    const view = new WebContentsView({ webPreferences: { session: isolated,
      preload: join(__dirname, "../preload/courseware-online-host.js"),
      contextIsolation: true, nodeIntegration: false, sandbox: true, webviewTag: false,
      webSecurity: true, safeDialogs: true, autoplayPolicy: "user-gesture-required" } });
    attempt.view = view;
    const contents = view.webContents;
    contents.setWindowOpenHandler(() => ({ action: "deny" }));
    contents.on("will-navigate", event => event.preventDefault());
    const origins = new Set([new URL(this.deployment!.hostUrl).origin, new URL(this.deployment!.apiUrl).origin]);
    contents.on("will-frame-navigate", event => {
      let permitted = false;
      try { permitted = !event.isMainFrame && (event.url === "about:blank" || origins.has(new URL(event.url).origin)); } catch { /* Deny malformed navigation. */ }
      if (!permitted) event.preventDefault();
    });
    contents.on("will-redirect", (event, target, _same, isMainFrame) => {
      let permitted = false;
      try { permitted = !(event.isMainFrame ?? isMainFrame) && origins.has(new URL(target).origin); } catch { /* Deny malformed redirects. */ }
      if (!permitted) event.preventDefault();
    });
    contents.on("will-attach-webview", event => event.preventDefault());
    contents.on("did-fail-load", (_event, _code, _description, _url, isMainFrame) => {
      if (isMainFrame !== false) this.fail(attempt, "COURSEWARE_ONLINE_LOAD_FAILED");
    });
    contents.on("render-process-gone", () => this.fail(attempt, "COURSEWARE_ONLINE_LOAD_FAILED"));
    contents.once("destroyed", () => this.fail(attempt, "COURSEWARE_ONLINE_LOAD_FAILED"));
    view.setBounds(this.bounds);
    if (this.visible) this.attach(attempt);
    try { await contents.loadURL(HOST); } catch { this.fail(attempt, "COURSEWARE_ONLINE_LOAD_FAILED"); }
  }

  private readonly receive = (event: IpcMainEvent, data: unknown): void => {
    const attempt = this.current, contents = attempt?.view?.webContents;
    if (!attempt || !contents || contents.isDestroyed() || event.sender !== contents || event.sender.id !== contents.id ||
        event.senderFrame !== contents.mainFrame || event.senderFrame?.url !== HOST || !record(data)) return;
    try { this.assertCurrent(attempt); } catch { this.fail(attempt, "COURSEWARE_ONLINE_AUTH_CHANGED"); return; }
    if (exact(data, ["type"]) && data.type === "wrapper-ready" && !attempt.configured) {
      attempt.configured = true;
      contents.send(COMMANDS, { type: "configure", channelId: attempt.channelId, ...this.deployment });
      return;
    }
    const call = attempt.barrier, launchPins = attempt.launch;
    if (call && launchPins && data.protocol === PROTOCOL && data.channelId === attempt.channelId && data.requestId === call.requestId &&
        data.generation === attempt.generation && data.projectId === attempt.projectId && data.sessionEpoch === launchPins.sessionEpoch &&
        data.documentKey === launchPins.documentKey && data.docsUserId === launchPins.docsUserId) {
      clearTimeout(call.timer); attempt.barrier = undefined;
      if (data.type === "error" && exact(data, [...replyKeys, "code"]) && typeof data.code === "string" && barrierErrors.has(data.code))
        call.reject(new Error(data.code));
      else if (call.barrierId === undefined && data.type === "barrier-capability" && exact(data, [...replyKeys, "result"]) &&
          exact(data.result, ["available"]) && typeof data.result.available === "boolean") call.resolve({ available: data.result.available });
      else if (call.barrierId !== undefined && data.type === "barrier" && exact(data, [...replyKeys, "result"]) && barrierReceipt(data.result, call.barrierId))
        call.resolve({ ...data.result });
      else call.reject(new Error("COURSEWARE_ONLINE_BARRIER_INVALID_RESPONSE"));
      return;
    }
    if (!attempt.configured || !exact(data, ["protocol", "channelId", "type"]) && !exact(data,
      ["protocol", "channelId", "requestId", "type", "generation", "projectId", "sessionEpoch", "documentKey", "docsUserId"]) && !exact(data,
      ["protocol", "channelId", "requestId", "type", "generation", "projectId", "sessionEpoch", "documentKey", "docsUserId", "dirty"]) && !exact(data,
      ["protocol", "channelId", "requestId", "type", "generation", "projectId", "sessionEpoch", "documentKey", "docsUserId", "canReadText"]) && !exact(data,
      ["protocol", "channelId", "requestId", "type", "generation", "projectId", "sessionEpoch", "documentKey", "docsUserId", "code"])) return;
    if (data.protocol !== PROTOCOL || data.channelId !== attempt.channelId) return;
    if (data.type === "entry-ready" && exact(data, ["protocol", "channelId", "type"]) && !attempt.sent && attempt.launch) {
      if (attempt.launch.expiresAtEpochMillis <= Date.now()) { this.fail(attempt, "COURSEWARE_ONLINE_LAUNCH_EXPIRED"); return; }
      attempt.sent = true;
      const { projectId, sessionEpoch, documentKey, docsUserId, configJson, expiresAtEpochMillis } = attempt.launch;
      contents.send(COMMANDS, { protocol: PROTOCOL, channelId: attempt.channelId, requestId: attempt.requestId,
        type: "open", generation: attempt.generation, projectId, sessionEpoch, documentKey, docsUserId, configJson, expiresAtEpochMillis });
      return;
    }
    const launch = attempt.launch;
    if (!attempt.sent || !launch || data.requestId !== attempt.requestId || data.generation !== attempt.generation ||
        data.projectId !== attempt.projectId || data.sessionEpoch !== launch.sessionEpoch || data.documentKey !== launch.documentKey || data.docsUserId !== launch.docsUserId) return;
    if (data.type === "ready" && exact(data, ["protocol", "channelId", "requestId", "type", "generation", "projectId", "sessionEpoch", "documentKey", "docsUserId"])) {
      if (attempt.ready) return;
      attempt.ready = true; clearTimeout(attempt.timer);
      this.publish({ available: true, ownerId: attempt.ownerId, projectId: attempt.projectId, status: "ready" });
      attempt.resolve(this.state());
      attempt.clients?.start();
    } else if (data.type === "state" && typeof data.dirty === "boolean" && attempt.ready && exact(data,
      ["protocol", "channelId", "requestId", "type", "generation", "projectId", "sessionEpoch", "documentKey", "docsUserId", "dirty"])) {
      this.publish({ available: true, ownerId: attempt.ownerId, projectId: attempt.projectId, status: data.dirty ? "sync-pending" : "sync-reported" });
    } else if (data.type === "error" && typeof data.code === "string" && exact(data,
      ["protocol", "channelId", "requestId", "type", "generation", "projectId", "sessionEpoch", "documentKey", "docsUserId", "code"]))
      this.fail(attempt, "COURSEWARE_ONLINE_NATIVE_ERROR");
  };

  private attach(attempt: Attempt): void {
    if (!attempt.view || attempt.window.isDestroyed() || !attempt.window.isVisible()) return;
    if (!attempt.window.contentView.children.includes(attempt.view)) attempt.window.contentView.addChildView(attempt.view);
    attempt.view.setBounds(this.bounds);
  }
  private detach(attempt: Attempt): void {
    if (attempt.view && !attempt.window.isDestroyed() && attempt.window.contentView.children.includes(attempt.view))
      attempt.window.contentView.removeChildView(attempt.view);
  }
  private fail(attempt: Attempt, code: string): void {
    if (this.current !== attempt) return;
    this.release(code);
    this.publish({ available: true, ownerId: attempt.ownerId, projectId: attempt.projectId, status: "error", errorCode: code });
  }
  private release(code = "COURSEWARE_ONLINE_VIEW_CLOSED"): void {
    const attempt = this.current;
    if (!attempt) return;
    attempt.clients?.stop();
    this.current = null;
    clearTimeout(attempt.timer); attempt.abort.abort();
    if (attempt.barrier) {
      clearTimeout(attempt.barrier.timer); attempt.barrier.reject(new Error(code)); attempt.barrier = undefined;
    }
    attempt.reject(new Error(code));
    this.detach(attempt);
    const contents = attempt.view?.webContents;
    if (contents && !contents.isDestroyed()) contents.close();
    for (const cleanup of attempt.cleanup) cleanup();
    attempt.launch = undefined;
  }
  private publish(value: CoursewareOnlineEditorState): void { this.value = value; this.options.emit(this.state()); }
}
