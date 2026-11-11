import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { register } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import test from "node:test";

const here = dirname(fileURLToPath(import.meta.url));
register(pathToFileURL(join(here, "helpers/ts-import-hooks.mjs")));
const { importCoursewarePptx } = await import("../electron/main/courseware-import-file.ts");
const fixture = join(here, "../../../packages/courseware-runtime/tests/fixtures/office-lineage-b7/source.pptx");

test("an imported PPTX becomes a distinct editable workspace copy", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "deckwise-import-"));
  try {
    const path = await importCoursewarePptx(workspace, fixture);
    assert.ok(path.startsWith(join(await realpath(workspace), ".deckwise-ppt", "imports")));
    assert.deepEqual(await readFile(path), await readFile(fixture));
    assert.notEqual(path, fixture);
    await writeFile(path, "changed");
    assert.notDeepEqual(await readFile(path), await readFile(fixture));
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("imports into a canonical workspace reached through a directory alias", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "deckwise-import-alias-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workspace = join(root, "actual");
  const alias = join(root, "alias");
  await mkdir(workspace);
  await symlink(workspace, alias, process.platform === "win32" ? "junction" : "dir");
  const imported = await importCoursewarePptx(alias, fixture);
  assert.ok(imported.startsWith(join(await realpath(workspace), ".deckwise-ppt", "imports")));
  assert.deepEqual(await readFile(imported), await readFile(fixture));
});

test("rejects an import directory redirected outside the workspace", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "deckwise-import-escape-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workspace = join(root, "workspace");
  const outside = join(root, "outside");
  await mkdir(workspace);
  await mkdir(outside);
  await symlink(outside, join(workspace, ".deckwise-ppt"), process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(importCoursewarePptx(workspace, fixture), /课件导入目录/);
});

test("a non-PPTX selection cannot enter the editor import path", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "deckwise-import-"));
  try {
    await assert.rejects(importCoursewarePptx(workspace, "/tmp/sample.pdf"), /请选择 PPTX/);
    const invalid = join(workspace, "fake.pptx");
    await writeFile(invalid, "not a presentation");
    await assert.rejects(importCoursewarePptx(workspace, invalid), /Invalid PPTX/);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});
