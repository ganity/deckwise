import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);
const read = (path) => readFile(new URL(path, root), "utf8");

const [protocol, app, authGate, authSession, launcher, settingsPage] = await Promise.all([
  read("../../packages/shared/src/protocol.ts"),
  read("src/App.tsx"),
  read("src/features/auth/AuthGate.tsx"),
  read("electron/main/auth-session.ts"),
  read("electron/main/bootstrap/launcher.ts"),
  read("src/features/settings/SettingsPage.tsx"),
]);

test("the main app is gated by education QR authentication", () => {
  assert.match(app, /<AuthGate>[\s\S]*<AppShell \/>[\s\S]*<\/AuthGate>/);
  assert.match(authGate, /api\.restoreAuth\(\)/);
  assert.match(authGate, /api\.startQrLogin\(\)/);
  assert.match(authGate, /api\.pollQrLogin\(state\.ticket\)/);
  assert.match(authSession, /edition=EDUCATION/);
  assert.match(authSession, /profile\.pcAllowed !== true/);
});

test("refresh credentials use an owner-only local file without OS keyring access", () => {
  assert.doesNotMatch(authSession, /safeStorage/);
  assert.match(authSession, /writeFile\(this\.sessionPath, refreshToken/);
  assert.match(authSession, /mode: 0o600/);
  assert.doesNotMatch(protocol, /DesktopAuthState[\s\S]{0,800}refreshToken/);
});

test("secondary plugin launcher is unavailable before authentication", () => {
  assert.match(launcher, /!appState\.applicationBooted \|\| !isAuthenticated\(\)/);
});

test("account settings can end the desktop session", () => {
  assert.match(settingsPage, /api\.logout\(\)/);
  assert.match(settingsPage, /settings\.accountLogout/);
  assert.match(authSession, /async logout\(\)/);
  assert.match(authSession, /clearStoredSession\(\)/);
  assert.match(authGate, /next\.status === "signedOut"/);
  assert.match(authGate, /void startLogin\(\)/);
});
