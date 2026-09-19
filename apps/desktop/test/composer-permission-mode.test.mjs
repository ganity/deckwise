import { readComposerSource } from "./helpers/source-contracts.mjs";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const composerSource = await readComposerSource();
const sessionCoordinationSource = await readFile(
  new URL("../src/stores/runtime/session-coordination.ts", import.meta.url),
  "utf8",
);

test("Composer exposes Full auto as a fixed non-interactive permission label", () => {
  assert.match(
    composerSource,
    /composer-permission composer-permission-static/,
  );
  assert.match(composerSource, /PERMISSION_MODE_I18N_KEYS\.auto/);
  assert.doesNotMatch(composerSource, /composer-permission-menu/);
  assert.doesNotMatch(composerSource, /permissionOpen|setPermissionOpen/);
  assert.doesNotMatch(composerSource, /\["ask", "accept-edits", "auto"\]/);
});

test("new and existing desktop sessions use Full auto", () => {
  assert.match(sessionCoordinationSource, /permissionMode: "auto"/);
  assert.match(
    composerSource,
    /activeSession\.permissionMode === "auto"/,
  );
  assert.match(composerSource, /permissionMode: "auto"/);
});
