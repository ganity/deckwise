/** Replay private-media HTTP checks with real Electron net.fetch; local fixtures only. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveElectronBinary } from "./e2e/boot.mjs";

assert(process.env.DECKWISE_E2E_OUTPUT, "Missing DECKWISE_E2E_OUTPUT");
assert(process.argv.length === 2 || (process.argv.length === 3 && ["--tts-main", "--tts-audio", "--team-assets"].includes(process.argv[2])), "Only --tts-main, --tts-audio or --team-assets is supported");
const teamAssets = process.argv[2] === "--team-assets";
const ttsAudio = process.argv[2] === "--tts-audio";
const ttsMain = ttsAudio || process.argv[2] === "--tts-main";
const testFile = teamAssets ? "courseware-team-assets.test.mjs" : ttsMain ? "courseware-tts-integration.test.mjs" : "courseware-media.test.mjs";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const output = resolve(process.env.DECKWISE_E2E_OUTPUT);
await mkdir(dirname(output), { recursive: true });
await mkdir(output);
const temp = await mkdtemp(join(tmpdir(), "deckwise-electron-media-"));
const { electronBinary } = resolveElectronBinary(root);
const bootstrap = join(temp, "main.cjs");
await writeFile(bootstrap, `
const { app } = require("electron");
const { after } = require("node:test");
app.on("window-all-closed", () => {});
process.on("uncaughtException", (error) => { console.error(error); app.exit(1); });
app.setPath("userData", ${JSON.stringify(join(temp, "profile"))});
app.whenReady().then(async () => {
  after(() => setImmediate(() => app.exit(process.exitCode || 0)));
  await import(${JSON.stringify(new URL(`../apps/desktop/test/${testFile}`, import.meta.url).href)});
}).catch((error) => { console.error(error); app.exit(1); });
`);
let log = "";
const environment = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/api.?key|secret|token|password|proxy/i.test(key)));
try {
  const child = spawn(electronBinary, ["--no-sandbox", bootstrap], { cwd: root, timeout: ttsMain ? 180_000 : 60_000, killSignal: "SIGKILL",
    env: { ...environment, ELECTRON_RUN_AS_NODE: "", DECKWISE_E2E_ELECTRON_NET: "1", DECKWISE_E2E_TTS_AUDIO: ttsAudio ? "1" : "0" }, stdio: ["ignore", "pipe", "pipe"] });
  for (const stream of [child.stdout, child.stderr]) stream.on("data", (bytes) => { log += String(bytes); process.stdout.write(bytes); });
  const exitCode = await new Promise((resolve, reject) => { child.once("error", reject); child.once("exit", resolve); });
  await writeFile(join(output, "electron.log"), log);
  const passed = [...log.matchAll(/^✔ /gmu)].length;
  const failed = [...log.matchAll(/^✖ /gmu)].length;
  const report = { status: exitCode === 0 && passed === (teamAssets ? 18 : ttsMain ? 1 : 9) && failed === 0 ? "PASS" : "FAIL", exitCode, passed, failed, testFile,
    electronVersion: (await readFile(join(root, "apps/desktop/node_modules/electron/dist/version"), "utf8")).trim(),
    realElectronNetFetch: true, localPlatformStandIn: true, realSpringPlatform: false, realProvider: false,
    providerAudioBytes: Boolean(process.env.DECKWISE_TTS_REAL_AUDIO_PATH),
    realAudioDecoder: ttsAudio, teachingAudioAdoption: ttsAudio, teamAssetResolution: teamAssets,
    realPngDecoder: teamAssets, modelWireWithAuthorizedRead: teamAssets, productionAssetPicker: false,
    sandbox: "--no-sandbox", packaged: false };
  await writeFile(join(output, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  assert.equal(report.status, "PASS", "Actual Electron transport checks failed; inspect retained log");
} finally { await rm(temp, { recursive: true, force: true }); }
