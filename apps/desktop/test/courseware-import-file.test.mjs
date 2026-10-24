import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
    assert.ok(path.startsWith(join(workspace, ".deckwise-ppt", "imports")));
    assert.deepEqual(await readFile(path), await readFile(fixture));
    assert.notEqual(path, fixture);
    await writeFile(path, "changed");
    assert.notDeepEqual(await readFile(path), await readFile(fixture));
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
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
