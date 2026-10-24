import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import test from "node:test";
import ts from "typescript";

const require = createRequire(import.meta.url);
const source = await readFile(new URL("../src/components/workpanel/CoursewareTeachingPanel.tsx", import.meta.url), "utf8");
const fixture = JSON.parse(await readFile(new URL("../../../packages/shared/src/courseware-contract.fixtures/accepted.json", import.meta.url), "utf8"));
const compiled = ts.transpileModule(source, { compilerOptions: {
  target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX,
} }).outputText;

function setup({ actions = [], changed = false, locked = false, enabled = true, instruction = "" } = {}) {
  const project = structuredClone(fixture.project), page = project.pages[0];
  page.actions = actions; page.locked = locked;
  const view = { viewId: "view", project, pageId: page.pageId, pageNumber: 1 };
  const states = [view, changed ? [{ id: "draft", type: "speech", text: "Unsaved" }] : actions];
  const updates = [], calls = [], scope = { viewId: "view", revision: null, serial: 0, failed: false };
  let cursor = 0;
  const History = () => null, exports = {};
  new Function("require", "exports", compiled)(id => {
    if (id === "react") return {
      useCallback: callback => callback, useEffect() {}, useRef: initial => ({ current: initial === null ? scope : initial }),
      useState: initial => { const index = cursor++; return [index < states.length ? states[index] :
        initial?.viewId === "" ? { viewId: "view", text: instruction } : initial, value => updates.push([index, value])]; },
    };
    if (id === "react/jsx-runtime") return require(id);
    if (id === "react-i18next") return { useTranslation: () => ({ t: key => key }) };
    if (id === "../../stores/app-store") return { useAppStore: select => select({ sendPrompt() {} }) };
    if (id === "../../lib/api") return { api: { async pptEditorTeachingDraftSet(...args) {
      calls.push(args); return { draft: { revision: "draft-revision" } };
    } } };
    if (id === "@pi-desktop/shared") return {};
    if (id === "./CoursewareTeachingHistory") return { CoursewareTeachingHistory: History };
    return new Proxy({}, { get: () => () => null });
  }, exports);
  const tree = exports.CoursewareTeachingPanel({ sessionId: "chat", enabled });
  const find = node => {
    if (!node || typeof node !== "object") return;
    if (node.type === History) return node;
    return [node.props?.children].flat(Infinity).map(find).find(Boolean);
  };
  return { history: find(tree), updates, calls, project };
}

test("deleted narration becomes an editable local draft before existing music without saving teaching", async () => {
  const music = { id: "music", type: "audio_clip", audioAssetId: "exported-music" };
  const f = setup({ actions: [music] }), before = structuredClone(f.project);
  assert.equal(f.history.props.disabled, false);
  const restored = [{ id: "fresh-speech", type: "speech", text: "Good!", pauseAfterMs: 1000 }];
  f.history.props.onRestore(restored);
  await Promise.resolve(); await Promise.resolve();
  assert.deepEqual(f.updates.find(([index]) => index === 1)[1], [...restored, music]);
  assert.deepEqual(f.calls, [["view", null, { actions: [...restored, music], instruction: "" }]]);
  assert.deepEqual(f.project, before);
});

for (const options of [{ actions: [{ id: "speech", type: "speech", text: "Keep existing" }] },
  { changed: true }, { locked: true }, { enabled: false }, { instruction: "Pending narration request" }])
  test(`history cannot overwrite teaching or drafts: ${JSON.stringify(options)}`, async () => {
    const f = setup(options), before = structuredClone(f.project);
    assert(f.history.props.disabled);
    f.history.props.onRestore([{ id: "fresh", type: "speech", text: "Recovered" }]);
    await Promise.resolve();
    assert.deepEqual(f.calls, []);
    assert.deepEqual(f.updates, []);
    assert.deepEqual(f.project, before);
  });
