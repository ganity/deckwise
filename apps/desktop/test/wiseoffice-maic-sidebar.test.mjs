import assert from "node:assert/strict";
import test from "node:test";
import { maicSidebarSource, maicCheckpointSource, maicTeachingFlowSource, maicEmbedSource } from "../../../scripts/wiseoffice-maic-sidebar.mjs";

test("native sidebar keeps the checkpoint step but delegates editing to MAIC content", () => {
  const before = `function render(action, card, element) {
      if (action.type === 'interaction_checkpoint' && action.checkpointKind === 'chapter_summary') {
        card.append(element('textarea', action.referenceAnswer.keyPoints.join('\\n')));
      }
      if (action.type === 'interaction_checkpoint' && action.checkpointKind === 'chapter_summary') {
        card.append(element('select', '题型'));
      }
      if (action.type === 'audio_clip' || action.type === 'video_clip') {
        card.append(element('button', 'play'));
      }
  }`;
  const code = maicCheckpointSource(before);
  const render = new Function("hasNativeTeaching", code + ";return render")(() => false);
  const nodes = [], card = { append: (...items) => nodes.push(...items) }, element = (tag, text) => ({ tag, text });
  render({ type: "interaction_checkpoint", checkpointKind: "chapter_summary", question: "Say hello" }, card, element);
  assert.deepEqual(nodes.map(node => node.tag), ["p", "p"]);
  assert.equal(nodes[0].text, "Say hello");
  assert.match(nodes[1].text, /右侧题目编辑/);
  const nativeNodes = [];
  const nativeRender = new Function("hasNativeTeaching", code + ";return render")(() => true);
  nativeRender({ type: "interaction_checkpoint", checkpointKind: "chapter_summary", referenceAnswer: { keyPoints: ["Native answer"] } },
    { append: (...nodes) => nativeNodes.push(...nodes) }, element);
  assert.deepEqual(nativeNodes.map(node => node.tag), ["textarea", "select"], "Native teaching keeps its own checkpoint editor");
  render({ type: "audio_clip" }, card, element);
  assert.deepEqual(nodes.at(-1), { tag: "button", text: "play" });
  assert.throws(() => maicSidebarSource("changed upstream source"), /rendering changed/);
});

test("native checkpoint title identifies the MAIC action and retains teacher pauses", () => {
  const code = maicTeachingFlowSource("return t(step.checkpointKind === 'chapter_summary' ? 'teachingExistingQuestion' : 'teachingTeacherPause');");
  const title = new Function("step", "t", code);
  assert.equal(title({ checkpointKind: "chapter_summary" }, value => value), "MAIC 课堂互动");
  assert.equal(title({ checkpointKind: "teacher_continue" }, value => value), "teachingTeacherPause");
  assert.throws(() => maicTeachingFlowSource("changed upstream source"), /title changed/);
});


test("native UI adapter restores one-based page selection without persisting it as a preference", () => {
  const source = "if (Object.keys(payload).some(key => !['theme', 'teachingOpen'].includes(key))) throw Error();\n        moduleUi = { ...moduleUi, ...payload };";
  const code = maicEmbedSource(source).replace(/^import[^\n]+\n/gm, '').replace(' as any', '');
  let page, moduleUi = { theme: 'dark' };
  const apply = new Function('payload', 'maicEditorApi', 'moduleUi', code + ';return moduleUi;');
  const api = () => ({WordControl:{m_oLogicDocument:{Slides:[{},{}]}},goToPage:value=>{page=value;}});
  moduleUi = apply({page:2}, api, moduleUi);
  assert.equal(page,1); assert.deepEqual(moduleUi,{theme:'dark'});
  for (const page of [0,3,1.5,'2']) assert.throws(()=>apply({page},api,moduleUi),/Invalid editor page/);
});
