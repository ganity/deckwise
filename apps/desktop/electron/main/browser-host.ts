import type { BrowserState } from "@pi-desktop/shared";
import type { BrowserPane } from "./browser-view";
import { BrowserCdp, type BrowserCdpLog, type BrowserElementTarget } from "./browser-cdp";
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { BrowserWindow } from "electron";
import { screenshotLivePreview, screenshotSvg } from "./svg-screenshot";

export const BROWSER_PLUGIN_ID = "pi.browser";
export const BROWSER_VIEW_ID = "browser";

export type BrowserRect = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export type BrowserNavigateInput = {
  url?: string;
  path?: string;
};

/**
 * Translate a plugin-page hole into window coordinates and clamp it so the
 * guest cannot cover chat/composer outside the calling plugin view.
 */
export function clampGuestBounds(
  view: BrowserRect,
  hole: BrowserRect,
): BrowserRect | null {
  const x = Math.max(view.x, view.x + hole.x);
  const y = Math.max(view.y, view.y + hole.y);
  const right = Math.min(view.x + view.width, view.x + hole.x + hole.width);
  const bottom = Math.min(view.y + view.height, view.y + hole.y + hole.height);
  const width = Math.floor(right - x);
  const height = Math.floor(bottom - y);
  if (width < 1 || height < 1) return null;
  return {
    x: Math.floor(x),
    y: Math.floor(y),
    width,
    height,
  };
}

function asRect(value: unknown): BrowserRect | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const x = Number(record.x);
  const y = Number(record.y);
  const width = Number(record.width);
  const height = Number(record.height);
  if (![x, y, width, height].every((n) => Number.isFinite(n))) return null;
  return { x, y, width, height };
}

export type BrowserHostDeps = {
  pane: BrowserPane;
  isPluginLoaded: (pluginId: string) => boolean;
  getFileRoot: (sessionId?: string) => Promise<string | null>;
  getScratchDir?: (sessionId?: string) => string | null;
  getMainWindow?: () => BrowserWindow | null;
  onState: (state: BrowserState) => void;
  log?: BrowserCdpLog;
};

type ChromeSurface = {
  pluginId: string;
  viewId: string;
  visible: boolean;
  bounds: BrowserRect;
};

/**
 * Public `pi.browser.*` implementation: one host-owned guest WebContentsView,
 * driven by plugin chrome through a clamped hole, plus CDP for the agent.
 */
export class BrowserHost {
  private readonly pane: BrowserPane;
  private readonly cdp: BrowserCdp;
  private readonly deps: BrowserHostDeps;
  private chrome: ChromeSurface | null = null;
  private hole: BrowserRect | null = null;
  private holePluginId: string | null = null;
  private readonly locations = new Map<string, string>();
  private chromeSessionId: string | null = null;
  private started = false;
  private navigationEpoch = 0;

  constructor(deps: BrowserHostDeps) {
    this.deps = deps;
    this.pane = deps.pane;
    this.cdp = new BrowserCdp(deps.log);
  }

  setChromeSurface(surface: ChromeSurface | null): void {
    this.chrome = surface;
    this.applyGuest();
  }

  setChromeSession(sessionId: string | undefined): void {
    const next = sessionId?.trim() || null;
    if (this.chromeSessionId === next) return;
    this.chromeSessionId = next;
    this.navigationEpoch += 1;
    this.pane.invalidateNavigation();
    this.started = false;
    this.pane.setVisible(false);
    if (next) {
      void this.rebindSession(next).catch((error) => {
        console.warn("Browser preview session restore failed", error);
      });
    }
  }

  /**
   * Content-relative hole inside the calling plugin view. Last writer wins
   * (v1 is a singleton guest).
   */
  setGuestHole(pluginId: string, hole: unknown): BrowserRect | null {
    const rect = asRect(hole);
    if (!rect) {
      this.hole = null;
      this.holePluginId = pluginId;
      this.applyGuest();
      return null;
    }
    this.hole = rect;
    this.holePluginId = pluginId;
    this.applyGuest();
    return this.guestBounds();
  }

  setGuestVisible(pluginId: string, visible: boolean): void {
    if (!visible && this.holePluginId === pluginId) {
      this.pane.setVisible(false);
      return;
    }
    if (visible) this.applyGuest();
  }

  rememberLocation(sessionId: string | undefined, location: string): void {
    const id = sessionId?.trim();
    const value = location.trim();
    if (!id || !value) return;
    this.locations.set(id, value);
  }

  async navigate(
    input: BrowserNavigateInput,
    sessionId?: string,
  ): Promise<BrowserState | null> {
    const target = String(input.path ?? input.url ?? "").trim();
    if (!target) return this.pane.getState();
    this.rememberLocation(sessionId ?? this.chromeSessionId ?? undefined, target);
    const background =
      Boolean(sessionId) &&
      Boolean(this.chromeSessionId) &&
      sessionId !== this.chromeSessionId;
    if (background) return this.pane.getState();
    const state = await this.navigateGuest(
      target,
      this.deps.getFileRoot(sessionId ?? this.chromeSessionId ?? undefined),
    );
    if (state) this.deps.onState(state);
    return state;
  }

  action(action: "back" | "forward" | "reload" | "stop"): void {
    this.pane.action(action);
  }

  getState(): BrowserState | null {
    return this.pane.getState();
  }

  openExternal(): void {
    this.pane.openExternal();
  }

  async snapshot(): Promise<{ tree: string; url: string; title: string }> {
    const wc = this.requireWebContents();
    return this.cdp.snapshot(wc);
  }

  async screenshot(
    input: { fullPage?: boolean; path?: string } = {},
    sessionId?: string,
  ): Promise<{ mimeType: string; data: string; path?: string }> {
    // SVG capture reads the current editor or a workspace file without showing
    // the browser guest; other pages retain CDP and native capture fallback.
    let shot: { mimeType: string; data: string } | null = null;
    try {
      const window = this.deps.getMainWindow?.();
      const root = window && await this.deps.getFileRoot(sessionId ?? this.chromeSessionId ?? undefined);
      if (window && root && (input.path || sessionId)) {
        shot = await screenshotSvg(window, root, input.path, sessionId);
        this.deps.log?.("info", shot ? "browser.screenshot.svg.done" : "browser.screenshot.svg.skipped", {
          pathProvided: Boolean(input.path),
        });
      }
    } catch (error) {
      this.deps.log?.("warn", "browser.screenshot.svg.fallback", { error: String(error) });
    }
    if (!shot) {
      const wc = await this.waitForWebContents();
      if (!input.path && sessionId && sessionId === this.chromeSessionId) {
        try {
          shot = await screenshotLivePreview(wc);
          this.deps.log?.("info", shot ? "browser.screenshot.svg.done" : "browser.screenshot.svg.skipped", {
            source: "live_preview",
          });
        } catch (error) {
          this.deps.log?.("warn", "browser.screenshot.svg.fallback", { source: "live_preview", error: String(error) });
        }
      }
      if (!shot) shot = await this.cdp.screenshot(wc, input, () => this.pane.capturePage());
    }
    const scratch = this.deps.getScratchDir?.(sessionId ?? this.chromeSessionId ?? undefined);
    if (!scratch) return shot;
    try {
      mkdirSync(scratch, { recursive: true });
      const path = join(scratch, `browser-screenshot-${Date.now()}.${shot.mimeType === "image/png" ? "png" : "jpg"}`);
      writeFileSync(path, Buffer.from(shot.data, "base64"));
      return { ...shot, path };
    } catch {
      return shot;
    }
  }

  async click(target: string | BrowserElementTarget): Promise<void> {
    const { uid, selector } = this.elementTarget(target);
    const wc = this.requireWebContents();
    if (selector) await this.cdp.clickSelector(wc, selector);
    else await this.cdp.click(wc, uid!);
  }

  async fill(target: string | BrowserElementTarget, text: string): Promise<void> {
    const { uid, selector } = this.elementTarget(target);
    const wc = this.requireWebContents();
    if (selector) await this.cdp.fillSelector(wc, selector, text);
    else await this.cdp.fill(wc, uid!, text);
  }

  async evaluate(expression: string): Promise<unknown> {
    return this.cdp.evaluate(this.requireWebContents(), expression);
  }

  console(limit?: number): { messages: ReturnType<BrowserCdp["console"]> } {
    this.ensureCdp();
    return { messages: this.cdp.console(limit) };
  }

  async cdpCommand(method: string, params?: unknown): Promise<unknown> {
    return this.cdp.send(this.requireWebContents(), method, params);
  }

  /**
   * Host `BrowserPreview` facade: plugin must be enabled; the guest loads the
   * workspace file only when that session's chrome is visible (D142).
   */
  async previewWorkspaceFile(
    sessionId: string,
    path: string,
    root: string,
  ): Promise<{ ok: true } | { ok: false; content: string }> {
    if (!this.deps.isPluginLoaded(BROWSER_PLUGIN_ID)) {
      return {
        ok: false,
        content:
          "页面预览组件已停用，无法打开预览。",
      };
    }
    this.rememberLocation(sessionId, path);
    const background =
      Boolean(this.chromeSessionId) && this.chromeSessionId !== sessionId;
    if (!background) {
      await this.navigateGuest(path, root);
    }
    return { ok: true };
  }

  disposeGuest(): void {
    this.navigationEpoch += 1;
    this.cdp.detach(this.pane.getWebContents() ?? undefined);
    this.pane.dispose();
    this.started = false;
    this.hole = null;
    this.holePluginId = null;
  }

  private guestBounds(): BrowserRect | null {
    if (!this.chrome?.visible || !this.hole) return null;
    if (this.holePluginId !== this.chrome.pluginId) return null;
    return clampGuestBounds(this.chrome.bounds, this.hole);
  }

  private applyGuest(): void {
    const bounds = this.guestBounds();
    if (!bounds || !this.started) {
      this.pane.setVisible(false);
      return;
    }
    this.pane.setBounds(bounds);
    this.pane.setVisible(true);
  }

  private async rebindSession(sessionId: string): Promise<void> {
    const location = this.locations.get(sessionId);
    if (!location) return;
    await this.navigateGuest(location, this.deps.getFileRoot(sessionId));
  }

  private async navigateGuest(
    target: string,
    root: string | null | Promise<string | null>,
  ): Promise<BrowserState | null> {
    const epoch = ++this.navigationEpoch;
    const fileRoot = await root;
    if (epoch !== this.navigationEpoch) return null;
    const state = await this.pane.navigateAndWait(target, fileRoot);
    if (epoch !== this.navigationEpoch) return null;
    if (state) this.started = true;
    this.applyGuest();
    return state;
  }

  private requireWebContents() {
    const wc = this.pane.getWebContents();
    if (!wc || wc.isDestroyed()) {
      throw Object.assign(new Error("browser guest is not available"), {
        code: "UNAVAILABLE",
      });
    }
    return wc;
  }

  private async waitForWebContents(timeoutMs = 2_000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const wc = this.pane.getWebContents();
      if (wc && !wc.isDestroyed()) return wc;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return this.requireWebContents();
  }

  private elementTarget(target: string | BrowserElementTarget): BrowserElementTarget {
    const value = typeof target === "string" ? { uid: target } : target;
    const uid = value.uid?.trim();
    const selector = value.selector?.trim();
    if (Boolean(uid) === Boolean(selector)) {
      throw Object.assign(new Error("provide exactly one of uid or selector"), {
        code: "INVALID_ARGUMENT",
      });
    }
    return { uid, selector };
  }

  private ensureCdp(): void {
    const wc = this.pane.getWebContents();
    if (wc && !wc.isDestroyed()) void this.cdp.attach(wc);
  }
}
