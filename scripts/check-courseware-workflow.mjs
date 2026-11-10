/** Scoped, provider-free workflow gate. A local current Host is mandatory. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), ".."), pnpm = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
const output = await mkdtemp(join(tmpdir(), "deckwise-workflow-gate-"));
const binary = join(root, "target/debug", process.platform === "win32" ? "pi-desktop-host-core.exe" : "pi-desktop-host-core");
const worker = join(root, "packages/courseware-runtime/dist/pptx-worker.mjs");
const pptMaster = join(root, "apps/desktop/dist/ppt-master");
const env = { ...process.env, DECKWISE_E2E_MEDIA_SCOPE_HOST: binary, DECKWISE_E2E_LOCAL_MEDIA_HOST: binary,
  DECKWISE_E2E_MUSIC_HOST: binary, DECKWISE_E2E_WORKFLOW_HOST: binary, DECKWISE_PPTX_NODE: process.execPath, DECKWISE_PPTX_WORKER: worker,
  DECKWISE_PPT_MASTER_SKILL_ROOT: pptMaster };
const report = { status: "RUNNING", providerCalls: 0, nativeEditor: "not-run", checks: [], metrics: [] };
async function run(name, command, args, timeout = 240_000) {
  console.log(`Running ${name}`);
  const started = Date.now(), child = spawnSync(command, args, { cwd: root, env, encoding: "utf8", timeout, maxBuffer: 16 * 1024 * 1024 });
  const log = `${child.stdout ?? ""}${child.stderr ?? ""}`;
  await writeFile(join(output, `${name}.log`), log);
  report.checks.push({ name, exitCode: child.status, durationMs: Date.now() - started });
  assert.equal(child.status, 0, `${name} failed: ${child.error ?? ""}\n${log.slice(-7000)}`);
  return log;
}
try {
  for (const path of [worker, join(root, "packages/shared/dist/index.js"), join(root, "packages/agent-runtime/dist/index.js"), join(pptMaster, "scripts/svg_to_pptx.py")])
    assert(existsSync(path), `Missing current workspace build: ${path}`);
  await run("host-build", "cargo", ["build", "-p", "host-core", "--locked"]);
  assert(existsSync(binary), "The current checkout's Host binary is missing");
  const files = ["generation-queue", "media", "local-media", "magic-layers", "canvas-music", "canvas-images", "scene-images", "tts", "saved-media", "chat-workflow-ui",
    "saved-narration", "narration", "scene-plan", "scene-deck", "presentation", "chat-workflow", "scene-image-pipeline", "media-scope-integration", "local-media-host", "canvas-music-host", "workflow-contract", "sidecar-proxy"];
  const node = await run("main-host", process.execPath, ["--test", "--test-reporter=tap", ...files.map(name => `apps/desktop/test/courseware-${name}.test.mjs`)]);
  const count = key => Number(node.match(new RegExp(`^# ${key} (\\d+)$`, "m"))?.[1] ?? -1);
  assert(count("tests") > 0 && count("pass") === count("tests") && count("skipped") === 0 && count("cancelled") === 0, "Every mandatory Main/Host test must run");
  Object.assign(report.checks.at(-1), { passed: count("pass"), skipped: count("skipped") });
  for (const line of node.split("\n")) {
    const json = line.match(/^\s*# (\{.+\})$/u)?.[1];
    if (json) report.metrics.push(JSON.parse(json));
  }
  for (const [pkg, tests] of [
    ["shared", ["courseware-workflow", "courseware-presentation", "courseware-scene-teaching", "courseware-teaching-quality"]],
    ["agent-runtime", ["courseware/narration-write", "courseware-turn-continuation", "courseware-stalled-continuation", "courseware-quality-continuation", "courseware-workflow-recovery", "courseware-workflow-tools", "runtime"]],
  ]) {
    const resultFile = join(output, `${pkg}.json`);
    await run(pkg, pnpm, ["--filter", `@pi-desktop/${pkg}`, "exec", "vitest", "run", ...tests.map(name => `src/${name}.test.ts`), "--reporter=json", `--outputFile=${resultFile}`]);
    const result = JSON.parse(await readFile(resultFile, "utf8"));
    assert(result.numTotalTests > 0 && result.numPassedTests === result.numTotalTests && result.numPendingTests === 0, `${pkg} contains unexecuted tests`);
    Object.assign(report.checks.at(-1), { passed: result.numPassedTests, skipped: result.numPendingTests });
  }
  const rust = await run("host-contracts", "cargo", ["test", "-p", "host-core", "--locked", "courseware_projects::"], 600_000);
  for (const name of ["native_save_preserves_pending_music_and_video_originals", "approved_question_contract_matches_shared_fixtures", "required_teaching_repair_saves_only_missing_actions_and_preserves_speech_audio"])
    assert(rust.includes(`::${name} ... ok`), `Mandatory Host regression did not execute: ${name}`);
  const counts = rust.match(/test result: ok\. (\d+) passed; (\d+) failed; (\d+) ignored/u);
  assert(counts, "Missing Rust result counts");
  Object.assign(report.checks.at(-1), { passed: Number(counts[1]), ignored: Number(counts[3]) });
  report.status = "PASS";
} catch (error) {
  report.status = "FAIL";
  console.error(String(error));
  process.exitCode = 1;
} finally {
  await writeFile(join(output, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  console.log(`${report.status}: ${join(output, "report.json")}`);
}
