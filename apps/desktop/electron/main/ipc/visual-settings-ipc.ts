import { IPC } from "@pi-desktop/shared";
import { net, session } from "electron";
import { createPublicHttpsClient } from "../public-https-fetch";
import { saveComposerPasteFiles } from "../composer-paste";
import type { DesktopAuthSession } from "../auth-session";
import type { IpcRegistrar } from "./types";

export function registerVisualSettings(registrar: IpcRegistrar, auth: DesktopAuthSession, dataDir: string,
  getHost: () => { call<T>(name: string, params: unknown): Promise<T> } | null) {
  const validId = (id: unknown): id is number => typeof id === "number" && Number.isSafeInteger(id) && id > 0;
  registrar.handleWithEvent(IPC.invoke.visualSettingLibrary, async event => {
    registrar.assertMainWindowSender(event);
    return (await auth.visualSettings()).map(({ id, name, revision }) => ({ id, name, revision }));
  });
  registrar.handleWithEvent(IPC.invoke.visualSettingImages, async (event, libraryId) => {
    registrar.assertMainWindowSender(event);
    if (!validId(libraryId)) throw new Error("Invalid library ID");
    return (await auth.visualSettings(libraryId)).map(({ id, name, type, description, images }) =>
      ({ id, name, type, description, images: images.map((image: { id: number; name: string; fileUrl: string }) => ({ id: image.id, name: image.name,
        preview: /^https:\/\//i.test(image.fileUrl) ? image.fileUrl : undefined })) }));
  });
  registrar.handleWithEvent(IPC.invoke.visualSettingAttach, async (event, input) => {
    registrar.assertMainWindowSender(event);
    if (!input || !validId(input.libraryId) || !validId(input.itemId) || !validId(input.imageId) || !Number.isSafeInteger(input.revision))
      throw new Error("Invalid visual setting selection");
    const host = getHost();
    if (!host || typeof input.sessionId !== "string" || !/^[a-zA-Z0-9_-]{1,128}$/u.test(input.sessionId)) throw new Error("Invalid visual setting chat");
    const principal = auth.getCoursewarePrincipal();
    const { session: owner } = await host.call<{ session?: { id: string } }>("session.get", { id: input.sessionId, messageLimit: 1 });
    if (owner?.id !== input.sessionId) throw new Error("Visual setting chat unavailable");
    const check = () => {
      principal.assertCurrent();
      if (host !== getHost()) throw new Error("Visual setting chat changed");
    };
    const checkRevision = async () => {
      check();
      const library = (await auth.visualSettings()).find(row => row.id === input.libraryId);
      if (!library || library.revision !== input.revision) throw new Error("Visual library changed; reopen it to select the current version");
      check();
      return library;
    };
    const library = await checkRevision();
    const item = (await auth.visualSettings(input.libraryId)).find(row => row.id === input.itemId);
    const image = item?.images.find((row: { id: number }) => row.id === input.imageId);
    if (!image || typeof image.fileUrl !== "string") throw new Error("Image is no longer in the selected library");
    check();
    const client = createPublicHttpsClient({ fetchImpl: (url, init) => net.fetch(url, init),
      lookupImpl: async host => (await session.defaultSession.resolveHost(host)).endpoints,
      routeImpl: url => session.defaultSession.resolveProxy(url) });
    await client.assertPublicUrl(image.fileUrl);
    const response = await net.fetch(image.fileUrl, { credentials: "omit", redirect: "error", signal: AbortSignal.timeout(60000) });
    if (!response.ok || !response.body) throw new Error("Could not download the selected visual setting");
    const reader = response.body.getReader(), chunks: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > 30 * 1024 * 1024) throw new Error("Visual setting image exceeds 30 MB");
        chunks.push(value);
      }
    } finally { await reader.cancel(); }
    const bytes = Buffer.concat(chunks, size);
    const png = bytes.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex"));
    const jpeg = bytes.subarray(0, 3).equals(Buffer.from([255, 216, 255]));
    const webp = bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP";
    if (!png && !jpeg && !webp) throw new Error("Unsupported setting image; select PNG, JPEG or WebP");
    await checkRevision();
    const safe = (s: string) => s.replace(/[\\/]/g, "_").slice(0, 30);
    const name = `setting_${input.libraryId}_v${library.revision}_${input.itemId}_${input.imageId}_${safe(item.name)}_${safe(image.name)}`;
    const files = await saveComposerPasteFiles(dataDir, input.sessionId, [{
      name: name + (png ? ".png" : jpeg ? ".jpg" : ".webp"), mimeType: png ? "image/png" : jpeg ? "image/jpeg" : "image/webp",
      data: Uint8Array.from(bytes).buffer,
    }]);
    check();
    return { files };
  });
}
