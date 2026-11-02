import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import test from "node:test";
import ts from "typescript";
import * as shared from "@pi-desktop/shared";
import { PptxInspector } from "../electron/main/pptx-inspection.ts";

const require = createRequire(import.meta.url);
const source = await readFile(new URL("../electron/main/host-process.ts", import.meta.url), "utf8");
const code = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
const exports = {};
new Function("require", "exports", code)(name => name === "@pi-desktop/shared" ? shared : name.startsWith("./") ? {} : require(name), exports);
const busy = () => new Error("Release the existing courseware job before starting another");
const host = callOnce => Object.assign(Object.create(exports.HostProcess.prototype), { callOnce });

test("saved-page inspection waits for another parser owner to release its job", async t => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  let occupied = true, attempts = 0;
  const calls = [];
  const transport = host(async (method, args) => {
    calls.push([method, args]);
    if (method === "courseware.parseStart") {
      attempts++;
      if (occupied) throw busy();
      return { jobId: "inspection" };
    }
    if (method === "courseware.parseStatus") return { status: "SUCCEEDED", summary: {
      sourceSha256: "a".repeat(64), pages: 10, warningCount: 0, errorCount: 0, warnings: [],
    } };
    if (method === "courseware.parseRelease") return { released: true };
    assert.fail(method);
  });
  const inspector = new PptxInspector();
  const check = inspector.start(transport, { path: "/workspace/saved.pptx", revision: 1, sha256: "a".repeat(64) });
  await Promise.resolve(); await Promise.resolve();
  assert.equal(inspector.status({ checkId: check.checkId }).status, "RUNNING");
  assert.equal(attempts, 1);
  occupied = false;
  t.mock.timers.tick(100);
  for (let i = 0; i < 20; i++) await Promise.resolve();
  assert.equal(inspector.status({ checkId: check.checkId }).status, "SUCCEEDED");
  assert.equal(attempts, 2);
  assert.deepEqual(calls.filter(([method]) => method === "courseware.parseRelease").map(([, args]) => args.jobId), ["inspection"]);
});

test("parser admission is bounded and never retries transport uncertainty or media submissions", async t => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  let attempts = 0;
  const waiting = host(async () => { attempts++; throw busy(); }).call("courseware.parseStart", { path: "saved.pptx" });
  const rejected = assert.rejects(waiting, /Release the existing courseware job/);
  await Promise.resolve(); await Promise.resolve();
  t.mock.timers.tick(90_000);
  await rejected;
  assert.equal(attempts, 2);
  for (const [method, error] of [["courseware.parseStart", new Error("RPC response lost")], ["courseware.media.prepare", busy()]]) {
    let count = 0;
    await assert.rejects(host(async () => { count++; throw error; }).call(method, {}), error);
    assert.equal(count, 1);
  }
});

test("Host overload retains its bounded backoff independently of parser occupancy", async t => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  let attempts = 0;
  const overload = Object.assign(new Error("Busy"), { errorCode: shared.ErrorCodes.HOST_OVERLOADED });
  const pending = host(async () => { attempts++; throw overload; }).call("session.get", {});
  const rejected = assert.rejects(pending, overload);
  for (const ms of [50, 100, 200, 400]) {
    await Promise.resolve(); await Promise.resolve();
    t.mock.timers.tick(ms);
  }
  await rejected;
  assert.equal(attempts, 5);
});
