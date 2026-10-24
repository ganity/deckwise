import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";

register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const { api } = await import("../src/lib/api.ts");
const { createInitialState } = await import("../src/stores/slices/initial-state.ts");
const { createSessionSlice } = await import("../src/stores/slices/session-slice.ts");
const { createSessionRuntime } = await import("../src/stores/runtime/session-runtime.ts");
const { createSessionCoordination } = await import("../src/stores/runtime/session-coordination.ts");
const drafts = await import("../src/lib/composer-draft-cache.ts");

function fixture(t) {
  drafts.resetComposerDraftCache();
  t.after(() => drafts.resetComposerDraftCache());
  const calls = [];
  const state = { ...createInitialState(), workspace: { path: "/workspace" }, activeProjectPath: "/workspace" };
  const access = { get: () => state, set: update => Object.assign(state, typeof update === "function" ? update(state) : update) };
  const runtime = createSessionRuntime(access);
  const deps = { ...access, runtime, decorateSessions: sessions => sessions, untitledTaskTitle: () => "New courseware" };
  const coordination = createSessionCoordination(deps);
  const slice = createSessionSlice({ ...deps, ...coordination });
  t.mock.method(api, "createSession", async input => {
    calls.push(["create", input]);
    return { session: { id: "created", title: input.title, projectPath: input.projectPath, mode: input.mode } };
  });
  t.mock.method(api, "coursewareTaskSet", async (...args) => { calls.push(["task", ...args]); return {}; });
  return { state, runtime, slice, calls };
}

const courseware = { taskType: "scene", educationContext: { schoolStage: "primary", grade: "Grade 3" }, initialPrompt: "  Fractions\nwith lively narration.  " };

test("task creation persists teaching settings before handing the exact unsent brief to the owning Chat", async t => {
  const f = fixture(t);
  await f.slice.newSession({ projectPath: "/workspace", courseware });
  assert.equal(f.calls[0][1].mode, "agent");
  assert.deepEqual(f.calls[1], ["task", "created", "scene", courseware.educationContext]);
  assert.equal(f.state.activeSessionId, "created");
  assert.deepEqual(f.state.composerPrefill, { sessionId: "created", text: courseware.initialPrompt, fileReferences: [] });
  assert.deepEqual(f.state.messages, []);
  assert.deepEqual(f.state.runningSessions, {});
});

test("an initial brief preserves home attachments and other text rather than discarding them", async t => {
  const f = fixture(t);
  const file = { path: "/workspace/material.pdf", name: "material.pdf", kind: "file" };
  drafts.writeComposerDraft(drafts.HOME_DRAFT_KEY, { text: "Use this material.", fileReferences: [file] });
  await f.slice.newSession({ projectPath: "/workspace", courseware });
  assert.deepEqual(f.state.composerPrefill, { sessionId: "created", text: `${courseware.initialPrompt}\n\nUse this material.`, fileReferences: [file] });
});

test("blank or duplicate briefs do not erase or duplicate an existing composer draft", async t => {
  const f = fixture(t);
  drafts.writeComposerDraft(drafts.HOME_DRAFT_KEY, { text: courseware.initialPrompt, fileReferences: [] });
  await f.slice.newSession({ projectPath: "/workspace", courseware });
  assert.equal(f.state.composerPrefill.text, courseware.initialPrompt);
  f.state.composerPrefill = null;
  await f.slice.newSession({ projectPath: "/workspace", courseware: { ...courseware, initialPrompt: " \n " } });
  assert.equal(f.state.composerPrefill, null);
});

test("a failed task save never activates an unconfigured courseware Chat or loses the home draft", async t => {
  const f = fixture(t);
  drafts.writeComposerDraft(drafts.HOME_DRAFT_KEY, { text: "Material notes", fileReferences: [] });
  t.mock.method(api, "coursewareTaskSet", async () => { throw new Error("Task save failed"); });
  await assert.rejects(f.slice.newSession({ projectPath: "/workspace", courseware }), /Task save failed/);
  assert.equal(f.state.activeSessionId, undefined);
  assert.equal(f.state.composerPrefill, null);
  assert.equal(f.state.sessions[0].id, "created");
  assert.equal(drafts.readComposerDraft(drafts.HOME_DRAFT_KEY).text, "Material notes");
});

test("navigation during creation cannot install a brief into another Chat", async t => {
  const f = fixture(t);
  let release;
  t.mock.method(api, "coursewareTaskSet", () => new Promise(resolve => { release = resolve; }));
  const creating = f.slice.newSession({ projectPath: "/workspace", courseware });
  await new Promise(resolve => setImmediate(resolve));
  assert(release);
  f.runtime.beginNavigationIntent();
  f.state.activeSessionId = "peer";
  release({}); await creating;
  assert.equal(f.state.activeSessionId, "peer");
  assert.equal(f.state.composerPrefill, null);
  assert.equal(f.state.sessions[0].id, "created");
});
