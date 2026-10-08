import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";

function load(relative, imports) {
  const file = new URL(relative, import.meta.url);
  const { outputText } = ts.transpileModule(readFileSync(file, "utf8"), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
    fileName: file.pathname,
  });
  const module = { exports: {} };
  new Function("require", "exports", "module", outputText)((id) => {
    assert.ok(Object.hasOwn(imports, id), `unexpected dependency: ${id}`);
    return imports[id];
  }, module.exports, module);
  return module.exports;
}

const i18n = { default: { t: (key) => key } };
const { createSessionSlice } = load("../src/stores/slices/session-slice.ts", {
  i18next: i18n,
  "../runtime/transcript-action": {},
  "../../lib/plan-mode-state": {},
  "../../lib/session-create": { sessionIsReusableEmpty: () => true },
  "../../lib/session-panes": {},
  "../../lib/sidebar-session-groups": { sessionMatchesProject: () => true },
  "../../lib/sidebar-preferences": {},
  "../../lib/api": { api: {} },
  "../../lib/refresh-coordinator": { createRefreshCoordinator: (fn) => fn },
  "../../lib/session-thinking": {},
  "../../lib/session-transcript": {},
  "./work-panel-slice": {},
});
const created = [];
const { createSessionCoordination } = load("../src/stores/runtime/session-coordination.ts", {
  i18next: i18n,
  "@pi-desktop/shared": { initialThinkingLevelForBinding: () => "off", normalizeMode: () => "agent" },
  "../../lib/api": { api: { createSession: async (input) => {
    created.push(input);
    throw new Error("creation reached");
  } } },
  "../../lib/composer-draft-cache": {},
  "../../lib/session-fork": {},
  "../../lib/session-create": {},
  "../../lib/session-panes": { clearSessionPanes: () => ({}) },
  "../../lib/sidebar-preferences": {},
  "../slices/work-panel-slice": { switchWorkPanelSession: () => ({}) },
});
const prompts = [];
const { createQueueSlice } = load("../src/stores/slices/queue-slice.ts", {
  i18next: i18n,
  "../../lib/api": { api: { prompt: async (input) => prompts.push(input) } },
  "../../lib/queued-prompts": {},
  "../../lib/session-transcript": { optimisticUserMessage: (id, content) => ({ id, content }) },
  "../../lib/work-panel-tabs": { toolWorkPanelTab: (id) => ({ id }) },
});

function fixture(overrides = {}) {
  const notices = [];
  const state = {
    activeSessionId: null, workspace: null, sessions: [], providers: [], page: "chat", retainedSessionIds: [],
    pendingPlans: {}, runningSessions: {}, messages: [], latestTurnResults: {}, sessionOutcomes: {},
    showToast: (text) => notices.push(text),
    openProject: async () => { state.createProjectDialogOpen = true; },
    clearProject: () => assert.fail("rejection must preserve the current workspace"),
    openWorkPanelTabForSession: (sessionId, tab) => { state.openedPanel = { sessionId, tab }; },
    ...overrides,
  };
  const deps = {
    get: () => state,
    set: (update) => Object.assign(state, typeof update === "function" ? update(state) : update),
    runtime: {
      beginNavigationIntent: () => 1,
      navigationIntentIsCurrent: () => true,
      newSessionScopeKey: (path) => path,
      pendingNewSessionRequests: new Map(),
      latestSessionInScope: () => state.sessions[0],
      liveMessageCountForSession: () => 0,
      submittedComposerDrafts: new Map(),
      insertOptimisticUserMessage: (_, message) => state.messages.push(message),
    },
    promptAttachmentsFromDraft: () => [],
    untitledTaskTitle: () => "New courseware",
    withoutRecordKey: (record) => record,
    isDefaultSessionTitle: () => false,
    viewingSessionIdForPrompt: () => null,
    persistSessionAndSelect: () => assert.fail("temporary session must not be persisted"),
    materializeDraftSession: () => assert.fail("temporary session must not be materialized"),
  };
  return { state, deps, notices };
}

test("New Task refuses path-less sessions before clearing a project or reusing old temporary history", async () => {
  const home = fixture();
  await createSessionSlice(home.deps).newSession();
  assert.equal(home.state.createProjectDialogOpen, true);
  for (const projectPath of [null, "", "   "]) {
    const f = fixture({ workspace: { path: "/course" }, sessions: [{ id: "old", projectPath: null }] });
    await createSessionSlice(f.deps).newSession({ projectPath });
    assert.equal(f.state.workspace.path, "/course");
    assert.equal(f.state.createProjectDialogOpen, true);
    assert.deepEqual(f.notices, ["chat.projectRequired"]);
  }
});

test("home send and attachment materialization refuse scratch creation; selecting a project enables creation", async () => {
  const f = fixture();
  const coordination = createSessionCoordination(f.deps);
  created.length = 0;
  f.deps.materializeDraftSession = coordination.materializeDraftSession;
  assert.equal(await createQueueSlice(f.deps).sendPrompt("make slides"), false);
  assert.equal(f.state.messages.length, 0);
  assert.equal(await coordination.materializeDraftSession(), null);
  assert.equal(created.length, 0);
  assert.equal(f.state.createProjectDialogOpen, true);
  f.state.workspace = { path: "/course" };
  await assert.rejects(coordination.materializeDraftSession(), /creation reached/);
  assert.equal(created[0].projectPath, "/course");
});

test("old temporary sessions cannot send, queue, or steer even with another workspace open", async () => {
  for (const projectPath of [null, "", "   "]) {
    const f = fixture({ activeSessionId: "old", workspace: { path: "/other" }, sessions: [{ id: "old", projectPath }],
      runningSessions: { old: true }, agentStatuses: { old: { currentTurnId: "turn" } } });
    const queue = createQueueSlice(f.deps);
    for (const action of ["sendPrompt", "enqueuePrompt", "steerPrompt"]) {
      assert.equal(await queue[action]("make slides"), false);
      assert.equal(f.state.createProjectDialogOpen, true);
    }
    assert.equal(f.state.messages.length, 0);
    assert.equal(f.deps.runtime.submittedComposerDrafts.size, 0);
  }
});

test("project-bound courseware submission still starts the workbench and reaches the prompt API", async () => {
  const f = fixture({ activeSessionId: "course", sessions: [{ id: "course", projectPath: "/course" }] });
  prompts.length = 0;
  assert.equal(await createQueueSlice(f.deps).sendPrompt("make slides"), true);
  assert.equal(prompts[0].sessionId, "course");
  assert.equal(f.state.runningSessions.course, true);
  assert.equal(f.state.messages[0].content, "make slides");
  assert.deepEqual(f.state.openedPanel, { sessionId: "course", tab: { id: "ppt" } });
  assert.deepEqual(f.notices, []);
});
