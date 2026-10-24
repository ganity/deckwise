export const COURSEWARE_STYLE_BATCH_TIMEOUT_MS = 1_800_000;
export const DEFAULT_RPC_TIMEOUT_MS = 130_000;
export const PERMISSION_TIMEOUT_MS = 120_000;
export const DEFAULT_COMMAND_TIMEOUT_MS = 60_000;
export const COMMAND_RPC_BUFFER_MS = 10_000;
export const DEFAULT_BASH_RPC_TIMEOUT_MS =
  PERMISSION_TIMEOUT_MS + DEFAULT_COMMAND_TIMEOUT_MS + COMMAND_RPC_BUFFER_MS;
const MAX_TIMER_DELAY_MS = 2_147_483_647;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Return the transport deadline for an RPC call. Bash includes the permission
 * wait, the effective command timeout, and transport slack. The finite style-batch
 * tool includes the same margins with a bounded batch execution budget. Every call has a
 * finite deadline so a lost response cannot leave a pending promise forever.
 */
export function rpcTimeoutMs(
  method: string,
  params: unknown,
): number {
  if (method !== "tools.execute") return DEFAULT_RPC_TIMEOUT_MS;

  const input = isRecord(params) ? params : undefined;
  if (input?.toolName === "ppt_propose_page_style_batch") {
    const requested = input.timeoutMs;
    const execution = typeof requested === "number" && Number.isFinite(requested) && requested > 0
      ? Math.min(COURSEWARE_STYLE_BATCH_TIMEOUT_MS, Math.ceil(requested)) : COURSEWARE_STYLE_BATCH_TIMEOUT_MS;
    return PERMISSION_TIMEOUT_MS + execution + COMMAND_RPC_BUFFER_MS;
  }
  if (input?.toolName !== "Bash") return DEFAULT_RPC_TIMEOUT_MS;
  if (input?.timeoutMs === undefined) return DEFAULT_BASH_RPC_TIMEOUT_MS;

  const commandTimeoutMs = input.timeoutMs;
  if (
    typeof commandTimeoutMs !== "number" ||
    !Number.isFinite(commandTimeoutMs) ||
    commandTimeoutMs <= 0
  ) {
    return DEFAULT_BASH_RPC_TIMEOUT_MS;
  }

  return Math.min(
    MAX_TIMER_DELAY_MS,
    PERMISSION_TIMEOUT_MS + Math.ceil(commandTimeoutMs) + COMMAND_RPC_BUFFER_MS,
  );
}
