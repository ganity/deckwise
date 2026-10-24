import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";
import { isCoursewareAttentionCue } from "@pi-desktop/shared";

const source = await readFile(new URL("../src/components/workpanel/CoursewareOnlineSourceReview.tsx", import.meta.url), "utf8");
const cue = (id, effect) => ({ id, atMs: 100, endMs: 900, effect });
function fixture() {
  const view = {
    viewId: "view-1", ownerId: "owner-1", original: { project: { pages: [
      { pageId: "old-a", locked: true, actions: [{ id: "speech", type: "speech", text: "Full narration preserved", pauseAfterMs: 400, audioAssetId: "team-audio", visualCues: [
        cue("highlight", { type: "highlight", elementIds: ["object-a", "object-b"], style: "glow", color: "#ff0000" }),
        cue("spotlight", { type: "spotlight", elementId: "object-a", elementIds: ["object-b"], dimOpacity: 0.7 }),
      ] }] },
      { pageId: "old-b", locked: false, actions: [{ id: "music", type: "audio_clip", audioAssetId: "music-asset" }, { id: "checkpoint", type: "interaction_checkpoint" }] },
    ] } },
    previousPages: [
      { pageId: "old-a", pageNumber: 1, objects: [{ objectId: "object-a", index: 1, kind: "text" }, { objectId: "object-b", index: 2, kind: "shape" }] },
      { pageId: "old-b", pageNumber: 2, objects: [] },
    ],
    targetPages: [
      { importPageId: "new-a", pageNumber: 1, objects: [{ importElementId: "target-a", index: 1, kind: "shape" }, { importElementId: "target-b", index: 2, kind: "image" }, { importElementId: "line", index: 3, kind: "line" }] },
      { importPageId: "new-b", pageNumber: 2, objects: [] },
    ],
  };
  const states = [], refs = [], deps = [], pending = [], calls = []; let cursor = 0, tree;
  const props = { view, disabled: false, onConfirm: decisions => calls.push(structuredClone(decisions)), onCancel() { calls.push("cancel"); } };
  const exports = {};
  new Function("require", "exports", ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText)(id => {
    if (id === "react") return {
      useState(initial) { const i = cursor++; if (!(i in states)) states[i] = typeof initial === "function" ? initial() : initial;
        return [states[i], next => { states[i] = typeof next === "function" ? next(states[i]) : next; }]; },
      useRef(initial) { const i = cursor++; return refs[i] ??= { current: initial }; },
      useEffect(callback, nextDeps) { const i = cursor++; if (!deps[i] || nextDeps.some((value, index) => value !== deps[i][index])) { deps[i] = nextDeps; pending.push(callback); } },
    };
    if (id === "react-i18next") return { useTranslation: () => ({ t: (key, values) => key + (values ? JSON.stringify(values) : "") }) };
    if (id === "@pi-desktop/shared") return { isCoursewareAttentionCue };
    assert.equal(id, "react/jsx-runtime"); return { jsx: (type, props) => ({ type, props }), jsxs: (type, props) => ({ type, props }) };
  }, exports);
  const render = () => { cursor = 0; tree = exports.CoursewareOnlineSourceReview(props); while (pending.length) pending.shift()(); };
  const nodes = (root = tree) => { const result = []; const visit = value => { if (Array.isArray(value)) return value.forEach(visit);
    if (!value || typeof value !== "object") return; result.push(value); visit(value.props?.children); }; visit(root); return result; };
  const text = node => typeof node?.props?.children === "string" ? node.props.children : "";
  const fieldsets = prefix => nodes().filter(node => node.type === "fieldset" && nodes(node).some(child => child.type === "legend" && text(child).startsWith(prefix)));
  const pages = () => fieldsets("panel.onlineSource.targetPage");
  const cues = () => nodes().filter(node => node.type === "fieldset" && node.props.children?.[0]?.type === "legend" && text(node.props.children[0]).startsWith("panel.pptEditor.effectsCue"));
  const change = (node, value) => { node.props.onChange({ target: { value, checked: value } }); render(); };
  const page = (index, value) => change(nodes(pages()[index]).find(node => node.type === "select"), value);
  const cueChoice = (index, object, decision, target) => {
    let labels = nodes(cues()[index]).filter(node => node.type === "label");
    change(nodes(labels.find(node => String(node.props.children[0]).startsWith("panel.onlineSource.targetDecision") && String(node.props.children[0]).includes(`\\\"number\\\":${object}`))).find(node => node.type === "select"), decision);
    if (target) {
      labels = nodes(cues()[index]).filter(node => node.type === "label");
      change(nodes(labels.find(node => String(node.props.children[0]).startsWith("panel.onlineSource.targetObject") && String(node.props.children[0]).includes(`\\\"number\\\":${object}`))).find(node => node.type === "select"), target);
    }
  };
  const check = (key, checked = true, root) => change(nodes(root).find(node => node.type === "label" && String(node.props.children.at?.(-1)).startsWith(key)).props.children.find(node => node?.type === "input"), checked);
  const confirm = () => nodes().find(node => node.type === "button" && text(node) === "panel.onlineSource.confirm");
  const ready = index => check("panel.onlineSource.ready", true, pages()[index]);
  const complete = () => { page(0, "old-a"); page(1, "old-b"); for (let i = 0; i < 2; i++) { cueChoice(i, 1, "keep", "target-a"); cueChoice(i, 2, "keep", "target-b"); } };
  render(); render();
  return { props, view, calls, nodes, pages, cues, page, cueChoice, check, confirm, ready, complete, render, change };
}

test("no page, cue, deletion or ready choices are defaulted; retained teaching is fully visible", () => {
  const f = fixture();
  assert(f.nodes().filter(node => node.type === "select").every(node => node.props.value === ""));
  assert(f.nodes().filter(node => node.type === "input").every(node => !node.props.checked));
  assert(f.confirm().props.disabled);
  const content = JSON.stringify(f.nodes());
  assert(content.includes("Full narration preserved") && content.includes("team-audio") && content.includes("music-asset"));
  assert(content.includes("candidatePause") && content.includes("candidateTeacherContinue") && content.includes('\\"start\\":100'));
  const locked = f.nodes().find(node => node.type === "label" && String(node.props.children.at?.(-1)).startsWith("panel.onlineSource.lockedPage"));
  assert(locked.props.children[0].props.disabled);
});

test("explicit associations preserve decisions, and pending review pages can be confirmed without publishing", () => {
  const f = fixture(), before = structuredClone(f.view); f.complete();
  assert.equal(f.confirm().props.disabled, false);
  assert(!f.nodes().some(node => node.type === "option" && node.props.value === "line"));
  f.confirm().props.onClick();
  const result = f.calls[0];
  assert.deepEqual(result.pages, [{ kind: "carry", targetImportPageId: "new-a", oldPageId: "old-a", confirmReady: false }, { kind: "carry", targetImportPageId: "new-b", oldPageId: "old-b", confirmReady: false }]);
  assert.deepEqual(result.removedPages, []);
  assert.equal(result.cues.length, 2);
  assert.deepEqual(result.cues[0], { oldPageId: "old-a", actionId: "speech", cueId: "highlight", deleteCue: false, targets: [{ decision: "keep", oldObjectId: "object-a", targetImportElementId: "target-a" }, { decision: "keep", oldObjectId: "object-b", targetImportElementId: "target-b" }] });
  assert.deepEqual(f.view, before);
});

test("each unused old page requires explicit deletion; locked pages and duplicate carry remain blocked", () => {
  const f = fixture(); f.complete(); f.page(1, "new");
  for (let i = 0; i < 2; i++) { f.cueChoice(i, 1, "keep", "target-a"); f.cueChoice(i, 2, "keep", "target-b"); }
  assert(f.confirm().props.disabled); f.check("panel.onlineSource.deletePage"); assert.equal(f.confirm().props.disabled, false);
  f.confirm().props.onClick(); assert.deepEqual(f.calls[0].removedPages, [{ oldPageId: "old-b", confirmDelete: true }]);
  f.page(0, "new"); assert(f.confirm().props.disabled);
  f.page(0, "old-a"); f.page(1, "old-a"); assert(f.confirm().props.disabled);
});

test("keep identity is globally consistent and injective; per-cue rebind can differ", () => {
  const f = fixture(); f.complete();
  f.cueChoice(1, 1, "keep", "target-b"); f.cueChoice(1, 2, "rebind", "target-a"); assert(f.confirm().props.disabled);
  f.cueChoice(1, 1, "rebind", "target-b"); assert.equal(f.confirm().props.disabled, false);
  f.cueChoice(0, 2, "keep", "target-a"); assert(f.confirm().props.disabled);
});

test("removing spotlight primary requires explicit whole-cue deletion and every target removal", () => {
  const f = fixture(); f.complete(); f.cueChoice(1, 1, "remove"); assert(f.confirm().props.disabled);
  let deletion = f.nodes(f.cues()[1]).find(node => node.type === "input"); assert(deletion.props.disabled);
  f.cueChoice(1, 2, "remove"); assert(f.confirm().props.disabled);
  f.check("panel.onlineSource.deleteCue", true, f.cues()[1]); assert.equal(f.confirm().props.disabled, false);
  f.confirm().props.onClick(); assert(f.calls[0].cues[1].deleteCue);
  assert(f.calls[0].cues[1].targets.every(target => target.decision === "remove"));
  f.cueChoice(1, 1, "keep", "target-a"); assert.equal(f.nodes(f.cues()[1]).find(node => node.type === "input").props.checked, false);
});

test("empty highlight needs explicit cue deletion; partial removal keeps a nonempty cue", () => {
  const f = fixture(); f.complete(); f.cueChoice(0, 1, "remove"); assert.equal(f.confirm().props.disabled, false);
  f.cueChoice(0, 2, "remove"); assert(f.confirm().props.disabled);
  f.check("panel.onlineSource.deleteCue", true, f.cues()[0]); assert.equal(f.confirm().props.disabled, false);
});

test("ready is per page, never inherited, and association changes invalidate affected review", () => {
  const f = fixture(); f.complete(); f.ready(0); f.ready(1); f.cueChoice(0, 1, "keep", "target-a");
  f.confirm().props.onClick(); assert.deepEqual(f.calls[0].pages.map(page => page.confirmReady), [false, true]);
  f.ready(0); f.page(1, "new");
  assert(f.nodes().filter(node => node.type === "input" && node.props.type === "checkbox").every(node => !node.props.checked));
});

test("disabled, stale render and replaced-owner callbacks cannot submit or mutate the new review", () => {
  const f = fixture(); f.complete(); const confirm = f.confirm().props.onClick;
  f.ready(0); confirm(); assert.equal(f.calls.length, 0, "old render cannot submit stale decisions");
  const disabledConfirm = f.confirm().props.onClick; f.props.disabled = true; f.render(); disabledConfirm(); assert.equal(f.calls.length, 0);
  f.props.disabled = false; f.render(); const oldConfirm = f.confirm().props.onClick;
  f.props.view = { ...f.view, viewId: "view-2", ownerId: "owner-2" }; f.render(); f.render(); oldConfirm(); assert.equal(f.calls.length, 0);
  assert(f.confirm().props.disabled); assert(f.nodes().filter(node => node.type === "select").every(node => node.props.value === ""));
});

test("missing old or unsupported new cue objects cannot be submitted", () => {
  const f = fixture(); f.complete(); f.view.previousPages[0].objects.shift(); f.render(); assert(f.confirm().props.disabled);
  const g = fixture(); g.complete(); g.view.targetPages[0].objects[0].kind = "line"; g.render(); assert(g.confirm().props.disabled);
});

test("preview uses supplied real PNG, hides raw failures and ignores old owner results", async () => {
  const f = fixture(); let resolve;
  f.props.onPreview = () => new Promise(done => { resolve = done; }); f.render();
  const button = () => f.nodes().find(node => node.type === "button" && String(node.props.children).startsWith("panel.onlineSource.preview"));
  button().props.onClick(); f.render();
  f.props.view = { ...f.view, ownerId: "other" }; f.render(); f.render();
  resolve("data:image/png;base64,iVBORw0KGgo="); await new Promise(done => setImmediate(done)); f.render();
  assert(!f.nodes().some(node => node.type === "img"));
  f.props.onPreview = async () => "https://private-token.invalid/preview"; f.render(); button().props.onClick();
  await new Promise(done => setImmediate(done)); f.render(); assert(!JSON.stringify(f.nodes()).includes("private-token"));
  assert(f.nodes().some(node => node.props?.role === "alert" && node.props.children === "panel.onlineSource.previewError"));
  f.props.onPreview = async () => "data:image/png;base64,iVBORw0KGgo="; f.render(); button().props.onClick();
  await new Promise(done => setImmediate(done)); f.render(); assert.equal(f.nodes().find(node => node.type === "img").props.src, "data:image/png;base64,iVBORw0KGgo=");
});

test("original page preview uses its own callback and labels the actual original page", async () => {
  const f=fixture(), calls=[];
  f.props.onOriginalPreview=async id=>{calls.push(id);return "data:image/png;base64,iVBORw0KGgo=";};f.render();
  const button=f.nodes().find(node=>node.type==="button" && String(node.props.children).startsWith("panel.onlineSource.previewOriginal"));
  button.props.onClick();await new Promise(resolve=>setImmediate(resolve));f.render();
  assert.deepEqual(calls,["old-a"]);
  assert.equal(f.nodes().find(node=>node.type==="img").props.alt,'panel.onlineSource.previewOriginal{"page":1}');
});
