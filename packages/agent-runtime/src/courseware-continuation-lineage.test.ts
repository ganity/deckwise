import { expect, it } from "vitest";
import type { AgentTurnContext, AgentToolResult } from "@earendil-works/pi-agent-core";
import type { CoursewareWorkflowCheckpoint } from "@pi-desktop/shared";
import { CoursewareTurnContinuation } from "./courseware-turn-continuation.js";

it.each([true, false])("checkpoints adoption before native updates and preserves the source fence (verified=%s)", async verified => {
  const continuation = new CoursewareTurnContinuation();
  let source = "a".repeat(64), ready = false;
  const state: { checkpoint: CoursewareWorkflowCheckpoint | null } = { checkpoint: null };
  const completion = () => ({ sourceSha256: source, teachingRevision: "T1", ready, issues: [] });
  const controls = {
    canWait: () => true,
    execute: async (name: string): Promise<AgentToolResult<unknown>> => {
      expect(name).toBe("courseware_media_context");
      return { content: [], details: { projectId: "project", sourceSha256: source, teachingRevision: "T1", jobs: [],
        narrationReady: ready, audioReady: ready, teachingReady: ready, assessmentMedia: { ready }, completion: completion() } };
    },
    checkpoints: {
      read: async () => ({ checkpoint: state.checkpoint, completion: completion() }),
      write: async (next: CoursewareWorkflowCheckpoint, expected: number) => {
        expect(expected).toBe(state.checkpoint?.revision ?? 0);
        expect(next.sourceSha256).toBe(source);
        state.checkpoint = next;
      },
    },
  };
  const turn = (toolUse: boolean): AgentTurnContext => ({ context: { messages: [] }, newMessages: [], message: {
    role: "assistant", content: toolUse ? [{ type: "toolCall", id: "adopt", name: "courseware_presentation_adopt", arguments: { continueTeaching: true } }] : [{ type: "text", text: "Exported" }],
    stopReason: toolUse ? "toolUse" : "stop", timestamp: 0, api: "openai-completions", provider: "fixture", model: "fixture",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
  }, toolResults: toolUse ? [{ role: "toolResult", timestamp: 0, toolName: "courseware_presentation_adopt", toolCallId: "adopt", isError: false, content: [], details: { generated: true, sourceSha256: source, projectId: "project" } }] : [] });
  await continuation.finish(turn(true), controls);
  expect(state.checkpoint).toMatchObject({ status: "running", sourceSha256: source });
  // Host native-save transactions rebind existing checkpoints, never arbitrary external edits.
  source = "b".repeat(64); ready = true;
  if (verified && state.checkpoint) state.checkpoint = { ...state.checkpoint, sourceSha256: source, revision: state.checkpoint.revision + 1 };
  if (verified) {
    await expect(continuation.finish(turn(false), controls)).resolves.toContain("checks are complete");
    expect(state.checkpoint).toMatchObject({ status: "completed", sourceSha256: source });
  } else {
    await expect(continuation.finish(turn(false), controls)).resolves.toContain("COURSEWARE_CONFLICT");
    expect(state.checkpoint).toMatchObject({ status: "running", sourceSha256: "a".repeat(64) });
  }
});

it("continues native generated files across verified saves without opening a legacy database project", async () => {
  const continuation = new CoursewareTurnContinuation();
  let source = "a".repeat(64), ready = false;
  const execute = async (): Promise<AgentToolResult<unknown>> => ({ content: [], details: {
    nativeTeaching: true, projectId: "native", sourceSha256: source, teachingRevision: source, jobs: [],
    narrationReady: true, audioReady: ready, teachingReady: ready, assessmentMedia: { ready },
    completion: { sourceSha256: source, teachingRevision: source, ready, issues: ready ? [] : [{ code: "AUDIO_MISSING", repairable: true, pageNumber: 1 }] },
  } });
  const controls = { canWait: () => true, execute, checkpoints: {
    read: async (): Promise<never> => { throw new Error("Unexpected legacy project read"); },
    write: async (): Promise<never> => { throw new Error("Unexpected legacy checkpoint write"); },
  } };
  const message = { role: "assistant" as const, content: [], stopReason: "stop" as const, timestamp: 0, api: "openai-completions" as const,
    provider: "fixture", model: "fixture", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
  const adopted: AgentTurnContext = { context: { messages: [] }, newMessages: [], message: { ...message, stopReason: "toolUse",
    content: [{ type: "toolCall", id: "adopt-native", name: "courseware_presentation_adopt", arguments: {} }] }, toolResults: [
    { role: "toolResult", timestamp: 0, toolName: "courseware_presentation_adopt", toolCallId: "adopt-native", isError: false, content: [], details: { generated: true, sourceSha256: source } },
  ] };
  await continuation.finish(adopted, controls);
  source = "b".repeat(64); ready = true;
  expect(await continuation.finish({ ...adopted, message, toolResults: [] }, controls)).toContain("checks are complete");
});
