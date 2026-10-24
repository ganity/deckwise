import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import test from "node:test";
import ts from "typescript";
import * as authoring from "@pi-desktop/courseware-runtime/authoring";

const requireCourseware = createRequire(new URL("../../../packages/courseware-runtime/package.json", import.meta.url));
const sharp = requireCourseware("sharp");
const background = await sharp({ create: { width: 1280, height: 800, channels: 4, background: "#ffffff" } }).png().toBuffer();
const source = await readFile(new URL("../electron/main/courseware-scene-deck.ts", import.meta.url), "utf8");
const { outputText } = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } });
let conflict = false;
let imageOnly = false;
const calls = [];
const exports = {};
new Function("require", "exports", outputText)((id) => {
  if (id === "node:crypto") return { createHash };
  if (id === "./courseware-scene-generator") return { createCoursewareSceneGenerator(config) {
    return async (request) => {
      calls.push({ config, request });
      return { scene: { version: 1, slideId: request.pageId, sourceHash: request.sourceHash, canvas: request.canvas,
        visualMasterAssetId: "master", cleanPlateAssetId: "clean", elements: imageOnly ? [{ id: "flat", type: "image_layer", layerRoute: "A1", assetId: "clean", bboxPx: [0, 0, 1280, 800], zIndex: 1 }] : [{ id: "title", type: "native_text", bboxPx: [80, 70, 800, 100], zIndex: 1,
          content: request.pageText.split("\n")[0], style: { fontFace: "Arial", fontSizePt: 32, color: "#000000", align: "left", lineHeight: 1.2 }, spokenAliases: [] }] },
        assets: { master: background, clean: conflict && calls.length === 2 ? Buffer.from("different") : background } };
    };
  } };
  throw new Error(`Unexpected dependency: ${id}`);
}, exports);
const { buildSceneCourseDeck } = exports;
const pages = [1, 2].map((number) => ({ pageId: `scene-00${number}`, sourceHash: `sha256:${"a".repeat(64)}`,
  title: `Page ${number}`, visibleText: ["Hello"], visualIntent: "孩子挥手", narration: `讲解 ${number}` }));
const visuals = pages.map(({ pageId }) => ({ pageId, visualMasterAssetId: "master", cleanPlateAssetId: "clean", images: [] }));
const input = { sessionId: "s", modelKey: "provider/model", pages, visuals, canvas: { width: 1280, height: 800 } };

test("planned scene pages compile as one editable PPTX and keep page narration separate", async () => {
  calls.length = 0;
  const deck = await buildSceneCourseDeck(input, async () => ({ text: "" }), authoring);
  assert.equal(deck.mapping.pages.length, 2);
  assert.deepEqual(deck.teaching, pages.map(({ pageId, narration }) => ({ pageId, narration })));
  assert.equal(calls.length, 2);
  assert.match(calls[0].request.instruction, /teacher narration is separate/);
  assert(!calls[0].request.pageText.includes("讲解"));
  assert(deck.pptx.length > 1000);
});

test("conflicting asset IDs and missing page visuals fail before compiling", async () => {
  calls.length = 0;
  await assert.rejects(buildSceneCourseDeck({ ...input, visuals: visuals.slice(0, 1) }, async () => ({ text: "" }), authoring), /Invalid scene course/);
  conflict = true;
  try { await assert.rejects(buildSceneCourseDeck(input, async () => ({ text: "" }), authoring), /conflicting bytes/); }
  finally { conflict = false; }
});

test("a raster-only scene cannot be presented as independently editable output", async () => {
  imageOnly = true;
  try { await assert.rejects(buildSceneCourseDeck(input, async () => ({ text: "" }), authoring), /independently editable native objects/); }
  finally { imageOnly = false; }
});

test("a scene cannot silently drop a reviewed foreground even when native text remains", async () => {
  const withForegrounds = visuals.map(visual => ({ ...visual, images: [
    { assetIds: ["master"], bytes: background }, { assetIds: ["clean"], bytes: background },
    { assetIds: ["apple"], bytes: background },
  ] }));
  await assert.rejects(buildSceneCourseDeck({ ...input, visuals: withForegrounds }, async () => ({ text: "" }), authoring),
    /retain every reviewed foreground as a separate object/);
});
