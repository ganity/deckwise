import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { register } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const { approveSceneCourseDraft, readSceneCourseDraft } = await import("../electron/main/courseware-scene-draft.ts");
const { sceneCoursePlanRelativePath } = await import("../electron/main/courseware-scene-plan.ts");
const draft = { title: "Greetings", pages: [{ title: "Hello", visibleText: ["Hello"],
  visualIntent: "Two friends waving", narration: "Say hello. Good!" }] };

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "deckwise-scene-draft-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const tasks = new Map([["chat-a", { taskType: "scene" }], ["chat-b", { taskType: "scene" }]]);
  const approvals = new Map();
  const host = { async call(method, params) {
    if (method === "courseware.task.get") return { task: tasks.get(params.sessionId) ?? null };
    if (method === "courseware.scenePlan.get") return { approval: approvals.get(params.sessionId) ?? null };
    if (method === "courseware.scenePlan.approve") {
      const path = join(root, sceneCoursePlanRelativePath(params.sessionId));
      const bytes = await readFile(path);
      assert.equal(createHash("sha256").update(bytes).digest("hex"), params.sha256);
      approvals.set(params.sessionId, { sha256: params.sha256, plan: JSON.parse(bytes) });
      return { approval: approvals.get(params.sessionId) };
    }
    assert.equal(method, "session.get");
    assert(Number.isInteger(params.messageLimit) && params.messageLimit > 0, "Host requires a positive message window");
    return { session: { projectPath: root } };
  } };
  const save = async (id, content = JSON.stringify(draft)) => {
    const path = join(root, sceneCoursePlanRelativePath(id));
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, content);
    return path;
  };
  return { root, host, tasks, approvals, save };
}

test("only the owning Chat's validated draft is read and survives a new reader", async (t) => {
  const f = await fixture(t);
  assert.deepEqual(await readSceneCourseDraft(f.host, { sessionId: "chat-a" }), { plan: null });
  const path = await f.save("chat-a");
  await f.save("chat-b", JSON.stringify({ ...draft, title: "Another lesson" }));
  const { plan } = await readSceneCourseDraft(f.host, { sessionId: "chat-a" });
  assert.equal(plan.title, draft.title);
  assert.equal(plan.relativePath, sceneCoursePlanRelativePath("chat-a"));
  assert.equal(plan.sha256, createHash("sha256").update(await readFile(path)).digest("hex"));
  assert.equal(plan.pages[0].pageId, "scene-001");
  assert.deepEqual(await readSceneCourseDraft({ call: (...args) => f.host.call(...args) }, { sessionId: "chat-a" }), { plan });
  const changed = structuredClone(draft); changed.pages[0].narration = "Wave to your friend.";
  await f.save("chat-a", JSON.stringify(changed));
  const next = (await readSceneCourseDraft(f.host, { sessionId: "chat-a" })).plan;
  assert.notEqual(next.sha256, plan.sha256);
  assert.notEqual(next.pages[0].sourceHash, plan.pages[0].sourceHash);
  assert.equal((await readSceneCourseDraft(f.host, { sessionId: "chat-b" })).plan.title, "Another lesson");
});

test("explicit approval pins the reviewed draft; Chat changes require reapproval", async (t) => {
  const f = await fixture(t);
  await f.save("chat-a");
  const { plan } = await readSceneCourseDraft(f.host, { sessionId: "chat-a" });
  assert.equal(plan.approvedSha256, null);
  const approved = await approveSceneCourseDraft(f.host, { sessionId: "chat-a", sha256: plan.sha256 });
  assert.equal(approved.plan.approvedSha256, plan.sha256);
  await f.save("chat-a", JSON.stringify({ ...draft, title: "Revised lesson" }));
  const revised = await readSceneCourseDraft(f.host, { sessionId: "chat-a" });
  assert.equal(revised.plan.approvedSha256, plan.sha256);
  assert.notEqual(revised.plan.sha256, plan.sha256);
  await assert.rejects(approveSceneCourseDraft(f.host, { sessionId: "chat-a", sha256: plan.sha256 }), /review it again/);
  assert.equal(f.approvals.get("chat-a").plan.title, draft.title);
  const next = await approveSceneCourseDraft(f.host, { sessionId: "chat-a", sha256: revised.plan.sha256 });
  assert.equal(next.plan.approvedSha256, revised.plan.sha256);
  assert.equal(f.approvals.has("chat-b"), false);
  for (const payload of [null, {}, [], { sessionId: "chat-a", sha256: "bad" },
    { sessionId: "chat-a", sha256: plan.sha256, path: "/other" }])
    await assert.rejects(approveSceneCourseDraft(f.host, payload), /Invalid scene plan/);
});

test("Chat planning preserves the saved body budget through review and rejects subtracting assessments", async t => {
  const f = await fixture(t);
  f.tasks.set("chat-a", { taskType: "scene", educationContext: { bodyPageLimit: 8 } });
  const plan = { ...draft, bodyPageLimit: 6, pages: Array.from({ length: 6 }, () => draft.pages[0]) };
  const path = await f.save("chat-a", JSON.stringify(plan));
  await assert.rejects(readSceneCourseDraft(f.host, { sessionId: "chat-a" }), /bodyPageLimit.*saved.*8/);
  assert.equal(JSON.parse(await readFile(path)).bodyPageLimit, 6);
  plan.bodyPageLimit = 8;
  await f.save("chat-a", JSON.stringify(plan));
  const { plan: reviewed } = await readSceneCourseDraft(f.host, { sessionId: "chat-a" });
  assert.equal(reviewed.bodyPageLimit, 8);
  const approved = await approveSceneCourseDraft(f.host, { sessionId: "chat-a", sha256: reviewed.sha256 });
  assert.equal(approved.plan.bodyPageLimit, 8);
  plan.pages = Array.from({ length: 9 }, () => draft.pages[0]);
  await f.save("chat-a", JSON.stringify(plan));
  await assert.rejects(readSceneCourseDraft(f.host, { sessionId: "chat-a" }), /正文 pages exceed/);
});

test("wrong task, attached PPTX, malformed input and changed task cannot expose a draft", async (t) => {
  const f = await fixture(t); await f.save("chat-a");
  for (const task of [{ taskType: "plain" }, { taskType: "import" }, { taskType: "scene", generatedPath: "/lesson.pptx" }]) {
    f.tasks.set("chat-a", task);
    await assert.rejects(readSceneCourseDraft(f.host, { sessionId: "chat-a" }), /ungenerated project-bound scene task/);
  }
  for (const payload of [null, [], {}, { sessionId: "../chat-a" }, { sessionId: "chat-a", path: "/other" }])
    await assert.rejects(readSceneCourseDraft(f.host, payload), /Invalid scene/);
  f.tasks.set("chat-a", { taskType: "scene" });
  let reads = 0;
  const changing = { async call(method, params) {
    if (method === "courseware.task.get" && ++reads === 2) f.tasks.set("chat-a", { taskType: "import" });
    return f.host.call(method, params);
  } };
  await assert.rejects(readSceneCourseDraft(changing, { sessionId: "chat-a" }), /ungenerated project-bound scene task/);
});

test("oversized, malformed, invalid UTF-8 and unknown-field drafts are rejected without modifying them", async (t) => {
  const f = await fixture(t);
  for (const [content, reason] of [["x".repeat(256 * 1024 + 1), /exceeds limits/], ["{", { name: "SyntaxError" }],
    [JSON.stringify({ ...draft, path: "/other" }), /Invalid scene course plan/],
    [Buffer.concat([Buffer.from('{"title":"'), Buffer.from([255]), Buffer.from('","pages":[]}')]), /encoded data/]]) {
    const path = await f.save("chat-a", content);
    await assert.rejects(readSceneCourseDraft(f.host, { sessionId: "chat-a" }), reason);
    assert.deepEqual(await readFile(path), Buffer.from(content));
  }
});

test("symlinks cannot redirect a Chat draft to another Chat or an outside file", async (t) => {
  const f = await fixture(t);
  const other = await f.save("chat-b");
  const path = join(f.root, sceneCoursePlanRelativePath("chat-a"));
  await mkdir(dirname(path), { recursive: true });
  await symlink(other, path);
  await assert.rejects(readSceneCourseDraft(f.host, { sessionId: "chat-a" }), /left its Chat directory/);
  await rm(path);
  const outside = await mkdtemp(join(tmpdir(), "deckwise-scene-outside-"));
  t.after(() => rm(outside, { recursive: true, force: true }));
  await writeFile(join(outside, "plan.json"), JSON.stringify(draft));
  await rm(dirname(path), { recursive: true });
  await symlink(outside, dirname(path));
  await assert.rejects(readSceneCourseDraft(f.host, { sessionId: "chat-a" }), /left its Chat directory/);
});

test("nonfile drafts reject without waiting for a named-pipe writer", { skip: process.platform === "win32", timeout: 2000 }, async (t) => {
  const f = await fixture(t);
  const path = join(f.root, sceneCoursePlanRelativePath("chat-a"));
  await mkdir(dirname(path), { recursive: true });
  execFileSync("mkfifo", [path]);
  await assert.rejects(readSceneCourseDraft(f.host, { sessionId: "chat-a" }), /exceeds limits/);
  assert.equal(f.approvals.size, 0);
});


test("new drafts approve image lettering and an already approved native draft can resume unchanged", async t => {
  const f = await fixture(t);
  await f.save("chat-a");
  const { plan } = await readSceneCourseDraft(f.host, { sessionId: "chat-a" });
  assert.equal((await approveSceneCourseDraft(f.host, { sessionId: "chat-a", sha256: plan.sha256 })).plan.textMode, undefined);
  const native = { ...draft, textMode: "native" };
  const path = await f.save("chat-b", JSON.stringify(native));
  const { plan: saved } = await readSceneCourseDraft(f.host, { sessionId: "chat-b" });
  await assert.rejects(approveSceneCourseDraft(f.host, { sessionId: "chat-b", sha256: saved.sha256 }), /omit textMode/);
  f.approvals.set("chat-b", { sha256: saved.sha256, plan: native });
  const resumed = await approveSceneCourseDraft(f.host, { sessionId: "chat-b", sha256: saved.sha256 });
  assert.equal(resumed.plan.textMode, "native");
  assert.equal(resumed.plan.sha256, saved.sha256);
  assert.equal(await readFile(path, "utf8"), JSON.stringify(native));
});
