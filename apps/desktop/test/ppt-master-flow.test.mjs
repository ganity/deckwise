import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (path) => readFile(new URL(path, import.meta.url), "utf8");
const [panel, queue, events, skill] = await Promise.all([
  read("../src/components/workpanel/PptMasterTab.tsx"),
  read("../src/stores/slices/queue-slice.ts"),
  read("../src/stores/slices/events-slice.ts"),
  read("../electron/main/builtin-skills.ts"),
]);

test("PPT tasks open PPT Master without workspace edits opening Review", () => {
  assert.match(queue, /openWorkPanelTabForSession\(startedIn, toolWorkPanelTab\("ppt"\)\)/);
  assert.doesNotMatch(events, /shouldOpenReviewArtifact|toolWorkPanelTab\("review"\)/);
});

test("SVG preview opens in Browser and waits for explicit PPTX generation", () => {
  assert.match(skill, /call ToolSearch for `browser`/);
  assert.match(skill, /Browser with `action=navigate`/);
  assert.match(skill, /Do not finalize or export PPTX until the user explicitly requests/);
  assert.match(panel, /生成 PPTX/);
  assert.match(panel, /sendPrompt\(PPTX_EXPORT_PROMPT/);
  assert.doesNotMatch(panel, /当前产物|开始生成/);
});

test("delivered PPT projects revise SVG as the only source and export a new PPTX", () => {
  assert.match(skill, /SVG is the only source of truth/);
  assert.match(skill, /official Revision Round/);
  assert.match(skill, /immediately create a new timestamped PPTX export/);
  assert.match(skill, /Never read changes back from a PPTX/);
  assert.match(panel, /latestSvgMtime > pptx\.mtimeMs/);
  assert.match(panel, /重新生成 PPTX/);
  assert.match(panel, /正在根据最新 SVG 生成新版本 PPTX/);
});
