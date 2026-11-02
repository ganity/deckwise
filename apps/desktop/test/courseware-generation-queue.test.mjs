import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

const source = await readFile(new URL("../electron/main/courseware-generation-queue.ts", import.meta.url), "utf8");
const exports = {};
new Function("exports", ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText)(exports);
const { CoursewareGenerationQueue } = exports;
const gate = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };

test("one media type retains its configured five slots until async tasks finish; FIFO resumes without resubmission", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const queue = new CoursewareGenerationQueue(5), started = [], completed = new Set();
  const pending = Array.from({ length: 7 }, (_, i) => queue.run(async () => {
    started.push(i); return { state: "submitted" };
  }, async () => ({ state: completed.has(i) ? "ready" : "submitted" })));
  await flush();
  assert.deepEqual(started, [0, 1, 2, 3, 4]);
  t.mock.timers.tick(3000); await flush();
  assert.equal(started.length, 5, "returning a task ID does not release a generation slot");
  completed.add(1); completed.add(3);
  t.mock.timers.tick(3000); await flush();
  assert.deepEqual(started, [0, 1, 2, 3, 4, 5, 6]);
  await Promise.all(pending);
});

test("cancelled queued work never submits and a failed active call releases capacity after reconciliation", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const queue = new CoursewareGenerationQueue(5), held = Array.from({ length: 5 }, gate);
  const initial = held.map((g, i) => queue.run(async () => {
    await g.promise;
    if (i === 0) throw new Error("COURSEWARE_MEDIA_TRANSPORT_FAILED");
    return { state: "ready" };
  }, async () => null));
  const failure = assert.rejects(initial[0], /TRANSPORT_FAILED/);
  const controller = new AbortController();
  const cancelled = queue.run(async () => assert.fail("cancelled job submitted"), async () => null, controller.signal);
  const cancellation = assert.rejects(cancelled, /WAIT_CANCELLED/);
  controller.abort(); await cancellation;
  let started = false;
  const next = queue.run(async () => { started = true; return { state: "ready" }; }, async () => null);
  await flush(); assert.equal(started, false);
  held[0].resolve(); await failure;
  t.mock.timers.tick(3000); await flush();
  await next; assert.equal(started, true);
  for (const g of held.slice(1)) g.resolve();
  await Promise.all(initial.slice(1));
});

test("unknown submissions retain their slot until status proves completion; read failures do not trigger paid retries", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const queue = new CoursewareGenerationQueue(5);
  let paid = 0, failRead = true;
  await Promise.all(Array.from({ length: 5 }, (_, i) => queue.run(async () => {
    paid++; return { state: "submission_unknown" };
  }, async () => { if (failRead) throw new Error("status unavailable"); return { state: "failed" }; })));
  const refused = queue.run(async () => { paid++; return { state: "ready" }; }, async () => null);
  const refusal = assert.rejects(refused, /status unavailable/);
  t.mock.timers.tick(3000); await flush(); await refusal;
  assert.equal(paid, 5);
  failRead = false;
  const retry = queue.run(async () => { paid++; return { state: "ready" }; }, async () => null);
  t.mock.timers.tick(3000); await flush(); await retry;
  assert.equal(paid, 6);
});

test("queued ownership is rechecked before dispatch and a refused owner cannot block the next task", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const queue = new CoursewareGenerationQueue(5), held = Array.from({ length: 5 }, gate);
  const initial = held.map((g, i) => queue.run(async () => { await g.promise; return { state: "ready" }; }, async () => null));
  let current = true;
  const refused = queue.run(async () => assert.fail("stale owner submitted"), async () => null,
    undefined, () => assert(current, "owner changed"));
  const refusal = assert.rejects(refused, /owner changed/);
  const next = queue.run(async () => ({ state: "ready" }), async () => null);
  current = false; held[0].resolve(); await flush(); await refusal; await next;
  for (const g of held.slice(1)) g.resolve();
  await Promise.all(initial);
});

test("uncertain or missing accepted jobs fail waiting work visibly without freeing or reposting those jobs", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  for (const status of [null, { state: "submission_unknown" }]) {
    const queue = new CoursewareGenerationQueue(5);
    await Promise.all(Array.from({ length: 5 }, () => queue.run(async () => ({ state: "submitted" }), async () => status)));
    const waiting = queue.run(async () => assert.fail("unknown work freed capacity"), async () => null);
    const refusal = assert.rejects(waiting, /GENERATION_STATUS_UNKNOWN/);
    t.mock.timers.tick(3000); await flush(); await refusal;
  }
});

test("a healthy completion releases capacity even when another original status is unavailable", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const queue = new CoursewareGenerationQueue(2);
  await queue.run(async () => ({ state: "submitted" }), async () => { throw new Error("original unavailable"); });
  await queue.run(async () => ({ state: "submitted" }), async () => ({ state: "ready" }));
  let posts = 0;
  const next = queue.run(async () => { posts++; return { state: "ready" }; }, async () => null);
  t.mock.timers.tick(3000); await flush(); await next;
  assert.equal(posts, 1);
});
