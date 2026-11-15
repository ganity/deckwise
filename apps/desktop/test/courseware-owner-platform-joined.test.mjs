import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import ts from "typescript";
import * as shared from "../../../packages/shared/dist/index.js";

const baseUrl = process.env.DECKWISE_OWNER_JOINED_URL;
const projectId = process.env.DECKWISE_OWNER_JOINED_PROJECT;
const require = createRequire(import.meta.url), modules = new Map([["@pi-desktop/shared", shared]]);
for (const name of ["office-file", "courseware-online-editing", "courseware-online-teaching"]) {
  const exports = {}, source = await fs.readFile(new URL(`../electron/main/${name}.ts`, import.meta.url), "utf8");
  new Function("require", "exports", ts.transpileModule(source, { compilerOptions: {
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS,
  } }).outputText)(id => id.startsWith("node:") ? require(id) : modules.get(id) ?? assert.fail(`Unexpected dependency: ${id}`), exports);
  modules.set(`./${name}`, exports);
}
const { CoursewareOnlineEditingClient } = modules.get("./courseware-online-editing");
const { CoursewareOnlineTeachingCoordinator } = modules.get("./courseware-online-teaching");

test("Desktop Owner transport joins actual Spring Security/JWT/SQL source-CAS session", {
  skip: !baseUrl || !projectId ? "Run through OwnerPreparationDesktopJoinedTest with disposable MySQL/Redis" : false,
  timeout: 60_000,
}, async t => {
  const bytes = await fs.readFile(new URL("../../../packages/courseware-runtime/tests/fixtures/office-lineage-b7/source.pptx", import.meta.url));
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const requests = [];
  let dropWriteResponse = false;
  function client(role, userId) {
    const principal = { tenantId: 900241, userId };
    const token = process.env[`DECKWISE_OWNER_JOINED_${role}`];
    assert(token, `Missing isolated fixture ${role} token`);
    return new CoursewareOnlineEditingClient({ baseUrl, getPrincipal: () => principal,
      resolveAccessToken: async () => token,
      async fetch(url, init) {
        requests.push({ method: init.method, path: new URL(url).pathname });
        const response = await fetch(url, init);
        if (dropWriteResponse && init.method === "POST" && new URL(url).pathname.endsWith("/teaching/writes")) {
          dropWriteResponse = false; await response.arrayBuffer(); throw new Error("Injected response loss after actual HTTP commit");
        }
        return response;
      },
    });
  }
  async function raw(path, token, method = "GET", body) {
    return fetch(`${baseUrl}${path}`, { method,
      headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body ? { "content-type": "application/json" } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}), redirect: "error", signal: AbortSignal.timeout(10_000) });
  }
  const owner = client("OWNER", 24101), editor = client("EDITOR", 24102), viewer = client("VIEWER", 24103);
  const outsider = client("OUTSIDER", 24104), disabled = client("DISABLED", 24105);
  const path = `/courseware/team/projects/${projectId}`;
  const input = (expectedSourceRevision) => ({ requestId: randomUUID(), sourceSha256: sha256, bytes, filename: "lesson.pptx",
    ...(expectedSourceRevision ? { expectedSourceRevision } : {}) });
  for (const token of [undefined, "fixture-invalid-jwt", process.env.DECKWISE_OWNER_JOINED_REFRESH]) {
    const response = await raw(`${path}/sources/current`, token);
    assert.equal(response.status, 401, "Missing, invalid and refresh credentials must not authenticate");
    await response.body?.cancel();
  }
  await assert.rejects(disabled.currentSource(projectId), /HTTP_401/u);
  await assert.rejects(outsider.currentSource(projectId), /PLATFORM_46100/u);
  // Real business code 46402 has no data; Desktop must return null before any source is uploaded.
  assert.equal(await owner.currentSource(projectId), null);
  assert.deepEqual(await owner.current(projectId), { projectId, epoch: 0, sessionId: null, active: false });
  await assert.rejects(viewer.uploadSource(projectId, input()), /PLATFORM_46102/u);
  const firstInput = input(), first = await owner.uploadSource(projectId, firstInput);
  assert.deepEqual(await owner.currentSource(projectId), first);
  assert.deepEqual(await owner.uploadSource(projectId, firstInput), first, "Same request replay returns existing source");
  const second = await owner.uploadSource(projectId, input(first.source.revision));
  assert.notEqual(second.source.revision, first.source.revision);
  assert.equal(second.source.sha256, sha256);
  assert.equal(await owner.currentTeaching(projectId), null);
  const seed = { requestId: randomUUID(), mappingRevision: "mapping-joined-1", project: {
    schemaVersion: "deckwise-courseware/1", projectId, taskType: "import", title: "Joined narration", source: second.source,
    teachingRevision: "local-teaching", pages: ["page-a", "page-b"].map(pageId => ({ pageId, actions: [
      { id: `speech-${pageId}`, type: "speech", text: "Original" }, { id: `cue-${pageId}`, type: "future-cue", retained: true },
    ], locked: false, reviewState: "ready" })),
  }, mapping: { revision: "mapping-joined-1", sourceSha256: sha256, pages: [
    { pageId: "page-a", importPageId: "page_1", objects: [{ objectId: "object-a", importElementId: "pptx_shape_1" }] },
    { pageId: "page-b", importPageId: "page_2", objects: [{ objectId: "object-b", importElementId: "pptx_shape_1" }] },
  ] } };
  // Explicit two-page teaching/mapping fixture; fresh parser lineage is a separate Host gate.
  assert(shared.isCoursewareOnlineSourceMapping(seed.mapping));
  for (const [change, code] of [
    [value => { value.project.source.revision = first.source.revision; }, 46603],
    [value => { value.mapping.revision = "wrong-mapping"; }, 46600],
    [value => { value.mapping.pages[1].objects[0].objectId = "object-a"; }, 46600],
  ]) {
    const invalid = structuredClone(seed); invalid.requestId = randomUUID(); change(invalid);
    const response = await raw(`${path}/teaching`, process.env.DECKWISE_OWNER_JOINED_OWNER, "POST", invalid);
    assert.equal((await response.json()).code, code);
    assert.equal(await owner.currentTeaching(projectId), null, "Rejected input cannot initialize teaching or mapping");
  }
  await assert.rejects(viewer.initializeTeaching(projectId, seed), /PLATFORM_46102/u);
  const teaching = await owner.initializeTeaching(projectId, seed);
  assert.deepEqual(await owner.initializeTeaching(projectId, seed), teaching);
  assert.deepEqual(await viewer.currentTeaching(projectId), teaching);
  const fixedMapping = { projectId, source: second.source, mapping: seed.mapping };
  const readMapping = member => member.getTeachingMapping(projectId, second.source.revision, seed.mappingRevision);
  assert.deepEqual(await readMapping(owner), fixedMapping);
  assert.deepEqual(await readMapping(editor), fixedMapping);
  assert.deepEqual(await readMapping(viewer), fixedMapping);
  await assert.rejects(readMapping(outsider), /PLATFORM_46100/u);
  await assert.rejects(owner.getTeachingMapping(projectId, first.source.revision, seed.mappingRevision), /PLATFORM_46607/u);
  await assert.rejects(owner.getTeachingMapping(projectId, second.source.revision, "missing-mapping"), /PLATFORM_46607/u);
  const mappingPath = `${path}/teaching/mappings/${seed.mappingRevision}`;
  const badSource = await raw(`${mappingPath}?sourceRevision=not-a-uuid`, process.env.DECKWISE_OWNER_JOINED_OWNER);
  assert.equal((await badSource.json()).code, 46600);
  const unauthenticatedMapping = await raw(`${mappingPath}?sourceRevision=${second.source.revision}`);
  assert.equal(unauthenticatedMapping.status, 401); await unauthenticatedMapping.body?.cancel();
  await assert.rejects(owner.start(projectId, 0, undefined, first.source.revision), /PLATFORM_46403/u);
  assert.equal((await owner.current(projectId)).epoch, 0, "Stale reviewed source cannot increment epoch");
  await assert.rejects(editor.start(projectId, 0, undefined, second.source.revision), /PLATFORM_46102/u);
  await assert.rejects(viewer.start(projectId, 0, undefined, second.source.revision), /PLATFORM_46102/u);
  const session = await owner.start(projectId, 0, undefined, second.source.revision);
  assert.equal(session.active, true); assert.equal(session.epoch, 1);
  await assert.rejects(owner.uploadSource(projectId, input(second.source.revision)), /PLATFORM_46406/u);
  assert.deepEqual(await owner.currentSource(projectId), second);
  await assert.rejects(owner.join(projectId), /PLATFORM_46301/u);
  await assert.rejects(editor.bind(projectId, 1), /PLATFORM_46102/u);
  const binding = await owner.bind(projectId, 1);
  assert.equal(binding.key, session.sessionId);
  const ownerLaunch = await owner.join(projectId), editorLaunch = await editor.join(projectId);
  assert.equal(ownerLaunch.documentKey, binding.key); assert.equal(editorLaunch.documentKey, binding.key);
  assert.notEqual(ownerLaunch.docsUserId, editorLaunch.docsUserId);
  assert.deepEqual(ownerLaunch.source, second.source); assert.deepEqual(editorLaunch.source, second.source);
  await assert.rejects(viewer.join(projectId), /READ_ONLY/u);
  const ownerId = randomUUID(), editorId = randomUUID();
  const coordinator = (client, viewOwner) => new CoursewareOnlineTeachingCoordinator({
    client: () => client, principal: () => ({ assertCurrent() {} }),
    binding: requested => { assert.equal(requested, viewOwner); return { ownerId: viewOwner, projectId, source: second.source, sessionEpoch: 1 }; },
  });
  const ownerTeaching = coordinator(owner, ownerId), editorTeaching = coordinator(editor, editorId);
  let a = await ownerTeaching.read(ownerId, "page-a"), b = await editorTeaching.read(editorId, "page-b");
  await assert.rejects(viewer.acquirePageLease(projectId, "page-a", 1), /PLATFORM_46102/u);
  a = await ownerTeaching.acquire(a.viewId); b = await editorTeaching.acquire(b.viewId);
  assert(!JSON.stringify(a).includes("leaseToken"), "Raw proof must never reach a teaching view");
  await assert.rejects(editor.acquirePageLease(projectId, "page-a", 1), /PLATFORM_46201/u);
  a = await ownerTeaching.renew(a.viewId);
  const edit = (view, text) => view.project.pages.find(page => page.pageId === view.pageId).actions.map(action =>
    action.type === "speech" ? shared.replaceNarrationText(action, text) : action);
  const oldA = a.viewId;
  a = await ownerTeaching.save(a.viewId, edit(a, "Owner page A"));
  await assert.rejects(ownerTeaching.save(oldA, edit(a, "Stale view")), /TEACHING_CHANGED/u);
  b = await editorTeaching.save(b.viewId, edit(b, "Editor page B"));
  assert.equal(b.project.pages[0].actions[0].text, "Owner page A", "A second page write must preserve the latest peer page");
  const finalActions = edit(a, "Owner confirmed response");
  dropWriteResponse = true;
  await assert.rejects(ownerTeaching.save(a.viewId, finalActions), /TEACHING_PENDING_WRITE/u);
  a = await ownerTeaching.save(a.viewId, finalActions);
  assert.equal(a.project.pages[1].actions[0].text, "Editor page B");
  assert.deepEqual(a.project.pages.map(page => page.actions[1]), seed.project.pages.map(page => page.actions[1]));
  await ownerTeaching.release(a.viewId); await editorTeaching.release(b.viewId);
  assert.deepEqual(await viewer.currentTeaching(projectId), { project: a.project, mappingRevision: a.mappingRevision });
  assert.deepEqual(await readMapping(owner), fixedMapping, "Teaching writes must retain the immutable original source/mapping tuple");
  assert.deepEqual(await readMapping(editor), fixedMapping);
  assert.deepEqual(await readMapping(viewer), fixedMapping);
  const beforeJoin = requests.length;
  const revoked = await raw(`${path}/members/24102`, process.env.DECKWISE_OWNER_JOINED_OWNER, "DELETE");
  assert.equal(revoked.status, 200); assert.equal((await revoked.json()).code, 200);
  await assert.rejects(editor.join(projectId), /PLATFORM_46100/u);
  assert(requests.slice(beforeJoin).every(row => row.method === "GET"), "Revoked join cannot create a session or binding");
  assert.equal((await owner.current(projectId)).epoch, 1);
  await assert.rejects(editorTeaching.read(editorId, "page-b"), /PLATFORM_46100/u);
  await assert.rejects(readMapping(editor), /PLATFORM_46100/u);
  assert.deepEqual(await readMapping(viewer), fixedMapping);
  t.diagnostic("Actual Spring MVC+Security/JWT/SQL + Desktop transport and teaching coordinator: complete mapping initialize/replay and exact source/revision GET, Editor/Viewer read, invalid source/mapping refusal, immutable mapping through four teaching versions, two leased pages, narration CAS preserving peer/opaque actions, lost-response exact replay, release and revoked re-read all passed; teaching/mapping is an explicit fixture, no fresh parser/Electron/real Docs engine in this gate");
});
