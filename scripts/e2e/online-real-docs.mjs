/** Current Desktop entry against an independently bootstrapped official Docs engine. */
import assert from "node:assert/strict";
import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { copyFile, mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, extname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { coursewareLaunch } from "./boot.mjs";

export async function runRealDocs() {
  for (const key of ["DECKWISE_E2E_OUTPUT", "DECKWISE_E2E_OFFICE_ROOT", "DECKWISE_E2E_ONLINE_ENTRY_DIST",
    "DECKWISE_E2E_DOCS_SECRET_FILE", "DECKWISE_E2E_DOCS_PLUGINS_JS"]) assert(process.env[key], `Missing ${key}`);
  const output = resolve(process.env.DECKWISE_E2E_OUTPUT);
  await mkdir(dirname(output), { recursive: true }); await mkdir(output);
  const secretFile = resolve(process.env.DECKWISE_E2E_DOCS_SECRET_FILE);
  assert.equal((await stat(secretFile)).mode & 0o077, 0, "Ephemeral secret file must be private");
  const secret = (await readFile(secretFile, "utf8")).trim(); assert(secret.length >= 32);
  const office = resolve(process.env.DECKWISE_E2E_OFFICE_ROOT), entryDist = join(output, "entry");
  const fixture = "http://127.0.0.1:49194", docs = "http://127.0.0.1:47894";
  const launch = coursewareLaunch(); assert.equal(launch.packaged, false, "This gate targets the current source build");
  const require = createRequire(new URL("../../packages/courseware-runtime/package.json", import.meta.url));
  const { _electron, chromium, expect } = require("@playwright/test");
  const officeRequire = createRequire(join(office, "package.json"));
  const { build } = await import(pathToFileURL(officeRequire.resolve("vite")).href);
  const directory = await mkdtemp(join(tmpdir(), "deckwise-real-docs-"));
  const workspace = join(directory, "workspace"), home = join(directory, "home");
  await mkdir(workspace); await mkdir(home);
  const digest = bytes => createHash("sha256").update(bytes).digest("hex");
  const redact = text => String(text).replaceAll(secret, "[REDACTED]").replace(/eyJ[A-Za-z0-9_.-]+/gu, "[REDACTED_JWT]");
  const logs = [], errors = [], callbacks = [], requests = [], reads = [];
  const nativeDiagnostics = [];
  const report = { status: "RUNNING", checks: [], directory, realElectron: true, realDocsEngine: true,
    realDesktopTeamEntry: true, nativeKeyboardEdits: true, realSpringPlatform: false,
    localAuthAndPlatformFixture: true, localSignedCallbackStorageFixture: true,
    paidCalls: false, packaged: false, sandbox: "--no-sandbox", reads };
  let app, page, browser, peer, server, sessionId, nativePage;
  const projectId = randomUUID(); let documentKey = randomUUID(), epoch = 1, sourceFilename = "source.pptx";
  const ownedKeys = new Set([documentKey]);
  const revision = randomUUID(); let sourceSha;
  const sign = claims => {
    const parts = [Buffer.from('{"alg":"HS256","typ":"JWT"}').toString("base64url"), Buffer.from(JSON.stringify(claims)).toString("base64url")];
    return `${parts.join(".")}.${createHmac("sha256", secret).update(parts.join(".")).digest("base64url")}`;
  };
  const verify = (token, body) => {
    if (typeof token !== "string") return false;
    try {
      const parts = token.split("."); if (parts.length !== 3) return false;
      const actual = Buffer.from(parts[2], "base64url"), expected = createHmac("sha256", secret).update(parts.slice(0, 2).join(".")).digest();
      if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return false;
      const header = JSON.parse(Buffer.from(parts[0], "base64url")); if (header.alg !== "HS256") return false;
      const claims = JSON.parse(Buffer.from(parts[1], "base64url")), { token: _token, ...unsigned } = body;
      const { iat, exp, ...signed } = claims;
      return (exp === undefined || exp > Date.now() / 1000) && (iat === undefined || iat <= Date.now() / 1000 + 30) &&
        isDeepStrictEqual(claims.payload ?? signed, unsigned);
    } catch { return false; }
  };
  const offer = userId => {
    const exp = Math.floor(Date.now() / 1000) + 60, docsUserId = `tenant-71-user-${userId}`;
    const config = { documentType: "slide", document: { key: documentKey, fileType: "pptx", title: "W13 real Docs.pptx",
      url: `${fixture}/${sourceFilename}`, permissions: { edit: true } }, editorConfig: { mode: "edit", callbackUrl: `${fixture}/callback`,
      user: { id: docsUserId, name: `Synthetic actor ${userId}` }, coEditing: { mode: "fast", change: false }, customization: { autosave: true },
      plugins: { autostart: ["asc.{D1ECA135-517C-4585-990C-6E0F2B001322}"], pluginsData: [`${fixture}/modules/config.json`] } } };
    return { projectId, sessionEpoch: epoch, source: { revision, sha256: sourceSha }, documentKey, docsUserId,
      configJson: JSON.stringify({ ...config, token: sign({ ...config, iat: exp - 60, exp }) }), expiresAtEpochMillis: exp * 1000 };
  };
  const invoke = async (name, ...args) => {
    const result = await page.evaluate(({ name, args }) => window.piDesktop.invoke(window.piDesktop.channels.invoke[name], ...args), { name, args });
    assert(result.ok, JSON.stringify(result.error)); return result.data;
  };
  const step = async (name, run) => { console.log("START", name); await run(); report.checks.push(name); console.log("PASS", name); };
  const pluginFrame = target => target.frames().find(frame => frame.url().startsWith(`${fixture}/modules/index.html`));
  async function nativeRead(target) {
    const frame = pluginFrame(target); assert(frame, "Actual native plugin frame is missing");
    const value = await frame.evaluate(() => new Promise(done => window.Asc.plugin.callCommand(function () {
      try {
        const presentation = Api.GetPresentation(), slides = [];
        for (let index = 0; index < presentation.GetSlidesCount(); index++) slides.push(presentation.GetSlideByIndex(index).GetAllShapes()
          .map(shape => shape.GetDocContent()?.GetText()).filter(value => typeof value === "string"));
        return { totalSlides: presentation.GetSlidesCount(), page: presentation.GetCurSlideIndex() + 1, slides };
      } catch (error) { return { error: String(error) }; }
    }, false, false, done)));
    assert(value && !value.error && Array.isArray(value.slides), "Native read unavailable"); return value;
  }
  async function findNativePage() {
    let target;
    await expect.poll(async () => {
      report.observedPages = app.context().pages().map(candidate => ({url:redact(candidate.url()),frames:candidate.frames().map(frame=>redact(frame.url()))}));
      target = app.context().pages().find(candidate => candidate.url() === "deckwise-editor://host/online.html" ||
        candidate.frames().some(frame => frame.url().startsWith(fixture + "/courseware-online.html")));
      if (target && !target.isClosed()) await target.evaluate(fixture => {
        if (window.__w13ObservingEntry) return;
        window.__w13ObservingEntry = true;
        window.addEventListener("message", event => {
          if (event.data?.protocol === "deckwise-docs-online/1" && event.data?.type === "error") {
            fetch(fixture + "/native-diagnostic", { method: "POST", body: JSON.stringify({source:"raw-entry",code:event.data.code}) }).catch(() => {});
          }
        }, true);
      }, fixture).catch(() => {});
      const docsFrame = target?.frames().find(frame => frame.url().startsWith(docs + "/") && frame.url().includes("presentationeditor/main"));
      if (docsFrame) report.pluginLoader = await docsFrame.evaluate(() => {
        const p=window.PE?.getController?.("Common.Controllers.Plugins");
        if (!p) return {controllerPresent:false};
        return {controllerPresent:true,langType:typeof p.appOptions?.lang,langPresent:typeof p.appOptions?.lang === "string" && p.appOptions.lang.length > 0,serverPluginsValueType:typeof p.serverPlugins?.plugins,serverPluginsIsFalse:p.serverPlugins?.plugins===false,configPluginCount:p.configPlugins?.plugins?.length,serverPluginCount:p.serverPlugins?.plugins?.length,
          configPresent:!!p.configPlugins?.config,actualLang:p.appOptions?.lang,autostart:p.autostart,startOnPostLoad:p.startOnPostLoad,canPlugins:p.appOptions?.canPlugins,
          scriptLoaded:window.Common?.Controllers?.LaunchController?.isScriptLoaded?.(),
          registered:window.PE.getCollection("Common.Collections.Plugins")?.map(x=>({guid:x.get("guid"),visible:x.get("visible")}))};
      }).catch(error=>({error:String(error)}));
      const state = await invoke("coursewareOnlineState");
      assert.notEqual(state.status, "error", JSON.stringify(state));
      return !!target && !!pluginFrame(target) && await pluginFrame(target).evaluate(() => Boolean(window.Asc?.plugin?.callCommand)).catch(() => false);
    }, { timeout: 60_000 }).toBe(true);
    return target;
  }
  async function openDesktop() {
    await page.getByRole("button", { name: "加入在线编辑", exact: true }).click();
    nativePage = await findNativePage();
    await expect.poll(async () => (await invoke("coursewareOnlineState")).status, { timeout: 60_000 }).toBe("ready");
    await expect.poll(async () => { try { return (await nativeRead(nativePage)).totalSlides; } catch { return 0; } }, { timeout: 45_000 }).toBe(3);
    return nativePage;
  }
  async function keyboardReplace(target, index, replacement) {
    const docsFrame = target.frames().find(frame=>frame.url().startsWith(docs + "/") && frame.url().includes("presentationeditor/main"));
    assert(docsFrame);
    const gotIt = docsFrame.getByText(/^(Got it|知道了)$/).first();
    if (await gotIt.isVisible().catch(()=>false)) await gotIt.click();
    const plugin = pluginFrame(target); assert(plugin);
    const selected = await plugin.evaluate(index => {
      window.Asc.scope.w13ShapeIndex = index;
      return new Promise(done => window.Asc.plugin.callCommand(function () {
        const shape = Api.GetPresentation().GetSlideByIndex(0).GetAllShapes().filter(shape => shape.GetDocContent()?.GetText())[Asc.scope.w13ShapeIndex];
        if (!shape || typeof shape.Select !== "function") return { error: "Native shape selection unavailable" };
        return { selected: shape.Select() === true };
      }, false, false, done));
    }, index);
    assert(selected?.selected, JSON.stringify(selected));
    // Selection is setup only. All text mutations below are trusted keyboard events in the real native editor.
    await target.bringToFront();
    await docsFrame.locator("#area_id").focus();
    report.keyboardFocus ??= [];
    report.keyboardFocus.push(await docsFrame.evaluate(()=>({tag:document.activeElement?.tagName,id:document.activeElement?.id})));
    await target.keyboard.press("Enter"); await target.keyboard.press("Control+A"); await target.keyboard.type(replacement, { delay: 30 });
    await target.keyboard.press("Escape");
    await expect.poll(async () => { try { return JSON.stringify(await nativeRead(target)).includes(replacement); } catch { return false; } },
      { timeout: 20_000 }).toBe(true);
  }
  try {
    await build({ root: office, configFile: false, publicDir: false, base: "./", logLevel: "warn",
      build: { outDir: entryDist, emptyOutDir: false, rollupOptions: { input: join(office, "courseware-online.html") } } });
    await build({ root: office, configFile: false, publicDir: false, logLevel: "warn", build: { outDir: join(output, "modules"),
      emptyOutDir: false, minify: false, lib: { entry: { "docs-community-plugin-entry": join(office, "lib/docs-community-plugin-entry.ts") },
        formats: ["es"], fileName: (_format, name) => `${name}.js` } } });
    for (const name of ["index.html", "config.json"]) await copyFile(join(office, "public/docs-community-plugin", name), join(output, "modules", name));
    await copyFile(process.env.DECKWISE_E2E_DOCS_PLUGINS_JS, join(output, "modules/plugins.js"));
    const b90 = "/home/jhz/code/train/docs/validation/courseware/parallel/B/b90-online-mount-races-20261021/source.pptx";
    await copyFile(b90, join(output, "source.pptx")); sourceSha = digest(await readFile(join(output, "source.pptx")));
    report.source = { sha256: sourceSha, bytes: (await stat(join(output, "source.pptx"))).size };
    const main = await readFile(join(launch.cwd, "out/main/index.js"));
    const entry = await readFile(join(entryDist, "courseware-online.html"));
    await copyFile(join(office, "public/docs-online-host.html"), join(output, "served-docs-online-host.html"));
    report.artifacts = { hostHtmlSha256: digest(await readFile(join(output, "served-docs-online-host.html"))), runnerSha256: digest(await readFile(new URL(import.meta.url))), mainSha256: digest(main), officeEntrySha256: digest(entry),
      pluginEntrySha256: digest(await readFile(join(output, "modules/docs-community-plugin-entry.js"))),
      matchedPluginsJsSha256: digest(await readFile(join(output, "modules/plugins.js"))) };
    server = createServer(async (request, response) => {
      try {
        const path = new URL(request.url, fixture).pathname;
        if (path.startsWith("/modules/")) response.setHeader("Access-Control-Allow-Origin", docs);
        if (!path.startsWith("/api/backend/") && path !== "/callback") requests.push({ method: request.method, path });
        if (path === "/native-diagnostic" && request.method === "POST") {
          let body = ""; for await (const bytes of request) { body += bytes; assert(body.length <= 8192); }
          nativeDiagnostics.push({ type: "native-docs-onError", event: redact(body) }); response.writeHead(204); return response.end();
        }
        if (path === "/favicon.ico") { response.writeHead(204); return response.end(); }
        const send = (value, code = 200) => { response.setHeader("content-type", "application/json"); response.end(JSON.stringify({ code, data: value })); };
        if (path === "/callback" && request.method === "POST") {
          let body = ""; for await (const bytes of request) { body += bytes; assert(body.length <= 1_048_576); }
          const value = JSON.parse(body); assert(verify(value.token ?? request.headers.authorization?.replace(/^Bearer /u, ""), value), "Unsigned callback");
          assert(ownedKeys.has(value.key), "Callback key must match an owned session");
          const record = { key: value.key, status: value.status, users: value.users, forcesavetype: value.forcesavetype, signed: true };
          if ([2, 6].includes(value.status)) {
            const url = new URL(value.url); assert.equal(url.origin, docs, "Download stays on the independently owned real Docs engine");
            const download = await fetch(url, { redirect: "error", signal: AbortSignal.timeout(30_000) }); assert(download.ok);
            const data = Buffer.from(await download.arrayBuffer()); assert(data.length > 100);
            record.saved = `saved-${callbacks.length}.pptx`; record.sha256 = digest(data); record.bytes = data.length;
            await writeFile(join(output, record.saved), data);
          }
          callbacks.push(record); await writeFile(join(output, "callbacks.json"), JSON.stringify(callbacks, null, 2));
          response.setHeader("content-type", "application/json"); return response.end('{"error":0}');
        }
        if (path.startsWith("/api/backend/")) {
          const route = path.slice("/api/backend".length);
          requests.push({ method: request.method, path: route, authorized: Boolean(request.headers.authorization) });
          if (route === "/auth/desktop/wx/qrcode") return send({ ticket: "synthetic-real-docs", entryUrl: `${fixture}/synthetic-login` });
          if (route.startsWith("/auth/wx/poll/") || route === "/auth/desktop/refresh") return send({ status: "SUCCESS",
            accessToken: sign({ exp: Math.floor(Date.now() / 1000) + 3600, synthetic: true }), refreshToken: "synthetic-real-docs-refresh" });
          assert(request.headers.authorization, "Main owns the fixture platform credential");
          if (route === "/auth/me") return send({ userId: 41, tenantId: 71, userName: "Synthetic real Docs actor A", tenantName: "Isolated fixture",
            role: "TEACHER", edition: "EDUCATION", pcAllowed: true });
          if (route === "/auth/logout") return send({});
          if (route === "/courseware/team/projects") return send([{ projectId, ownerUserId: 41, role: "OWNER", createdAt: "2026-10-24T00:00:00Z" }]);
          if (route === `/courseware/team/projects/${projectId}/editing-session` && request.method === "GET") return send({ projectId, epoch, sessionId: documentKey, active: true });
          if (route === `/courseware/team/projects/${projectId}/editing-session/${epoch}/editor-config` && request.method === "POST") return send(offer(41));
          throw new Error(`Unexpected Platform fixture request ${request.method} ${route}`);
        }
        if (path === "/peer.html") { response.setHeader("content-type", "text/html"); return response.end('<html><body style="margin:0"><iframe id="entry" style="width:100vw;height:100vh;border:0"></iframe></body></html>'); }
        if (path === "/docs-online-host.html") { response.setHeader("content-type", "text/html"); return response.end(await readFile(join(office, "public/docs-online-host.html"))); }
        const base = path === "/courseware-online.html" || /^\/assets\/[A-Za-z0-9_.-]+\.js$/u.test(path) ? entryDist : output;
        const file = resolve(base, `.${path}`); assert(file.startsWith(base + "/") && !path.includes(".."));
        response.setHeader("cache-control", "no-store");
        response.setHeader("content-type", ({ ".html": "text/html", ".js": "text/javascript", ".json": "application/json", ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation" })[extname(file)] ?? "application/octet-stream");
        response.end(await readFile(file));
      } catch (error) { errors.push(redact(error.stack)); response.writeHead(500); response.end("Isolated real Docs fixture refused request"); }
    });
    await new Promise(done => server.listen(49194, "0.0.0.0", done));
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/api.?key|secret|token|password|proxy/i.test(key) && !/^DECKWISE_DOCS_/u.test(key)));
    app = await _electron.launch({ executablePath: launch.executablePath, cwd: launch.cwd,
      args: [...launch.args, "--no-sandbox", `--user-data-dir=${join(directory, "profile")}`],
      env: { ...env, HOME: home, USERPROFILE: home, ELECTRON_RUN_AS_NODE: "", ELECTRON_RENDERER_URL: "", PI_DESKTOP_DATA_DIR: join(directory, "data"),
        PI_DESKTOP_START_MAXIMIZED: "0", DECKWISE_PLATFORM_BASE_URL: `${fixture}/api/backend`,
        DECKWISE_DOCS_ONLINE_ENTRY_URL: `${fixture}/courseware-online.html`, DECKWISE_DOCS_API_URL: `${docs}/web-apps/apps/api/documents/api.js`,
        DECKWISE_DOCS_PLUGIN_CONFIG_URL: `${fixture}/modules/config.json` }, timeout: 60_000 });
    for (const stream of [app.process().stdout, app.process().stderr]) stream.on("data", bytes => logs.push(redact(bytes)));
    const observe = target => {
      target.on("pageerror", error => nativeDiagnostics.push({type:"pageerror",text:redact(error.stack)}));
      target.on("requestfailed", request => nativeDiagnostics.push({type:"requestfailed",url:redact(request.url()),failure:request.failure()?.errorText}));
      target.on("framenavigated", frame => nativeDiagnostics.push({type:"framenavigated",url:redact(frame.url())}));
      target.on("console", message => {
      if (["error", "warning"].includes(message.type()) || message.text().includes("W13_REAL_NATIVE_ERROR")) nativeDiagnostics.push({ type: message.type(), text: redact(message.text()) });
    }); };
    for (const target of app.context().pages()) observe(target);
    app.context().on("page", observe);
    report.pid = app.process().pid;
    app.process().once("exit", (code, signal) => { report.exitCode = code; report.signal = signal; });
    page = await app.firstWindow({ timeout: 60_000 });
    page.on("pageerror", error => errors.push(redact(error.stack)));
    await app.evaluate(({ app, BrowserWindow, ipcMain }) => {
      globalThis.__w13NativeOnlineEvents = [];
      ipcMain.on("deckwise-online:event", (event, data) => {
        if (event.senderFrame?.url === "deckwise-editor://host/online.html") globalThis.__w13NativeOnlineEvents.push({
          type: data?.type, code: data?.code, at: Date.now(), canReadText: data?.canReadText, key: data?.documentKey, userId: data?.docsUserId,
        });
      });
      app.on("web-contents-created", (_event, contents) => contents.session.webRequest.onBeforeRequest((details, done) => {
        const url = new URL(details.url); done({ cancel: /^https?:$/u.test(url.protocol) && !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) });
      }));
      BrowserWindow.getAllWindows()[0].setBounds({ x: 0, y: 0, width: 1700, height: 1100 });
    });
    await page.waitForFunction(() => Boolean(window.piDesktop));
    const qr = await invoke("authStartQr"); await invoke("authPollQr", { ticket: qr.ticket });
    await page.waitForFunction(() => Boolean(window.__PI_DESKTOP__));
    await invoke("projectSet", workspace); sessionId = (await invoke("sessionCreate", { title: "Real Docs integration", projectPath: workspace })).session.id;
    await page.evaluate(async id => {
      window.__PI_CAPTURE__ = true; await window.__PI_DESKTOP__.selectSession(id);
      window.__PI_DESKTOP__.openNewWorkPanelTab(); await window.__PI_DESKTOP__.setWorkPanelWidth(1100);
    }, sessionId);
    await page.locator('[data-work-panel-launcher-item="team-projects"]').last().click();
    await step("Current Desktop team action joins the official Docs engine with its real native plugin", async () => {
      await openDesktop(); const first = await nativeRead(nativePage); reads.push({ actor: "A", phase: "baseline", ...first });
      assert(JSON.stringify(first).includes("CHAT_REPLACED_IN_OFFICE"));
      await expect.poll(() => app.evaluate(() => globalThis.__w13NativeOnlineEvents.some(event => event.type === "mounted" && event.canReadText === true)),
        { timeout: 35_000 }).toBe(true);
      report.nativeOnlineEvents = await app.evaluate(() => globalThis.__w13NativeOnlineEvents);
      report.nativeAttachment = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].contentView.children
        .filter(child => child.webContents?.getURL() === "deckwise-editor://host/online.html").map(child => child.getBounds()));
      assert.equal(report.nativeAttachment.length, 1); assert(report.nativeAttachment[0].width > 0 && report.nativeAttachment[0].height > 0);
      report.nativeLayout = await Promise.all(nativePage.frames().map(frame => frame.evaluate(() => ({
        url:location.origin + location.pathname, nativeDefaultConfig:window.DocsAPI?.DocEditor?.defaultConfig ? {lang:window.DocsAPI.DocEditor.defaultConfig.editorConfig?.lang,width:window.DocsAPI.DocEditor.defaultConfig.width,height:window.DocsAPI.DocEditor.defaultConfig.height} : undefined, viewport:{width:innerWidth,height:innerHeight},
        iframes:[...document.querySelectorAll("iframe")].map(element=>({id:element.id,name:element.name,
          widthAttribute:element.getAttribute("width"),heightAttribute:element.getAttribute("height"),inlineStyle:element.getAttribute("style"),
          bounds:{x:element.getBoundingClientRect().x,y:element.getBoundingClientRect().y,width:element.getBoundingClientRect().width,height:element.getBoundingClientRect().height}}))
      })).catch(()=>null)));
      const hostLayout = report.nativeLayout.find(value=>value?.url === fixture + "/docs-online-host.html");
      assert(hostLayout?.iframes.length === 1);
      assert(Math.abs(hostLayout.iframes[0].bounds.width - hostLayout.viewport.width) <= 2);
      assert(Math.abs(hostLayout.iframes[0].bounds.height - hostLayout.viewport.height) <= 2);
      await nativePage.screenshot({ path: join(output, "desktop-real-docs.png") });
    });
    await step("An independent browser actor joins the same actual Docs document key", async () => {
      browser = await chromium.launch({ headless: true, args: ["--no-sandbox"] }); peer = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
      await peer.context().route("**/*", route => {
        const url = new URL(route.request().url());
        return /^https?:$/u.test(url.protocol) && !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) ? route.abort() : route.continue();
      });
      await peer.goto(`${fixture}/peer.html`);
      await peer.evaluate(({ launch, fixture, docs }) => {
        const frame = document.getElementById("entry"), channelId = crypto.randomUUID(), requestId = crypto.randomUUID();
        window.onlineMessages = [];
        window.addEventListener("message", event => {
          if (event.source !== frame.contentWindow || event.origin !== fixture || event.data?.channelId !== channelId) return;
          const data = event.data; window.onlineMessages.push({ type: data.type, code: data.code, canReadText: data.canReadText });
          if (data.type === "entry-ready") frame.contentWindow.postMessage({ protocol: "deckwise-docs-online/1", channelId, requestId, type: "open",
            generation: 1, projectId: launch.projectId, sessionEpoch: launch.sessionEpoch, documentKey: launch.documentKey, docsUserId: launch.docsUserId,
            configJson: launch.configJson, expiresAtEpochMillis: launch.expiresAtEpochMillis }, fixture);
        });
        frame.src = `${fixture}/courseware-online.html?parentOrigin=${encodeURIComponent(fixture)}&channelId=${channelId}&apiUrl=${encodeURIComponent(docs + "/web-apps/apps/api/documents/api.js")}&communityPluginConfigUrl=${encodeURIComponent(fixture + "/modules/config.json")}`;
      }, { launch: offer(42), fixture, docs });
      await expect.poll(async () => { try { return (await nativeRead(peer)).totalSlides; } catch { return 0; } }, { timeout: 60_000 }).toBe(3);
      await expect.poll(() => peer.evaluate(() => window.onlineMessages.some(message => message.type === "mounted" && message.canReadText === true)), { timeout: 45_000 }).toBe(true);
      reads.push({ actor: "B", phase: "baseline", ...await nativeRead(peer) });
    });
    await step("Actual keyboard changes from each actor propagate through the official collaborative engine", async () => {
      await keyboardReplace(nativePage, 0, "W13_REAL_DESKTOP_ACTOR_A");
      await expect.poll(async () => { try { return JSON.stringify(await nativeRead(peer)).includes("W13_REAL_DESKTOP_ACTOR_A"); } catch { return false; } }, { timeout: 45_000 }).toBe(true);
      await keyboardReplace(peer, 1, "W13_REAL_BROWSER_ACTOR_B");
      for (const [actor, target] of [["A", nativePage], ["B", peer]]) {
        await expect.poll(async () => { try { const value = JSON.stringify(await nativeRead(target)); return value.includes("W13_REAL_DESKTOP_ACTOR_A") && value.includes("W13_REAL_BROWSER_ACTOR_B"); } catch { return false; } }, { timeout: 45_000 }).toBe(true);
        reads.push({ actor, phase: "converged", ...await nativeRead(target) });
      }
    });
    await step("Signed force-save produces a verified status-6 callback and actual downloaded PPTX containing both edits", async () => {
      const command = { c: "forcesave", key: documentKey, userdata: randomUUID() };
      const response = await fetch(`${docs}/coauthoring/CommandService.ashx`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...command, token: sign(command) }), signal: AbortSignal.timeout(15_000) });
      report.forceSave = await response.json(); assert.equal(report.forceSave.error, 0);
      await expect.poll(() => callbacks.some(item => item.key === documentKey && item.status === 6 && item.saved), { timeout: 60_000 }).toBe(true);
      report.saved = callbacks.find(item => item.key === documentKey && item.status === 6 && item.saved);
      report.packageReadback = JSON.parse(execFileSync("python3", ["-c", `import sys,json,zipfile,xml.etree.ElementTree as E,hashlib
p=sys.argv[1]
with zipfile.ZipFile(p) as z:
 assert z.testzip() is None
 slides={n:[t.text or '' for t in E.fromstring(z.read(n)).iter('{http://schemas.openxmlformats.org/drawingml/2006/main}t')] for n in z.namelist() if n.startswith('ppt/slides/slide') and n.endswith('.xml')}
 text=str(slides)
 assert 'W13_REAL_DESKTOP_ACTOR_A' in text and 'W13_REAL_BROWSER_ACTOR_B' in text
 print(json.dumps({'slides':slides,'sha256':hashlib.sha256(open(p,'rb').read()).hexdigest(),'bothKeyboardEditsPresent':True}))`, join(output, report.saved.saved)], { encoding: "utf8" }));
    });
    await step("Closing both actors and reopening the downloaded saved bytes under a new key retains both edits", async () => {
      await peer.close();
      await page.locator(".courseware-online-editor header button").last().click();
      await expect.poll(async () => (await invoke("coursewareOnlineState")).status).toBe("closed");
      report.originalKey = documentKey; documentKey = randomUUID(); epoch++; sourceFilename = report.saved.saved;
      ownedKeys.add(documentKey);
      sourceSha = report.saved.sha256; report.reopenedKey = documentKey;
      await openDesktop(); const reopened = await nativeRead(nativePage); reads.push({ actor: "A", phase: "reopened-saved-bytes", ...reopened });
      assert(JSON.stringify(reopened).includes("W13_REAL_DESKTOP_ACTOR_A") && JSON.stringify(reopened).includes("W13_REAL_BROWSER_ACTOR_B"));
      await nativePage.screenshot({ path: join(output, "desktop-reopened-saved.png") });
    });
    assert.deepEqual(errors, []); report.status = "PASS";
  } catch (error) {
    report.status = "FAIL";
    report.error = redact(error.stack); process.exitCode = 1;
    for (const [name, target] of [["desktop", nativePage], ["peer", peer], ["renderer", page]]) if (target && !target.isClosed()) {
      await target.screenshot({ path: join(output, `failure-${name}.png`) }).catch(() => {});
      await writeFile(join(output, `frames-${name}.json`), JSON.stringify(await Promise.all(target.frames().map(async frame => ({
        url: redact(frame.url()), text: redact((await frame.locator("body").innerText().catch(() => "")).slice(0, 4000)),
      }))), null, 2));
    }
    if (page && !page.isClosed()) report.finalMainState = await invoke("coursewareOnlineState").catch(() => null);
    if (app) report.nativeOnlineEvents = await app.evaluate(() => globalThis.__w13NativeOnlineEvents).catch(() => null);
  } finally {
    await browser?.close();
    if (app && app.process().exitCode === null && app.process().signalCode === null) {
      const exited = new Promise(done => app.process().once("exit", done));
      await app.evaluate(({ app }) => app.exit(0)); await exited;
    }
    await new Promise(done => server ? server.close(done) : done());
    await writeFile(join(output, "electron.log"), logs.join(""));
    await writeFile(join(output, "report.json"), JSON.stringify({ ...report, callbacks, requests, nativeDiagnostics, errors }, null, 2));
  }
}
