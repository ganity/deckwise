import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const read = (path) => readFile(new URL(path, import.meta.url), "utf8");
const [resolver, host, skill, shell, tools, builder, packageJson, prepare] = await Promise.all([
  read("../electron/main/python-runtime.ts"),
  read("../electron/main/host-process.ts"),
  read("../electron/main/builtin-skills.ts"),
  read("../../../crates/host-core/src/tools/shell.rs"),
  read("../../../crates/host-core/src/tools/mod.rs"),
  read("../runtime/python/build-runtime.mjs"),
  read("../package.json").then(JSON.parse),
  read("../../../scripts/prepare-ppt-master.mjs"),
]);

test("the bundled Python runtime is first on every PPT Master command PATH", () => {
  assert.match(resolver, /DECKWISE_RUNTIME_BIN/);
  assert.match(resolver, /DECKWISE_PYTHON/);
  assert.match(host, /bundledPythonEnvironment/);
  assert.match(shell, /pub fn tool_env_path/);
  assert.match(shell, /DECKWISE_RUNTIME_BIN/);
  assert.match(tools, /env_path: shell::tool_env_path\(\)/);
  assert.match(skill, /resolveBundledPython/);
});

test("release scripts stage a pinned runtime for every supported desktop target", () => {
  for (const target of ["win-x64", "mac-x64", "mac-arm64", "linux-x64", "linux-arm64"]) {
    assert.ok(builder.includes(`"${target}"`), `missing runtime target ${target}`);
  }
  assert.match(builder, /Python archive checksum mismatch/);
  assert.match(builder, /attribution_guard\.py/);
  assert.match(builder, /Refusing unsafe output directory/);
  assert.doesNotMatch(builder, /PyMuPDF|pymupdf==|fitz==/i);
  assert.match(builder, /dist\/ppt-master/);
  assert.match(prepare, /PPT_MASTER_COMMIT = "6e3ce9c5a3b994a0e223a14a0f7eddf42fd0b9f5"/);
  assert.match(prepare, /PPT_MASTER_ARCHIVE_SHA256 = "8064591bba8ed97cd1dc77987232157be31fe088d5821c6ffb05a178084c83df"/);
  assert.match(prepare, /github\.com\/hugohe3\/ppt-master\/archive/);
  assert.ok(
    packageJson.build.extraResources.some(
      (entry) => entry.from === "dist/runtime/current" && entry.to === "runtime",
    ),
  );
});

test("the desktop packaging command stages PPT Master beside the Python runtime", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "deckwise-packaging-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const desktop = join(root, "apps", "desktop");
  const localSkill = join(root, "local-skill");
  await mkdir(desktop, { recursive: true });
  await mkdir(join(root, "scripts"), { recursive: true });
  await cp(new URL("../../../scripts/prepare-ppt-master.mjs", import.meta.url),
    join(root, "scripts", "prepare-ppt-master.mjs"));
  await cp(new URL("../../../scripts/extract-tar.mjs", import.meta.url),
    join(root, "scripts", "extract-tar.mjs"));
  for (const file of ["SKILL.md", "scripts/attribution_guard.py", "workflows/routing.md"]) {
    await mkdir(dirname(join(localSkill, file)), { recursive: true });
    await writeFile(join(localSkill, file), `fixture: ${file}\n`);
  }

  const [, ...args] = packageJson.scripts["prepare:ppt-master"].split(" ");
  await execFileAsync(process.execPath, args, {
    cwd: desktop,
    env: { ...process.env, DECKWISE_PPT_MASTER_SKILL_ROOT: localSkill },
  });
  const resource = packageJson.build.extraResources.find((entry) => entry.to === "skills/ppt-master");
  assert.ok(resource, "PPT Master must be bundled as a skill resource");
  assert.equal(await readFile(join(desktop, resource.from, "scripts", "attribution_guard.py"), "utf8"),
    "fixture: scripts/attribution_guard.py\n");
});

test("packaging extracts archives from paths containing a drive colon and spaces", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "deckwise-archive-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const archiveRoot = join(root, process.platform === "win32" ? "drive with spaces" : "C:drive with spaces");
  const source = join(root, "source");
  const output = join(root, "output with spaces");
  for (const directory of [archiveRoot, source, output]) await mkdir(directory);
  await writeFile(join(source, "payload.txt"), "packaged runtime\n");
  await execFileAsync("tar", ["-czf", "fixture.tar.gz", "-C", source, "."], { cwd: archiveRoot });

  const archive = process.platform === "win32"
    ? join(archiveRoot, "fixture.tar.gz")
    : join("C:drive with spaces", "fixture.tar.gz");
  const extractorUrl = new URL("../../../scripts/extract-tar.mjs", import.meta.url).href;
  await execFileAsync(process.execPath, ["--input-type=module", "-e",
    `import { extractTarGz } from ${JSON.stringify(extractorUrl)}; await extractTarGz(process.argv[1], process.argv[2]);`,
    archive, "output with spaces"], { cwd: root });
  assert.equal(await readFile(join(output, "payload.txt"), "utf8"), "packaged runtime\n");
});
