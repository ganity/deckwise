import assert from "node:assert/strict";
import { createHash } from "node:crypto";
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
const planning = await loadSource("../electron/main/courseware-scene-plan.ts", { "@pi-desktop/agent-runtime": profiles, "@pi-desktop/shared": shared });
const { createSceneCoursePlan, parseSceneCoursePlan } = planning;
const input = { sessionId: "session-1", modelKey: "provider/model", brief: "幼儿园英语问候课", education: { schoolStage: "kindergarten", subject: "english" } };
const answer = JSON.stringify({ title: "问候", pages: [{ title: "打招呼", visibleText: ["Hello"], visualIntent: "两个孩子挥手", narration: "和朋友挥挥手，说 Hello。Good!" }] });

test("initial planning corrects invalid JSON with bounded feedback instead of human schema steering", async () => {
  const requests = [];
  const result = await createSceneCoursePlan(input, async request => {
    const data = JSON.parse(request.messages[0].content); requests.push(data);
    return { text: requests.length === 1 ? "invalid JSON" : answer };
  });
  assert.equal(result.title, "问候"); assert.equal(requests.length, 2);
  assert.equal(requests[1].repair.previousOutput, "invalid JSON");
  assert.deepEqual(requests[1].education, requests[0].education);
  let calls = 0;
  await assert.rejects(createSceneCoursePlan(input, async () => { calls++; return { text: "invalid JSON" }; }));
  assert.equal(calls, 3);
  calls = 0;
  await assert.rejects(createSceneCoursePlan(input, async () => { calls++; throw Error("Provider lost"); }), /Provider lost/);
  assert.equal(calls, 1);
});

test("正文 page limits exclude independent quiz and checkpoint scenes while retaining both", () => {
  const page = JSON.parse(answer).pages[0];
  const quiz = { ...page, visibleText: [], narration: "", title: "Quiz", teaching: { pageType: "quiz", phase: "review", objective: "Check", durationSeconds: 30, requiredObjects: [] },
    quiz: { type: "quiz", questions: [{ id: "q", type: "single", question: "Pick", options: [{ value: "A", label: "A" }, { value: "B", label: "B" }], answer: ["A"] }] } };
  const interaction = { ...page, visibleText: [], narration: "", title: "Discussion", teaching: { pageType: "interactive", phase: "practice", objective: "Discuss", durationSeconds: 30, requiredObjects: [], question: { text: "Why?", response: { kind: "discussion", options: [], answerIndices: [] } } } };
  const plan = parseSceneCoursePlan(JSON.stringify({ title: "Mixed", bodyPageLimit: 1, pages: [page, quiz, interaction] }));
  assert.equal(plan.bodyPageLimit, 1);
  assert.equal(plan.pages.length, 3);
  assert.throws(() => parseSceneCoursePlan(JSON.stringify({ title: "Grouped", pages: [page, page, quiz] })), /between related body pages/);
  assert.equal(parseSceneCoursePlan(JSON.stringify({ title: "Inserted", pages: [page, quiz, page] })).pages.length, 3);
  assert.equal(plan.pages.filter(value => !value.quiz && !value.teaching?.question).length, 1);
  assert.equal(parseSceneCoursePlan(JSON.stringify({ title: "Full lesson", pages: [page, quiz, ...Array.from({ length: 29 }, () => page), interaction] })).pages.length, 32);
  assert.throws(() => parseSceneCoursePlan(JSON.stringify({ title: "Too many body pages", pages: Array.from({ length: 31 }, () => page) })), /正文 pages exceed/);
  assert.throws(() => parseSceneCoursePlan(JSON.stringify({ title: "Too many", bodyPageLimit: 1, pages: [page, { ...page, title: "Second" }] })), /正文 pages exceed/);
  const merged = { ...page, teaching: { ...interaction.teaching, pageType: "slide" } };
  assert.throws(() => parseSceneCoursePlan(JSON.stringify({ title: "Merged", pages: [merged] })), /checkpoint pages must use pageType=interactive or pbl/);
});

test("an explicit eight-page request remains eight body pages, without subtracting assessments", async () => {
  const page = JSON.parse(answer).pages[0];
  const quiz = { ...page, title: "Quiz", visibleText: [], narration: "", teaching: {
    pageType: "quiz", phase: "review", objective: "Check", durationSeconds: 30, requiredObjects: [],
  }, quiz: { type: "quiz", questions: [{ id: "q", type: "single", question: "Pick", options: [
    { value: "A", label: "A" }, { value: "B", label: "B" },
  ], answer: ["A"] }] } };
  const checkpoint = { ...page, title: "Checkpoint", visibleText: [], narration: "", teaching: {
    pageType: "interactive", phase: "practice", objective: "Discuss", durationSeconds: 30, requiredObjects: [],
    question: { text: "Why?", response: { kind: "discussion", options: [], answerIndices: [] } },
  } };
  // Reproduce the captured draft: seven body pages plus two assessments, but a model-invented limit of six.
  const output = JSON.stringify({ title: "Family", bodyPageLimit: 6, pages: [
    page, quiz, ...Array.from({ length: 6 }, () => page), checkpoint,
  ] });
  for (const brief of ["根据附件中的教案生成8页教学课件", "请制作 8 页课件", "正文8页，另加Quiz和交互", "Create 8 pages of courseware", "最多8页"]) {
    const result = await createSceneCoursePlan({ ...input, brief }, async () => ({ text: output }));
    assert.equal(result.bodyPageLimit, 8, brief);
    assert.equal(result.pages.length, 9);
    assert.throws(() => parseSceneCoursePlan(JSON.stringify({ title: "Too many", pages: Array.from({ length: 9 }, () => page) }), result.bodyPageLimit), /正文 pages exceed/);
  }
  const resumed = await createSceneCoursePlan({ ...input, brief: "继续，额外加两页互动", education: {
    ...input.education, bodyPageLimit: 8,
  } }, async () => ({ text: output }));
  assert.equal(resumed.bodyPageLimit, 8);
});

test("Chat draft errors expose the format while interaction questions remain separate editable text", () => {
  const plan = JSON.parse(answer);
  plan.pages[0].teaching = { pageType: "invalid" };
  assert.throws(() => parseSceneCoursePlan(JSON.stringify(plan)), /teaching\.pageType:.*slide\|quiz\|interactive\|pbl/);
  plan.pages[0].visibleText = []; plan.pages[0].narration = "";
  plan.pages[0].teaching = { pageType: "interactive", phase: "practice", objective: "Greet", durationSeconds: 120,
    requiredObjects: [], question: { text: "Wave hello", response: { kind: "practice", options: [], answerIndices: [] } } };
  assert.equal(parseSceneCoursePlan(JSON.stringify(plan)).pages[0].teaching.question.text, "Wave hello");
  plan.pages[0].teaching.question.text = "";
  assert.throws(() => parseSceneCoursePlan(JSON.stringify(plan)), /question\.text/);
});

test("Chat draft validation reports field errors across every page at once", () => {
  const page = JSON.parse(answer).pages[0];
  const plan = { title: "Greetings", pages: [
    { ...page, teaching: { pageType: "practice", phase: "practice", objective: "Greet", durationSeconds: 30, requiredObjects: [] } },
    { ...page, teaching: { pageType: "quiz", phase: "review", objective: "Greet", durationSeconds: 30, requiredObjects: [],
      question: { text: "Which greeting?", response: { kind: "single", options: ["Hello", "Bye"], answerIndices: [2] } } } },
    { ...page, teaching: { pageType: "review", phase: "review", objective: "Review", durationSeconds: 30, requiredObjects: [] } },
  ] };
  assert.throws(() => parseSceneCoursePlan(JSON.stringify(plan)), error => {
    assert.match(error.message, /pages\[0\]\.teaching\.pageType.*practice.*slide\|quiz\|interactive\|pbl/);
    assert.match(error.message, /pages\[0\]\.teaching\.question.*required/);
    assert.match(error.message, /pages\[1\]\.teaching\.question\.response\.answerIndices/);
    assert.match(error.message, /pages\[1\].*independent MAIC quiz/);
    assert.match(error.message, /pages\[2\]\.teaching\.pageType.*review/);
    return true;
  });
});

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
const story = await loadSource("../electron/main/courseware-story.ts");
const { registerAgentIpc } = await loadSource("../electron/main/ipc/agent-ipc.ts", {
  "@pi-desktop/shared": shared, "@pi-desktop/agent-runtime": runtime,
  "../courseware-story": story,
  "../oauth": {}, "../prompt-attachments": attachments, "../plan-execution": {},
  "../session-message-input": sessionInput, "../courseware-scene-plan": planning,
  "../courseware-llm-auth": { resolveCoursewareLlmAuth: async () => ({}) },
  "../builtin-skills": { loadBuiltinSkillBody: (id) => id === "deckwise/scene-courseware"
    ? { id, name: "scene-courseware", body: sceneSkill } : null },
});

async function dispatchChat(educationContext, { taskType = "scene", nativeEditing = false, importPath, generatedPath, storyState, storyFailure } = {}) {
  const handlers = new Map(), requests = [], persisted = [];
  const activeTurns = new Map(), methods = [];
  const host = { async call(method, params) {
    methods.push(method);
    if (method === "settings.get") return {};
    if (method === "session.get") return { session: { id: input.sessionId, projectPath: "/workspace", messages: [] } };
    if (method === "courseware.task.get") return { task: { taskType, educationContext, importPath, generatedPath, ...(storyState || storyFailure ? { storyFirst: true } : {}) } };
    if (method === "courseware.story.get") {
      if (storyFailure) throw new Error("Story storage unavailable");
      return { story: storyState };
    }
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
    activeTurns, activeTurnUsages: new Map(), approvedExecutionIdsBySession: new Map(), claimedExecutionSessions: new Map(),
    resolveAgentRuntimeLaunch: async () => ({ providerId: "provider", modelId: "model", projectPath: "/workspace",
      sidecarParams: { sessionId: input.sessionId, provider: { id: "provider", modelId: "model", modelConfig: { input: ["text"] } },
        ...(nativeEditing ? { pptEditorBinding: { projectId: "office", documentId: "deck", sessionId: "native" } } : {}) } }),
    acquireSessionOperation: async () => () => {}, finishTurn: async () => assert.fail("Prompt should succeed"),
    emitAgentEvent() {}, setNotificationViewingSessionId() {},
  });
  const prompt = () => handlers.get(shared.IPC.invoke.agentPrompt)({ sessionId: input.sessionId, content: "Plan a greetings lesson" });
  if (storyFailure) {
    await assert.rejects(prompt(), /Story storage unavailable/);
    assert(!methods.includes("session.beginTurn"));
    assert.equal(activeTurns.size, 0);
    assert.equal(requests.length, 0);
    return;
  }
  const result = await prompt();
  assert.equal(result.accepted, true);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].provider.modelId, "model");
  assert.equal(persisted[0].content, "Plan a greetings lesson");
  return requests[0].content;
}

test("story storage failure does not open a durable turn or start production", async () => {
  await dispatchChat({}, { storyFailure: true });
});

test("both Chat routes design the story first and inject its approved snapshot into their original production prompt", async () => {
  const draft = { title: "Greetings rescue", objectives: ["Say hello"], beats: [{ id: "hello", event: "Help Robin greet a friend" }] };
  const pending = { schemaVersion: 1, revision: 1, draft, sha256: "a".repeat(64), approvedSha256: null, educationContext: input.education, bound: false };
  for (const taskType of ["plain", "scene"]) {
    const designing = await dispatchChat(input.education, { taskType, storyState: pending });
    assert.match(designing, /user need not supply a lesson plan/);
    assert.match(designing, /courseware_story_save/);
    assert.doesNotMatch(designing, /Current scene-courseware skill instructions|Official PPT Master/);
    const producing = await dispatchChat(input.education, { taskType, storyState: { ...pending, approvedSha256: pending.sha256 } });
    assert(producing.includes(draft.title));
    assert(producing.includes(pending.sha256));
    assert.match(producing, taskType === "plain" ? /full existing PPT Master/ : /storySha256/);
  }
});

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
  assert.match(native, /For Office content edits, read fresh native context and use only operations advertised/);
  assert.match(native, /Office selection capabilities do not limit these teaching operations/);
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

test("both planning entrances require concrete original identities without changing lesson requirements", async () => {
  const check = content => {
    assert.match(content, /For generic lesson characters, design original identities/);
    assert.match(content, /silhouettes, body proportions, facial features and color\/outfit combinations/);
    assert.match(content, /recognizable commercial mascots/);
    assert.match(content, /Preserve required names, species, count and explicit user appearance requirements/);
    assert.match(content, /do not silently redesign approved characters/);
  };
  await createSceneCoursePlan(input, async request => {
    check(request.system);
    return { text: answer };
  });
  check(await dispatchChat(input.education));
});


test("scene planning counts every illustrated opening and activity page within the saved body budget", async () => {
  const education = { ...input.education, bodyPageLimit: 4 };
  for (const content of [planning.sceneCourseTeachingPolicy(education), await dispatchChat(education)]) {
    assert.match(content, /saved maximum is 4 body pages/);
    assert.match(content, /including every cover, opening, illustrated activity setup and review/);
    assert.match(content, /never add a body page to repair an assessment when the budget is full/);
  }
});

test("scene planning preserves required groups and names while excluding unrequested clutter", async () => {
  const policy = planning.sceneCourseTeachingPolicy(input.education);
  for (const content of [policy, sceneSkill]) {
    assert.match(content, /Preserve every lesson-required character, name and prop; do not cap their count/);
    assert.match(content, /five animals and all five names/);
    assert.match(content, /Do not add unrequested subjects, duplicate portraits\/badges, extra text carriers or decorative props/);
    assert.match(content, /depth, light, color and materials/);
  }
});

test("typed teaching questions and hash order survive reordered JSON fields", () => {
  const teaching = { pageType: "quiz", phase: "practice", objective: "Identify a greeting", durationSeconds: 40, requiredObjects: [] };
  const quiz = { type: "quiz", questions: [{ id: "greeting", type: "single", question: "Which greeting?", options: [{ value: "A", label: "Hello" }, { value: "B", label: "Goodbye" }], answer: ["A"] }] };
  const page = { quiz, title: "Choose", visibleText: [], visualIntent: "Quiz template", narration: "", teaching };
  const plan = p => parseSceneCoursePlan(JSON.stringify({ title: "Greetings", pages: [p] }));
  const reversed = value => Array.isArray(value) ? value.map(reversed) : value && typeof value === "object" ? Object.fromEntries(Object.entries(value).reverse().map(([k,v]) => [k, reversed(v)])) : value;
  assert.equal(plan(page).pages[0].sourceHash, plan(reversed(page)).pages[0].sourceHash);
  assert.deepEqual(plan(page).pages[0].quiz.questions[0].answer, ["A"]);
  assert.throws(() => { const { quiz, ...withoutQuiz } = page; plan(withoutQuiz); }, /independent MAIC quiz/);
  assert.deepEqual(plan(page).pages[0].teaching, teaching);
  const multiple = { ...quiz, interactionMode: "classroom_instant_feedback", questions: [...quiz.questions, { ...quiz.questions[0], id: "second" }] };
  assert.throws(() => plan({ ...page, quiz: multiple }), /exactly one question/);
  assert.throws(() => plan({ ...page, quiz: { ...multiple, interactionMode: "assessment_review" } }), /exactly one question/);
  const withVideo = { ...page, teaching: { ...teaching, video: { purpose: "Wave", prompt: "A five-second silent wave" } } };
  assert.throws(() => plan(withVideo), /separate body activity/);
  assert.throws(() => plan({ ...page, teaching: { ...teaching, question: { text: "Which greeting?", response: { kind: "single", options: ["Hello", "Goodbye"], answerIndices: [0] } } } }), /Quiz questions belong only in page.quiz/);
  assert.throws(() => plan({ ...page, teaching: null }));
});

test("the skill planning example passes the actual parser and retains question and music requirements", () => {
  const example = sceneSkill.match(/```json\s*([\s\S]*?)```/u)?.[1];
  assert(example, "The planning skill needs an executable JSON example");
  const plan = parseSceneCoursePlan(example);
  assert.equal(plan.pages[1].teaching?.question?.response.kind, "practice");
  assert.equal(plan.pages[0].teaching.pageType, "slide");
  assert(plan.pages[0].teaching?.music?.prompt);
  assert(plan.pages[0].teaching?.video?.prompt);
});

test("production Chat planning example separates MAIC quiz content from editable checkpoints", async () => {
  const content = await dispatchChat(input.education);
  const example = content.match(/```json\s*([\s\S]*?)```/u)?.[1];
  assert(example, "Main Chat must receive an executable mixed-lesson example");
  const plan = parseSceneCoursePlan(example);
  const quizPage = plan.pages.find(page => page.teaching?.pageType === "quiz");
  assert(quizPage?.quiz, "The mixed-lesson example must include independent MAIC quiz content");
  assert.equal(quizPage.teaching.question, undefined);
  assert.equal(quizPage.quiz.type, "quiz");
  assert.deepEqual(quizPage.quiz.questions[0].answer, ["A"]);
  const checkpoint = plan.pages.find(page => page.teaching?.pageType === "interactive");
  assert.equal(checkpoint.quiz, undefined);
  assert(checkpoint.teaching.question.referenceAnswer?.summary);
  assert(checkpoint.teaching.question.constraintPrompt);
  assert(!checkpoint.visibleText.includes(checkpoint.teaching.question.text));
});

test("both planning entrances specify independent MAIC quizzes and repair missing quiz content", async () => {
  const check = content => assert.match(content, /Quiz pages MUST include quiz:/);
  check(await dispatchChat(input.education));
  const page = JSON.parse(answer).pages[0];
  page.teaching = { pageType: "quiz", phase: "review", objective: "Greet", durationSeconds: 30, requiredObjects: [] };
  const quiz = { type: "quiz", questions: [{ id: "greeting", type: "single", question: "Which greeting?",
    options: [{ value: "A", label: "Hello" }, { value: "B", label: "Goodbye" }], answer: ["A"] }] };
  const slides = Array.from({ length: 4 }, () => JSON.parse(answer).pages[0]);
  const invalid = JSON.stringify({ title: "Greetings", pages: [...slides, page] });
  const requests = [];
  const result = await createSceneCoursePlan(input, async request => {
    check(request.system);
    requests.push(JSON.parse(request.messages[0].content));
    return { text: requests.length === 1 ? invalid : JSON.stringify({ title: "Greetings", pages: [slides[0], { ...page, visibleText: [], narration: "", quiz }, ...slides.slice(1)] }) };
  });
  assert.equal(requests.length, 2);
  assert.match(requests[1].repair.error, /Invalid scene course page 5 \(pages\[4\]\)\.quiz: quiz pageType requires independent MAIC quiz content/);
  assert.doesNotMatch(requests[1].repair.error, /teaching\.question: required/);
  assert.equal(requests[1].repair.previousOutput, invalid);
  assert.deepEqual(result.pages[1].quiz, quiz);
  assert.equal(result.pages[1].teaching.question, undefined);
});

test("stray quiz content does not suppress the required checkpoint question", () => {
  const page = JSON.parse(answer).pages[0];
  page.teaching = { pageType: "interactive", phase: "practice", objective: "Greet", durationSeconds: 30, requiredObjects: [] };
  page.quiz = { type: "quiz", questions: [{ id: "greeting", type: "short_answer", question: "Greet a friend", answer: ["Hello"] }] };
  assert.throws(() => parseSceneCoursePlan(JSON.stringify({ title: "Greetings", pages: [page] })), /teaching\.question: required/);
});

test("objective assessment cannot be planned as a custom checkpoint instead of MAIC Quiz", () => {
  const page = { ...JSON.parse(answer).pages[0], teaching: { pageType: "interactive", phase: "practice", objective: "Identify brother",
    durationSeconds: 40, requiredObjects: [], question: { text: "Which one is brother?", response: {
      kind: "single", options: ["mum", "dad", "brother", "sister"], answerIndices: [2],
    }, referenceAnswer: { summary: "brother", keyPoints: ["brother"] } } } };
  assert.throws(() => parseSceneCoursePlan(JSON.stringify({ title: "My Family", pages: [page] })), /objective.*pageType=quiz.*page\.quiz/i);
});

test("a Freeze activity cannot be silently replaced by a checkpoint template", async () => {
  const body = { title: "Freeze game", visibleText: ["Freeze!", "I love my mum."], visualIntent: "Family on four colored mats; Freeze sign", narration: "Music plays. Freeze, then say I love my mum.", teaching: { pageType: "slide", phase: "practice", objective: "Speak a full sentence", durationSeconds: 200, requiredObjects: ["mum", "dad", "mats"] } };
  const question = { text: "Say a complete sentence about mum.", response: { kind: "practice", options: [], answerIndices: [] } };
  const hybrid = { ...body, teaching: { ...body.teaching, pageType: "interactive", question } };
  assert.throws(() => parseSceneCoursePlan(JSON.stringify({ title: "Family", pages: [hybrid] })), /separate body activity/);
  const checkpoint = { title: "Your turn", visibleText: [], visualIntent: "MAIC checkpoint template", narration: "", teaching: { ...body.teaching, pageType: "interactive", durationSeconds: 40, requiredObjects: [], question } };
  const outputs = [JSON.stringify({ title: "Family", pages: [hybrid] }), JSON.stringify({ title: "Family", bodyPageLimit: 1, pages: [body, checkpoint] })];
  const plan = await createSceneCoursePlan(input, async () => ({ text: outputs.shift() }));
  assert.equal(plan.pages.length, 2);
  assert.deepEqual(plan.pages[0].visibleText, body.visibleText);
  assert.equal(plan.pages[0].narration, body.narration);
  assert.equal(plan.pages[1].narration, "");
});

test("rejects noncanonical Quiz option keys before image generation or approval", () => {
  const page = JSON.parse(answer).pages[0];
  const quiz = { ...page, visibleText: [], narration: "", teaching: { pageType: "quiz", phase: "review", objective: "Check", durationSeconds: 30, requiredObjects: [] }, quiz: { type: "quiz", questions: [{ id: "q", type: "single", question: "Which shape?", options: [{ value: "circle", label: "circle" }, { value: "square", label: "square" }], answer: ["circle"] }] } };
  assert.throws(() => parseSceneCoursePlan(JSON.stringify({ title: "Shapes", pages: [page, quiz] })), /options|answer values/);
});

test("scene normalization retains required effects and includes them in the page source hash", () => {
  const draft = { title: "Circle", pages: [{ title: "Circle", visibleText: ["Circle"], visualIntent: "A red circle", narration: "Look at the circle.",
    teaching: { pageType: "slide", phase: "opening", objective: "See circle", durationSeconds: 30, requiredObjects: ["circle"], requiredEffects: ["spotlight", "highlight", "animation"] } }] };
  const first = parseSceneCoursePlan(JSON.stringify(draft));
  assert.deepEqual(first.pages[0].teaching.requiredEffects, draft.pages[0].teaching.requiredEffects);
  assert.equal(first.pages[0].sourceHash, "sha256:" + createHash("sha256").update(JSON.stringify(draft.pages[0])).digest("hex"));
  draft.pages[0].teaching.requiredEffects = ["highlight"];
  const changed = parseSceneCoursePlan(JSON.stringify(draft));
  assert.notEqual(first.pages[0].sourceHash, changed.pages[0].sourceHash);
  assert.equal(changed.pages[0].pageId, first.pages[0].pageId);
});
