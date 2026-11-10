type Listener = (event: { sender: { id: number } }, envelope: unknown) => void;
type IpcSource = {
  on(channel: string, listener: Listener): unknown;
  removeListener(channel: string, listener: Listener): unknown;
};

export function requestPptEditor(
  ipc: IpcSource,
  senderId: number,
  requestId: string,
  responseType: "document:native-teaching-result" | "document:context" | "document:command-result" | "document:page-preview" | "document:image-target-reviewed",
  send: () => void,
  signal: AbortSignal,
  timeoutMs = 30_000,
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error?: Error, payload?: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      ipc.removeListener("deckwise-editor:event", listener);
      signal.removeEventListener("abort", abort);
      if (error) reject(error);
      else resolve(payload);
    };
    const listener: Listener = (event, envelope) => {
      if (event.sender.id !== senderId || !envelope || typeof envelope !== "object") return;
      const host = envelope as { type?: string; message?: unknown };
      if (host.type === "error") {
        finish(new Error("Editor host failed; read fresh context before retrying"));
        return;
      }
      if (host.type !== "message" || !host.message || typeof host.message !== "object") return;
      const message = host.message as { id?: string; type?: string; payload?: unknown };
      if (message.id !== requestId) return;
      if (message.type === "document:error") {
        const payload = message.payload as { message?: unknown } | undefined;
        finish(new Error(typeof payload?.message === "string" ? payload.message : "Editor command failed"));
      } else if (message.type === responseType) finish(undefined, message.payload);
    };
    const abort = () => finish(new Error("Editor session was closed"));
    const timer = setTimeout(() => finish(new Error("Editor request timed out; read fresh context before retrying")), timeoutMs);
    ipc.on("deckwise-editor:event", listener);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    else {
      try { send(); } catch (error) { finish(error instanceof Error ? error : new Error(String(error))); }
    }
  });
}
