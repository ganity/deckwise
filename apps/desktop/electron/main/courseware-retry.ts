import { createHash } from "node:crypto";

// One durable successor per original makes repeated delivery of a retry idempotent.
export const coursewareRetryIntentId = (intentId: string) => `retry-${createHash("sha256").update(intentId).digest("hex")}`;

export function currentCoursewareAttempts<T extends { intentId: string }>(rows: T[]): T[] {
  const ids = new Set(rows.map(row => row.intentId));
  return rows.filter(row => !ids.has(coursewareRetryIntentId(row.intentId)));
}

export function assertCoursewareRetryable(task: { state: string; feeState: string; actualPoints: number | null } | null | undefined): void {
  if (!task || !["failed", "cancelled", "archive_failed"].includes(task.state) ||
      !["released", "settled"].includes(task.feeState) || !Number.isSafeInteger(task.actualPoints) ||
      Number(task.actualPoints) < 0 || task.feeState === "released" && task.actualPoints !== 0)
    throw new Error("COURSEWARE_RETRY_REQUIRES_CONFIRMED_TERMINAL_FAILURE");
}
