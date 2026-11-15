import { randomUUID } from "node:crypto";
import { COURSEWARE_STYLE_BATCH_TIMEOUT_MS, type PptEditorBinding } from "@pi-desktop/shared";
import { createPptCandidateTools } from "./ppt-candidate-tools.js";

type Host = { call<T>(method: string, params: unknown): Promise<T> };

/** Main owns reviewed inputs; Rust owns proposal permission and audit. */
export function createAuthorizedPptCandidateTools(host: Host, sessionId: string, binding: PptEditorBinding, getTurnId: () => string | undefined) {
  const unavailable = async (): Promise<never> => { throw new Error("Tool invocation required"); };
  return createPptCandidateTools({ binding, getContext: unavailable, propose: unavailable })
    .map((tool) => ({ ...tool,
      async execute(toolCallId: string, input: unknown, signal?: AbortSignal) {
        const call = async (name: string, args: unknown, id: string) => {
          signal?.throwIfAborted();
          const turnId = getTurnId();
          if (!turnId) throw new Error("Candidate generation requires an active Chat turn");
          const abort = () => { void host.call("tools.abort", { sessionId, toolCallId: id }).catch(() => undefined); };
          signal?.addEventListener("abort", abort, { once: true });
          try {
            const result = await host.call<{ ok: boolean; content: unknown; errorCode?: string }>("tools.execute", { sessionId, turnId, toolCallId: id, toolName: name, mode: "agent", args, timeoutMs: name === "ppt_propose_page_style_batch" ? COURSEWARE_STYLE_BATCH_TIMEOUT_MS : 240_000 });
            signal?.throwIfAborted();
            if (!result.ok) throw new Error(`${result.errorCode ?? "Candidate generation failed"}: ${String(result.content && typeof result.content === "object" ? Reflect.get(result.content, "error") : result.content)}`);
            return result.content;
          } finally { signal?.removeEventListener("abort", abort); }
        };
        const authorized = createPptCandidateTools({ binding,
          getContext: () => call("ppt_get_narration_context", binding, randomUUID()),
          propose: (request) => call(tool.name, request, toolCallId),
        }).find((candidate) => candidate.name === tool.name)!;
        return authorized.execute(toolCallId, input, signal);
      },
    }));
}
