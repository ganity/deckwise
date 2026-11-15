import { setTimeout as delay } from "node:timers/promises";

type IpcListener = (event: { sender: { id: number } }, message: unknown) => void;

type IpcSource = {
  on(channel: string, listener: IpcListener): unknown;
  removeListener(channel: string, listener: IpcListener): unknown;
};

export const PPT_EDITOR_HANDSHAKE_TIMEOUT_MS = 60_000;
export const PPT_EDITOR_DOCUMENT_OPEN_TIMEOUT_MS = 180_000;

export class PptEditorNotReadyError extends Error {
  readonly code = "PPT_EDITOR_NOT_READY";
  readonly phase: "opening" | "saving" | "focus";
  constructor(phase: "opening" | "saving" | "focus") {
    super(phase === "focus"
      ? "Return to this courseware Chat to continue; the task is waiting without accessing the other Chat's document."
      : "PPT editor is still opening or saving; the saved courseware task is waiting for the editor to become ready.");
    this.name = "PptEditorNotReadyError";
    this.phase = phase;
  }
}

export async function waitForPptEditorTeachingReady(input: {
  ready(): boolean;
  phase(): "opening" | "saving" | "focus";
  check(): void;
  timeoutMs?: number;
  intervalMs?: number;
}): Promise<void> {
  const deadline = Date.now() + (input.timeoutMs ?? 15_000);
  while (true) {
    input.check();
    if (input.ready()) return;
    if (Date.now() >= deadline) throw new PptEditorNotReadyError(input.phase());
    await delay(Math.min(input.intervalMs ?? 100, Math.max(1, deadline - Date.now())));
  }
}

/** Register acknowledgement before dispatch and release it if dispatch fails. */
export async function openPptEditorDocument(ipcMain: IpcSource, senderId: number,
  commandId: string, dispatch: () => void, signal: AbortSignal,
  timeoutMs = PPT_EDITOR_DOCUMENT_OPEN_TIMEOUT_MS): Promise<void> {
  const abort = new AbortController();
  const pending = waitForPptEditorMessage(ipcMain, senderId, "document:opened", commandId,
    timeoutMs, AbortSignal.any([signal, abort.signal]));
  try {
    signal.throwIfAborted();
    dispatch();
    await pending;
  } catch (error) {
    abort.abort(error);
    await pending.catch(() => undefined);
    throw error;
  }
}

export function waitForPptEditorMessage(
  ipcMain: IpcSource,
  senderId: number,
  expectedType: "document:ready" | "document:opened",
  commandId: string | undefined,
  timeoutMs = PPT_EDITOR_HANDSHAKE_TIMEOUT_MS,
  signal?: AbortSignal,
): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      ipcMain.removeListener("deckwise-editor:event", listener);
      signal?.removeEventListener("abort", abort);
      if (error) reject(error);
      else resolve();
    };
    const listener: IpcListener = (event, envelope) => {
      if (event.sender.id !== senderId || !envelope || typeof envelope !== "object") return;
      const hostMessage = envelope as { type?: string; message?: unknown };
      if (hostMessage.type === "error") {
        finish(new Error(typeof hostMessage.message === "string" ? hostMessage.message : "Editor failed to load"));
        return;
      }
      if (hostMessage.type !== "message") return;
      const message = hostMessage.message;
      if (!message || typeof message !== "object") return;
      const payload = message as { type?: string; id?: string; payload?: { message?: string } };
      if (payload.type === "document:error") {
        if (commandId && payload.id !== commandId) return;
        finish(new Error(payload.payload?.message || "Editor could not open the document"));
        return;
      }
      if (payload.type !== expectedType) return;
      if (expectedType === "document:opened" && payload.id !== commandId) return;
      finish();
    };
    const timer = setTimeout(
      () => finish(new Error(`Editor timed out waiting for ${expectedType}`)),
      timeoutMs,
    );
    const abort = () => finish(signal?.reason instanceof Error && signal.reason.name !== "AbortError" ? signal.reason : new Error("Editor opening was cancelled"));
    ipcMain.on("deckwise-editor:event", listener);
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
  });
}
