import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("the Composer exposes the built-in web search capability switch", async () => {
  const toolbar = await readFile(
    new URL("../src/features/chat/composer/ComposerToolbar.tsx", import.meta.url),
    "utf8",
  );

  assert.match(toolbar, /chat\.webSearch/);
  assert.match(toolbar, /aria-pressed=\{webSearchEnabled\}/);
});
