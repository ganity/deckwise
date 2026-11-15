import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import test from "node:test";
import ts from "typescript";

const source = readFileSync(
  new URL("../electron/main/editor-resource-path.ts", import.meta.url),
  "utf8",
);
const module = { exports: {} };
new Function(
  "require",
  "exports",
  "module",
  ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS },
  }).outputText,
)(createRequire(import.meta.url), module.exports, module);
const { editorResourcePath } = module.exports;

test("bundled editor paths stay under the installation resource root", () => {
  const root = resolve("editor-test-resources");
  assert.equal(
    editorResourcePath(root, "/editor"),
    resolve(root, "editor.html"),
  );
  assert.equal(
    editorResourcePath(root, "/fonts/English%20Font.bin"),
    resolve(root, "fonts/English Font.bin"),
  );
  for (const path of [
    "/../secret",
    "/%2e%2e/secret",
    "/%2e/secret",
    "/a%5c..%5csecret",
    "/%00",
    "/%zz",
    "relative",
  ])
    assert.equal(editorResourcePath(root, path), null, path);
});
