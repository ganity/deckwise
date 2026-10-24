import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { register } from "node:module";
import test from "node:test";
import { genericModelConfig } from "@pi-desktop/agent-runtime";
import { DECKWISE_MANAGED_PROVIDER_ID, IPC, OAUTH_AUTH_KIND } from "@pi-desktop/shared";

register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const { registerAgentIpc } = await import("../electron/main/ipc/agent-ipc.ts");
const projectId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

test("prompt enhancement and title IPC enforce fresh team scope without personal fallback", { timeout: 20000 }, async () => {
  const paths = [], handlers = new Map();
  let task = null, forbidden = false, providerId = DECKWISE_MANAGED_PROVIDER_ID;
  const server = createServer(async (req, res) => {
    for await (const _ of req) { /* Drain the real adapter request. */ }
    paths.push(req.url);
    if (forbidden) {
      res.writeHead(403, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "TEAM_LLM_PERMISSION_DENIED" } }));
      return;
    }
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write(`data: ${JSON.stringify({ id: "fixture", choices: [{ index: 0,
      delta: { role: "assistant", content: "Updated lesson" }, finish_reason: null }] })}\n\n`);
    res.write(`data: ${JSON.stringify({ id: "fixture", choices: [{ index: 0,
      delta: {}, finish_reason: "stop" }] })}\n\n`);
    res.end("data: [DONE]\n\n");
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const baseUrl = `http://127.0.0.1:${server.address().port}/v1`;
  const previous = process.env.DECKWISE_LLM_BASE_URL;
  process.env.DECKWISE_LLM_BASE_URL = baseUrl;
  const host = { async call(method, params) {
    if (method === "settings.get") return {};
    if (method === "session.get") {
      assert.equal(params.id, "chat");
      return { session: { id: "chat", projectPath: "/fixture" } };
    }
    assert.equal(method, "courseware.task.get");
    assert.equal(params.sessionId, "chat");
    return { task };
  } };
  registerAgentIpc({
    registrar: { handle: (channel, handler) => handlers.set(channel, handler) },
    getHost: () => host, getSidecar: () => null, getAgentHostBridge: () => null,
    logger: { app() {} },
    resolvePlatformAccessToken: async () => "fixture-managed-token",
    vendorOAuth: { async resolveAuth(id) {
      assert.equal(id, "vendor-account"); return { apiKey: "fixture-vendor-token" };
    } },
    async resolveAgentRuntimeLaunch() {
      return { providerId, modelId: "fixture", sidecarParams: { thinkingLevel: "off", provider: {
        id: providerId, name: "Fixture", modelId: "fixture", authKind: OAUTH_AUTH_KIND,
        apiStyle: "chat_completions", baseUrl, modelConfig: genericModelConfig("fixture", baseUrl),
      } } };
    },
  });
  const operations = [
    () => handlers.get(IPC.invoke.promptEnhance)({ sessionId: "chat", draft: "Improve this lesson" }),
    () => handlers.get(IPC.invoke.sessionSummarizeTitle)({ sessionId: "chat", userPrompt: "Make a lesson" }),
  ];
  try {
    for (const operation of operations) {
      task = null;
      assert(Object.values(await operation()).includes("Updated lesson"));
      assert.equal(paths.at(-1), "/v1/chat/completions");
      task = { teamProjectId: projectId };
      assert(Object.values(await operation()).includes("Updated lesson"));
      const teamPath = `/v1/courseware/team/projects/${projectId}/chat/completions`;
      assert.equal(paths.at(-1), teamPath);
      forbidden = true;
      const offset = paths.length;
      await assert.rejects(operation(), /403|TEAM_LLM_PERMISSION_DENIED/u);
      assert.deepEqual(paths.slice(offset), [teamPath]);
      forbidden = false;
      providerId = "vendor-account";
      assert(Object.values(await operation()).includes("Updated lesson"));
      assert.equal(paths.at(-1), "/v1/chat/completions");
      providerId = DECKWISE_MANAGED_PROVIDER_ID;
    }
    task = { teamProjectId: projectId };
    assert.deepEqual(await handlers.get(IPC.invoke.promptEnhance)({ draft: "A new personal lesson" }),
      { enhancedDraft: "Updated lesson" });
    assert.equal(paths.at(-1), "/v1/chat/completions");
  } finally {
    if (previous === undefined) delete process.env.DECKWISE_LLM_BASE_URL;
    else process.env.DECKWISE_LLM_BASE_URL = previous;
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  }
});
