import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (path) => readFile(new URL(path, import.meta.url), "utf8");
const [controller, ipc, protocol, api, panel, skill] = await Promise.all([
  read("../electron/main/ppt-preview.ts"),
  read("../electron/main/ipc/ppt-preview-ipc.ts"),
  read("../../../packages/shared/src/protocol.ts"),
  read("../src/lib/api.ts"),
  read("../src/components/workpanel/PptMasterTab.tsx"),
  read("../electron/main/builtin-skills.ts"),
]);

test("SVG preview probes the project service and restarts it when unavailable", () => {
  assert.match(controller, /\/api\/health/);
  assert.match(controller, /service[^\n]*live_preview/);
  assert.match(controller, /resolveBundledPython/);
  assert.match(controller, /resolvePptMasterSkillRoot/);
  assert.match(controller, /--live/);
  assert.match(controller, /--daemon/);
  assert.match(controller, /--no-browser/);
  assert.match(controller, /live_preview["']?,\s*["']lock\.json/);
});

test("the main-window-only IPC returns a ready preview URL", () => {
  assert.match(protocol, /pptPreviewOpen:\s*"deckwise\/ppt-preview\/open"/);
  assert.match(ipc, /assertMainWindowSender/);
  assert.match(ipc, /controller\.open/);
  assert.match(api, /pptPreviewOpen/);
});

test("PPT Master exposes an in-app preview action", () => {
  assert.match(panel, /预览 SVG/);
  assert.match(panel, /api\.pptPreviewOpen/);
  assert.match(panel, /browserPluginTab/);
  assert.match(skill, /--no-browser/);
});
