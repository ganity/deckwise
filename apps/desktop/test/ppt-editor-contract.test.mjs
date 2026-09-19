import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (path) => readFile(new URL(path, import.meta.url), "utf8");
const [controller, host, component, protocol, vite, packageJson, hostProtocol] = await Promise.all([
  read("../electron/main/ppt-editor.ts"),
  read("../resources/editor-host/index.html"),
  read("../src/components/workpanel/PptEditorTab.tsx"),
  read("../../../packages/shared/src/protocol.ts"),
  read("../electron.vite.config.ts"),
  read("../package.json").then(JSON.parse),
  read("../electron/main/editor-host-protocol.ts"),
]);

test("PPTX editor is embedded and all normal escape routes are denied", () => {
  assert.match(controller, /setWindowOpenHandler\(\(\) => \(\{ action: "deny" \}\)\)/);
  assert.match(controller, /will-download/);
  assert.match(controller, /setPermissionRequestHandler/);
  assert.match(controller, /will-navigate/);
  assert.match(controller, /installEditorHostProtocol\(editorSession\.protocol\)/);
  assert.match(component, /pptEditorSetBounds/);
  assert.match(component, /pptEditorSetVisible/);
  assert.doesNotMatch(component, /edit\.chaxus\.com/);
});

test("editor host accepts messages only from the configured top-level editor frame", () => {
  assert.match(host, /event\.origin !== expectedOrigin/);
  assert.match(host, /event\.source !== editor\.contentWindow/);
  assert.match(host, /targetExt !== "PPTX"/);
  assert.match(host, /document:saved/);
});

test("editor host protocol delegates HTML loading to Electron's network stack", () => {
  assert.match(hostProtocol, /net\.fetch\(/);
  assert.match(hostProtocol, /pathToFileURL/);
  assert.doesNotMatch(hostProtocol, /new Response\(new Uint8Array\(html\)/);
});

test("editor archives revisions and replaces the original PPTX with stale-write protection", () => {
  assert.match(controller, /Revision conflict: expected/);
  assert.match(controller, /expectedRevision: current\.revision\.revision/);
  assert.match(controller, /\.deckwise-ppt\/revisions/);
  assert.match(controller, /sha256/);
  assert.match(controller, /replaceSourcePptx/);
  assert.match(controller, /current\.sourcePath/);
  assert.match(controller, /fs\.rename\(temporaryPath, sourcePath\)/);
});

test("editor preload and host page are both shipped", () => {
  assert.match(vite, /"editor-host".*electron\/preload\/editor-host\.ts/s);
  assert.match(protocol, /pptEditorOpen/);
  assert.match(protocol, /pptEditorState/);
  assert.ok(
    packageJson.build.extraResources.some(
      (entry) => entry.from === "resources/editor-host" && entry.to === "editor-host",
    ),
  );
});
