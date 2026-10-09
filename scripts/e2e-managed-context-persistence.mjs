#!/usr/bin/env node
/** Real host SQLite settings, isolated profile, no model/network requests. */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { register } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Host, resolveHostBinary } from "./e2e/host.mjs";
register(new URL("../apps/desktop/test/helpers/ts-import-hooks.mjs", import.meta.url));
const { createProviderCatalogRuntime } = await import("../apps/desktop/electron/main/runtime/provider-catalog.ts");
const { ModelsDevCatalog } = await import("../apps/desktop/electron/main/models-dev-catalog.ts");
const directory = await mkdtemp(join(tmpdir(), "deckwise-context-settings-"));
const host = new Host(resolveHostBinary(), directory);
try {
  await host.start();
  const catalog = new ModelsDevCatalog({ catalogPath: join(directory, "unused.json"),
    fetchImpl: async () => new Response("{}") });
  await catalog.refresh();
  const runtime = createProviderCatalogRuntime({ getHost: () => host, modelsDevCatalog: catalog });
  assert.equal((await runtime.listRuntimeProviders())[0].models[0].contextWindow, 128_000);
  await host.call("settings.set", runtime.validateSettingsWrite({ managedContextWindow: 1_000_000 }));
  await host.restart();
  const saved = await host.call("settings.get");
  assert.equal(saved.managedContextWindow, 1_000_000);
  const managed = (await runtime.listRuntimeProviders())[0];
  assert.equal(managed.models[0].contextWindow, 1_000_000);
  assert.equal(managed.models[0].contextWindowSource, "user");
  await host.call("settings.set", { theme: "light" });
  assert.equal((await host.call("settings.get")).managedContextWindow, 1_000_000);
  console.log("PASS managed context override survives real host restart and unrelated partial settings writes");
} finally {
  await host.stop();
  await rm(directory, { recursive: true, force: true });
}
