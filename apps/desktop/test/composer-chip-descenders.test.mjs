import { readComposerSource } from "./helpers/source-contracts.mjs";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { loadStyles } from "./helpers/styles.mjs";

const composerSource = await readComposerSource();
const styles = await loadStyles();

function ruleBlock(source, selector) {
  const start = source.indexOf(`${selector} {`);
  assert.notEqual(start, -1, `missing ${selector} rule`);
  // Prefer the layout rule (height: 28px) when color-only overrides exist first.
  let idx = start;
  while (idx !== -1) {
    const open = source.indexOf("{", idx);
    const close = source.indexOf("}", open);
    const block = source.slice(idx, close + 1);
    if (block.includes("height: 28px")) return block;
    idx = source.indexOf(`${selector} {`, close + 1);
  }
  throw new Error(`no 28px layout rule for ${selector}`);
}

test("model chip label avoids leading-none under truncation", () => {
  assert.match(composerSource, /className="composer-model-thinking-model"/);
  assert.doesNotMatch(
    composerSource,
    /composer-model-thinking-model[^"]*leading-none|truncate text-sm leading-none/,
  );
});

test("model menu options show one complete display name on hover", () => {
  assert.match(
    composerSource,
    /const configuredTitle = model\.displayName \|\| model\.modelId;[\s\S]*?const optionTitle = isInternalCoursewareModelLabel\(configuredTitle\)/,
  );
  assert.match(composerSource, /title=\{optionTitle\}/);
  const optionBlock =
    composerSource.match(/const optionTitle[\s\S]*?<\/button>/)?.[0] ?? "";
  assert.doesNotMatch(optionBlock, /max-w-\[170px\]|font-mono text-text-secondary/);
});

test("composer runtime chips keep compact line-height for descenders", () => {
  for (const selector of [".mode-chip"]) {
    const block = ruleBlock(styles, selector);
    assert.match(block, /line-height:\s*var\(--leading-compact\);/);
    assert.match(block, /overflow:\s*visible;/);
  }

  assert.match(
    styles,
    /\.composer-model-thinking-chip\s*\{[\s\S]*?line-height:\s*var\(--leading-compact\);/,
  );
  assert.match(
    styles,
    /\.composer-model-thinking-model,\s*\.composer-model-thinking-level\s*\{[\s\S]*?text-overflow:\s*ellipsis;/,
  );
});

test("fixed Agent and permission labels stay hidden", () => {
  assert.doesNotMatch(composerSource, /composer-mode-chip|composer-permission/);
  assert.doesNotMatch(styles, /\.composer-mode-(?:chip|static)|\.composer-permission/);
});
