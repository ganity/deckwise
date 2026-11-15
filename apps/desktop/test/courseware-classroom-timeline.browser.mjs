import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import ts from "typescript";
import * as runtime from "../../../packages/courseware-runtime/dist/node.mjs";

const root = new URL("../../../", import.meta.url).pathname;
const require = createRequire(join(root, "packages/courseware-runtime/package.json"));
const desktopRequire = createRequire(join(root, "apps/desktop/package.json"));
const { build } = require("esbuild"), { chromium, expect } = require("@playwright/test"), JSZip = require("jszip");
const exports = {};
new Function("require", "exports", ts.transpileModule(await readFile(new URL("../electron/main/courseware-classroom-timeline.ts", import.meta.url), "utf8"), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText)(id => { assert.equal(id, "@pi-desktop/courseware-runtime/node"); return runtime; }, exports);
const out = await mkdtemp(join(tmpdir(), "maic-timeline-browser-"));
const wav = Buffer.alloc(44 + 48000);
wav.write("RIFF"); wav.writeUInt32LE(wav.length-8, 4); wav.write("WAVEfmt ", 8); wav.writeUInt32LE(16, 16);
wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22); wav.writeUInt32LE(8000, 24); wav.writeUInt32LE(16000, 28);
wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write("data", 36); wav.writeUInt32LE(48000, 40);
const music = await readFile(join(root, "packages/courseware-runtime/tests/fixtures/music-clip/tone.mp3"));
const target = { id: "target", type: "text", sourceShapeId: "42", left: 20, top: 30, width: 200, height: 80, rotate: 0, content: "<p>Animated target</p>", defaultFontName: "Arial", defaultColor: "#000000" };
const scene = { id: "body", stageId: "stage", type: "slide", title: "Native teaching", order: 0, content: { type: "slide", canvas: {
  id: "canvas", viewportSize: 1000, viewportRatio: .5625, theme: { backgroundColor: "#fff", themeColors: [], fontColor: "#000", fontName: "Arial" }, elements: [target],
} }, actions: [{ id: "speech", type: "speech", text: "Local narration", audioId: "voice", audioUrl: "asset:voice" }] };
const converted = exports.convertNativeTeaching({ scene, sourceSha256: "a".repeat(64),
  page: { id: "page", width: 1000, height: 562.5, elements: [target], pptxAnimation: { steps: [{ id: "entry", trigger: "click", items: [{ id: "appear", effect: "appear", animationType: "in", startAtMs: 0, durationMs: 0, target: { shapeId: "42" } }] }] } },
  objects: [{ objectId: "logical", importElementId: "target" }],
  resources: new Map([["voice", { url: "asset:voice", mimeType: "audio/wav", durationMs: 3000 }], ["song", { url: "asset:song", mimeType: "audio/mpeg", durationMs: 8072 }]]),
  actions: [{ id: "entry", type: "native_animation", version: 1, sourceSha256: "a".repeat(64), stepIndex: 0 },
    { id: "speech", type: "speech", text: "Local narration", audioAssetId: "voice", visualCues: [
      { id: "pulse", atMs: 0, endMs: 200, effect: { type: "element_animation", elementId: "logical", effect: "pulse" } },
      { id: "focus", atMs: 250, endMs: 2400, effect: { type: "spotlight", elementId: "logical" } },
      { id: "highlight", atMs: 1000, endMs: 2700, effect: { type: "highlight", elementIds: ["logical"], style: "outline" } },
    ] }, { id: "pause", type: "delay", durationMs: 400 }, { id: "music", type: "audio_clip", audioAssetId: "song" }],
});
scene.actions = converted.actions; scene.content.canvas.elements.push(...converted.elements);
const classroom = { id: "class", createdAt: "2026-11-06", stage: { id: "stage", name: "Timeline", createdAt: 1, updatedAt: 1 }, scenes: [scene], mediaManifest: converted.media,
  audioManifest: [{ sceneId: "body", actionId: "speech", assetId: "voice", audioId: "voice", mimeType: "audio/wav", url: "asset:voice", originalUrl: "asset:voice" }] };
const zip = await JSZip.loadAsync(await runtime.exportMaicClassroom(classroom, async asset => asset.assetId === "voice" ? wav : music));
const meta = JSON.parse(await zip.file("meta.json").async("string"));
await build({ stdin: { contents: `import React from 'react';import {createRoot} from 'react-dom/client';import {loadMaicClassroom, FixedCoursewarePlayer, englishPlayerLabels} from './packages/courseware-runtime/src/player';
const raw=await(await fetch('/meta.json')).json();const build=await loadMaicClassroom(raw.classroom,'fixture',async asset=>URL.createObjectURL(await(await fetch('/'+asset.url)).blob()));
window.events=[];createRoot(document.getElementById('root')).render(<FixedCoursewarePlayer build={build} labels={englishPlayerLabels} onState={(mode)=>window.events.push({mode,at:performance.now()})}/>);`, resolveDir: root, loader: "tsx" },
  outfile: join(out, "app.js"), bundle: true, format: "esm", jsx: "automatic", plugins: [{ name: "one-react", setup(builder) {
    builder.onResolve({ filter: /^react(?:-dom)?(?:\/.*)?$/ }, args => ({ path: desktopRequire.resolve(args.path) }));
  } }] });
const server = createServer(async (req, res) => {
  try {
    const path = new URL(req.url, "http://localhost").pathname;
    if (path === "/meta.json") { res.setHeader("content-type", "application/json"); res.end(JSON.stringify(meta)); }
    else if (path.startsWith("/assets/")) { res.setHeader("content-type", path.endsWith(".wav") ? "audio/wav" : "audio/mpeg"); res.end(await zip.file(path.slice(1)).async("nodebuffer")); }
    else if (path === "/player.css") { res.setHeader("content-type", "text/css"); res.end(await readFile(join(root, "packages/courseware-runtime/dist/player.css"))); }
    else if (path === "/app.js") { res.setHeader("content-type", "text/javascript"); res.end(await readFile(join(out, "app.js"))); }
    else { res.setHeader("content-type", "text/html"); res.end('<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="/player.css"><div id="root"></div><script type="module" src="/app.js"></script>'); }
  } catch (error) { res.statusCode = 500; res.end(String(error)); }
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const browser = await chromium.launch({ headless: true, args: ["--autoplay-policy=no-user-gesture-required"] });
try {
  const page = await browser.newPage({ viewport: { width: 1180, height: 900 } }), errors = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  const targetNode = page.locator('[data-slide-render-element-id="target"]');
  await expect(targetNode).toHaveCSS("opacity", "0");
  await page.getByRole("button", { name: "Play", exact: true }).click();
  await expect(targetNode).toHaveCSS("opacity", "1");
  const focusId = converted.elements.find(e => e.id.endsWith("spotlight")).id;
  const focus = page.locator(`[data-slide-render-element-id="${focusId}"]`);
  await expect(focus).toHaveCSS("opacity", "1");
  await page.getByRole("button", { name: "Pause", exact: true }).click();
  const paused = await page.getByRole("slider").first().inputValue();
  await page.waitForTimeout(200);
  assert.equal(await page.getByRole("slider").first().inputValue(), paused, "Pause freezes narration");
  await page.getByRole("button", { name: "Resume", exact: true }).click();
  await expect(focus).toHaveCSS("opacity", "0", { timeout: 5000 });
  await page.waitForFunction(() => [...document.querySelectorAll("audio")].some(a => !a.paused && a.currentTime > .05), { timeout: 6000 });
  await page.getByRole("button", { name: "Pause", exact: true }).click();
  const musicTime = await page.locator("audio").evaluate(a => ({ time: a.currentTime, paused: a.paused }));
  assert(musicTime.paused, "Pause reaches the canonical audio element");
  await page.waitForTimeout(150);
  assert(Math.abs(await page.locator("audio").evaluate(a => a.currentTime) - musicTime.time) < .04);
  await page.getByRole("button", { name: "Resume", exact: true }).click();
  await page.locator("audio").evaluate(a => { a.currentTime = a.duration - .1; });
  await expect(page.getByRole("status").filter({ hasText: "Playback complete" })).toBeVisible();
  assert.deepEqual(errors, []);
  console.log("PASS native→MAIC→archive→player: hidden entrance, timed spotlight/highlight, speech pause, real MP3, pause/resume and completion");
} finally { await browser.close(); await new Promise(resolve => server.close(resolve)); await rm(out, { recursive: true, force: true }); }
