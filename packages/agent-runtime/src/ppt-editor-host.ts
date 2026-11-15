import { randomUUID } from "node:crypto";
import type { PptEditorBinding } from "@pi-desktop/shared";
import { createPptEditorTools } from "./ppt-editor-tools.js";

type Host = { call<T>(method: string, params: unknown): Promise<T> };

/** Native operations use the existing Rust permission/audit and desktop-dispatch path. */
export function createAuthorizedPptEditorTools(host: Host, sessionId: string, binding: PptEditorBinding, getTurnId: () => string | undefined) {
  return createPptEditorTools({ binding, getContext: async () => { throw new Error("Tool invocation required"); }, execute: async () => { throw new Error("Tool invocation required"); } })
    .map((tool, index) => ({ ...tool,
      async execute(toolCallId: string, input: unknown, signal?: AbortSignal) {
        const call = async (toolName: string, args: unknown, context: boolean, signal?: AbortSignal): Promise<unknown> => {
          signal?.throwIfAborted();
          const turnId = getTurnId();
          if (!turnId) throw new Error("PPT tools require an active Chat turn");
          const id = context ? randomUUID() : toolCallId;
          const abort = () => { void host.call("tools.abort", { sessionId, toolCallId: id }).catch(() => undefined); };
          signal?.addEventListener("abort", abort, { once: true });
          try {
            const result = await host.call<{ ok: boolean; content: unknown; errorCode?: string }>("tools.execute", {
              sessionId, turnId, toolCallId: id, toolName, mode: "agent", args,
            });
            signal?.throwIfAborted();
            if (!result.ok) {
              const message = result.content && typeof result.content === "object" ? Reflect.get(result.content, "error") : result.content;
              throw new Error(`${result.errorCode ?? "PPT tool failed"}: ${String(message)}`);
            }
            return result.content;
          } finally { signal?.removeEventListener("abort", abort); }
        };
        const authorized = createPptEditorTools({ binding,
          getContext: (signal) => call("ppt_get_context", binding, true, signal),
          execute: (command, signal) => call(`ppt_${command.tool}`, command, false, signal),
        })[index]!;
        return authorized.execute(toolCallId, input, signal);
      },
    }));
}
