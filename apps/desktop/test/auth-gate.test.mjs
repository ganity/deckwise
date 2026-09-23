import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);
const read = (path) => readFile(new URL(path, root), "utf8");

const [protocol, app, authGate, authSession, launcher, settingsPage, providerCatalog, sessionLaunch, sidecar, main] = await Promise.all([
  read("../../packages/shared/src/protocol.ts"),
  read("src/App.tsx"),
  read("src/features/auth/AuthGate.tsx"),
  read("electron/main/auth-session.ts"),
  read("electron/main/bootstrap/launcher.ts"),
  read("src/features/settings/SettingsPage.tsx"),
  read("electron/main/runtime/provider-catalog.ts"),
  read("electron/main/runtime/session-launch.ts"),
  read("electron/main/runtime/sidecar.ts"),
  read("electron/main/index.ts"),
]);

test("the main app is gated by education QR authentication", () => {
  assert.match(app, /<AuthGate>[\s\S]*<AppShell \/>[\s\S]*<\/AuthGate>/);
  assert.match(authGate, /api\.restoreAuth\(\)/);
  assert.match(authGate, /api\.startQrLogin\(\)/);
  assert.match(authGate, /api\.pollQrLogin\(state\.ticket\)/);
  assert.match(authSession, /edition=EDUCATION/);
  assert.match(authSession, /\/auth\/desktop\/wx\/qrcode/);
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

test("the optional llm gateway uses the signed-in platform access token", () => {
  assert.match(authSession, /async resolveAccessToken\(\)/);
  assert.match(authSession, /this\.accessTokenExpiresIn\(\) <= ACCESS_REFRESH_EARLY_MS/);
  assert.match(authSession, /\/auth\/desktop\/refresh/);
  assert.match(authSession, /rotatedRefreshToken/);
  assert.match(providerCatalog, /authKind: OAUTH_AUTH_KIND/);
  assert.match(sessionLaunch, /process\.env\.DECKWISE_LLM_BASE_URL/);
  assert.match(sessionLaunch, /provider\.id === DECKWISE_MANAGED_PROVIDER_ID/);
  assert.match(sessionLaunch, /const llmBaseUrl = isManagedProvider \?/);
  assert.doesNotMatch(sessionLaunch, /value: await resolvePlatformAccessToken\(\)/);
  assert.match(sessionLaunch, /const baseUrl = llmBaseUrl \?\?/);
  assert.doesNotMatch(sessionLaunch, /const llmBaseUrl = configuredLlmBaseUrl\(\);/);
  assert.match(sidecar, /providerId === DECKWISE_MANAGED_PROVIDER_ID/);
  assert.match(sidecar, /apiKey: await resolvePlatformAccessToken\(\)/);
  assert.match(main, /resolvePlatformAccessToken: \(\) => authSession\.resolveAccessToken\(\)/);
});

test("the managed Seedream image backend follows the refreshed desktop session", () => {
  assert.match(authSession, /join\(homedir\(\), "\.ppt-master"\)/);
  assert.match(authSession, /IMAGE_BACKEND=openai/);
  assert.match(authSession, /OPENAI_BASE_URL=\$\{baseUrl\}/);
  assert.match(authSession, /OPENAI_MODEL=\$\{model\}/);
  assert.match(authSession, /DECKWISE_IMAGE_MODEL/);
  assert.match(authSession, /await this\.writeImageRuntime\(this\.accessToken\)/);
});
