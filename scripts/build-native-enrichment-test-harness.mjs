import { createRequire } from "node:module";
import { dirname, resolve, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const { build } = createRequire(join(root, "packages/agent-runtime/package.json"))("esbuild");
if (!process.argv[2]) throw new Error("Provide the output .mjs path for the paired Document E2E test");
const files = { CoursewareNativeTools: "courseware-native-tools", CoursewareNativeAudio: "courseware-native-audio",
  CoursewareCandidateCoordinator: "courseware-candidates", adoptNativeMaterials: "courseware-native-materials" };
await build({ stdin: { contents: Object.entries(files).map(([name, file]) =>
  `export { ${name} } from ${JSON.stringify(join(root, "apps/desktop/electron/main", file + ".ts"))};`).join("\n"), resolveDir: root },
  outfile: resolve(process.argv[2]), bundle: true, platform: "node", format: "esm", packages: "external", plugins: [{ name: "native-enrichment-test", setup(b) {
    // Unrelated Electron rendering entry points are forbidden in this provider-free browser test.
    b.onResolve({ filter: /^\.\/courseware-(source-candidate|redo-candidate|style-batch-candidate|native-narration)$/ }, args => ({ path: args.path, namespace: "unrelated" }));
    b.onLoad({ filter: /.*/, namespace: "unrelated" }, () => ({ contents: 'export const stagePageFadeCandidate = () => { throw Error("Unexpected rendering in enrichment test") }; export const stagePageRedoCandidate = stagePageFadeCandidate; export const stagePageStyleBatchCandidate = stagePageFadeCandidate; export const generateNativeNarration = stagePageFadeCandidate;' }));
    b.onResolve({ filter: /^@pi-desktop\// }, args => ({ path: pathToFileURL(join(root, "packages", args.path.slice("@pi-desktop/".length).replace("/node", ""), "dist",
      args.path.endsWith("/node") ? "node.mjs" : "index.js")).href, external: true }));
    b.onResolve({ filter: /^\.\/courseware-runtime$/ }, () => ({ path: "runtime-url", namespace: "native-test" }));
    b.onLoad({ filter: /.*/, namespace: "native-test" }, () => ({ contents: `export const coursewareAuthoringUrl = () => ${JSON.stringify(pathToFileURL(join(root, "packages/courseware-runtime/dist/authoring.mjs")).href)};` }));
  } }] });
