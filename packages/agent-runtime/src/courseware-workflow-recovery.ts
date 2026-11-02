const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object";

export class CoursewareWorkflowError extends Error {
  constructor(readonly code: string, message: string) { super(message); this.name = "CoursewareWorkflowError"; }
}

/** Retry only explicit transient codes; unknown paid outcomes never authorize a replacement. */
export function coursewareFailureRecovery(error: unknown): "retry-read" | "query-original" | "repair-input" | "cancelled" | "blocked" {
  let cause = error;
  for (let depth = 0; depth < 4 && record(cause); depth++) {
    const code = typeof cause.code === "string" ? cause.code : typeof cause.errorCode === "string" ? cause.errorCode :
      typeof cause.message === "string" ? /^([A-Z][A-Z0-9_]+)(?::|$)/u.exec(cause.message)?.[1] : undefined;
    if (["TASK_STATUS_UNAVAILABLE", "COURSEWARE_MEDIA_TRANSPORT_FAILED", "HOST_OVERLOADED", "ECONNRESET", "ETIMEDOUT", "RATE_LIMITED", "SERVICE_UNAVAILABLE"].includes(code ?? "")) return "retry-read";
    if (["COURSEWARE_MEDIA_GENERATION_STATUS_UNKNOWN", "COURSEWARE_SUBMISSION_UNKNOWN"].includes(code ?? "")) return "query-original";
    if (["INVALID_PARAMS", "COURSEWARE_INVALID"].includes(code ?? "")) return "repair-input";
    if (["TOOL_TURN_CANCELLED", "COURSEWARE_MEDIA_WAIT_CANCELLED", "ABORT_ERR"].includes(code ?? "") || cause.name === "AbortError") return "cancelled";
    cause = cause.cause;
  }
  return "blocked";
}
