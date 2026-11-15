import type { CoursewarePptxCandidateReview, UiMessage } from "@pi-desktop/shared";
import { toolResultPayload } from "./tool-presentation";

type Kind = CoursewarePptxCandidateReview["kind"] | "page-narration";
const toolKinds: Record<string, Kind> = {
  courseware_narration_propose: "page-narration",
  ppt_propose_page_narration: "page-narration", ppt_propose_page_redo: "page-pptx",
  ppt_propose_page_fade: "page-fade", ppt_propose_page_style_batch: "page-style-batch",
};

/** Receipts expose entrances only; Main still reads and validates saved candidates. */
export function chatCandidateReceipts(messages: UiMessage[]): Array<{ candidateId: string; kind: Kind; pageNumber?: number }> {
  const candidates = new Map<string, { candidateId: string; kind: Kind; pageNumber?: number }>();
  for (const message of [...messages].reverse()) {
    if (message.role !== "tool" || !message.toolName || !Object.hasOwn(toolKinds, message.toolName) ||
        message.toolStatus !== "success" || message.isError || message.parentToolCallId) continue;
    try {
      const kind = toolKinds[message.toolName];
      const raw = toolResultPayload(message);
      const payload = typeof raw === "string" ? JSON.parse(raw) : raw;
      const results = message.toolName === "courseware_narration_propose" && Array.isArray(payload?.candidates) ? payload.candidates : [payload];
      for (const result of results) {
      if (result?.kind === kind && result.reviewState === "needs-review" && result.applied === false && result.saved === false &&
          typeof result.baseline?.sessionId === "string" && /^[\w.-]{1,128}$/u.test(result.baseline.sessionId) &&
          typeof result.candidateId === "string" && /^[\w.-]{1,128}$/u.test(result.candidateId) &&
          (kind === "page-narration" || (typeof result.outputSha256 === "string" && /^[a-f\d]{64}$/iu.test(result.outputSha256))) &&
          !candidates.has(result.candidateId)) candidates.set(result.candidateId, { candidateId: result.candidateId, kind, ...(Number.isInteger(result.pageNumber) && result.pageNumber > 0 ? { pageNumber: result.pageNumber } : {}) });
      }
    } catch { /* Incomplete or malformed tool output is not a candidate entrance. */ }
  }
  return [...candidates.values()];
}
