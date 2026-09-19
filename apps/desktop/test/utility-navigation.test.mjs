import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

const sources = await Promise.all([
  "../src/components/Sidebar.tsx",
  "../src/components/SearchDialog.tsx",
  "../src/components/OnboardingChecklist.tsx",
  "../src/features/app/AppShell.tsx",
  "../src/stores/app-state.ts",
].map((path) => readFile(new URL(path, import.meta.url), "utf8")));

test("DeckWise has no user-facing extensions or marketplace destination", () => {
  for (const source of sources) {
    assert.doesNotMatch(source, /data-nav="plugins"|setPage\("plugins"\)|page === "plugins"|page: "plugins"|PluginsPage/);
  }
});
