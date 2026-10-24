#!/usr/bin/env node
/** Real Desktop/Office-entry join; local auth/Platform/Docs protocol fixtures, no real coediting. */
import assert from "node:assert/strict";
import { createHash, createHmac, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { coursewareLaunch } from "./e2e/boot.mjs";

if (process.argv.includes("--real-docs")) {
  await (await import("./e2e/online-real-docs.mjs")).runRealDocs();
  process.exit(process.exitCode ?? 0);
}

for (const key of ["DECKWISE_E2E_OUTPUT", "DECKWISE_E2E_ONLINE_ENTRY_DIST", "DECKWISE_E2E_OFFICE_ROOT"])
  assert(process.env[key], `Missing ${key}`);
const launch = coursewareLaunch();
const unconfiguredOnly = process.argv.includes("--unconfigured-only");
const mountOnly = process.argv.includes("--mount-only");
const ownerPreparation = process.argv.includes("--owner-preparation");
const onlineTeaching = process.argv.includes("--online-teaching");
const onlinePublication = process.argv.includes("--online-publication");
assert([unconfiguredOnly, mountOnly, ownerPreparation, onlineTeaching, onlinePublication].filter(Boolean).length <= 1, "Choose one isolated group mode");
if (ownerPreparation) for (const key of ["DECKWISE_E2E_OFFICE_DIST", "DECKWISE_E2E_PPTX", "PI_DESKTOP_HOST_BIN"])
  assert(process.env[key], `Missing ${key}`);
if (onlinePublication) for (const key of ["DECKWISE_E2E_PPTX", "PI_DESKTOP_HOST_BIN", "DECKWISE_PPTX_WORKER"])
  assert(process.env[key], `Missing ${key}`);
const output = resolve(process.env.DECKWISE_E2E_OUTPUT);
await mkdir(dirname(output), { recursive: true }); await mkdir(output);
const directory = await mkdtemp(join(tmpdir(), "deckwise-online-join-"));
const workspace = join(directory, "workspace"); await mkdir(workspace);
const fixtureHome = join(directory, "home"); await mkdir(fixtureHome);
const officeDist = resolve(process.env.DECKWISE_E2E_ONLINE_ENTRY_DIST);
const officeRoot = resolve(process.env.DECKWISE_E2E_OFFICE_ROOT);
const { _electron, expect } = createRequire(new URL("../packages/courseware-runtime/package.json", import.meta.url))("@playwright/test");
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const preparation = ownerPreparation ? (await import("./e2e/online-owner-preparation.mjs")).ownerPreparationPlatform() : null;
const secret = "isolated-online-browser-fixture-secret-at-least-32-bytes";
const projectId = "b53115d2-18ae-44f2-bfd2-c47b3d1a7652";
const documentKey = "63275272-1454-4919-ade1-5e5b92b91e03";
const source = { revision: "d3b4b10a-c0d5-4711-a954-f354374f375b", sha256: "a".repeat(64) };
const teaching = onlineTeaching ? (await import("./e2e/online-teaching.mjs")).onlineTeachingPlatform({ projectId, source }) : null;
const publication = onlinePublication ? await (await import("./e2e/online-publication.mjs")).onlinePublicationPlatform({
  projectId, source, documentKey, inputPath: process.env.DECKWISE_E2E_PPTX, workerPath: process.env.DECKWISE_PPTX_WORKER, output }) : null;
const accounts = { owner: { userId: 41, role: "OWNER" }, editor: { userId: 42, role: "EDITOR" }, viewer: { userId: 43, role: "VIEWER" } };
const requests = [], docsEvents = [], issued = [], logs = [], errors = [], statuses = [];
const report = { status: "RUNNING", checks: [], directory, packaged: launch.packaged, realElectron: true,
  mode: onlinePublication ? "online-publication" : onlineTeaching ? "online-teaching" : ownerPreparation ? "owner-preparation" : unconfiguredOnly ? "unconfigured-only" : mountOnly ? "mount-only" : "six-groups", launches: [],
  realTeamProjectsUI: true, realMainAuthAndOnlineClient: true, realOfficeEntryAndLauncher: true,
  isolatedChildHome: true,
  localAuthFixture: true, localPlatformFixture: true, docsApiProtocolFixture: true,
  realSpringPlatform: false, realDocsSynchronization: false, paidCalls: false, sandbox: "--no-sandbox" };
let server, origin, app, page, account = "owner", sessionId, launchNumber = 0, localOffice;
const jwt = claims => {
  const parts = [Buffer.from('{"alg":"HS256","typ":"JWT"}').toString("base64url"), Buffer.from(JSON.stringify(claims)).toString("base64url")];
  return `${parts.join(".")}.${createHmac("sha256", secret).update(parts.join(".")).digest("base64url")}`;
};
const tokenFor = name => jwt({ fixtureAccount: name, exp: Math.floor(Date.now() / 1000) + 3600 });
function principal(request) {
  const token = request.headers.authorization?.replace(/^Bearer /u, "");
  if (!token) return null;
  try {
    const parts = token.split(".");
    assert.equal(parts[2], createHmac("sha256", secret).update(parts.slice(0, 2).join(".")).digest("base64url"));
    return accounts[JSON.parse(Buffer.from(parts[1], "base64url")).fixtureAccount] ?? null;
  } catch { return null; }
}
function offer(actor, clientId) {
  const exp = Math.floor(Date.now() / 1000) + 60;
  const docsUserId = `tenant-71-user-${actor.userId}${clientId ? `-client-${clientId}` : ""}`, edit = actor.role !== "VIEWER";
  const payload = { documentType: "slide", document: { key: documentKey, fileType: "pptx", title: "Presentation.pptx",
    url: `${origin}/source.pptx`, permissions: { edit } }, editorConfig: { mode: edit ? "edit" : "view",
    callbackUrl: `${origin}/callback`, user: { id: docsUserId, name: `User ${actor.userId}` },
    coEditing: { mode: "fast", change: false }, customization: { autosave: true },
    ...(onlinePublication ? { plugins: { autostart: ["asc.{D1ECA135-517C-4585-990C-6E0F2B001322}"], pluginsData: [`${origin}/docs-plugin/config.json`] } } : {}) }, iat: exp - 60, exp };
  const configJson = JSON.stringify({ documentType: payload.documentType, document: payload.document, editorConfig: payload.editorConfig, token: jwt(payload) });
  issued.push({ userId: actor.userId, configSha256: hash(configJson) });
  return { projectId, sessionEpoch: preparation?.session.epoch ?? 5, source: preparation?.source?.source ?? source,
    documentKey, docsUserId, configJson, expiresAtEpochMillis: exp * 1000, ...(clientId ? { clientId } : {}) };
}
const docsScript = `${onlinePublication ? (await import("./e2e/online-publication.mjs")).onlinePublicationDocsScript : ""}
  window.DocsAPI = { DocEditor: function(id, config) {
    const placeholder = document.getElementById(id);
    if (!placeholder || !config.document.permissions.edit || config.editorConfig.mode !== 'edit') throw Error('Invalid fixture mount');
    placeholder.textContent = 'Isolated Docs API fixture';
    let destroyed = false;
    window.__docsFixture = {
      ready() { if (!destroyed) config.events.onDocumentReady(); },
      state(dirty) { if (!destroyed) config.events.onDocumentStateChange({data:dirty}); },
      config: { key:config.document.key, userId:config.editorConfig.user.id }
    };
    fetch('/__verify', {method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(config, (key,value)=>key==='events'?undefined:value)})
      .then(reply=>{if(!reply.ok)throw Error('JWT verification failed');return reply.json();})
      .then(()=>{if(!destroyed)window.__docsFixture.ready();})
      .catch(()=>{if(!destroyed)config.events.onError({data:'fixture verification failed'});});
    this.destroyEditor = () => { destroyed = true; placeholder.textContent = ''; delete window.__docsFixture; };
  } };
`;
const invokeResult = (name, ...args) => page.evaluate(async ({ name, args }) =>
  window.piDesktop.invoke(window.piDesktop.channels.invoke[name], ...args), { name, args });
const invoke = async (name, ...args) => {
  const result = await invokeResult(name, ...args); assert(result.ok, JSON.stringify(result.error)); return result.data;
};
const step = async (name, run) => { console.log("START", name); await run(); report.checks.push(name); console.log("PASS", name); };
async function login(name) {
  account = name;
  const current = await invoke("authRestore");
  if (current.status === "authenticated") await invoke("authLogout");
  const qr = await invoke("authStartQr"); assert.equal(qr.status, "waitingForScan");
  const next = await invoke("authPollQr", { ticket: qr.ticket });
  assert.equal(next.status, "authenticated"); assert.equal(next.profile.userId, accounts[name].userId);
  await page.waitForFunction(() => Boolean(window.__PI_DESKTOP__));
}
async function teamPanel() {
  await page.evaluate(async id => { window.__PI_CAPTURE__ = true; await window.__PI_DESKTOP__.selectSession(id); window.__PI_DESKTOP__.openNewWorkPanelTab(); }, sessionId);
  await page.locator('[data-work-panel-launcher-item="team-projects"]').last().click();
  await expect(page.locator(".team-project-row")).toHaveCount(1);
}
async function nativeFrame() {
  let frame;
  await expect.poll(async () => {
    frame = app.context().pages().flatMap(target => target.frames()).find(candidate => candidate.url() === `${origin}/docs-online-host.html`);
    return !!frame && await frame.evaluate(() => Boolean(window.__docsFixture)).catch(() => false);
  }, { timeout: 15_000 }).toBe(true);
  return frame;
}
async function opened() {
  await page.getByRole("button", { name: "加入在线编辑", exact: true }).click();
  const frame = await nativeFrame();
  await expect.poll(async () => (await invoke("coursewareOnlineState")).status, { timeout: 15_000 }).toBe("ready");
  const state = await invoke("coursewareOnlineState"); assert.equal(state.projectId, projectId); assert(state.ownerId);
  assert(!JSON.stringify(state).includes("configJson") && !JSON.stringify(state).includes("token"));
  return frame;
}
async function start(configured) {
  launchNumber++;
  const environment = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    !/api.?key|secret|token|password|proxy/i.test(key) && !/^DECKWISE_DOCS_/u.test(key)));
  app = await _electron.launch({ executablePath: launch.executablePath, cwd: launch.cwd,
    args: [...launch.args, "--no-sandbox", `--user-data-dir=${join(directory, `profile-${launchNumber}`)}`],
    env: { ...environment, HOME: fixtureHome, USERPROFILE: fixtureHome, ELECTRON_RUN_AS_NODE: "", ELECTRON_RENDERER_URL: "",
      PI_DESKTOP_DATA_DIR: join(directory, `data-${launchNumber}`),
      PI_DESKTOP_START_MAXIMIZED: "0", DECKWISE_PLATFORM_BASE_URL: `${origin}/api/backend`,
      ...(ownerPreparation ? { DECKWISE_EDITOR_URL: "http://127.0.0.1:4367" } : {}),
      ...(configured ? { DECKWISE_DOCS_ONLINE_ENTRY_URL: `${origin}/courseware-online.html`,
        DECKWISE_DOCS_API_URL: `${origin}/web-apps/apps/api/documents/api.js`,
        ...(onlinePublication ? { DECKWISE_DOCS_PLUGIN_CONFIG_URL: `${origin}/docs-plugin/config.json` } : {}) } : {}) }, timeout: 45_000 });
  const processInfo = { configured, pid: app.process().pid, dataDir: join(directory, `data-${launchNumber}`),
    profileDir: join(directory, `profile-${launchNumber}`), exitCode: null, signal: null };
  report.launches.push(processInfo);
  app.process().once("exit", (code, signal) => { processInfo.exitCode = code; processInfo.signal = signal; });
  for (const stream of [app.process().stdout, app.process().stderr]) stream.on("data", bytes => logs.push(String(bytes)));
  try { page = await app.firstWindow({ timeout: 60_000 }); }
  catch (error) {
    processInfo.startupFailure = { message: String(error), exitCodeBeforeCleanup: app.process().exitCode,
      signalBeforeCleanup: app.process().signalCode,
      main: await app.evaluate(({ app, BrowserWindow }) => ({ userData: app.getPath("userData"),
        dataDir: process.env.PI_DESKTOP_DATA_DIR, windows: BrowserWindow.getAllWindows().length })).catch(() => null) };
    throw error;
  }
  page.on("pageerror", error => errors.push(error.stack));
  await app.evaluate(({ app, BrowserWindow, session }) => {
    const installed = new Set();
    const protect = contents => {
      if (installed.has(contents.session)) return;
      installed.add(contents.session);
      contents.session.webRequest.onBeforeRequest((details, done) => {
        const url = new URL(details.url);
        done({ cancel: /^https?:$/u.test(url.protocol) && !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) });
      });
    };
    session.defaultSession.webRequest.onBeforeRequest((details, done) => {
      const url = new URL(details.url); done({ cancel: /^https?:$/u.test(url.protocol) && !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) });
    });
    app.on("web-contents-created", (_event, contents) => protect(contents));
    const window = BrowserWindow.getAllWindows()[0]; window.setBounds({ x: 0, y: 0, width: 1440, height: 1000 });
  });
  await page.waitForFunction(() => Boolean(window.piDesktop));
}
async function stop() {
  if (!app) return;
  const current = app; app = undefined;
  if (current.process().exitCode === null && current.process().signalCode === null) {
    const exited = new Promise(done => current.process().once("exit", done));
    await current.evaluate(({ app }) => app.exit(0)); await exited;
  }
}
try {
  if (ownerPreparation) {
    const { pathToFileURL } = await import("node:url");
    const requireOffice = createRequire(join(officeRoot, "package.json"));
    const { preview } = await import(pathToFileURL(requireOffice.resolve("vite")).href);
    localOffice = await preview({ configFile: false, root: officeRoot,
      build: { outDir: resolve(process.env.DECKWISE_E2E_OFFICE_DIST) },
      preview: { host: "127.0.0.1", port: 4367, strictPort: true } });
  }
  server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url, "http://fixture"), path = url.pathname;
      const send = (data, code = 200) => { response.setHeader("content-type", "application/json"); response.end(JSON.stringify({ code, data })); };
      if (publication && await publication.storage({ path, request, response })) return;
      if (path === "/__verify") {
        let raw = ""; for await (const bytes of request) raw += bytes; assert(raw.length < 100_000);
        const config = JSON.parse(raw), [header, payload, signature] = config.token.split(".");
        assert.equal(signature, createHmac("sha256", secret).update(`${header}.${payload}`).digest("base64url"));
        const claims = JSON.parse(Buffer.from(payload, "base64url")); assert.deepEqual(config.document, claims.document);
        assert.deepEqual(config.editorConfig, claims.editorConfig); assert.equal(config.document.key, documentKey);
        assert(claims.exp > Date.now() / 1000); const configSha256 = hash(raw); assert(issued.some(item => item.configSha256 === configSha256));
        docsEvents.push({ type: "verified-mount", key: config.document.key, userId: config.editorConfig.user.id, configSha256 });
        return send({ ok: true });
      }
      if (path === "/web-apps/apps/api/documents/api.js") { response.setHeader("content-type", "text/javascript"); return response.end(docsScript); }
      if (path === "/docs-online-host.html") {
        response.setHeader("content-type", "text/html"); return response.end(await readFile(join(officeRoot, "public/docs-online-host.html")));
      }
      if (path === "/courseware-online.html" || /^\/assets\/[A-Za-z0-9_.-]+\.js$/u.test(path)) {
        const bytes = await readFile(join(officeDist, path.slice(1)));
        response.setHeader("content-type", path.endsWith(".js") ? "text/javascript" : "text/html"); return response.end(bytes);
      }
      assert(path.startsWith("/api/backend/"), `Unexpected fixture route ${path}`);
      const actor = principal(request), route = path.slice("/api/backend".length);
      requests.push({ method: request.method, path: route, userId: actor?.userId ?? null });
      if (route === "/auth/desktop/wx/qrcode") return send({ ticket: `fixture-${account}`, entryUrl: `${origin}/fixture-login` });
      if (route.startsWith("/auth/wx/poll/")) return send({ status: "SUCCESS", accessToken: tokenFor(account), refreshToken: `fixture-refresh-${account}` });
      if (["/auth/desktop/refresh", "/auth/refresh"].includes(route)) return send({ accessToken: tokenFor(account), refreshToken: `fixture-refresh-${account}` });
      if (route === "/auth/logout") return send({});
      assert(actor, "Authenticated fixture request required");
      if (route === "/auth/me") return send({ userId: actor.userId, userName: `Fixture ${actor.role}`, tenantId: 71,
        tenantName: "Isolated team", role: "TEACHER", edition: "EDUCATION", pcAllowed: true });
      if (route === "/courseware/team/projects") return send([{ projectId, ownerUserId: accounts.owner.userId, role: actor.role, createdAt: "2026-10-24T00:00:00Z" }]);
      if (preparation && await preparation.handle({ request, route, actor, send, projectId, documentKey, origin, output })) return;
      if (teaching && await teaching.handle({ request, response, route, actor, send })) return;
      if (publication && await publication.handle({ request, response, route, actor, send, origin, url })) return;
      if (!teaching && !publication && route === `/courseware/team/projects/${projectId}/teaching` && request.method === "GET") return send(null, 46606);
      if (!teaching && !publication && route === `/courseware/team/projects/${projectId}/editing-session/${preparation?.session.epoch ?? 5}/write-pauses/current` && request.method === "GET") return send(null);
      if (route === `/courseware/team/projects/${projectId}/editing-session` && request.method === "GET")
        return send({ projectId, epoch: 5, sessionId: documentKey, active: true });
      if (route === `/courseware/team/projects/${projectId}/editing-session/${preparation?.session.epoch ?? 5}/editor-config` && request.method === "POST") {
        if (preparation) assert.equal(preparation.boundKey, documentKey);
        let clientId;
        if (publication) {
          let raw = ""; for await (const bytes of request) raw += bytes; clientId = JSON.parse(raw).clientId;
          publication.register(clientId, `tenant-71-user-${actor.userId}-client-${clientId}`);
        }
        return send(offer(actor, clientId));
      }
      throw new Error(`Unexpected fixture request ${request.method} ${route}`);
    } catch (error) { errors.push(`FIXTURE ${error.stack}`); response.writeHead(500); response.end("Fixture request rejected"); }
  });
  await new Promise(done => server.listen(0, "127.0.0.1", done)); origin = `http://127.0.0.1:${server.address().port}`;
  const entryBytes = await readFile(join(officeDist, "courseware-online.html"));
  const asset = entryBytes.toString().match(/src="\.\/([^"]+\.js)"/u)?.[1]; assert(asset);
  report.artifacts = { officeEntry: { sha256: hash(entryBytes), asset, assetSha256: hash(await readFile(join(officeDist, asset))) },
    mainSha256: hash(await readFile(join(launch.cwd, launch.packaged ? "resources/app.asar" : "out/main/index.js"))) };
  if (ownerPreparation) {
    await start(true); await login("owner"); await invoke("projectSet", workspace);
    sessionId = (await invoke("sessionCreate", { title: "Owner preparation fixture", projectPath: workspace, mode: "agent" })).session.id;
    report.preparation = await (await import("./e2e/online-owner-preparation.mjs")).verifyOwnerPreparation({
      app, page, expect, invoke, step, teamPanel, nativeFrame, preparation, projectId, sessionId, workspace, output, requests,
      dataDir: join(directory, `data-${launchNumber}`) });
    report.artifacts.hostSha256 = hash(await readFile(process.env.PI_DESKTOP_HOST_BIN));
    report.artifacts.runnerSha256 = hash(await readFile(new URL(import.meta.url)));
    report.artifacts.ownerHelperSha256 = hash(await readFile(new URL("./e2e/online-owner-preparation.mjs", import.meta.url)));
  }
  if (onlineTeaching) {
    await start(true); await login("owner"); await invoke("projectSet", workspace);
    sessionId = (await invoke("sessionCreate", { title: "Online teaching fixture", projectPath: workspace })).session.id;
    report.teaching = await (await import("./e2e/online-teaching.mjs")).verifyOnlineTeaching({
      app, page, expect, invoke, step, teamPanel, opened, nativeFrame, teaching, projectId, output });
    report.artifacts.runnerSha256 = hash(await readFile(new URL(import.meta.url)));
    report.artifacts.teachingHelperSha256 = hash(await readFile(new URL("./e2e/online-teaching.mjs", import.meta.url)));
    if (process.env.PI_DESKTOP_HOST_BIN) report.artifacts.hostSha256 = hash(await readFile(process.env.PI_DESKTOP_HOST_BIN));
  }
  if (onlinePublication) {
    await start(true); await login("owner"); await invoke("projectSet", workspace);
    sessionId = (await invoke("sessionCreate", { title: "Online fixed publication fixture", projectPath: workspace })).session.id;
    report.publication = await (await import("./e2e/online-publication.mjs")).verifyOnlinePublication({
      app, page, expect, invoke, step, teamPanel, opened, publication, projectId, sessionId, output });
    report.artifacts.runnerSha256 = hash(await readFile(new URL(import.meta.url)));
    report.artifacts.publicationHelperSha256 = hash(await readFile(new URL("./e2e/online-publication.mjs", import.meta.url)));
    report.artifacts.hostSha256 = hash(await readFile(process.env.PI_DESKTOP_HOST_BIN));
    report.artifacts.workerSha256 = hash(await readFile(process.env.DECKWISE_PPTX_WORKER));
  }
  if (!unconfiguredOnly && !ownerPreparation && !onlineTeaching && !onlinePublication) {
  await start(true); await login("owner");
  await invoke("projectSet", workspace);
  sessionId = (await invoke("sessionCreate", { title: "Online join fixture", projectPath: workspace })).session.id;
  await step("Owner clicks the real team join button and mounts the pinned Office entry with the exact signed config", async () => {
    await teamPanel(); await opened();
    assert.equal(docsEvents.at(-1).userId, "tenant-71-user-41");
    const onlinePages = app.context().pages().filter(target => target !== page);
    assert(onlinePages.length); const urls = onlinePages.flatMap(target => target.frames().map(frame => frame.url()));
    assert(urls.some(url => url.startsWith(`${origin}/courseware-online.html?`)));
    assert(urls.every(url => !url.includes("configJson") && !url.includes("token=")));
    if (mountOnly) {
      const rect = await page.locator(".courseware-online-editor .ppt-editor-surface").evaluate(element => {
        const { x, y, width, height } = element.getBoundingClientRect();
        return Object.fromEntries(Object.entries({ x, y, width, height }).map(([key, value]) => [key, Math.round(value)]));
      });
      assert(rect.width > 0 && rect.height > 0, "Renderer editor slot must have nonzero size");
      const nativeBounds = () => app.evaluate(({ BrowserWindow }) => {
        const window = BrowserWindow.getAllWindows()[0];
        const children = window.contentView.children.filter(child => child.webContents?.getURL() === "deckwise-editor://host/online.html");
        return { onlineChildren: children.length, bounds: children[0]?.getBounds() ?? null, content: window.getContentBounds(),
          windowVisible: window.isVisible() };
      });
      await expect.poll(async () => {
        report.nativeVisibility = { rendererSlot: rect, ...await nativeBounds() };
        return report.nativeVisibility.onlineChildren === 1 && report.nativeVisibility.bounds &&
          Object.entries(rect).every(([key, value]) => report.nativeVisibility.bounds[key] === value);
      }, { timeout: 5000 }).toBe(true);
      const actual = report.nativeVisibility;
      assert(actual.windowVisible, "Main window must be visible");
      assert(actual.bounds.x >= 0 && actual.bounds.y >= 0 && actual.bounds.width > 0 && actual.bounds.height > 0);
      assert(actual.bounds.x + actual.bounds.width <= actual.content.width && actual.bounds.y + actual.bounds.height <= actual.content.height,
        "Attached native editor must stay inside the main window content");
      const frame = await nativeFrame();
      await expect(frame.getByText("Isolated Docs API fixture", { exact: true })).toBeVisible();
      await frame.page().screenshot({ path: join(output, "native-online-view.png") });
      report.nativeVisibility.nativeViewScreenshot = "native-online-view.png";
    }
    await page.screenshot({ path: join(output, "owner-mounted.png") });
  });
  if (!mountOnly) {
  await step("Native dirty/clean notifications reach Desktop state without claiming a durable save receipt", async () => {
    const frame = await nativeFrame();
    for (const [dirty, expected] of [[true, "sync-pending"], [false, "sync-reported"]]) {
      await frame.evaluate(dirty => window.__docsFixture.state(dirty), dirty);
      await expect.poll(async () => (await invoke("coursewareOnlineState")).status).toBe(expected);
      statuses.push(expected);
    }
  });
  await step("Closing the UI releases this local view without ending or replacing the shared session", async () => {
    await page.locator(".courseware-online-editor header button").last().click();
    await expect(page.locator(".team-project-row")).toHaveCount(1);
    await expect.poll(async () => (await invoke("coursewareOnlineState")).status).toBe("closed");
    assert(!requests.some(item => item.method === "DELETE" || /document-binding$/u.test(item.path)));
    assert(!requests.some(item => item.method === "POST" && /editing-session$/u.test(item.path)));
  });
  await step("Editor joins the same active key and changing accounts destroys the old local view", async () => {
    await login("editor"); await teamPanel(); await opened();
    assert.equal(docsEvents.at(-1).key, documentKey); assert.equal(docsEvents.at(-1).userId, "tenant-71-user-42");
    await invoke("authLogout");
    await expect.poll(async () => (await invoke("coursewareOnlineState")).status).toBe("closed");
    assert(!app.context().pages().flatMap(target => target.frames()).some(frame => frame.url() === `${origin}/docs-online-host.html`));
    await login("viewer"); await teamPanel();
    await expect(page.getByRole("button", { name: "加入在线编辑", exact: true })).toHaveCount(0);
  });
  await step("Viewer cannot bypass the absent UI action through the production Main online-open IPC", async () => {
    const before = docsEvents.length;
    const result = await invokeResult("coursewareOnlineOpen", { ownerId: randomUUID(), projectId });
    const state = await invoke("coursewareOnlineState");
    assert.equal(state.status, "error"); assert.equal(state.errorCode, "COURSEWARE_ONLINE_READ_ONLY");
    assert.equal(docsEvents.length, before);
    report.viewerRefusal = { ipcOk: result.ok, errorCode: state.errorCode, platformIssuedViewConfig: issued.at(-1)?.userId === accounts.viewer.userId };
  });
  }
  }
  if (!mountOnly && !ownerPreparation && !onlineTeaching && !onlinePublication) {
  await step("An unconfigured deployment disables the real join action and leaves the team list usable", async () => {
    await stop(); await start(false); await login("owner");
    await invoke("projectSet", workspace);
    sessionId = (await invoke("sessionCreate", { title: "Unavailable deployment", projectPath: workspace })).session.id;
    await teamPanel();
    assert.equal((await invoke("coursewareOnlineState")).available, false);
    await expect(page.getByRole("button", { name: "加入在线编辑", exact: true })).toBeDisabled();
    await expect(page.getByRole("button", { name: "预览播放", exact: true })).toBeEnabled();
    await page.screenshot({ path: join(output, "deployment-unavailable.png") });
  });
  }
  assert.deepEqual(errors, []); report.status = "PASS";
} catch (error) { report.status = "FAIL"; report.error = error.stack; process.exitCode = 1;
  if (page) {
    await page.screenshot({ path: join(output, "failure.png") }).catch(() => {});
    await writeFile(join(output, "failure-aria.txt"), await page.locator("body").ariaSnapshot()).catch(() => {});
  }
} finally {
  await stop().catch(error => errors.push(`CLEANUP ${error.stack}`));
  await new Promise(done => server ? server.close(done) : done());
  if (localOffice) await new Promise(done => localOffice.httpServer.close(done));
  await writeFile(join(output, "electron.log"), logs.join(""));
  await writeFile(join(output, "report.json"), JSON.stringify({ ...report, requests, docsEvents, statuses, errors }, null, 2));
}
