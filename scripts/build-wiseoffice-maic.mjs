import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { resolve, join } from "node:path";
import { lstat, readFile, realpath, writeFile } from "node:fs/promises";
import { maicSidebarSource, maicTeachingFlowSource, maicEmbedSource } from "./wiseoffice-maic-sidebar.mjs";
import { sourceIdentity } from "./courseware-release-inputs.mjs";

const [source, destination] = process.argv.slice(2);
assert(source && destination, "Usage: build-wiseoffice-maic.mjs <WiseOffice source> <new build directory>");
const root = await realpath(source), outDir = resolve(destination);
const desktopRoot = fileURLToPath(new URL("../", import.meta.url));
const desktopSource = sourceIdentity(desktopRoot), documentSource = sourceIdentity(root);
await assert.rejects(lstat(outDir), { code: "ENOENT" }, "Build destination must be new");
const requireSource = createRequire(join(root, "package.json"));
const { build } = await import(pathToFileURL(requireSource.resolve("vite")).href);
const { workspaceSourceAliases } = await import(pathToFileURL(join(root, "bin/workspace-aliases.mjs")).href);
const { secureEditorHtml } = await import(pathToFileURL(join(root, "bin/editor-csp.mjs")).href);
const applied = new Set();
await build({
  configFile: false, root, base: "./", publicDir: join(root, "public"),
  esbuild: { jsx: "automatic" },
  resolve: { alias: [{ find: "deckwise-quiz-live", replacement: fileURLToPath(new URL("./wiseoffice-quiz-live.mjs", import.meta.url)) }, { find: "deckwise-native-assessment", replacement: fileURLToPath(new URL("../apps/desktop/src/components/workpanel/mount-native-assessment.tsx", import.meta.url)) }, { find: "@", replacement: root }, ...workspaceSourceAliases(root)] },
  plugins: [{ name: "deckwise-maic-content-editor", enforce: "pre", transform(code, id) {
    if (id === join(root, "lib/embed-api.ts").replaceAll("\\", "/")) {
      applied.add("embed"); return { code: maicEmbedSource(code), map: null };
    }
    if (id === join(root, "lib/deckwise-teaching-sidebar.ts").replaceAll("\\", "/")) {
      applied.add("sidebar"); return { code: maicSidebarSource(code), map: null };
    }
    if (id === join(root, "lib/deckwise-teaching-flow.ts").replaceAll("\\", "/")) {
      applied.add("flow"); return { code: maicTeachingFlowSource(code), map: null };
    }
  } }],
  build: { outDir, rollupOptions: { input: join(root, "module.html") } },
});
assert.deepEqual([...applied].sort(), ["embed", "flow", "sidebar"], "MAIC sidebar integration was not applied");
const html = join(outDir, "module.html");
await writeFile(html, secureEditorHtml(await readFile(html, "utf8")));
assert.deepEqual(sourceIdentity(root), documentSource, "Document source state changed during integration build");
assert.deepEqual(sourceIdentity(desktopRoot), desktopSource, "Desktop source state changed during integration build");
await writeFile(join(outDir, "deckwise-maic-integration.json"), JSON.stringify({ version: 1, contentEditor: "maic", nativeCheckpointEditor: "native-teaching",
  ...documentSource, desktopCommit: desktopSource.commit, desktopDirty: desktopSource.dirty }));
