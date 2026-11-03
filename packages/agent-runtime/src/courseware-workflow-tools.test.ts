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
  expect(f.tools.some(tool => /approve|select|publish/.test(tool.name))).toBe(false);
  await f.tools[0]!.execute("read", {});
  expect(f.calls).toEqual([{ method: "tools.execute", params: { sessionId: "chat-1", turnId: "turn-1",
    toolCallId: "read", toolName: "courseware_workflow_get", mode: "agent", args: {} } }]);
});

it("accepts explicit retry flags only on a single original refresh", async () => {
  const f = fixture();
  const image = f.tools.find(tool => tool.name === "courseware_scene_image_refresh")!;
  const media = f.tools.find(tool => tool.name === "courseware_media_refresh")!;
  await image.execute("retry-image", { intentId: "failed-original", retryFailed: true });
  const args = { kind: "tts", sourceSha256: "a".repeat(64), pageNumber: 1, intentId: "failed-original", retryFailed: true };
  await media.execute("retry-audio", args);
  expect(f.calls.at(-1)?.params).toMatchObject({ args });
  await expect(image.execute("invalid", { intentId: "original", retryFailed: "yes" })).rejects.toThrow();
  await expect(media.execute("invalid", { kind: "tts", sourceSha256: "a".repeat(64), pageNumber: 1, intentIds: ["original"], retryFailed: true })).rejects.toThrow();
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
  expect(f.calls.at(-1)?.params).toMatchObject({ timeoutMs: 960_000 });
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
  const { actionId, ...batch } = args;
  await prepare.execute("tts-batch", { ...batch, actionIds: [actionId, "speech-2"] });
  expect(f.calls.at(-1)?.params).toMatchObject({ args: { ...batch, actionIds: [actionId, "speech-2"] }, timeoutMs: 960_000 });
  for (const actionIds of [[], [actionId, actionId], Array(101).fill(actionId), ["../foreign"]])
    await expect(prepare.execute("invalid-batch", { ...batch, actionIds })).rejects.toThrow("Invalid courseware");
  await expect(prepare.execute("ambiguous-batch", { ...args, actionIds: [actionId] })).rejects.toThrow("Invalid courseware");
  const refresh = f.tools.find(tool => tool.name === "courseware_media_refresh")!;
  const recovery = { kind: "tts", sourceSha256: args.sourceSha256, pageNumber: 1, intentIds: ["original-one", "original-two"] };
  await refresh.execute("recover-batch", recovery);
  expect(f.calls.at(-1)?.params).toMatchObject({ args: recovery, timeoutMs: 960_000 });
  for (const extra of [{ intentIds: [] }, { intentIds: ["one", "one"] }, { intentIds: Array(101).fill("one") },
    { intentId: "one" }, { kind: "music" }, { intentIds: ["../foreign"] }])
    await expect(refresh.execute("invalid-recovery", { ...recovery, ...extra })).rejects.toThrow("Invalid courseware");
  await expect(compile.execute("invalid", { planSha256: "a".repeat(64), continueTeaching: "yes" })).rejects.toThrow("Invalid courseware");
});


it("preserves kind-specific media validation with object-root provider schemas", async () => {
  const f = fixture();
  const prepare = f.tools.find(tool => tool.name === "courseware_media_prepare")!;
  const common = { sourceSha256: "a".repeat(64), pageNumber: 1, model: "fixture" };
  for (const args of [
    { ...common, kind: "video", actionId: "video-1" },
    { ...common, kind: "tts", actionId: "speech-1", voice: null },
    { ...common, kind: "music", prompt: "Hello song", music: { title: "Hello", instrumental: true } },
  ]) await prepare.execute("valid", args);
  expect(f.calls).toHaveLength(3);
  for (const args of [
    { ...common, kind: "video" },
    { ...common, kind: "tts" },
    { ...common, kind: "music", prompt: "Hello" },
    { ...common, kind: "music", prompt: "Hello", music: { title: "" } },
    { ...common, kind: "video", actionId: "video-1", voice: "tts-only" },
    { ...common, kind: "tts", actionId: "speech-1", voice: "invalid voice" },
  ]) await expect(prepare.execute("invalid", args)).rejects.toThrow("Invalid courseware");
  expect(f.calls).toHaveLength(3);
});


it("keeps an explicit transient code across the Main error envelope", async () => {
  const tools = createCoursewareWorkflowTools({ async call<T>(): Promise<T> {
    return { ok: false, errorCode: "COURSEWARE_WORKFLOW_REJECTED", content: { error: "COURSEWARE_MEDIA_TRANSPORT_FAILED" } } as T;
  } }, "chat", () => "turn");
  const context = tools.find(tool => tool.name === "courseware_media_context")!;
  await expect(context.execute("read", {})).rejects.toMatchObject({ code: "COURSEWARE_MEDIA_TRANSPORT_FAILED" });
});

it("bounds full-deck media text while retaining complete internal evidence and page-scoped reads", async () => {
  const content = { sourceSha256: "a".repeat(64), jobs: [], completion: { ready: true },
    pages: Array.from({ length: 10 }, (_, i) => ({ pageNumber: i + 1, narrationReady: true, audioReady: true,
      actions: [{ type: "speech", text: "x".repeat(32000) }], speeches: [{ actionId: `speech-${i}`, text: "x".repeat(32000), audioReady: true }] })),
    approvedPlan: { pages: [{ narration: "x".repeat(32000) }] } };
  const tools = createCoursewareWorkflowTools({ async call<T>(): Promise<T> { return { ok: true, content } as T; } }, "chat", () => "turn");
  const media = await tools.find(t => t.name === "courseware_media_context")!.execute("read", {});
  expect(JSON.stringify(media.content).length).toBeLessThan(10000);
  expect(media.details).toEqual(content);
  const page = await tools.find(t => t.name === "courseware_narration_context")!.execute("page", { pageNumbers: [1] });
  expect(page.details).toEqual(content);
  expect(JSON.stringify(page.content)).toContain("x".repeat(32000));
});

it("exposes whole-scene continuation only through an explicit boolean on the selected cover refresh", async () => {
  const f = fixture();
  const refresh = f.tools.find(tool => tool.name === "courseware_scene_image_refresh")!;
  await refresh.execute("pipeline", { intentId: "selected-cover", generateRemaining: true });
  expect(f.calls.at(-1)?.params).toMatchObject({ args: { intentId: "selected-cover", generateRemaining: true }, timeoutMs: 960_000 });
  await expect(refresh.execute("invalid", { intentId: "selected-cover", generateRemaining: "true" })).rejects.toThrow("Invalid courseware");
  expect(refresh.description).toContain("five each");
});
