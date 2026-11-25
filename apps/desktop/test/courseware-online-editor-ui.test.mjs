import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

const sources = await Promise.all(["CoursewareOnlineEditor", "TeamProjectsTab"].map(async name => [name,
  ts.transpileModule(await readFile(new URL(`../src/components/workpanel/${name}.tsx`, import.meta.url), "utf8"), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
  }).outputText]));
const output = Object.fromEntries(sources);
const flush = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve, reject; const promise = new Promise((done, fail) => { resolve = done; reject = fail; }); return { promise, resolve, reject }; };
const state = (ownerId, projectId = "project-owner", status = "ready") => ({ available: true, ownerId, projectId, status });

function fixture(name = "CoursewareOnlineEditor", options = {}) {
  const hooks = [], effects = [], calls = [], opens = [], reviews = [], confirmations = [], translations = [], online = new Set(), auth = new Set(), frames = new Map();
  let cursor = 0, tree, writes = 0, closed = 0, uuid = 0, frameId = 0;
  let memberRoster = [];
  const props = { projectId: "project-owner", sessionId: options.sessionId ?? "chat-1", manageTeachingPause: options.manageTeachingPause ?? false, onClose: () => { closed++; } };
  const projects = ["OWNER", "EDITOR", "VIEWER"].map(role => ({ projectId: `project-${role.toLowerCase()}`, role, ownerUserId: 1 }));
  const api = {
    async coursewareOnlineState() { calls.push(["state"]); return { available: options.available ?? true, ownerId: null, projectId: null, status: "closed" }; },
    coursewareOnlineOpen(ownerId, projectId) { calls.push(["open", ownerId, projectId]); const pending = deferred(); opens.push({ ownerId, projectId, ...pending }); return pending.promise; },
    async coursewareOnlineClose(ownerId) { calls.push(["close", ownerId]); },
    async coursewareOnlineSetVisible(ownerId, visible) { calls.push(["visible", ownerId, visible]); },
    async coursewareOnlineSetBounds(ownerId, bounds) { calls.push(["bounds", ownerId, bounds]); },
    onCoursewareOnlineState(listener) { online.add(listener); return () => online.delete(listener); },
    onAuthChanged(listener) { auth.add(listener); return () => auth.delete(listener); },
    async coursewareTeamProjects() { calls.push(["projects"]); return projects; },
    async coursewareTeamProjectCreate(title) {
      calls.push(["project-create", title]);
      projects.push({ projectId: "project-created", title, role: "OWNER", ownerUserId: 1 });
      return "project-created";
    },
    async coursewareTeamMembers(projectId) {
      calls.push(["members", projectId]);
      return [{ userId: 2, role: "OWNER" }, ...memberRoster];
    },
    async coursewareTeamMemberSearch(projectId, query) {
      calls.push(["member-search", projectId, query]);
      return [{ userId: 8, name: "Teacher", departmentName: "Math" }];
    },
    async coursewareTeamMemberGrant(projectId, userId, role) {
      calls.push(["member-grant", projectId, userId, role]);
      memberRoster = [{ userId, name: "Teacher", role }];
    },
    async coursewareTeamMemberRevoke(projectId, userId) {
      calls.push(["member-revoke", projectId, userId]);
      memberRoster = [];
    },
    coursewareOnlinePrepareReview(request) { calls.push(["review", request]); const pending = deferred(); reviews.push({ request, ...pending }); return pending.promise; },
    coursewareOnlinePrepareConfirm(request) { calls.push(["confirm", request]); const pending = deferred(); confirmations.push({ request, ...pending }); return pending.promise; },
    async coursewareOnlinePrepareCancel(request) { calls.push(["cancel", request]); return { ok: true }; },
    async coursewareOnlineBarrierRead(ownerId) { calls.push(["source-barrier", ownerId]); return options.barrier ? options.barrier(ownerId) : { ownerId, state: "held", teachingPaused: true, uncertain: false }; },
    async coursewareOnlineSourceBegin(request) { calls.push(["source-begin", request]); return options.sourceBegin ? options.sourceBegin(request) : { ownerId: request.ownerId, viewId: "source-view", original: { project: { projectId: "project-owner", pages: [] } }, previousPages: [{ pageId: "old-1", pageNumber: 2, objects: [] }], targetPages: [{ importPageId: "target-1", pageNumber: 3, objects: [] }] }; },
    async coursewareOnlineSourceResolve(request) { calls.push(["source-resolve", request]); return options.sourceResolve ? options.sourceResolve(request) : { ownerId: opens[0].ownerId, viewId: request.viewId, status: "reviewed", readyPages: 1, totalPages: 1 }; },
    async coursewareOnlineSourcePreview(request) { calls.push(["source-preview", request]); return { image: "data:image/png;base64,iVBORw0KGgo=" }; },
    async coursewareOnlineSourceClear(request) { calls.push(["source-clear", request]); if (options.sourceClear) return options.sourceClear(request); return { ok: true }; },
    async coursewareFixedCancel() { calls.push(["fixed-cancel"]); if (options.fixedCancel) return options.fixedCancel(); return { ok: true }; },
  };
  const exports = {};
  new Function("require", "exports", "crypto", "ResizeObserver", "window", "requestAnimationFrame", "cancelAnimationFrame", output[name])(id => {
    if (id === "../../lib/api") return { api };
    if (id === "react-i18next") return { useTranslation: () => ({ t: (key, values) => { translations.push([key, values]); return key; } }) };
    if (id === "./CoursewareOnlineEditor") return { CoursewareOnlineEditor: "OnlineEditorShell" };
    if (id === "./CoursewareGroupPanel") return { CoursewareGroupPanel: "GroupPanel" };
    if (id === "./CoursewareTeamAssignment") return { CoursewareTeamAssignment: "TeamAssignment" };
    if (id === "../../stores/app-store") return { useAppStore: selector => selector({ activeSessionId: props.sessionId }) };
    if (id === "./CoursewareOnlineSourceReview") return { CoursewareOnlineSourceReview: "SourceReview" };
    if (id === "./CoursewarePlaybackPanel") return { CoursewarePlaybackPanel: "PlaybackPanel" };
    if (id === "./CoursewareOnlineBarrierPanel") return { CoursewareOnlineBarrierPanel: "OnlineBarrierPanel" };
    if (id === "./CoursewareOnlinePauseRecovery") return { CoursewareOnlinePauseRecovery: "OnlinePauseRecovery" };
    if (id === "./WorkTabEmpty") return { WorkTabEmpty: "Empty" };
    if (id === "../icons") return { IconFolderOpen: "Folder", IconPlay: "Play", IconRefresh: "Refresh" };
    if (id === "react") return {
      useState(initial) { const index = cursor++; if (!(index in hooks)) hooks[index] = initial;
        return [hooks[index], value => { writes++; hooks[index] = typeof value === "function" ? value(hooks[index]) : value; }]; },
      useRef(initial) { const index = cursor++; return hooks[index] ??= { current: initial }; },
      useCallback(callback, dependencies) { const index = cursor++, previous = hooks[index];
        if (!previous || dependencies.some((value, i) => value !== previous.dependencies[i])) hooks[index] = { dependencies, callback };
        return hooks[index].callback; },
      useEffect(effect, dependencies) { const index = cursor++, previous = hooks[index];
        if (!previous || dependencies.some((value, i) => value !== previous.dependencies[i]))
          effects.push(() => { previous?.cleanup?.(); hooks[index] = { dependencies, cleanup: effect() }; });
      },
    };
    assert.equal(id, "react/jsx-runtime");
    return { jsx: (type, props) => ({ type, props }), jsxs: (type, props) => ({ type, props }) };
  }, exports, { randomUUID: () => `owner-${++uuid}` }, class { observe() {} disconnect() {} },
  { addEventListener() {}, removeEventListener() {} }, callback => { const id = ++frameId; frames.set(id, callback); return id; }, id => frames.delete(id));
  const nodes = () => { const out = []; const visit = node => { if (Array.isArray(node)) return node.forEach(visit);
    if (!node || typeof node !== "object") return; out.push(node); visit(node.props?.children); }; visit(tree); return out; };
  const render = () => { cursor = 0; tree = exports[name](props);
    for (const node of nodes()) if (node.props?.ref) node.props.ref.current ??= { getBoundingClientRect: () => ({ x: 10, y: 20, width: 800, height: 500 }) };
    while (effects.length) effects.shift()(); };
  const settle = async () => { await flush(); render(); render(); };
  const button = key => nodes().find(node => node.type === "button" && node.props.children === `panel.onlineEditing.${key}`);
  const unmount = () => { for (const hook of hooks) hook?.cleanup?.(); };
  render(); render();
  return { api, props, calls, opens, reviews, confirmations, translations, nodes, render, settle, button, unmount, projects,
    event: value => { for (const listener of online) listener(value); },
    auth: () => { for (const listener of [...auth]) listener(); },
    frames: () => { for (const [id, callback] of [...frames]) { frames.delete(id); callback(); } },
    status: () => nodes().find(node => node.props?.role === "status")?.props.children,
    writes: () => writes, closed: () => closed };
}

test("owner names a team project, grants a searched member permission, then revokes it", async () => {
  const f = fixture("TeamProjectsTab");
  await f.settle();
  const button = (key) => f.nodes().find(node => node.type === "button" && node.props.children === `panel.teamMembers.${key}`);
  button("createProject").props.onClick();
  f.render();
  f.nodes().find(node => node.type === "input").props.onChange({ target: { value: "Fractions" } });
  f.render();
  f.nodes().find(node => node.type === "form").props.onSubmit({ preventDefault() {} });
  await f.settle();
  assert(f.calls.some(call => call[0] === "project-create" && call[1] === "Fractions"));
  const row = f.nodes().filter(node => node.type === "article").at(-1);
  assert.equal(row.props.children[0].props.children[0].props.children, "Fractions");
  const manage = row.props.children.find(node => node?.props?.className === "team-project-members").props.children[0];
  manage.props.onClick();
  await f.settle();
  const input = f.nodes().find(node => node.type === "input" && node.props.type === "search");
  input.props.onChange({ target: { value: "Teacher" } });
  f.render();
  f.nodes().find(node => node.type === "form" && node.props.className === "team-project-member-search")
    .props.onSubmit({ preventDefault() {} });
  await f.settle();
  assert(f.calls.some(call => call[0] === "member-search" && call[2] === "Teacher"));
  const candidate = f.nodes().find(node => node.type === "button" && node.props.children === "Teacher · Math · #8");
  candidate.props.onClick();
  f.render();
  button("grant").props.onClick();
  await f.settle();
  assert.deepEqual(f.calls.find(call => call[0] === "member-grant"), ["member-grant", "project-created", 8, "VIEWER"]);
  const member = () => f.nodes().find(node => node.type === "button" && node.props.children === "Teacher · #8 · panel.teamMembers.VIEWER");
  member().props.onClick();
  f.render();
  button("revoke").props.onClick();
  await f.settle();
  assert.deepEqual(f.calls.find(call => call[0] === "member-revoke"), ["member-revoke", "project-created", 8]);
  assert.equal(member(), undefined);
  f.unmount();
});

test("team list only offers eligible members an explicit join; return refreshes the same list", async () => {
  const f = fixture("TeamProjectsTab"); await f.settle();
  assert.equal(f.calls.filter(call => call[0] === "state").length, 1);
  assert.equal(f.calls.filter(call => call[0] === "open").length, 0);
  const rows = f.nodes().filter(node => node.type === "article");
  for (let index = 0; index < rows.length; index++) {
    const children = rows[index].props.children.flat();
    assert.equal(children.some(node => node?.type === "button" && node.props.children === "panel.onlineEditing.join"), index < 2);
  }
  const joins = f.nodes().filter(node => node.type === "button" && node.props.children === "panel.onlineEditing.join");
  joins[0].props.onClick(); joins[1].props.onClick(); f.render();
  const shell = f.nodes().find(node => node.type === "OnlineEditorShell");
  assert.equal(shell.props.projectId, "project-owner");
  assert.equal(shell.props.manageTeachingPause, true);
  shell.props.onClose(); await f.settle();
  assert(!f.nodes().some(node => node.type === "OnlineEditorShell"));
  assert.equal(f.calls.filter(call => call[0] === "projects").length, 2);
  f.unmount();
});

test("only an Owner's online editor offers teaching-pause recovery controls", async () => {
  const f = fixture("TeamProjectsTab"); await f.settle();
  const joins = f.nodes().filter(node => node.type === "button" && node.props.children === "panel.onlineEditing.join");
  joins[1].props.onClick(); f.render();
  assert.equal(f.nodes().find(node => node.type === "OnlineEditorShell").props.manageTeachingPause, false);
  f.unmount();
});

test("undeployed editor explains unavailability and never joins, including captured disabled handlers", async () => {
  const f = fixture("TeamProjectsTab", { available: false }); await f.settle();
  assert(f.nodes().some(node => node.props?.children === "panel.onlineEditing.unavailable"));
  assert.equal(f.button("join").props.disabled, true); f.button("join").props.onClick(); f.render();
  assert(!f.nodes().some(node => node.type === "OnlineEditorShell"));
  assert.equal(f.opens.length, 0); f.unmount();
});

test("team auth changes discard the open shell and refresh permissions", async () => {
  const f = fixture("TeamProjectsTab"); await f.settle(); f.button("join").props.onClick(); f.render();
  f.auth(); await f.settle();
  assert(!f.nodes().some(node => node.type === "OnlineEditorShell"));
  assert.equal(f.calls.filter(call => call[0] === "projects").length, 2); f.unmount();
});

test("a captured join from a previous account cannot reopen that account's project", async () => {
  const f = fixture("TeamProjectsTab"); await f.settle(); const previousJoin = f.button("join").props.onClick;
  f.auth(); previousJoin(); await f.settle();
  assert(!f.nodes().some(node => node.type === "OnlineEditorShell")); f.unmount();
});

test("desktop shell opens once, filters owner/project events, reports owned bounds and distinguishes sync from archive", async () => {
  const f = fixture(); assert.equal(f.opens.length, 1);
  const open = f.opens[0]; assert.equal(open.projectId, "project-owner");
  f.event(state("other-owner")); f.event(state(open.ownerId, "other-project")); f.render();
  assert.equal(f.status(), "panel.onlineEditing.opening");
  open.resolve(state(open.ownerId)); await f.settle(); assert.equal(f.status(), "panel.onlineEditing.ready");
  f.frames(); assert.deepEqual(f.calls.find(call => call[0] === "bounds"), ["bounds", open.ownerId, { x: 10, y: 20, width: 800, height: 500 }]);
  f.event(state(open.ownerId, open.projectId, "sync-pending")); f.render(); assert.equal(f.status(), "panel.onlineEditing.syncPending");
  f.event(state(open.ownerId, open.projectId, "sync-reported")); f.render(); assert.equal(f.status(), "panel.onlineEditing.syncReported");
  assert(!f.nodes().some(node => node.type === "button" && /save|publish/i.test(String(node.props.children))));
  f.button("back").props.onClick(); assert.equal(f.closed(), 1);
  f.unmount(); assert(f.calls.some(call => call[0] === "close" && call[1] === open.ownerId));
  assert(f.calls.some(call => call[0] === "visible" && call[1] === open.ownerId && call[2] === false));
});

test("unmount cancels a pending join immediately and late open/event cannot update or reveal a view", async () => {
  const f = fixture(), open = f.opens[0]; f.unmount();
  assert(f.calls.some(call => call[0] === "close" && call[1] === open.ownerId));
  const writes = f.writes(); open.resolve(state(open.ownerId)); f.event(state(open.ownerId)); await flush(); f.frames();
  assert.equal(f.writes(), writes);
  assert(!f.calls.some(call => call[0] === "visible" && call[2] === true));
});

test("errors stay generic; explicit retry closes the old owner and discards its late state", async () => {
  const f = fixture(), previous = f.opens[0]; previous.reject(new Error("secret-token https://private.invalid")); await f.settle();
  assert.equal(f.status(), "panel.onlineEditing.error");
  assert(!JSON.stringify(f.nodes()).includes("secret-token"));
  const retry = f.button("retry").props.onClick; retry(); retry(); f.render(); f.render();
  assert.equal(f.opens.length, 2); const next = f.opens[1]; assert.notEqual(next.ownerId, previous.ownerId);
  assert(f.calls.some(call => call[0] === "close" && call[1] === previous.ownerId));
  f.event(state(previous.ownerId)); f.render(); assert.equal(f.status(), "panel.onlineEditing.opening");
  next.resolve(state(next.ownerId)); await f.settle(); assert.equal(f.status(), "panel.onlineEditing.ready"); f.unmount();
});

test("fixed error states distinguish inactive and read-only sessions without displaying arbitrary server details", async () => {
  for (const [errorCode, key] of [["PLATFORM_46200", "inactive"], ["COURSEWARE_ONLINE_PLATFORM_46200", "inactive"], ["COURSEWARE_ONLINE_SESSION_INACTIVE", "inactive"],
    ["COURSEWARE_ONLINE_READ_ONLY", "readOnly"], ["COURSEWARE_ONLINE_ACCESS_CHANGED", "accessChanged"], ["token-private-url", "error"]]) {
    const f = fixture(), open = f.opens[0];
    f.event({ ...state(open.ownerId, open.projectId, "error"), errorCode }); f.render();
    assert(f.nodes().some(node => node.props?.role === "alert" && node.props.children === `panel.onlineEditing.${key}`));
    assert(!JSON.stringify(f.nodes()).includes(errorCode)); f.unmount();
  }
  const f = fixture(); f.opens[0].resolve({ available: false, ownerId: null, projectId: null, status: "closed" }); await f.settle();
  assert(f.nodes().some(node => node.props?.role === "alert" && node.props.children === "panel.onlineEditing.unavailable"));
  assert.equal(f.button("retry"), undefined); f.unmount();
});

test("account changes immediately close this client and fence late join responses", async () => {
  const f = fixture(), open = f.opens[0]; f.auth(); const writes = f.writes();
  assert.equal(f.closed(), 1); assert(f.calls.some(call => call[0] === "close" && call[1] === open.ownerId));
  open.resolve(state(open.ownerId)); f.event(state(open.ownerId)); await flush();
  assert.equal(f.writes(), writes); assert(!f.calls.some(call => call[0] === "visible" && call[2] === true)); f.unmount();
});

const reviewed = (extra = {}) => ({ reviewId: "review-1", projectId: "project-owner", sessionId: "chat-1", fileName: "Lesson.pptx",
  byteLength: 12345, sha256: "a".repeat(64), expectedEpoch: 7, replacesSource: true, ...extra });
const prepared = { projectId: "project-owner", sessionEpoch: 8, source: { revision: "uploaded-revision", sha256: "a".repeat(64) } };
const acknowledge = f => { f.nodes().find(node => node.type === "input" && node.props.type === "checkbox").props.onChange({ target: { checked: true } }); f.render(); };
async function reviewOwner(f, value = reviewed()) {
  f.button("prepare").props.onClick(); f.reviews.at(-1).resolve(value); await f.settle();
}

test("Owner preparation reviews without writes, requires explicit confirmation and reuses the ordinary editor shell", async () => {
  const f = fixture("TeamProjectsTab"); await f.settle();
  assert.equal(f.nodes().filter(node=>node.type==="button" && node.props.children==="panel.onlineEditing.prepare").length, 1);
  await reviewOwner(f);
  assert.deepEqual(f.reviews[0].request, { sessionId: "chat-1", projectId: "project-owner" });
  assert(f.nodes().some(node=>node.type==="dd" && node.props.children==="Lesson.pptx"));
  assert(f.nodes().some(node=>node.props?.children==="panel.onlineEditing.prepareReplacement"));
  assert(f.nodes().some(node=>node.props?.children==="panel.onlineEditing.preparePptxOnly"));
  assert.equal(f.button("prepareConfirm").props.disabled, true);
  f.button("prepareConfirm").props.onClick(); assert.equal(f.confirmations.length, 0);
  acknowledge(f); const confirm = f.button("prepareConfirm").props.onClick; confirm(); confirm(); f.render();
  assert.deepEqual(f.confirmations.map(value=>value.request), [{ reviewId: "review-1" }]);
  assert(!f.nodes().some(node=>node.type==="OnlineEditorShell"));
  f.confirmations[0].resolve(prepared); await f.settle();
  assert.equal(f.nodes().find(node=>node.type==="OnlineEditorShell").props.projectId, "project-owner");
  assert(!f.calls.some(call=>call[0]==="cancel")); f.unmount();
});

test("preparation is disabled without a current Chat or deployment even for captured handlers", async () => {
  for (const options of [{ available: false }, {}]) {
    const f = fixture("TeamProjectsTab", options); if (options.available !== false) { f.props.sessionId = undefined; f.render(); }
    await f.settle(); const button = f.button("prepare"); assert.equal(button.props.disabled, true);
    button.props.onClick(); assert.equal(f.reviews.length, 0); assert.equal(f.confirmations.length, 0); f.unmount();
  }
});

test("cancel discards a review and rejects captured confirmation; a late review is cancelled without being displayed", async () => {
  const f = fixture("TeamProjectsTab"); await f.settle(); await reviewOwner(f); acknowledge(f);
  const confirm = f.button("prepareConfirm").props.onClick;
  f.button("prepareCancel").props.onClick(); f.render(); confirm();
  assert.deepEqual(f.calls.filter(call=>call[0]==="cancel"), [["cancel", { reviewId: "review-1" }]]);
  assert.equal(f.confirmations.length, 0);
  f.button("prepare").props.onClick(); f.render(); const pending = f.reviews.at(-1);
  f.button("prepareCancel").props.onClick(); pending.resolve(reviewed({ reviewId: "late-review" })); await f.settle();
  assert(f.calls.some(call=>call[0]==="cancel" && call[1].reviewId==="late-review"));
  assert.equal(f.button("prepareConfirm"), undefined); f.unmount();
});

test("changing target projects cancels the old review and an old acknowledged handler cannot confirm the new file", async () => {
  const f = fixture("TeamProjectsTab"); await f.settle();
  f.projects.push({ projectId: "project-other", role: "OWNER", ownerUserId: 1 }); f.render();
  await reviewOwner(f); acknowledge(f); const oldConfirm = f.button("prepareConfirm").props.onClick;
  const buttons=f.nodes().filter(node=>node.type==="button" && node.props.children==="panel.onlineEditing.prepare");
  buttons[1].props.onClick(); f.reviews.at(-1).resolve(reviewed({ reviewId: "review-2", projectId: "project-other", fileName: "Other.pptx" })); await f.settle();
  assert(f.calls.some(call=>call[0]==="cancel" && call[1].reviewId==="review-1"));
  oldConfirm(); assert.equal(f.confirmations.length, 0);
  assert.equal(f.button("prepareConfirm").props.disabled, true);
  assert(f.nodes().some(node=>node.type==="dd" && node.props.children==="Other.pptx")); f.unmount();
});

test("account and Chat changes fence late review and confirmation results", async () => {
  for (const change of [f=>f.auth(), f=>{ f.props.sessionId="chat-2"; f.render(); }]) {
    const f=fixture("TeamProjectsTab"); await f.settle(); f.button("prepare").props.onClick();
    const pending=f.reviews[0]; change(f); pending.resolve(reviewed()); await f.settle();
    assert.equal(f.button("prepareConfirm"), undefined);
    assert(f.calls.some(call=>call[0]==="cancel" && call[1].reviewId==="review-1")); f.unmount();
    const g=fixture("TeamProjectsTab"); await g.settle(); await reviewOwner(g); acknowledge(g); g.button("prepareConfirm").props.onClick();
    change(g); g.confirmations[0].resolve(prepared); await g.settle();
    assert(!g.nodes().some(node=>node.type==="OnlineEditorShell")); g.unmount();
  }
});

test("active sessions only guide ordinary join and preparation failures do not disclose remote details or auto retry", async () => {
  for (const [message,key] of [["COURSEWARE_ONLINE_SESSION_ACTIVE", "prepareActive"], ["secret-token https://private.invalid/file.pptx", "prepareFailed"]]) {
    const f=fixture("TeamProjectsTab"); await f.settle(); f.button("prepare").props.onClick();
    f.reviews[0].reject(new Error(message)); await f.settle();
    assert(f.nodes().some(node=>node.props?.role==="alert" && node.props.children===`panel.onlineEditing.${key}`));
    assert.equal(f.confirmations.length,0); assert.equal(f.opens.length,0);
    assert(!JSON.stringify(f.nodes()).includes("secret-token")); assert(f.button("join")); f.unmount();
  }
});

test("a Main-verified recovery remains an explicit reviewed confirmation on the same finite API", async () => {
  const f=fixture("TeamProjectsTab"); await f.settle(); await reviewOwner(f,reviewed({recovering:true}));
  assert(f.nodes().some(node=>node.props?.children==="panel.onlineEditing.prepareRecovery"));
  assert.equal(f.button("prepareResume").props.disabled,true); f.button("prepareResume").props.onClick(); assert.equal(f.confirmations.length,0);
  acknowledge(f); f.button("prepareResume").props.onClick(); assert.deepEqual(f.confirmations[0].request,{reviewId:"review-1"});
  f.confirmations[0].resolve(prepared); await f.settle(); f.unmount();
});

test("unmount and refresh discard reviewed preparation and never reopen from late work", async () => {
  const f=fixture("TeamProjectsTab"); await f.settle(); f.button("prepare").props.onClick(); f.unmount();
  const writes=f.writes(); f.reviews[0].resolve(reviewed()); await flush();
  assert.equal(f.writes(),writes); assert(f.calls.some(call=>call[0]==="cancel" && call[1].reviewId==="review-1"));
  const g=fixture("TeamProjectsTab"); await g.settle(); await reviewOwner(g); acknowledge(g);
  const confirm=g.button("prepareConfirm").props.onClick;
  g.nodes().find(node=>node.type==="button" && Array.isArray(node.props.children) && node.props.children.includes(" 刷新")).props.onClick();
  confirm(); await g.settle(); assert.equal(g.confirmations.length,0); assert.equal(g.button("prepareConfirm"),undefined); g.unmount();
});

test("only Owner can explicitly prepare with narration; review counts and separate consent are visible", async () => {
  const f = fixture("TeamProjectsTab"); await f.settle();
  assert.equal(f.nodes().filter(node => node.type === "button" && node.props.children === "panel.onlineEditing.prepareWithTeaching").length, 1);
  f.button("prepareWithTeaching").props.onClick();
  assert.deepEqual(f.reviews[0].request, { sessionId: "chat-1", projectId: "project-owner", includeTeaching: true });
  f.reviews[0].resolve(reviewed({ teaching: { pageCount: 3, narrationCount: 5 } })); await f.settle();
  assert(f.nodes().some(node => node.props?.children === "panel.onlineEditing.prepareTeachingSummary"));
  assert(f.translations.some(([key, values]) => key === "panel.onlineEditing.prepareTeachingSummary" && values.pageCount === 3 && values.narrationCount === 5));
  assert(!f.nodes().some(node => node.props?.children === "panel.onlineEditing.preparePptxOnly"));
  assert(f.nodes().some(node => Array.isArray(node.props?.children) && node.props.children.includes("panel.onlineEditing.prepareTeachingAcknowledgement")));
  assert.equal(f.button("prepareConfirm").props.disabled, true);
  acknowledge(f); f.button("prepareConfirm").props.onClick();
  assert.equal(f.confirmations.length, 1); f.unmount();
});

test("review cannot silently downgrade narration preparation or opt PPTX-only preparation into teaching", async () => {
  for (const includeTeaching of [true, false]) {
    const f = fixture("TeamProjectsTab"); await f.settle(); f.button(includeTeaching ? "prepareWithTeaching" : "prepare").props.onClick();
    f.reviews[0].resolve(reviewed(includeTeaching ? {} : { teaching: { pageCount: 3, narrationCount: 5 } })); await f.settle();
    assert.equal(f.button("prepareConfirm"), undefined); assert.equal(f.confirmations.length, 0);
    assert(f.calls.some(call => call[0] === "cancel" && call[1].reviewId === "review-1"));
    assert(f.nodes().some(node => node.props?.role === "alert" && node.props.children === "panel.onlineEditing.prepareTeachingConflict")); f.unmount();
  }
});

test("verified audio transfer is counted and requires explicit team sharing consent", async () => {
  const f = fixture("TeamProjectsTab"); await f.settle(); f.button("prepareWithTeaching").props.onClick();
  f.reviews[0].resolve(reviewed({ teaching: { pageCount: 3, narrationCount: 5, audioCount: 2 } })); await f.settle();
  assert(f.translations.some(([key, values]) => key === "panel.onlineEditing.prepareTeachingAudioSummary" && values.count === 2));
  assert(f.nodes().some(node => Array.isArray(node.props?.children) && node.props.children.includes("panel.onlineEditing.prepareTeachingAudioAcknowledgement")));
  assert.equal(f.confirmations.length, 0); assert.equal(f.button("prepareConfirm").props.disabled, true);
  acknowledge(f); f.button("prepareConfirm").props.onClick();
  assert.deepEqual(f.confirmations[0].request, { reviewId: "review-1" }); f.unmount();
});

test("teaching preparation errors explain missing local setup, media and conflicts without exposing details", async () => {
  for (const [error, key] of [["TEACHING_NOT_READY", "prepareTeachingNotReady"], ["TEACHING_CONFLICT", "prepareTeachingConflict"],
    ["TEACHING_MEDIA_UNAVAILABLE", "prepareTeachingMedia"], ["PREPARATION_CHANGED", "prepareTeachingConflict"]]) {
    const f = fixture("TeamProjectsTab"); await f.settle(); f.button("prepareWithTeaching").props.onClick();
    f.reviews[0].reject(new Error(`COURSEWARE_ONLINE_${error}: private-path`)); await f.settle();
    assert(f.nodes().some(node => node.props?.role === "alert" && node.props.children === `panel.onlineEditing.${key}`));
    assert(!JSON.stringify(f.nodes()).includes("private-path")); assert.equal(f.confirmations.length, 0); f.unmount();
  }
});

test("online editing leaves narration to WiseOffice and retains the owner’s save review controls", async () => {
  const editor = fixture();
  await readySource(editor);
  assert(!editor.nodes().some(node => ["OnlineTeachingPanel", "OnlineBarrierPanel", "OnlinePauseRecovery"].includes(node.type)));
  editor.button("back").props.onClick();
  assert.equal(editor.closed(), 1);
  editor.unmount();

  const owner = fixture();
  owner.props.manageTeachingPause = true;
  owner.render();
  const open = owner.opens[0];
  owner.event({ ...state(open.ownerId, open.projectId, "error"), errorCode: "COURSEWARE_ONLINE_PLATFORM_46901" });
  open.reject(new Error("COURSEWARE_ONLINE_PLATFORM_46901"));
  await owner.settle();
  assert.equal(owner.nodes().find(node => node.type === "OnlineBarrierPanel").props.enabled, true);
  assert.equal(owner.nodes().find(node => node.type === "OnlinePauseRecovery").props.enabled, false);
  assert(!owner.nodes().some(node => node.type === "OnlineTeachingPanel"));
  assert(owner.button("retry"));
  owner.unmount();
});

const sourceButton = (f, key) => f.nodes().find(node => node.type === "button" && node.props.children === `panel.onlineSource.${key}`);
async function readySource(f) { f.opens[0].resolve(state(f.opens[0].ownerId)); await f.settle(); }

test("loss of project access clears the active review and teaching panel and allows returning to the team list", async () => {
  const f = fixture("CoursewareOnlineEditor", { manageTeachingPause: true }); await readySource(f);
  sourceButton(f, "begin").props.onClick(); await f.settle();
  assert(f.nodes().some(node => node.type === "SourceReview"));
  const open = f.opens[0];
  f.event({ ...state(open.ownerId, open.projectId, "error"), errorCode: "COURSEWARE_ONLINE_ACCESS_CHANGED" });
  await f.settle();
  assert(!f.nodes().some(node => ["OnlineBarrierPanel", "OnlinePauseRecovery", "SourceReview", "PlaybackPanel"].includes(node.type)));
  assert(f.calls.some(call => call[0] === "source-clear"));
  f.button("back").props.onClick();
  assert.equal(f.closed(), 1);
  f.unmount();
});

test("saved source review is explicit, requires held pause and hides native editor while presenting both real page previews", async () => {
  const f=fixture("CoursewareOnlineEditor",{manageTeachingPause:true}); await readySource(f);
  assert(!f.calls.some(call=>call[0]==="source-begin")); assert.equal(sourceButton(f,"begin").props.disabled,false);
  const start=sourceButton(f,"begin").props.onClick;start();start();await f.settle();
  const ownerId=f.opens[0].ownerId;
  assert.deepEqual(f.calls.find(call=>call[0]==="source-begin"),["source-begin",{ownerId,sessionId:"chat-1"}]);
  assert.equal(f.calls.filter(call=>call[0]==="source-begin").length,1);
  assert(f.calls.some(call=>call[0]==="visible" && call[1]===ownerId && call[2]===false));
  assert(!f.nodes().some(node => node.type === "OnlineBarrierPanel"));
  const leaf=f.nodes().find(node=>node.type==="SourceReview");
  await leaf.props.onPreview("target-1"); await leaf.props.onOriginalPreview("old-1");
  assert.deepEqual(f.calls.filter(call=>call[0]==="source-preview").map(call=>call[1]),[
    {viewId:"source-view",side:"target",page:3},{viewId:"source-view",side:"original",page:2}]);
  f.event(state(ownerId)); f.render();
  assert.equal(f.calls.filter(call=>call[0]==="visible").at(-1)[2],false,"native status events must not reveal the editor over review");
  const decisions={pages:[],removedPages:[],cues:[]};leaf.props.onConfirm(decisions);await f.settle();
  assert.deepEqual(f.calls.find(call=>call[0]==="source-resolve"),["source-resolve",{viewId:"source-view",decisions}]);
  assert(f.nodes().some(node=>node.props?.role==="status" && node.props.children==="panel.onlineSource.reviewed"));
  assert(f.translations.some(([key,values])=>key==="panel.onlineSource.reviewed" && values.ready===1 && values.total===1));
  const playback=f.nodes().find(node=>node.type==="PlaybackPanel");
  assert.deepEqual(playback.props.onlineSource,{viewId:"source-view",ownerId,teamProjectId:"project-owner",readyPages:1,totalPages:1});
  assert.equal(playback.props.sessionId,"chat-1");assert.equal(playback.props.enabled,true);
  assert(!f.calls.some(call=>/adopt|publish|upload/i.test(call[0])));
  sourceButton(f,"returnToEditor").props.onClick();await f.settle();
  assert(f.calls.some(call=>call[0]==="source-clear" && call[1].viewId==="source-view"));
  assert(f.calls.findIndex(call=>call[0]==="fixed-cancel")<f.calls.findIndex(call=>call[0]==="source-clear"));
  assert.equal(f.calls.filter(call=>call[0]==="visible").at(-1)[2],true);f.unmount();
});

test("review does not begin without owner, session or fresh held barrier", async () => {
  for(const barrier of [{state:"draining",teachingPaused:true},{state:"released",teachingPaused:false},{state:"held",teachingPaused:true,uncertain:true}]){
    const f=fixture("CoursewareOnlineEditor",{manageTeachingPause:true,barrier:()=>barrier});await readySource(f);
    sourceButton(f,"begin").props.onClick();await f.settle();
    assert(!f.calls.some(call=>call[0]==="source-begin"));
    assert(f.nodes().some(node=>node.props?.role==="alert" && node.props.children==="panel.onlineSource.requiresPause"));f.unmount();
  }
  const f=fixture();await readySource(f);assert.equal(sourceButton(f,"begin"),undefined);f.unmount();
  const g=fixture("CoursewareOnlineEditor",{manageTeachingPause:true});await readySource(g);
  g.props.sessionId=undefined;g.render();assert.equal(sourceButton(g,"begin").props.disabled,true);g.unmount();
});

test("cancel clears the exact review and stale review responses cannot replace a switched session or closed owner", async () => {
  const f=fixture("CoursewareOnlineEditor",{manageTeachingPause:true});await readySource(f);
  sourceButton(f,"begin").props.onClick();await f.settle();
  f.nodes().find(node=>node.type==="SourceReview").props.onCancel();await f.settle();
  assert.equal(f.calls.filter(call=>call[0]==="source-clear").length,1);assert(!f.nodes().some(node=>node.type==="SourceReview"));f.unmount();
  for(const end of [f=>{f.props.sessionId="chat-2";f.render();},f=>f.unmount(),f=>f.auth()]){
    const pending=deferred();const g=fixture("CoursewareOnlineEditor",{manageTeachingPause:true,sourceBegin:()=>pending.promise});await readySource(g);
    sourceButton(g,"begin").props.onClick();await g.settle();const ownerId=g.opens[0].ownerId;end(g);
    pending.resolve({ownerId,viewId:"late-view",original:{project:{pages:[]}},previousPages:[],targetPages:[]});await flush();
    assert(g.calls.some(call=>call[0]==="source-clear" && call[1].viewId==="late-view"));
    assert(!g.calls.some(call=>call[0]==="source-resolve"));g.unmount();
  }
});

test("review failures remain generic and failed clear keeps native view hidden for explicit retry", async () => {
  let attempts=0;
  const f=fixture("CoursewareOnlineEditor",{manageTeachingPause:true,sourceClear:()=>{if(!attempts++)throw new Error("private/token");return {ok:true};}});await readySource(f);
  sourceButton(f,"begin").props.onClick();await f.settle();f.nodes().find(node=>node.type==="SourceReview").props.onCancel();await f.settle();
  assert(f.nodes().some(node=>node.props?.role==="alert" && node.props.children==="panel.onlineSource.failed"));
  assert(!JSON.stringify(f.nodes()).includes("private/token"));
  assert.equal(f.calls.filter(call=>call[0]==="visible").at(-1)[2],false);
  f.nodes().find(node=>node.type==="SourceReview").props.onCancel();await f.settle();
  assert.equal(f.calls.filter(call=>call[0]==="visible").at(-1)[2],true);f.unmount();
});

test("returning to editing waits for fixed build/player cancellation before clearing the review", async () => {
  const cancel=deferred();const f=fixture("CoursewareOnlineEditor",{manageTeachingPause:true,fixedCancel:()=>cancel.promise});await readySource(f);
  sourceButton(f,"begin").props.onClick();await f.settle();f.nodes().find(node=>node.type==="SourceReview").props.onConfirm({pages:[],removedPages:[],cues:[]});await f.settle();
  sourceButton(f,"returnToEditor").props.onClick();await f.settle();
  assert.equal(sourceButton(f,"returnToEditor").props.disabled,true);assert(!f.calls.some(call=>call[0]==="source-clear"));
  assert.equal(f.calls.filter(call=>call[0]==="visible").at(-1)[2],false);
  cancel.resolve({ok:true});await f.settle();assert(f.calls.some(call=>call[0]==="source-clear"));
  assert.equal(f.calls.filter(call=>call[0]==="visible").at(-1)[2],true);f.unmount();
});

test("foreign review results are cleared without rendering them and captured completed handlers cannot resolve twice", async () => {
  const f=fixture("CoursewareOnlineEditor",{manageTeachingPause:true,sourceBegin:()=>({ownerId:"foreign",viewId:"foreign-view",targetPages:[]})});await readySource(f);
  sourceButton(f,"begin").props.onClick();await f.settle();
  assert(!f.nodes().some(node=>node.type==="SourceReview"));assert(f.calls.some(call=>call[0]==="source-clear" && call[1].viewId==="foreign-view"));f.unmount();
  const g=fixture("CoursewareOnlineEditor",{manageTeachingPause:true});await readySource(g);sourceButton(g,"begin").props.onClick();await g.settle();
  const leaf=g.nodes().find(node=>node.type==="SourceReview");leaf.props.onConfirm({pages:[],removedPages:[],cues:[]});await g.settle();
  leaf.props.onConfirm({pages:[],removedPages:[],cues:[]});await g.settle();assert.equal(g.calls.filter(call=>call[0]==="source-resolve").length,1);g.unmount();
});

test("captured review entry cannot hide another owner or begin after session or role changes", async () => {
  for(const change of [f=>{f.props.sessionId="chat-2";},f=>{f.props.manageTeachingPause=false;},f=>{f.props.projectId="project-other";}]){
    const f=fixture("CoursewareOnlineEditor",{manageTeachingPause:true});await readySource(f);const start=sourceButton(f,"begin").props.onClick;
    change(f);f.render();const calls=f.calls.length;start();await f.settle();
    assert(!f.calls.slice(calls).some(call=>call[0]==="source-begin" || call[0]==="visible" && call[2]===false));f.unmount();
  }
});
