import { expect, it } from "vitest";
import { createCoursewareWorkflowTools } from "./courseware-workflow-tools.js";
import { COURSEWARE_WORKFLOW_TOOLS } from "@pi-desktop/shared";

function fixture() {
  let turn: string | undefined = "turn-1";
  let result = { ok: true, content: { generated: false } };
  const calls: Array<{ method: string; params: unknown }> = [];
  let after = () => {};
  const tools = createCoursewareWorkflowTools({ async call<T>(method: string, params: unknown): Promise<T> {
    calls.push({ method, params: structuredClone(params) }); after(); return result as T;
  } }, "chat-1", () => turn);
  return { tools, calls, turn: (value?: string) => { turn = value; }, after: (value: () => void) => { after = value; },
    result: (value: typeof result) => { result = value; } };
}

it("advertises only finite sequential actions and pins every call to the owning active turn", async () => {
  const f = fixture();
  expect(f.tools.map(tool => tool.name)).toEqual(COURSEWARE_WORKFLOW_TOOLS);
  expect(f.tools.every(tool => tool.executionMode === "sequential")).toBe(true);
  expect(f.tools.some(tool => /submit|approve|select|publish/.test(tool.name))).toBe(false);
  await f.tools[0]!.execute("read", {});
  expect(f.calls).toEqual([{ method: "tools.execute", params: { sessionId: "chat-1", turnId: "turn-1",
    toolCallId: "read", toolName: "courseware_workflow_get", mode: "agent", args: {} } }]);
});

it("validates boundaries before dispatch and requires a bounded compiler timeout", async () => {
  const f = fixture();
  for (const input of [{ sessionId: "other" }, { approve: true }])
    await expect(f.tools[0]!.execute("invalid", input)).rejects.toThrow("Invalid courseware");
  expect(f.calls).toHaveLength(0);
  f.turn(undefined);
  await expect(f.tools[0]!.execute("no-turn", {})).rejects.toThrow("active Chat turn");
  f.turn("turn-1");
  await f.tools.at(-1)!.execute("compile", { planSha256: "a".repeat(64) });
  expect(f.calls.at(-1)?.params).toMatchObject({ timeoutMs: 960_000 });
});

it("rejects late receipts, failed operations and cancellation instead of claiming completion", async () => {
  const f = fixture();
  f.after(() => f.turn("turn-2"));
  await expect(f.tools[0]!.execute("late", {})).rejects.toThrow("turn changed");
  f.after(() => {});
  f.result({ ok: false, content: { generated: false } });
  await expect(f.tools[0]!.execute("failure", {})).rejects.toThrow("COURSEWARE_WORKFLOW_FAILED");
  const controller = new AbortController(); controller.abort();
  const count = f.calls.length;
  await expect(f.tools[0]!.execute("abort", {}, controller.signal)).rejects.toThrow();
  expect(f.calls).toHaveLength(count);
});
