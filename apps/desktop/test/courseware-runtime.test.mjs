import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import ts from "typescript";
import { coursewareAuthoringUrl, coursewareRuntimeEnvironment } from "../electron/main/courseware-runtime.ts";

test("optional worker discovery keeps existing boot and pins the Node executable", async () => {
  const directory = await mkdtemp(join(tmpdir(), "courseware-runtime-"));
  const previous = process.env.DECKWISE_PPTX_WORKER;
  try {
    const worker = join(directory, "pptx-worker.mjs");
    process.env.DECKWISE_PPTX_WORKER = worker;
    assert.deepEqual(coursewareRuntimeEnvironment(), {});
    assert.equal(coursewareAuthoringUrl(), undefined);
    await writeFile(worker, "// fixture");
    assert.deepEqual(coursewareRuntimeEnvironment(), {
      DECKWISE_PPTX_NODE: process.execPath,
      DECKWISE_PPTX_WORKER: worker,
    });
    assert.equal(coursewareAuthoringUrl(), undefined);
    const authoring = join(directory, "authoring.mjs"); await writeFile(authoring, "// fixture");
    assert.equal(coursewareAuthoringUrl(), pathToFileURL(authoring).href);
  } finally {
    if (previous === undefined) delete process.env.DECKWISE_PPTX_WORKER;
    else process.env.DECKWISE_PPTX_WORKER = previous;
    await rm(directory, { recursive: true, force: true });
  }
});

test("source launches discover staged resources; packaged resources and explicit overrides keep precedence", async t => {
  const root = await mkdtemp(join(tmpdir(), "courseware-source-runtime-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = await readFile(new URL("../electron/main/courseware-runtime.ts", import.meta.url), "utf8");
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText;
  const process = { env: {}, execPath: "/trusted/electron", resourcesPath: join(root, "installed") };
  const exports = {};
  new Function("require", "exports", "__dirname", "process", compiled)(name => {
    if (name === "node:fs") return { existsSync };
    if (name === "node:path") return { dirname, join };
    if (name === "node:url") return { pathToFileURL };
    assert.fail(name);
  }, exports, join(root, "out/main"), process);
  assert.deepEqual(exports.coursewareRuntimeEnvironment(), {});
  const staged = join(root, "resources/pptx-worker"), installed = join(root, "installed/pptx-worker");
  for (const directory of [staged, installed]) await mkdir(directory, { recursive: true });
  await writeFile(join(staged, "pptx-worker.mjs"), "// staged worker");
  await writeFile(join(staged, "authoring.mjs"), "// staged compiler");
  assert.equal(exports.coursewareRuntimeEnvironment().DECKWISE_PPTX_WORKER, join(staged, "pptx-worker.mjs"));
  assert.equal(exports.coursewareAuthoringUrl(), pathToFileURL(join(staged, "authoring.mjs")).href);
  await writeFile(join(installed, "pptx-worker.mjs"), "// installed worker");
  assert.equal(exports.coursewareRuntimeEnvironment().DECKWISE_PPTX_WORKER, join(installed, "pptx-worker.mjs"));
  process.env.DECKWISE_PPTX_WORKER = join(root, "missing-override.mjs");
  assert.deepEqual(exports.coursewareRuntimeEnvironment(), {});
});
