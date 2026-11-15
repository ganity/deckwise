import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import test from "node:test";
import ts from "typescript";
import * as shared from "../../../packages/shared/dist/index.js";

const require = createRequire(import.meta.url), exports = {};
const source = await readFile(new URL("../electron/main/courseware-online-seed.ts", import.meta.url), "utf8");
new Function("require", "exports", ts.transpileModule(source, { compilerOptions: {
  target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS,
} }).outputText)(id => id.startsWith("node:") ? require(id) : id === "@pi-desktop/shared" ? shared : assert.fail(id), exports);
const { onlineTeachingSeed, projectOnlineTeaching, projectOnlineMapping } = exports;
const sha256 = "a".repeat(64), projectId = "office-local-doc";
function fixture() {
  const project = { schemaVersion: "deckwise-courseware/1", projectId, taskType: "import", title: "Lesson",
    source: { revision: "source-1", sha256 }, teachingRevision: "teaching-1",
    educationContext: { schoolStage: "kindergarten", fullEnglishTeaching: false },
    pages: [{ pageId: "page-1", locked: false, reviewState: "ready", actions: [
      { id: "speech-1", type: "speech", text: "Good job!", pauseAfterMs: 250 },
      { id: "highlight-1", type: "highlight", target: { objectId: "object-1" } },
    ] }, { pageId: "page-2", locked: true, reviewState: "review", actions: [{ id: "wait-1", type: "teacher_continue" }] }] };
  assert(shared.isCoursewareProject(project));
  return { project, mapping: { revision: "mapping-1", sourceSha256: sha256, pages: [
    { pageId: "page-1", importPageId: "page_1", objects: [
      { objectId: "object-1", importElementId: "pptx_shape_1" }, { objectId: "object-2", importElementId: "pptx_shape_2" },
    ] }, { pageId: "page-2", importPageId: "page_2", objects: [] },
  ] } };
}
const seed = raw => onlineTeachingSeed(raw, projectId, sha256);

test("valid Host project and ordered mapping yield stable cloned local pins and a remote projection", () => {
  const raw = fixture(), result = seed(raw);
  assert.deepEqual(result.pins, { projectId, teachingRevision: "teaching-1", mappingRevision: "mapping-1", payloadSha256: result.pins.payloadSha256 });
  assert.match(result.pins.payloadSha256, /^[a-f0-9]{64}$/u);
  const remoteSource = { revision: "22222222-2222-4222-8222-222222222222", sha256 };
  const remote = projectOnlineTeaching(result, "11111111-1111-4111-8111-111111111111", remoteSource);
  assert.deepEqual(remote, { ...raw.project, projectId: "11111111-1111-4111-8111-111111111111", source: remoteSource });
  const mapping = projectOnlineMapping(result);
  assert.deepEqual(mapping, raw.mapping);
  assert.equal(Object.hasOwn(mapping, "sourceRevision"), false);
  mapping.pages[0].objects[0].objectId = "remote-change";
  raw.mapping.pages[0].objects[0].objectId = "local-change";
  assert.equal(result.mapping.pages[0].objects[0].objectId, "object-1");
  remote.pages[0].actions[0].text = "remote change";
  raw.project.pages[0].actions[0].text = "local change";
  assert.equal(result.project.pages[0].actions[0].text, "Good job!");
  assert.throws(() => projectOnlineTeaching(result, "team-project", { ...remoteSource, sha256: "b".repeat(64) }), /TEACHING_CONFLICT/);
});

test("payload hash ignores object key order and pins complete ordered mapping content", () => {
  const raw = fixture(), first = seed(raw);
  const reordered = value => Array.isArray(value) ? value.map(reordered) : value && typeof value === "object" ?
    Object.fromEntries(Object.entries(value).reverse().map(([key, entry]) => [key, reordered(entry)])) : value;
  assert.equal(seed(reordered(raw)).pins.payloadSha256, first.pins.payloadSha256);
  raw.project.pages[0].actions[0].text = "Well done!";
  assert.notEqual(seed(raw).pins.payloadSha256, first.pins.payloadSha256);
  const mappingOnly = fixture(); mappingOnly.mapping.revision = "mapping-2";
  assert.notEqual(seed(mappingOnly).pins.payloadSha256, first.pins.payloadSha256);
  for (const change of [
    raw => { raw.mapping.pages[0].objects[0].objectId = "object-new"; },
    raw => { raw.mapping.pages[0].objects[0].importElementId = "shape-new"; },
    raw => { raw.mapping.pages[0].importPageId = "page-new"; },
    raw => { raw.mapping.pages[0].objects.reverse(); },
    raw => { raw.mapping.pages[0].objects.pop(); },
  ]) {
    const changed = fixture(); change(changed);
    assert.notEqual(seed(changed).pins.payloadSha256, first.pins.payloadSha256);
  }
});

for (const [name, change] of [
  ["missing context", () => null], ["missing mapping", raw => ({ project: raw.project })],
  ["wrong project", raw => { raw.project.projectId = "other"; return raw; }],
  ["wrong source", raw => { raw.project.source.sha256 = "b".repeat(64); return raw; }],
  ["wrong mapping source", raw => { raw.mapping.sourceSha256 = "b".repeat(64); return raw; }],
  ["wrong mapping order", raw => { raw.mapping.pages.reverse(); return raw; }],
  ["missing mapped page", raw => { raw.mapping.pages.pop(); return raw; }],
  ["duplicate mapped page", raw => { raw.mapping.pages[1] = raw.mapping.pages[0]; return raw; }],
  ["unsafe mapping revision", raw => { raw.mapping.revision = "../mapping"; return raw; }],
  ["empty mapping revision", raw => { raw.mapping.revision = ""; return raw; }],
  ["legacy partial mapping", raw => { raw.mapping.pages[0] = { pageId: "page-1", slidePart: "ppt/slides/slide1.xml" }; return raw; }],
  ["unknown mapping field", raw => { raw.mapping.pages[0].objects[0].extra = true; return raw; }],
  ["duplicate mapped object", raw => { raw.mapping.pages[1].objects.push(raw.mapping.pages[0].objects[0]); return raw; }],
  ["duplicate imported element", raw => { raw.mapping.pages[0].objects[1].importElementId = "pptx_shape_1"; return raw; }],
  ["corrupt project", raw => { raw.project.pages[0].actions[0].id = null; return raw; }],
]) test(`seed rejects ${name} instead of initializing local state`, () => {
  assert.throws(() => seed(change(fixture())), /TEACHING_NOT_READY/);
});

for (const action of [
  { id: "clip-1", type: "audio_clip", audioAssetId: "music-1" },
  { id: "clip-1", type: "audio_clip" },
  ...["audioAssetId", "audioId", "audioUrl"].map(key => ({ id: "speech-2", type: "speech", text: "Hello", [key]: "local-audio" })),
]) test(`seed rejects untransferred ${action.type} ${Object.keys(action).at(-1)} media`, () => {
  const raw = fixture(); raw.project.pages[0].actions.push(action);
  assert.throws(() => seed(raw), /TEACHING_MEDIA_UNAVAILABLE/);
});


function audioFixture() {
  const raw = fixture(), sha = "c".repeat(64), localAssetId = `tts-${sha}`;
  raw.project.pages[0].actions[0].audioAssetId = localAssetId;
  const audio = { project: structuredClone(raw.project), assets: [{ localAssetId, kind: "tts",
    taskRef: { taskId: "22222222-2222-4222-8222-222222222222", idempotencyKey: "audio-key", requestHash: "d".repeat(64) },
    assetId: "33333333-3333-4333-8333-333333333333", sha256: sha, mimeType: "audio/wav", byteLength: 100 }] };
  audio.project.pages[0].actions[0].audioAssetId = audio.assets[0].assetId;
  return { raw, audio };
}

test("audio-aware seed pins original local content plus full proof projection and mutates only remote audio references", () => {
  const { raw, audio } = audioFixture(), original = structuredClone(raw), result = onlineTeachingSeed(raw, projectId, sha256, audio);
  assert.deepEqual(result.project, original.project);
  const remote = projectOnlineTeaching(result, "11111111-1111-4111-8111-111111111111", { revision: "remote-source", sha256 });
  assert.equal(remote.pages[0].actions[0].audioAssetId, audio.assets[0].assetId);
  assert.equal(raw.project.pages[0].actions[0].audioAssetId, original.project.pages[0].actions[0].audioAssetId);
  assert.equal(remote.pages[0].actions[0].text, original.project.pages[0].actions[0].text);
  const changed = audioFixture(); changed.audio.assets[0].taskRef.idempotencyKey = "another-task-proof";
  assert.notEqual(onlineTeachingSeed(changed.raw, projectId, sha256, changed.audio).pins.payloadSha256, result.pins.payloadSha256);
  const other = audioFixture(); other.audio.assets[0].assetId = "44444444-4444-4444-8444-444444444444";
  other.audio.project.pages[0].actions[0].audioAssetId = other.audio.assets[0].assetId;
  assert.notEqual(onlineTeachingSeed(other.raw, projectId, sha256, other.audio).pins.payloadSha256, result.pins.payloadSha256);
  audio.project.pages[0].actions[0].text = "mutated"; audio.assets[0].taskRef.idempotencyKey = "mutated";
  assert.equal(result.audio.project.pages[0].actions[0].text, "Good job!");
});

test("audio seed rejects incomplete, foreign or teaching-mutating projections", () => {
  for (const mutate of [v => { v.audio.assets = []; }, v => { v.audio.assets[0].assetId = "local-id"; },
    v => { v.audio.assets[0].taskRef.taskId = "local-task"; }, v => { v.audio.assets[0].sha256 = "d".repeat(64); },
    v => { v.audio.assets.push(v.audio.assets[0]); }, v => { v.audio.project.title = "changed"; },
    v => { v.audio.project.pages[0].actions[0].text = "changed"; },
    v => { v.audio.project.source.revision = "changed"; }, v => { v.raw.project.pages[0].actions[0].audioUrl = "url"; }]) {
    const value = audioFixture(); mutate(value);
    assert.throws(() => onlineTeachingSeed(value.raw, projectId, sha256, value.audio), /TEACHING_MEDIA_UNAVAILABLE/);
  }
});


test("no-audio seed retains the exact legacy canonical project/mapping hash and omits audio projection", () => {
  const raw = fixture(), value = seed(raw);
  const canonical = object => Array.isArray(object) ? object.map(canonical) : object && typeof object === "object" ?
    Object.fromEntries(Object.keys(object).sort().map(key => [key, canonical(object[key])])) : object;
  const legacy = createHash("sha256").update(JSON.stringify(canonical({ project: raw.project, mapping: raw.mapping }))).digest("hex");
  assert.equal(value.pins.payloadSha256, legacy); assert.equal(Object.hasOwn(value, "audio"), false);
});
