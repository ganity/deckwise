import { expect, it, vi } from "vitest";
import { createAuthorizedMediaCanvasTools } from "./courseware-media-canvas-tools.js";

type View = {
  projectId: string; revision: string | null;
  document: null | { version: number; projectId: string; revision: number; viewport: { x: number; y: number; zoom: number };
    drafts: { id: string; revision: number; kind: string; title: string; prompt: string; references: { assetId: string; revision: string; label: string }[]; x: number; y: number }[] };
};
const initial = (): View => ({ projectId: "course", revision: "opaque-canvas-1", document: {
  version: 1, projectId: "course", revision: 9, viewport: { x: 4, y: 8, zoom: 1 }, drafts: [
    { id: "image-one", revision: 3, kind: "image", title: "A picture", prompt: "An old prompt", references: [], x: 100, y: 200 },
    { id: "music-two", revision: 1, kind: "music", title: "Music", prompt: "A tune", references: [], x: 300, y: 400 },
  ],
} });
const input = () => ({ draftId: "image-one", expectedRevision: 3, patch: { prompt: "A new prompt", references: [{ assetId: "ref-1", revision: "asset-v2", label: "Reference" }] } });

function setup() {
  let current = initial(); let turn: string | undefined = "turn-one";
  const events: { method: string; params: Record<string, unknown> }[] = [];
  const call = vi.fn(async (method: string, params: unknown): Promise<unknown> => {
    const args = params as Record<string, unknown>;
    events.push({ method, params: structuredClone(args) });
    if (method === "tools.abort") return undefined;
    if (method !== "tools.execute") throw new Error("Unexpected direct RPC");
    if (args.toolName === "courseware_canvas_edit") {
      const edit = args.args as { expectedRevision: string; draftId: string; expectedDraftRevision: number; patch: object };
      if (edit.expectedRevision !== current.revision) return { ok: false, errorCode: "COURSEWARE_CONFLICT", content: { error: "Canvas changed" } };
      const document = structuredClone(current.document!);
      const draft = document.drafts.find(item => item.id === edit.draftId)!;
      Object.assign(draft, edit.patch); draft.revision += 1; document.revision += 1;
      current = { ...current, revision: "opaque-canvas-2", document };
    }
    return { ok: true, content: structuredClone(current) };
  });
  const host = { async call<T>(method: string, params: unknown): Promise<T> { return await call(method, params) as T; } };
  const tools = createAuthorizedMediaCanvasTools(host, "chat-session", () => turn);
  return { tools, get: tools[0]!, edit: tools[1]!, call, events,
    current: () => current, set: (view: View) => { current = view; }, turn: (next: string | undefined) => { turn = next; } };
}

it("offers two sequential tools and reads through active-turn authorization without network or PPT operations", async () => {
  const state = setup(); const fetch = vi.spyOn(globalThis, "fetch");
  try {
    expect(state.tools.map(tool => [tool.name, tool.executionMode])).toEqual([["courseware_canvas_get", "sequential"], ["courseware_canvas_edit", "sequential"]]);
    const result = await state.get.execute("read-call", {});
    expect(result.details).toEqual(initial());
    expect(JSON.parse(result.content[0]!.type === "text" ? result.content[0]!.text : "null")).toEqual(initial());
    expect(state.events).toEqual([{ method: "tools.execute", params: {
      sessionId: "chat-session", turnId: "turn-one", toolCallId: "read-call", toolName: "courseware_canvas_get", mode: "agent", args: {},
    } }]);
    expect(fetch).not.toHaveBeenCalled();
  } finally { fetch.mockRestore(); }
});

it("pins fresh canvas CAS internally, edits only one draft and returns the actual saved document", async () => {
  const state = setup(); const request = input();
  const result = await state.edit.execute("edit-call", request);
  expect(state.events.map(event => event.params.toolName)).toEqual(["courseware_canvas_get", "courseware_canvas_edit"]);
  expect(state.events[0]!.params.toolCallId).not.toBe("edit-call");
  expect(state.events[1]).toEqual({ method: "tools.execute", params: {
    sessionId: "chat-session", turnId: "turn-one", toolCallId: "edit-call", toolName: "courseware_canvas_edit", mode: "agent",
    args: { expectedRevision: "opaque-canvas-1", draftId: "image-one", expectedDraftRevision: 3, patch: request.patch },
  } });
  expect(result.details).toEqual(state.current());
  expect(state.current().document!.drafts[0]).toMatchObject({ revision: 4, prompt: "A new prompt", x: 100, y: 200 });
  expect(state.current().document!.drafts[1]).toEqual(initial().document!.drafts[1]);
  expect(state.current().document!.revision).toBe(10);
  expect(result.details).not.toHaveProperty("generated");
  expect(result.details).not.toHaveProperty("pptx");
});

it.each(["revision", "missing", "empty"])("refuses %s draft state without dispatching an edit", async reason => {
  const state = setup(); const current = initial();
  if (reason === "revision") current.document!.drafts[0]!.revision += 1;
  if (reason === "missing") current.document!.drafts.shift();
  if (reason === "empty") { current.revision = null; current.document = null; }
  state.set(current);
  await expect(state.edit.execute("edit", input())).rejects.toThrow("changed or is missing");
  expect(state.events.map(event => event.params.toolName)).toEqual(["courseware_canvas_get"]);
});

it.each([
  { ...input(), projectId: "foreign" }, { ...input(), sessionId: "foreign" }, { ...input(), path: "/tmp/other" },
  { ...input(), expectedRevision: "opaque" }, { ...input(), expectedRevision: -1 },
  { ...input(), patch: {} }, { ...input(), patch: { generate: true } },
  { ...input(), patch: { title: " " } }, { ...input(), patch: { title: "x".repeat(161) } },
  { ...input(), patch: { prompt: "x".repeat(16_001) } }, { ...input(), patch: { references: null } },
  { ...input(), patch: { references: [{ assetId: "asset", revision: "1", label: " " }] } },
  { ...input(), patch: { references: Array.from({ length: 17 }, (_, i) => ({ assetId: `ref-${i}`, revision: "1", label: "Ref" })) } },
])("rejects model-controlled authority or malformed finite patches before Host I/O: %j", async invalid => {
  const state = setup();
  await expect(state.edit.execute("bad", invalid)).rejects.toThrow("Invalid media canvas tool input");
  expect(state.call).not.toHaveBeenCalled();
});

it("rejects duplicate reference IDs and foreign get arguments before Host I/O, but permits clearing prompt/references", async () => {
  const state = setup(); const ref = { assetId: "one", revision: "1", label: "Reference" };
  await expect(state.edit.execute("bad", { ...input(), patch: { references: [ref, ref] } })).rejects.toThrow("Duplicate");
  await expect(state.get.execute("bad", { projectId: "foreign" })).rejects.toThrow("Invalid");
  expect(state.call).not.toHaveBeenCalled();
  expect((await state.edit.execute("clear", { ...input(), patch: { prompt: "", references: [] } })).details).toMatchObject({ document: { drafts: [{ id: "image-one", prompt: "" }, expect.any(Object)] } });
});

it("pins the original model input before context I/O", async () => {
  const state = setup(); const request = input(); const original = state.call.getMockImplementation()!;
  state.call.mockImplementationOnce(async (method, params) => {
    request.patch.prompt = "Injected later"; request.expectedRevision = 99;
    return original(method, params);
  });
  await state.edit.execute("edit", request);
  expect(state.events[1]!.params.args).toMatchObject({ expectedDraftRevision: 3, patch: { prompt: "A new prompt" } });
});

it.each(["missing", "during-read", "during-write"])("refuses %s Chat turn without crossing owner boundaries or replaying", async point => {
  const state = setup(); const original = state.call.getMockImplementation()!;
  if (point === "missing") state.turn(undefined);
  else state.call.mockImplementation(async (method, params) => {
    const result = await original(method, params);
    if ((params as Record<string, unknown>).toolName === (point === "during-read" ? "courseware_canvas_get" : "courseware_canvas_edit")) state.turn("other-turn");
    return result;
  });
  await expect(state.edit.execute("edit", input())).rejects.toThrow(point === "missing" ? "active Chat turn" : "Chat turn changed");
  expect(state.events).toHaveLength(point === "missing" ? 0 : point === "during-read" ? 1 : 2);
});

it.each(["read", "write"])("aborts the exact in-flight %s dispatch and rejects late output", async point => {
  const state = setup(); const controller = new AbortController(); const original = state.call.getMockImplementation()!;
  state.call.mockImplementation(async (method, params) => {
    const args = params as Record<string, unknown>;
    if (method === "tools.execute" && args.toolName === (point === "read" ? "courseware_canvas_get" : "courseware_canvas_edit")) controller.abort();
    return original(method, params);
  });
  await expect(state.edit.execute("edit", input(), controller.signal)).rejects.toThrow();
  const aborts = state.events.filter(event => event.method === "tools.abort");
  expect(aborts).toHaveLength(1);
  const dispatch = state.events.find(event => event.params.toolName === (point === "read" ? "courseware_canvas_get" : "courseware_canvas_edit"))!;
  expect(aborts[0]!.params).toEqual({ sessionId: "chat-session", toolCallId: dispatch.params.toolCallId });
  expect(state.events.filter(event => event.params.toolName === "courseware_canvas_edit")).toHaveLength(point === "write" ? 1 : 0);
});

it("does not dispatch an already-aborted call and removes abort listeners after completion", async () => {
  const state = setup(); const early = new AbortController(); early.abort();
  await expect(state.get.execute("early", {}, early.signal)).rejects.toThrow();
  expect(state.events).toHaveLength(0);
  const late = new AbortController(); await state.edit.execute("edit", input(), late.signal); late.abort();
  expect(state.events.filter(event => event.method === "tools.abort")).toHaveLength(0);
});

it.each(["get", "edit"])("propagates %s Host refusal without retries or invented success", async point => {
  const state = setup(); const original = state.call.getMockImplementation()!;
  state.call.mockImplementation(async (method, params) => {
    const name = (params as Record<string, unknown>).toolName;
    if (name === `courseware_canvas_${point}`) return { ok: false, errorCode: "COURSEWARE_CONFLICT", content: { error: "Changed elsewhere" } };
    return original(method, params);
  });
  await expect(state.edit.execute("edit", input())).rejects.toThrow("COURSEWARE_CONFLICT: Changed elsewhere");
  expect(state.call).toHaveBeenCalledTimes(point === "get" ? 1 : 2);
});

it.each(["project", "duplicate", "path", "null", "nan"])("rejects malformed %s Host views", async reason => {
  const state = setup(); const current = initial();
  if (reason === "project") current.document!.projectId = "other";
  if (reason === "duplicate") current.document!.drafts.push(structuredClone(current.document!.drafts[0]!));
  if (reason === "path") Object.assign(current, { path: "/private/path" });
  if (reason === "null") current.revision = null;
  if (reason === "nan") current.document!.viewport.x = Number.NaN;
  state.set(current);
  await expect(state.get.execute("read", {})).rejects.toThrow("Invalid media canvas response");
});

it("rejects an edit result changing an unrelated draft instead of claiming success", async () => {
  const state = setup(); const original = state.call.getMockImplementation()!;
  state.call.mockImplementation(async (method, params) => {
    const result = await original(method, params) as { ok: boolean; content: View };
    if ((params as Record<string, unknown>).toolName === "courseware_canvas_edit") result.content.document!.drafts[1]!.prompt = "Unexpected peer write";
    return result;
  });
  await expect(state.edit.execute("edit", input())).rejects.toThrow("Mismatched media canvas edit result");
  expect(state.call).toHaveBeenCalledTimes(2);
});
