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
  importDialog,
  authSession,
  authIpc,
  protocol,
  rendererApi,
  toolDisplay,
  toolRow,
  composer,
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
  read("../src/components/workpanel/CoursewareImportDialog.tsx"),
  read("../electron/main/auth-session.ts"),
  read("../electron/main/ipc/auth-ipc.ts"),
  read("../../../packages/shared/src/protocol.ts"),
  read("../src/lib/api.ts"),
  read("../src/lib/tool-display.ts"),
  read("../src/features/chat/transcript/ToolRow.tsx"),
  read("../src/components/Composer.tsx"),
]);

test("DeckWise only accepts PPTX courseware tasks and routes the selected skill", () => {
  assert.match(prompts, /specialized PPTX courseware creation agent/);
  assert.match(prompts, /not a general-purpose chat or coding assistant/);
  assert.match(prompts, /unrelated to creating or modifying PPTX courseware/);
  assert.match(agentIpc, /function deckWiseModelPrompt/);
  assert.match(agentIpc, /resolveCoursewareRoute/);
  assert.match(agentIpc, /courseware\.task\.get/);
  assert.match(agentIpc, /taskType === "scene"/);
  assert.match(agentIpc, /content: deckWiseModelPrompt\(req\.content\)/);
  assert.match(agentIpc, /const modelContent = deckWiseModelPrompt\(/);
  assert.match(agentIpc, /never mention Pi, PPT Master, skill ids/);
  assert.match(composer, /isInternalCoursewareModelLabel/);
  assert.match(composer, /t\("chat\.coursewareAssistant"\)/);
  assert.match(skill, /Keep implementation details private/);
  assert.match(toolDisplay, /isCoursewareInternalToolCall/);
  assert.match(toolDisplay, /课件处理流程/);
  assert.match(toolRow, /!internalCoursewareTool/);
});

test("home quick starts prefill the composer without auto-sending", () => {
  assert.match(chatSurface, /setQuickstartPrefill\(\{ text: prompt, token:/);
  assert.match(chatSurface, /<StableComposer variant="home" prefill=\{quickstartPrefill\}/);
  assert.match(chatSurface, /小学三年级数学制作《认识分数》/);
  assert.match(chatSurface, /约 15 页/);
  assert.match(chatSurface, /清新插画风/);
});

test("the workbench keeps the three task choices separate and loads the saved choice", () => {
  assert.match(panel, /coursewareTaskGet\(activeSession\.id\)/);
  assert.match(panel, /coursewareTaskSet\(activeSession\.id, next, education\)/);
  assert.match(panel, /setEducation\(task\?\.educationContext \?\? \{\}\)/);
  assert.match(panel, /保存教学设置/);
  assert.match(panel, /全英文教学/);
  for (const field of ["textbookVersion", "chapter", "lessonType"]) assert.match(panel, new RegExp(`education\\.${field}`));
  assert.match(agentIpc, /Teaching settings:/);
  assert.match(agentIpc, /For kindergarten English, use 0–2 short English expressions/);
  for (const label of ["普通 PPT 生成", "场景式课件生成", "已有 PPT 导入"]) {
    assert.ok(panel.includes(label));
  }
  assert.match(panel, /CoursewareScenePlanPanel/);
  assert.match(panel, /task\?\.generatedPath/);
  assert.match(panel, /打开场景课件 PPT/);
  assert.match(panel, /coursewareImportPptx\(sessionId, picked\.token\)/);
  assert.match(panel, /打开已导入 PPT/);
});

test("PPT Master asks only for genuinely missing input in at most three rounds", () => {
  assert.match(skill, /inspect the user's prompt and attached documents/);
  assert.match(skill, /at most three rounds/);
  assert.match(skill, /One `asktool` call is one clarification round/);
  assert.match(skill, /never ask extra questions merely to use the remaining rounds/);
  assert.match(skill, /proceed with conservative assumptions/);
  assert.match(skill, /do not claim completion until both official checks exit 0/);
  assert.match(skill, /project_manager\.py validate <project_path>/);
  assert.match(skill, /notes\/total\.md must cover every page/);
});

test("fixed-identity design sheets guide new scene generation instead of slide placement", () => {
  assert.match(skill, /reference-only inputs before planning/);
  assert.match(skill, /Do not place or crop the original sheet/);
  assert.match(skill, /reference_images/);
  assert.match(skill, /single scene/);
  assert.match(skill, /explicitly asks to display the original/);
  assert.match(skill, /generation fails/);
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

test("a new task never inherits another task's courseware project", () => {
  assert.match(panel, /const projectPath = useMemo\(\(\) => referencedProject\(messages\), \[messages\]\)/);
  assert.match(panel, /if \(!projectPath\) return;/);
  assert.doesNotMatch(panel, /listDir\("\.deckwise-ppt\/projects"\)/);
});

test("SVG preview opens in Browser and waits for explicit PPTX generation", () => {
  assert.match(skill, /call ToolSearch for `browser`/);
  assert.match(skill, /Browser with `action=navigate`/);
  assert.match(skill, /Do not finalize or export PPTX until the user explicitly requests/);
  assert.match(panel, /生成 PPT/);
  assert.match(panel, /sendPrompt\(PPTX_EXPORT_PROMPT/);
  assert.doesNotMatch(panel, /当前产物|开始生成/);
});

test("the workbench blocks PPTX export while the generated pages fail the final quality gate", () => {
  assert.match(panel, /svg_quality_report\.json/);
  assert.match(panel, /report\.summary\?\.errors !== 0/);
  assert.match(panel, /notes\.find\(.*total\.md/);
  assert.match(panel, /!project\?\.qualityIssue/);
  assert.match(panel, /继续修复生成结果/);
  assert.match(panel, /不要新建项目或丢弃现有页面/);
});

test("Office edits supersede SVG generation candidates", () => {
  assert.match(skill, /Once Office editing starts/);
  assert.match(skill, /load deckwise\/ppt-edit/);
  assert.match(skill, /Never supersede Office edits with an older SVG export/);
  assert.match(panel, /latestInputMtime > pptx\.mtimeMs/);
  assert.match(panel, /重新生成 PPT/);
  assert.match(panel, /正在根据最新页面生成新版本 PPT/);
});

test("completed PPTX projects can be published with education metadata", () => {
  assert.match(panel, /<CoursewareImportDialog/);
  assert.match(panel, /发布到教学平台/);
  assert.match(importDialog, /firstLessonPlan/);
  assert.match(importDialog, /account\.dictionaries\?\.grades/);
  assert.match(importDialog, /account\.dictionaries\?\.subjects/);
  assert.match(importDialog, /detailLevel/);
  assert.match(importDialog, /api\.importCourseware/);
  assert.match(protocol, /coursewareImport:\s*"deckwise\/courseware\/import"/);
  assert.match(rendererApi, /importCourseware/);
  assert.match(authIpc, /assertMainWindowSender/);
  assert.match(authSession, /\/courses\/presign/);
  assert.match(authSession, /skipMaterial:\s*"true"/);
  assert.match(authSession, /\/courses\/courseware-import-tasks/);
  assert.match(authSession, /sourceMaterial/);
  assert.match(authSession, /lessonPlan/);
  assert.match(authSession, /schoolStage:\s*"primary"/);
});

test("team projects use authenticated Desktop transport and appear in the work panel", async () => {
  assert.match(protocol, /coursewareTeamProjects:\s*"deckwise\/courseware\/team\/projects"/);
  assert.match(protocol, /coursewareTeamProjectCreate:\s*"deckwise\/courseware\/team\/project\/create"/);
  assert.match(protocol, /coursewareTaskBindTeam:\s*"deckwise\/courseware\/task\/bind-team"/);
  assert.match(protocol, /coursewareFixedShare:\s*"deckwise\/courseware\/fixed\/share"/);
  assert.match(authIpc, /assertMainWindowSender\(event\)[\s\S]*coursewareMedia\.getTeamProjects\(\)/);
  assert.match(rendererApi, /coursewareTeamProjects:\s*\(\)\s*=>\s*invoke<CoursewareTeamProject\[]>\(IPC\.invoke\.coursewareTeamProjects\)/);
  const workPanel = await read("../src/components/workpanel/WorkPanel.tsx");
  assert.match(workPanel, /toolWorkPanelTab\("team"\)/);
  assert.match(workPanel, /activeTab\?\.kind === "team"/);
  const teamTab = await read("../src/components/workpanel/TeamProjectsTab.tsx");
  assert.match(teamTab, /api\.coursewareTeamProjects\(\)/);
  assert.match(teamTab, /api\.coursewareTeamProjectCreate\(\)/);
  assert.match(await read("../src/components/workpanel/CoursewarePlaybackPanel.tsx"), /coursewareFixedShare\(build\.previewId, teamProjectId, sessionId, teamChannel\)/);
  assert.match(teamTab, /api\.coursewareTeamPlay\(project\.projectId, playChannel, "zh-CN"\)/);
  assert.match(teamTab, /OWNER: "创建者"/);
  assert.match(teamTab, /VIEWER: "只读"/);
  const playbackIpc = await read("../electron/main/ipc/courseware-playback-ipc.ts");
  assert.match(playbackIpc, /IPC\.invoke\.coursewareTeamPlay/);
  assert.match(playbackIpc, /uploadAndPublishFixedBuild/);
  const playbackPanel = await read("../src/components/workpanel/CoursewarePlaybackPanel.tsx");
  assert.match(playbackPanel, /api\.coursewareFixedShare\(build\.previewId, teamProjectId, sessionId, teamChannel\)/);
  assert.match(playbackIpc, /courseware\.snapshot\.onlineOrigin/);
  assert.match(playbackIpc, /courseware\.fixedShare\.prepare/);
  assert.match(playbackIpc, /courseware\.fixedShare\.complete/);
  assert.match(playbackIpc, /courseware\.fixedShare\.get/);
  assert.match(playbackIpc, /queryFixedBuildPublication/);
  assert.doesNotMatch(playbackIpc, /host\.call\("courseware\.task\.bindTeam"/);
  const player = await read("../electron/main/courseware-player-preview.ts");
  assert.match(player, /downloadTeamFixedFile/);
  assert.match(player, /downloadUrl: ""/);
});
