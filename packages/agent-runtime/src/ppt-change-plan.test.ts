import { expect, it } from "vitest";
import { createPptChangePlanTool } from "./ppt-change-plan.js";

const binding = { projectId: "native", documentId: "document", sessionId: "editor" };
const baseline = { ...binding, editGeneration: 1, coursewareProjectId: "course", pageId: "page", sourceRevision: "R1",
  teachingRevision: "T1", sourceSha256: "a".repeat(64), contentSha256: "b".repeat(64) };
const context = { editor: { ...binding, kind: "slide", page: 1, selectedText: "", selectionCharacters: 0,
  readOnly: false, editGeneration: 1, capabilities: [] }, baseline, clean: true, manualLocked: false, capabilities: ["page-narration"] };
const input = { editGeneration: 1, changes: [{ label: "Change page", toolName: "ppt_add_slide_text" },
  { label: "Change narration", toolName: "ppt_propose_page_narration" }] };

it("records a current-page checklist through authorized context and Host metadata only", async () => {
  const calls: Record<string, unknown>[] = [];
  const host = { async call<T>(_method: string, params: unknown): Promise<T> {
    const p = params as Record<string, unknown>; calls.push(p);
    return { ok: true, content: p.toolName === "ppt_get_narration_context" ? context : {
      changeGroupId: "group-1", pageId: "page", pageNumber: 1, expectedCount: 2, recorded: true, applied: false,
    } } as T;
  } };
  const result = await createPptChangePlanTool(host, "chat", binding, () => "turn").execute("plan-call", input);
  expect(calls.map(call => call.toolName)).toEqual(["ppt_get_narration_context", "ppt_record_change_plan"]);
  expect(calls[1]).toMatchObject({ sessionId: "chat", turnId: "turn", toolCallId: "plan-call", mode: "agent",
    args: { baseline, pageNumber: 1, changes: input.changes } });
  expect(result.details).toMatchObject({ expectedCount: 2, recorded: true, applied: false });
});

it("refuses unknown inputs, stale generations, locked pages and changed turns before recording", async () => {
  const calls: Record<string, unknown>[] = [];
  let turn: string | undefined = "turn";
  let current: unknown = context;
  const host = { async call<T>(_method: string, params: unknown): Promise<T> {
    calls.push(params as Record<string, unknown>); return { ok: true, content: current } as T;
  } };
  const tool = createPptChangePlanTool(host, "chat", binding, () => turn);
  for (const value of [{ ...input, path: "/file" }, { ...input, changes: [] }, { ...input, changes: [{ label: "Run", toolName: "ppt_execute_js" }] },
    { ...input, changes: [{ ...input.changes[0], label: "x".repeat(201) }] }]) await expect(tool.execute("plan", value)).rejects.toThrow();
  expect(calls).toHaveLength(0);
  for (const value of [{ ...context, clean: false }, { ...context, manualLocked: true },
    { ...context, baseline: { ...baseline, editGeneration: 2 } }]) {
    current = value; await expect(tool.execute("plan", input)).rejects.toThrow();
  }
  expect(calls.every(call => call.toolName === "ppt_get_narration_context")).toBe(true);
  turn = undefined; await expect(tool.execute("plan", input)).rejects.toThrow("active Chat turn");
});

it("copies planned items before awaited context and aborts the exact Host call", async () => {
  const local = structuredClone(input); const controller = new AbortController();
  const calls: { method: string; params: Record<string, unknown> }[] = [];
  const host = { async call<T>(method: string, params: unknown): Promise<T> {
    const p = params as Record<string, unknown>; calls.push({ method, params: p });
    if (method === "tools.abort") return undefined as T;
    if (p.toolName === "ppt_get_narration_context") {
      local.changes[0].label = "changed during await";
      return { ok: true, content: context } as T;
    }
    expect(p).toMatchObject({ args: { changes: input.changes } });
    controller.abort(); return { ok: true, content: {} } as T;
  } };
  await expect(createPptChangePlanTool(host, "chat", binding, () => "turn").execute("plan-call", local, controller.signal)).rejects.toThrow();
  expect(calls.at(-1)).toEqual({ method: "tools.abort", params: { sessionId: "chat", toolCallId: "plan-call" } });
});
