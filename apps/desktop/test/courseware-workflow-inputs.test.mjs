import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const root = new URL("../../../", import.meta.url);
const read = path => readFile(new URL(path, root), "utf8");

test("release runners prepare pinned Document and native worker inputs before packaging", async () => {
  const action = await read(".github/actions/prepare-courseware/action.yml");
  assert.match(action, /repository: \$\{\{ steps\.source\.outputs\.repository \}\}/);
  assert.match(action, /ref: \$\{\{ steps\.source\.outputs\.commit \}\}/);
  assert.match(action, /persist-credentials: false/);
  assert.match(action, /pnpm.*install --frozen-lockfile/);
  assert.match(action, /working-directory: \.courseware-inputs\/document/, "Resolve Document's own packageManager version");
  assert.match(action, /build-wiseoffice-maic\.mjs/);
  assert.match(action, /stage-wiseoffice\.mjs/);
  assert.match(action, /scripts\/stage-worker\.mjs/);
  assert.match(action, /courseware-release-inputs\.mjs --freeze/);
  for (const path of [".github/workflows/release.yml", ".github/workflows/linux-package.yml"]) {
    const workflow = await read(path);
    const prepare = workflow.indexOf("uses: ./.github/actions/prepare-courseware");
    const pack = workflow.indexOf("run: pnpm --filter @pi-desktop/desktop run");
    assert(prepare > 0 && prepare < pack, `${path} must prepare ignored inputs before packing`);
    assert.match(workflow, /DECKWISE_COURSEWARE_RELEASE: '1'/);
    assert(workflow.indexOf("apt-get install") < pack, "RPM tools must precede packaging");
    assert.match(workflow, /check-courseware-package\.mjs/);
    assert.match(workflow, /xvfb-run -a node scripts\/e2e-maic-courseware\.mjs/);
    assert.match(workflow, /cp "\$DECKWISE_E2E_OUTPUT\/report\.json" apps\/desktop\/release\/courseware-acceptance-linux-x64\.json/);
    assert(workflow.indexOf("courseware-artifact-checksums.mjs") > workflow.indexOf("xvfb-run"), "Checksums must include final acceptance evidence");
  }
  const linux = await read(".github/workflows/linux-package.yml");
  const failureEvidence = linux.split("- name: Preserve failed package acceptance evidence")[1]?.split("- name:")[0];
  assert(failureEvidence, "Failed runtime checks must retain diagnostic evidence");
  assert.match(failureEvidence, /if: failure\(\)/);
  assert.match(failureEvidence, /path: \$\{\{ runner\.temp \}\}\/courseware-package-acceptance/);
  for (const artifact of ["*.AppImage", "*.deb", "*.rpm", "courseware-*.json", "SHA256SUMS-*.txt"])
    assert(linux.includes(`apps/desktop/release/${artifact}`), `Missing downloadable ${artifact}`);
});

test("source checkout rejects moving refs and unsafe repository names", async t => {
  const source = await read(".github/actions/prepare-courseware/action.yml");
  const body = source.split("run: |\n")[1]?.split("\n    - name:")[0].replace(/^        /gm, "");
  assert(body, "Missing source validation script");
  const directory = await mkdtemp(join(tmpdir(), "courseware-source-pin-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await mkdir(join(directory, "apps/desktop"), { recursive: true });
  const pin = { schemaVersion: "deckwise-courseware-sources/1", document: { repository: "ganity/document", commit: "a".repeat(40) } };
  const run = () => execFileSync("bash", ["-c", body], { cwd: directory, env: { ...process.env, GITHUB_OUTPUT: join(directory, "outputs") }, stdio: "pipe" });
  const save = () => writeFile(join(directory, "apps/desktop/courseware-sources.json"), JSON.stringify(pin));
  await save(); run();
  assert.equal(await readFile(join(directory, "outputs"), "utf8"), `repository=ganity/document\ncommit=${"a".repeat(40)}\n`);
  pin.document.commit = "main"; await save(); assert.throws(run);
  pin.document.commit = "a".repeat(40); pin.document.repository = "../document"; await save(); assert.throws(run);
});
