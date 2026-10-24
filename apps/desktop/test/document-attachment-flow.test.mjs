import assert from "node:assert/strict";
import test from "node:test";
import { register } from "node:module";
import { readFile } from "node:fs/promises";

register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const { appendPromptFallbackPaths, stripPromptAttachmentReferences } =
  await import("../electron/main/prompt-attachments.ts");
const appStore = await readFile(new URL("../src/stores/app-store.ts", import.meta.url), "utf8");
const agentIpc = await readFile(new URL("../electron/main/ipc/agent-ipc.ts", import.meta.url), "utf8");
const sidecar = await readFile(new URL("../../../packages/agent-runtime/src/sidecar.ts", import.meta.url), "utf8");

test("document chips are sent through the structured parser instead of agent Read", () => {
  assert.doesNotMatch(appStore, /if \(reference\.token && kind !== "image"\) return \[\];/);
});

test("parsed document paths are removed from the model-facing prompt", () => {
  const document = {
    message: { kind: "file", name: "lesson.doc", ref: "/tmp/lesson.doc" },
    fallbackPath: "/tmp/lesson.doc",
    absolutePath: "/tmp/lesson.doc",
  };
  const prompt = stripPromptAttachmentReferences(
    "请根据 @/tmp/lesson.doc 生成课件",
    [document],
  );
  assert.equal(prompt, "请根据 生成课件");
  assert.equal(
    appendPromptFallbackPaths("请根据资料生成", []),
    "请根据资料生成",
  );
});

test("parsed document paths are not restored from persisted history", async () => {
  assert.match(agentIpc, /content: stripPromptAttachmentReferences\(promptContent, structuredDocuments\)/);
  const history = await readFile(new URL("../../../packages/agent-runtime/src/attachment-history.ts", import.meta.url), "utf8");
  assert.match(sidecar, /hydrateAttachmentHistory/);
  assert.match(history, /attachment.kind !== "file" \|\| !/);
  assert.match(history, /replaceAll\(reference, ""\)/);
});
