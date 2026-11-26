import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { resolve, join } from "node:path";
import { lstat, readFile, realpath, writeFile } from "node:fs/promises";
import { maicSidebarSource, maicTeachingFlowSource, maicEmbedSource } from "./wiseoffice-maic-sidebar.mjs";
import { sourceIdentity } from "./courseware-release-inputs.mjs";

const [source, destination, mode] = process.argv.slice(2);
assert(source && destination && (mode === undefined || mode === "--docs-native"),
  "Usage: build-wiseoffice-maic.mjs <WiseOffice source> <new build directory> [--docs-native]");
const online = mode === "--docs-native";
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
  configFile: false, root, base: "./", publicDir: online ? false : join(root, "public"),
  define: online ? { __WISEOFFICE_DOCS_NATIVE__: "true", "process.env.NODE_ENV": '"production"' } : undefined,
  esbuild: { jsx: "automatic" },
  resolve: { alias: [{ find: "deckwise-quiz-live", replacement: fileURLToPath(new URL("./wiseoffice-quiz-live.mjs", import.meta.url)) }, { find: "deckwise-native-assessment", replacement: fileURLToPath(new URL("../apps/desktop/src/components/workpanel/mount-native-assessment.tsx", import.meta.url)) }, { find: "@", replacement: root }, ...workspaceSourceAliases(root)] },
  plugins: [{ name: "deckwise-maic-content-editor", enforce: "pre", transform(code, id) {
    // Windows Document checkouts may use CRLF; integration templates use LF.
    code = code.replaceAll("\r\n", "\n");
    if (id === join(root, "lib/embed-api.ts").replaceAll("\\", "/")) {
      applied.add("embed"); return { code: maicEmbedSource(code), map: null };
    }
    if (id === join(root, "lib/deckwise-teaching-sidebar.ts").replaceAll("\\", "/")) {
      applied.add("sidebar"); return { code: maicSidebarSource(code, online), map: null };
    }
    if (id === join(root, "lib/deckwise-teaching-flow.ts").replaceAll("\\", "/")) {
      applied.add("flow"); return { code: maicTeachingFlowSource(code), map: null };
    }
  } }],
  build: online
    ? { outDir, lib: { entry: join(root, "lib/docs-native-teaching-entry.ts"), name: "WiseOfficeTeaching",
        formats: ["iife"], fileName: () => "wiseoffice-teaching.js" } }
    : { outDir, rollupOptions: { input: join(root, "module.html") } },
});
assert.deepEqual([...applied].sort(), online ? ["flow", "sidebar"] : ["embed", "flow", "sidebar"],
  "MAIC sidebar integration was not applied");
if (online) {
  const { build: buildPreview } = await import("../packages/courseware-runtime/node_modules/esbuild/lib/main.js");
  await buildPreview({
    entryPoints: [join(desktopRoot, "packages/courseware-runtime/src/teaching-preview.ts")],
    outfile: join(outDir, "deckwise-runtime/teaching-preview.mjs"),
    bundle: true, platform: "browser", format: "esm", target: "chrome130",
    define: { "process.env": "{}" },
  });
} else {
  const html = join(outDir, "module.html");
  await writeFile(html, secureEditorHtml(await readFile(html, "utf8")));
}
assert.deepEqual(sourceIdentity(root), documentSource, "Document source state changed during integration build");
assert.deepEqual(sourceIdentity(desktopRoot), desktopSource, "Desktop source state changed during integration build");
await writeFile(join(outDir, "deckwise-maic-integration.json"), JSON.stringify({ version: 1, contentEditor: "maic", nativeCheckpointEditor: "native-teaching",
  ...documentSource, desktopCommit: desktopSource.commit, desktopDirty: desktopSource.dirty }));
