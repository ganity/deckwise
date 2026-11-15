import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { chromium, _electron } from '@playwright/test';

const args = [
  '--no-sandbox',
  '--autoplay-policy=document-user-activation-required',
  '--disable-features=MediaEngagementBypassAutoplayPolicies,PreloadMediaEngagementData',
];

export async function launchPlaybackBrowser(executablePath) {
  if (executablePath === undefined) {
    const browser = await chromium.launch({
      channel: 'chrome', headless: true, ignoreDefaultArgs: ['--mute-audio'], args,
    });
    return { browser, runtime: { kind: 'chrome', version: browser.version() } };
  }
  assert(path.isAbsolute(executablePath), '--electron must name an absolute Electron executable');
  const profile = await mkdtemp(path.join(tmpdir(), 'deckwise-d4-electron-'));
  const env = { ...process.env, DECKWISE_PLAYBACK_TEST_PROFILE: profile };
  delete env.ELECTRON_RUN_AS_NODE;
  let app;
  try {
    app = await _electron.launch({
      executablePath, env,
      args: [...args, fileURLToPath(new URL('./playback-electron.cjs', import.meta.url))],
    });
    const runtime = await app.evaluate(async ({ app, BrowserWindow }) => {
      await app.whenReady();
      return { kind: 'electron', versions: process.versions, profile: app.getPath('userData'), windows: BrowserWindow.getAllWindows().length };
    });
    assert.equal(runtime.profile, profile);
    assert.equal(runtime.windows, 0);
    delete runtime.profile;
    return {
      runtime,
      browser: {
        version: () => runtime.versions.chrome,
        async newPage({ viewport }) {
          const window = app.waitForEvent('window');
          await app.evaluate(({ BrowserWindow }, size) => {
            const window = new BrowserWindow({
              ...size, useContentSize: true, show: true,
              webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true,
                autoplayPolicy: 'document-user-activation-required' },
            });
            void window.loadURL('about:blank');
          }, viewport);
          const page = await window;
          try {
            const preferences = await (await app.browserWindow(page)).evaluate(window => window.webContents.getLastWebPreferences());
            assert.deepEqual({ sandbox: preferences.sandbox, contextIsolation: preferences.contextIsolation,
              nodeIntegration: preferences.nodeIntegration, webSecurity: preferences.webSecurity },
            { sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true });
            return page;
          } catch (error) {
            await page.close();
            throw error;
          }
        },
        async close() {
          try {
            const windows = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length);
            assert.equal(windows, 0, 'A playback test leaked a BrowserWindow');
          } finally {
            await app.close();
            await rm(profile, { recursive: true, force: true });
          }
        },
      },
    };
  } catch (error) {
    await app?.close();
    await rm(profile, { recursive: true, force: true });
    throw error;
  }
}
