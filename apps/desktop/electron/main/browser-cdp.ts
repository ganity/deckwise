import type { NativeImage, WebContents } from "electron";

/** Chrome DevTools Protocol revision attached to the work-panel guest. */
export const BROWSER_CDP_PROTOCOL = "1.3";

/**
 * Deny-by-default CDP methods the public `pi.browser.cdp` API may send.
 * Cookie, storage, target, and network-interception methods stay off this list.
 */
export const BROWSER_CDP_ALLOWLIST = new Set([
  "Page.enable",
  "Page.reload",
  "Page.captureScreenshot",
  "Page.getLayoutMetrics",
  "Page.bringToFront",
  "DOM.enable",
  "DOM.getDocument",
  "DOM.querySelector",
  "DOM.querySelectorAll",
  "DOM.getBoxModel",
  "DOM.describeNode",
  "DOM.scrollIntoViewIfNeeded",
  "DOM.getOuterHTML",
  "DOM.getAttributes",
  "Runtime.enable",
  "Runtime.evaluate",
  "Runtime.callFunctionOn",
  "Runtime.getProperties",
  "Runtime.awaitPromise",
  "Input.dispatchMouseEvent",
  "Input.dispatchKeyEvent",
  "Input.insertText",
  "Accessibility.enable",
  "Accessibility.getFullAXTree",
  "Accessibility.getPartialAXTree",
  "Console.enable",
]);

const MAX_EVALUATE_CHARS = 64 * 1024;
const MAX_CONSOLE_MESSAGES = 100;
const SCREENSHOT_MAX_WIDTH = 1280;
const SCREENSHOT_TIMEOUT_MS = 15_000;

export type BrowserConsoleMessage = {
  type: string;
  text: string;
  timestamp: number;
};

export type AxNode = {
  nodeId?: string;
  ignored?: boolean;
  role?: { value?: string };
  name?: { value?: string };
  backendDOMNodeId?: number;
  childIds?: string[];
};

export type SnapshotResult = {
  tree: string;
  url: string;
  title: string;
};

export type BrowserElementTarget = {
  uid?: string;
  selector?: string;
};

export type BrowserCdpLog = (
  level: "info" | "warn",
  event: string,
  data?: Record<string, unknown>,
) => void;

export function isAllowedCdpMethod(method: string): boolean {
  return BROWSER_CDP_ALLOWLIST.has(method.trim());
}

/**
 * Flatten an accessibility tree into indented text with stable `eN` uids.
 * Ignored nodes are skipped; uids map to backend DOM node ids for click/fill.
 */
export function flattenAxTree(nodes: AxNode[]): {
  tree: string;
  uids: Map<string, number>;
} {
  const byId = new Map<string, AxNode>();
  for (const node of nodes) {
    if (typeof node.nodeId === "string") byId.set(node.nodeId, node);
  }
  const childIds = new Set<string>();
  for (const node of nodes) {
    for (const id of node.childIds ?? []) childIds.add(id);
  }
  const roots = nodes.filter(
    (node) => typeof node.nodeId === "string" && !childIds.has(node.nodeId),
  );
  const uids = new Map<string, number>();
  const lines: string[] = [];
  let next = 1;

  const walk = (node: AxNode, depth: number) => {
    if (!node.ignored) {
      const role = node.role?.value?.trim() || "Generic";
      const name = node.name?.value?.trim() ?? "";
      const uid = `e${next}`;
      next += 1;
      if (typeof node.backendDOMNodeId === "number") {
        uids.set(uid, node.backendDOMNodeId);
      }
      const label = name ? `${role} ${JSON.stringify(name)}` : role;
      lines.push(`${"  ".repeat(depth)}- ${uid} ${label}`);
    }
    for (const childId of node.childIds ?? []) {
      const child = byId.get(childId);
      if (child) walk(child, node.ignored ? depth : depth + 1);
    }
  };
  for (const root of roots) walk(root, 0);
  return { tree: lines.join("\n") || "(empty)", uids };
}

function consoleText(args: unknown): string {
  if (!Array.isArray(args)) return String(args ?? "");
  return args
    .map((arg) => {
      if (!arg || typeof arg !== "object") return String(arg);
      const record = arg as { value?: unknown; description?: string; type?: string };
      if (typeof record.value === "string") return record.value;
      if (record.value !== undefined) return String(record.value);
      if (typeof record.description === "string") return record.description;
      return record.type ?? "";
    })
    .filter(Boolean)
    .join(" ");
}

/**
 * CDP session bound to one guest WebContents. Re-attaches when the view is
 * recreated. Snapshot uids are valid only until the next snapshot.
 */
export class BrowserCdp {
  private readonly log?: BrowserCdpLog;

  constructor(log?: BrowserCdpLog) {
    this.log = log;
  }

  private attachedId: number | null = null;
  private attachedWebContents: WebContents | null = null;
  private uids = new Map<string, number>();
  private messages: BrowserConsoleMessage[] = [];
  private onDebuggerMessage?: (
    event: unknown,
    method: string,
    params: unknown,
  ) => void;
  private onDebuggerDetach?: () => void;

  isAttached(wc: WebContents): boolean {
    return this.attachedId === wc.id && !wc.isDestroyed() && wc.debugger.isAttached();
  }

  async attach(wc: WebContents, trace = false): Promise<void> {
    if (wc.isDestroyed()) {
      throw new Error("browser guest is not available");
    }
    if (this.isAttached(wc)) return;
    this.detach();
    if (!wc.debugger.isAttached()) {
      wc.debugger.attach(BROWSER_CDP_PROTOCOL);
    }
    this.attachedId = wc.id;
    this.attachedWebContents = wc;
    this.onDebuggerMessage = (_event, method, params) => {
      if (
        method === "Page.frameStartedNavigating" ||
        method === "Page.frameNavigated" ||
        method === "Page.navigatedWithinDocument"
      ) {
        this.uids.clear();
      }
      if (method !== "Runtime.consoleAPICalled" && method !== "Console.messageAdded") {
        return;
      }
      const record = params && typeof params === "object" ? (params as Record<string, unknown>) : {};
      const type =
        typeof record.type === "string"
          ? record.type
          : typeof (record.message as { level?: string } | undefined)?.level === "string"
            ? (record.message as { level: string }).level
            : "log";
      const text =
        method === "Console.messageAdded"
          ? String((record.message as { text?: string } | undefined)?.text ?? "")
          : consoleText(record.args);
      this.messages.push({ type, text, timestamp: Date.now() });
      if (this.messages.length > MAX_CONSOLE_MESSAGES) this.messages.shift();
    };
    this.onDebuggerDetach = () => {
      if (this.onDebuggerMessage) wc.debugger.off("message", this.onDebuggerMessage);
      if (this.onDebuggerDetach) wc.debugger.off("detach", this.onDebuggerDetach);
      this.uids.clear();
      this.attachedId = null;
      this.attachedWebContents = null;
      this.onDebuggerMessage = undefined;
      this.onDebuggerDetach = undefined;
    };
    wc.debugger.on("message", this.onDebuggerMessage);
    wc.debugger.on("detach", this.onDebuggerDetach);
    try {
      await this.command(wc, "Runtime.enable", {}, trace);
      await this.command(wc, "Console.enable", {}, trace);
      await this.command(wc, "Page.enable", {}, trace);
      await this.command(wc, "DOM.enable", {}, trace);
      await this.command(wc, "Accessibility.enable", {}, trace);
    } catch (error) {
      this.detach(wc);
      throw error;
    }
  }

  detach(wc?: WebContents): void {
    const target = this.attachedWebContents ?? wc;
    if (target) {
      if (this.onDebuggerMessage) {
        target.debugger.off("message", this.onDebuggerMessage);
      }
      if (this.onDebuggerDetach) {
        target.debugger.off("detach", this.onDebuggerDetach);
      }
      if (!target.isDestroyed() && target.debugger.isAttached()) {
        try {
          target.debugger.detach();
        } catch {
          // Already detached.
        }
      }
    }
    this.onDebuggerMessage = undefined;
    this.onDebuggerDetach = undefined;
    this.attachedId = null;
    this.attachedWebContents = null;
    this.uids.clear();
  }

  private async command(
    wc: WebContents,
    method: string,
    params: Record<string, unknown> = {},
    trace = false,
  ): Promise<unknown> {
    const startedAt = Date.now();
    if (trace) {
      this.log?.("info", "browser.cdp.command.start", {
        method,
        webContentsId: wc.id,
      });
    }
    try {
      const result = await wc.debugger.sendCommand(method, params);
      if (trace) {
        this.log?.("info", "browser.cdp.command.done", {
          method,
          webContentsId: wc.id,
          durationMs: Date.now() - startedAt,
        });
      }
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (trace) {
        this.log?.("warn", "browser.cdp.command.failed", {
          method,
          webContentsId: wc.id,
          durationMs: Date.now() - startedAt,
          error: message,
        });
      }
      if (/target.*closed|webcontents.*destroyed|debugger.*(detached|not attached)/i.test(message)) {
        this.detach(wc);
        throw Object.assign(
          new Error(`browser target closed while handling ${method}; the action may have completed`),
          { code: "BROWSER_TARGET_CLOSED", cause: error },
        );
      }
      throw error;
    }
  }

  async send(wc: WebContents, method: string, params?: unknown): Promise<unknown> {
    if (!isAllowedCdpMethod(method)) {
      throw Object.assign(new Error(`CDP method not allowed: ${method}`), {
        code: "PERMISSION_DENIED",
      });
    }
    await this.attach(wc);
    return this.command(
      wc,
      method,
      (params && typeof params === "object" ? params : {}) as Record<string, unknown>,
    );
  }

  async snapshot(wc: WebContents): Promise<SnapshotResult> {
    await this.attach(wc);
    const raw = (await this.command(wc, "Accessibility.getFullAXTree")) as {
      nodes?: AxNode[];
    };
    const flattened = flattenAxTree(Array.isArray(raw?.nodes) ? raw.nodes : []);
    this.uids = flattened.uids;
    return {
      tree: flattened.tree,
      url: wc.getURL(),
      title: wc.getTitle(),
    };
  }

  async screenshot(
    wc: WebContents,
    input: { fullPage?: boolean } = {},
    capturePage?: () => Promise<NativeImage>,
  ): Promise<{ mimeType: string; data: string }> {
    const startedAt = Date.now();
    this.log?.("info", "browser.screenshot.start", {
      fullPage: Boolean(input.fullPage),
      webContentsId: wc.id,
    });
    // Electron's native capture path does not depend on a CDP response and is
    // reliable for the normal visible-area screenshot used by the preview.
    if (!input.fullPage) {
      return this.nativeScreenshot(wc, startedAt, capturePage);
    }

    // Full-page capture still needs CDP for its content-sized clip. Bound the
    // command so a Chromium capture stall cannot consume the host RPC timeout.
    try {
      this.detach(wc);
      await this.withTimeout(this.attach(wc, true), SCREENSHOT_TIMEOUT_MS, "CDP attach");
      let clip: { x: number; y: number; width: number; height: number; scale: number } | undefined;
      if (input.fullPage) {
        const metrics = (await this.withTimeout(
          this.command(wc, "Page.getLayoutMetrics", {}, true),
          SCREENSHOT_TIMEOUT_MS,
          "CDP layout metrics",
        )) as {
          contentSize?: { width?: number; height?: number };
          cssContentSize?: { width?: number; height?: number };
        };
        const size = metrics.cssContentSize ?? metrics.contentSize ?? { width: 0, height: 0 };
        const width = Math.max(1, Number(size.width) || 1);
        const height = Math.max(1, Number(size.height) || 1);
        const scale = width > SCREENSHOT_MAX_WIDTH ? SCREENSHOT_MAX_WIDTH / width : 1;
        clip = { x: 0, y: 0, width, height, scale };
      }
      const result = (await this.withTimeout(this.command(wc, "Page.captureScreenshot", {
        format: "jpeg",
        quality: 70,
        ...(clip ? { clip, captureBeyondViewport: true } : {}),
      }, true), SCREENSHOT_TIMEOUT_MS, "CDP screenshot")) as { data?: string };
      if (typeof result?.data !== "string" || !result.data) {
        throw new Error("screenshot produced no data");
      }
      this.log?.("info", "browser.screenshot.done", {
        fullPage: Boolean(input.fullPage),
        webContentsId: wc.id,
        durationMs: Date.now() - startedAt,
        bytes: result.data.length,
      });
      return { mimeType: "image/jpeg", data: result.data };
    } catch (error) {
      if (error instanceof Error && (error as Error & { code?: string }).code === "SCREENSHOT_TIMEOUT") {
        this.detach(wc);
        this.log?.("warn", "browser.screenshot.fullPage.fallback", {
          webContentsId: wc.id,
          durationMs: Date.now() - startedAt,
          error: error.message,
        });
        return this.nativeScreenshot(wc, startedAt, capturePage);
      }
      this.log?.("warn", "browser.screenshot.failed", {
        fullPage: Boolean(input.fullPage),
        webContentsId: wc.id,
        durationMs: Date.now() - startedAt,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  private async nativeScreenshot(
    wc: WebContents,
    startedAt: number,
    capturePage?: () => Promise<NativeImage>,
  ): Promise<{ mimeType: string; data: string }> {
    this.log?.("info", "browser.screenshot.native.start", {
      webContentsId: wc.id,
    });
    try {
      const image = await this.withTimeout(
        (capturePage ?? (() => wc.capturePage(undefined, { stayHidden: true, stayAwake: true })))(),
        SCREENSHOT_TIMEOUT_MS,
        "native screenshot",
      );
      const data = image.toJPEG(70).toString("base64");
      if (!data) throw new Error("screenshot produced no data");
      this.log?.("info", "browser.screenshot.native.done", {
        webContentsId: wc.id,
        durationMs: Date.now() - startedAt,
        bytes: data.length,
      });
      return { mimeType: "image/jpeg", data };
    } catch (error) {
      this.log?.("warn", "browser.screenshot.native.failed", {
        webContentsId: wc.id,
        durationMs: Date.now() - startedAt,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  private async withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        promise,
        new Promise<T>((_resolve, reject) => {
          timer = setTimeout(() => reject(Object.assign(new Error(`${label} timed out`), {
            code: "SCREENSHOT_TIMEOUT",
          })), timeoutMs);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private async clickNode(
    wc: WebContents,
    target: { nodeId?: number; backendNodeId?: number },
    label: string,
  ): Promise<void> {
    await this.attach(wc);
    await this.command(wc, "DOM.scrollIntoViewIfNeeded", target);
    const model = (await this.command(wc, "DOM.getBoxModel", target)) as {
      model?: { content?: number[] };
    };
    const quad = model.model?.content;
    if (!Array.isArray(quad) || quad.length < 8) {
      throw Object.assign(new Error(`no box model for ${label}`), { code: "NOT_FOUND" });
    }
    const x = (quad[0] + quad[2] + quad[4] + quad[6]) / 4;
    const y = (quad[1] + quad[3] + quad[5] + quad[7]) / 4;
    await this.command(wc, "Input.dispatchMouseEvent", {
      type: "mousePressed",
      x,
      y,
      button: "left",
      clickCount: 1,
    });
    await this.command(wc, "Input.dispatchMouseEvent", {
      type: "mouseReleased",
      x,
      y,
      button: "left",
      clickCount: 1,
    });
  }

  async click(wc: WebContents, uid: string): Promise<void> {
    const backendNodeId = this.requireUid(uid);
    await this.clickNode(wc, { backendNodeId }, uid);
  }

  async clickSelector(wc: WebContents, selector: string): Promise<void> {
    const target = await this.querySelector(wc, selector);
    await this.clickNode(wc, { nodeId: target }, `selector ${JSON.stringify(selector)}`);
  }

  private async querySelector(wc: WebContents, selector: string): Promise<number> {
    const trimmed = selector.trim();
    if (!trimmed) {
      throw Object.assign(new Error("selector must not be empty"), { code: "INVALID_ARGUMENT" });
    }
    await this.attach(wc);
    const document = (await this.command(wc, "DOM.getDocument", { depth: 0 })) as {
      root?: { nodeId?: number };
    };
    const rootNodeId = document.root?.nodeId;
    if (typeof rootNodeId !== "number") {
      throw Object.assign(new Error("browser document is not ready"), { code: "UNAVAILABLE" });
    }
    try {
      const result = (await this.command(wc, "DOM.querySelector", {
        nodeId: rootNodeId,
        selector: trimmed,
      })) as { nodeId?: number };
      if (!result.nodeId) {
        throw Object.assign(new Error(`selector not found: ${trimmed}`), { code: "NOT_FOUND" });
      }
      return result.nodeId;
    } catch (error) {
      if (error && typeof error === "object" && "code" in error) throw error;
      throw Object.assign(new Error(`invalid selector: ${trimmed}`), {
        code: "INVALID_ARGUMENT",
        cause: error,
      });
    }
  }

  async fill(wc: WebContents, uid: string, text: string): Promise<void> {
    const backendNodeId = this.requireUid(uid);
    await this.fillNode(wc, { backendNodeId }, text, uid);
  }

  async fillSelector(wc: WebContents, selector: string, text: string): Promise<void> {
    const nodeId = await this.querySelector(wc, selector);
    await this.fillNode(wc, { nodeId }, text, `selector ${JSON.stringify(selector)}`);
  }

  private async fillNode(
    wc: WebContents,
    target: { nodeId?: number; backendNodeId?: number },
    text: string,
    label: string,
  ): Promise<void> {
    await this.attach(wc);
    const resolved = (await this.command(wc, "DOM.resolveNode", target)) as {
      object?: { objectId?: string };
    };
    const objectId = resolved.object?.objectId;
    if (!objectId) {
      throw Object.assign(new Error(`could not resolve ${label}`), { code: "NOT_FOUND" });
    }
    await this.command(wc, "Runtime.callFunctionOn", {
      objectId,
      functionDeclaration: `function (value) {
        this.focus();
        if ("value" in this) {
          this.value = value;
          this.dispatchEvent(new Event("input", { bubbles: true }));
          this.dispatchEvent(new Event("change", { bubbles: true }));
          return;
        }
        this.textContent = value;
        this.dispatchEvent(new Event("input", { bubbles: true }));
      }`,
      arguments: [{ value: text }],
    });
  }

  async evaluate(wc: WebContents, expression: string): Promise<unknown> {
    await this.attach(wc);
    const result = (await this.command(wc, "Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: true,
    })) as {
      result?: { value?: unknown; description?: string; type?: string };
      exceptionDetails?: { text?: string; exception?: { description?: string } };
    };
    if (result.exceptionDetails) {
      const message =
        result.exceptionDetails.exception?.description ||
        result.exceptionDetails.text ||
        "evaluation failed";
      throw Object.assign(new Error(message), { code: "TOOL_FAILED" });
    }
    const value = result.result?.value ?? result.result?.description ?? null;
    const serialized = JSON.stringify(value);
    if (serialized && serialized.length > MAX_EVALUATE_CHARS) {
      return {
        truncated: true,
        value: serialized.slice(0, MAX_EVALUATE_CHARS),
      };
    }
    return value;
  }

  console(limit = 50): BrowserConsoleMessage[] {
    const cap = Math.min(MAX_CONSOLE_MESSAGES, Math.max(1, Math.floor(limit) || 50));
    return this.messages.slice(-cap);
  }

  private requireUid(uid: string): number {
    const id = this.uids.get(uid.trim());
    if (typeof id !== "number") {
      throw Object.assign(
        new Error(`unknown or stale uid "${uid}"; call snapshot first`),
        { code: "INVALID_ARGUMENT" },
      );
    }
    return id;
  }
}
