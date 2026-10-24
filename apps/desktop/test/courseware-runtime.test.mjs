import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
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
