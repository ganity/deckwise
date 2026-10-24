import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import test from "node:test";
import ts from "typescript";
import * as util from "node:util";
import * as crypto from "node:crypto";
import { createRequire } from "node:module";
import * as shared from "@pi-desktop/shared";

const require = createRequire(import.meta.url);
function load(source, dependencies) {
  const exports = {};
  new Function("require", "exports", ts.transpileModule(source, { compilerOptions: {
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS,
  } }).outputText)(id => {
    if (Object.hasOwn(dependencies, id)) return dependencies[id];
    assert(id.startsWith("node:"), `Unexpected dependency: ${id}`);
    return require(id);
  }, exports);
  return exports;
}
const office = load(await fs.readFile(new URL("../electron/main/office-file.ts", import.meta.url), "utf8"), { "@pi-desktop/shared": shared });
const transport = load(await fs.readFile(new URL("../electron/main/courseware-online-editing.ts", import.meta.url), "utf8"), {
  "node:util": util, "node:crypto": crypto, "./office-file": office, "@pi-desktop/shared": shared,
});
const { CoursewareOnlineEditingClient } = transport;
const projectId = "e53fe140-6154-4aa2-8d04-25348952b700";
const documentKey = "67fa376e-7c2c-4323-b9ea-d9222492fae2";
const current = () => ({ projectId, epoch: 4, sessionId: documentKey, active: true });
function offer() {
  const expiresAtEpochMillis = (Math.floor(Date.now() / 1000) + 60) * 1000;
  const payload = { documentType: "slide", document: { key: documentKey, fileType: "pptx", title: "Presentation.pptx",
    url: "https://storage.test/source.pptx", permissions: { edit: true } }, editorConfig: {
    mode: "edit", user: { id: "tenant-1-user-2", name: "User 2" }, callbackUrl: "https://platform.test/callback",
    coEditing: { mode: "fast", change: false }, customization: { autosave: true },
  }, iat: expiresAtEpochMillis / 1000 - 60, exp: expiresAtEpochMillis / 1000 };
  const config = { documentType: payload.documentType, document: payload.document, editorConfig: payload.editorConfig,
    token: `${Buffer.from('{"alg":"HS256"}').toString("base64url")}.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.fixtureSignature` };
  return { projectId, sessionEpoch: 4, source: { revision: "2d687531-3154-482b-8703-a9f8851c9a09", sha256: "a".repeat(64) },
    documentKey, docsUserId: "tenant-1-user-2", configJson: JSON.stringify(config), expiresAtEpochMillis };
}
const json = data => new Response(JSON.stringify({ code: 200, data }), { headers: { "Content-Type": "application/json" } });
function setup(handler = url => json(url.endsWith("/editor-config") ? offer() : current()), resolveToken = async () => "private-platform-token") {
  let principal = { tenantId: 1, userId: 2 };
  const calls = [];
  const client = new CoursewareOnlineEditingClient({ baseUrl: "https://platform.test/api/backend", getPrincipal: () => principal,
    resolveAccessToken: resolveToken, fetch: async (url, init) => {
      calls.push([url, init]); return handler(url, init);
    } });
  return { client, calls, change: value => { principal = value; } };
}

test("join reuses one authorized active key and preserves the original signed configuration", async () => {
  const issued = offer();
  const f = setup(url => json(url.endsWith("/editor-config") ? issued : current()));
  assert.deepEqual(await f.client.join(projectId), issued);
  assert.equal(f.calls.length, 2);
  assert.equal(f.calls[0][1].method, "GET");
  assert.equal(f.calls[1][0], `https://platform.test/api/backend/courseware/team/projects/${projectId}/editing-session/4/editor-config`);
  assert.equal(f.calls[1][1].body, "{}");
  for (const [, init] of f.calls) {
    assert.equal(init.headers.Authorization, "Bearer private-platform-token");
    assert.equal(init.redirect, "error"); assert.equal(init.credentials, "omit"); assert.equal(init.cache, "no-store");
  }
  assert(!JSON.stringify(issued).includes("private-platform-token"));
});

test("inactive, changed and invalid sessions never start a replacement or request a signed config", async () => {
  for (const value of [{ ...current(), active: false }, { ...current(), epoch: 0 }, { ...current(), sessionId: null },
    { ...current(), projectId: documentKey }, { ...current(), injected: true }]) {
    const f = setup(() => json(value));
    await assert.rejects(f.client.join(projectId), /INVALID_RESPONSE|SESSION_INACTIVE/);
    assert.equal(f.calls.length, 1);
  }
  const f = setup();
  await assert.rejects(f.client.join("../other"), /INVALID_REQUEST/); assert.equal(f.calls.length, 0);
});

test("editing entry refuses the server's signed Viewer configuration without granting local write authority", async () => {
  const issued = offer(), config = JSON.parse(issued.configJson);
  config.document.permissions.edit = false;
  config.editorConfig.mode = "view";
  const claims = JSON.parse(Buffer.from(config.token.split(".")[1], "base64url").toString("utf8"));
  claims.document = config.document; claims.editorConfig = config.editorConfig;
  config.token = `${config.token.split(".")[0]}.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.fixtureSignature`;
  issued.configJson = JSON.stringify(config);
  const f = setup(url => json(url.endsWith("/editor-config") ? issued : current()));
  await assert.rejects(f.client.join(projectId), /COURSEWARE_ONLINE_READ_ONLY/);
  assert.equal(f.calls.length, 2);
  assert(!f.calls.some(([url]) => url.endsWith("document-binding")));
});

test("a signed launch cannot swap source binding, native user, key, epoch, payload or expiry", async () => {
  for (const change of [value => { value.projectId = documentKey; }, value => { value.sessionEpoch++; },
    value => { value.documentKey = projectId; }, value => { value.docsUserId = "local-user"; },
    value => { value.source.sha256 = "wrong"; }, value => { value.expiresAtEpochMillis = Date.now() - 1000; },
    value => { value.expiresAtEpochMillis += 600_000; }, value => { value.platformToken = "unexpected"; },
    value => { const c = JSON.parse(value.configJson); c.editorConfig.user.id = "tenant-1-user-3"; value.configJson = JSON.stringify(c); },
    value => { const c = JSON.parse(value.configJson); c.document.url = "https://other.test/source"; value.configJson = JSON.stringify(c); },
    value => { const c = JSON.parse(value.configJson); c.editorConfig.plugins = {}; value.configJson = JSON.stringify(c); },
    value => { value.configJson = "malformed"; }]) {
    const issued = offer(); change(issued);
    const f = setup(url => json(url.endsWith("/editor-config") ? issued : current()));
    await assert.rejects(f.client.join(projectId), /INVALID_RESPONSE/);
    assert.equal(f.calls.length, 2);
  }
});

test("account change after config request discards the response without exposing another member's token", async () => {
  let f;
  f = setup(url => {
    if (url.endsWith("/editor-config")) { f.change({ tenantId: 1, userId: 3 }); return json(offer()); }
    return json(current());
  });
  await assert.rejects(f.client.join(projectId), /AUTH_CHANGED/);
  assert.equal(f.calls.length, 2);
  f.change(null); await assert.rejects(f.client.current(projectId), /AUTH_REQUIRED/);
});

test("session creation and binding are separate explicit commands, with no retry on uncertain outcome", async () => {
  const f = setup(() => json(current()));
  assert.deepEqual(await f.client.start(projectId, 3), current());
  assert.deepEqual(JSON.parse(f.calls[0][1].body), { expectedEpoch: 3 });
  const binding = { key: documentKey, sessionEpoch: 4, callbackUrl: "https://platform.test/callback" };
  const bound = setup(() => json(binding));
  assert.deepEqual(await bound.client.bind(projectId, 4), binding);
  assert.equal(bound.calls[0][0].endsWith("/editing-session/document-binding"), true);
  const lost = setup(() => { throw new Error("response-lost"); });
  await assert.rejects(lost.client.start(projectId, 3), /response-lost/);
  assert.equal(lost.calls.length, 1);
  await assert.rejects(f.client.start(projectId, -1), /INVALID_REQUEST/);
});

test("disabled, revoked, oversized and aborted launch responses fail without fallback", async () => {
  for (const handler of [() => new Response("", { status: 503 }), () => new Response(JSON.stringify({ code: 46305, message: "private-debug" }),
    { headers: { "content-type": "application/json" } }), () => new Response("x".repeat(131_073), { headers: { "content-type": "application/json" } })]) {
    const f = setup(handler);
    await assert.rejects(f.client.join(projectId), /HTTP_503|PLATFORM_46305|INVALID_RESPONSE/);
    assert.equal(f.calls.length, 1);
  }
  const f = setup(), abort = new AbortController(); abort.abort();
  await assert.rejects(f.client.join(projectId, abort.signal), /abort/i); assert.equal(f.calls.length, 0);
});

const sourceRevision = "2d687531-3154-482b-8703-a9f8851c9a09";
const requestId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const previousRevision = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const pptx = Buffer.from("PK[Content_Types].xmlppt/presentation.xml");
const hash = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
const uploadInput = () => ({ requestId, expectedSourceRevision: previousRevision, sourceSha256: hash(pptx), bytes: Buffer.from(pptx), filename: "Lesson.pptx" });
const sourceVersion = () => ({ projectId, source: { revision: sourceRevision, sha256: hash(pptx) }, byteLength: pptx.length,
  requestId, sessionEpoch: null, callbackId: null });
const businessError = code => new Response(JSON.stringify({ code, message: "private-debug" }), { headers: { "content-type": "application/json" } });

test("current source accepts exact upload and final-save provenance, and only not-found becomes null", async () => {
  for (const value of [sourceVersion(), { ...sourceVersion(), sessionEpoch: 4, callbackId: "c".repeat(64) }]) {
    const f = setup(() => json(value));
    assert.deepEqual(await f.client.currentSource(projectId), value);
    assert.equal(f.calls[0][0], `https://platform.test/api/backend/courseware/team/projects/${projectId}/sources/current`);
    assert.equal(f.calls[0][1].method, "GET");
  }
  assert.equal(await setup(() => businessError(46402)).client.currentSource(projectId), null);
  for (const code of [46100, 46102, 46403, 46405, 46406]) {
    await assert.rejects(setup(() => businessError(code)).client.currentSource(projectId), new RegExp(`PLATFORM_${code}`));
  }
  for (const mutate of [v => { v.projectId = documentKey; }, v => { v.source.revision = "bad"; },
    v => { v.source.sha256 = "A".repeat(64); }, v => { v.requestId = "bad"; }, v => { v.byteLength = 0; },
    v => { v.byteLength = 20 * 1024 * 1024 + 1; }, v => { v.sessionEpoch = -1; },
    v => { v.callbackId = "c".repeat(64); }, v => { v.sessionEpoch = 4; }, v => { v.unexpected = true; }]) {
    const value = sourceVersion(); mutate(value);
    await assert.rejects(setup(() => json(value)).client.currentSource(projectId), /INVALID_RESPONSE/);
  }
});

test("source upload sends a bounded immutable PPTX multipart with exact CAS fields and checks its receipt", async () => {
  const input = uploadInput();
  const f = setup(async (url, init) => {
    assert.equal(url, `https://platform.test/api/backend/courseware/team/projects/${projectId}/sources`);
    assert.equal(init.method, "POST");
    assert.equal(init.headers["Content-Type"], undefined);
    assert(init.body instanceof FormData);
    assert.deepEqual([...init.body.keys()], ["requestId", "expectedSourceRevision", "sourceSha256", "source"]);
    assert.equal(init.body.get("requestId"), requestId);
    assert.equal(init.body.get("expectedSourceRevision"), previousRevision);
    assert.equal(init.body.get("sourceSha256"), hash(pptx));
    const file = init.body.get("source");
    assert.equal(file.name, "Lesson.pptx");
    assert.equal(file.type, "application/vnd.openxmlformats-officedocument.presentationml.presentation");
    assert.deepEqual(Buffer.from(await file.arrayBuffer()), pptx);
    return json(sourceVersion());
  }, async () => { input.bytes.fill(0); input.sourceSha256 = "d".repeat(64); return "fresh"; });
  assert.deepEqual(await f.client.uploadSource(projectId, input), sourceVersion());
  assert.equal(f.calls[0][1].headers.Authorization, "Bearer fresh");
  for (const mutate of [v => { v.requestId = previousRevision; }, v => { v.source.sha256 = "d".repeat(64); },
    v => { v.byteLength++; }, v => { v.sessionEpoch = 4; v.callbackId = "c".repeat(64); }]) {
    const value = sourceVersion(); mutate(value);
    const rejected = setup(() => json(value));
    await assert.rejects(rejected.client.uploadSource(projectId, uploadInput()), /INVALID_RESPONSE/);
    assert.equal(rejected.calls.length, 1);
  }
  const first = uploadInput(); delete first.expectedSourceRevision;
  const initial = setup((_url, init) => { assert.equal(init.body.has("expectedSourceRevision"), false); return json(sourceVersion()); });
  await initial.client.uploadSource(projectId, first);
});

test("invalid source uploads and malformed source CAS never resolve a token or send a request", async () => {
  let tokens = 0;
  for (const mutate of [v => { v.requestId = "bad"; }, v => { v.expectedSourceRevision = null; },
    v => { v.expectedSourceRevision = ""; }, v => { v.sourceSha256 = "A".repeat(64); },
    v => { v.sourceSha256 = "d".repeat(64); }, v => { v.bytes = Buffer.alloc(0); },
    v => { v.bytes = Buffer.alloc(20 * 1024 * 1024 + 1); }, v => { v.bytes = new Uint8Array(pptx); },
    v => { v.bytes = Buffer.from("PK[Content_Types].xmlword/document.xml"); v.sourceSha256 = hash(v.bytes); },
    v => { v.filename = "../Lesson.pptx"; }, v => { v.filename = "Lesson.pptx\r\nInjected: yes"; },
    v => { v.filename = "Lesson.pdf"; }, v => { v.extra = true; }]) {
    const input = uploadInput(); mutate(input);
    const f = setup(undefined, async () => { tokens++; return "token"; });
    await assert.rejects(f.client.uploadSource(projectId, input), /INVALID_REQUEST/);
    assert.equal(f.calls.length, 0);
  }
  const f = setup(undefined, async () => { tokens++; return "token"; });
  await assert.rejects(f.client.start(projectId, 3, undefined, ""), /INVALID_REQUEST/);
  await assert.rejects(f.client.start(projectId, Number.MAX_SAFE_INTEGER, undefined, sourceRevision), /INVALID_REQUEST/);
  await assert.rejects(f.client.uploadSource("../other", uploadInput()), /INVALID_REQUEST/);
  assert.equal(tokens, 0);
});

test("20 MiB is inclusive and upload, reviewed start, bind, and join preserve exact order and fresh authentication", async () => {
  const boundary = Buffer.alloc(20 * 1024 * 1024); pptx.copy(boundary);
  const large = uploadInput(); large.bytes = boundary; large.sourceSha256 = hash(boundary);
  const boundaryReceipt = { ...sourceVersion(), byteLength: boundary.length, source: { revision: sourceRevision, sha256: large.sourceSha256 } };
  const boundaryClient = setup((_url, init) => { assert.equal(init.body.get("source").size, boundary.length); return json(boundaryReceipt); });
  assert.deepEqual(await boundaryClient.client.uploadSource(projectId, large), boundaryReceipt);
  let tokens = 0;
  const f = setup((url, init) => {
    if (url.endsWith("/sources/current")) return businessError(46402);
    if (url.endsWith("/sources")) return json(sourceVersion());
    if (url.endsWith("/document-binding")) return json({ key: documentKey, sessionEpoch: 4, callbackUrl: "https://platform.test/callback" });
    if (url.endsWith("/editor-config")) return json(offer());
    if (init.method === "POST") assert.deepEqual(JSON.parse(init.body), { expectedEpoch: 3, expectedSourceRevision: sourceRevision });
    return json(current());
  }, async () => `fresh-${++tokens}`);
  assert.equal(await f.client.currentSource(projectId), null);
  const input = uploadInput(); delete input.expectedSourceRevision;
  const uploaded = await f.client.uploadSource(projectId, input);
  const started = await f.client.start(projectId, 3, undefined, uploaded.source.revision);
  await f.client.bind(projectId, started.epoch);
  await f.client.join(projectId);
  assert.deepEqual(f.calls.map(([url, init]) => [init.method, new URL(url).pathname.split(projectId)[1]]), [
    ["GET", "/sources/current"], ["POST", "/sources"], ["POST", "/editing-session"],
    ["POST", "/editing-session/document-binding"], ["GET", "/editing-session"], ["POST", "/editing-session/4/editor-config"],
  ]);
  assert.equal(tokens, 6);
  for (const [index, [, init]] of f.calls.entries()) {
    assert.equal(init.headers.Authorization, `Bearer fresh-${index + 1}`);
    assert.equal(init.redirect, "error"); assert.equal(init.credentials, "omit"); assert.equal(init.cache, "no-store");
  }
});

test("uncertain upload and reviewed start never retry or silently fall back", async () => {
  for (const operation of [client => client.uploadSource(projectId, uploadInput()), client => client.start(projectId, 3, undefined, sourceRevision)]) {
    const f = setup(() => { throw new Error("response-lost"); });
    await assert.rejects(operation(f.client), /response-lost/);
    assert.equal(f.calls.length, 1);
    for (const code of [46102, 46401, 46403, 46406]) {
      const denied = setup(() => businessError(code));
      await assert.rejects(operation(denied.client), new RegExp(`PLATFORM_${code}`));
      assert.equal(denied.calls.length, 1);
    }
  }
});

test("source reads and uploads discard account changes and cancellation during token, fetch, stream, and cleanup", async () => {
  for (const operation of [(client, signal) => client.currentSource(projectId, signal), (client, signal) => client.uploadSource(projectId, uploadInput(), signal)]) {
    let f;
    f = setup(undefined, async () => { f.change({ tenantId: 1, userId: 3 }); return "old-token"; });
    await assert.rejects(operation(f.client), /AUTH_CHANGED/); assert.equal(f.calls.length, 0);
    f = setup(() => { f.change(null); return json(sourceVersion()); });
    await assert.rejects(operation(f.client), /AUTH_CHANGED/); assert.equal(f.calls.length, 1);
    const cancellation = new AbortController();
    f = setup(() => { cancellation.abort(); return json(sourceVersion()); });
    await assert.rejects(operation(f.client, cancellation.signal), /abort/i);
    let bodyRead = false;
    f = setup(() => new Response(new ReadableStream({ pull(controller) {
      if (bodyRead) { f.change(null); controller.close(); }
      else { bodyRead = true; controller.enqueue(new TextEncoder().encode(JSON.stringify({ code: 200, data: sourceVersion() }))); }
    } }), { headers: { "content-type": "application/json" } }));
    await assert.rejects(operation(f.client), /AUTH_CHANGED/);
    let reads = 0;
    f = setup(() => ({ ok: true, headers: new Headers({ "content-type": "application/json" }), body: { getReader: () => ({
      async read() { return reads++ ? { done: true } : { done: false, value: new TextEncoder().encode(JSON.stringify({ code: 200, data: sourceVersion() })) }; },
      async cancel() { f.change(null); },
    }) } }));
    await assert.rejects(operation(f.client), /AUTH_CHANGED/);
    const aborted = new AbortController(); aborted.abort();
    f = setup(); await assert.rejects(operation(f.client, aborted.signal), /abort/i); assert.equal(f.calls.length, 0);
    for (const phase of ["token", "stream", "cleanup"]) {
      const abort = new AbortController(); let read = 0;
      f = setup(() => ({ ok: true, headers: new Headers({ "content-type": "application/json" }), body: { getReader: () => ({
        async read() {
          if (phase === "stream") abort.abort();
          return read++ ? { done: true } : { done: false, value: new TextEncoder().encode(JSON.stringify({ code: 200, data: sourceVersion() })) };
        },
        async cancel() { if (phase === "cleanup") abort.abort(); },
      }) } }), async () => { if (phase === "token") abort.abort(); return "token"; });
      await assert.rejects(operation(f.client, abort.signal), /abort/i);
      assert.equal(f.calls.length, phase === "token" ? 0 : 1);
    }
  }
});

test("Desktop auth exposes the online client with the current fresh token and reuses it for join", async () => {
  const calls = [];
  const { DesktopAuthSession } = load(await fs.readFile(new URL("../electron/main/auth-session.ts", import.meta.url), "utf8"), {
    "@pi-desktop/shared": shared, "./courseware-online-editing": transport,
    "./courseware-media": { CoursewareMediaClient: class {} },
    electron: { net: { async fetch(url, init) { calls.push([url, init]); return json(url.endsWith("/editor-config") ? offer() : url.endsWith("/sources/current") ? sourceVersion() : current()); } } },
  });
  const auth = new DesktopAuthSession({ dataDir: "/unused-fixture", onChanged() {}, log() {} });
  auth.state = { status: "authenticated", profile: { tenantId: 1, userId: 2 } }; auth.accessToken = "initial";
  let refreshed = 0;
  auth.resolveAccessToken = async () => `fresh-${++refreshed}`;
  const client = auth.getCoursewareOnlineClient();
  assert(client instanceof CoursewareOnlineEditingClient);
  assert.deepEqual(await client.currentSource(projectId), sourceVersion());
  await auth.joinCoursewareOnline(projectId);
  assert.deepEqual(calls.map(([, init]) => init.headers.Authorization), ["Bearer fresh-1", "Bearer fresh-2", "Bearer fresh-3"]);
  auth.state = { status: "signedOut" };
  await assert.rejects(client.currentSource(projectId), /AUTH_REQUIRED/);
  assert.equal(calls.length, 3);
});

const teachingProject = () => ({ schemaVersion: "deckwise-courseware/1", projectId, taskType: "plain", title: "Lesson",
  source: { revision: sourceRevision, sha256: "a".repeat(64) }, teachingRevision: previousRevision,
  pages: [{ pageId: "page-1", actions: [{ id: "speech-1", type: "speech", text: "Hello" }], locked: false, reviewState: "ready" }] });
const teachingVersion = () => ({ project: { ...teachingProject(), teachingRevision: requestId }, mappingRevision: "mapping-1" });
const writePause = () => ({ projectId, sessionEpoch: 4, pauseId: requestId, state: "held", teaching: teachingVersion() });
const forceSave = () => ({ requestId, key: documentKey, sessionEpoch: 4, state: "pending", commandError: 0, callbackId: null });
const archive = () => ({ receipt: { callbackId: "c".repeat(64), key: documentKey, sessionEpoch: 4, documentStatus: 6,
  state: "archived", sha256: "d".repeat(64), byteLength: 1234 }, downloadUrl: "https://storage.test/archived.pptx?signature=synthetic" });

test("publication transport uses real pause/save/archive routes with fresh authenticated bounded requests", async () => {
  let tokens = 0;
  const f = setup((url, init) => {
    if (url.endsWith("/archive")) return json(archive());
    if (url.includes("/force-saves")) return json(forceSave());
    return json({ ...writePause(), ...(init.method === "DELETE" ? { state: "released" } : {}) });
  }, async () => `fresh-${++tokens}`);
  assert.deepEqual(await f.client.currentWritePause(projectId, 4), writePause());
  assert.deepEqual(await f.client.pauseWrites(projectId, 4, requestId), writePause());
  assert.deepEqual(await f.client.getWritePause(projectId, 4, requestId), writePause());
  assert.equal((await f.client.resumeWrites(projectId, 4, requestId)).state, "released");
  assert.deepEqual(await f.client.requestForceSave(projectId, 4, requestId, documentKey), forceSave());
  assert.deepEqual(await f.client.getForceSave(projectId, 4, requestId, documentKey), forceSave());
  assert.deepEqual(await f.client.getCallbackArchive(projectId, 4, "c".repeat(64), documentKey), archive());
  assert.deepEqual(f.calls.map(([url, init]) => [init.method, url.split("/editing-session/4")[1], init.body]), [
    ["GET", "/write-pauses/current", undefined], ["POST", "/write-pauses", JSON.stringify({ pauseId: requestId })],
    ["GET", `/write-pauses/${requestId}`, undefined], ["DELETE", `/write-pauses/${requestId}`, undefined],
    ["POST", "/force-saves", JSON.stringify({ requestId })], ["GET", `/force-saves/${requestId}`, undefined],
    ["GET", `/callbacks/${"c".repeat(64)}/archive`, undefined],
  ]);
  assert.equal(tokens, 7);
  for (const [index, [, init]] of f.calls.entries()) {
    assert.equal(init.headers.Authorization, `Bearer fresh-${index + 1}`);
    assert.equal(init.credentials, "omit"); assert.equal(init.redirect, "error"); assert.equal(init.cache, "no-store");
  }
});

test("current pause permits only an explicit null or a bound held pause; known pause responses remain exact", async () => {
  assert.equal(await setup(() => json(null)).client.currentWritePause(projectId, 4), null);
  for (const code of [46102, 46200, 46802]) await assert.rejects(setup(() => businessError(code)).client.currentWritePause(projectId, 4), new RegExp(`PLATFORM_${code}`));
  for (const mutate of [v => { v.projectId = documentKey; }, v => { v.sessionEpoch++; }, v => { v.pauseId = "bad"; },
    v => { v.state = ["held"]; }, v => { v.state = "unknown"; }, v => { v.teaching.mappingRevision = "bad/value"; },
    v => { v.teaching.project.projectId = documentKey; }, v => { v.teaching.project.source.revision = "local-source"; },
    v => { v.teaching.project.source.sha256 = "bad"; }, v => { v.extra = true; }]) {
    const value = writePause(); mutate(value);
    await assert.rejects(setup(() => json(value)).client.currentWritePause(projectId, 4), /INVALID_RESPONSE/);
  }
  await assert.rejects(setup(() => json({ ...writePause(), state: "released" })).client.currentWritePause(projectId, 4), /INVALID_RESPONSE/);
  await assert.rejects(setup(() => json({ ...writePause(), pauseId: documentKey })).client.getWritePause(projectId, 4, requestId), /INVALID_RESPONSE/);
  await assert.rejects(setup(() => json({ ...writePause(), state: ["held"] })).client.getWritePause(projectId, 4, requestId), /INVALID_RESPONSE/);
  await assert.rejects(setup(() => json(writePause())).client.resumeWrites(projectId, 4, requestId), /INVALID_RESPONSE/);
  for (const method of ["pauseWrites", "getWritePause", "resumeWrites"]) await assert.rejects(setup(() => json(null)).client[method](projectId, 4, requestId), /INVALID_RESPONSE/);
  // An idempotent POST can read a pause that was already released; do not silently re-pause.
  assert.equal((await setup(() => json({ ...writePause(), state: "released" })).client.pauseWrites(projectId, 4, requestId)).state, "released");
});

test("save status preserves unknown/no-change states and requires exact request, native key, epoch and receipt consistency", async () => {
  for (const [state, commandError, callbackId] of [["submitting", null, null], ["command_unknown", null, null],
    ["pending", 0, null], ["no_changes", 4, null], ["rejected", 2, null], ["archived", null, "c".repeat(64)],
    ["failed", 0, "c".repeat(64)], ["session_closed", null, null]]) {
    const value = { ...forceSave(), state, commandError, callbackId };
    assert.deepEqual(await setup(() => json(value)).client.getForceSave(projectId, 4, requestId, documentKey), value);
  }
  for (const mutate of [v => { v.requestId = documentKey; }, v => { v.key = projectId; }, v => { v.sessionEpoch++; },
    v => { v.state = "unknown"; }, v => { v.commandError = "0"; }, v => { v.commandError = 7; },
    v => { v.callbackId = "c".repeat(64); }, v => { v.state = "archived"; }, v => { v.state = "failed"; },
    v => { v.state = "no_changes"; }, v => { v.state = "command_unknown"; }, v => { v.state = "rejected"; },
    v => { v.extra = "private-debug"; }]) {
    const value = forceSave(); mutate(value);
    for (const method of ["getForceSave", "requestForceSave"]) await assert.rejects(setup(() => json(value)).client[method](projectId, 4, requestId, documentKey), /INVALID_RESPONSE/);
  }
});

test("archive requires matching immutable archived bytes and a bounded safe Main-only URL without downloading", async () => {
  for (const url of ["https://storage.test/archived.pptx?signature=synthetic", "http://127.0.0.1:1234/archive?signature=synthetic"]) {
    const value = archive(); value.downloadUrl = url;
    const f = setup(() => json(value)); assert.deepEqual(await f.client.getCallbackArchive(projectId, 4, "c".repeat(64), documentKey), value);
    assert.equal(f.calls.length, 1); assert(f.calls[0][0].includes("/callbacks/"));
  }
  for (const mutate of [v => { v.receipt.key = projectId; }, v => { v.receipt.callbackId = "b".repeat(64); },
    v => { v.receipt.sessionEpoch++; }, v => { v.receipt.documentStatus = 7; }, v => { v.receipt.documentStatus = "6"; },
    v => { v.receipt.state = "event"; }, v => { v.receipt.sha256 = null; }, v => { v.receipt.byteLength = 0; },
    v => { v.receipt.byteLength = 20 * 1024 * 1024 + 1; }, v => { v.receipt.extra = true; }, v => { v.extra = true; },
    ...["javascript:alert(1)", "file:///private", "http://storage.test/file", "https://u:p@storage.test/file", "https://storage.test/file#x",
      "https://storage.test/\r\nsecret", `https://storage.test/${"x".repeat(8200)}`].map(url => v => { v.downloadUrl = url; })]) {
    const value = archive(); mutate(value);
    await assert.rejects(setup(() => json(value)).client.getCallbackArchive(projectId, 4, "c".repeat(64), documentKey), /INVALID_RESPONSE/);
  }
});

const publicationOperations = [
  (client, signal) => client.currentWritePause(projectId, 4, signal),
  (client, signal) => client.pauseWrites(projectId, 4, requestId, signal),
  (client, signal) => client.getWritePause(projectId, 4, requestId, signal),
  (client, signal) => client.resumeWrites(projectId, 4, requestId, signal),
  (client, signal) => client.requestForceSave(projectId, 4, requestId, documentKey, signal),
  (client, signal) => client.getForceSave(projectId, 4, requestId, documentKey, signal),
  (client, signal) => client.getCallbackArchive(projectId, 4, "c".repeat(64), documentKey, signal),
];

test("publication inputs reject invalid scope and required identifiers before resolving credentials", async () => {
  let tokens = 0;
  for (const method of ["currentWritePause", "pauseWrites", "getWritePause", "resumeWrites", "requestForceSave", "getForceSave", "getCallbackArchive"]) {
    for (const epoch of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      const f = setup(undefined, async () => { tokens++; return "token"; });
      await assert.rejects(f.client[method](projectId, epoch, requestId, documentKey), /INVALID_REQUEST/); assert.equal(f.calls.length, 0);
    }
  }
  for (const operation of [c => c.currentWritePause("../other", 4), c => c.pauseWrites(projectId, 4, undefined),
    c => c.getWritePause(projectId, 4, "../../other"), c => c.resumeWrites(projectId, 4, "current"),
    c => c.requestForceSave(projectId, 4, undefined, documentKey), c => c.getForceSave(projectId, 4, requestId, undefined),
    c => c.getCallbackArchive(projectId, 4, "bad", documentKey), c => c.getCallbackArchive(projectId, 4, "c".repeat(64), "bad/key")]) {
    const f = setup(undefined, async () => { tokens++; return "token"; }); await assert.rejects(operation(f.client), /INVALID_REQUEST/); assert.equal(f.calls.length, 0);
  }
  assert.equal(tokens, 0);
});

test("publication never retries unknown submissions, leaks server messages or mistakes errors for no active pause", async () => {
  for (const operation of publicationOperations) {
    const lost = setup(() => { throw new Error("unknown-transport"); }); await assert.rejects(operation(lost.client), /unknown-transport/); assert.equal(lost.calls.length, 1);
    const denied = setup(() => businessError(46102)); await assert.rejects(operation(denied.client), error => error.message === "COURSEWARE_ONLINE_PLATFORM_46102");
    const oversized = setup(() => new Response("x".repeat(shared.COURSEWARE_MAX_BYTES + 4097), { headers: { "content-type": "application/json" } }));
    await assert.rejects(operation(oversized.client), /INVALID_RESPONSE/);
    const aborted = setup(), abort = new AbortController(); abort.abort(); await assert.rejects(operation(aborted.client, abort.signal), /abort/i); assert.equal(aborted.calls.length, 0);
    let f; f = setup(() => { f.change({ tenantId: 1, userId: 3 }); return json(null); }); await assert.rejects(operation(f.client), /AUTH_CHANGED/);
  }
});
const initializeInput = () => ({ requestId, mappingRevision: "mapping-1", project: teachingProject() });
const sourceMapping = () => ({ revision: "mapping-1", sourceSha256: "a".repeat(64), pages: [
  { pageId: "page-1", importPageId: "page_1", objects: [{ objectId: "object-1", importElementId: "text_1" }] },
] });
const mappingVersion = () => ({ projectId, source: structuredClone(teachingProject().source), mapping: sourceMapping() });
const leaseProof = () => ({ sessionEpoch: 4, leaseEpoch: 2, leaseToken: documentKey });
const pageLease = () => ({ projectId, pageId: "page-1", ...leaseProof(), expiresAtEpochMillis: Date.now() + 60_000 });
const teachingWriteInput = () => ({ requestId, lease: leaseProof(), write: { projectId, pageId: "page-1",
  expectedSourceRevision: sourceRevision, expectedTeachingRevision: previousRevision,
  actions: [{ id: "speech-1", type: "speech", text: "Updated narration" }] } });
const writtenVersion = input => ({ project: { ...teachingProject(), teachingRevision: requestId,
  pages: [{ ...teachingProject().pages[0], actions: structuredClone(input.write.actions), reviewState: "review" }] }, mappingRevision: "mapping-1" });

test("initialization sends the complete source mapping and snapshots it before resolving credentials", async () => {
  const input = { ...initializeInput(), mapping: sourceMapping() }, captured = structuredClone(input);
  const f = setup((_url, init) => { assert.deepEqual(JSON.parse(init.body), captured); return json(teachingVersion()); }, async () => {
    input.mapping.pages[0].objects[0].importElementId = "mutated"; return "fresh";
  });
  assert.deepEqual(await f.client.initializeTeaching(projectId, input), teachingVersion());
  for (const mutate of [v => { v.mapping = undefined; }, v => { v.mapping.revision = "other"; },
    v => { v.mapping.sourceSha256 = "b".repeat(64); }, v => { v.mapping.pages[0].pageId = "other"; },
    v => { v.mapping.pages.push({ pageId: "extra", importPageId: "page_2", objects: [] }); },
    v => { v.mapping.pages[0].objects.push(v.mapping.pages[0].objects[0]); }]) {
    const value = { ...initializeInput(), mapping: sourceMapping() }; mutate(value);
    const rejected = setup(); await assert.rejects(rejected.client.initializeTeaching(projectId, value), /INVALID_REQUEST/);
    assert.equal(rejected.calls.length, 0);
  }
});

test("versioned mapping read binds project, source and mapping and preserves missing/forbidden failures", async () => {
  const f = setup(() => json(mappingVersion()));
  assert.deepEqual(await f.client.getTeachingMapping(projectId, sourceRevision, "mapping-1"), mappingVersion());
  assert.equal(f.calls[0][0], `https://platform.test/api/backend/courseware/team/projects/${projectId}/teaching/mappings/mapping-1?sourceRevision=${sourceRevision}`);
  assert.equal(f.calls[0][1].method, "GET");
  assert.equal(f.calls[0][1].headers.Authorization, "Bearer private-platform-token");
  for (const mutate of [v => { v.projectId = documentKey; }, v => { v.source.revision = documentKey; },
    v => { v.source.sha256 = "b".repeat(64); }, v => { v.source.extra = true; },
    v => { v.mapping.revision = "other"; }, v => { v.mapping.pages[0].objects[0].importElementId = ""; },
    v => { v.extra = true; }]) {
    const value = mappingVersion(); mutate(value);
    await assert.rejects(setup(() => json(value)).client.getTeachingMapping(projectId, sourceRevision, "mapping-1"), /INVALID_RESPONSE/);
  }
  for (const code of [46102, 46607]) await assert.rejects(
    setup(() => businessError(code)).client.getTeachingMapping(projectId, sourceRevision, "mapping-1"), new RegExp(`PLATFORM_${code}`));
  for (const [source, mapping] of [["bad", "mapping-1"], [sourceRevision, ".."], [sourceRevision, "x/y"]]) {
    const invalid = setup(); await assert.rejects(invalid.client.getTeachingMapping(projectId, source, mapping), /INVALID_REQUEST/);
    assert.equal(invalid.calls.length, 0);
  }
  let changed; changed = setup(() => { changed.change({ tenantId: 1, userId: 3 }); return json(mappingVersion()); });
  await assert.rejects(changed.client.getTeachingMapping(projectId, sourceRevision, "mapping-1"), /AUTH_CHANGED/);
});

test("teaching initialize, session start, page acquire/renew/write/release use real route shapes and fresh auth in order", async () => {
  let tokens = 0;
  const initialize = initializeInput(), write = teachingWriteInput();
  const f = setup((url, init) => {
    if (url.endsWith("/teaching")) {
      if (init.method === "GET") return businessError(46606);
      assert.deepEqual(JSON.parse(init.body), initialize); return json(teachingVersion());
    }
    if (url.endsWith("/editing-session")) return json(current());
    if (url.endsWith("/lease")) {
      assert.deepEqual(JSON.parse(init.body), init.method === "POST" ? { sessionEpoch: 4 } : leaseProof());
      return json(init.method === "DELETE" ? null : pageLease());
    }
    assert(url.endsWith("/teaching/writes")); assert.deepEqual(JSON.parse(init.body), write); return json(writtenVersion(write));
  }, async () => `fresh-${++tokens}`);
  assert.equal(await f.client.currentTeaching(projectId), null);
  assert.deepEqual(await f.client.initializeTeaching(projectId, initialize), teachingVersion());
  await f.client.start(projectId, 3, undefined, sourceRevision);
  const acquired = await f.client.acquirePageLease(projectId, "page-1", 4);
  assert.equal(acquired.leaseToken, documentKey);
  const renewed = await f.client.renewPageLease(projectId, "page-1", leaseProof());
  assert.equal(renewed.leaseEpoch, acquired.leaseEpoch);
  assert.deepEqual(await f.client.writeTeaching(projectId, write), writtenVersion(write));
  assert.equal(await f.client.releasePageLease(projectId, "page-1", leaseProof()), undefined);
  assert.deepEqual(f.calls.map(([url, init]) => [init.method, new URL(url).pathname.split(projectId)[1]]), [
    ["GET", "/teaching"], ["POST", "/teaching"], ["POST", "/editing-session"],
    ["POST", "/pages/page-1/lease"], ["PUT", "/pages/page-1/lease"], ["POST", "/teaching/writes"], ["DELETE", "/pages/page-1/lease"],
  ]);
  assert.equal(tokens, 7);
  for (const [index, [, init]] of f.calls.entries()) {
    assert.equal(init.headers.Authorization, `Bearer fresh-${index + 1}`);
    assert.equal(init.redirect, "error"); assert.equal(init.credentials, "omit"); assert.equal(init.cache, "no-store");
  }
});

test("teaching reads use Shared project validation, exact version keys and only 46606 as missing", async () => {
  assert.deepEqual(await setup(() => json(teachingVersion())).client.currentTeaching(projectId), teachingVersion());
  for (const code of [46100, 46102, 46406, 46600, 46603]) {
    await assert.rejects(setup(() => businessError(code)).client.currentTeaching(projectId), new RegExp(`PLATFORM_${code}`));
  }
  for (const mutate of [v => { v.extra = true; }, v => { v.mappingRevision = "../bad"; }, v => { v.mappingRevision = ""; },
    v => { v.project.projectId = documentKey; }, v => { v.project.source.revision = "local-source"; },
    v => { v.project.source.sha256 = "A".repeat(64); }, v => { v.project.pages.push(v.project.pages[0]); },
    v => { v.project.pages[0].actions.push(v.project.pages[0].actions[0]); }, v => { v.project.pages[0].extra = true; },
    v => { v.project.source.extra = true; }, v => { v.project.pages[0].reviewState = "wrong"; }]) {
    const value = teachingVersion(); mutate(value);
    await assert.rejects(setup(() => json(value)).client.currentTeaching(projectId), /INVALID_RESPONSE/);
  }
  await assert.rejects(setup(() => json(null)).client.currentTeaching(projectId), /INVALID_RESPONSE/);
});

test("teaching writes and initialization snapshot nested JSON before credentials await", async () => {
  for (const operation of ["initialize", "write"]) {
    const input = operation === "initialize" ? initializeInput() : teachingWriteInput();
    const captured = structuredClone(input), response = operation === "initialize" ? teachingVersion() : writtenVersion(captured);
    const f = setup((_url, init) => { assert.deepEqual(JSON.parse(init.body), captured); return json(response); }, async () => {
      input.requestId = documentKey;
      if (operation === "initialize") { input.mappingRevision = "changed"; input.project.pages[0].actions[0].text = "changed"; }
      else { input.lease.leaseToken = requestId; input.write.actions[0].text = "changed"; }
      return "fresh";
    });
    assert.deepEqual(await (operation === "initialize" ? f.client.initializeTeaching(projectId, input) : f.client.writeTeaching(projectId, input)), response);
  }
  for (const method of ["renewPageLease", "releasePageLease"]) {
    const input = leaseProof(), captured = structuredClone(input);
    const f = setup((_url, init) => { assert.deepEqual(JSON.parse(init.body), captured); return json(method === "releasePageLease" ? null : pageLease()); },
      async () => { input.leaseToken = requestId; input.leaseEpoch++; return "fresh"; });
    await f.client[method](projectId, "page-1", input);
  }
});

test("teaching inputs reject invalid IDs, source tuples, Shared project/write shape and non-JSON actions before credentials", async () => {
  let tokens = 0;
  for (const [make, method, mutations] of [
    [initializeInput, "initializeTeaching", [v => { v.extra = true; }, v => { v.requestId = "bad"; }, v => { v.mappingRevision = "../bad"; },
      v => { v.project.projectId = documentKey; }, v => { v.project.source.revision = "not-platform-uuid"; },
      v => { v.project.source.sha256 = "bad"; }, v => { v.project.pages = []; }, v => { v.project.pages[0].actions[0].extra = () => {}; }]],
    [teachingWriteInput, "writeTeaching", [v => { v.extra = true; }, v => { v.requestId = "bad"; }, v => { v.lease.leaseToken = "bad"; },
      v => { v.lease.extra = true; }, v => { v.write.projectId = documentKey; }, v => { v.write.expectedSourceRevision = "local"; },
      v => { v.write.expectedTeachingRevision = ""; }, v => { v.write.pageId = "../page"; }, v => { v.write.extra = true; },
      v => { v.write.actions[0].extra = new Date(); }]],
  ]) {
    for (const mutate of mutations) {
      const input = make(); mutate(input);
      const f = setup(undefined, async () => { tokens++; return "token"; });
      await assert.rejects(f.client[method](projectId, input), /INVALID_REQUEST/); assert.equal(f.calls.length, 0);
    }
  }
  const f = setup(undefined, async () => { tokens++; return "token"; });
  for (const sessionEpoch of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])
    await assert.rejects(f.client.acquirePageLease(projectId, "page-1", sessionEpoch), /INVALID_REQUEST/);
  for (const method of ["renewPageLease", "releasePageLease"]) {
    for (const mutate of [v => { v.leaseToken = "bad"; }, v => { v.sessionEpoch = 0; }, v => { v.leaseEpoch = 0; },
      v => { v.leaseEpoch = Number.MAX_SAFE_INTEGER + 1; }, v => { v.extra = true; }]) {
      const input = leaseProof(); mutate(input);
      await assert.rejects(f.client[method](projectId, "page-1", input), /INVALID_REQUEST/);
    }
    await assert.rejects(f.client[method](projectId, "../page", leaseProof()), /INVALID_REQUEST/);
  }
  await assert.rejects(f.client.currentTeaching("../project"), /INVALID_REQUEST/);
  assert.equal(tokens, 0); assert.equal(f.calls.length, 0);
});

test("teaching receipts cannot acknowledge another source, mapping, target page or action set", async () => {
  for (const mutate of [v => { v.mappingRevision = "other"; }, v => { v.project.source.revision = documentKey; },
    v => { v.project.source.sha256 = "b".repeat(64); }, v => { v.project.pages[0].actions[0].text = "wrong"; }]) {
    const value = teachingVersion(); mutate(value);
    await assert.rejects(setup(() => json(value)).client.initializeTeaching(projectId, initializeInput()), /INVALID_RESPONSE/);
  }
  for (const mutate of [v => { v.project.source.revision = documentKey; }, v => { v.project.teachingRevision = previousRevision; },
    v => { v.project.pages[0].pageId = "page-2"; }, v => { v.project.pages[0].actions[0].text = "wrong"; },
    v => { v.project.pages[0].locked = true; }, v => { v.project.pages[0].reviewState = "ready"; }]) {
    const input = teachingWriteInput(), value = writtenVersion(input); mutate(value);
    await assert.rejects(setup(() => json(value)).client.writeTeaching(projectId, input), /INVALID_RESPONSE/);
  }
});

test("page lease responses bind page/session/token and reject invalid generations or expiry", async () => {
  for (const mutate of [v => { v.projectId = documentKey; }, v => { v.pageId = "page-2"; }, v => { v.sessionEpoch++; },
    v => { v.leaseEpoch = 0; }, v => { v.leaseToken = "bad"; }, v => { v.extra = true; },
    v => { v.expiresAtEpochMillis = Date.now() - 1; }, v => { v.expiresAtEpochMillis = Date.now() + 600_000; }]) {
    const value = pageLease(); mutate(value);
    await assert.rejects(setup(() => json(value)).client.acquirePageLease(projectId, "page-1", 4), /INVALID_RESPONSE/);
  }
  for (const mutate of [v => { v.leaseToken = requestId; }, v => { v.leaseEpoch++; }]) {
    const value = pageLease(); mutate(value);
    await assert.rejects(setup(() => json(value)).client.renewPageLease(projectId, "page-1", leaseProof()), /INVALID_RESPONSE/);
  }
  for (const value of [{}, true, undefined])
    await assert.rejects(setup(() => json(value)).client.releasePageLease(projectId, "page-1", leaseProof()), /INVALID_RESPONSE|PLATFORM_200/);
  await assert.rejects(setup(() => json(null)).client.acquirePageLease(projectId, "page-1", 4), /INVALID_RESPONSE/);
});

test("teaching has a bounded 2 MiB budget with response envelope allowance while existing endpoints stay at 128 KiB", async () => {
  const limit = 2 * 1024 * 1024;
  const project = teachingProject();
  project.pages[0].actions[0].text += "x".repeat(limit - Buffer.byteLength(JSON.stringify(project)));
  assert.equal(Buffer.byteLength(JSON.stringify(project)), limit);
  assert.deepEqual((await setup(() => json({ project, mappingRevision: "mapping-1" })).client.currentTeaching(projectId)).project, project);
  project.pages[0].actions[0].text += "x";
  await assert.rejects(setup(() => json({ project, mappingRevision: "mapping-1" })).client.currentTeaching(projectId), /INVALID_RESPONSE/);
  for (const method of ["initializeTeaching", "writeTeaching"]) {
    const input = method === "initializeTeaching" ? initializeInput() : teachingWriteInput();
    if (method === "writeTeaching") input.write.expectedTeachingRevision = "t".repeat(128);
    const actions = method === "initializeTeaching" ? input.project.pages[0].actions : input.write.actions;
    actions[0].text += "x".repeat(limit - Buffer.byteLength(JSON.stringify(input)));
    const response = method === "initializeTeaching" ? { project: { ...input.project, teachingRevision: requestId }, mappingRevision: input.mappingRevision } : writtenVersion(input);
    await setup(() => json(response)).client[method](projectId, input);
    actions[0].text += "x";
    let tokens = 0; const f = setup(undefined, async () => { tokens++; return "token"; });
    await assert.rejects(f.client[method](projectId, input), /INVALID_REQUEST/); assert.equal(tokens, 0);
  }
  for (const headers of [{ "content-type": "application/json" }, { "content-type": "application/json", "content-length": String(limit + 4097) }]) {
    const f = setup(() => new Response("x".repeat(limit + 4097), { headers }));
    await assert.rejects(f.client.currentTeaching(projectId), /INVALID_RESPONSE/);
  }
  await assert.rejects(setup(() => json({ project: teachingProject(), mappingRevision: "mapping-1", padding: "x".repeat(131_073) })).client.current(projectId), /INVALID_RESPONSE/);
});

test("teaching and page authority commands never retry unknown outcomes or reinterpret permission/stale errors as missing", async () => {
  const operations = [client => client.initializeTeaching(projectId, initializeInput()), client => client.writeTeaching(projectId, teachingWriteInput()),
    client => client.acquirePageLease(projectId, "page-1", 4), client => client.renewPageLease(projectId, "page-1", leaseProof()),
    client => client.releasePageLease(projectId, "page-1", leaseProof())];
  for (const operation of operations) {
    const lost = setup(() => { throw new Error("response-lost"); });
    await assert.rejects(operation(lost.client), /response-lost/); assert.equal(lost.calls.length, 1);
    for (const code of [46100, 46102, 46200, 46201, 46202, 46406, 46602, 46603, 46605, 46606]) {
      const f = setup(() => businessError(code));
      await assert.rejects(operation(f.client), new RegExp(`PLATFORM_${code}`)); assert.equal(f.calls.length, 1);
    }
  }
});

test("every teaching and lease method discards principal changes and cancellation across credentials, response streaming and cleanup", async () => {
  const operations = [(client, signal) => client.currentTeaching(projectId, signal),
    (client, signal) => client.initializeTeaching(projectId, initializeInput(), signal),
    (client, signal) => client.writeTeaching(projectId, teachingWriteInput(), signal),
    (client, signal) => client.acquirePageLease(projectId, "page-1", 4, signal),
    (client, signal) => client.renewPageLease(projectId, "page-1", leaseProof(), signal),
    (client, signal) => client.releasePageLease(projectId, "page-1", leaseProof(), signal)];
  for (const operation of operations) {
    for (const phase of ["token", "fetch", "stream", "cleanup"]) {
      let f, reads = 0;
      f = setup(() => {
        if (phase === "fetch") f.change(null);
        return { ok: true, headers: new Headers({ "content-type": "application/json" }), body: { getReader: () => ({
          async read() { if (phase === "stream") f.change(null); return reads++ ? { done: true } : {
            done: false, value: new TextEncoder().encode(JSON.stringify({ code: 200, data: null })) }; },
          async cancel() { if (phase === "cleanup") f.change(null); },
        }) } };
      }, async () => { if (phase === "token") f.change(null); return "token"; });
      await assert.rejects(operation(f.client), /AUTH_CHANGED/); assert.equal(f.calls.length, phase === "token" ? 0 : 1);
      const abort = new AbortController(); reads = 0;
      const aborted = setup(() => {
        if (phase === "fetch") abort.abort();
        return { ok: true, headers: new Headers({ "content-type": "application/json" }), body: { getReader: () => ({
          async read() { if (phase === "stream") abort.abort(); return reads++ ? { done: true } : {
            done: false, value: new TextEncoder().encode(JSON.stringify({ code: 200, data: null })) }; },
          async cancel() { if (phase === "cleanup") abort.abort(); },
        }) } };
      }, async () => { if (phase === "token") abort.abort(); return "token"; });
      await assert.rejects(operation(aborted.client, abort.signal), /abort/i);
      assert.equal(aborted.calls.length, phase === "token" ? 0 : 1);
    }
  }
});


const sourceReviewInput = () => ({ requestId, sessionEpoch: 4, pauseId: documentKey, forceSaveRequestId: previousRevision,
  expectedSourceRevision: sourceRevision, expectedTeachingRevision: previousRevision,
  project: { ...teachingProject(), source: { revision: requestId, sha256: hash(pptx) } },
  mapping: { ...sourceMapping(), revision: "review-mapping", sourceSha256: hash(pptx) } });
const sourceReview = (input = sourceReviewInput()) => ({ snapshotId: input.requestId, sessionEpoch: input.sessionEpoch,
  forceSaveRequestId: input.forceSaveRequestId, callbackId: "c".repeat(64), sourceByteLength: pptx.length,
  baselineSourceRevision: input.expectedSourceRevision, baselineTeachingRevision: input.expectedTeachingRevision,
  teaching: { project: { ...structuredClone(input.project), teachingRevision: documentKey }, mappingRevision: input.mapping.revision },
  mapping: structuredClone(input.mapping) });
const downloadableArchive = () => ({ ...archive(), receipt: { ...archive().receipt, sha256: hash(pptx), byteLength: pptx.length } });

test("source review capture/read preserve the frozen reviewed tuple and snapshot mutable input before auth", async () => {
  const input = sourceReviewInput(), captured = structuredClone(input), response = sourceReview(captured);
  let tokens = 0;
  const f = setup((url, init) => {
    assert.equal(url, `https://platform.test/api/backend/courseware/team/projects/${projectId}/teaching/source-reviews${init.method === "GET" ? `/${requestId}` : ""}`);
    if (init.method === "POST") assert.deepEqual(JSON.parse(init.body), captured);
    return json(response);
  }, async () => { tokens++; input.mapping.pages[0].objects[0].importElementId = "mutated"; input.project.title = "mutated"; return "fresh"; });
  assert.deepEqual(await f.client.captureSourceReview(projectId, input), response);
  assert.deepEqual(await f.client.getSourceReview(projectId, requestId), response);
  assert.equal(tokens, 2);
  for (const [, init] of f.calls) {
    assert.equal(init.headers.Authorization, "Bearer fresh"); assert.equal(init.credentials, "omit");
    assert.equal(init.redirect, "error"); assert.equal(init.cache, "no-store");
  }
});

test("source review inputs reject invalid identity, baseline, unreviewed pages, mapping, cues and local audio before auth", async () => {
  for (const mutate of [v => { v.requestId = "bad"; }, v => { v.sessionEpoch = 0; }, v => { v.sessionEpoch = Number.MAX_SAFE_INTEGER + 1; },
    v => { v.pauseId = "bad"; }, v => { v.forceSaveRequestId = "bad"; }, v => { v.expectedSourceRevision = "bad"; },
    v => { v.expectedTeachingRevision = "bad"; }, v => { v.project.projectId = documentKey; },
    v => { v.project.source.revision = sourceRevision; }, v => { v.expectedSourceRevision = requestId; },
    v => { v.project.teachingRevision = documentKey; }, v => { v.project.pages[0].reviewState = "review"; },
    v => { v.mapping.sourceSha256 = "b".repeat(64); }, v => { v.mapping.pages[0].pageId = "other"; },
    v => { v.mapping.pages[0].objects.push(v.mapping.pages[0].objects[0]); },
    v => { v.project.pages[0].actions.push({ id: "cue", type: "highlight", target: { objectId: "missing" } }); },
    v => { v.project.pages[0].actions[0].audioAssetId = "tts-local"; },
    v => { v.project.pages[0].actions[0].audioUrl = "https://untrusted.test/audio"; },
    v => { v.project.pages[0].actions.push({ id: "music", type: "audio_clip" }); }, v => { v.extra = true; }]) {
    const input = sourceReviewInput(); mutate(input);
    let tokens = 0; const f = setup(undefined, async () => { tokens++; return "token"; });
    await assert.rejects(f.client.captureSourceReview(projectId, input), /INVALID_REQUEST/);
    assert.equal(tokens, 0); assert.equal(f.calls.length, 0);
  }
  for (const operation of [c => c.captureSourceReview("../x", sourceReviewInput()), c => c.getSourceReview(projectId, "../x")]) {
    const f = setup(); await assert.rejects(operation(f.client), /INVALID_REQUEST/); assert.equal(f.calls.length, 0);
  }
});

test("source review responses bind source bytes, mapping order, baseline and server generated teaching revision", async () => {
  for (const mutate of [v => { v.snapshotId = sourceRevision; }, v => { v.sessionEpoch = 0; },
    v => { v.forceSaveRequestId = "bad"; }, v => { v.callbackId = "bad"; }, v => { v.sourceByteLength = 0; },
    v => { v.sourceByteLength = 20 * 1024 * 1024 + 1; }, v => { v.baselineSourceRevision = v.snapshotId; },
    v => { v.baselineTeachingRevision = "bad"; }, v => { v.teaching.project.projectId = documentKey; },
    v => { v.teaching.project.source.revision = sourceRevision; }, v => { v.teaching.project.source.sha256 = "b".repeat(64); },
    v => { v.teaching.project.teachingRevision = v.baselineTeachingRevision; },
    v => { v.teaching.project.teachingRevision = "local-revision"; }, v => { v.teaching.project.pages[0].reviewState = "review"; },
    v => { v.teaching.mappingRevision = "different"; }, v => { v.mapping.pages[0].pageId = "other"; },
    v => { v.mapping.extra = true; }, v => { v.teaching.extra = true; }, v => { v.extra = "private"; }]) {
    const value = sourceReview(); mutate(value);
    for (const operation of [c => c.captureSourceReview(projectId, sourceReviewInput()), c => c.getSourceReview(projectId, requestId)])
      await assert.rejects(operation(setup(() => json(value)).client), /INVALID_RESPONSE/);
  }
  // Well formed but wrong capture echoes cannot be substituted by the server.
  for (const mutate of [v => { v.sessionEpoch++; }, v => { v.forceSaveRequestId = documentKey; },
    v => { v.baselineSourceRevision = documentKey; }, v => { v.baselineTeachingRevision = sourceRevision; },
    v => { v.teaching.project.title = "changed"; }, v => { v.mapping.pages[0].objects[0].importElementId = "other"; }]) {
    const value = sourceReview(); mutate(value);
    await assert.rejects(setup(() => json(value)).client.captureSourceReview(projectId, sourceReviewInput()), /INVALID_RESPONSE/);
  }
  for (const code of [46102, 46404, 46602, 46603, 46608]) {
    await assert.rejects(setup(() => businessError(code)).client.captureSourceReview(projectId, sourceReviewInput()), new RegExp(`PLATFORM_${code}`));
    await assert.rejects(setup(() => businessError(code)).client.getSourceReview(projectId, requestId), new RegExp(`PLATFORM_${code}`));
  }
});

test("review capture/read preserve account/cancel checks, bounded JSON and no submission retry", async () => {
  for (const operation of [(c, signal) => c.captureSourceReview(projectId, sourceReviewInput(), signal),
    (c, signal) => c.getSourceReview(projectId, requestId, signal)]) {
    let f; f = setup(undefined, async () => { f.change(null); return "old"; });
    await assert.rejects(operation(f.client), /AUTH_CHANGED/); assert.equal(f.calls.length, 0);
    f = setup(() => { f.change(null); return json(sourceReview()); }); await assert.rejects(operation(f.client), /AUTH_CHANGED/);
    f = setup(() => { throw new Error("unknown-review-response"); }); await assert.rejects(operation(f.client), /unknown-review-response/);
    assert.equal(f.calls.length, 1);
    const abort = new AbortController(); abort.abort(); f = setup();
    await assert.rejects(operation(f.client, abort.signal), /abort/i); assert.equal(f.calls.length, 0);
    f = setup(() => new Response("x".repeat(shared.COURSEWARE_MAX_BYTES + 4097), { headers: { "content-type": "application/json" } }));
    await assert.rejects(operation(f.client), /INVALID_RESPONSE/);
  }
});

test("callback download authenticates metadata then streams only the pinned PPTX bytes without sending a bearer to storage", async () => {
  let tokens = 0;
  const f = setup((url, init) => url.includes("/archive") && url.startsWith("https://platform.test/") ? json(downloadableArchive()) : new Response(pptx),
    async () => `fresh-${++tokens}`);
  const result = await f.client.downloadCallbackArchive(projectId, 4, "c".repeat(64), documentKey);
  assert.deepEqual(result, { receipt: downloadableArchive().receipt, bytes: pptx });
  assert.equal(tokens, 1); assert.equal(f.calls.length, 2);
  const [url, init] = f.calls[1]; assert.equal(url, downloadableArchive().downloadUrl);
  assert.equal(init.method, "GET"); assert.equal(new Headers(init.headers).has("authorization"), false);
  assert.equal(init.credentials, "omit"); assert.equal(init.redirect, "error"); assert.equal(init.cache, "no-store");
  assert(!JSON.stringify(result).includes("downloadUrl"));
});

test("callback download rejects wrong hash, short/long/oversized bodies, false lengths and invalid PPTX without retries", async () => {
  for (const response of [() => new Response(Buffer.from("X".repeat(pptx.length))), () => new Response(pptx.subarray(0, pptx.length - 1)),
    () => new Response(Buffer.concat([pptx, Buffer.from("extra")])),
    () => new Response(pptx, { headers: { "content-length": String(pptx.length + 1) } }),
    () => new Response(pptx, { headers: { "content-length": String(20 * 1024 * 1024 + 1) } }),
    () => new Response(pptx, { headers: { "content-length": "invalid" } }), () => new Response("", { status: 503 })]) {
    const f = setup(url => url.startsWith("https://platform.test/") ? json(downloadableArchive()) : response());
    await assert.rejects(f.client.downloadCallbackArchive(projectId, 4, "c".repeat(64), documentKey), /INVALID_RESPONSE|HTTP_503/);
    assert.equal(f.calls.length, 2);
  }
  const bad = Buffer.from("not a pptx"), metadata = downloadableArchive();
  metadata.receipt.sha256 = hash(bad); metadata.receipt.byteLength = bad.length;
  await assert.rejects(setup(url => url.startsWith("https://platform.test/") ? json(metadata) : new Response(bad)).client
    .downloadCallbackArchive(projectId, 4, "c".repeat(64), documentKey), /INVALID_RESPONSE/);
  const oversized = downloadableArchive(); oversized.receipt.byteLength = 20 * 1024 * 1024 + 1;
  const f = setup(() => json(oversized));
  await assert.rejects(f.client.downloadCallbackArchive(projectId, 4, "c".repeat(64), documentKey), /INVALID_RESPONSE/); assert.equal(f.calls.length, 1);
});

test("callback download rejects account changes/cancellation at metadata, storage fetch, streaming and reader cleanup", async () => {
  for (const mode of ["metadata", "fetch", "read", "cancel", "abort-read", "abort-fetch"]) {
    const abort = new AbortController(); let f;
    f = setup(url => {
      if (url.startsWith("https://platform.test/")) {
        if (mode === "metadata") f.change(null);
        return json(downloadableArchive());
      }
      if (mode === "fetch") f.change(null);
      if (mode === "abort-fetch") abort.abort();
      let reads = 0;
      return { ok: true, headers: new Headers(), body: { getReader: () => ({
        async read() { if (mode === "read") f.change(null); if (mode === "abort-read") abort.abort();
          return reads++ ? { done: true } : { done: false, value: pptx }; },
        async cancel() { if (mode === "cancel") f.change(null); },
      }) } };
    });
    await assert.rejects(f.client.downloadCallbackArchive(projectId, 4, "c".repeat(64), documentKey, abort.signal),
      mode.startsWith("abort") ? /abort/i : /AUTH_CHANGED/);
    assert.equal(f.calls.length, mode === "metadata" ? 1 : 2);
  }
  const abort = new AbortController(); abort.abort(); const f = setup();
  await assert.rejects(f.client.downloadCallbackArchive(projectId, 4, "c".repeat(64), documentKey, abort.signal), /abort/i);
  assert.equal(f.calls.length, 0);
});


const reviewedCue = effect => ({ id: "attention-1", atMs: 0, endMs: 3_600_000, effect });
const reviewedCuesInput = () => {
  const input = sourceReviewInput();
  input.mapping.pages[0].objects.push({ objectId: "object-2", importElementId: "shape_2" });
  input.project.pages[0].actions[0].visualCues = [
    reviewedCue({ type: "highlight", elementIds: ["object-1", "object-2"], color: "#Aa09fF", style: "glow", opacity: 0 }),
    { ...reviewedCue({ type: "spotlight", elementId: "object-1", elementIds: ["object-2"], dimOpacity: 1 }), id: "attention-2" },
  ];
  return input;
};

test("source review accepts real nested speech highlight and spotlight cues and preserves valid boundary styles", async () => {
  for (const style of ["outline", "fill", "glow"]) {
    const input = reviewedCuesInput(); input.project.pages[0].actions[0].visualCues[0].effect.style = style;
    const value = sourceReview(input), f = setup(() => json(value));
    assert.deepEqual(await f.client.captureSourceReview(projectId, input), value);
    assert.deepEqual(await f.client.getSourceReview(projectId, requestId), value);
  }
  const input = reviewedCuesInput();
  input.project.pages[0].actions[0].visualCues = Array.from({ length: 200 }, (_, index) => ({
    ...reviewedCue({ type: "spotlight", elementId: "object-1", dimOpacity: 0 }), id: `cue-${index}`,
  }));
  const value = sourceReview(input);
  assert.deepEqual(await setup(() => json(value)).client.captureSourceReview(projectId, input), value);
});

test("source review rejects malformed real nested cues on both capture and frozen review read", async () => {
  for (const mutate of [
    a => { a.visualCues = {}; }, a => { a.visualCues = null; },
    a => { a.visualCues = Array(201).fill(a.visualCues[0]); }, a => { a.visualCues[1].id = a.visualCues[0].id; },
    a => { a.visualCues[0].id = ""; }, a => { a.visualCues[0].id = "x".repeat(201); },
    a => { a.visualCues[0].atMs = -1; }, a => { a.visualCues[0].atMs = 0.5; },
    a => { a.visualCues[0].endMs = 3_600_001; }, a => { a.visualCues[0].endMs = 0; },
    a => { a.visualCues[0].endMs = "1000"; }, a => { a.visualCues[0].unknown = true; },
    a => { a.visualCues[0].effect.type = "fade"; }, a => { a.visualCues[0].effect.elementIds = []; },
    a => { a.visualCues[0].effect.elementIds = ["object-1", "object-1"]; },
    a => { a.visualCues[0].effect.elementIds = Array(201).fill("object-1"); },
    a => { a.visualCues[0].effect.color = "red"; }, a => { a.visualCues[0].effect.color = "#12345G"; },
    a => { a.visualCues[0].effect.style = "invalid"; }, a => { a.visualCues[0].effect.style = ["fill"]; },
    a => { a.visualCues[0].effect.opacity = -0.1; }, a => { a.visualCues[0].effect.opacity = 1.1; },
    a => { a.visualCues[0].effect.opacity = "0.5"; }, a => { a.visualCues[0].effect.unknown = true; },
    a => { delete a.visualCues[1].effect.elementId; }, a => { a.visualCues[1].effect.elementIds = {}; },
    a => { a.visualCues[1].effect.elementIds = ["object-1"]; }, a => { a.visualCues[1].effect.dimOpacity = -0.1; },
    a => { a.visualCues[1].effect.dimOpacity = 1.1; }, a => { a.visualCues[1].effect.dimOpacity = null; },
    a => { a.visualCues[1].effect.color = "#123456"; },
  ]) {
    const input = reviewedCuesInput(); mutate(input.project.pages[0].actions[0]);
    const f = setup(() => json(sourceReview(input)));
    await assert.rejects(f.client.captureSourceReview(projectId, input), /INVALID_REQUEST/); assert.equal(f.calls.length, 0);
    await assert.rejects(f.client.getSourceReview(projectId, requestId), /INVALID_RESPONSE/);
  }
});

test("source review binds every nested cue target to the same mapped page and rejects unsupported top-level effects", async () => {
  for (const kind of ["highlight", "spotlight"]) for (const target of ["missing", "object-other-page"]) {
    const input = reviewedCuesInput();
    input.project.pages.push({ pageId: "page-2", actions: [], locked: false, reviewState: "ready" });
    input.mapping.pages.push({ pageId: "page-2", importPageId: "page_2", objects: [{ objectId: "object-other-page", importElementId: "shape_3" }] });
    input.project.pages[0].actions[0].visualCues = [reviewedCue(kind === "highlight" ?
      { type: kind, elementIds: [target] } : { type: kind, elementId: target })];
    const f = setup(() => json(sourceReview(input)));
    await assert.rejects(f.client.captureSourceReview(projectId, input), /INVALID_REQUEST/); assert.equal(f.calls.length, 0);
    await assert.rejects(f.client.getSourceReview(projectId, requestId), /INVALID_RESPONSE/);
  }
  for (const action of [{ id: "wrong", type: "highlight", target: { objectId: "object-1" } },
    { id: "wrong", type: "spotlight", target: { objectId: "object-1" } },
    { id: "wrong", type: "audio_clip", audioAssetId: documentKey, visualCues: [reviewedCue({ type: "spotlight", elementId: "object-1" })] },
    { id: "wrong", type: "interaction_checkpoint", checkpointId: "pause", checkpointKind: "teacher_continue", visualCues: [] }]) {
    const input = reviewedCuesInput(); input.project.pages[0].actions.push(action);
    const f = setup(() => json(sourceReview(input)));
    await assert.rejects(f.client.captureSourceReview(projectId, input), /INVALID_REQUEST/); assert.equal(f.calls.length, 0);
    await assert.rejects(f.client.getSourceReview(projectId, requestId), /INVALID_RESPONSE/);
  }
});

const nativeClientId = "66666666-6666-4666-8666-666666666666";
const nativeBarrierId = "77777777-7777-4777-8777-777777777777";
const nativePauseId = "88888888-8888-4888-8888-888888888888";
function nativeBarrierOffer() {
  return { projectId, sessionEpoch: 4, barrierId: nativeBarrierId, pauseId: nativePauseId, state: "draining", coverage: "managed",
    allRegisteredClientsHeld: false, authoritativeCoverage: false, consistentPublicationReady: false, proof: "client-reported",
    clients: [{ clientId: nativeClientId, docsUserId: `tenant-1-user-2-client-${nativeClientId}`, state: "awaiting", nativeReady: false,
      lastSeenEpochMillis: Date.now() }], reasons: ["CLIENTS_NOT_HELD"] };
}

test("per-mount config registration binds the exact client UUID and native Docs user while old services remain ordinary", async () => {
  const issued = offer(); issued.clientId = nativeClientId;
  const config = JSON.parse(issued.configJson), claims = JSON.parse(Buffer.from(config.token.split(".")[1], "base64url"));
  issued.docsUserId = `tenant-1-user-2-client-${nativeClientId}`;
  config.editorConfig.user.id = issued.docsUserId; claims.editorConfig = config.editorConfig;
  config.token = `${config.token.split(".")[0]}.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.fixtureSignature`;
  issued.configJson = JSON.stringify(config);
  const f = setup(url => json(url.endsWith("editor-config") ? issued : current()));
  assert.deepEqual(await f.client.join(projectId, undefined, nativeClientId), issued);
  assert.deepEqual(JSON.parse(f.calls.at(-1)[1].body), { clientId: nativeClientId });
  const old = setup(); assert.equal((await old.client.join(projectId, undefined, nativeClientId)).clientId, undefined);
  const bad = setup(url => json(url.endsWith("editor-config") ? { ...issued, clientId: requestId } : current()));
  await assert.rejects(bad.client.join(projectId, undefined, nativeClientId), /INVALID_RESPONSE/);
  const invalid = setup(); await assert.rejects(invalid.client.join(projectId, undefined, "invalid"), /INVALID_REQUEST/);
  assert.equal(invalid.calls.length, 0);
});

test("native registry methods preserve authenticated identity, exact paths, methods and non-authoritative evidence", async () => {
  const issued = nativeBarrierOffer(), f = setup(() => json(issued));
  assert.deepEqual(await f.client.currentNativeBarrier(projectId, 4), issued);
  assert.deepEqual(await f.client.startNativeBarrier(projectId, 4, nativeBarrierId, nativePauseId), issued);
  assert.deepEqual(await f.client.getNativeBarrier(projectId, 4, nativeBarrierId), issued);
  assert.deepEqual(await f.client.reportNativeBarrier(projectId, 4, nativeBarrierId, nativeClientId, "draining"), issued);
  assert.deepEqual(await f.client.heartbeatNativeClient(projectId, 4, nativeClientId, true), issued);
  assert.deepEqual(await f.client.releaseNativeBarrier(projectId, 4, nativeBarrierId), issued);
  assert.deepEqual(await f.client.leaveNativeClient(projectId, 4, nativeClientId), issued);
  const root = `/editing-session/4`;
  assert.deepEqual(f.calls.map(([url, init]) => [init.method, url.split(root)[1]]), [
    ["GET", "/native-barriers/current"], ["POST", "/native-barriers"], ["GET", `/native-barriers/${nativeBarrierId}`],
    ["PUT", `/native-barriers/${nativeBarrierId}/clients/${nativeClientId}`], ["PUT", `/native-clients/${nativeClientId}`],
    ["DELETE", `/native-barriers/${nativeBarrierId}`], ["DELETE", `/native-clients/${nativeClientId}`],
  ]);
  assert.deepEqual(JSON.parse(f.calls[1][1].body), { barrierId: nativeBarrierId, pauseId: nativePauseId });
  assert.deepEqual(JSON.parse(f.calls[3][1].body), { state: "draining" });
  assert.deepEqual(JSON.parse(f.calls[4][1].body), { nativeReady: true });
  assert(f.calls.every(([, init]) => init.cache === "no-store" && init.headers.Authorization === "Bearer private-platform-token"));
  const empty = setup(() => json(null));
  assert.equal(await empty.client.currentNativeBarrier(projectId, 4), null);
  assert.equal(await empty.client.heartbeatNativeClient(projectId, 4, nativeClientId, false), null);
  assert.equal(await empty.client.leaveNativeClient(projectId, 4, nativeClientId), null);
});

test("native registry rejects forged readiness, cross-epoch/client responses and malformed commands", async () => {
  for (const mutate of [v => { v.authoritativeCoverage = true; }, v => { v.consistentPublicationReady = true; },
    v => { v.sessionEpoch++; }, v => { v.projectId = nativeClientId; }, v => { v.barrierId = "bad"; },
    v => { v.clients[0].docsUserId = "tenant-1-user-3"; }, v => { v.clients.push(v.clients[0]); },
    v => { v.clients[0].nativeReady = "yes"; }, v => { v.clients[0].lastSeenEpochMillis = -1; }]) {
    const issued = nativeBarrierOffer(); mutate(issued);
    const f = setup(() => json(issued)); await assert.rejects(f.client.currentNativeBarrier(projectId, 4), /INVALID_RESPONSE/);
  }
  const f = setup(() => json(nativeBarrierOffer()));
  await assert.rejects(f.client.startNativeBarrier(projectId, 4, "bad", nativePauseId), /INVALID_REQUEST/);
  await assert.rejects(f.client.reportNativeBarrier(projectId, 4, nativeBarrierId, "bad", "held"), /INVALID_REQUEST/);
  await assert.rejects(f.client.heartbeatNativeClient(projectId, 0, nativeClientId, true), /INVALID_REQUEST/);
  assert.equal(f.calls.length, 0);
});

function docsCoverageOffer() {
  return { projectId, sessionEpoch: 4, barrierId: nativeBarrierId, pauseId: nativePauseId, documentKey,
    verifiedAtEpochMillis: Date.now(), docsUsers: [`tenant-1-user-2-client-${nativeClientId}`],
    coverage: "supported-deckwise-mounts", authoritativeCoverage: true, consistentPublicationReady: false, reasons: [] };
}

test("Docs coverage explicitly posts the exact frozen barrier without forwarding a renderer publication grant", async () => {
  const issued = docsCoverageOffer(), f = setup(() => json(issued));
  const result = await f.client.verifyNativeBarrierCoverage(projectId, 4, nativeBarrierId);
  assert.deepEqual(result, issued); assert.notEqual(result, issued);
  const [url, init] = f.calls[0];
  assert.equal(url, `https://platform.test/api/backend/courseware/team/projects/${projectId}/editing-session/4/native-barriers/${nativeBarrierId}/verify-docs`);
  assert.equal(init.method, "POST"); assert.equal(init.body, undefined); assert.equal(init.cache, "no-store");
  assert.equal(init.redirect, "error"); assert.equal(init.credentials, "omit");
  assert.equal(init.headers.Authorization, "Bearer private-platform-token");
  assert.equal(result.consistentPublicationReady, false);
  assert.equal(f.calls.length, 1);
});

test("Docs coverage preserves an explicit negative observation and unknown actual users for investigation", async () => {
  const issued = { ...docsCoverageOffer(), authoritativeCoverage: false, docsUsers: ["unregistered-editor"], reasons: ["DOCS_USERS_MISMATCH"] };
  const f = setup(() => json(issued));
  assert.deepEqual(await f.client.verifyNativeBarrierCoverage(projectId, 4, nativeBarrierId), issued);
  const empty = { ...issued, docsUsers: [], reasons: ["EMPTY_EDITOR_REGISTRY", "DOCS_USERS_MISMATCH"] };
  const e = setup(() => json(empty));
  assert.deepEqual(await e.client.verifyNativeBarrierCoverage(projectId, 4, nativeBarrierId), empty);
});

test("Docs coverage rejects changed scope, malformed or contradictory evidence and publication readiness", async () => {
  for (const mutate of [v => { v.projectId = nativeClientId; }, v => { v.sessionEpoch++; },
    v => { v.barrierId = nativeClientId; }, v => { v.pauseId = "invalid"; }, v => { v.documentKey = "../other"; },
    v => { v.verifiedAtEpochMillis = 0; }, v => { v.verifiedAtEpochMillis = Number.MAX_SAFE_INTEGER + 1; },
    v => { v.coverage = "all-connections"; }, v => { v.consistentPublicationReady = true; },
    v => { v.authoritativeCoverage = "yes"; }, v => { v.authoritativeCoverage = false; },
    v => { v.reasons = ["CLIENTS_NOT_HELD"]; }, v => { v.docsUsers = []; },
    v => { v.docsUsers = ["legacy-user"]; }, v => { v.docsUsers.push(v.docsUsers[0]); },
    v => { v.docsUsers = ["bad\n"]; }, v => { v.docsUsers = Array(1001).fill("editor"); },
    v => { v.authoritativeCoverage = false; v.reasons = ["bad reason"]; },
    v => { v.authoritativeCoverage = false; v.reasons = ["CLIENTS_NOT_HELD", "CLIENTS_NOT_HELD"]; },
    v => { v.extra = "unexpected"; }]) {
    const issued = docsCoverageOffer(); mutate(issued);
    const f = setup(() => json(issued));
    await assert.rejects(f.client.verifyNativeBarrierCoverage(projectId, 4, nativeBarrierId), /INVALID_RESPONSE/);
  }
});

test("Docs verification refuses invalid local commands, respects cancellation and never retries unknown results", async () => {
  const f = setup(() => json(docsCoverageOffer()));
  for (const args of [["../other", 4, nativeBarrierId], [projectId, 0, nativeBarrierId], [projectId, 4, "invalid"]])
    await assert.rejects(f.client.verifyNativeBarrierCoverage(...args), /INVALID_REQUEST/);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(f.client.verifyNativeBarrierCoverage(projectId, 4, nativeBarrierId, controller.signal), { name: "AbortError" });
  assert.equal(f.calls.length, 0);
  const unavailable = setup(() => { throw new Error("network-unknown"); });
  await assert.rejects(unavailable.client.verifyNativeBarrierCoverage(projectId, 4, nativeBarrierId), /network-unknown/);
  assert.equal(unavailable.calls.length, 1);
  const failed = setup(() => new Response(JSON.stringify({ code: 46907, data: null }), { headers: { "Content-Type": "application/json" } }));
  await assert.rejects(failed.client.verifyNativeBarrierCoverage(projectId, 4, nativeBarrierId), /PLATFORM_46907/);
});

test("Docs verification discards a response if the authenticated account changes during HTTP", async () => {
  let release;
  const response = new Promise(resolve => { release = resolve; });
  const f = setup(() => response);
  const pending = f.client.verifyNativeBarrierCoverage(projectId, 4, nativeBarrierId);
  await new Promise(resolve => setImmediate(resolve));
  f.change({ tenantId: 9, userId: 10 }); release(json(docsCoverageOffer()));
  await assert.rejects(pending, /AUTH_CHANGED/);
});

const verifiedReviewInput = () => ({ ...sourceReviewInput(), barrierId: nativeBarrierId });

test("verified save, GET polling, immutable capture and recovery use their explicit authenticated routes", async () => {
  const input = verifiedReviewInput(), saved = { ...forceSave(), requestId: input.forceSaveRequestId, state: "archived", callbackId: "c".repeat(64) };
  const review = sourceReview(input), f = setup(url => json(url.includes("force-saves") ? saved : review));
  assert.deepEqual(await f.client.requestBarrierForceSave(projectId, 4, nativeBarrierId, input.forceSaveRequestId, documentKey), saved);
  assert.deepEqual(await f.client.getForceSave(projectId, 4, input.forceSaveRequestId, documentKey), saved);
  assert.deepEqual(await f.client.captureVerifiedSourceReview(projectId, input), review);
  assert.deepEqual(await f.client.getVerifiedSourceReview(projectId, input.requestId), review);
  const root = `https://platform.test/api/backend/courseware/team/projects/${projectId}`;
  assert.deepEqual(f.calls.map(([url, init]) => [url, init.method, init.body]), [
    [`${root}/editing-session/4/native-barriers/${nativeBarrierId}/force-saves`, "POST", JSON.stringify({ requestId: input.forceSaveRequestId })],
    [`${root}/editing-session/4/force-saves/${input.forceSaveRequestId}`, "GET", undefined],
    [`${root}/teaching/verified-source-reviews`, "POST", JSON.stringify(input)],
    [`${root}/teaching/verified-source-reviews/${input.requestId}`, "GET", undefined],
  ]);
  assert(f.calls.every(([, init]) => init.headers.Authorization === "Bearer private-platform-token" && init.cache === "no-store" && init.credentials === "omit" && init.redirect === "error"));
});

test("verified capture snapshots the barrier and reviewed data before asynchronous authentication", async () => {
  const input = verifiedReviewInput(), expected = structuredClone(input), result = sourceReview(expected);
  const f = setup((url, init) => { assert.deepEqual(JSON.parse(init.body), expected); return json(result); }, async () => {
    input.barrierId = documentKey; input.project.title = "changed"; input.mapping.pages[0].objects[0].importElementId = "changed"; return "fresh";
  });
  assert.deepEqual(await f.client.captureVerifiedSourceReview(projectId, input), result);
});

test("verified operations reject malformed local commands and cannot opt into primitive fallback with a flag", async () => {
  let tokens = 0; const f = setup(undefined, async () => { tokens++; return "token"; });
  for (const args of [["../other", 4, nativeBarrierId, requestId, documentKey], [projectId, 0, nativeBarrierId, requestId, documentKey],
    [projectId, 4, "invalid", requestId, documentKey], [projectId, 4, nativeBarrierId, "bad", documentKey], [projectId, 4, nativeBarrierId, requestId, "../key"]])
    await assert.rejects(f.client.requestBarrierForceSave(...args), /INVALID_REQUEST/);
  for (const mutate of [v => { v.barrierId = "bad"; }, v => { delete v.barrierId; }, v => { v.project.pages[0].reviewState = "review"; },
    v => { v.verified = true; }, v => { v.expectedTeachingRevision = "bad"; }]) {
    const input = verifiedReviewInput(); mutate(input);
    await assert.rejects(f.client.captureVerifiedSourceReview(projectId, input), /INVALID_REQUEST/);
  }
  await assert.rejects(f.client.getVerifiedSourceReview(projectId, "../other"), /INVALID_REQUEST/);
  assert.equal(tokens, 0); assert.equal(f.calls.length, 0);
});

test("verified responses bind the exact saved key and complete reviewed tuple", async () => {
  for (const mutate of [v => { v.key = nativeClientId; }, v => { v.sessionEpoch++; }, v => { v.requestId = documentKey; }]) {
    const response = forceSave(); mutate(response);
    await assert.rejects(setup(() => json(response)).client.requestBarrierForceSave(projectId, 4, nativeBarrierId, requestId, documentKey), /INVALID_RESPONSE/);
  }
  for (const mutate of [v => { v.forceSaveRequestId = documentKey; }, v => { v.baselineTeachingRevision = documentKey; },
    v => { v.mapping.pages[0].objects[0].importElementId = "changed"; }, v => { v.teaching.project.title = "changed"; }]) {
    const input = verifiedReviewInput(), response = sourceReview(input); mutate(response);
    await assert.rejects(setup(() => json(response)).client.captureVerifiedSourceReview(projectId, input), /INVALID_RESPONSE/);
  }
  const wrong = sourceReview(); wrong.snapshotId = documentKey;
  await assert.rejects(setup(() => json(wrong)).client.getVerifiedSourceReview(projectId, requestId), /INVALID_RESPONSE/);
});

test("unknown verified POST outcomes are not retried and failed recovery never reads the ordinary primitive", async () => {
  for (const operation of [c => c.requestBarrierForceSave(projectId, 4, nativeBarrierId, requestId, documentKey),
    c => c.captureVerifiedSourceReview(projectId, verifiedReviewInput()), c => c.getVerifiedSourceReview(projectId, requestId)]) {
    const lost = setup(() => { throw new Error("response-lost"); });
    await assert.rejects(operation(lost.client), /response-lost/); assert.equal(lost.calls.length, 1);
    for (const code of [46907, 46908, 46909, 46910, 46911, 46912, 46404]) {
      const failed = setup(() => businessError(code));
      await assert.rejects(operation(failed.client), new RegExp(`PLATFORM_${code}`)); assert.equal(failed.calls.length, 1);
    }
  }
});

test("verified methods discard account replacements and cancellation across authentication, HTTP and streaming", async () => {
  const operations = [(c, signal) => c.requestBarrierForceSave(projectId, 4, nativeBarrierId, requestId, documentKey, signal),
    (c, signal) => c.captureVerifiedSourceReview(projectId, verifiedReviewInput(), signal),
    (c, signal) => c.getVerifiedSourceReview(projectId, requestId, signal)];
  for (const operation of operations) for (const phase of ["token", "fetch", "stream", "cleanup"]) {
    let f, reads = 0;
    f = setup(() => {
      if (phase === "fetch") f.change(null);
      return { ok: true, headers: new Headers({ "content-type": "application/json" }), body: { getReader: () => ({
        async read() { if (phase === "stream") f.change(null); return reads++ ? { done: true } : { done: false, value: new TextEncoder().encode('{"code":200,"data":null}') }; },
        async cancel() { if (phase === "cleanup") f.change(null); },
      }) } };
    }, async () => { if (phase === "token") f.change(null); return "token"; });
    await assert.rejects(operation(f.client), /AUTH_CHANGED/);
    const abort = new AbortController(); reads = 0;
    const cancelled = setup(() => {
      if (phase === "fetch") abort.abort();
      return { ok: true, headers: new Headers({ "content-type": "application/json" }), body: { getReader: () => ({
        async read() { if (phase === "stream") abort.abort(); return reads++ ? { done: true } : { done: false, value: new TextEncoder().encode('{"code":200,"data":null}') }; },
        async cancel() { if (phase === "cleanup") abort.abort(); },
      }) } };
    }, async () => { if (phase === "token") abort.abort(); return "token"; });
    await assert.rejects(operation(cancelled.client, abort.signal), /abort/i);
  }
});

const originalSourceArchive = () => ({ version: { projectId, source: { revision: previousRevision, sha256: hash(pptx) },
  byteLength: pptx.length, requestId, sessionEpoch: null, callbackId: null }, downloadUrl: "https://storage.test/original.pptx?signature=synthetic" });

test("original source download uses exact immutable revision and isolates the short storage grant from returned data", async () => {
  const grant = originalSourceArchive();
  const f = setup(url => url.startsWith("https://platform.test/") ? json(grant) : new Response(pptx));
  const result = await f.client.downloadSource(projectId, previousRevision);
  assert.deepEqual(result, { version: grant.version, bytes: pptx });
  assert.equal(f.calls[0][0], `https://platform.test/api/backend/courseware/team/projects/${projectId}/sources/${previousRevision}/download`);
  assert.equal(f.calls[0][1].method, "GET"); assert.equal(f.calls[0][1].body, undefined);
  assert.equal(f.calls[0][1].headers.Authorization, "Bearer private-platform-token");
  const [url, init] = f.calls[1]; assert.equal(url, grant.downloadUrl);
  assert.equal(init.method, "GET"); assert.equal(new Headers(init.headers).has("authorization"), false);
  assert.equal(init.credentials, "omit"); assert.equal(init.redirect, "error"); assert.equal(init.cache, "no-store");
  assert(!JSON.stringify(result).includes("downloadUrl"));
});

test("original source rejects foreign or malformed metadata and unsafe URLs before fetching storage", async () => {
  for (const mutate of [v => { v.version.projectId = documentKey; }, v => { v.version.source.revision = requestId; },
    v => { v.version.source.sha256 = "invalid"; }, v => { v.version.byteLength = 0; }, v => { v.version.byteLength = 20 * 1024 * 1024 + 1; },
    v => { v.version.callbackId = "c".repeat(64); }, v => { v.version.extra = true; }, v => { v.extra = true; },
    ...["file:///etc/passwd", "http://external.invalid/source.pptx", "https://user:password@storage.test/a", "https://storage.test/a#fragment", "https://storage.test/a\n", "x".repeat(8193)]
      .map(url => v => { v.downloadUrl = url; })]) {
    const grant = originalSourceArchive(); mutate(grant); const f = setup(() => json(grant));
    await assert.rejects(f.client.downloadSource(projectId, previousRevision), /INVALID_RESPONSE/);
    assert.equal(f.calls.length, 1);
  }
  for (const value of [null, "", "../latest", previousRevision.toUpperCase()]) {
    const f = setup(); await assert.rejects(f.client.downloadSource(projectId, value), /INVALID_REQUEST/); assert.equal(f.calls.length, 0);
  }
});

test("original source rejects corrupt or invalid Office bytes, length mismatches and failed storage without retries", async () => {
  for (const response of [() => new Response(Buffer.alloc(pptx.length)), () => new Response(pptx.subarray(0, pptx.length - 1)),
    () => new Response(Buffer.concat([pptx, Buffer.from("extra")])), () => new Response(pptx, { headers: { "content-length": String(pptx.length + 1) } }),
    () => new Response(pptx, { headers: { "content-length": "invalid" } }), () => new Response(null), () => new Response("", { status: 503 })]) {
    const f = setup(url => url.startsWith("https://platform.test/") ? json(originalSourceArchive()) : response());
    await assert.rejects(f.client.downloadSource(projectId, previousRevision), /INVALID_RESPONSE|HTTP_503/); assert.equal(f.calls.length, 2);
  }
  const bytes = Buffer.from("not a presentation"), grant = originalSourceArchive(); grant.version.source.sha256 = hash(bytes); grant.version.byteLength = bytes.length;
  const f = setup(url => url.startsWith("https://platform.test/") ? json(grant) : new Response(bytes));
  await assert.rejects(f.client.downloadSource(projectId, previousRevision), /INVALID_RESPONSE/);
});

test("original source never returns bytes after account change or cancellation during metadata, fetch, read or cleanup", async () => {
  for (const mode of ["metadata", "fetch", "read", "cancel", "abort-read", "abort-fetch"]) {
    const abort = new AbortController(); let f;
    f = setup(url => {
      if (url.startsWith("https://platform.test/")) { if (mode === "metadata") f.change(null); return json(originalSourceArchive()); }
      if (mode === "fetch") f.change(null); if (mode === "abort-fetch") abort.abort();
      let reads = 0;
      return { ok: true, headers: new Headers(), body: { getReader: () => ({
        async read() { if (mode === "read") f.change(null); if (mode === "abort-read") abort.abort();
          return reads++ ? { done: true } : { done: false, value: pptx }; },
        async cancel() { if (mode === "cancel") f.change(null); },
      }) } };
    });
    await assert.rejects(f.client.downloadSource(projectId, previousRevision, abort.signal), mode.startsWith("abort") ? /abort/i : /AUTH_CHANGED/);
    assert.equal(f.calls.length, mode === "metadata" ? 1 : 2);
  }
  const abort = new AbortController(); abort.abort(); const f = setup();
  await assert.rejects(f.client.downloadSource(projectId, previousRevision, abort.signal), /abort/i); assert.equal(f.calls.length, 0);
});

test("original source grant and PPTX streaming work over real loopback HTTP without a Platform bearer on storage", async () => {
  const { createServer } = await import("node:http"); const requests = []; let origin;
  const server = createServer((request, response) => {
    requests.push({ url: request.url, authorization: request.headers.authorization, cookie: request.headers.cookie });
    if (request.url === `/courseware/team/projects/${projectId}/sources/${previousRevision}/download`) {
      const grant = originalSourceArchive(); grant.downloadUrl = `${origin}/private-original.pptx?signature=fixture`;
      response.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" }); response.end(JSON.stringify({ code: 200, data: grant }));
    } else if (request.url === "/private-original.pptx?signature=fixture") {
      response.writeHead(200, { "content-type": "application/vnd.openxmlformats-officedocument.presentationml.presentation", "content-length": pptx.length }); response.end(pptx);
    } else { response.writeHead(404); response.end(); }
  });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  origin = `http://127.0.0.1:${server.address().port}`;
  const principal = { tenantId: 1, userId: 2 };
  const client = new CoursewareOnlineEditingClient({ baseUrl: origin, fetch, getPrincipal: () => principal, resolveAccessToken: async () => "synthetic-platform-token" });
  try {
    const result = await client.downloadSource(projectId, previousRevision);
    assert.deepEqual(result, { version: originalSourceArchive().version, bytes: pptx });
    assert.equal(requests.length, 2); assert.equal(requests[0].authorization, "Bearer synthetic-platform-token");
    assert.equal(requests[1].authorization, undefined); assert.equal(requests[1].cookie, undefined);
  } finally { server.closeAllConnections(); await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
});
