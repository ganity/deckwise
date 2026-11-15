import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { posix, win32 } from "node:path";
import test from "node:test";

// Exercise the actual Vite hook with each platform's path.join and Vite's module IDs.
const source = await readFile(new URL("../../../scripts/build-wiseoffice-maic.mjs", import.meta.url), "utf8");
const hook = source.match(/transform\(code, id\) \{([\s\S]*?)\n  \} \}\]/)?.[1];
assert(hook, "The build must register its MAIC transform hook");
for (const [platform, paths, root] of [
  ["Windows", win32, "D:\\a\\deckwise\\deckwise\\.courseware-inputs\\document"],
  ["POSIX", posix, "/runner/Document with spaces"],
]) {
  test(`${platform} builds apply all MAIC transforms to Vite module IDs`, () => {
    const applied = new Set();
    const transform = new Function("join", "root", "applied", "maicEmbedSource", "maicSidebarSource", "maicTeachingFlowSource",
      `return function(code, id) {${hook}}`)(paths.join, root, applied, code => `embed:${code}`, code => `sidebar:${code}`, code => `flow:${code}`);
    for (const [file, marker] of [["embed-api.ts", "embed"], ["deckwise-teaching-sidebar.ts", "sidebar"], ["deckwise-teaching-flow.ts", "flow"]]) {
      const id = `${root.replaceAll("\\", "/")}/lib/${file}`;
      assert.deepEqual(transform("source", id), { code: `${marker}:source`, map: null });
      assert.equal(transform("source", `${id}.unrelated`), undefined);
    }
    assert.deepEqual([...applied].sort(), ["embed", "flow", "sidebar"]);
  });
}
