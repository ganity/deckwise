import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

const exports = {};
const source = await readFile(new URL("../../../packages/shared/src/courseware-editor.ts", import.meta.url), "utf8");
new Function("require", "exports", ts.transpileModule(source, { compilerOptions: {
  target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS,
} }).outputText)(() => ({}), exports);

test("attention cues reuse the fixed player's exact bounded audio-clock shapes", () => {
  const highlight = { id: "cue", atMs: 100, endMs: 900, effect: { type: "highlight", elementIds: ["object-a", "object-b"], color: "#ffaa00", style: "outline", opacity: 0.8 } };
  const spotlight = { ...highlight, effect: { type: "spotlight", elementId: "object-a", elementIds: ["object-b"], dimOpacity: 0.6 } };
  assert.equal(exports.isCoursewareAttentionCue(highlight), true);
  assert.equal(exports.isCoursewareAttentionCue(spotlight), true);
  const animation = { id: "motion", atMs: 0, endMs: 600, effect: { type: "element_animation", elementId: "object-a", effect: "fadeIn" } };
  assert.equal(exports.isCoursewareAttentionCue(animation), true);
  assert.equal(exports.isCoursewareAttentionCue({ ...animation, endMs: 5001 }), false);
  assert.equal(exports.isCoursewareAttentionCue({ ...animation, effect: { ...animation.effect, effect: "arbitrary" } }), false);
  assert.equal(exports.isCoursewareAttentionIntent({ type: "spotlight", objectIds: ["object-a"], animation: "pulse" }), true);
  assert.equal(exports.isCoursewareAttentionIntent({ type: "spotlight", objectIds: ["object-a"], animation: "arbitrary" }), false);
  for (const patch of [{ atMs: -1 }, { endMs: 100 }, { endMs: 3_600_001 }, { atMs: 1.5 }, { timeline: "other" },
    { effect: { type: "highlight", elementIds: [] } }, { effect: { type: "highlight", elementIds: ["object-a", "object-a"] } },
    { effect: { type: "highlight", elementIds: ["object-a"], nativeAnimation: true } },
    { effect: { type: "spotlight", elementId: "object-a", elementIds: ["object-a"] } }])
    assert.equal(exports.isCoursewareAttentionCue({ ...highlight, ...patch }), false);
});

const componentSource = await readFile(new URL("../src/components/workpanel/CoursewareTeachingEffects.tsx", import.meta.url), "utf8");
function controls(options = {}) {
  const state = [];
  let cursor = 0, tree, changes = [];
  const speech = { id: "speech", type: "speech", text: "Find the apple.", audioAssetId: "voice", pauseAfterMs: 500,
    visualCues: [{ id: "native-cue", atMs: 0, endMs: 100, effect: { type: "element_animation", elementId: "apple", effect: "fadeIn" } }] };
  const checkpoint = { id: "wait", type: "interaction_checkpoint", checkpointId: "wait", checkpointKind: "teacher_continue" };
  if (options.noAudio) delete speech.audioAssetId;
  const props = { view: { viewId: "view", pageId: "page", project: { taskType: options.taskType ?? "scene", pages: [{ pageId: "page", locked: !!options.locked,
    reviewState: options.unconfirmed ? "review" : "ready" }] }, teachingObjects: [
    { objectId: "apple", name: "Apple", aliases: [], status: options.stale ? "content_changed" : "mapped", effectTargetEligible: !options.unsupported },
    { objectId: "banana", name: "Banana", aliases: [], status: "mapped", effectTargetEligible: true },
  ] }, actions: [speech, checkpoint], disabled: !!options.disabled,
    onChange(next) { changes.push(next); props.actions = next; } };
  const component = {};
  new Function("require", "exports", ts.transpileModule(componentSource, { compilerOptions: {
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX,
  } }).outputText)(id => {
    if (id === "@pi-desktop/shared") return exports;
    if (id === "react") return { useState(initial) { const index = cursor++; if (!(index in state)) state[index] = initial;
      return [state[index], value => { state[index] = typeof value === "function" ? value(state[index]) : value; }]; } };
    if (id === "react-i18next") return { useTranslation: () => ({ t: key => key }) };
    assert.equal(id, "react/jsx-runtime"); return { jsx: (type, props) => ({ type, props }), jsxs: (type, props) => ({ type, props }) };
  }, component);
  const render = () => { cursor = 0; tree = component.CoursewareTeachingEffects(props); };
  const nodes = () => { const result = [], visit = value => { if (Array.isArray(value)) return value.forEach(visit);
    if (!value || typeof value !== "object") return; result.push(value); visit(value.props?.children); }; visit(tree); return result; };
  const named = (type, key) => nodes().find(node => node.type === type && node.props.children === "panel.pptEditor." + key);
  const inputFor = key => nodes().find(node => node.type === "label" && Array.isArray(node.props.children) && node.props.children[0] === "panel.pptEditor." + key).props.children[1];
  const selectObject = name => { const label = nodes().find(node => node.type === "label" && node.props.children?.includes(name));
    label.props.children[0].props.onChange({ target: { checked: true } }); render(); };
  const submit = () => { nodes().find(node => node.type === "form").props.onSubmit({ preventDefault() {} }); render(); };
  render();
  return { props, speech, checkpoint, changes, nodes, render, named, inputFor, selectObject, submit };
}

test("user adds, edits and removes multi-object attention cues without altering audio, waits or unrelated cues", () => {
  const f = controls();
  f.selectObject("Apple"); f.selectObject("Banana");
  assert.equal(f.named("button", "effectsAdd").props.disabled, false);
  f.submit();
  let actions = f.changes.at(-1), cue = actions[0].visualCues.at(-1);
  assert.equal(cue.effect.type, "highlight"); assert.deepEqual(cue.effect.elementIds, ["apple", "banana"]);
  assert.equal(cue.atMs, 0); assert.equal(cue.endMs, 1000);
  assert.equal(actions[0].audioAssetId, "voice"); assert.equal(actions[0].text, f.speech.text); assert.equal(actions[0].pauseAfterMs, 500);
  assert.deepEqual(actions[0].visualCues[0], f.speech.visualCues[0]); assert.deepEqual(actions[1], f.checkpoint);
  f.nodes().filter(n => n.type === "button" && n.props.children === "panel.pptEditor.effectsEdit").at(-1).props.onClick(); f.render();
  const effect = f.nodes().find(node => node.type === "select" && node.props.value === "highlight");
  effect.props.onChange({ target: { value: "spotlight" } }); f.render();
  f.inputFor("effectsStart").props.onChange({ target: { value: "200" } }); f.render();
  f.inputFor("effectsEnd").props.onChange({ target: { value: "900" } }); f.render();
  assert.equal(f.named("button", "effectsApply").props.disabled, false, "editing needs no approval checkbox");
  f.submit();
  const edited = f.changes.at(-1)[0].visualCues.at(-1);
  assert.equal(edited.id, cue.id); assert.equal(edited.atMs, 200); assert.equal(edited.endMs, 900);
  assert.deepEqual(edited.effect, { type: "spotlight", elementId: "apple", elementIds: ["banana"] });
  f.nodes().filter(n => n.type === "button" && n.props.children === "panel.pptEditor.effectsRemove").at(-1).props.onClick(); f.render();
  assert.deepEqual(f.changes.at(-1), [f.speech, f.checkpoint]);
});

test("locked, readonly, stale/unsupported targets, missing audio and invalid intervals cannot author a cue", () => {
  for (const options of [{ locked: true }, { disabled: true }, { noAudio: true }]) {
    const f = controls(options); f.selectObject("Apple"); f.submit();
    assert.equal(f.changes.length, 0);
    assert.equal(f.named("button", "effectsAdd").props.disabled, true);
  }
  for (const options of [{ stale: true }, { unsupported: true }]) {
    const f = controls(options);
    assert(!f.nodes().some(node => node.type === "label" && node.props.children?.includes("Apple")));
  }
  const f = controls(); f.selectObject("Apple");
  f.inputFor("effectsEnd").props.onChange({ target: { value: "0" } }); f.render(); f.submit();
  assert.equal(f.changes.length, 0);
  assert.equal(f.named("button", "effectsAdd").props.disabled, true);
});

test("ordinary and imported projects use the same form with saved-page object labels", () => {
  for (const taskType of ["plain", "import"]) {
    const f = controls({ taskType });
    f.props.view.teachingObjects[0].savedKind = "text";
    f.props.view.teachingObjects[0].savedIndex = 1;
    f.render();
    assert(f.nodes().some(node => node.type === "label" && node.props.children?.includes("panel.pptEditor.effectsObjectText")));
    assert(f.nodes().some(node => node.type === "p" && node.props.children === "panel.pptEditor.effectsSavedObjectsScope"));
    f.selectObject("panel.pptEditor.effectsObjectText"); f.submit();
    const cue = f.changes.at(-1)[0].visualCues.at(-1);
    assert.deepEqual(cue.effect, { type: "highlight", elementIds: ["apple"] });
    assert.equal(f.changes.at(-1)[0].audioAssetId, "voice");
    assert.deepEqual(f.changes.at(-1)[1], f.checkpoint);
  }
});

test("object animations can be edited but cannot exceed five seconds or duplicate a page target", () => {
  const f = controls();
  f.named("button", "effectsEdit").props.onClick(); f.render();
  const kind = f.nodes().find(n => n.type === "select" && n.props.value === "fadeIn");
  assert(kind, "motion must not be mislabeled as spotlight");
  kind.props.onChange({ target: { value: "pulse" } }); f.render(); f.submit();
  assert.equal(f.changes.at(-1)[0].visualCues[0].effect.effect, "pulse");
  f.named("button", "effectsEdit").props.onClick(); f.render();
  f.inputFor("effectsEnd").props.onChange({ target: { value: "5001" } }); f.render(); f.submit();
  assert.equal(f.changes.length, 1);
  f.named("button", "effectsCancel").props.onClick(); f.render();
  f.selectObject("Apple"); f.submit();
  assert.equal(f.changes.length, 1, "cannot animate one object twice");
});


test("legacy unconfirmed pages can edit cues without page or effect approval", () => {
  const f = controls({ unconfirmed: true });
  assert(!f.nodes().some(node => node.type === "input" && node.props.type === "checkbox" && node.props.checked === undefined));
  f.selectObject("Apple");
  assert.equal(f.named("button", "effectsAdd").props.disabled, false);
  f.submit();
  assert.equal(f.changes.length, 1);
});
