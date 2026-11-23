import { readStoreSource, readTranscriptSource, readMainSource } from "./helpers/source-contracts.mjs";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (path) =>
  readFile(new URL(`../${path}`, import.meta.url), "utf8");
const readRoot = (path) =>
  readFile(new URL(`../../../${path}`, import.meta.url), "utf8");

// The message_end projection (including the !event.message.error guard) lives
// in src/lib/session-transcript.ts since the native side-chat re-keying.
const readSessionTranscript = () => read("src/lib/session-transcript.ts");

test("provider failures stay in the transcript as structured assistant messages", async () => {
  const [runtime, store, main, sessionTranscript] = await Promise.all([
    readRoot("packages/agent-runtime/src/runtime.ts"),
    readStoreSource(),
    readMainSource(),
    readSessionTranscript(),
  ]);

  assert.match(runtime, /error:\s*classifiedError,\s*isError:\s*true/);
  assert.match(runtime, /m\.status === "error" \|\| m\.isError \|\| m\.error/);
  assert.match(sessionTranscript, /!event\.message\.error/);
  assert.match(store, /assistantErrorMessage\(event\.error\)/);
  assert.match(main, /failed && empty && !event\.message\.error/);
});

test("assistant error messages expose readable provider details and one Continue action", async () => {
  const transcript = await readTranscriptSource();
  const component = transcript.slice(
    transcript.indexOf("function AssistantErrorMessage"),
    transcript.indexOf("const TOOL_ACTION_KEYS"),
  );

  assert.match(component, /function AssistantErrorMessage/);
  assert.match(component, /aria-expanded=\{open\}/);
  assert.match(component, /error\.message/);
  assert.match(component, /message\.providerId/);
  assert.match(component, /message\.modelId/);
  assert.match(component, /copyErrorDetails/);
  assert.doesNotMatch(component, /retryLastPrompt/);
  assert.doesNotMatch(component, /error\.retriable/);
  assert.doesNotMatch(component, /errors\.action\.retry/);
  assert.match(component, /errors\.action\.continue/);
  assert.match(component, /chat\.continueCurrentTaskPrompt/);
  assert.match(component, /setSettingsTab\("agent"\)/);

// Issue #234: the localized NETWORK_ERROR summary cannot tell DNS from TLS from
// a dropped socket, so both failure surfaces render the transport errno next to
// the stable code.
test("network failures show the transport errno beside the error code", async () => {
  const [transcript, activityGroup] = await Promise.all([
    readTranscriptSource(),
    read("src/features/chat/transcript/ActivityGroup.tsx"),
  ]);
  const card = transcript.slice(
    transcript.indexOf("function AssistantErrorMessage"),
    transcript.indexOf("const TOOL_ACTION_KEYS"),
  );

  assert.match(card, /error\.details/);
  assert.match(card, /networkCode/);
  assert.match(activityGroup, /retryError\.networkCode/);
});
});

test("continue recovers the current courseware step from safe evidence only", async () => {
  const { default: ts } = await import("typescript");
  const file = await read("src/lib/courseware-error-continuation.ts");
  const exports = {};
  new Function("exports", ts.transpileModule(file, {compilerOptions:{module:ts.ModuleKind.CommonJS, target:ts.ScriptTarget.ES2022}}).outputText)(exports);
  const translate = (key, args) => [key, ...Object.values(args)].join(" ");
  const resume = (message, messages) => exports.coursewareErrorContinuation(message, messages, translate);
  for (const [toolName, field, context] of [
    ["courseware_media_prepare", "kind", "courseware_media_context"],
    ["courseware_media_assessments", "mode", 'courseware_media_assessments({"mode":"context"})'],
  ]) {
    const message = {id:"error", role:"assistant", error:{code:"TOOL_ARGUMENT_RETRY_EXHAUSTED", details:{
      toolName, issues:`- ${field}: private rejected value\n- root: anyOf`,
    }}};
    const prompt = resume(message, [message]);
    for (const text of [toolName, field, context]) assert(prompt.includes(text));
    assert(!prompt.includes("private rejected value"));
    assert.equal(resume(message, [message, {id:"next",role:"user"}]), null);
  }
  const message = {id:"400", role:"assistant", error:{code:"PROVIDER_ERROR", details:{providerStatus:400}}};
  const search = {role:"tool", toolName:"ToolSearch", toolArgs:{query:"courseware_scene_compile"}};
  assert.match(resume(message,[search,message]), /courseware_scene_compile.*HTTP 400/);
  for (const unrelated of [{role:"user"}, {role:"tool",toolName:"Read"}])
    assert.equal(resume(message, [search,unrelated,message]), undefined);
  assert.equal(resume(message,[message]), undefined);
});
