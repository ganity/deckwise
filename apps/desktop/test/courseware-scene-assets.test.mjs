import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";
import * as shared from "../../../packages/shared/dist/index.js";

const source = await readFile(new URL("../electron/main/courseware-scene-assets.ts", import.meta.url), "utf8");
const { outputText } = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } });
const exports = {};
new Function("require", "exports", outputText)((id) => {
  if (id === "@pi-desktop/shared") return shared;
  throw new Error(`Unexpected dependency: ${id}`);
}, exports);
const { resolveSceneCourseVisuals } = exports;
const fixture = JSON.parse(await readFile(new URL("../../../packages/shared/src/courseware-contract.fixtures/team-image.json", import.meta.url), "utf8")).data;
const ref = (suffix) => {
  const value = structuredClone(fixture);
  value.assetRef.assetId = `11111111-1111-4111-8111-${String(suffix).padStart(12, "0")}`;
  value.assetRef.downloadPath = `/courseware/team/projects/${value.projectId}/assets/${value.assetRef.assetId}/content`;
  assert(shared.isCoursewareTeamAssetRef(value));
  return value;
};
const first = ref(1), second = ref(2), sharedBackground = ref(3);
const pages = [{ pageId: "scene-001" }, { pageId: "scene-002" }];
const assignments = [
  { pageId: "scene-001", visualMaster: first, cleanPlate: sharedBackground, layers: [] },
  { pageId: "scene-002", visualMaster: second, cleanPlate: sharedBackground, layers: [] },
];

test("authorized scene assets remain bound to each planned page", async () => {
  let requested;
  const visuals = await resolveSceneCourseVisuals({ pages, assignments, canvas: { width: 1280, height: 800 } }, async (refs) => {
    requested = refs;
    return [{ assetIds: [first.assetRef.assetId, second.assetRef.assetId, sharedBackground.assetRef.assetId], width: 1280, height: 800, bytes: Buffer.from("fixture"), sha256: "a".repeat(64) }];
  });
  assert.equal(requested.length, 3);
  assert.deepEqual(visuals.map((value) => value.pageId), ["scene-001", "scene-002"]);
  assert(!visuals[0].images[0].assetIds.includes(second.assetRef.assetId));
  assert(!visuals[1].images[0].assetIds.includes(first.assetRef.assetId));
});

test("missing or mismatched page backgrounds fail after authorized resolution", async () => {
  await assert.rejects(resolveSceneCourseVisuals({ pages, assignments: assignments.slice(0, 1), canvas: { width: 1280, height: 800 } }, async () => []), /Invalid scene visual/);
  await assert.rejects(resolveSceneCourseVisuals({ pages, assignments, canvas: { width: 1280, height: 800 } }, async () => [
    { assetIds: [first.assetRef.assetId, second.assetRef.assetId, sharedBackground.assetRef.assetId], width: 640, height: 400, bytes: Buffer.from("fixture"), sha256: "a".repeat(64) },
  ]), /differs from the selected canvas/);
});
