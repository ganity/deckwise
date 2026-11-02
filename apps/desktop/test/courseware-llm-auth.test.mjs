import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";
import * as shared from "../../../packages/shared/dist/index.js";

const source = await readFile(new URL("../electron/main/courseware-llm-auth.ts", import.meta.url), "utf8");
const { outputText } = ts.transpileModule(source, { compilerOptions: {
  target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS,
} });
const exports = {};
new Function("require", "exports", outputText)(id => {
  assert.equal(id, "@pi-desktop/shared"); return shared;
}, exports);
const { resolveCoursewareLlmAuth } = exports;
const project = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

function fixture() {
  let task = null, session = { projectPath: "/fixture" }, current;
  const calls = [];
  const host = { async call(method, params) {
    calls.push({ method, params });
    if (method === "session.get") return { session };
    assert.equal(method, "courseware.task.get"); return { task };
  } }; current = host;
  return { calls, resolve: () => resolveCoursewareLlmAuth(() => current, "chat", async () => "fresh-token"),
    task(value) { task = value; }, session(value) { session = value; }, replace() { current = { ...host }; }, host: () => current };
}

test("personal and unbound completion preserve the original model base URL", async () => {
  const f = fixture();
  assert.deepEqual(await f.resolve(), { apiKey: "fresh-token" });
  f.task({ type: "plain" });
  assert.deepEqual(await f.resolve(), { apiKey: "fresh-token" });
  f.session({}); f.calls.length = 0;
  assert.deepEqual(await f.resolve(), { apiKey: "fresh-token" });
  assert.equal(f.calls.length, 1);
  assert.deepEqual(f.calls[0].params, { id: "chat", messageLimit: 1 });
  assert.deepEqual(await resolveCoursewareLlmAuth(f.host, undefined, async () => "fresh-token"), { apiKey: "fresh-token" });
});

test("team binding is reread on every model request without changing the token", async () => {
  const f = fixture();
  assert.equal((await f.resolve()).baseUrl, undefined);
  f.task({ teamProjectId: project });
  const auth = await f.resolve();
  assert.equal(auth.apiKey, "fresh-token");
  assert.equal(auth.baseUrl, `${shared.DECKWISE_MANAGED_BASE_URL.replace(/\/+$/u, "")}/courseware/team/projects/${project}`);
  const other = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  f.task({ teamProjectId: other });
  assert((await f.resolve()).baseUrl.endsWith(other));
});

test("malformed saved scopes and missing sessions fail closed", async () => {
  const f = fixture();
  for (const task of [undefined, [], 4, { teamProjectId: null }, { teamProjectId: "../personal" }, { teamProjectId: 4 }]) {
    f.task(task); await assert.rejects(f.resolve(), /COURSEWARE_LLM_INVALID_SCOPE/u);
  }
  f.session(null); await assert.rejects(f.resolve(), /COURSEWARE_LLM_SESSION_MISSING/u);
});

test("Host replacement while obtaining credentials cannot use the new account's scope", async () => {
  const f = fixture();
  await assert.rejects(resolveCoursewareLlmAuth(f.host, "chat", async () => {
    f.replace(); return "fresh-token";
  }), /COURSEWARE_LLM_HOST_CHANGED/u);
  await assert.rejects(resolveCoursewareLlmAuth(() => null, "chat", async () => "unused"), /HOST_UNAVAILABLE/u);
});

test("team gateway supports loopback and rejects credential-bearing or insecure URLs", async () => {
  const original = process.env.DECKWISE_LLM_BASE_URL;
  const f = fixture(); f.task({ teamProjectId: project });
  try {
    process.env.DECKWISE_LLM_BASE_URL = "http://127.0.0.1:18080";
    assert.equal((await f.resolve()).baseUrl, `http://127.0.0.1:18080/v1/courseware/team/projects/${project}`);
    for (const url of ["http://remote.invalid/v1", "https://user:pass@example.invalid/v1", "https://example.invalid/v1?token=x", "https://example.invalid/v1#x"]) {
      process.env.DECKWISE_LLM_BASE_URL = url;
      await assert.rejects(f.resolve(), /COURSEWARE_LLM_INVALID_GATEWAY/u);
    }
  } finally {
    if (original === undefined) delete process.env.DECKWISE_LLM_BASE_URL;
    else process.env.DECKWISE_LLM_BASE_URL = original;
  }
});
