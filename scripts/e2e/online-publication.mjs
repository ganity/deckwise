import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const clone = value => structuredClone(value);
const readBody = async request => {
  const chunks = []; let length = 0;
  for await (const bytes of request) { length += bytes.length; assert(length <= 64 * 1024 * 1024); chunks.push(bytes); }
  return Buffer.concat(chunks);
};

/** External HTTP/Docs protocol fixture only; local renderer/Main/Host/parser/build run unchanged. */
export async function onlinePublicationPlatform({ projectId, source, inputPath, workerPath, output, documentKey }) {
  const sourceBytes = await readFile(inputPath), parsed = join(output, "fixture-parser");
  await promisify(execFile)(process.execPath, [resolve(workerPath), resolve(inputPath), parsed], { timeout: 90_000 });
  const identity = JSON.parse(await readFile(join(parsed, "identity.json"), "utf8"));
  source.sha256 = hash(sourceBytes); assert.equal(identity.sourceSha256, source.sha256);
  const mapping = { revision: randomUUID(), sourceSha256: source.sha256, pages: identity.pages.map(page => ({
    pageId: randomUUID(), importPageId: page.importPageId,
    objects: page.objects.map(object => ({ objectId: randomUUID(), importElementId: object.importElementId })),
  })) };
  const project = { schemaVersion: "deckwise-courseware/1", projectId, taskType: "plain", title: "Online publication fixture",
    source: clone(source), teachingRevision: randomUUID(), pages: mapping.pages.map(page => ({
      pageId: page.pageId, locked: false, reviewState: "ready", actions: [],
    })) };
  const prefix = `/courseware/team/projects/${projectId}`, editing = `${prefix}/editing-session/5`;
  const version = () => ({ project: clone(project), mappingRevision: mapping.revision });
  const sourceVersion = { projectId, source: clone(source), byteLength: sourceBytes.length, requestId: randomUUID(), sessionEpoch: null, callbackId: null };
  const clients = new Map(), saves = new Map(), reviews = new Map(), events = [];
  const callbackId = hash(Buffer.from(`isolated callback:${source.sha256}`));
  let pause = null, barrier = null, stored = null;
  const pointers = { shared: { projectId, channel: "shared", buildId: null, snapshotId: null, packageSha256: null, version: 0 },
    formal: { projectId, channel: "formal", buildId: null, snapshotId: null, packageSha256: null, version: 0 } };
  const currentBarrier = () => {
    if (!barrier) return null;
    const list = [...clients.values()].map(clone), held = list.length > 0 && list.every(client => client.state === "held" && client.nativeReady);
    return { projectId, sessionEpoch: 5, barrierId: barrier.barrierId, pauseId: barrier.pauseId,
      state: barrier.state === "released" ? "released" : held ? "held" : "draining", coverage: "managed",
      allRegisteredClientsHeld: held, authoritativeCoverage: false, consistentPublicationReady: false, proof: "client-reported", clients: list, reasons: [] };
  };
  const fixture = {
    project, mapping, events, sourceBytes,
    get review() { return [...reviews.values()].at(-1); },
    get stored() { return stored; },
    get pointers() { return clone(pointers); },
    register(clientId, docsUserId) {
      assert.match(clientId, /^[a-f0-9-]{36}$/u); assert.equal(clients.has(clientId), false);
      clients.set(clientId, { clientId, docsUserId, state: "awaiting", nativeReady: false, lastSeenEpochMillis: Date.now() });
    },
    async storage({ path, request, response }) {
      if (path === "/fixture-publication-source.pptx") {
        assert(!request.headers.authorization, "Object storage must receive no Platform token");
        response.writeHead(200, { "content-type": "application/vnd.openxmlformats-officedocument.presentationml.presentation", "content-length": sourceBytes.length });
        response.end(sourceBytes); return true;
      }
      if (path !== "/__publication-native") return false;
      const body = JSON.parse(await readBody(request)); events.push({ type: "native-protocol", ...body });
      response.writeHead(200, { "content-type": "application/json" }); response.end('{"ok":true}'); return true;
    },
    async handle({ request, response, route, actor, send, origin, url }) {
      if (!route.startsWith(prefix)) return false;
      const method = request.method;
      if (route === `${prefix}/teaching` && method === "GET") { send(version()); return true; }
      if (route === `${prefix}/sources/current`) { send(sourceVersion); return true; }
      if (route === `${prefix}/sources/${source.revision}/download`) {
        send({ version: sourceVersion, downloadUrl: `${origin}/fixture-publication-source.pptx` }); return true;
      }
      if (route === `${prefix}/teaching/mappings/${mapping.revision}`) {
        assert.equal(url.searchParams.get("sourceRevision"), source.revision);
        send({ projectId, source: clone(source), mapping: clone(mapping) }); return true;
      }
      if (route === `${editing}/write-pauses/current` && method === "GET") { send(pause?.state === "held" ? pause : null); return true; }
      if (route === `${editing}/write-pauses` && method === "POST") {
        assert.equal(actor.role, "OWNER"); const body = JSON.parse(await readBody(request));
        assert(!pause); pause = { projectId, sessionEpoch: 5, pauseId: body.pauseId, state: "held", teaching: version() };
        events.push({ type: "teaching-pause", pauseId: pause.pauseId }); send(pause); return true;
      }
      if (pause && route === `${editing}/write-pauses/${pause.pauseId}`) {
        if (method === "DELETE") { pause.state = "released"; events.push({ type: "teaching-resume" }); }
        send(pause); return true;
      }
      if (route === `${editing}/native-barriers/current` && method === "GET") { send(currentBarrier()); return true; }
      if (route === `${editing}/native-barriers` && method === "POST") {
        assert.equal(actor.role, "OWNER"); assert.equal(pause?.state, "held");
        const body = JSON.parse(await readBody(request)); assert.equal(body.pauseId, pause.pauseId);
        barrier = { ...body, state: "draining" }; for (const client of clients.values()) client.state = "awaiting";
        events.push({ type: "barrier-start", ...body }); send(currentBarrier()); return true;
      }
      const mount = route.match(/\/native-clients\/([a-f0-9-]{36})$/u);
      if (mount) {
        const client = clients.get(mount[1]); assert(client);
        if (method === "DELETE") { client.state = "disconnected"; client.nativeReady = false; }
        else { assert.equal(method, "PUT"); client.nativeReady = JSON.parse(await readBody(request)).nativeReady; }
        client.lastSeenEpochMillis = Date.now(); send(currentBarrier()); return true;
      }
      if (barrier && route === `${editing}/native-barriers/${barrier.barrierId}`) {
        if (method === "DELETE") { barrier.state = "released"; events.push({ type: "barrier-release" }); }
        send(currentBarrier()); return true;
      }
      const report = route.match(/\/native-barriers\/([a-f0-9-]{36})\/clients\/([a-f0-9-]{36})$/u);
      if (report) {
        assert.equal(method, "PUT"); assert.equal(report[1], barrier?.barrierId);
        const client = clients.get(report[2]), body = JSON.parse(await readBody(request)); assert(client);
        if (body.state === "held") {
          assert(["draining", "held"].includes(client.state));
          assert(events.some(event => event.type === "native-protocol" && event.tool === "native_barrier_quiesce" && event.barrierId === barrier.barrierId));
        }
        if (body.state === "resumed") assert.equal(barrier.state, "released");
        client.state = body.state; client.lastSeenEpochMillis = Date.now();
        events.push({ type: "client-report", state: body.state }); send(currentBarrier()); return true;
      }
      if (barrier && route === `${editing}/native-barriers/${barrier.barrierId}/force-saves` && method === "POST") {
        assert.equal(currentBarrier().state, "held"); const body = JSON.parse(await readBody(request));
        const save = { requestId: body.requestId, key: documentKey, sessionEpoch: 5, state: "archived", commandError: null, callbackId };
        saves.set(save.requestId, save); events.push({ type: "verified-save", requestId: save.requestId }); send(save); return true;
      }
      if (route === `${editing}/callbacks/${callbackId}/archive`) {
        send({ receipt: { callbackId, key: documentKey, sessionEpoch: 5, documentStatus: 6, state: "archived",
          sha256: source.sha256, byteLength: sourceBytes.length }, downloadUrl: `${origin}/fixture-publication-source.pptx` }); return true;
      }
      if (route === `${prefix}/teaching/verified-source-reviews` && method === "POST") {
        const body = JSON.parse(await readBody(request)); assert.equal(currentBarrier().state, "held");
        assert.equal(body.sessionEpoch, 5); assert.equal(body.pauseId, pause.pauseId); assert.equal(body.barrierId, barrier.barrierId);
        assert(saves.has(body.forceSaveRequestId)); assert.equal(body.expectedSourceRevision, source.revision);
        assert.equal(body.expectedTeachingRevision, project.teachingRevision); assert.equal(body.project.source.sha256, source.sha256);
        assert.equal(body.project.source.revision, body.requestId); assert(body.project.pages.every(page => page.reviewState === "ready"));
        const review = { snapshotId: body.requestId, sessionEpoch: 5, forceSaveRequestId: body.forceSaveRequestId, callbackId,
          sourceByteLength: sourceBytes.length, baselineSourceRevision: source.revision, baselineTeachingRevision: project.teachingRevision,
          teaching: { project: { ...clone(body.project), teachingRevision: randomUUID() }, mappingRevision: body.mapping.revision }, mapping: clone(body.mapping) };
        assert(!reviews.has(body.requestId)); reviews.set(body.requestId, review); events.push({ type: "verified-capture", snapshotId: review.snapshotId });
        send(review); return true;
      }
      if (route === `${prefix}/fixed-builds` && method === "POST") {
        const raw = await readBody(request), form = await new Request("http://127.0.0.1/upload", { method, headers: request.headers, body: raw }).formData();
        const manifestBytes = Buffer.from(await form.get("manifest").arrayBuffer()), manifest = JSON.parse(manifestBytes);
        assert.equal(hash(manifestBytes), url.searchParams.get("manifestSha256")); assert.equal(manifest.buildId, url.searchParams.get("buildId"));
        const files = new Map(await Promise.all(form.getAll("files").map(async file => [file.name, Buffer.from(await file.arrayBuffer())])));
        assert.equal(files.size, manifest.files.length);
        for (const file of manifest.files) assert.equal(hash(files.get(file.path)), file.sha256);
        assert.deepEqual(files.get("source.pptx"), sourceBytes); assert.equal(hash(files.get("package.json")), manifest.buildId);
        assert(reviews.has(url.searchParams.get("snapshotId")));
        stored = { buildId: manifest.buildId, snapshotId: url.searchParams.get("snapshotId"), packageSha256: manifest.buildId };
        await writeFile(join(output, "uploaded-package.json"), files.get("package.json"));
        await writeFile(join(output, "uploaded-manifest.json"), manifestBytes);
        events.push({ type: "fixed-upload", ...stored, files: files.size }); send(stored); return true;
      }
      const pointer = route.match(/\/publish\/(shared|formal)$/u);
      if (pointer && method === "GET") { send(pointers[pointer[1]]); return true; }
      if (route === `${prefix}/publish` && method === "POST") {
        const body = JSON.parse(await readBody(request)); assert(stored); assert.equal(body.buildId, stored.buildId);
        const current = pointers[body.channel]; assert.equal(body.expectedVersion, current.version); assert.match(body.intentId, /^[a-f0-9-]{36}$/u);
        Object.assign(current, stored, { version: current.version + 1 }); events.push({ type: "publish", channel: body.channel, intentId: body.intentId });
        send(current); return true;
      }
      return false;
    },
  };
  return fixture;
}

/** The fixed native acknowledgement is a Docs protocol fixture, never Main state injection. */
export const onlinePublicationDocsScript = `
window.addEventListener('message', event => {
  if (event.origin !== location.origin || event.source !== window.parent || event.data?.protocol !== 'deckwise-docs-read/1' || event.data.type !== 'connect') return;
  const port = event.ports[0], sessionId = event.data.sessionId; let barrier;
  port.onmessage = async ({data}) => {
    if (data.protocol !== 'deckwise-docs-read/1' || data.sessionId !== sessionId) return;
    let result;
    if (data.tool === 'native_barrier_capability') result = {available:true};
    else if (data.tool === 'native_barrier_quiesce') { barrier = data.barrierId; result = {barrierId:barrier,state:'held',serverIndex:7}; }
    else if (data.tool === 'native_barrier_status') result = {barrierId:data.barrierId,state:'held',serverIndex:7};
    else if (data.tool === 'native_barrier_resume') result = {barrierId:data.barrierId,state:'resumed',serverIndex:7};
    else result = {page:1,totalSlides:1,text:'Isolated publication fixture',truncated:false,slidesRead:1};
    await fetch('/__publication-native',{method:'POST',body:JSON.stringify({tool:data.tool,barrierId:data.barrierId,result})});
    port.postMessage({protocol:data.protocol,sessionId,requestId:data.requestId,result});
  };
  port.start();
});
setTimeout(() => window.parent.postMessage({protocol:'deckwise-docs-read/1',type:'ready'},location.origin),0);
`;

export async function verifyOnlinePublication({ page, expect, invoke, step, teamPanel, opened, publication, projectId, sessionId, output }) {
  const evidence = { realElectron: true, realMainIpcHostParserBuildRenderer: true, platformHttpFixture: true,
    docsProtocolFixture: true, realDocsSynchronization: false, paidCalls: false, pages: publication.project.pages.length };
  await step("Visible team Join opens the real online editor without a local task", async () => {
    assert.equal((await invoke("coursewareTaskGet", { sessionId })).task, null);
    await teamPanel(); await opened();
    await expect(page.getByRole("button", { name: "暂停编辑并核对", exact: true })).toBeEnabled({ timeout: 20_000 });
    await page.screenshot({ path: join(output, "01-online-ready.png") });
  });
  await step("Owner pauses through the visible controls and Main waits for the fixed native protocol acknowledgement", async () => {
    await page.getByRole("button", { name: "暂停编辑并核对", exact: true }).click();
    await expect.poll(() => publication.events.some(event => event.type === "client-report" && event.state === "held"), { timeout: 25_000 }).toBe(true);
    await page.getByRole("button", { name: "刷新状态", exact: true }).click();
    await expect(page.getByText("已登记编辑窗口已暂停，但不代表全部更改已保存。", { exact: false })).toBeVisible();
    assert.equal(publication.events.filter(event => event.type === "teaching-resume").length, 0);
    await page.screenshot({ path: join(output, "02-held-native-window.png") });
  });
  await step("Real Main/Host parses the archived save and visible page choices explicitly confirm the publication input", async () => {
    await page.getByRole("button", { name: "审查服务器保存稿", exact: true }).click();
    const review = page.locator(".courseware-online-source-review"); await expect(review).toBeVisible({ timeout: 90_000 });
    for (const [index, original] of publication.project.pages.entries())
      await review.getByRole("combobox", { name: `保存后的第 ${index + 1} 页使用的讲解`, exact: true }).selectOption(original.pageId);
    for (const index of publication.project.pages.keys())
      await review.getByRole("checkbox", { name: `已核对保存后的第 ${index + 1} 页、讲解及效果关联，标记为可发布。`, exact: true }).check();
    await page.screenshot({ path: join(output, "03-explicit-page-associations.png") });
    await review.getByRole("button", { name: "确认关联", exact: true }).click();
    await expect(page.getByText(/关联审查完成.*尚未发布/u)).toBeVisible({ timeout: 90_000 });
    assert.equal(publication.events.filter(event => event.type === "verified-save").length, 1);
    assert.equal(publication.events.filter(event => event.type === "publish").length, 0);
  });
  await step("Visible Create Fixed Version imports a verified immutable snapshot and uses the actual fixed builder", async () => {
    await page.getByRole("button", { name: "创建固定版本", exact: true }).click();
    const panel = page.locator(".courseware-playback");
    await expect.poll(async () => await panel.getByText("预览已构建。", { exact: true }).count() || await panel.getByRole("button", { name: "确认并继续构建", exact: true }).count(), { timeout: 120_000 }).toBeGreaterThan(0);
    const approve = panel.getByRole("button", { name: "确认并继续构建", exact: true });
    if (await approve.count()) {
      const boxes = panel.getByRole("checkbox"); for (let index = 0; index < await boxes.count(); index++) await boxes.nth(index).check();
      await page.screenshot({ path: join(output, "04-conversion-warning-review.png") }); await approve.click();
    }
    await expect(panel.getByText("预览已构建。", { exact: true })).toBeVisible({ timeout: 120_000 });
    assert.equal(publication.events.filter(event => event.type === "verified-capture").length, 1);
    assert.equal(publication.events.filter(event => event.type === "publish").length, 0);
    await expect(panel.getByRole("button", { name: "共享固定版本", exact: true })).toBeDisabled();
    await page.screenshot({ path: join(output, "05-fixed-preview-ready.png") });
  });
  await step("An explicit visible consent shares the exact real build through Main and records one publication", async () => {
    const panel = page.locator(".courseware-playback");
    await panel.getByRole("checkbox", { name: "我确认将此固定版本发布到当前团队的共享频道。", exact: true }).check();
    await panel.getByRole("button", { name: "共享固定版本", exact: true }).click();
    await expect(panel.getByText("已发布到团队共享频道。", { exact: true })).toBeVisible({ timeout: 60_000 });
    assert.equal(publication.events.filter(event => event.type === "fixed-upload").length, 1);
    assert.equal(publication.events.filter(event => event.type === "publish").length, 1);
    assert.equal(publication.pointers.shared.snapshotId, publication.review.snapshotId);
    assert.equal(publication.pointers.shared.buildId, publication.stored.buildId);
    assert.equal((await invoke("coursewareTaskGet", { sessionId })).task, null);
    evidence.snapshotId = publication.review.snapshotId; evidence.buildId = publication.stored.buildId;
    evidence.teamProjectId = projectId; evidence.pointer = publication.pointers.shared;
    await page.screenshot({ path: join(output, "06-shared-fixed-version.png") });
  });
  evidence.events = publication.events;
  return evidence;
}
