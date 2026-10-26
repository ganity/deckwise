import assert from "node:assert/strict";
import test from "node:test";
import { chatFirstEditResponse, chatFirstRedoSceneResponse } from "../../../scripts/e2e/chat-first-edit.mjs";

test("the Chat fade fixture uses the real finite tool schema and reports only a pending receipt", () => {
  const results = {
    Skill: { content: "Loaded" },
    ppt_get_presentation_text: { content: JSON.stringify({ context: { editGeneration: 7 }, text: "A circle has no corners." }) },
  };
  const context = { user: "CHAT_FIRST_FADE", has: () => true, result: name => results[name], plain: value => value };
  assert.deepEqual(chatFirstEditResponse(context), { name: "ppt_propose_page_fade", args: { editGeneration: 7 } });
  results.ppt_propose_page_fade = { content: JSON.stringify({ candidateId: "candidate", saved: false, applied: false, reviewState: "needs-review" }) };
  assert.deepEqual(chatFirstEditResponse(context), { content: "CHAT_FIRST_FADE_DONE candidate" });
  results.ppt_propose_page_fade.content = JSON.stringify({ candidateId: "candidate", saved: true });
  assert.throws(() => chatFirstEditResponse(context));
});


test("the Chat redo fixture uses the finite proposal and accepts only its unapplied receipt", () => {
  const results = {
    Skill: { content: "Loaded" },
    ppt_get_presentation_text: { content: JSON.stringify({ context: { editGeneration: 9 }, text: "A circle has no corners." }) },
  };
  const context = { user: "CHAT_FIRST_REDO", has: () => true, result: name => results[name], plain: value => value };
  const proposal = chatFirstEditResponse(context);
  assert.equal(proposal.name, "ppt_propose_page_redo"); assert.equal(proposal.args.editGeneration, 9);
  assert(proposal.args.instruction.includes("One round circle, a fresh layout."));
  results.ppt_propose_page_redo = { content: JSON.stringify({ candidateId: "redo", saved: false, applied: false, reviewState: "needs-review" }) };
  assert.deepEqual(chatFirstEditResponse(context), { content: "CHAT_FIRST_REDO_DONE redo" });
  results.ppt_propose_page_redo.content = JSON.stringify({ candidateId: "redo", saved: false, applied: true });
  assert.throws(() => chatFirstEditResponse(context));
});

test("redo scene fixture validates the approved pixel hashes and latest saved source before output", () => {
  const scene = { pageId: "page", sourceHash: "sha256:" + "a".repeat(64), canvas: { width: 1280, height: 720 },
    pageText: "Try drawing a circle.", instruction: "Use One round circle, a fresh layout.",
    visualMasterAssetId: "master", cleanPlateAssetId: "clean", availableAssets: [{assetId:"master",sha256:"b".repeat(64)}, {assetId:"clean",sha256:"c".repeat(64)}] };
  const visuals = { originalSha256: "b".repeat(64), textlessSha256: "c".repeat(64) };
  const output = JSON.parse(chatFirstRedoSceneResponse(scene, visuals, "a".repeat(64)));
  assert.equal(output.elements[0].type, "native_text");
  assert.equal(output.elements[0].content, "One round circle, a fresh layout.");
  assert.equal(JSON.parse(chatFirstRedoSceneResponse({ ...scene,
    pageText: '<p><span>Try drawing</span>&nbsp;<span>a circle.</span></p>',
  }, visuals, "a".repeat(64))).elements[0].content, output.elements[0].content);
  assert.throws(() => chatFirstRedoSceneResponse(scene, visuals, "d".repeat(64)));
  assert.throws(() => chatFirstRedoSceneResponse(scene, {...visuals, textlessSha256:"d".repeat(64)}, "a".repeat(64)));
  assert.throws(() => chatFirstRedoSceneResponse({...scene, pageText:"Old SVG"}, visuals, "a".repeat(64)));
});
