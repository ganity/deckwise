import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import test from "node:test";
import ts from "typescript";
import * as shared from "@pi-desktop/shared";
import * as runtime from "@pi-desktop/agent-runtime";

const require = createRequire(import.meta.url);
async function loadSource(path, dependencies = {}) {
  const source = await readFile(new URL(path, import.meta.url), "utf8");
  const { outputText } = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } });
  const exports = {};
  new Function("require", "exports", outputText)((id) => {
    if (Object.hasOwn(dependencies, id)) return dependencies[id];
    if (id.startsWith("node:")) return require(id);
    throw new Error(`Unexpected dependency: ${id}`);
  }, exports);
  return exports;
}
// Read the actual vendored policies so a stale dist cannot hide prompt regressions.
const commands = await loadSource("../../../packages/agent-runtime/src/courseware/kindergarten-english-commands.ts");
const profiles = await loadSource("../../../packages/agent-runtime/src/courseware/generation-profile-registry.ts", {
  "./kindergarten-english-commands.js": commands,
});
const planning = await loadSource("../electron/main/courseware-scene-plan.ts", { "@pi-desktop/agent-runtime": profiles });
const { createSceneCoursePlan, parseSceneCoursePlan } = planning;
const input = { sessionId: "session-1", modelKey: "provider/model", brief: "幼儿园英语问候课", education: { schoolStage: "kindergarten", subject: "english" } };
const answer = JSON.stringify({ title: "问候", pages: [{ title: "打招呼", visibleText: ["Hello"], visualIntent: "两个孩子挥手", narration: "和朋友挥挥手，说 Hello。Good!" }] });

test("initial scene plan uses the selected teaching policy and yields stable page bindings", async () => {
  let request;
  const plan = await createSceneCoursePlan(input, async (value) => { request = value; return { text: answer }; });
  assert.equal(request.sessionId, input.sessionId);
  assert.match(request.system, /Language policy \[BILINGUAL_ENGLISH_KINDERGARTEN\]/);
  assert.match(request.system, /Use 0-2 exact phrases per ordinary page/);
  assert.deepEqual(JSON.parse(request.messages[0].content).education, input.education);
  assert.equal(plan.pages[0].pageId, "scene-001");
  assert.match(plan.pages[0].sourceHash, /^sha256:[a-f0-9]{64}$/);
  assert.equal(plan.pages[0].narration, "和朋友挥挥手，说 Hello。Good!");
  const other = await createSceneCoursePlan({ ...input, education: { schoolStage: "kindergarten", subject: "math" } }, async (value) => {
    assert.match(value.system, /Do not add English praise or commands/);
    return { text: answer };
  });
  assert.equal(other.pages[0].sourceHash, plan.pages[0].sourceHash);
});

test("completion requests reuse MAIC age, subject and language rules without changing saved settings", async () => {
  for (const [education, required, absent] of [
    [{ schoolStage: " Kindergarten ", subject: " English ", grade: "K2", lessonType: "Practice", fullEnglishTeaching: true },
      [/Audience stage \[KINDERGARTEN\]/, /Grade=K2/, /LessonType=Practice/, /FULL_ENGLISH_KINDERGARTEN/, /Teach entirely in simple, concrete English/, /short, simple and speakable/, /such as Good!/, /never assume an unseen answer/], [/BILINGUAL_ENGLISH_KINDERGARTEN/, /PRIMARY_MATH/]],
    [{ schoolStage: "kindergarten", subject: "math" },
      [/Audience stage \[KINDERGARTEN\]/, /short sentences, vivid actions/, /Do not add English praise or commands/], [/Kindergarten English classroom command policy/, /such as Good!/, /BILINGUAL_ENGLISH/]],
    [{ schoolStage: "primary", subject: "math", grade: "3", chapter: "Length" },
      [/Audience stage \[PRIMARY\]/, /PRIMARY_MATH/, /source-grounded numbers, units/i, /never AI-generated raster artwork/], [/Kindergarten English classroom command policy/, /such as Good!/]],
    [{ schoolStage: "primary", subject: "chinese" },
      [/PRIMARY_CHINESE/, /Never invent stroke-order diagrams/], [/Kindergarten English classroom command policy/, /PRIMARY_MATH/]],
    [{ schoolStage: "primary", subject: "english", fullEnglishTeaching: true },
      [/Language policy \[FULL_ENGLISH\]/, /Teach entirely in English/], [/Kindergarten English classroom command policy/, /FULL_ENGLISH_KINDERGARTEN/]],
    [{ schoolStage: "primary", subject: "english", fullEnglishTeaching: false },
      [/BILINGUAL_ENGLISH_PRIMARY/, /approximately 60-80%/], [/Kindergarten English classroom command policy/, /FULL_ENGLISH_KINDERGARTEN/]],
    [{ schoolStage: "senior_high", subject: "history" },
      [/Audience stage \[SENIOR_HIGH\]/, /reasoning, problem solving/], [/Kindergarten English classroom command policy/, /such as Good!/]],
    [{}, [/Audience stage \[GENERAL_SCHOOL\]/], [/Audience stage \[KINDERGARTEN\]/, /Kindergarten English classroom command policy/]],
  ]) {
    const before = structuredClone(education);
    await createSceneCoursePlan({ ...input, education }, async (request) => {
      for (const pattern of required) assert.match(request.system, pattern);
      for (const pattern of absent) assert.doesNotMatch(request.system, pattern);
      assert.match(request.system, /put unspoken teacher operations and participation\/waiting intent in visualIntent/);
      assert.match(request.system, /Narration contains only words spoken directly to students/);
      assert.match(request.system, /does not encode executable waits or assess answers/);
      assert.doesNotMatch(request.system, /allowQuizScenes|allowInteractiveScenes|"type":"wait"/);
      assert.deepEqual(JSON.parse(request.messages[0].content).education, before);
      return { text: answer };
    });
    assert.deepEqual(education, before);
  }
});

const attachments = await loadSource("../electron/main/prompt-attachments.ts", { "@pi-desktop/shared": shared });
const sessionInput = await loadSource("../electron/main/session-message-input.ts", { "@pi-desktop/shared": shared });
const sceneSkill = (await readFile(new URL("../resources/skills/scene-courseware/SKILL.md", import.meta.url), "utf8")).replace(/^---\n[\s\S]*?\n---\n/, "");
const { registerAgentIpc } = await loadSource("../electron/main/ipc/agent-ipc.ts", {
  "@pi-desktop/shared": shared, "@pi-desktop/agent-runtime": runtime,
  "../oauth": {}, "../prompt-attachments": attachments, "../plan-execution": {},
  "../session-message-input": sessionInput, "../courseware-scene-plan": planning,
  "../courseware-llm-auth": { resolveCoursewareLlmAuth: async () => ({}) },
  "../builtin-skills": { loadBuiltinSkillBody: (id) => id === "deckwise/scene-courseware"
    ? { id, name: "scene-courseware", body: sceneSkill } : null },
});

async function dispatchChat(educationContext, { taskType = "scene", nativeEditing = false, importPath, generatedPath } = {}) {
  const handlers = new Map(), requests = [], persisted = [];
  const host = { async call(method, params) {
    if (method === "settings.get") return {};
    if (method === "session.get") return { session: { id: input.sessionId, projectPath: "/workspace", messages: [] } };
    if (method === "courseware.task.get") return { task: { taskType, educationContext, importPath, generatedPath } };
    if (method === "session.beginTurn") return { turnId: "turn-1" };
    if (method === "session.appendMessage") { persisted.push(params.message); return {}; }
    assert.fail(`Unexpected RPC ${method}`);
  } };
  registerAgentIpc({
    registrar: { handle: (channel, handler) => handlers.set(channel, handler) }, getHost: () => host,
    getSidecar: () => ({ setProjectInstructionRoot() {}, async call(method, params) {
      assert.equal(method, "agent.prompt"); requests.push(params); return { accepted: true, turnId: "turn-1" };
    } }), getAgentHostBridge: () => null, logger: { app() {} }, vendorOAuth: {}, agentExtensions: {},
    cancelSessionTools() {}, persistenceOutbox: {}, dataDir: "/unused-no-attachments",
    activeTurns: new Map(), activeTurnUsages: new Map(), approvedExecutionIdsBySession: new Map(), claimedExecutionSessions: new Map(),
    resolveAgentRuntimeLaunch: async () => ({ providerId: "provider", modelId: "model", projectPath: "/workspace",
      sidecarParams: { sessionId: input.sessionId, provider: { id: "provider", modelId: "model", modelConfig: { input: ["text"] } },
        ...(nativeEditing ? { pptEditorBinding: { projectId: "office", documentId: "deck", sessionId: "native" } } : {}) } }),
    acquireSessionOperation: async () => () => {}, finishTurn: async () => assert.fail("Prompt should succeed"),
    emitAgentEvent() {}, setNotificationViewingSessionId() {},
  });
  const result = await handlers.get(shared.IPC.invoke.agentPrompt)({ sessionId: input.sessionId, content: "Plan a greetings lesson" });
  assert.equal(result.accepted, true);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].provider.modelId, "model");
  assert.equal(persisted[0].content, "Plan a greetings lesson");
  return requests[0].content;
}

test("generated scene teaching can resume without an active Office binding", async () => {
  const content = await dispatchChat(input.education, { generatedPath: "/workspace/generated.pptx" });
  assert.match(content, /courseware_media_context/);
  assert.match(content, /without Office navigation/);
});

test("production Main Chat forwards the same MAIC policy and actual scene skill to the existing runtime", async () => {
  for (const [education, expected, excluded] of [
    [input.education, /BILINGUAL_ENGLISH_KINDERGARTEN/, /FULL_ENGLISH_KINDERGARTEN/],
    [{ schoolStage: " KINDERGARTEN ", subject: " English ", fullEnglishTeaching: true }, /FULL_ENGLISH_KINDERGARTEN/, /BILINGUAL_ENGLISH_KINDERGARTEN/],
    [{ schoolStage: "kindergarten", subject: "math" }, /Audience stage \[KINDERGARTEN\]/, /Kindergarten English classroom command policy|such as Good!/],
    [{ schoolStage: "PRIMARY", subject: "MATH", grade: "3" }, /PRIMARY_MATH/, /Kindergarten English classroom command policy|such as Good!/],
  ]) {
    const before = structuredClone(education);
    const content = await dispatchChat(education);
    assert.match(content, expected);
    assert.doesNotMatch(content, excluded);
    assert(content.includes(planning.sceneCourseTeachingPolicy(education)));
    assert(content.includes(sceneSkill));
    assert.match(content, /planned five-second video slots/);
    assert.match(content, /courseware_media_context\(kind:video\)/);
    assert.match(content, /teacher-led questions with reference answers/);
    assert.doesNotMatch(content, /not generated video|video generation\/postprocessing\/mounting chain remain incomplete/);
    assert(content.includes(planning.sceneCoursePlanRelativePath(input.sessionId)));
    assert.match(content, /Narration contains only words spoken directly to students/);
    assert.doesNotMatch(content, /Keep teacher instructions in narration/);
    assert.deepEqual(education, before);
  }
});

test("the new scene planning policy does not change plain, import or native editing prompts", async () => {
  for (const options of [{ taskType: "plain" }, { taskType: "import", nativeEditing: true }, { taskType: "scene", nativeEditing: true }]) {
    const content = await dispatchChat(input.education, options);
    assert.doesNotMatch(content, /Audience stage \[|Kindergarten English classroom command policy/);
    assert.match(content, /For kindergarten English, use 0–2 short English expressions/);
    assert.doesNotMatch(content, /Host-selected scene planning file/);
  }
});

test("import requirements can be discussed in main Chat before selection or opening Office", async () => {
  for (const importPath of [undefined, "/workspace/imported.pptx"]) {
    const content = await dispatchChat(input.education, { taskType: "import", importPath });
    assert.match(content, /No Office editing binding is active/);
    assert.match(content, /collect requirements/);
    assert.match(content, /file picker in the main Chat/);
    assert.match(content, /Do not inspect, parse or modify the PPTX with file or shell tools/);
    assert.doesNotMatch(content, /Host-selected scene planning file|# Skill: scene-courseware/);
  }
  const native = await dispatchChat(input.education, { taskType: "import", nativeEditing: true });
  assert.doesNotMatch(native, /No Office editing binding is active/);
  assert.match(native, /read fresh context and use only operations advertised/);
});

test("initial scene plan rejects malformed, oversized and late output", async () => {
  await assert.rejects(createSceneCoursePlan(input, async () => ({ text: JSON.stringify({ title: "课", pages: [{ title: "页", visibleText: [], visualIntent: "场景", narration: "讲解", sourcePptx: "/tmp/secret" }] }) })), /Invalid scene course page/);
  await assert.rejects(createSceneCoursePlan(input, async () => ({ text: "x".repeat(256 * 1024 + 1) })), /exceeds limits/);
  const controller = new AbortController();
  await assert.rejects(createSceneCoursePlan({ ...input, signal: controller.signal }, async () => {
    controller.abort();
    return { text: answer };
  }), /aborted/i);
});

test("a Chat-edited saved draft is revalidated and only changed page content changes its hash", () => {
  const draft = JSON.parse(answer);
  draft.pages.push({ ...draft.pages[0], title: "Goodbye" });
  const before = parseSceneCoursePlan(JSON.stringify(draft));
  draft.pages[0].narration = "向朋友挥挥手，说 Hello。";
  const after = parseSceneCoursePlan(JSON.stringify(draft));
  assert.equal(after.pages[0].pageId, before.pages[0].pageId);
  assert.notEqual(after.pages[0].sourceHash, before.pages[0].sourceHash);
  assert.deepEqual(after.pages[1], before.pages[1]);
  draft.pages[0].file = "/tmp/other.pptx";
  assert.throws(() => parseSceneCoursePlan(JSON.stringify(draft)), /Invalid scene course page/);
  assert.throws(() => parseSceneCoursePlan("x".repeat(256 * 1024 + 1)), /exceeds limits/);
});


test("course visual bible survives parsing and reaches the planning prompt without breaking legacy drafts", async () => {
  const visualBible = { artDirection: "Warm matte 3D, soft lighting, cream and green palette",
    characters: "Pandy: one round black and white panda, green scarf, fixed eye patches and proportions",
    setting: "One woodland classroom; outdoor scenes only for an explicit teaching reason" };
  const draft = { ...JSON.parse(answer), visualBible };
  assert.deepEqual(parseSceneCoursePlan(JSON.stringify(draft)).visualBible, visualBible);
  assert.equal(parseSceneCoursePlan(answer).visualBible, undefined);
  await createSceneCoursePlan(input, async request => {
    assert.match(request.system, /visualBible/);
    assert.match(request.system, /recurring character/);
    return { text: JSON.stringify(draft) };
  });
  for (const invalid of [null, {}, { ...visualBible, path: "/tmp/reference" },
    { ...visualBible, characters: " " }, { ...visualBible, artDirection: "x".repeat(1001) }])
    assert.throws(() => parseSceneCoursePlan(JSON.stringify({ ...draft, visualBible: invalid })), /visual bible/i);
});

test("preset and custom art directions reach both planning entrances as saved user requirements", async () => {
  for (const visualStyle of ["Clean 2D cartoon, crisp outlines", "哑光黏土 3D，奶油白和蓝色，柔光，不要水彩或蜡笔纹理"]) {
    const education = { ...input.education, visualStyle };
    const visualBible = { artDirection: visualStyle, characters: "Monkey in a blue vest", setting: "A classroom" };
    const result = await createSceneCoursePlan({ ...input, education }, async request => {
      assert.equal(JSON.parse(request.messages[0].content).education.visualStyle, visualStyle);
      assert.match(request.system, /user's explicit art direction/);
      assert.match(request.system, /Preserve its medium, materials, palette, lighting and exclusions/);
      return { text: JSON.stringify({ ...JSON.parse(answer), visualBible }) };
    });
    assert.equal(result.visualBible.artDirection, visualStyle);
    const content = await dispatchChat(education);
    assert(content.includes(JSON.stringify(education)));
    assert.match(content, /Never change a user-selected style without a new user request/);
  }
});
