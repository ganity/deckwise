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

it("preserves bounded custom scene style in revision-checked requirements updates", async () => {
  const f = fixture();
  const update = f.tools.find(tool => tool.name === "courseware_requirements_update")!;
  const args = { expectedEducationContext: {}, educationContext: { visualStyle: "Matte clay 3D; no watercolor" } };
  await update.execute("style", args);
  expect(f.calls.at(-1)?.params).toMatchObject({ args });
  for (const visualStyle of [null, 3, "x".repeat(501)])
    await expect(update.execute("invalid", { ...args, educationContext: { visualStyle } })).rejects.toThrow("Invalid courseware");
});

it("validates boundaries before dispatch and requires a bounded compiler timeout", async () => {
  const f = fixture();
  for (const input of [{ sessionId: "other" }, { approve: true }])
    await expect(f.tools[0]!.execute("invalid", input)).rejects.toThrow("Invalid courseware");
  expect(f.calls).toHaveLength(0);
  f.turn(undefined);
  await expect(f.tools[0]!.execute("no-turn", {})).rejects.toThrow("active Chat turn");
  f.turn("turn-1");
  await f.tools.find(tool => tool.name === "courseware_scene_compile")!.execute("compile", { planSha256: "a".repeat(64) });
  expect(f.calls.at(-1)?.params).toMatchObject({ timeoutMs: 960_000 });
  const refresh = f.tools.find(tool => tool.name === "courseware_scene_image_refresh")!;
  await refresh.execute("resume-prepared", { intentId: "original", generatePrepared: true });
  expect(f.calls.at(-1)?.params).toMatchObject({ args: { intentId: "original", generatePrepared: true } });
  await refresh.execute("wait-original", { intentId: "original", waitForUpdate: true });
  expect(f.calls.at(-1)?.params).toMatchObject({ args: { intentId: "original", waitForUpdate: true } });
  await expect(refresh.execute("invalid-wait", { intentId: "original", waitForUpdate: "yes" })).rejects.toThrow("Invalid courseware");
  await expect(refresh.execute("invalid-resume", { intentId: "original", generatePrepared: "true" })).rejects.toThrow("Invalid courseware");
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


it("mounts saved-page tools without any Office binding and dispatches the complete range", async () => {
  const f = fixture();
  const context = f.tools.find(tool => tool.name === "courseware_narration_context")!;
  await context.execute("outline", {});
  const generate = f.tools.find(tool => tool.name === "courseware_narration_propose")!;
  const args = { pageNumbers: [1, 2, 56], sourceSha256: "a".repeat(64), instruction: "Explain each page" };
  await generate.execute("batch", args);
  expect(f.calls.at(-1)?.params).toMatchObject({ toolName: "courseware_narration_propose", args, timeoutMs: 960000 });
  for (const pageNumbers of [[], [0], [1, 1], [101]])
    await expect(generate.execute("invalid", { ...args, pageNumbers })).rejects.toThrow("Invalid courseware");
});


it("image preparation and recovery retain bounded transport and archive timeouts", async () => {
  const f = fixture();
  await f.tools.find(tool => tool.name === "courseware_scene_image_prepare")!.execute("prepare", {
    planSha256: "a".repeat(64), pageId: "scene-001", target: { kind: "visualMaster" },
  });
  expect(f.calls.at(-1)?.params).toMatchObject({ timeoutMs: 960_000 });
  await f.tools.find(tool => tool.name === "courseware_scene_image_refresh")!.execute("refresh", { intentId: "original" });
  expect(f.calls.at(-1)?.params).toMatchObject({ timeoutMs: 960_000 });
});

it("exposes finite saved media operations and retains the full-course authorization flag", async () => {
  const f = fixture();
  const compile = f.tools.find(tool => tool.name === "courseware_scene_compile")!;
  await compile.execute("complete-course", { planSha256: "a".repeat(64), continueTeaching: true });
  expect(f.calls.at(-1)?.params).toMatchObject({ args: { continueTeaching: true } });
  const context = f.tools.find(tool => tool.name === "courseware_media_context")!;
  await context.execute("tts-catalog", { kind: "tts" });
  const prepare = f.tools.find(tool => tool.name === "courseware_media_prepare")!;
  const args = { kind: "tts", sourceSha256: "a".repeat(64), pageNumber: 1, actionId: "speech-1", model: "teacher", voice: "voice" };
  await prepare.execute("tts", args);
  expect(f.calls.at(-1)?.params).toMatchObject({ args, timeoutMs: 960_000 });
  for (const extra of [{ path: "/tmp/audio" }, { kind: "video" }, { pageNumber: 0 }, { sourceSha256: "old" }])
    await expect(prepare.execute("invalid", { ...args, ...extra })).rejects.toThrow("Invalid courseware");
  await expect(compile.execute("invalid", { planSha256: "a".repeat(64), continueTeaching: "yes" })).rejects.toThrow("Invalid courseware");
});
