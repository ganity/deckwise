import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import ts from "typescript";

const source = await readFile(new URL("../src/features/chat/composer/hooks/useComposerSubmit.ts", import.meta.url), "utf8");
const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;

function fixture({ ready = true, send = async () => false } = {}) {
  const values = [], restored = [], cleared = [], effects = [];
  const state = { activeSessionId: "chat" };
  let index = 0;
  const exports = {};
  new Function("require", "exports", compiled)(name => {
    if (name === "react") return {
      useState(initial) { const i = index++; values[i] = initial; return [initial, value => { values[i] = value; }]; },
      useRef: value => ({ current: value }), useEffect: effect => { effects.push(effect); },
    };
    if (name === "@pi-desktop/shared") return new Proxy({}, { get: () => text => text });
    if (name.endsWith("app-store")) return { useAppStore: { getState: () => state } };
    if (name.endsWith("composer-draft-cache")) return { draftKeyForSession: id => id };
    return {};
  }, exports);
  const attachments = [{ path: "lesson.docx" }];
  const controller = exports.useComposerSubmit({
    value: "Explain this lesson", draftKey: "chat", activeSessionId: "chat", modelReady: ready,
    sendBlocked: false, pasting: false, activeFileReferences: [], t: key => key,
    sendPrompt: send, steerPrompt: send, showToast() { assert.fail("submission errors must remain visible"); },
    draft: { ref: { current: null }, draftSnapshot: text => ({ text, fileReferences: attachments }),
      clearDraftForKey: key => cleared.push(key), restoreDraftForKey: (key, snapshot) => restored.push({ key, snapshot }) },
  });
  return { controller, values, restored, cleared, effects, attachments, state };
}

test("missing model remains visible without clearing text or attachments", async () => {
  const f = fixture({ ready: false, send: () => assert.fail("must not dispatch") });
  await f.controller.submit();
  assert.equal(f.values[0], "errors.MODEL_NOT_CONFIGURED");
  assert.deepEqual(f.cleared, []);
  f.controller.clearSubmissionError();
  assert.equal(f.values[0], null);
});

for (const steering of [false, true]) for (const throws of [false, true]) {
  test(`${steering ? "steer" : "send"} failure restores text and attachments (${throws ? "exception" : "rejection"})`, async () => {
    const f = fixture({ send: async () => { if (throws) throw new Error("Local document failed"); return false; } });
    await f.controller.submit(steering);
    assert.deepEqual(f.cleared, ["chat"]);
    assert.equal(f.restored[0].key, "chat");
    assert.equal(f.restored[0].snapshot.text, "Explain this lesson");
    assert.deepEqual(f.restored[0].snapshot.fileReferences, f.attachments);
    assert.equal(f.values[0], throws ? "Local document failed" : "coursewareWorkflow.sendFailed");
    f.effects[0]();
    assert.equal(f.values[0], null);
  });
}

test("late failure restores only the original draft without showing an error in another session", async () => {
  let fail;
  const f = fixture({ send: () => new Promise((_resolve, reject) => { fail = reject; }) });
  const pending = f.controller.submit();
  f.state.activeSessionId = "other";
  fail(new Error("Old send failed"));
  await pending;
  assert.equal(f.restored[0].key, "chat");
  assert.equal(f.values[0], null);
});

test("an accepted submission clears its draft without restoring it", async () => {
  const f = fixture({ send: async () => true });
  await f.controller.submit();
  assert.deepEqual(f.cleared, ["chat"]);
  assert.deepEqual(f.restored, []);
  assert.equal(f.values[0], null);
});
