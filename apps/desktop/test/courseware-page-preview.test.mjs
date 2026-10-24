import assert from "node:assert/strict";
import * as crypto from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

const source = await readFile(new URL("../electron/main/courseware-page-preview.ts", import.meta.url), "utf8");
const { outputText } = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } });
const exports = {};
new Function("require", "exports", outputText)(id => {
  if (id === "node:crypto") return crypto;
  assert.equal(id, "./courseware-scene-context");
  return { captureCoursewareSceneImages: () => assert.fail("Invalid replies must never reach the PNG decoder") };
}, exports);
const { sourcePreviewTarget, captureSourcePagePreview } = exports;
const hash = "a".repeat(64);
const context = () => ({ readOnly: true, pageLineage: { sourceSha256: hash, pageTokens: ["first", "second"], openedPageTokens: ["first", "second"] } });

test("private source targets require a fresh exact ordered readonly page lineage", () => {
  assert.deepEqual(sourcePreviewTarget(context(), hash, 2), { sourceSha256: hash, page: 2, pageToken: "second" });
  for (const change of ["readonly", "hash", "duplicate", "reordered", "inserted", "missing", "token", "long"]) {
    const input = context();
    if (change === "readonly") input.readOnly = false;
    if (change === "hash") input.pageLineage.sourceSha256 = "b".repeat(64);
    if (change === "duplicate") input.pageLineage.pageTokens[1] = "first";
    if (change === "reordered") input.pageLineage.pageTokens.reverse();
    if (change === "inserted") input.pageLineage.pageTokens.push("third");
    if (change === "missing") delete input.pageLineage;
    if (change === "token") input.pageLineage.pageTokens[1] = "bad/token";
    if (change === "long") input.pageLineage.pageTokens[1] = "x".repeat(129);
    assert.throws(() => sourcePreviewTarget(input, hash, 2), /readonly/, change);
  }
  for (const page of [0, 3, -1, 1.2, "2", NaN]) assert.throws(() => sourcePreviewTarget(context(), hash, page));
});

test("forged source/page/omission/resolution replies fail before PNG decode", () => {
  const target = sourcePreviewTarget(context(), hash, 2);
  for (const change of ["sourceSha256", "page", "pageToken", "mime", "png", "extra", "omitted", "size", "resolution"]) {
    const reply = { ...target, mime: "image/png", png: new Uint8Array(45) };
    if (["sourceSha256", "pageToken", "mime"].includes(change)) reply[change] = "changed";
    if (change === "page") reply.page = 1;
    if (change === "png") reply.png = [];
    if (change === "extra") reply.url = "https://untrusted.test";
    if (change === "omitted") reply.nativeTextOmitted = true;
    if (change === "size") reply.png = new Uint8Array(8 * 1024 * 1024 + 1);
    assert.throws(() => captureSourcePagePreview(reply, target, false), /preview/i, change);
  }
  assert.throws(() => captureSourcePagePreview({ ...target, mime: "image/png", png: new Uint8Array(45) }, target, true), /requested/);
});
