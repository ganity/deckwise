import assert from "node:assert/strict";
import test from "node:test";
import {
  createMediaCanvasDocument, parseMediaCanvasDocument, addMediaCanvasDraft, editMediaCanvasDraft,
  moveMediaCanvasDraft, removeMediaCanvasDraft, setMediaCanvasViewport, zoomMediaCanvasViewport,
} from "../src/lib/courseware-media-canvas.ts";

test("canvas prompts, pinned references and placement survive a serialized project-local roundtrip", () => {
  let document = createMediaCanvasDocument("project-a");
  for (const kind of ["image", "video", "music", "sound"]) document = addMediaCanvasDraft(document, kind, kind, kind);
  document = editMediaCanvasDraft(document, "image", 0, { prompt: "A friendly rabbit", references: [{ assetId: "asset-1", revision: "sha256:1", label: "Original" }] });
  document = moveMediaCanvasDraft(document, "image", -40, 200);
  document = setMediaCanvasViewport(document, { x: 90, y: -10, zoom: 0.5 });
  assert.deepEqual(parseMediaCanvasDocument(JSON.parse(JSON.stringify(document)), "project-a"), document);
  assert.throws(() => parseMediaCanvasDocument(document, "project-b"));
  assert.equal(document.drafts[0].revision, 1);
});

test("Chat and properties edit the same revision; late answers do not erase new prompt or placement", () => {
  let document = addMediaCanvasDraft(createMediaCanvasDocument("project"), "draft", "image", "Picture");
  document = moveMediaCanvasDraft(document, "draft", 100, 200);
  document = editMediaCanvasDraft(document, "draft", 0, { prompt: "Property edit" });
  assert.throws(() => editMediaCanvasDraft(document, "draft", 0, { prompt: "Late Chat reply" }), /changed/);
  document = editMediaCanvasDraft(document, "draft", 1, { prompt: "Accepted Chat edit" });
  assert.equal(document.drafts[0].prompt, "Accepted Chat edit");
  assert.deepEqual([document.drafts[0].x, document.drafts[0].y], [100, 200]);
  assert.throws(() => editMediaCanvasDraft(document, "draft", 2, { x: 0 }), /Unsupported/);
  const removed = removeMediaCanvasDraft(document, "draft");
  assert.equal(removed.drafts.length, 0);
  assert.equal(document.drafts.length, 1);
});

test("zoom preserves its world-space anchor and clamps zoom", () => {
  const viewport = { x: 20, y: 30, zoom: 1 };
  const next = zoomMediaCanvasViewport(viewport, 2, 120, 130);
  assert.equal((120 - next.x) / next.zoom, 100);
  assert.equal((130 - next.y) / next.zoom, 100);
  assert.equal(zoomMediaCanvasViewport(viewport, 100, 0, 0).zoom, 3);
  assert.equal(zoomMediaCanvasViewport(viewport, 0, 0, 0).zoom, 0.2);
});

test("invalid cross-boundary documents, duplicates and oversized prompts are rejected", () => {
  const valid = addMediaCanvasDraft(createMediaCanvasDocument("project"), "draft", "image", "Picture");
  const invalid = [
    { ...valid, version: 2 }, { ...valid, revision: -1 }, { ...valid, viewport: { x: 0, y: 0, zoom: Infinity } },
    { ...valid, drafts: [...valid.drafts, ...valid.drafts] },
    { ...valid, drafts: [{ ...valid.drafts[0], prompt: "x".repeat(16_001) }] },
    { ...valid, drafts: [{ ...valid.drafts[0], x: NaN }] },
    { ...valid, drafts: [{ ...valid.drafts[0], references: [{ assetId: "x", label: "unversioned" }] }] },
  ];
  for (const document of invalid) assert.throws(() => parseMediaCanvasDocument(document, "project"));
  assert.throws(() => addMediaCanvasDraft(valid, "draft", "image", "Duplicate"));
});
