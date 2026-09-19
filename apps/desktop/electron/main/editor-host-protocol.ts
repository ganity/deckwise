import { app, net, protocol, type Protocol } from "electron";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

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
  target.handle(EDITOR_HOST_SCHEME, async (request) => {
    const url = new URL(request.url);
    if (url.hostname !== "host" || url.pathname !== "/index.html") {
      return new Response("not found", { status: 404 });
    }
    // Let Chromium's network stack serve the file. Returning a hand-built
    // Response body works in BrowserWindow but is rejected by some Electron
    // 43 WebContentsView loads as ERR_FAILED.
    return net.fetch(pathToFileURL(join(root, "index.html")).toString());
  });
}
