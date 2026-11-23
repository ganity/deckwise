import type { UiMessage } from "@pi-desktop/shared";
import type { TFunction } from "i18next";

const coursewareTool = (name: unknown): name is string => typeof name === "string" && /^courseware_[a-z0-9_]+$/.test(name);

/** A stale courseware error disables its action. Other chats keep their usual continuation. */
export function coursewareErrorContinuation(message: UiMessage, messages: UiMessage[], t: TFunction): string | null | undefined {
  const error = message.error;
  if (!error) return;
  let last = messages.length - 1;
  while (last >= 0 && messages[last].role === "system") last--;
  const current = messages[last]?.id === message.id;
  const details = error.details && typeof error.details === "object" ? error.details as Record<string, unknown> : undefined;
  if (error.code === "TOOL_ARGUMENT_RETRY_EXHAUSTED" && coursewareTool(details?.toolName)) {
    if (!current) return null;
    const tool = details.toolName;
    const context = tool === "courseware_media_assessments" ? 'courseware_media_assessments({"mode":"context"})'
      : tool === "courseware_media_prepare" || tool === "courseware_media_refresh" ? "courseware_media_context"
      : "courseware_workflow_get";
    // Send schema field names without forwarding rejected values or provider text.
    const fields = new Set<string>();
    if (typeof details.issues === "string") {
      for (const line of details.issues.split("\n")) {
        const field = /^- ([A-Za-z][A-Za-z0-9_.]*):/.exec(line)?.[1];
        if (field && field !== "root") fields.add(field);
      }
    }
    return t("coursewareWorkflow.resumeInvalidTool", { tool, context, fields: fields.size ? ` (${[...fields].join(", ")})` : "" });
  }
  if (!error.code.startsWith("PROVIDER_") && error.code !== "NETWORK_ERROR") return;
  const index = current ? last : messages.findIndex(m => m.id === message.id);
  for (let i = index - 1; i >= 0 && messages[i].role !== "user"; i--) {
    const previous = messages[i];
    if (previous.role !== "tool" || previous.parentToolCallId) continue;
    const args = previous.toolArgs;
    const tool = previous.toolName === "ToolSearch" && args && typeof args === "object" && "query" in args ? args.query : previous.toolName;
    if (coursewareTool(tool)) {
      if (!current) return null;
      const status = details?.providerStatus;
      return t("coursewareWorkflow.resumeProvider", { tool, error: Number.isInteger(status) ? `${error.code} (HTTP ${status})` : error.code });
    }
    return;
  }
}
