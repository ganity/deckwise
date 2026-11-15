/** Invoked by the disposable Spring/gateway runner; credentials arrive only on stdin. */
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ts from "typescript";
import * as runtime from "../../../packages/agent-runtime/dist/index.js";
import * as shared from "../../../packages/shared/dist/index.js";
import { Host } from "../../../scripts/e2e/host.mjs";

const chunks = []; for await (const chunk of process.stdin) chunks.push(chunk);
const input = JSON.parse(Buffer.concat(chunks).toString());
assert(input.baseUrl.startsWith("http://127.0.0.1:"));
assert(process.env.DECKWISE_E2E_LLM_HOST, "Missing exact checked Host binary");
process.env.DECKWISE_LLM_BASE_URL = input.baseUrl;
async function load(name, imports) {
  const exports = {};
  const source = await readFile(new URL(`../electron/main/${name}.ts`, import.meta.url), "utf8");
  const { outputText } = ts.transpileModule(source, { compilerOptions: {
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS,
  } });
  new Function("require", "exports", outputText)(id => {
    assert(Object.hasOwn(imports, id), `Unexpected import ${id}`); return imports[id];
  }, exports);
  return exports;
}
const helpers = await load("plugin-agent-complete", { "@pi-desktop/agent-runtime": runtime, "@pi-desktop/shared": shared });
const auth = await load("courseware-llm-auth", { "@pi-desktop/shared": shared });
const unused = new Proxy({}, { get() { throw new Error("Unexpected scene compiler in narration test"); } });
const { createMainCompletion } = await load("main-completion", {
  "@pi-desktop/agent-runtime": runtime, "@pi-desktop/shared": shared, "./plugin-agent-complete": helpers,
  "./courseware-llm-auth": auth, "./courseware-scene-context": unused, "./courseware-scene-generator": unused,
  "./courseware-scene-plan": unused, "./courseware-scene-deck": unused, "./courseware-runtime": unused,
  "./courseware-scene-staging": unused, "./courseware-scene-assets": unused, "./courseware-scene-workflow": unused,
});
const directory = await mkdtemp(join(tmpdir(), "deckwise-team-llm-"));
const workspace = join(directory, "workspace"), data = join(directory, "data");
await mkdir(workspace); await mkdir(join(data, "plugins/market"), { recursive: true });
await writeFile(join(data, "plugins/market/catalog.json"), JSON.stringify({ schemaVersion: 2, providerId: "official", plugins: [] }));
const host = new Host(process.env.DECKWISE_E2E_LLM_HOST, data);
try {
  await host.start();
  const sessionId = (await host.call("session.create", { projectPath: workspace })).session.id;
  await host.call("courseware.task.set", { sessionId, taskType: "plain" });
  if (input.projectId) await host.call("courseware.task.bindTeam", { sessionId, teamProjectId: input.projectId });
  let tokenReads = 0;
  const provider = { id: shared.DECKWISE_MANAGED_PROVIDER_ID, name: "Managed fixture", modelId: "fixture-model",
    authKind: shared.OAUTH_AUTH_KIND, apiStyle: input.apiStyle ?? "chat_completions", baseUrl: input.baseUrl,
    modelConfig: runtime.genericModelConfig("fixture-model", input.baseUrl) };
  const main = createMainCompletion({ getHost: () => host, resolvePlatformAccessToken: async () => { tokenReads++; return input.accessToken; },
    vendorOAuth: unused, async resolveAgentRuntimeLaunch() { return { providerId: provider.id, modelId: provider.modelId,
      sidecarParams: { provider, thinkingLevel: "off" } }; } });
  const request = { sessionId, modelKey: `${provider.id}/${provider.modelId}`,
    messages: [{ role: "user", content: "Rewrite page one narration as one short encouraging sentence." }] };
  if (input.allowed) {
    const result = await main.complete(request);
    assert.equal(result.text, "Good! 请看看这个圆形。");
  } else {
    await assert.rejects(main.complete(request), /403|TEAM_LLM_PERMISSION_DENIED/u);
  }
  assert.equal(tokenReads, 1);
  console.log(JSON.stringify({ status: "PASS", allowed: input.allowed, teamBound: Boolean(input.projectId), tokenReads }));
} finally { await host.stop(); await rm(directory, { recursive: true, force: true }); }
