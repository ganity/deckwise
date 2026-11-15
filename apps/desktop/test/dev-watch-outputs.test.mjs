import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout } from "node:timers/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";

const desktop = dirname(dirname(fileURLToPath(import.meta.url)));
const require = createRequire(join(desktop, "package.json"));
const { createServer, loadConfigFromFile } = await import(require.resolve("vite"));

test("development watches source changes without watching packaged outputs", async () => {
  const loaded = await loadConfigFromFile({ command: "serve", mode: "development" }, join(desktop, "electron.vite.config.ts"));
  const root = await mkdtemp(join(tmpdir(), "deckwise-watch-"));
  const files = ["src/app.ts", "release/trial/linux-unpacked/resources/icons/a.svg", "dist/runtime/a.py", "out/main/index.js"];
  let server;
  try {
    for (const file of files) {
      await mkdir(dirname(join(root, file)), { recursive: true });
      await writeFile(join(root, file), "initial");
    }
    server = await createServer({ configFile: false, root, server: { ...loaded.config.renderer.server, port: 0 }, optimizeDeps: { noDiscovery: true, include: [] } });
    await server.listen();
    const source = join(root, "src/app.ts");
    for (let attempt = 0; attempt < 50 && !server.watcher.getWatched()[join(root, "src")]; attempt++) await setTimeout(20);
    const watched = Object.keys(server.watcher.getWatched());
    assert.ok(watched.includes(join(root, "src")), "source remains watched");
    for (const dir of ["release", "dist", "out"]) {
      assert.ok(!watched.some((path) => path === join(root, dir) || path.startsWith(join(root, dir) + "/")), `${dir} must not consume watchers`);
    }
    const changed = new Promise((resolve, reject) => {
      const timer = globalThis.setTimeout(() => reject(new Error("Source change was not observed")), 3000);
      server.watcher.on("change", (file) => { if (file === source) { clearTimeout(timer); resolve(); } });
    });
    await writeFile(source, "updated");
    await changed;
  } finally {
    await server?.close();
    await rm(root, { recursive: true, force: true });
  }
});
