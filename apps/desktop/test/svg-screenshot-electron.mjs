import assert from "node:assert/strict";
import { createServer } from "node:http";
import { register } from "node:module";
import { app, BrowserWindow, nativeImage } from "electron";

register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const { screenshotLivePreview, screenshotSvg } = await import("../electron/main/svg-screenshot.ts");

void app.whenReady().then(async () => {
  const server = createServer((_request, response) => {
    response.setHeader("Content-Type", "text/html; charset=utf-8");
    response.end('<!doctype html><div id="slide-list"><div class="slide-item active"></div></div><div id="svg-content" style="display:block"><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 9"><rect width="16" height="9" fill="#e53935"/></svg></div>');
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const window = new BrowserWindow({ show: false });
  try {
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const { DECKWISE_SVG_SMOKE_FILE: file, DECKWISE_SVG_SMOKE_WORKSPACE: workspace } = process.env;
    let shot;
    if (file && workspace) {
      await window.loadURL("about:blank");
      shot = await screenshotSvg(window, workspace, file);
    } else {
      await window.loadURL(process.env.DECKWISE_SVG_SMOKE_URL || `http://127.0.0.1:${address.port}/`);
      await window.webContents.executeJavaScript(`new Promise((resolve, reject) => {
        const deadline = Date.now() + 10000;
        const check = () => document.querySelector('#svg-content svg')
          ? resolve(true)
          : Date.now() > deadline ? reject(new Error('SVG preview did not load')) : setTimeout(check, 100);
        check();
      })`);
      shot = await screenshotLivePreview(window.webContents);
    }
    assert.equal(shot?.mimeType, "image/png");
    const image = nativeImage.createFromBuffer(Buffer.from(shot.data, "base64"));
    assert.deepEqual(image.getSize(), { width: 1920, height: 1080 });
    const pixels = image.toBitmap();
    assert.ok(pixels.some((channel, index) => index % 4 < 3 && channel < 240), "the PNG contains slide content");
    assert.equal(window.isVisible(), false);
    console.log("SVG screenshot Electron smoke passed: 1920x1080 PNG, window stayed hidden");
  } finally {
    window.destroy();
    server.close();
    app.quit();
  }
}).catch((error) => {
  console.error(error);
  app.exit(1);
});
