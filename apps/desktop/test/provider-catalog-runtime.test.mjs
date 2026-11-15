import assert from "node:assert/strict";
import { createServer } from "node:http";
import { registerHooks } from "node:module";
import test from "node:test";

import { ModelsDevCatalog } from "../electron/main/models-dev-catalog.ts";

const runtimeModule = new URL("../electron/main/runtime/provider-catalog.ts", import.meta.url);
// The production bundler resolves this extensionless TypeScript import.
const resolution = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (context.parentURL === runtimeModule.href && specifier === "../models-dev-catalog") {
      return nextResolve("../models-dev-catalog.ts", context);
    }
    return nextResolve(specifier, context);
  },
});
const { createProviderCatalogRuntime } = await import(runtimeModule.href)
  .finally(() => resolution.deregister());

const fixture = {
  example: {
    name: "Example",
    api: "https://models.example/v1",
    models: {
      "catalog-model": {
        id: "catalog-model",
        reasoning: true,
        modalities: { input: ["text", "image"], output: ["text"] },
        limit: { context: 128_000, output: 8_192 },
      },
      "text-model": {
        id: "text-model",
        reasoning: false,
        modalities: { input: ["text"], output: ["text"] },
      },
    },
  },
};

async function fixtureRuntime() {
  const catalog = new ModelsDevCatalog({
    catalogPath: "unused-model-catalog.json",
    fetchImpl: async () => new Response(JSON.stringify(fixture), { status: 200 }),
  });
  assert.equal(await catalog.refresh(), true);
  const runtime = createProviderCatalogRuntime({
    getHost: () => null,
    modelsDevCatalog: catalog,
  });
  return { catalog, runtime };
}

for (const modelId of ["catalog-model", "unpublished-model"]) {
  test(`cached metadata keeps provider binding changes immediate for ${modelId}`, async () => {
    const { catalog, runtime } = await fixtureRuntime();
    const provider = {
      id: "provider-row",
      name: "Example",
      vendorKey: "example",
      baseUrl: "https://models.example/v1",
      models: [{
        id: modelId,
        contextWindow: 128_000,
        maxTokens: 8_192,
        thinkingLevels: ["low", "high"],
        supportsImages: true,
      }],
    };
    const session = { id: "session-one", providerId: provider.id, modelId };
    const input = { vendorKey: provider.vendorKey, baseUrl: provider.baseUrl, modelId };
    const published = catalog.findModel(input);
    const initial = runtime.enrichSession(session, [provider]);
    assert.equal(initial.supportsReasoning, true);
    assert.equal(initial.supportsVision, true);
    assert.deepEqual(initial.supportedThinkingLevels, ["low", "high"]);

    provider.models = [{
      ...provider.models[0],
      contextWindow: 64_000,
      maxTokens: 4_096,
      thinkingLevels: ["off"],
      supportsImages: false,
    }];
    const updated = runtime.enrichSession(session, [provider]);
    assert.equal(updated.supportsReasoning, false);
    assert.equal(updated.supportsVision, false);
    assert.deepEqual(updated.supportedThinkingLevels, ["off"]);
    assert.equal(runtime.enrichProvider(provider).supportsVision, false);

    provider.models = [{ ...provider.models[0], thinkingLevels: ["max"], supportsImages: true }];
    const restored = runtime.enrichSession(session, [provider]);
    assert.equal(restored.supportsReasoning, true);
    assert.equal(restored.supportsVision, true);
    assert.deepEqual(restored.supportedThinkingLevels, ["max"]);
    assert.equal(catalog.findModel(input), published, "binding edits do not replace catalog metadata");
    assert.deepEqual(session, { id: "session-one", providerId: provider.id, modelId });
  });
}

test("cached session capabilities follow the current default model", async () => {
  const { runtime } = await fixtureRuntime();
  const provider = {
    id: "provider-row",
    name: "Example",
    vendorKey: "example",
    baseUrl: "https://models.example/v1",
  };
  const defaults = { defaultProviderId: provider.id, defaultModelId: "catalog-model" };
  const first = runtime.enrichSession({}, [provider], defaults);
  assert.equal(first.supportsReasoning, true);
  assert.equal(first.supportsVision, true);

  defaults.defaultModelId = "text-model";
  const second = runtime.enrichSession({}, [provider], defaults);
  assert.equal(second.supportsReasoning, false);
  assert.equal(second.supportsVision, false);
  defaults.defaultModelId = "catalog-model";
  assert.deepEqual(runtime.enrichSession({}, [provider], defaults), first);
});

test("a bulk session refresh reuses catalog matches while preserving each session", async () => {
  const { catalog, runtime } = await fixtureRuntime();
  const provider = { id: "provider-row", name: "Example", vendorKey: "example" };
  const input = { vendorKey: provider.vendorKey, modelId: "catalog-model" };
  const match = catalog.findModel(input);
  assert.ok(match);
  const modelId = match.modelId;
  let modelReads = 0;
  Object.defineProperty(match, "modelId", {
    configurable: true,
    get() {
      modelReads += 1;
      return modelId;
    },
  });
  const sessions = Array.from({ length: 816 }, (_, index) => ({
    id: `session-${index}`,
    title: `Task ${index}`,
    providerId: provider.id,
    modelId,
  }));

  for (let refresh = 0; refresh < 2; refresh += 1) {
    const result = sessions.map((session) => runtime.enrichSession(session, [provider]));
    assert.deepEqual(result, sessions.map((session) => ({
      ...session,
      supportsReasoning: true,
      supportsVision: true,
      supportedThinkingLevels: ["low", "medium", "high"],
    })));
  }
  assert.equal(modelReads, 0, "session list refreshes must not repeat catalog matching work");
});

test("the managed DeckWise provider is first and becomes the empty-settings default", async () => {
  const catalog = new ModelsDevCatalog({
    catalogPath: "unused-model-catalog.json",
    fetchImpl: async () => new Response(JSON.stringify(fixture), { status: 200 }),
  });
  assert.equal(await catalog.refresh(), true);
  const runtime = createProviderCatalogRuntime({
    getHost: () => ({
      call: async () => ({
        providers: [{ id: "custom", name: "Custom", authKind: "none", enabled: true }],
      }),
    }),
    modelsDevCatalog: catalog,
  });

  const providers = await runtime.listRuntimeProviders();
  assert.equal(providers[0].id, "deckwise-managed");
  assert.equal(providers[0].models[0].supportsImages, true);
  assert.equal(providers[1].id, "custom");
  const defaults = runtime.normalizeSettings({});
  assert.equal(defaults.defaultProviderId, "deckwise-managed");
  assert.equal(defaults.defaultModelId, providers[0].defaultModelId);
  assert.ok(defaults.defaultCommandShell);
  assert.equal(
    runtime.normalizeSettings({ defaultProviderId: "custom", defaultModelId: "custom-model" })
      .defaultProviderId,
    "custom",
  );
  assert.equal(runtime.normalizeSettings({ defaultProviderId: "custom" }).defaultModelId, "");
});

test("the managed provider reads its model catalog from the llm gateway", async () => {
  const catalog = new ModelsDevCatalog({
    catalogPath: "unused-model-catalog.json",
    fetchImpl: async () => new Response(JSON.stringify(fixture), { status: 200 }),
  });
  const originalFetch = globalThis.fetch;
  const originalBaseUrl = process.env.DECKWISE_LLM_BASE_URL;
  delete process.env.DECKWISE_LLM_BASE_URL;
  const requests = [];
  globalThis.fetch = async (input, init) => {
    requests.push({ input: String(input), authorization: init?.headers?.Authorization });
    return new Response(JSON.stringify({
      object: "list",
      data: [
        { id: "gateway-model-a", display_name: "模型 A" },
        { id: "gateway-model-b" },
      ],
    }), { status: 200 });
  };
  try {
    const runtime = createProviderCatalogRuntime({
      getHost: () => ({ call: async () => ({ providers: [] }) }),
      modelsDevCatalog: catalog,
      resolvePlatformAccessToken: async () => "access-token",
    });
    const providers = await runtime.listRuntimeProviders();
    assert.equal(providers[0].apiStyle, "responses");
    assert.deepEqual(providers[0].models.map((model) => ({
      id: model.id,
      alias: model.alias,
      contextWindow: model.contextWindow,
      maxTokens: model.maxTokens,
      thinkingLevels: model.thinkingLevels,
      defaultThinkingLevel: model.defaultThinkingLevel,
      supportsImages: model.supportsImages,
    })), [
      {
        id: "gateway-model-a",
        alias: "gateway-model-a",
        contextWindow: 128_000,
        maxTokens: 32_768,
        thinkingLevels: ["off", "low", "medium", "high"],
        defaultThinkingLevel: "off",
        supportsImages: true,
      },
      {
        id: "gateway-model-b",
        alias: "gateway-model-b",
        contextWindow: 128_000,
        maxTokens: 32_768,
        thinkingLevels: ["off", "low", "medium", "high"],
        defaultThinkingLevel: "off",
        supportsImages: true,
      },
    ]);
    assert.equal(providers[0].defaultModelId, "gateway-model-a");
    assert.deepEqual(requests, [{
      input: "https://trainwise.efrobot.com/llm-ha/v1/models",
      authorization: "Bearer access-token",
    }]);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalBaseUrl === undefined) delete process.env.DECKWISE_LLM_BASE_URL;
    else process.env.DECKWISE_LLM_BASE_URL = originalBaseUrl;
  }
});

test("the managed provider preserves a gateway URL override", async () => {
  const originalFetch = globalThis.fetch;
  const originalBaseUrl = process.env.DECKWISE_LLM_BASE_URL;
  process.env.DECKWISE_LLM_BASE_URL = "http://127.0.0.1:9788/v1/";
  const requests = [];
  globalThis.fetch = async (input) => {
    requests.push(String(input));
    return new Response(JSON.stringify({ data: [{ id: "local-model" }] }));
  };
  try {
    const runtime = createProviderCatalogRuntime({
      getHost: () => ({ call: async () => ({ providers: [] }) }),
      modelsDevCatalog: new ModelsDevCatalog({
        catalogPath: "unused.json",
        fetchImpl: async () => new Response(JSON.stringify(fixture)),
      }),
      resolvePlatformAccessToken: async () => "access-token",
    });
    const providers = await runtime.listRuntimeProviders();
    assert.equal(providers[0].defaultModelId, "local-model");
    assert.deepEqual(requests, ["http://127.0.0.1:9788/v1/models"]);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalBaseUrl === undefined) delete process.env.DECKWISE_LLM_BASE_URL;
    else process.env.DECKWISE_LLM_BASE_URL = originalBaseUrl;
  }
});

test("managed model discovery refuses insecure gateways before resolving authentication", async () => {
  const { catalog } = await fixtureRuntime();
  const originalFetch = globalThis.fetch;
  const originalBaseUrl = process.env.DECKWISE_LLM_BASE_URL;
  let authCalls = 0;
  let requests = 0;
  globalThis.fetch = async () => {
    requests += 1;
    return new Response(JSON.stringify({ data: [{ id: "unsafe-model" }] }));
  };
  try {
    const runtime = createProviderCatalogRuntime({
      getHost: () => ({ call: async () => ({ providers: [] }) }),
      modelsDevCatalog: catalog,
      resolvePlatformAccessToken: async () => { authCalls += 1; return "fixture-token"; },
    });
    for (const url of ["http://gateway.example/v1", "ftp://localhost/v1", "file://localhost/v1"]) {
      process.env.DECKWISE_LLM_BASE_URL = url;
      const providers = await runtime.listRuntimeProviders();
      assert.notEqual(providers[0].defaultModelId, "unsafe-model");
    }
    assert.equal(authCalls, 0);
    assert.equal(requests, 0);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalBaseUrl === undefined) delete process.env.DECKWISE_LLM_BASE_URL;
    else process.env.DECKWISE_LLM_BASE_URL = originalBaseUrl;
  }
});

test("managed model discovery does not forward authentication through redirects", async () => {
  const { catalog } = await fixtureRuntime();
  const originalBaseUrl = process.env.DECKWISE_LLM_BASE_URL;
  const requests = [];
  const server = createServer((request, response) => {
    requests.push({ path: request.url, authorization: request.headers.authorization });
    if (request.url === "/v1/models") {
      response.writeHead(307, { Location: "/redirected/models" });
      response.end();
      return;
    }
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ data: [{ id: "redirected-model" }] }));
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  try {
    process.env.DECKWISE_LLM_BASE_URL = `http://127.0.0.1:${server.address().port}/v1`;
    const runtime = createProviderCatalogRuntime({
      getHost: () => ({ call: async () => ({ providers: [] }) }),
      modelsDevCatalog: catalog,
      resolvePlatformAccessToken: async () => "fixture-token",
    });
    const providers = await runtime.listRuntimeProviders();
    assert.notEqual(providers[0].defaultModelId, "redirected-model");
    assert.deepEqual(requests, [{ path: "/v1/models", authorization: "Bearer fixture-token" }]);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    if (originalBaseUrl === undefined) delete process.env.DECKWISE_LLM_BASE_URL;
    else process.env.DECKWISE_LLM_BASE_URL = originalBaseUrl;
  }
});

test("managed context settings survive catalog refresh and runtime recreation", async () => {
  const { catalog } = await fixtureRuntime();
  let settings = {};
  const custom = { id: "custom", models: [{ id: "other", contextWindow: 64_000 }] };
  const create = () => createProviderCatalogRuntime({
    getHost: () => ({ call: async (method) => method === "settings.get"
      ? structuredClone(settings) : { providers: [custom] } }),
    modelsDevCatalog: catalog,
  });
  const runtime = create();
  assert.equal((await runtime.listRuntimeProviders())[0].models[0].contextWindow, 128_000);
  settings = runtime.validateSettingsWrite({ managedContextWindow: 1_000_000 });
  for (const current of [runtime, create()]) {
    const providers = await current.listRuntimeProviders();
    const managed = providers[0];
    assert.equal(managed.models[0].contextWindow, 1_000_000);
    assert.equal(managed.models[0].contextWindowSource, "user");
    const effective = current.effectiveSubagentModelConfig(managed, managed.models[0].id, {
      modelId: managed.models[0].id, contextWindow: 128_000, maxTokens: 32_768,
      input: ["text", "image"],
    });
    assert.equal(effective.modelConfig.contextWindow, 1_000_000);
    assert.equal(effective.modelConfig.maxTokens, 32_768);
    assert.equal(providers[1].models[0].contextWindow, 64_000);
  }
  settings = runtime.validateSettingsWrite({ managedContextWindow: 128_000 });
  assert.equal((await runtime.listRuntimeProviders())[0].models[0].contextWindow, 128_000);
});

test("managed context overrides apply to every discovered model and offline fallback", async () => {
  const { catalog } = await fixtureRuntime();
  const originalFetch = globalThis.fetch;
  let available = true;
  globalThis.fetch = async () => available
    ? new Response(JSON.stringify({ data: [{ id: "one" }, { id: "two" }] }))
    : new Response("offline", { status: 503 });
  try {
    const runtime = createProviderCatalogRuntime({
      getHost: () => ({ call: async (method) => method === "settings.get"
        ? { managedContextWindow: 256_000 } : { providers: [] } }),
      modelsDevCatalog: catalog,
      resolvePlatformAccessToken: async () => "fixture-token",
    });
    const models = (await runtime.listRuntimeProviders())[0].models;
    assert.deepEqual(models.map((model) => model.contextWindow), [256_000, 256_000]);
    available = false;
    assert.equal((await runtime.listRuntimeProviders())[0].models[0].contextWindow, 256_000);
  } finally { globalThis.fetch = originalFetch; }
});

test("settings boundary rejects invalid managed context windows", async () => {
  const { runtime } = await fixtureRuntime();
  for (const value of [0, -1, 1.5, "256000", null, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => runtime.validateSettingsWrite({ managedContextWindow: value }),
      (error) => error.errorCode === "INVALID_ARGUMENT");
  }
  assert.deepEqual(runtime.validateSettingsWrite({ theme: "dark" }), { theme: "dark" });
});
