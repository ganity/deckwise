import { describe, expect, it, vi } from "vitest";
import { createPptCandidateTools, registerPptCandidateTools, type PptCandidateContext, type PptCandidateReceipt, type PptCandidateToolHost } from "./ppt-candidate-tools.js";

const binding = { projectId: "project-b", documentId: "document-b", sessionId: "session-b" };
function setup() {
  let current: PptCandidateContext = {
    editor: { ...binding, kind: "slide", page: 2, selectedText: "", selectionCharacters: 0, readOnly: false, editGeneration: 7,
      capabilities: [{ name: "get_presentation_text", description: "Read", readOnly: true, inputSchema: {} }] },
    baseline: { ...binding, coursewareProjectId: "canonical-course-b", editGeneration: 7, pageId: "logical-page-b", sourceRevision: "R8", sourceSha256: "a".repeat(64), teachingRevision: "T8", contentSha256: "b".repeat(64) },
    clean: true, manualLocked: false, capabilities: ["page-pptx", "page-narration", "page-fade"],
  };
  const getContext = vi.fn(async (): Promise<unknown> => structuredClone(current));
  const propose = vi.fn(async (request: Parameters<PptCandidateToolHost["propose"]>[0]): Promise<unknown> => ({
    candidateId: "candidate-b", kind: request.kind, baseline: request.baseline, reviewState: "needs-review", applied: false,
    ...(request.kind === "page-narration" ? {} : { outputSha256: "c".repeat(64) }),
  } satisfies PptCandidateReceipt));
  const host = { binding, getContext, propose };
  return { host, tools: createPptCandidateTools(host), current: () => current, change: (patch: Partial<PptCandidateContext>) => { current = { ...current, ...patch }; } };
}
const args = { editGeneration: 7, instruction: "Redo this page only" };
describe("existing Chat candidate tools", () => {
  it("registers independent sequential proposal tools through the existing extension API", () => {
    const state = setup(); const registerTool = vi.fn();
    registerPptCandidateTools({ registerTool }, state.host);
    expect(registerTool.mock.calls.map(([tool]) => [tool.name, tool.executionMode])).toEqual([
      ["ppt_propose_page_redo", "sequential"], ["ppt_propose_page_narration", "sequential"], ["ppt_propose_page_fade", "sequential"], ["ppt_propose_page_style_batch", "sequential"],
    ]);
  });
  it.each([0, 1, 2])("returns only a bounded review receipt for tool %s without source paths/bytes or save/adoption claims", async (index) => {
    const state = setup();
    const input = index === 2 ? { editGeneration: 7 } : args;
    const result = await state.tools[index]!.execute("call", input);
    expect(result.details).toMatchObject({ candidateId: "candidate-b", baseline: state.current().baseline, applied: false, saved: false, reviewState: "needs-review" });
    expect(JSON.stringify(result.details).length).toBeLessThan(1200);
    if (index === 1) expect(result.details).toMatchObject({ audioReady: false });
    expect(state.host.propose.mock.calls[0]?.[0]).toEqual({ kind: state.current().capabilities[index], baseline: state.current().baseline, ...(index === 2 ? {} : { instruction: args.instruction }) });
  });
  it.each(["dirty", "readOnly", "lock", "capability", "generation", "document", "missingPage", "badSchema"])("refuses %s before generation", async (change) => {
    const state = setup(); const now = state.current();
    if (change === "dirty") state.change({ clean: false });
    if (change === "readOnly") state.change({ editor: { ...now.editor, readOnly: true } });
    if (change === "lock") state.change({ manualLocked: true });
    if (change === "capability") state.change({ capabilities: [] });
    if (change === "generation") state.change({ editor: { ...now.editor, editGeneration: 8 }, baseline: { ...now.baseline, editGeneration: 8 } });
    if (change === "document") state.change({ baseline: { ...now.baseline, documentId: "other" } });
    if (change === "missingPage") state.change({ editor: { ...now.editor, page: undefined } });
    if (change === "badSchema") state.host.getContext.mockResolvedValue({ ...now, baseline: { ...now.baseline, sourceRevision: 8 } });
    await expect(state.tools[0]!.execute("call", args)).rejects.toThrow();
    expect(state.host.propose).not.toHaveBeenCalled();
  });
  it.each(["sourceRevision", "sourceSha256", "teachingRevision", "coursewareProjectId", "pageId", "contentSha256", "editGeneration", "manualLock", "capability"])("rejects late %s changes", async (key) => {
    const state = setup();
    const first = structuredClone(state.current()); const next = structuredClone(first);
    if (key === "manualLock") next.manualLocked = true;
    else if (key === "capability") next.capabilities = [];
    else if (key === "editGeneration") { next.editor.editGeneration = 8; next.baseline.editGeneration = 8; }
    else Object.assign(next.baseline, { [key]: key.endsWith("Sha256") ? "d".repeat(64) : "changed" });
    state.host.getContext.mockResolvedValueOnce(first).mockResolvedValue(next);
    await expect(state.tools[0]!.execute("call", args)).rejects.toThrow();
    expect(state.host.propose).toHaveBeenCalledTimes(1);
  });
  it("rejects model-controlled identities, paths, code, unknown effect fields and empty instructions", async () => {
    const state = setup();
    for (const input of [{ ...args, pageId: "other" }, { ...args, sourcePptx: "bytes" }, { ...args, script: "code" }, { ...args, instruction: " " }]) {
      await expect(state.tools[0]!.execute("call", input)).rejects.toThrow("Invalid candidate tool input");
    }
    await expect(state.tools[2]!.execute("call", { editGeneration: 7, effect: "arbitrary" })).rejects.toThrow();
    expect(state.host.propose).not.toHaveBeenCalled();
  });
  it.each(["binding", "kind", "applied", "status", "hash", "payload", "candidateId"])("rejects invalid %s receipts", async (key) => {
    const state = setup();
    const raw = await state.host.propose({ kind: "page-pptx", baseline: state.current().baseline });
    const receipt = { ...(raw as PptCandidateReceipt) };
    if (key === "binding") receipt.baseline = { ...receipt.baseline, pageId: "other" };
    if (key === "kind") receipt.kind = "page-fade";
    if (key === "hash") receipt.outputSha256 = "invalid";
    if (key === "candidateId") receipt.candidateId = "../../candidate";
    if (key === "applied") Object.assign(receipt, { applied: true });
    if (key === "status") Object.assign(receipt, { reviewState: "ready" });
    if (key === "payload") Object.assign(receipt, { pptx: "binary must not enter transcript" });
    state.host.propose.mockResolvedValue(receipt);
    await expect(state.tools[0]!.execute("call", args)).rejects.toThrow();
  });
  it("propagates host save/model failure and cancellation without retries", async () => {
    const state = setup();
    state.host.getContext.mockRejectedValueOnce(new Error("Save in progress"));
    await expect(state.tools[0]!.execute("call", args)).rejects.toThrow("Save in progress");
    const early = new AbortController(); early.abort();
    await expect(state.tools[0]!.execute("call", args, early.signal)).rejects.toThrow();
    expect(state.host.propose).not.toHaveBeenCalled();
    state.host.propose.mockRejectedValueOnce(new Error("Model failed"));
    await expect(state.tools[0]!.execute("call", args)).rejects.toThrow("Model failed");
    const late = new AbortController();
    state.host.propose.mockImplementationOnce(async (request) => { late.abort(); return { candidateId: "pending", kind: request.kind, baseline: request.baseline, reviewState: "needs-review", applied: false, outputSha256: "c".repeat(64) }; });
    await expect(state.tools[0]!.execute("call", args, late.signal)).rejects.toThrow();
    expect(state.host.propose).toHaveBeenCalledTimes(2);
  });
  it("does not let a mutable host request change the expected baseline", async () => {
    const state = setup();
    state.host.propose.mockImplementationOnce(async (request) => {
      request.baseline.pageId = "other";
      return { candidateId: "bad", kind: request.kind, baseline: request.baseline, reviewState: "needs-review", applied: false, outputSha256: "c".repeat(64) };
    });
    await expect(state.tools[0]!.execute("call", args)).rejects.toThrow("mismatched");
  });
  it("captures validated receipt values before the asynchronous final context read", async () => {
    const state = setup();
    const receipt = await state.host.propose({ kind: "page-pptx", baseline: state.current().baseline });
    state.host.propose.mockResolvedValue(receipt);
    state.host.getContext.mockResolvedValueOnce(state.current()).mockImplementationOnce(async () => {
      Object.assign(receipt as object, { candidateId: "../../changed-after-validation" });
      return state.current();
    });
    expect((await state.tools[0]!.execute("call", args)).details).toMatchObject({ candidateId: "candidate-b" });
  });
  it.each([0, 1])("retains the validated instruction across context I/O for tool %s", async (index) => {
    const state = setup(); const input = { ...args };
    state.host.getContext.mockImplementationOnce(async () => {
      input.instruction = " ";
      return state.current();
    });
    await state.tools[index]!.execute("call", input);
    expect(state.host.propose.mock.calls[0]?.[0].instruction).toBe(args.instruction);
  });
  it.each([0, 1, 2])("does not substitute a later edit generation while reading tool %s context", async (index) => {
    const state = setup(); const input = index === 2 ? { editGeneration: 7 } : { ...args };
    const now = state.current();
    state.host.getContext.mockImplementationOnce(async () => {
      input.editGeneration = 8;
      state.change({ editor: { ...now.editor, editGeneration: 8 }, baseline: { ...now.baseline, editGeneration: 8 } });
      return state.current();
    });
    await expect(state.tools[index]!.execute("call", input)).rejects.toThrow("Editor context changed");
    expect(state.host.propose).not.toHaveBeenCalled();
  });
  it("retains the authorized proposal callback across context I/O", async () => {
    const state = setup(); const original = state.host.propose;
    const replacement = vi.fn(original.getMockImplementation()!);
    state.host.getContext.mockImplementationOnce(async () => {
      state.host.propose = replacement;
      return state.current();
    });
    await state.tools[0]!.execute("call", args);
    expect(original).toHaveBeenCalledTimes(1);
    expect(replacement).not.toHaveBeenCalled();
  });
  it.each(["clean", "manualLocked"] as const)("uses the original live reader to reject late %s changes", async (key) => {
    const state = setup(); const clean = structuredClone(state.current());
    const replacement = vi.fn(async (): Promise<unknown> => clean);
    state.host.propose.mockImplementationOnce(async (request) => {
      state.change(key === "clean" ? { clean: false } : { manualLocked: true });
      state.host.getContext = replacement;
      return { candidateId: "pending", kind: request.kind, baseline: request.baseline, reviewState: "needs-review", applied: false, outputSha256: "c".repeat(64) };
    });
    await expect(state.tools[0]!.execute("call", args)).rejects.toThrow("Candidate unavailable");
    expect(replacement).not.toHaveBeenCalled();
  });
  it("preserves the host receiver and original abort signal for both callbacks", async () => {
    const state = setup(); const signal = new AbortController().signal;
    const host: PptCandidateToolHost = {
      binding,
      async getContext(received) { expect(this).toBe(host); expect(received).toBe(signal); return state.current(); },
      async propose(request, received) { expect(this).toBe(host); expect(received).toBe(signal); return state.host.propose(request); },
    };
    expect((await createPptCandidateTools(host)[0]!.execute("call", args, signal)).details).toMatchObject({ applied: false, saved: false });
  });
});

function batchSetup() {
  const state = setup();
  const scope = { reviewId: "review-one", pageIds: [state.current().baseline.pageId, "peer-page"] };
  state.change({ capabilities: [...state.current().capabilities, "page-style-batch"], styleBatch: scope });
  state.host.propose.mockImplementation(async request => ({ candidateId: "batch-candidate", kind: request.kind,
    baseline: structuredClone(request.baseline), targetPageIds: [...scope.pageIds], outputSha256: "d".repeat(64), reviewState: "needs-review", applied: false }));
  return { ...state, scope, tool: state.tools.find(tool => tool.name === "ppt_propose_page_style_batch")! };
}

it("batch takes only generation, pins the confirmed scope and returns an unapplied bounded receipt", async () => {
  const state = batchSetup();
  const result = await state.tool.execute("batch", { editGeneration: 7 });
  expect(state.host.propose.mock.calls[0]?.[0]).toEqual({ kind: "page-style-batch", baseline: state.current().baseline, styleBatch: state.scope });
  expect(result.details).toMatchObject({ targetPageIds: state.scope.pageIds, kind: "page-style-batch", saved: false, applied: false });
  for (const field of ["instruction", "pageIds", "styleBatch", "approved", "path"]) {
    await expect(state.tool.execute("forged", { editGeneration: 7, [field]: "untrusted" })).rejects.toThrow("Invalid candidate tool input");
  }
  expect(state.host.propose).toHaveBeenCalledTimes(1);
});

it.each(["missing", "duplicate", "foreign", "oversized", "extra", "capability", "unsafeId"])("refuses malformed confirmed batch scope: %s", async change => {
  const state = batchSetup();
  const current = structuredClone(state.current());
  if (change === "missing") delete current.styleBatch;
  if (change === "duplicate") current.styleBatch!.pageIds = [current.baseline.pageId, current.baseline.pageId];
  if (change === "foreign") current.styleBatch!.pageIds = ["foreign", "peer"];
  if (change === "oversized") current.styleBatch!.pageIds = [current.baseline.pageId, ...Array.from({ length: 20 }, (_, i) => `page-${i}`)];
  if (change === "extra") Object.assign(current.styleBatch!, { instruction: "Changed" });
  if (change === "capability") current.capabilities = ["page-fade"];
  if (change === "unsafeId") current.styleBatch!.reviewId = "../review";
  state.host.getContext.mockResolvedValue(current);
  await expect(state.tool.execute("batch", { editGeneration: 7 })).rejects.toThrow("confirmed style scope");
  expect(state.host.propose).not.toHaveBeenCalled();
});

it.each(["scope", "review", "receipt", "mutation"])("rejects late batch %s changes without retry or adoption", async change => {
  const state = batchSetup();
  if (change === "scope" || change === "review") {
    state.host.getContext.mockResolvedValueOnce(structuredClone(state.current())).mockImplementationOnce(async () => ({ ...state.current(),
      styleBatch: { ...state.scope, ...(change === "scope" ? { pageIds: [state.scope.pageIds[0], "new-peer"] } : { reviewId: "new-review" }) } }));
  } else {
    state.host.propose.mockImplementationOnce(async request => {
      if (change === "mutation") request.styleBatch!.pageIds[1] = "injected";
      return { candidateId: "batch", kind: "page-style-batch", baseline: request.baseline,
        targetPageIds: change === "receipt" ? [...state.scope.pageIds].reverse() : request.styleBatch!.pageIds,
        outputSha256: "d".repeat(64), reviewState: "needs-review", applied: false };
    });
  }
  await expect(state.tool.execute("batch", { editGeneration: 7 })).rejects.toThrow();
  expect(state.host.propose).toHaveBeenCalledTimes(1);
});
