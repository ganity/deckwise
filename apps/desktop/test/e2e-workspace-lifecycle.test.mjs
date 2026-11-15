import assert from "node:assert/strict";
import test from "node:test";
import { retainCoursewareWorkspace } from "../../../scripts/e2e/boot.mjs";

test("playback-only recovery never owns the supplied paid workspace", () => {
  for (const passed of [false, true]) {
    assert.equal(retainCoursewareWorkspace({ recovery: true, mediaEnabled: false, passed }), true,
      "A recovered workspace must remain available after both success and failure");
  }
});

test("fresh failed media runs retain their receipts while ordinary temporary runs can clean up", () => {
  assert.equal(retainCoursewareWorkspace({ recovery: false, mediaEnabled: true, passed: false }), true);
  assert.equal(retainCoursewareWorkspace({ recovery: false, mediaEnabled: true, passed: true }), false);
  for (const passed of [false, true]) {
    assert.equal(retainCoursewareWorkspace({ recovery: false, mediaEnabled: false, passed }), false);
  }
});
