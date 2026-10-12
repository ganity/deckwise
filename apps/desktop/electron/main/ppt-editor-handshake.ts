type IpcListener = (event: { sender: { id: number } }, message: unknown) => void;

type IpcSource = {
  on(channel: string, listener: IpcListener): unknown;
  removeListener(channel: string, listener: IpcListener): unknown;
};

export const PPT_EDITOR_HANDSHAKE_TIMEOUT_MS = 60_000;

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
