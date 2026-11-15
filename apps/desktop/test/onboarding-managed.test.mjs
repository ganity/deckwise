import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import ts from "typescript";

const require = createRequire(import.meta.url);
const source = await readFile(new URL("../src/components/OnboardingChecklist.tsx", import.meta.url), "utf8");
const { outputText } = ts.transpileModule(source, { compilerOptions: {
  target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX,
} });
function render(providers, done = false) {
  const state = { providers, onboarding: { showChecklist: true, steps: ["provider", "secret", "project", "prompt"]
    .map(id => ({ id, title: id, done: done && ["project", "prompt"].includes(id) })) } };
  const exports = {};
  new Function("require", "exports", outputText)(id => {
    if (id === "react/jsx-runtime") return require(id);
    if (id === "@pi-desktop/shared") return { DECKWISE_MANAGED_PROVIDER_ID: "deckwise-managed" };
    if (id === "react-i18next") return { useTranslation: () => ({ t: key => "label:" + key }) };
    if (id === "../stores/app-store") return { useAppStore: selector => selector(state) };
    if (id === "../lib/api") return { api: {} };
    assert.equal(id, "./icons"); return { IconCheck: () => null };
  }, exports);
  return renderToStaticMarkup(createElement(exports.OnboardingChecklist));
}

test("managed catalog removes BYOK setup while project and prompt onboarding stay visible", () => {
  const html = render([{ id: "deckwise-managed", enabled: true, models: [{ id: "managed-model" }] }]);
  assert(!html.includes("onboarding.addProvider")); assert(!html.includes("onboarding.saveKey"));
  assert(html.includes("onboarding.openProject")); assert(html.includes("onboarding.firstPrompt"));
});

for (const providers of [[], [{ id: "custom", enabled: true, models: [{ id: "custom-model" }] }],
  [{ id: "deckwise-managed", enabled: false, models: [{ id: "managed-model" }] }],
  [{ id: "deckwise-managed", enabled: true, models: [] }]]) {
  test(`BYOK onboarding is preserved without a usable managed catalog: ${JSON.stringify(providers)}`, () => {
    const html = render(providers);
    for (const label of ["addProvider", "saveKey", "openProject", "firstPrompt"]) assert(html.includes("onboarding." + label));
  });
}

test("managed users who completed project and prompt see no empty checklist", () => {
  assert.equal(render([{ id: "deckwise-managed", enabled: true, models: [{ id: "managed-model" }] }], true), "");
});
