import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { verifyInventory } from "./courseware-release-inputs.mjs";

if (process.argv[2] === "--check") {
  assert(process.argv.length === 4, "Usage: stage-wiseoffice.mjs --check <staged bundle>");
  const checked = await verifyInventory(resolve(process.argv[3]), "deckwise-bundle.json");
  assert(checked.manifest.version === 1 && checked.manifest.contentEditor === "maic", "Invalid WiseOffice receipt");
  console.log(JSON.stringify({ status: "VERIFIED", sha256: checked.sha256, files: checked.manifest.files.length }));
  process.exit(0);
}

const [sourceArgument, destinationArgument] = process.argv.slice(2);
assert(
  sourceArgument,
  "Usage: stage-wiseoffice.mjs <WiseOffice production build> [new destination]",
);
const source = await realpath(resolve(sourceArgument));
const destination = resolve(
  destinationArgument ||
    fileURLToPath(
      new URL("../apps/desktop/resources/wiseoffice", import.meta.url),
    ),
);
assert(
  !destination.startsWith(source + "/"),
  "Destination must be outside the source",
);
await assert.rejects(
  lstat(destination),
  { code: "ENOENT" },
  "Destination already exists; keep the previous bundle intact",
);
const entry = await lstat(join(source, "module.html")).then(() => "module.html", () => "editor.html");
for (const name of [
  entry,
  "sdkjs/slide/sdk-all-min.js",
  "web-apps/apps/presentationeditor/main/index.html",
  "sdkjs/common/wasm/x2t/x2t.wasm.br",
])
  assert(
    (await lstat(join(source, name))).isFile(),
    `Missing editor resource: ${name}`,
  );

const files = [];
async function inventory(directory, prefix = "") {
  for (const entry of (await readdir(directory, { withFileTypes: true })).sort(
    (a, b) => a.name.localeCompare(b.name),
  )) {
    assert(!entry.isSymbolicLink(), `Symlink is not allowed: ${entry.name}`);
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) await inventory(join(directory, entry.name), path);
    else {
      assert(entry.isFile(), `Unsupported resource: ${path}`);
      const bytes = await readFile(join(directory, entry.name));
      files.push({
        path,
        bytes: bytes.length,
        sha256: createHash("sha256").update(bytes).digest("hex"),
      });
    }
  }
}
await inventory(source);
files.length = 0;
const integration = await readFile(join(source, "deckwise-maic-integration.json"), "utf8").then(JSON.parse, error => {
  if (error.code !== "ENOENT") throw error;
  return null;
});
assert(integration?.version === 1 && integration.contentEditor === "maic" && integration.nativeCheckpointEditor === "native-teaching" &&
  /^[a-f0-9]{40}$/.test(integration.commit) && typeof integration.dirty === "boolean",
  "Build the MAIC editor integration with scripts/build-wiseoffice-maic.mjs before staging");
const { commit, dirty, desktopCommit, desktopDirty } = integration;
await mkdir(dirname(destination), { recursive: true });
const temporary = await mkdtemp(
  join(dirname(destination), ".wiseoffice-stage-"),
);
try {
  await cp(source, temporary, { recursive: true, dereference: false });
  // Bundle the same timing/geometry primitives used by the fixed player.
  const { build } = await import("../packages/courseware-runtime/node_modules/esbuild/lib/main.js");
  await build({
    entryPoints: [fileURLToPath(new URL("../packages/courseware-runtime/src/teaching-preview.ts", import.meta.url))],
    outfile: join(temporary, "deckwise-runtime/teaching-preview.mjs"),
    bundle: true, platform: "browser", format: "esm", target: "chrome130",
    define: { "process.env": "{}" },
  });
  await inventory(temporary);
  await writeFile(
    join(temporary, "deckwise-bundle.json"),
    JSON.stringify({ version: 1, commit, dirty, desktopCommit, desktopDirty, entry, contentEditor: integration.contentEditor, files }, null, 2),
  );
  await rename(temporary, destination);
} catch (error) {
  await rm(temporary, { recursive: true, force: true });
  throw error;
}
console.log(
  JSON.stringify({ destination, commit, dirty, files: files.length }),
);
