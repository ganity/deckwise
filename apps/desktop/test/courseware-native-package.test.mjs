import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { createHash } from "node:crypto";
import test from "node:test";
import ts from "typescript";
import JSZip from "jszip";
import * as shared from "../../../packages/shared/dist/index.js";
const require = createRequire(import.meta.url);
const exports = {};
new Function("require", "exports", ts.transpileModule(readFileSync(new URL("../electron/main/courseware-native-package.ts", import.meta.url), "utf8"), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true },
}).outputText)(id => id === "@pi-desktop/shared" ? shared : require(id), exports);
const { readNativeTeachingPackage } = exports;
const bytes = Buffer.from("verified media");
const sha = createHash("sha256").update(bytes).digest("hex");
function fixture() {
  return { schemaVersion: "deckwise-native-teaching/1", documentId: "document", revision: "rev1",
    pages: [{ pageId: "page", locked: false, reviewState: "review", actions: [{ id: "speech", type: "speech", text: "Hello", audioAssetId: "tts-" + sha }] }],
    identity: { pages: [{ pageId: "page", objects: [] }] }, media: [{ id: "tts-" + sha, sha256: sha, mimeType: "audio/mpeg", byteLength: bytes.length, durationMs: 1000, data: bytes.toString("base64") }] };
}
async function pack(value) {
  const zip = new JSZip(); zip.file("ppt/presentation.xml", "<presentation/>");
  if (value) zip.file("customXml/item1.xml", '<teaching xmlns="urn:deckwise:native-teaching:1">' + JSON.stringify(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;") + "</teaching>");
  return zip.generateAsync({ type: "uint8array", compression: "DEFLATE" });
}
test("native package independently verifies all teaching media and rejects missing/corrupted bytes", async () => {
  const value = fixture();
  assert.deepEqual(await readNativeTeachingPackage(await pack(value)), value);
  assert.equal(await readNativeTeachingPackage(await pack()), undefined);
  for (const change of [v => v.media[0].data = Buffer.from("bad").toString("base64"), v => v.media = [],
    v => v.media.push(v.media[0]), v => v.identity.pages[0].pageId = "foreign"]) {
    const bad = fixture(); change(bad); await assert.rejects(readNativeTeachingPackage(await pack(bad)));
  }
});
test("explicit real Part A copy contains all verified teaching and assessment audio", { skip: !process.env.DECKWISE_NATIVE_REAL_FIXTURE }, async () => {
  const value = await readNativeTeachingPackage(readFileSync(join(process.env.DECKWISE_NATIVE_REAL_FIXTURE, "native.pptx")));
  const report = JSON.parse(readFileSync(join(process.env.DECKWISE_NATIVE_REAL_FIXTURE, "report.json"), "utf8"));
  assert.equal(value.pages.length, report.pages); assert.equal(value.media.length, report.media);
  assert.equal(value.media.reduce((sum, m) => sum + m.byteLength, 0), report.mediaBytes);
});
