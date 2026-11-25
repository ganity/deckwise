import { app, net, protocol, type Protocol } from "electron";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { promises as fs, createReadStream } from "node:fs";
import { Readable } from "node:stream";
import { createBrotliDecompress } from "node:zlib";
import { editorResourcePath } from "./editor-resource-path";

export const EDITOR_HOST_SCHEME = "deckwise-editor";

export function registerEditorHostScheme(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: EDITOR_HOST_SCHEME,
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        corsEnabled: true,
      },
    },
  ]);
}

const installedProtocols = new WeakSet<object>();

export function installEditorHostProtocol(target: Protocol = protocol): void {
  if (installedProtocols.has(target)) return;
  installedProtocols.add(target);
  const root = app.isPackaged
    ? join(process.resourcesPath, "editor-host")
    : join(app.getAppPath(), "resources", "editor-host");
  const officeRoot = app.isPackaged
    ? join(process.resourcesPath, "wiseoffice")
    : join(app.getAppPath(), "resources", "wiseoffice");
  target.handle(EDITOR_HOST_SCHEME, async (request) => {
    const url = new URL(request.url);
    if (url.hostname === "wiseoffice") {
      const file = editorResourcePath(officeRoot, url.pathname);
      if (!file || !["GET", "HEAD"].includes(request.method)) return new Response("not found", { status: 404 });
      try {
        // Reject symlink escapes as well as lexical traversal.
        const realRoot = await fs.realpath(officeRoot);
        const realFile = await fs.realpath(file);
        if (editorResourcePath(realRoot, "/" + realFile.slice(realRoot.length + 1)) !== realFile) return new Response("not found", { status: 404 });
        const wasm = url.pathname.endsWith("/x2t.wasm.br");
        const response = wasm ? null : await net.fetch(pathToFileURL(realFile).toString(), { method: request.method });
        const headers = new Headers(response?.headers);
        headers.set("Cross-Origin-Opener-Policy", "same-origin");
        headers.set("Cross-Origin-Embedder-Policy", "require-corp");
        headers.set("Cross-Origin-Resource-Policy", "cross-origin");
        if (wasm) {
          // Custom protocols do not apply HTTP content decoding to Response bodies.
          headers.delete("Content-Length");
          headers.set("Content-Type", "application/wasm");
          const body = request.method === "HEAD" ? null : Readable.toWeb(createReadStream(realFile).pipe(createBrotliDecompress()));
          return new Response(body as ReadableStream<Uint8Array> | null, { headers });
        }
        return new Response(response!.body, { status: response!.status, headers });
      } catch { return new Response("not found", { status: 404 }); }
    }
    if (url.hostname !== "host" || !["/index.html", "/online.html"].includes(url.pathname)) {
      return new Response("not found", { status: 404 });
    }
    // Let Chromium's network stack serve the file. Returning a hand-built
    // Response body works in BrowserWindow but is rejected by some Electron
    // 43 WebContentsView loads as ERR_FAILED.
    const response = await net.fetch(pathToFileURL(join(root, url.pathname.slice(1))).toString());
    const headers = new Headers(response.headers);
    headers.set("Cross-Origin-Opener-Policy", "same-origin");
    // The local converter needs shared memory. The online wrapper embeds a separately secured Docs origin.
    if (url.pathname === "/index.html") headers.set("Cross-Origin-Embedder-Policy", "require-corp");
    return new Response(response.body, { status: response.status, headers });
  });
}
