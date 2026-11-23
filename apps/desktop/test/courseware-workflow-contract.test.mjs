/** Real compiler, Main narration, parser and Host persistence; only model/supplier output is synthetic. */
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire, register } from "node:module";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import ts from "typescript";
import * as shared from "../../../packages/shared/dist/index.js";
import * as runtime from "../../../packages/agent-runtime/dist/index.js";
import * as authoring from "../../../packages/courseware-runtime/dist/authoring.mjs";
import { Host } from "../../../scripts/e2e/host.mjs";

register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const { AgentSidecar } = await import("../electron/main/agent-sidecar.ts");

async function load(name, dependencies) {
  const exports = {}, source = await readFile(new URL(`../electron/main/${name}.ts`, import.meta.url), "utf8");
  new Function("require", "exports", ts.transpileModule(source, { compilerOptions: {
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS,
  } }).outputText)(id => { assert(Object.hasOwn(dependencies, id), id); return dependencies[id]; }, exports);
  return exports;
}
const objectView = await load("courseware-scene-object-view", { "@pi-desktop/shared": shared });
const { generateSavedNarrationBatch } = await load("courseware-narration-batch", {
  "@pi-desktop/shared": shared, "@pi-desktop/agent-runtime": runtime, "./courseware-scene-object-view": objectView,
  "./courseware-review-json": await import("../electron/main/courseware-review-json.ts"),
  "./courseware-narration-visuals": { createNarrationVisuals() { assert.fail("Unexpected rasterization"); } },
});
const { buildSceneCourseDeck } = await load("courseware-scene-deck", {
  "node:crypto": { createHash }, "./courseware-scene-generator": { createCoursewareSceneGenerator: () => () => assert.fail("Unexpected layout model") },
});
const hash = bytes => createHash("sha256").update(bytes).digest("hex");

test("approved body media survives actual Main/Host repair, lost save reply and restart", {
  skip: !process.env.DECKWISE_E2E_WORKFLOW_HOST, timeout: 90_000,
}, async t => {
  const directory = await mkdtemp(join(tmpdir(), "deckwise-workflow-contract-")), workspace = join(directory, "workspace"), data = join(directory, "data");
  await mkdir(workspace); await mkdir(join(data, "plugins/market"), { recursive: true });
  await writeFile(join(data, "plugins/market/catalog.json"), JSON.stringify({ schemaVersion: 2, providerId: "official", plugins: [] }));
  const host = new Host(process.env.DECKWISE_E2E_WORKFLOW_HOST, data);
  t.after(async () => { await host.stop(); await rm(directory, { recursive: true, force: true }); });
  await host.start();
  const sessionId = (await host.call("session.create", { projectPath: workspace })).session.id, principalKey = "a".repeat(64);
  await host.call("courseware.task.set", { sessionId, taskType: "scene" });
  const teaching = { pageType: "slide", phase: "practice", objective: "Greet", durationSeconds: 30, requiredObjects: [],
    video: { purpose: "Show a wave", prompt: "A five-second silent wave" } };
  const plan = { title: "Greeting", pages: [
    { title: "Greeting", visibleText: ["Hello", "Bye"], visualIntent: "A wave", narration: "Hello. Welcome!", teaching },
    { title: "Goodbye", visibleText: ["Bye"], visualIntent: "A goodbye wave", narration: "Goodbye!", teaching: {
      pageType: "slide", phase: "review", objective: "Say goodbye", durationSeconds: 30, requiredObjects: [],
    } },
  ] };
  const planBytes = Buffer.from(JSON.stringify(plan)), planSha256 = hash(planBytes), path = join(workspace, ".deckwise-ppt/scenes", sessionId, "plan.json");
  await mkdir(join(path, ".."), { recursive: true }); await writeFile(path, planBytes);
  await host.call("courseware.scenePlan.approve", { sessionId, sha256: planSha256 });
  const sharp = createRequire(new URL("../../../packages/courseware-runtime/package.json", import.meta.url))("sharp");
  const master = await sharp({ create: { width: 128, height: 128, channels: 4, background: "red" } }).png().toBuffer();
  const clean = await sharp({ create: { width: 128, height: 128, channels: 4, background: "white" } }).png().toBuffer();
  const ids = [], visuals = [], pages = plan.pages.map((page, i) => ({ ...page, pageId: `scene-00${i + 1}`, sourceHash: `sha256:${hash(JSON.stringify(page))}` }));
  for (const page of pages) {
    for (const target of [{ kind: "visualMaster" }, { kind: "cleanPlate" }, { kind: "layer", name: "Wave" }]) {
      const prepared = (await host.call("courseware.sceneImage.prepare", { sessionId, principalKey, planSha256, pageId: page.pageId, target, model: "fixture-image" })).intent;
      const operation = { sessionId, principalKey, intentId: prepared.intentId };
      await host.call("courseware.sceneImage.begin", operation);
      const taskRef = { taskId: `task-${prepared.intentId}`, idempotencyKey: prepared.idempotencyKey, requestHash: prepared.requestHash };
      await host.call("courseware.sceneImage.bind", { ...operation, taskRef });
      const bytes = target.kind === "cleanPlate" ? clean : master;
      await host.call("courseware.sceneImage.asset.stage", { ...operation, asset: { taskRef, sha256: hash(bytes), byteLength: bytes.length, mimeType: "image/png", width: 128, height: 128 }, bytesBase64: bytes.toString("base64") });
      await host.call("courseware.sceneImage.asset.adopt", { ...operation, expectedSelectedIntentId: null });
      ids.push(prepared.intentId);
    }
    visuals.push({ pageId: page.pageId, visualMasterAssetId: "master", cleanPlateAssetId: "clean",
      images: [{ assetIds: ["master"], bytes: master }, { assetIds: ["clean"], bytes: clean }, { assetIds: ["wave"], bytes: master }],
      foregroundPlacements: [{ assetId: "wave", bboxPx: [32, 32, 64, 64], zIndex: 1 }] });
  }
  const deck = await buildSceneCourseDeck({ sessionId, modelKey: "fixture/model", pages, visuals, canvas: { width: 128, height: 128 } }, async () => assert.fail("Unexpected model"), authoring);
  // Supply real readable notes so the headless case needs no native slide renderer.
  const JSZip = createRequire(new URL("../../../packages/courseware-runtime/package.json", import.meta.url))("jszip");
  const zip = await JSZip.loadAsync(deck.pptx);
  for (let i = 1; i <= pages.length; i++) {
    const rel = `ppt/slides/_rels/slide${i}.xml.rels`, types = "[Content_Types].xml";
    zip.file(rel, (await zip.file(rel).async("string")).replace("</Relationships>", `<Relationship Id="fixture-notes" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/notesSlide" Target="../notesSlides/notesSlide${i}.xml"/></Relationships>`));
    zip.file(types, (await zip.file(types).async("string")).replace("</Types>", `<Override PartName="/ppt/notesSlides/notesSlide${i}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.notesSlide+xml"/></Types>`));
    zip.file(`ppt/notesSlides/notesSlide${i}.xml`, '<p:notes xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><p:cSld><p:spTree><p:sp><p:nvSpPr><p:cNvPr id="2" name="Notes"/><p:cNvSpPr/><p:nvPr><p:ph type="body"/></p:nvPr></p:nvSpPr><p:spPr/><p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:t>Greeting lesson</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:notes>');
  }
  deck.pptx = await zip.generateAsync({ type: "nodebuffer" });
  const archive = join(workspace, ".deckwise-ppt/revisions/contract/r0001/document.pptx");
  await mkdir(join(archive, ".."), { recursive: true }); await writeFile(archive, deck.pptx);
  const { jobId } = await host.call("courseware.parseStart", { sessionId, path: archive });
  let parsed;
  for (let i = 0; i < 400; i++) {
    parsed = await host.call("courseware.parseStatus", { jobId });
    if (parsed.status !== "RUNNING") break;
    await delay(20);
  }
  assert.equal(parsed.status, "SUCCEEDED", JSON.stringify(parsed));
  const initialized = await host.call("courseware.project.initializeGenerated", { sessionId, jobId, sourceSha256: hash(deck.pptx), title: plan.title,
    narrations: plan.pages.map(p => p.narration), sceneMapping: deck.mapping, sceneProof: { planSha256, principalKey, selectedIntentIds: ids } });
  let project = initialized.project, lostReply = false, deltaCalls = 0;
  const read = async () => (await host.call("courseware.project.get", { sessionId, projectId: project.projectId })).project;
  const bridge = { async call(method, args) {
    const result = await host.call(method, args);
    if (method === "courseware.narration.save" && args.write.pageId === project.pages[0].pageId && lostReply) { lostReply = false; throw new Error("Fixture lost committed reply"); }
    return result;
  } };
  const batch = repairRequiredTeaching => generateSavedNarrationBatch({ host: bridge, sessionId, jobId, project, bytes: deck.pptx,
    selected: [1, 2], instruction: "Teach the approved lesson", repairRequiredTeaching, model: { modelKey: "fixture/model" },
    canDispatch: () => true, current: async expected => assert.deepEqual(await read(), expected),
    complete: async input => {
      const request = JSON.parse(input.messages[0].content);
      if (request.reviewKind === "narration_semantics") return { text: JSON.stringify({ issues: [] }) };
      if (request.outline) return { text: JSON.stringify({ goal: "Greet", pages: request.outline.map(p => ({ pageNumber: p.pageNumber, purpose: "Greet", bridge: "Continue", focus: "Greeting" })) }) };
      if (request.missing) {
        deltaCalls++;
        assert.deepEqual(request.missing, ["video"]);
        return { text: JSON.stringify({ insertions: [{ afterSpeechId: request.speechAnchors[0], block: { type: "video", prompt: teaching.video.prompt } }] }) };
      }
      return { text: JSON.stringify({ blocks: [{ type: "speech", text: "Hello. Welcome!" }] }) };
    },
  });
  const initial = await batch(false);
  assert.equal(initial.saved, true, JSON.stringify(initial));
  project = await read();
  const completion = async () => (await host.call("courseware.workflow.get", { sessionId, projectId: project.projectId })).completion;
  assert((await completion()).issues.some(i => i.code === "VIDEO_MISSING"));
  assert.equal(project.pages[0].actions[0].text, "Hello. Welcome!");
  const audio = await readFile(new URL("fixtures/courseware-tts-tone.mp3", import.meta.url));
  for (const page of project.pages) for (const speech of page.actions.filter(a => a.type === "speech")) {
    const intentId = randomUUID(), scope = { sessionId, projectId: project.projectId, principalKey, intentId };
    const intent = (await host.call("courseware.tts.prepare", { sessionId, selection: { ...scope, sessionId: undefined, pageId: page.pageId, actionId: speech.id,
      expectedSourceRevision: project.source.revision, expectedTeachingRevision: project.teachingRevision, model: "fixture-tts", voice: null } })).intent;
    await host.call("courseware.tts.begin", scope);
    const taskRef = { taskId: `tts-${intentId}`, idempotencyKey: intent.idempotencyKey, requestHash: intent.requestHash };
    await host.call("courseware.tts.bind", { ...scope, taskRef });
    await host.call("courseware.tts.audio.stage", { ...scope, audio: { taskRef, sha256: hash(audio), byteLength: audio.length, mimeType: "audio/mpeg", durationMs: 1000 }, bytesBase64: audio.toString("base64") });
    await host.call("courseware.tts.audio.adopt", { ...scope, expectedTeachingRevision: project.teachingRevision, expectedAudioAssetId: null });
    project = await read();
  }
  const originalSpeech = project.pages.map(p => p.actions.filter(a => a.type === "speech"));
  lostReply = true;
  assert.equal((await batch(true)).saved, false);
  project = await read();
  assert.equal((await batch(true)).saved, true);
  project = await read();
  assert.equal(deltaCalls, 1);
  assert.deepEqual(project.pages.map(p => p.actions.filter(a => a.type === "speech")), originalSpeech);
  assert.equal(project.pages[0].actions.filter(a => a.type === "interaction_checkpoint").length, 0);
  const slot = project.pages[0].actions.find(a => a.type === "video_slot");
  assert(slot);
  const scope = { sessionId, projectId: project.projectId, principalKey };
  const video = (await host.call("courseware.video.prepare", { ...scope, pageId: project.pages[0].pageId, slotId: slot.id, model: "fixture-video" })).intent;
  const operation = { ...scope, intentId: video.intentId };
  await host.call("courseware.video.begin", operation);
  const taskRef = { taskId: "video-original", idempotencyKey: video.idempotencyKey, requestHash: video.requestHash };
  await host.call("courseware.video.bind", { ...operation, taskRef });
  const bytes = await readFile(new URL("fixtures/courseware-workflow/silent.mp4", import.meta.url));
  await host.call("courseware.video.stage", { ...operation, taskRef, asset: { sha256: hash(bytes), byteLength: bytes.length, width: 128, height: 128, durationMs: 5000 }, bytesBase64: bytes.toString("base64") });
  await host.call("courseware.video.adopt", { ...operation, expectedTeachingRevision: project.teachingRevision });
  project = await read();
  assert.equal((await completion()).ready, true);
  await host.call("courseware.parseRelease", { jobId });
  await host.stop(); await host.start();
  assert.deepEqual(await read(), project);
  assert.equal((await completion()).ready, true);
  const turnId = (await host.call("session.beginTurn", { sessionId })).turnId;
  const sidecar = Object.create(AgentSidecar.prototype), replies = new Map();
  sidecar.host = host;
  sidecar.localTools = new Map();
  sidecar.writeToChild = line => { const reply = JSON.parse(line); replies.set(reply.id, reply); return true; };
  const proxy = async (method, params) => {
    const id = randomUUID();
    await sidecar.onLine(JSON.stringify({ jsonrpc: "2.0", id, method: "host.proxy", params: { method, params } }));
    const reply = replies.get(id); replies.delete(id);
    if (reply.error) throw Object.assign(new Error(reply.error.message), { code: reply.error.code });
    return reply.result;
  };
  const { createAssistantMessageEventStream } = await import(new URL("../../../packages/agent-runtime/node_modules/@earendil-works/pi-ai/dist/index.js", import.meta.url));
  let requests = 0;
  const events = [], model = { source: "generic", name: "Fixture", baseUrl: "http://127.0.0.1:1/v1", reasoning: false,
    input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 256_000, maxTokens: 4096 };
  const agent = new runtime.DesktopAgentRuntime({ sessionId, mode: "agent", thinkingLevel: "off",
    commandShell: { id: "bash", label: "Bash", dialect: "posix", available: true, isDefault: true },
    provider: { id: "fixture", name: "Fixture", baseUrl: model.baseUrl, modelId: "fixture", apiKey: "", authKind: "none",
      supportsReasoning: false, supportedThinkingLevels: ["off"], modelConfig: model },
    onEvent: event => events.push(event), host: { async call(method, params) {
      if (method.startsWith("courseware.workflow.")) return proxy(method, params);
      if (method !== "tools.execute") return {};
      assert.equal(params.toolName, "courseware_media_context");
      const current = await read(), progress = shared.coursewareTeachingProgress(current);
      return { ok: true, content: { projectId: current.projectId, sourceSha256: current.source.sha256, teachingRevision: current.teachingRevision,
        jobs: [], completion: await completion(), narrationReady: true, audioReady: progress.audio === progress.total, teachingReady: progress.ready === progress.total,
        videoReady: !current.pages.some(p => p.actions.some(a => a.type === "video_slot")), quality: shared.inspectCoursewareTeaching(current) } };
    } },
  });
  agent.agent.streamFunction = () => {
    requests++;
    const content = requests === 1 ? [{ type: "toolCall", id: "search", name: "ToolSearch", arguments: { query: "courseware_media_context" } }]
      : requests === 2 ? [{ type: "toolCall", id: "context", name: "courseware_media_context", arguments: { continueTeaching: true } }]
      : [{ type: "text", text: "The saved course is complete." }];
    const message = { role: "assistant", api: "openai-completions", provider: "fixture", model: "fixture", timestamp: Date.now(), content,
      stopReason: requests < 3 ? "toolUse" : "stop", usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
    const stream = createAssistantMessageEventStream();
    queueMicrotask(() => { stream.push({ type: "done", reason: message.stopReason, message }); stream.end(message); });
    return stream;
  };
  try {
    await agent.prompt("Finish the saved teaching course.", "user", turnId);
    assert.equal(requests, 3, "one discovery request, one status request, one final report");
    assert.equal(agent.getStatus().isRunning, false);
    assert.equal(events.filter(e => e.event.type === "error").length, 0);
    assert.equal(events.filter(e => e.event.type === "agent_end").length, 1);
    assert.equal((await host.call("courseware.workflow.get", { sessionId, projectId: project.projectId })).checkpoint.status, "completed");
  } finally { await agent.dispose(); }
  t.diagnostic(JSON.stringify({ modelRepairCalls: deltaCalls, originalVideoAdoptions: 1, preservedSpeeches: originalSpeech.flat().length, terminalEvents: 1, providerCalls: 0 }));
});
