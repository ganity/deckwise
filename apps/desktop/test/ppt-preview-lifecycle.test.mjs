import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";

const read = (path) => readFile(new URL(path, import.meta.url), "utf8");
const [controller, ipc, protocol, api, panel, skill, editor, editorCss] = await Promise.all([
  read("../electron/main/ppt-preview.ts"),
  read("../electron/main/ipc/ppt-preview-ipc.ts"),
  read("../../../packages/shared/src/protocol.ts"),
  read("../src/lib/api.ts"),
  read("../src/components/courseware/CoursewareChatPresentation.tsx"),
  read("../electron/main/builtin-skills.ts"),
  read("../src/components/workpanel/SvgEditorTab.tsx"),
  read("../src/styles/svg-editor.css"),
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
  assert.match(protocol, /pptPreviewRequest:\s*"deckwise\/ppt-preview\/request"/);
  assert.match(ipc, /assertMainWindowSender/);
  assert.match(ipc, /controller\.open/);
  assert.match(ipc, /controller\.request/);
  assert.match(api, /pptPreviewOpen/);
});

test("preview readiness and editor requests use the owning session's workspace", async () => {
  const handlers = new Map();
  const roots = { master: "/master/workspace", imported: "/import/workspace" };
  const calls = [];
  let slides = [{ ok: false }];
  class Preview {
    async open(root, path) {
      calls.push([root, path, "open"]);
      return { url: "http://127.0.0.1:6061/", started: false };
    }
    async request(root, path, { route, method }) {
      calls.push([root, path, route, method]);
      return { slides };
    }
  }
  const exports = {};
  new Function("require", "exports", ts.transpileModule(ipc, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText)(id => id === "../ppt-preview" ? { PptPreviewController: Preview } : {
    IPC: { invoke: { pptPreviewOpen: "open", pptPreviewRequest: "request" } },
  }, exports);
  exports.registerPptPreviewIpc({
    registrar: { handleWithEvent: (name, handler) => handlers.set(name, handler), assertMainWindowSender() {} },
    getWorkspaceRoot: async sessionId => roots[sessionId] ?? null,
  });
  const path = ".deckwise-ppt/projects/lesson";
  const input = { path, sessionId: "master", requireSlide: true };
  assert.equal(await handlers.get("open")(null, input), null);
  slides = [{ ok: false }, { ok: true }];
  assert.ok(await handlers.get("open")(null, input));
  await handlers.get("request")(null, { path, sessionId: "imported", route: "/api/slides" });
  await handlers.get("request")(null, { ...input, route: "/api/save-all", method: "POST" });
  assert.deepEqual(calls.at(-2), [roots.imported, path, "/api/slides", undefined]);
  assert.deepEqual(calls.at(-1), [roots.master, path, "/api/save-all", "POST"]);
  await assert.rejects(handlers.get("request")(null, { path, route: "/api/slides" }), /unavailable/);
});

test("the courseware workspace exposes an in-app page preview action", () => {
  assert.match(panel, /coursewareWorkflow.previewPages/);
  assert.match(panel, /api\.pptPreviewOpen/);
  assert.match(panel, /svgEditorWorkPanelTab/);
  assert.match(skill, /opens it as soon as one valid slide is saved/);
});

test("native SVG requests stay inside the preview API allowlist", () => {
  assert.match(controller, /isAllowedPptPreviewRoute/);
  assert.match(controller, /\/api\/shutdown/);
  assert.match(controller, /route\.startsWith\("\/images\/"\)/);
  assert.match(controller, /SVG preview route is not allowed/);
  assert.match(controller, /if \(action === "edit" \|\| action === "undo"\) return method === "POST"/);
  assert.match(controller, /if \(annotationId\) return method === "DELETE"/);
});

test("slide image references pass the preview route allowlist", () => {
  const source = controller.slice(controller.indexOf("const API_ROUTES"), controller.indexOf("function samePath")).replace("export function", "function");
  const js = ts.transpileModule(`${source}\nglobalThis.check = isAllowedPptPreviewRoute;`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const context = {};
  runInNewContext(js, context);
  const check = context.check;
  assert.equal(check("/images/sun_hero.png", "GET"), true);
  assert.equal(check("/images/subfolder/sun_hero.png", "GET"), true);
  assert.equal(check(`/api/slide/${encodeURIComponent("01_封面_太阳系.svg")}`, "GET"), true);
  assert.equal(check("/images/../secret.txt", "GET"), false);
  assert.equal(check("/images/sun_hero.png", "POST"), false);
});

test("native SVG editor covers the original editing workflow", () => {
  for (const feature of ["promote_tspan", "/api/save-all", "/undo", "box: true", "svg-editor-annotation", "externalChange", "exitPreview"]) {
    assert.ok(editor.includes(feature), `missing editor behavior: ${feature}`);
  }
  assert.match(editor, /FORBID_TAGS: \["foreignObject"\]/);
  assert.match(editor, /hasExternalCssResource/);
});

test("SVG slide list has no empty thumbnails and selectable elements show a hover outline", () => {
  assert.doesNotMatch(editor, /svg-editor-thumb|padStart\(2, "0"\)/);
  assert.match(editorCss, /\.svg-editor-canvas \.svg-editor-selectable:hover\s*(?:,[^{]+)?\{[^}]*outline:\s*2px solid/);
});

test("ordinary readiness follows inspected output independently of the running turn", () => {
  assert.match(panel, /const path = referencedProject\(messages, sourcePath\)/);
  assert.match(panel, /readyPath = project\?\.pptxPath && !project.needsPptxRegeneration && !project.qualityIssue/);
  assert.match(panel, /onReady\?\.\(readyPath\)/);
  assert.doesNotMatch(panel, /42%|60%|88%/);
});
