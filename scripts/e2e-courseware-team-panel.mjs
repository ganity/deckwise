/** Real React team controls with deliberately reordered preload replies; no remote writes. */
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { IPC } from "../packages/shared/dist/index.js";

assert(process.env.DECKWISE_E2E_OUTPUT, "Missing DECKWISE_E2E_OUTPUT");
const output = resolve(process.env.DECKWISE_E2E_OUTPUT);
await mkdir(output);
const desktop = createRequire(new URL("../apps/desktop/package.json", import.meta.url));
const { createServer } = desktop("vite");
const { chromium, expect } = createRequire(new URL("../packages/courseware-runtime/package.json", import.meta.url))("@playwright/test");
const projects = ["a", "b"].map((letter) => ({ projectId: letter.repeat(8) + "-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  ownerUserId: 1, role: "OWNER", createdAt: "2026-10-23T00:00:00Z" }));
const report = { status: "RUNNING", checks: [], realReact: true, preloadStandIn: true, realPlatform: false, paidCalls: false };
const errors = [];
let browser, server;
try {
  server = await createServer({ root: new URL("../apps/desktop", import.meta.url).pathname, configFile: false,
    server: { host: "127.0.0.1", port: 0, watch: null }, esbuild: { jsx: "automatic" },
    plugins: [{ name: "team-panel-fixture", resolveId(id) { if (id === "/__team-panel.jsx") return id; },
      load(id) { if (id === "/__team-panel.jsx") return `
        import { createElement } from 'react';
        import { createRoot } from 'react-dom/client';
        import i18n from 'i18next';
        import { I18nextProvider } from 'react-i18next';
        import { catalogs } from '@pi-desktop/i18n';
        import { TeamProjectsTab } from '/src/components/workpanel/TeamProjectsTab.tsx';
        import { CoursewareTeamAssignment } from '/src/components/workpanel/CoursewareTeamAssignment.tsx';
        import { useAppStore } from '/src/stores/app-store.ts';
        await i18n.init({lng:'zh-CN',resources:{'zh-CN':{translation:catalogs['zh-CN']}}});
        const root = createRoot(document.getElementById('root'));
        let generation = 0;
        window.renderTeam = (visible = true) => root.render(createElement(I18nextProvider, {i18n},
          visible ? createElement(TeamProjectsTab, {key:++generation}) : null));
        window.renderLocalAssignment = () => {
          useAppStore.setState({activeSessionId:'local-lesson',coursewareTeamAssignmentSessionId:'local-lesson'});
          root.render(createElement(CoursewareTeamAssignment, {sessionId:'local-lesson',title:'认识分数'}));
        };
        window.renderTeam();
      `; }, configureServer(instance) { instance.middlewares.use((req, res, next) => {
        if (req.url !== "/__team-panel") return next();
        res.setHeader("content-type", "text/html");
        res.end('<div id="root"></div><script type="module" src="/__team-panel.jsx"></script>');
      }); } }] });
  await server.listen();
  browser = await chromium.launch({ headless: true, args: ["--no-sandbox"] });
  const page = await browser.newPage();
  page.on("pageerror", (error) => errors.push(error.stack));
  await page.addInitScript(({ channels, projects }) => {
    window.calls = []; window.pending = []; window.deferred = []; window.listeners = {};
    window.piDesktop = { on(channel, listener) {
      const listeners = window.listeners[channel] ??= new Set();
      listeners.add(listener); return () => listeners.delete(listener);
    }, async invoke(channel, payload) {
      window.calls.push({ channel, payload });
      if (window.deferred.includes(channel)) return new Promise((resolve) => window.pending.push({ channel, payload, resolve }));
      if (channel === channels.coursewareTeamProjects) return { ok: true, data: window.projectReply ?? projects };
      if (channel === channels.coursewareTaskGet) return {ok:true,data:{task:{taskType:"plain", ...(window.synced ? {teamProjectId:projects[0].projectId} : {})}}};
      if (channel === channels.coursewareTeamProjectCreate) return {ok:true,data:projects[0].projectId};
      if (channel === channels.coursewareOnlinePrepareReview) return {ok:true,data:{reviewId:"00000000-aaaa-4aaa-8aaa-aaaaaaaaaaaa"}};
      if (channel === channels.coursewareOnlinePrepareConfirm) {
        if (!window.syncRetried) {
          window.syncRetried = true;
          return {ok:false,error:{code:"UPLOAD_INTERRUPTED",message:"同步失败，连接中断"}};
        }
        window.synced = true;
        return {ok:true,data:{projectId:projects[0].projectId}};
      }
      if (channel === channels.coursewareOnlinePrepareCancel) return {ok:true,data:null};
      if (channel === channels.coursewareGroups) {
        const groupId = "cccccccc-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
        const recipients = [{ userId: 1, name: "陈老师", role: "OWNER" }, { userId: 33, name: "王老师", role: "VIEWER" }];
        const outsideCollaborators = [{ userId: 44, name: "李老师", role: "EDITOR" }];
        switch (payload.action) {
          case "list": return { ok: true, data: window.groupCreated ? [
            { groupId, name: "数学备课组", role: "OWNER", memberCount: window.groupMemberAdded ? 2 : 1, archived: false },
          ] : [] };
          case "create":
            window.groupCreated = true;
            return { ok: true, data: { groupId } };
          case "members": return { ok: true, data: [
            { userId: 1, name: "陈老师", role: "OWNER" },
            ...(window.groupMemberAdded ? [{ userId: 33, name: "王老师", role: "MEMBER" }] : []),
          ] };
          case "search": return { ok: true, data: [{ userId: 33, name: "王老师", departmentName: "数学组" }] };
          case "setMember":
            window.groupMemberAdded = true;
            return { ok: true, data: null };
          case "review": return { ok: true, data: { version: 3, recipients, outsideCollaborators: window.localAssignment ? [] : outsideCollaborators } };
          case "share":
            window.projectReply = (window.projectReply ?? projects).map((item) =>
              item.projectId === payload.projectId ? { ...item, groupId } : item);
            return { ok: true, data: null };
        }
      }
      if (channel === channels.coursewareTeamMembers) return { ok: true, data: [{ userId: payload.projectId === projects[0].projectId ? 11 : 22, role: "EDITOR" }] };
      if ([channels.coursewareTeamMemberGrant, channels.coursewareTeamMemberRevoke].includes(channel)) return { ok: true, data: { ok: true } };
      throw new Error(`Unexpected IPC: ${channel}`);
    } };
  }, { channels: IPC.invoke, projects });
  await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/__team-panel`);
  const row = (index) => page.locator(".team-project-row").nth(index);
  const open = async (index) => { await row(index).getByRole("button", { name: "成员管理", exact: true }).click(); };
  const form = () => page.locator(".team-project-member-form");
  const reset = async () => {
    await page.evaluate(() => { window.calls = []; window.pending = []; window.deferred = []; window.renderTeam(); });
    await page.waitForFunction((channel) => window.calls.some((entry) => entry.channel === channel), IPC.invoke.coursewareTeamProjects);
    await expect(page.locator(".team-project-row")).toHaveCount(2);
  };
  const settle = async (index, result) => {
    await page.evaluate(({ index, result }) => window.pending[index].resolve(result), { index, result });
    await page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));
  };
  const step = async (name, run) => { await run(); report.checks.push(name); console.log("PASS", name); };

  await step("An empty team list can refresh to discover a newly shared project", async () => {
    await page.evaluate(() => { window.projectReply = []; window.renderTeam(); });
    await expect(page.getByText("暂无共享课件", { exact: true })).toBeVisible();
    await page.evaluate((projects) => { window.projectReply = projects; }, projects);
    await page.getByRole("button", { name: "刷新", exact: true }).click({ timeout: 2000 });
    await expect(page.locator(".team-project-row")).toHaveCount(2);
    await page.evaluate(() => { delete window.projectReply; });
  });

  await step("Switching team clears the previous member selection before another write", async () => {
    await reset(); await open(0);
    await form().getByRole("button", { name: "#11 · 可编辑" }).click();
    await expect(form().getByText("已选择成员：#11")).toBeVisible();
    await open(1);
    await expect(form().getByRole("button", { name: "#22 · 可编辑" })).toBeVisible();
    await expect(form().getByRole("button", { name: "保存权限" })).toHaveCount(0);
    assert(!(await page.evaluate(() => window.calls)).some(({ channel }) => [IPC.invoke.coursewareTeamMemberGrant, IPC.invoke.coursewareTeamMemberRevoke].includes(channel)));
  });
  await step("A late member list cannot replace the currently open team's list", async () => {
    await reset(); await page.evaluate((channel) => window.deferred.push(channel), IPC.invoke.coursewareTeamMembers);
    await open(0); await open(1);
    await page.waitForFunction(() => window.pending.length === 2);
    await settle(1, { ok: true, data: [{ userId: 22, role: "VIEWER" }] });
    await settle(0, { ok: true, data: [{ userId: 11, role: "EDITOR" }] });
    await expect(form().getByRole("button", { name: "#22 · 只读" })).toBeVisible();
    await expect(form().getByRole("button", { name: "#11 · 可编辑" })).toHaveCount(0);
  });
  await step("A late denial for a previous team cannot replace the current team's success", async () => {
    await reset(); await page.evaluate((channel) => window.deferred.push(channel), IPC.invoke.coursewareTeamMembers);
    await open(0); await open(1); await page.waitForFunction(() => window.pending.length === 2);
    await settle(1, { ok: true, data: [{ userId: 22, role: "VIEWER" }] });
    await settle(0, { ok: false, error: { code: "FORBIDDEN", message: "Old team access revoked" } });
    await expect(form().getByRole("alert")).toHaveCount(0);
    await expect(form().getByRole("button", { name: "#22 · 只读" })).toBeVisible();
  });
  await step("A stale search cannot replace a newer result or grant access to the wrong person", async () => {
    await reset(); await open(0);
    await page.evaluate((channel) => window.deferred.push(channel), IPC.invoke.coursewareTeamMemberSearch);
    const search = form().getByRole("searchbox");
    await search.fill("李"); await search.press("Enter");
    await page.waitForFunction(() => window.pending.length === 1);
    await search.fill("王"); await search.press("Enter");
    await page.waitForFunction(() => window.pending.length === 2);
    await settle(1, { ok: true, data: [{ userId: 33, name: "王老师", departmentName: "教研组" }] });
    await settle(0, { ok: true, data: [{ userId: 44, name: "李老师", departmentName: null }] });
    await expect(form().getByRole("button", { name: "李老师 · #44" })).toHaveCount(0);
    await form().getByRole("button", { name: "王老师 · 教研组 · #33" }).click();
    await form().getByRole("button", { name: "保存权限", exact: true }).click();
    await expect.poll(async () => (await page.evaluate(() => window.calls)).filter(({ channel }) => channel === IPC.invoke.coursewareTeamMemberGrant)).toEqual([
      { channel: IPC.invoke.coursewareTeamMemberGrant, payload: { projectId: projects[0].projectId, userId: 33, role: "VIEWER" } },
    ]);
  });
  await step("Selecting an editor retains their role and a grant sends the exact project/user/role", async () => {
    await reset(); await open(0);
    await form().getByRole("button", { name: "#11 · 可编辑" }).click();
    await expect(form().getByLabel("权限")).toHaveValue("EDITOR");
    await form().getByRole("button", { name: "保存权限", exact: true }).click();
    await expect.poll(async () => (await page.evaluate(() => window.calls)).filter(({ channel }) => channel === IPC.invoke.coursewareTeamMemberGrant)).toEqual([
      { channel: IPC.invoke.coursewareTeamMemberGrant, payload: { projectId: projects[0].projectId, userId: 11, role: "EDITOR" } },
    ]);
  });
  await step("Leaving during a grant prevents late member reads or project refreshes", async () => {
    await reset(); await open(0);
    await page.evaluate((channel) => window.deferred.push(channel), IPC.invoke.coursewareTeamMemberGrant);
    await form().getByRole("button", { name: "#11 · 可编辑" }).click();
    await form().getByRole("button", { name: "保存权限", exact: true }).click();
    await page.waitForFunction(() => window.pending.length === 1);
    await open(1); await expect(form().getByRole("button", { name: "#22 · 可编辑" })).toBeVisible();
    const count = await page.evaluate(() => window.calls.length);
    await settle(0, { ok: true, data: { ok: true } });
    assert.equal(await page.evaluate(() => window.calls.length), count);
    await expect(form().getByRole("button", { name: "#22 · 可编辑" })).toBeVisible();
  });
  await step("A failed revoke stays visible and does not retry the mutation", async () => {
    await reset(); await open(0);
    await page.evaluate((channel) => window.deferred.push(channel), IPC.invoke.coursewareTeamMemberRevoke);
    await form().getByRole("button", { name: "#11 · 可编辑" }).click();
    await form().getByRole("button", { name: "撤销权限", exact: true }).click();
    await page.waitForFunction(() => window.pending.length === 1);
    await settle(0, { ok: false, error: { code: "FORBIDDEN", message: "Membership change refused" } });
    await expect(form().getByRole("alert")).toContainText("Membership change refused");
    assert.equal((await page.evaluate(() => window.calls)).filter(({ channel }) => channel === IPC.invoke.coursewareTeamMemberRevoke).length, 1);
  });
  await step("An older project refresh cannot overwrite the newest response", async () => {
    await reset(); await page.evaluate((channel) => window.deferred.push(channel), IPC.invoke.coursewareTeamProjects);
    await page.getByRole("button", { name: "刷新", exact: true }).evaluate((button) => { button.click(); button.click(); });
    await page.waitForFunction(() => window.pending.length === 2);
    await settle(1, { ok: true, data: [projects[1]] });
    await settle(0, { ok: true, data: [projects[0]] });
    await expect(page.locator(".team-project-main strong")).toHaveText([projects[1].projectId]);
  });
  await step("Create failure remains visible when the account already has projects", async () => {
    await reset(); await page.evaluate((channel) => window.deferred.push(channel), IPC.invoke.coursewareTeamProjectCreate);
    await page.getByRole("button", { name: "新建团队项目", exact: true }).click();
    await page.getByLabel("项目名称").fill("教研课件");
    await page.getByRole("button", { name: "新建团队项目", exact: true }).click();
    await page.waitForFunction(() => window.pending.length === 1);
    await settle(0, { ok: false, error: { code: "FORBIDDEN", message: "Project creation refused" } });
    await expect(page.getByRole("alert")).toContainText("Project creation refused");
    await expect(page.locator(".team-project-row")).toHaveCount(2);
    assert.equal((await page.evaluate(() => window.calls)).filter(({ channel }) => channel === IPC.invoke.coursewareTeamProjectCreate).length, 1);
  });
  await step("An auth change clears member selection and ignores the previous account's replies", async () => {
    await reset(); await page.evaluate((channel) => window.deferred.push(channel), IPC.invoke.coursewareTeamMembers);
    await open(0); await page.waitForFunction(() => window.pending.length === 1);
    await page.evaluate((channel) => {
      for (const listener of window.listeners[channel] ?? []) listener({ status: "authenticated" });
    }, IPC.event.authChanged);
    await expect(form()).toHaveCount(0);
    await settle(0, { ok: true, data: [{ userId: 99, role: "EDITOR" }] });
    await page.evaluate(() => { window.deferred = []; }); await open(1);
    await expect(form().getByRole("button", { name: "#22 · 可编辑" })).toBeVisible();
    await expect(form().getByRole("button", { name: "保存权限" })).toHaveCount(0);
    await expect(form().getByRole("button", { name: "#99 · 可编辑" })).toHaveCount(0);
  });
  await step("Unmounted member changes cannot trigger follow-up reads and release the auth listener", async () => {
    await reset(); await open(0);
    await page.evaluate((channel) => window.deferred.push(channel), IPC.invoke.coursewareTeamMemberGrant);
    await form().getByRole("button", { name: "#11 · 可编辑" }).click();
    await form().getByRole("button", { name: "保存权限", exact: true }).evaluate((button) => { button.click(); button.click(); });
    await page.waitForFunction(() => window.pending.length === 1);
    assert.equal((await page.evaluate(() => window.calls)).filter(({ channel }) => channel === IPC.invoke.coursewareTeamMemberGrant).length, 1);
    await page.evaluate(() => window.renderTeam(false)); await expect(page.locator(".team-projects-tab")).toHaveCount(0);
    const count = await page.evaluate(() => window.calls.length);
    await settle(0, { ok: true, data: { ok: true } });
    assert.equal(await page.evaluate(() => window.calls.length), count);
    assert.equal(await page.evaluate((channel) => window.listeners[channel]?.size ?? 0, IPC.event.authChanged), 0);
  });
  await step("A named teaching group adds a teacher and shares two courseware projects after reviewing access", async () => {
    await reset();
    await page.getByRole("button", { name: "备课组", exact: true }).click();
    const group = page.getByRole("region", { name: "备课组", exact: true });
    await group.getByRole("button", { name: "新建备课组" }).click();
    await group.getByLabel("备课组名称").fill("数学备课组");
    await group.getByRole("button", { name: "保存", exact: true }).click();
    await group.getByText("成员与角色", { exact: true }).click();
    await group.getByRole("searchbox").fill("王");
    await group.getByRole("button", { name: "搜索", exact: true }).click();
    await group.getByRole("button", { name: "加入备课组", exact: true }).click();
    await expect(group.getByText("2 位有效成员", { exact: false })).toBeVisible();
    for (const [index, project] of projects.entries()) {
      await group.getByLabel("共享课件到备课组").selectOption(project.projectId);
      await group.getByRole("button", { name: "归属团队", exact: true }).click();
      await group.getByRole("button", { name: "核对访问范围" }).click();
      await expect(group.getByText("王老师 · 只读", {exact:true})).toBeVisible();
      await expect(group.getByText(/组外协作者将失去访问权限.*李老师/)).toBeVisible();
      await group.getByRole("button", {name:"确认归属",exact:true}).click();
      await expect(page.locator(".team-project-row")).toHaveCount(index + 1);
    }
    const shares = (await page.evaluate(() => window.calls)).filter(({ payload }) => payload?.action === "share");
    assert.equal(shares.length, 2);
    assert.equal(shares[0].payload.keepOutsideAccess, false);
    assert.equal(shares[0].payload.outsideCollaborators[0].role, "EDITOR");
  });
  await step("Existing local lesson stays private on upload failure and can resume its first sync", async () => {
    await page.evaluate(() => {
      window.calls = []; window.localAssignment = true; delete window.projectReply;
      window.renderLocalAssignment();
    });
    const picker = page.getByLabel("选择团队");
    await picker.selectOption("cccccccc-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
    await page.getByRole("button",{name:"核对访问范围"}).click();
    await expect(page.getByRole("button",{name:"确认归属"})).toBeVisible();
    assert.equal(await page.evaluate(channel => window.calls.filter(call => call.channel === channel).length,
      IPC.invoke.coursewareTeamProjectCreate), 0);
    await page.getByRole("button",{name:"确认归属"}).click();
    await expect(page.getByRole("alert")).toContainText("同步失败");
    assert.equal(await page.evaluate(() => window.calls.filter(({payload}) => payload?.action === "share").length),0);
    await page.getByRole("button",{name:"核对访问范围"}).click();
    await page.getByRole("button",{name:"确认归属"}).click();
    await expect(page.getByText("所属团队 · 数学备课组")).toBeVisible();
    const calls = await page.evaluate(() => window.calls);
    assert(calls.some(call => call.channel === IPC.invoke.coursewareOnlinePrepareReview && call.payload.requireTaskSource === true));
    assert.equal(calls.filter(call => call.channel === IPC.invoke.coursewareTeamProjectCreate).length,1);
    assert.equal(calls.filter(call => call.channel === IPC.invoke.coursewareOnlinePrepareConfirm).length,2);
    assert.equal(calls.filter(call => call.payload?.action === "share").length,1);
    assert(calls.findIndex(call => call.payload?.action === "share") > calls.findLastIndex(call => call.channel === IPC.invoke.coursewareOnlinePrepareConfirm));
  });
  assert.deepEqual(errors, []);
  report.status = "PASS";
  await page.screenshot({ path: `${output}/team-panel.png` });
} catch (error) { report.status = "FAIL"; report.error = error.stack; process.exitCode = 1;
} finally {
  await browser?.close(); await server?.close();
  await writeFile(`${output}/report.json`, JSON.stringify({ ...report, errors }, null, 2));
}
