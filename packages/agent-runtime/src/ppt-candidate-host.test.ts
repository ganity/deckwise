import { expect, it } from "vitest";
import { createAuthorizedPptCandidateTools } from "./ppt-candidate-host.js";

const binding = { projectId: "native", documentId: "document", sessionId: "editor" };
const baseline = { ...binding, editGeneration: 1, coursewareProjectId: "course", pageId: "page", sourceRevision: "R1", teachingRevision: "T1", sourceSha256: "a".repeat(64), contentSha256: "b".repeat(64) };
const context = { editor: { ...binding, kind: "slide", page: 1, selectedText: "", selectionCharacters: 0, readOnly: false, editGeneration: 1, capabilities: [] }, baseline, clean: true, manualLocked: false, capabilities: ["page-narration", "page-fade"] };

it("offers four proposal tools and routes narration through the same active-turn permission path", async () => {
  const calls: { method: string; params: Record<string, unknown> }[] = [];
  const host = { async call<T>(method: string, params: unknown): Promise<T> {
    const p = params as Record<string, unknown>;
    calls.push({ method, params: p });
    return { ok: true, content: p.toolName === "ppt_get_narration_context" ? context : { kind: "page-narration", baseline, teachingRevision: "T2", pageNumber: 1, saved: true, applied: true, audioReady: false } } as T;
  } };
  const tools = createAuthorizedPptCandidateTools(host, "chat", binding, () => "turn");
  expect(tools.map((tool) => tool.name)).toEqual(["ppt_propose_page_redo", "ppt_propose_page_narration", "ppt_propose_page_fade", "ppt_propose_page_style_batch"]);
  const result = await tools.find(tool => tool.name === "ppt_propose_page_narration")!.execute("proposal", { editGeneration: 1, instruction: "Rewrite" });
  expect(result.details).toMatchObject({ saved: true, audioReady: false, applied: true });
  expect(calls.map(({ method, params }) => [method, params.toolName, params.sessionId, params.turnId, params.mode])).toEqual([
    ["tools.execute", "ppt_get_narration_context", "chat", "turn", "agent"],
    ["tools.execute", "ppt_propose_page_narration", "chat", "turn", "agent"],
  ]);
  expect(calls[1]!.params.toolCallId).toBe("proposal");
  expect(calls[0]!.params.args).toEqual(binding);
  expect(calls[0]!.params.toolCallId).not.toBe("proposal");
  await expect(createAuthorizedPptCandidateTools(host, "chat", binding, () => undefined)[1]!.execute("call", { editGeneration: 1, instruction: "Rewrite" })).rejects.toThrow("active Chat turn");
  expect(calls).toHaveLength(2);
});

it("redo requires an approved capability and uses the authorized active-turn path without adopting", async () => {
  const calls: Record<string, unknown>[] = [];
  let approved = false;
  const host = { async call<T>(_method: string, params: unknown): Promise<T> {
    const p = params as Record<string, unknown>; calls.push(p);
    return { ok: true, content: p.toolName === "ppt_get_narration_context"
      ? { ...context, capabilities: approved ? [...context.capabilities, "page-pptx"] : context.capabilities }
      : { candidateId: "redo", kind: "page-pptx", baseline, outputSha256: "d".repeat(64), reviewState: "needs-review", applied: false } } as T;
  } };
  const tool = createAuthorizedPptCandidateTools(host, "chat", binding, () => "turn").find(tool => tool.name === "ppt_propose_page_redo")!;
  await expect(tool.execute("unapproved", { editGeneration: 1, instruction: "Rebuild" })).rejects.toThrow("capability unavailable");
  expect(calls.map(call => call.toolName)).toEqual(["ppt_get_narration_context"]);
  approved = true; calls.length = 0;
  const result = await tool.execute("redo-call", { editGeneration: 1, instruction: "Rebuild" });
  expect(calls.map(call => call.toolName)).toEqual(["ppt_get_narration_context", "ppt_propose_page_redo", "ppt_get_narration_context"]);
  expect(calls[1]).toMatchObject({ toolCallId: "redo-call", args: { kind: "page-pptx", baseline, instruction: "Rebuild" } });
  expect(result.details).toMatchObject({ candidateId: "redo", kind: "page-pptx", outputSha256: "d".repeat(64), saved: false, applied: false });
});

it("cancels the exact in-flight Host call and refuses its late result", async () => {
  const controller = new AbortController();
  const aborted: unknown[] = [];
  const host = { async call<T>(method: string, params: unknown): Promise<T> {
    if (method === "tools.abort") { aborted.push(params); return undefined as T; }
    controller.abort();
    return { ok: true, content: context } as T;
  } };
  const tool = createAuthorizedPptCandidateTools(host, "chat", binding, () => "turn")[0]!;
  await expect(tool.execute("proposal", { editGeneration: 1, instruction: "Rewrite" }, controller.signal)).rejects.toThrow();
  expect(aborted).toHaveLength(1);
  expect(aborted[0]).toMatchObject({ sessionId: "chat", toolCallId: expect.any(String) });
});

it("routes fade through authorized context/proposal/context and retains the output hash without applying", async () => {
  const calls: Record<string, unknown>[] = [];
  const host = { async call<T>(_method: string, params: unknown): Promise<T> {
    const p = params as Record<string, unknown>; calls.push(p);
    return { ok: true, content: p.toolName === "ppt_get_narration_context" ? context : {
      candidateId: "fade", kind: "page-fade", baseline, outputSha256: "c".repeat(64), reviewState: "needs-review", applied: false,
    } } as T;
  } };
  const tool = createAuthorizedPptCandidateTools(host, "chat", binding, () => "turn").find(tool => tool.name === "ppt_propose_page_fade")!;
  const result = await tool.execute("fade-call", { editGeneration: 1 });
  expect(calls.map(call => call.toolName)).toEqual(["ppt_get_narration_context", "ppt_propose_page_fade", "ppt_get_narration_context"]);
  expect(calls[1]).toMatchObject({ toolCallId: "fade-call", args: { kind: "page-fade", baseline } });
  expect(result.details).toMatchObject({ kind: "page-fade", outputSha256: "c".repeat(64), saved: false, applied: false });
});

it("batch uses only the trusted context scope and the same permission path with a bounded long timeout", async () => {
  const calls: Record<string, unknown>[] = [];
  const scope = { reviewId: "style-review", pageIds: [baseline.pageId, "peer"] };
  const host = { async call<T>(_method: string, input: unknown): Promise<T> {
    const p = input as Record<string, unknown>; calls.push(p);
    return { ok: true, content: p.toolName === "ppt_get_narration_context" ? { ...context, capabilities: ["page-style-batch"], styleBatch: scope } : {
      candidateId: "batch", kind: "page-style-batch", baseline, targetPageIds: scope.pageIds,
      outputSha256: "c".repeat(64), reviewState: "needs-review", applied: false,
    } } as T;
  } };
  const tool = createAuthorizedPptCandidateTools(host, "chat", binding, () => "turn").find(t => t.name === "ppt_propose_page_style_batch")!;
  expect((await tool.execute("batch-call", { editGeneration: 1 })).details).toMatchObject({ targetPageIds: scope.pageIds, applied: false });
  expect(calls.map(c => c.toolName)).toEqual(["ppt_get_narration_context", "ppt_propose_page_style_batch", "ppt_get_narration_context"]);
  expect(calls[1]).toMatchObject({ toolCallId: "batch-call", timeoutMs: 1_800_000, args: { kind: "page-style-batch", baseline, styleBatch: scope } });
  expect(calls[0]!.timeoutMs).toBe(240_000);
});
