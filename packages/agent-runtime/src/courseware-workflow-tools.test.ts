import { expect, it } from "vitest";
import { createCoursewareWorkflowTools } from "./courseware-workflow-tools.js";
import { Check } from "typebox/value";
import { COURSEWARE_WORKFLOW_TOOLS } from "@pi-desktop/shared";
import { CoursewareWorkflowError, coursewareInputHint } from "./courseware-workflow-recovery.js";
import { classifyAgentError } from "./agent-errors.js";

it("retains safe editor focus diagnostics through Host tool and continuation wrapping", async () => {
  const tools = createCoursewareWorkflowTools({ async call<T>(): Promise<T> {
    return { ok: false, errorCode: "PPT_EDITOR_NOT_READY", content: { error: "private path", phase: "focus" } } as T;
  } }, "chat", () => "turn");
  const tool = tools.find(t => t.name === "courseware_media_context")!;
  const failure = await tool.execute("read", {}).catch(error => error);
  expect(failure).toBeInstanceOf(CoursewareWorkflowError);
  const classified = classifyAgentError(new CoursewareWorkflowError(failure.code, "continuation", "courseware_media_context", { cause: failure }));
  expect(classified).toMatchObject({ code: "PPT_EDITOR_NOT_READY", retriable: true,
    details: { editorPhase: "focus" }, message: expect.stringMatching(/Return to this courseware Chat/) });
  expect(JSON.stringify(classified)).not.toContain("private path");
});

it.each([
  ["PRESENTATION_TEACHING_MISMATCH: Page 2: Interaction guidance differs from plan", "PRESENTATION_TEACHING_MISMATCH", /Page 2.*Interaction guidance.*artwork/],
  ["PRESENTATION_REGISTRATION_FAILED: no acknowledgement", "PRESENTATION_REGISTRATION_FAILED", /confirm registration/],
  ["PRESENTATION_REVIEW_UNAVAILABLE: Page 3: timeout", "PRESENTATION_REVIEW_UNAVAILABLE", /Page 3.*same PPTX/],
  ["PRESENTATION_VISUAL_DEFECT: Page 4: example", "PRESENTATION_VISUAL_DEFECT", /Page 4.*visual defect/],
  ["COURSEWARE_SCENE_MASTER_REVIEW_UNAVAILABLE (scene-002): service unavailable", "COURSEWARE_SCENE_MASTER_REVIEW_UNAVAILABLE", /scene-002.*original master/],
  ["COURSEWARE_SCENE_MASTER_REJECTED (scene-003): incorrect label", "COURSEWARE_SCENE_MASTER_REJECTED", /scene-003.*reported visual defects/],
] as const)("preserves safe diagnostic context across a host rejection %s", async (message, code, expected) => {
  const tools = createCoursewareWorkflowTools({ async call<T>() {
    return { ok: false, errorCode: "COURSEWARE_WORKFLOW_REJECTED", content: { error: message + " private payload" } } as T;
  } }, "chat", () => "turn");
  const read = tools.find(t => t.name === "courseware_workflow_get")!;
  const cause = await read.execute("read", {}).catch(error => error);
  const classified = classifyAgentError(new CoursewareWorkflowError(cause.code, "continuation", read.name, { cause }));
  expect(classified.code).toBe(code);
  expect(classified.message).toMatch(expected);
  expect(JSON.stringify(classified)).not.toContain("private payload");
});

function fixture(userRequests?: () => string) {
  let turn: string | undefined = "turn-1";
  let result = { ok: true, content: { generated: false } };
  const calls: Array<{ method: string; params: unknown }> = [];
  let after = () => {};
  const tools = createCoursewareWorkflowTools({ async call<T>(method: string, params: unknown): Promise<T> {
    calls.push({ method, params: structuredClone(params) }); after(); return result as T;
  } }, "chat-1", () => turn, userRequests);
  return { tools, calls, turn: (value?: string) => { turn = value; }, after: (value: () => void) => { after = value; },
    result: (value: typeof result) => { result = value; } };
}

it("returns schema-owned field hints before dispatch without echoing rejected input", async () => {
  const f = fixture();
  const requirements = f.tools.find(tool => tool.name === "courseware_requirements_update")!;
  const bounded = await requirements.execute("limit", { expectedEducationContext: {},
    educationContext: { bodyPageLimit: 31 } }).catch(error => error);
  expect(bounded).toMatchObject({ code: "COURSEWARE_INVALID", operation: "courseware_requirements_update" });
  expect(bounded.message).toContain("/educationContext/bodyPageLimit must be <= 30");

  const story = f.tools.find(tool => tool.name === "courseware_story_save")!;
  const missing = await story.execute("missing", { story: {} }).catch(error => error);
  expect(missing.message).toContain("/expectedRevision is required");

  const image = f.tools.find(tool => tool.name === "courseware_scene_image_prepare")!;
  const base = { planSha256: "a".repeat(64), pageId: "scene-001" };
  const layer = await image.execute("layer", { ...base, target: { kind: "layer" } }).catch(error => error);
  expect(layer.message).toContain("/target/name is required");
  const kind = await image.execute("kind", { ...base, target: { kind: "private-value" } }).catch(error => error);
  expect(kind.message).toContain("/target/kind must be one of:");
  expect(kind.message).not.toContain("private-value");
  const id = await image.execute("id", { ...base, pageId: "private/page", target: { kind: "visualMaster" } }).catch(error => error);
  expect(id.message).toContain("/pageId must match the required format");
  expect(id.message).not.toContain("private/page");
  const extra = await image.execute("extra", { ...base, target: { kind: "visualMaster" }, secret: "private-value" }).catch(error => error);
  expect(extra.message).not.toMatch(/secret|private-value/u);
  const media = f.tools.find(tool => tool.name === "courseware_media_refresh")!;
  const duplicate = await media.execute("duplicate", { kind: "tts", sourceSha256: "a".repeat(64),
    recover: true, pageNumbers: [1, 1] }).catch(error => error);
  expect(duplicate.message).toContain("/pageNumbers must contain distinct items");
  expect(f.calls).toEqual([]);
  await image.execute("valid", { ...base, target: { kind: "visualMaster" } });
  expect(f.calls).toHaveLength(1);
  expect(f.calls[0]?.params).toMatchObject({ toolCallId: "valid", toolName: "courseware_scene_image_prepare" });
});

it("advertises only finite sequential actions and pins every call to the owning active turn", async () => {
  const f = fixture();
  for (const tool of f.tools) expect(JSON.parse(JSON.stringify(tool.parameters)).type, tool.name).toBe("object");
  expect(f.tools.map(tool => tool.name)).toEqual(COURSEWARE_WORKFLOW_TOOLS);
  expect(f.tools.every(tool => tool.executionMode === "sequential")).toBe(true);
  expect(f.tools.some(tool => /approve|select|publish/.test(tool.name))).toBe(false);
  await f.tools.find(tool => tool.name === "courseware_workflow_get")!.execute("read", {});
  expect(f.calls).toEqual([{ method: "tools.execute", params: { sessionId: "chat-1", turnId: "turn-1",
    toolCallId: "read", toolName: "courseware_workflow_get", mode: "agent", args: {} } }]);
});

it("dispatches native lesson planning and bounded recovery without allowing mixed intent scopes", async () => {
  const f = fixture(), sourceSha256 = "a".repeat(64);
  const plan = f.tools.find(t => t.name === "courseware_narration_plan")!;
  const recovery = f.tools.find(t => t.name === "courseware_media_refresh")!;
  await plan.execute("plan", { sourceSha256, apply: false, lessonPlan: { sourceId: "b".repeat(64) } });
  for (const lessonPlan of [{}, { sourceId: "b".repeat(64), text: "forged transcription" }])
    await expect(plan.execute("bad-plan", { sourceSha256, apply: false, lessonPlan })).rejects.toThrow("Invalid courseware workflow input");
  await recovery.execute("recover", { kind: "tts", sourceSha256, recover: true });
  await recovery.execute("scoped", { kind: "tts", sourceSha256, recover: true, pageNumbers: [1, 3], model: "voice", voice: null });
  for (const args of [
    { kind: "tts", sourceSha256, recover: true, intentId: "original" },
    { kind: "tts", sourceSha256, recover: true, pageNumbers: [1, 1] },
    { kind: "music", sourceSha256, recover: true },
    { kind: "tts", sourceSha256, recover: true, retryFailed: true },
  ]) await expect(recovery.execute("bad", args)).rejects.toThrow("Invalid courseware workflow input");
  expect(f.calls).toHaveLength(3);
});

it("dispatches an ordinary export teaching plan with bounded native Quiz option keys", async () => {
  const f = fixture();
  const adopt = f.tools.find(tool => tool.name === "courseware_presentation_adopt")!;
  const input = { path: "/workspace/.deckwise-ppt/projects/lesson/exports/lesson.pptx", sourceSha256: "a".repeat(64),
    pages: [{ pageNumber: 1, teaching: { pageType: "quiz", phase: "practice", objective: "Name father", durationSeconds: 30, requiredObjects: [] },
      quiz: { type: "quiz", questions: [{ id: "family", type: "single", question: "Who?", options: [{ value: "A", label: "father" }, { value: "B", label: "mother" }], answer: ["A"] }] } }], continueTeaching: true };
  await adopt.execute("adopt", input);
  expect(f.calls[0]).toMatchObject({ params: { toolName: "courseware_presentation_adopt", args: input, timeoutMs: 16 * 60_000 } });
  input.pages[0]!.quiz.questions[0]!.options[0]!.value = "0";
  await expect(adopt.execute("invalid", input)).rejects.toThrow("Invalid courseware workflow input");
  expect(f.calls).toHaveLength(1);
});

it("keeps teaching checks on for adoption retries while allowing a later PPTX-only turn", async () => {
  const f = fixture(), adopt = f.tools.find(tool => tool.name === "courseware_presentation_adopt")!;
  const input = { path: "exports/lesson.pptx", sourceSha256: "a".repeat(64) };
  await adopt.execute("teach", { ...input, continueTeaching: true });
  await adopt.execute("retry", { ...input, continueTeaching: false });
  f.turn("pptx-only");
  await adopt.execute("file", { ...input, continueTeaching: false });
  expect(f.calls[1]).toMatchObject({ params: { args: { continueTeaching: true } } });
  expect(f.calls[2]).toMatchObject({ params: { args: { continueTeaching: false } } });
});

it("prepares fixed assessment SVGs through the owning turn without exporting or generating media", async () => {
  const f = fixture(), tool = f.tools.find(tool => tool.name === "courseware_presentation_prepare")!;
  const args = { projectPath: ".deckwise-ppt/projects/lesson", canvas: { width: 1280, height: 720 },
    pages: [{ pageNumber: 1, teaching: { pageType: "interactive", phase: "practice", objective: "Introduce family", durationSeconds: 30,
      requiredObjects: [], question: { text: "Introduce your family", response: { kind: "discussion", options: [], answerIndices: [] } } } }] };
  await tool.execute("prepare", args);
  expect(f.calls[0]).toMatchObject({ params: { sessionId: "chat-1", turnId: "turn-1", toolName: "courseware_presentation_prepare", args } });
  for (const invalid of [{ ...args, canvas: { width: 0, height: 720 } }, { ...args, sourceSha256: "a".repeat(64) }])
    await expect(tool.execute("bad", invalid)).rejects.toThrow("Invalid courseware workflow input");
  expect(f.calls).toHaveLength(1);
});

it("passes only user-evidenced exact narration counts to the host", async () => {
  const sent: any[] = [];
  const quote = "Use four speech blocks on each page";
  const tools = createCoursewareWorkflowTools({ async call<T>(_method: string, params: unknown): Promise<T> {
    sent.push(params); return {ok:true,content:{}} as T;
  } }, "chat", () => "turn", () => quote);
  const tool = tools.find(t => t.name === "courseware_narration_propose")!;
  const args = {sourceSha256:"a".repeat(64), pageNumbers:[1], instruction:"Five paragraphs", speechCount:4};
  await tool.execute("suggestion", args);
  await tool.execute("explicit", {...args, speechCountEvidence:quote});
  expect(sent[0].args).not.toHaveProperty("speechCount");
  expect(sent[1].args.speechCount).toBe(4);
  expect(sent[1].args).not.toHaveProperty("speechCountEvidence");
});

it("normalizes misplaced teaching fields before SDK validation without guessing conflicting values", async () => {
  const f = fixture(), tool = f.tools.find(t => t.name === "courseware_presentation_prepare")!;
  const teaching = { phase: "explore", objective: "Compare", durationSeconds: 40, requiredObjects: [] };
  const input = { projectPath: "lesson", canvas: { width: 1280, height: 720 }, pages: [
    { pageNumber: 1, teaching, pageType: "slide", requiredEffects: ["highlight"] },
    { pageNumber: 2, teaching: { ...teaching, pageType: "slide" }, pageType: "slide" }
  ] };
  const prepared = tool.prepareArguments?.(input);
  expect(Check(tool.parameters, prepared)).toBe(true);
  await tool.execute("prepared", prepared);
  expect(f.calls[0].params).toMatchObject({ args: { pages: [
    { pageNumber: 1, teaching: { ...teaching, pageType: "slide", requiredEffects: ["highlight"] } },
    { pageNumber: 2, teaching: { ...teaching, pageType: "slide" } }
  ] } });
  input.pages[1].pageType = "quiz";
  expect(() => tool.prepareArguments?.(input)).toThrow(/pages\[1\].*pageType/);
});

it("declares distinct body, Quiz and checkpoint shapes instead of optional interchangeable fields", async () => {
  const f = fixture(), tool = f.tools.find(tool => tool.name === "courseware_presentation_prepare")!;
  const args = { projectPath: ".deckwise-ppt/projects/lesson", canvas: { width: 1280, height: 720 }, pages: [{ pageNumber: 1,
    teaching: { pageType: "interactive", phase: "practice", objective: "Share", durationSeconds: 30, requiredObjects: [] } }] };
  await expect(tool.execute("missing-question", args)).rejects.toThrow("Invalid courseware workflow input");
  expect(f.calls).toEqual([]);
});

it("dispatches bounded story drafts while rejecting invalid references and model-owned approval", async () => {
  const f = fixture();
  const save = f.tools.find(tool => tool.name === "courseware_story_save")!;
  const story = { title: "Rainbow rescue", summary: "Find the colors", setting: "A garden", objectives: ["Name red"],
    characters: [{ name: "Robin", description: "A round robot" }],
    beats: [{ id: "find", title: "Find red", event: "Find a red ball", objective: "Name red", activity: "Sort colors" }], assumptions: [] };
  await save.execute("story", { expectedRevision: 0, story });
  expect(f.calls.at(-1)?.params).toMatchObject({ sessionId: "chat-1", turnId: "turn-1", toolName: "courseware_story_save", args: { expectedRevision: 0, story } });
  for (const input of [
    { expectedRevision: 0, story, approved: true },
    { expectedRevision: -1, story },
    { expectedRevision: 0, story: { ...story, beats: [...story.beats, ...story.beats] } },
    { expectedRevision: 0, story: { ...story, objectives: ["Unrelated"] } },
  ]) await expect(save.execute("invalid", input)).rejects.toThrow();
  const repeated = await save.execute("repeat", { expectedRevision: 0,
    story: { ...story, beats: [...story.beats, ...story.beats] } }).catch(error => error);
  expect(repeated).toMatchObject({ code: "COURSEWARE_INVALID", operation: "courseware_story_save" });
  expect(repeated.message).toContain("/story/beats/1/id must be unique");
  expect(coursewareInputHint(new CoursewareWorkflowError(repeated.code, "wrapped", "courseware_story_save", { cause: repeated })))
    .toContain("/story/beats/1/id must be unique");
  const unmatched = await save.execute("unmatched", { expectedRevision: 0,
    story: { ...story, objectives: ["private objective"] } }).catch(error => error);
  expect(unmatched.message).toContain("/story/beats/0/objective must reference /story/objectives");
  expect(unmatched.message).not.toContain("private objective");
  const oversized = await save.execute("oversized", { expectedRevision: 0,
    story: { ...story, beats: Array.from({ length: 30 }, (_, index) => ({ ...story.beats[0], id: `beat-${index}`,
      event: "private event ".repeat(180) })) } }).catch(error => error);
  expect(oversized.message).toContain("/story exceeds 65536 bytes");
  expect(oversized.message).not.toContain("private event");
  expect(f.calls).toHaveLength(1);
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

it("gives shared assessment media the saved-media dispatch budget", async () => {
  const f = fixture();
  await f.tools.find(tool => tool.name === "courseware_media_assessments")!.execute("assessment", { mode: "context" });
  expect(f.calls.at(-1)?.params).toMatchObject({ toolName: "courseware_media_assessments", timeoutMs: 960_000 });
});

it("validates assessment identities, revisions and TTS voice before dispatch", async () => {
  const f = fixture(), tool = f.tools.find(tool => tool.name === "courseware_media_assessments")!;
  const target = { mode: "prepare", kind: "tts", projectId: "project", sceneId: "scene", actionId: "speech",
    expectedRevision: "r1", expectedSourceRevision: "s1", model: "tts", voice: null };
  for (const field of ["projectId", "sceneId", "actionId", "expectedRevision", "expectedSourceRevision", "model", "voice"]) {
    const invalid: Record<string, unknown> = { ...target }; delete invalid[field];
    await expect(tool.execute("invalid", invalid)).rejects.toThrow("Invalid courseware");
  }
  await expect(tool.execute("invalid", { mode: "context", actionId: "speech" })).rejects.toThrow();
  await expect(tool.execute("invalid", { ...target, kind: "image", questionId: "q", optionValue: "A" })).rejects.toThrow();
  expect(f.calls).toHaveLength(0);
  for (const mode of ["prepare", "refresh"]) await tool.execute("valid", { ...target, mode });
  await tool.execute("image", { mode: "prepare", kind: "image", projectId: "project", sceneId: "scene", questionId: "q", optionValue: "A",
    expectedRevision: "r1", expectedSourceRevision: "s1", model: "image" });
  expect(f.calls).toHaveLength(3);
});

it("dispatches revision-checked assessment image exclusions only with explicit scope and reason", async () => {
  const f = fixture(), tool = f.tools.find(tool => tool.name === "courseware_media_assessments")!;
  const args = { mode: "configure", projectId: "project", expectedRevision: "r1", expectedSourceRevision: "s1",
    sceneIds: ["quiz"], optionImages: "excluded", reason: "User requested text-only choices" };
  for (const invalid of [{ ...args, sceneIds: [] }, { ...args, sceneIds: ["quiz", "quiz"] }, { ...args, reason: "" },
    { ...args, optionImages: "skip" }, { ...args, kind: "tts" }])
    await expect(tool.execute("invalid", invalid)).rejects.toThrow("Invalid courseware");
  expect(f.calls).toHaveLength(0);
  await tool.execute("configure", args);
  expect(f.calls.at(-1)?.params).toMatchObject({ args });
});

it("preserves the body-page budget and bounded custom style in revision-checked requirements updates", async () => {
  const f = fixture();
  const update = f.tools.find(tool => tool.name === "courseware_requirements_update")!;
  const args = { expectedEducationContext: {}, educationContext: { visualStyle: "Matte clay 3D; no watercolor", bodyPageLimit: 8 } };
  await update.execute("style", args);
  expect(f.calls.at(-1)?.params).toMatchObject({ args });
  for (const bodyPageLimit of [null, 0, 31, 1.5, "8"])
    await expect(update.execute("invalid", { ...args, educationContext: { bodyPageLimit } })).rejects.toThrow("Invalid courseware");
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


it("exposes media fields and only common requirements at the root while rejecting empty calls", async () => {
  const f = fixture();
  for (const [toolName, required] of [
    ["courseware_media_prepare", ["kind", "model", "pageNumber", "sourceSha256"]],
    ["courseware_media_assessments", ["mode"]],
    ["courseware_media_refresh", ["kind", "sourceSha256"]],
  ] as const) {
    const tool = f.tools.find(t => t.name === toolName)!;
    const wire = JSON.parse(JSON.stringify(tool.parameters));
    expect(wire.required.sort()).toEqual(required);
    const fields = wire.anyOf.flatMap((branch: {properties: object}) => Object.keys(branch.properties));
    expect(Object.keys(wire.properties).sort()).toEqual([...new Set(fields)].sort());
    await expect(tool.execute("empty", {})).rejects.toThrow("Invalid courseware");
  }
  expect(f.calls).toHaveLength(0);
  const assessment = f.tools.find(t => t.name === "courseware_media_assessments")!;
  expect(Check(assessment.parameters, {mode:"context"})).toBe(true);
  expect(Check(assessment.parameters, {mode:"prepare"})).toBe(false);
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

it("scopes narration context to selected pages and omits repeated full-deck payloads from model text", async () => {
  const value = { projectId: "project", sourceSha256: "a".repeat(64), approvedPlan: { pages: Array(100).fill("x".repeat(1000)) },
    completion: { ready: false, issues: Array(100).fill({ pageNumber: 1, code: "AUDIO_MISSING" }) },
    quality: { counts: { AUDIO_MISSING: 100 }, issues: [{ pageNumber: 1, code: "AUDIO_MISSING" }, { pageNumber: 2, code: "NARRATION_MISSING" }] },
    pages: [{ pageNumber: 2, actions: [{ id: "speech", type: "speech", text: "Keep exact speech" }], speeches: [{ actionId: "speech", text: "Keep exact speech" }] }] };
  const tools = createCoursewareWorkflowTools({ async call<T>(): Promise<T> { return { ok: true, content: value } as T; } }, "chat", () => "turn");
  const result = await tools.find(tool => tool.name === "courseware_narration_context")!.execute("read", { pageNumbers: [2] });
  const text = JSON.stringify(result.content);
  expect(text.length).toBeLessThan(2000);
  expect(text).toContain("Keep exact speech");
  expect(text).not.toContain("approvedPlan");
  expect(result.details).toEqual(value);
});

it('advertises a five-page narration limit and rejects a whole-deck call before Host dispatch', async () => {
  const f = fixture();
  const generate = f.tools.find(tool => tool.name === 'courseware_narration_propose')!;
  expect(generate.parameters).toMatchObject({properties:{pageNumbers:{maxItems:5}}});
  expect(generate.description).not.toContain('all missing pages in one call');
  expect(generate.description).toContain('at most 5');
  const before = f.calls.length;
  for (const pageNumbers of [[1,2,3,4,5,6], Array.from({length:56},(_,i)=>i+1)])
    await expect(generate.execute('oversized',{pageNumbers,sourceSha256:'a'.repeat(64),instruction:'Teach'})).rejects.toThrow();
  expect(f.calls).toHaveLength(before);
  await generate.execute('five-pages',{pageNumbers:[1,2,3,4,5],sourceSha256:'a'.repeat(64),instruction:'Teach'});
  expect(f.calls).toHaveLength(before + 1);
});


it("rejects mutually exclusive refresh operations before Host dispatch while preserving explicit false flags", async () => {
  const f = fixture(), tool = f.tools.find(t => t.name === "courseware_scene_image_refresh")!;
  for (const flags of [
    { generateRemaining: true, waitForUpdate: true }, { generateRemaining: true, generatePrepared: true },
    { generateRemaining: true, retryFailed: true }, { retryFailed: true, generatePrepared: true },
  ]) await expect(tool.execute("invalid", { intentId: "original", ...flags })).rejects.toMatchObject({ code: "COURSEWARE_INVALID_REFRESH" });
  expect(f.calls).toHaveLength(0);
  for (const flags of [{}, { generateRemaining: true, waitForUpdate: false, retryFailed: false },
    { generatePrepared: true, waitForUpdate: true }, { retryFailed: true, waitForUpdate: true }])
    await tool.execute("valid", { intentId: "original", ...flags });
  expect(f.calls).toHaveLength(4);
});


it("advertises exactly the refresh flag combinations accepted by Main", () => {
  const tool = fixture().tools.find(t => t.name === "courseware_scene_image_refresh")!;
  for (let bits = 0; bits < 16; bits++) {
    const args = { intentId: "original", generateRemaining: !!(bits & 1), generatePrepared: !!(bits & 2),
      retryFailed: !!(bits & 4), waitForUpdate: !!(bits & 8) };
    const valid = !(args.generateRemaining && (args.generatePrepared || args.retryFailed || args.waitForUpdate)) &&
      !(args.generatePrepared && args.retryFailed);
    expect(Check(tool.parameters, args), JSON.stringify(args)).toBe(valid);
  }
});


it("retains only schema-owned field hints through continuation wrappers", async () => {
  const f = fixture(), tool = f.tools.find(t => t.name === "courseware_narration_propose")!;
  const failure = await tool.execute("missing", { sourceSha256: "a".repeat(64), pageNumbers: [1] }).catch(e => e);
  const wrapped = new CoursewareWorkflowError(failure.code, "private outer data", tool.name, { cause: failure });
  expect(coursewareInputHint(wrapped)).toContain("/instruction is required");
  expect(coursewareInputHint(wrapped)).not.toContain("private outer data");
  const forged = new CoursewareWorkflowError("COURSEWARE_INVALID", "private payload", tool.name,
    { cause: { code: "COURSEWARE_INVALID", message: "private nested data", inputHint: "private hint" } });
  expect(coursewareInputHint(forged)).not.toContain("private");
});


it("dispatches the teacher's request and saved page selection instead of invented binding instructions", async () => {
  const f = fixture(() => "Show the numerator, under 35 seconds.");
  const tool = f.tools.find(t => t.name === "courseware_narration_propose")!;
  const input = { pageNumbers: [2], sourceSha256: "a".repeat(64), instruction: "Every sentence must spotlight the page-one field" };
  await tool.execute("narrate", input);
  expect(f.calls[0].params).toMatchObject({ args: { ...input, instruction: "Show the numerator, under 35 seconds." } });
  await tool.execute("repair", { ...input, repairRequiredTeaching: true });
  expect(f.calls[1].params).toMatchObject({ args: { instruction: input.instruction } });
});

it("restores serialized narration parameters only for an unambiguous schema-valid call", () => {
  const tool = fixture().tools.find(t => t.name === "courseware_narration_plan")!;
  const hash = "a".repeat(64), lessonPlan = { sourceId: "b".repeat(64) };
  const args = { lessonPlan, sourceSha256: hash + '</sourceSha256>\n<｜｜DSML｜｜ parameter name="apply" string="false">false' };
  expect(tool.prepareArguments?.(args)).toEqual({ sourceSha256: hash, lessonPlan, apply: false });
  const conflict = { ...args, apply: true };
  expect(tool.prepareArguments?.(conflict)).toBe(conflict);
});
