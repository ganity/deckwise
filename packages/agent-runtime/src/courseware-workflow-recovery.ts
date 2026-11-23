const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object";

export class CoursewareWorkflowError extends Error {
  constructor(readonly code: string, message: string, readonly operation?: string, options?: ErrorOptions) {
    super(message, options); this.name = "CoursewareWorkflowError";
  }
}

/** Construct only from local schema diagnostics, never from Host/provider payloads. */
export class CoursewareInputError extends CoursewareWorkflowError {
  constructor(operation: string, readonly inputHint: string) {
    super("COURSEWARE_INVALID", `Invalid courseware workflow input (${operation}): ${inputHint}`, operation);
  }
}

const inputHints: Record<string, string> = {
  PRESENTATION_TEACHING_MISMATCH: "Read the saved plan and native teaching fields on the reported page. Keep the exported PPTX and artwork.",
  PRESENTATION_VISUAL_DEFECT: "Correct only the reported visual defect on the affected page before adoption, then validate the export.",
  PRESENTATION_REVIEW_UNAVAILABLE: "Keep the export and resume visual acceptance of the same PPTX when the review service is available.",
  PRESENTATION_REGISTRATION_FAILED: "Read the saved workflow to confirm registration. Retain the export and resume from its last verified state.",
  COURSEWARE_SCENE_MASTER_REJECTED: "Inspect this page's archived master and reported visual defects before decomposition. Preserve its original order.",
  COURSEWARE_SCENE_MASTER_REVIEW_UNAVAILABLE: "Retry visual acceptance on the archived original master for this page before decomposition. Keep its image order.",
  COURSEWARE_ASSESSMENT_CONTEXT_STALE: "Read courseware_media_assessments(mode:context) and use its current project and revisions for the requested operation.",
  COURSEWARE_ASSESSMENT_REVISION_CHANGED: "Read courseware_media_assessments(mode:context) and refresh the original question audio using its key and current revisions.",
  COURSEWARE_ASSESSMENT_TARGET_CHANGED: "The question, target or voice changed. Keep the original audio order and compare the current assessment before requesting new audio.",
  COURSEWARE_ASSESSMENT_READ_ONLY: "The assessment is read-only. Keep the original order until the target can be saved.",
  COURSEWARE_INVALID: "Read the tool schema, correct only the invalid fields and use current context identities.",
  INVALID_PARAMS: "Read the tool schema and correct the invalid fields before trying again.",
  COURSEWARE_SCENE_IMAGE_INVALID_REQUEST: "Read courseware_workflow_get. Use a current body pageId and approved planSha256. Omit model to use the configured catalog. The desktop resolves the image reference. Do not shorten the image prompt to repair an identity error.",
  COURSEWARE_INVALID_REFERENCE: "Read the approved plan and current selected page master. The desktop supplies the image reference automatically.",
  COURSEWARE_INVALID_REFRESH: "Use intentId and generateRemaining:true alone. For one original job use waitForUpdate:true; generatePrepared and retryFailed cannot both be true. retryFailed requires explicit user authorization.",
  COURSEWARE_SOURCE_CHANGED: "Read courseware_narration_context again. sourceSha256 is the saved PPTX hash, not a material sourceId or planSha256. Reconcile current pages before writing; preserve saved speech and original media.",
  COURSEWARE_INVALID_ASSESSMENT_SCOPE: "Read courseware_media_assessments with mode:context. Configure only sceneIds from configurableQuizSceneIds; body and interactive pages are not Quiz pages.",
};

const operationHints: Record<string, string> = {
  courseware_media_context: "The media status check failed. Read the saved media context and original job status before continuing.",
  courseware_scene_generate_remaining: "Read courseware_workflow_get and inspect the confirmed cover and original job receipts before continuing.",
  courseware_scene_image_refresh: "Read courseware_workflow_get and query the original image intent for this page. Preserve its last confirmed state.",
  courseware_media_prepare: "Read courseware_media_context for the current source hash, missing targets, models and original jobs. For missing speech use kind:tts, sourceSha256, pageNumber, actionIds and model from the saved context. Refresh pending orders first.",
  courseware_media_refresh: "Read courseware_media_context for the target page and refresh its original order.",
  courseware_media_assessments: "Call courseware_media_assessments with {\"mode\":\"context\"} to read current targets, revisions and original jobs before choosing the required operation.",
  courseware_narration_propose: "Read saved narration and page diagnostics before editing the unfinished speech or effects.",
  courseware_presentation_adopt: "Read saved registration and acceptance of the exported PPTX before continuing.",
};
export function coursewareOperationHint(operation?: string) {
  return operation && Object.hasOwn(operationHints, operation) ? operationHints[operation] : undefined;
}

/** Only local schema diagnostics may supplement static hints; provider payloads stay private. */
export function coursewareInputHint(error: unknown): string | undefined {
  if (!(error instanceof CoursewareWorkflowError) || !Object.hasOwn(inputHints, error.code)) return;
  let cause: unknown = error;
  for (let depth = 0; depth < 4 && cause instanceof CoursewareWorkflowError && cause.code === error.code; depth++, cause = cause.cause)
    if (cause instanceof CoursewareInputError) return `${cause.inputHint}. ${inputHints[error.code]}`;
  // Retain bounded local identifiers across continuation wrappers. Raw provider payloads stay private.
  let at: unknown = error;
  for (let depth = 0; depth < 4 && at instanceof CoursewareWorkflowError && at.code === error.code; depth++, at = at.cause) {
    const page = /\bPage (\d{1,3})\b/iu.exec(at.message)?.[1];
    const scene = /\bscene-\d{3}\b/u.exec(at.message)?.[0];
    if (error.code.startsWith("PRESENTATION_") && page) {
      const field = /\b(Interaction question text|Interaction response|Interaction guidance|Quiz reference answer|Quiz answer|Existing interaction question reading|Generated media requirement|Generated media prompt|Generated narration) differs from plan|\b(Quiz questions missing|Quiz page is incomplete|Expected one interaction checkpoint)\b/u.exec(at.message)?.[0];
      return `Page ${page}${field ? " (" + field + ")" : ""}. ${inputHints[error.code]}`;
    }
    if (error.code.startsWith("COURSEWARE_SCENE_MASTER_") && scene) return `${scene}. ${inputHints[error.code]}`;
  }
  return inputHints[error.code];
}

/** Retry only explicit transient codes; unknown paid outcomes never authorize a replacement. */
export function coursewareFailureRecovery(error: unknown): "retry-read" | "query-original" | "repair-input" | "cancelled" | "blocked" {
  let cause = error;
  for (let depth = 0; depth < 4 && record(cause); depth++) {
    const code = typeof cause.code === "string" ? cause.code : typeof cause.errorCode === "string" ? cause.errorCode :
      typeof cause.message === "string" ? /^([A-Z][A-Z0-9_]+)(?::|$)/u.exec(cause.message)?.[1] : undefined;
    if (["TASK_STATUS_UNAVAILABLE", "COURSEWARE_MEDIA_TRANSPORT_FAILED", "HOST_OVERLOADED", "ECONNRESET", "ETIMEDOUT", "RATE_LIMITED", "SERVICE_UNAVAILABLE",
      "PPT_EDITOR_NOT_READY", "PPT_EDITOR_SAVE_IN_PROGRESS"].includes(code ?? "")) return "retry-read";
    if (["COURSEWARE_MEDIA_GENERATION_STATUS_UNKNOWN", "COURSEWARE_SUBMISSION_UNKNOWN"].includes(code ?? "")) return "query-original";
    if (code === "PRESENTATION_REVIEW_UNAVAILABLE" || code === "COURSEWARE_SCENE_MASTER_REVIEW_UNAVAILABLE") return "retry-read";
    if (code === "PRESENTATION_REGISTRATION_FAILED") return "query-original";
    if (code === "COURSEWARE_ASSESSMENT_READ_ONLY") return "blocked";
    if (Object.hasOwn(inputHints, code ?? "")) return "repair-input";
    if (["TOOL_TURN_CANCELLED", "COURSEWARE_MEDIA_WAIT_CANCELLED", "ABORT_ERR"].includes(code ?? "") || cause.name === "AbortError") return "cancelled";
    cause = cause.cause;
  }
  return "blocked";
}
