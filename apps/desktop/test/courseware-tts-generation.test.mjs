import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import test from "node:test";
import ts from "typescript";

const require = createRequire(import.meta.url);
const source = await readFile(new URL("../src/components/workpanel/CoursewareTtsTasks.tsx", import.meta.url), "utf8");
const compiled = ts.transpileModule(source, { compilerOptions: {
  target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX,
} }).outputText;
function harness() {
  let index = 0, tree, subscriber;
  const slots = [], calls = [];
  const quote = { quoteId: "quote-1", intentId: "intent-1", model: "tts", voice: null, maxPoints: 5, expiresAt: "2099-01-01T00:00:00Z" };
  const prepared = { intentId: "intent-1", pageId: "page-1", actionId: "speech-1", model: "tts", voice: null, phase: "prepared", current: true, task: null };
  let loseReceipt = false;
  const api = {
    onAuthChanged(fn) { subscriber = fn; return () => {}; },
    async pptEditorTtsModels() { calls.push("models"); return [{ model: "tts", voices: ["teacher"], providerDefaultVoice: true }]; },
    async pptEditorTtsPrepare(...args) { calls.push(["prepare", ...args]); return prepared; },
    async pptEditorTtsQuote(...args) { calls.push(["quote", ...args]); return quote; },
    async pptEditorTtsSubmitConfirmed(...args) { calls.push(["submit", ...args]); if (loseReceipt) throw new Error("receipt lost"); return { ...prepared, phase: "submitted" }; },
    async pptEditorTtsList() { calls.push("list"); return [{ ...prepared, phase: "submission-unknown" }]; },
    async pptEditorTtsArchive() { calls.push("archive"); return { durationMs: 2000 }; },
    async pptEditorTtsAdopt(...args) { calls.push(["adopt", ...args]); return { ...props.view, project: { ...props.view.project,
      teachingRevision: "review-new", pages: [{ ...props.view.project.pages[0], reviewState: "review" }] } }; },
  };
  const mod = { exports: {} };
  new Function("require", "exports", compiled)((id) => {
    if (id === "react/jsx-runtime") return require(id);
    if (id === "react-i18next") return { useTranslation: () => ({ t: key => key }) };
    if (id === "../../lib/api") return { api };
    if (id === "react") return {
      useState(initial) { const i = index++; if (!(i in slots)) slots[i] = initial; return [slots[i], value => { slots[i] = typeof value === "function" ? value(slots[i]) : value; }]; },
      useRef(initial) { const i = index++; return slots[i] ??= { current: initial }; },
      useEffect(effect, deps) { const i = index++; if (!slots[i] || deps.some((dep, j) => dep !== slots[i][j])) { slots[i] = deps; effect(); } },
    };
    throw new Error(id);
  }, mod.exports);
  const props = { enabled: true, onActiveChange() {}, onAdopt(next) { calls.push(["adopted", next]); }, view: { viewId: "view-1", pageId: "page-1", project: {
    teachingRevision: "rev-1", pages: [{ pageId: "page-1", locked: false, actions: [{ type: "speech", id: "speech-1", text: "Good job!" }] }],
  } } };
  const render = () => { index = 0; tree = mod.exports.CoursewareTtsTasks(props); };
  function nodes(node = tree) {
    if (!node || typeof node !== "object") return [];
    return [node, ...[node.props?.children].flat(Infinity).flatMap(child => child === undefined ? [] : nodes(child))];
  }
  const button = key => nodes().find(n => n.type === "button" && n.props.children === `panel.pptEditor.${key}`);
  async function click(key) { const b = button(key); assert(b && !b.props.disabled, key); b.props.onClick(); await new Promise(resolve => setImmediate(resolve)); render(); }
  function select(label, value) { const node = nodes().find(n => n.type === "label" && n.props.children?.[0] === `panel.pptEditor.${label}`); node.props.children[1].props.onChange({ target: { value } }); render(); }
  function checkFee() { nodes().find(n => n.type === "input" && n.props.type === "checkbox").props.onChange({ target: { checked: true } }); render(); }
  render(); render();
  return { api, calls, button, click, select, checkFee, render, nodes, props, logout() { subscriber(); render(); }, loseReceipt() { loseReceipt = true; } };
}
async function quote(f) {
  await f.click("ttsLoadModels");
  f.select("ttsSegment", "speech-1"); f.select("ttsModel", "tts");
  await f.click("ttsGetQuote");
}
test("narration UI requires quote and explicit fee confirmation, then uses confirmed submit", async () => {
  const f = harness(); await quote(f);
  assert.equal(f.button("ttsSubmitPaid").props.disabled, true);
  assert(!f.calls.some(call => call[0] === "submit"));
  f.checkFee(); await f.click("ttsSubmitPaid");
  assert.deepEqual(f.calls.find(call => call[0] === "submit"), ["submit", "view-1", "rev-1", "intent-1", "quote-1"]);
  assert.equal(f.button("ttsSubmitPaid"), undefined);
});
test("voice changes and sign-out invalidate displayed confirmation", async () => {
  const f = harness(); await quote(f); f.checkFee();
  f.select("ttsVoiceLabel", "teacher");
  assert.equal(f.button("ttsSubmitPaid"), undefined);
  await f.click("ttsGetQuote"); f.logout();
  assert.equal(f.button("ttsSubmitPaid"), undefined);
});
test("lost submission receipt refreshes existing journal instead of generating again", async () => {
  const f = harness(); await quote(f); f.checkFee(); f.loseReceipt();
  await f.click("ttsSubmitPaid");
  assert.equal(f.calls.filter(call => call[0] === "submit").length, 1);
  assert(f.calls.includes("list"));
  assert(f.nodes().some(n => n.props?.role === "alert"));
  assert.equal(f.button("ttsSubmitPaid"), undefined);
});

test("an unconfigured audio service explains the empty catalogue and cannot offer paid generation", async () => {
  const f = harness(); f.api.pptEditorTtsModels = async () => [];
  await f.click("ttsLoadModels");
  assert(f.nodes().some(node => node.props?.role === "alert"));
  assert.equal(f.button("ttsGetQuote").props.disabled, true);
  assert.equal(f.button("ttsSubmitPaid"), undefined);
});

test("revoice with retained visual cues explicitly requires timing review before page confirmation", async () => {
  const f = harness();
  f.props.view.project.pages[0].actions[0].visualCues = [
    { id: "old-highlight", atMs: 100, endMs: 300, effect: { type: "highlight", elementIds: ["square"] } },
    { id: "old-spotlight", atMs: 400, endMs: 800, effect: { type: "spotlight", elementId: "square" } },
  ];
  await quote(f); f.checkFee(); await f.click("ttsSubmitPaid"); await f.click("ttsArchive");
  const label = f.nodes().find(n => n.type === "label" && n.props.children?.[1] === "panel.pptEditor.ttsConfirmCueReview");
  assert(label, "existing timed cues need the explicit review acknowledgement");
  assert.equal(f.button("ttsAdopt").props.disabled, true);
  assert(!f.calls.some(call => Array.isArray(call) && call[0] === "adopt"));
  label.props.children[0].props.onChange({ target: { checked: true } }); f.render();
  await f.click("ttsAdopt");
  const next = f.calls.find(call => Array.isArray(call) && call[0] === "adopted")[1];
  assert.equal(next.project.pages[0].reviewState, "review");
  assert.deepEqual(next.project.pages[0].actions[0].visualCues, f.props.view.project.pages[0].actions[0].visualCues);
});

test("definite TTS refusal displays terminal guidance and offers another quote without auto-submitting", async () => {
  const f = harness(); await quote(f); f.checkFee();
  f.api.pptEditorTtsSubmitConfirmed = async () => ({ intentId: "intent-1", pageId: "page-1", actionId: "speech-1",
    model: "tts", voice: null, phase: "rejected", current: true, task: null });
  await f.click("ttsSubmitPaid");
  assert(f.nodes().some(node => node.props?.children === "panel.pptEditor.ttsPhase.rejected"));
  assert.equal(f.button("ttsSubmitPaid"), undefined);
  assert.equal(f.button("ttsGetQuote").props.disabled, false);
  assert.equal(f.button("ttsCheck").props.disabled, true);
  assert(!f.calls.some(call => Array.isArray(call) && call[0] === "submit"));
});
