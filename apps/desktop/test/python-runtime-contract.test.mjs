import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (path) => readFile(new URL(path, import.meta.url), "utf8");
const [resolver, host, skill, shell, tools, builder, packageJson] = await Promise.all([
  read("../electron/main/python-runtime.ts"),
  read("../electron/main/host-process.ts"),
  read("../electron/main/builtin-skills.ts"),
  read("../../../crates/host-core/src/tools/shell.rs"),
  read("../../../crates/host-core/src/tools/mod.rs"),
  read("../runtime/python/build-runtime.mjs"),
  read("../package.json").then(JSON.parse),
]);

test("the bundled Python runtime is first on every PPT Master command PATH", () => {
  assert.match(resolver, /DECKWISE_RUNTIME_BIN/);
  assert.match(resolver, /DECKWISE_PYTHON/);
  assert.match(host, /bundledPythonEnvironment/);
  assert.match(shell, /pub fn tool_env_path/);
  assert.match(shell, /DECKWISE_RUNTIME_BIN/);
  assert.match(tools, /env_path: shell::tool_env_path\(\)/);
  assert.match(skill, /resolveBundledPython/);
});

test("release scripts stage a pinned runtime for every supported desktop target", () => {
  for (const target of ["win-x64", "mac-x64", "mac-arm64", "linux-x64", "linux-arm64"]) {
    assert.ok(builder.includes(`"${target}"`), `missing runtime target ${target}`);
  }
  assert.match(builder, /Python archive checksum mismatch/);
  assert.match(builder, /attribution_guard\.py/);
  assert.match(builder, /Refusing unsafe output directory/);
  assert.doesNotMatch(builder, /PyMuPDF|pymupdf==|fitz==/i);
  assert.ok(
    packageJson.build.extraResources.some(
      (entry) => entry.from === "dist/runtime/current" && entry.to === "runtime",
    ),
  );
});
