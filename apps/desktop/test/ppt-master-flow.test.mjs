import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (path) => readFile(new URL(path, import.meta.url), "utf8");
const [
  panel,
  queue,
  events,
  skill,
  prompts,
  agentIpc,
  chatSurface,
  settingsPage,
  settingsSearch,
  projectsPage,
  sessionIpc,
  desktopMain,
  pluginServices,
  pluginRuntime,
  hostMain,
  marketplaceCatalog,
  ignoreRules,
] = await Promise.all([
  read("../src/components/workpanel/PptMasterTab.tsx"),
  read("../src/stores/slices/queue-slice.ts"),
  read("../src/stores/slices/events-slice.ts"),
  read("../electron/main/builtin-skills.ts"),
  read("../../../packages/agent-runtime/src/mode-prompts.ts"),
  read("../electron/main/ipc/agent-ipc.ts"),
  read("../src/components/ChatSurface.tsx"),
  read("../src/features/settings/SettingsPage.tsx"),
  read("../src/lib/settings-search.ts"),
  read("../src/pages/ProjectsPage.tsx"),
  read("../electron/main/ipc/session-ipc.ts"),
  read("../electron/main/index.ts"),
  read("../electron/main/services/plugin-services.ts"),
  read("../electron/main/plugin-runtime.ts"),
  read("../../../crates/host-core/src/main.rs"),
  read("../../../crates/host-core/src/plugins/marketplace/catalog.rs"),
  read("../../../crates/host-core/src/tools/ignore_rules.rs"),
]);

test("DeckWise only accepts PPTX courseware tasks and loads PPT Master", () => {
  assert.match(prompts, /specialized PPTX courseware creation agent/);
  assert.match(prompts, /not a general-purpose chat or coding assistant/);
  assert.match(prompts, /unrelated to creating or modifying PPTX courseware/);
  assert.match(agentIpc, /function deckWiseModelPrompt/);
  assert.match(agentIpc, /PPT_MASTER_SKILL_ID/);
  assert.match(agentIpc, /content: deckWiseModelPrompt\(req\.content\)/);
  assert.match(agentIpc, /const modelContent = deckWiseModelPrompt\(/);
});

test("home quick starts prefill the composer without auto-sending", () => {
  assert.match(chatSurface, /setQuickstartPrefill\(\{ text: prompt, token:/);
  assert.match(chatSurface, /<StableComposer variant="home" prefill=\{quickstartPrefill\}/);
});

test("settings do not expose agent behavior customization", () => {
  for (const id of ["instructions", "skills", "mcp", "subagents"]) {
    assert.doesNotMatch(settingsSearch, new RegExp(`id: "${id}"`));
    assert.doesNotMatch(settingsPage, new RegExp(`tab === "${id}"`));
  }
  assert.doesNotMatch(settingsPage, /settings\.modePlan|settings\.modeGoal|defaultMode: value/);
  assert.doesNotMatch(projectsPage, /ProjectInstructionsDialog|project\.editInstructions/);
});

test("DeckWise startup skips native Pi history and uses its own data directory", () => {
  assert.doesNotMatch(sessionIpc, /native\.session\.list/);
  for (const source of [
    desktopMain,
    pluginServices,
    pluginRuntime,
    hostMain,
    marketplaceCatalog,
    ignoreRules,
  ]) {
    assert.match(source, /\.deckwise/);
    assert.doesNotMatch(source, /join\([^\n]*["']\.pi-desktop["']/);
  }
});

test("PPT tasks open PPT Master without workspace edits opening Review", () => {
  assert.match(queue, /openWorkPanelTabForSession\(startedIn, toolWorkPanelTab\("ppt"\)\)/);
  assert.doesNotMatch(events, /shouldOpenReviewArtifact|toolWorkPanelTab\("review"\)/);
});

test("SVG preview opens in Browser and waits for explicit PPTX generation", () => {
  assert.match(skill, /call ToolSearch for `browser`/);
  assert.match(skill, /Browser with `action=navigate`/);
  assert.match(skill, /Do not finalize or export PPTX until the user explicitly requests/);
  assert.match(panel, /生成 PPTX/);
  assert.match(panel, /sendPrompt\(PPTX_EXPORT_PROMPT/);
  assert.doesNotMatch(panel, /当前产物|开始生成/);
});

test("delivered PPT projects revise SVG as the only source and export a new PPTX", () => {
  assert.match(skill, /SVG is the only source of truth/);
  assert.match(skill, /official Revision Round/);
  assert.match(skill, /immediately create a new timestamped PPTX export/);
  assert.match(skill, /Never read changes back from a PPTX/);
  assert.match(panel, /latestSvgMtime > pptx\.mtimeMs/);
  assert.match(panel, /重新生成 PPTX/);
  assert.match(panel, /正在根据最新 SVG 生成新版本 PPTX/);
});
