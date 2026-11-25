import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  mkdtemp,
  mkdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { brotliCompressSync } from "node:zlib";
import ts from "typescript";

test("local editor protocol decodes WASM and denies filesystem escapes", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "wiseoffice-protocol-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const resources = join(root, "resources", "wiseoffice");
  await mkdir(join(resources, "sdkjs", "common", "wasm", "x2t"), {
    recursive: true,
  });
  await writeFile(join(resources, "editor.html"), "<html>local editor</html>");
  const wrapper = join(root, "resources", "editor-host");
  await mkdir(wrapper);
  for (const name of ["index.html", "online.html"]) await writeFile(join(wrapper, name), "");
  const wasm = Buffer.from([0, 97, 115, 109, 1, 0, 0, 0]);
  await writeFile(
    join(resources, "sdkjs/common/wasm/x2t/x2t.wasm.br"),
    brotliCompressSync(wasm),
  );
  await writeFile(join(root, "private"), "private content");
  await symlink(join(root, "private"), join(resources, "escape"));
  const require = createRequire(import.meta.url);
  const electron = {
    app: { isPackaged: false, getAppPath: () => root },
    net: { fetch: async (url) => new Response(await readFile(new URL(url))) },
  };
  const cache = new Map();
  function load(file) {
    if (cache.has(file)) return cache.get(file);
    const module = { exports: {} };
    new Function(
      "require",
      "exports",
      "module",
      ts.transpileModule(readFileSync(file, "utf8"), {
        compilerOptions: {
          target: ts.ScriptTarget.ES2022,
          module: ts.ModuleKind.CommonJS,
        },
      }).outputText,
    )(
      (id) =>
        id === "electron"
          ? electron
          : id.startsWith(".")
            ? load(join(dirname(file), id + ".ts"))
            : require(id),
      module.exports,
      module,
    );
    cache.set(file, module.exports);
    return module.exports;
  }
  let handler;
  load(
    new URL("../electron/main/editor-host-protocol.ts", import.meta.url)
      .pathname,
  ).installEditorHostProtocol({
    handle: (_scheme, callback) => {
      handler = callback;
    },
  });
  const request = (path, method = "GET") =>
    handler({ url: "deckwise-editor://wiseoffice" + path, method });
  const local = await handler({ url: "deckwise-editor://host/index.html", method: "GET" });
  const online = await handler({ url: "deckwise-editor://host/online.html", method: "GET" });
  assert.equal(local.headers.get("cross-origin-embedder-policy"), "require-corp");
  assert.equal(online.headers.get("cross-origin-embedder-policy"), null);
  assert.equal(
    await (await request("/editor")).text(),
    "<html>local editor</html>",
  );
  const response = await request("/sdkjs/common/wasm/x2t/x2t.wasm.br");
  assert.equal(response.headers.get("content-type"), "application/wasm");
  assert.equal(response.headers.get("content-encoding"), null);
  assert.equal(
    response.headers.get("cross-origin-embedder-policy"),
    "require-corp",
  );
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), wasm);
  for (const path of [
    "/escape",
    "/missing",
    "/%2e%2e%2fprivate",
    "/%5cprivate",
    "/%00",
  ])
    assert.equal((await request(path)).status, 404, path);
  assert.equal((await request("/editor", "POST")).status, 404);
  assert.equal(
    (await handler({ url: "deckwise-editor://other/editor", method: "GET" }))
      .status,
    404,
  );
});
