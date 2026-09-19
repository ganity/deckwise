#!/usr/bin/env node
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { createWriteStream, promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";

const release = "20260901";
const pythonVersion = "3.14.7";
const abi = "cp314";
const here = path.dirname(fileURLToPath(import.meta.url));

const targets = {
  "win-x64": {
    triple: "x86_64-pc-windows-msvc",
    sha256: "ca3c33ca924dfcab3b74205a7a58a88b0255135c53f95497b26b5e60700fd66d",
    python: ["python.exe"],
    sitePackages: ["Lib", "site-packages"],
    pipPlatforms: ["win_amd64"],
  },
  "mac-x64": {
    triple: "x86_64-apple-darwin",
    sha256: "7e151a7c9028855b61a7d6e78381f2020a1ef185281399f3b1aafc5e1c9a1a64",
    python: ["bin", "python3"],
    sitePackages: ["lib", "python3.14", "site-packages"],
    pipPlatforms: ["macosx_10_15_x86_64"],
  },
  "mac-arm64": {
    triple: "aarch64-apple-darwin",
    sha256: "4632cb1a6edad9e73d3c81b6d2e69131637d995173e3e85005df14102b0592ba",
    python: ["bin", "python3"],
    sitePackages: ["lib", "python3.14", "site-packages"],
    pipPlatforms: ["macosx_11_0_arm64"],
  },
  "linux-x64": {
    triple: "x86_64-unknown-linux-gnu",
    sha256: "3959f92825141e04adf44982d3a83ee57af0877e893b0796e04c1468749d9b04",
    python: ["bin", "python3"],
    sitePackages: ["lib", "python3.14", "site-packages"],
    pipPlatforms: ["manylinux2014_x86_64", "manylinux_2_28_x86_64"],
  },
  "linux-arm64": {
    triple: "aarch64-unknown-linux-gnu",
    sha256: "8a0798baa8a2c27b5751d590aced543eaa85e20b3f73d93c1af049688acdc9c5",
    python: ["bin", "python3"],
    sitePackages: ["lib", "python3.14", "site-packages"],
    pipPlatforms: ["manylinux2014_aarch64", "manylinux_2_28_aarch64"],
  },
};

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const name = argv[index];
    if (name === "--platform") options.platform = argv[++index];
    else if (name === "--arch") options.arch = argv[++index];
    else if (name === "--output") options.output = argv[++index];
    else throw new Error(`Unknown argument: ${name}`);
  }
  return options;
}

function hostParts() {
  return {
    platform: process.platform === "win32" ? "win" : process.platform === "darwin" ? "mac" : "linux",
    arch: process.arch === "arm64" ? "arm64" : "x64",
  };
}

async function sha256(file) {
  const hash = createHash("sha256");
  const handle = await fs.open(file, "r");
  try {
    for await (const chunk of handle.createReadStream()) hash.update(chunk);
  } finally {
    await handle.close();
  }
  return hash.digest("hex");
}

async function download(url, destination) {
  const response = await fetch(url, { redirect: "follow" });
  if (!response.ok || !response.body) throw new Error(`Download failed (${response.status}): ${url}`);
  await pipeline(response.body, createWriteStream(destination));
}

function run(program, args) {
  const result = spawnSync(program, args, { stdio: "inherit" });
  if (result.status !== 0) throw new Error(`${program} failed`);
}

async function resolveSkillRoot() {
  const candidates = [
    process.env.DECKWISE_PPT_MASTER_SKILL_ROOT,
    path.resolve(here, "../../../../../ppt-gen/vendors/ppt-master/skills/ppt-master"),
  ].filter(Boolean);
  for (const candidate of candidates) {
    if (await fs.stat(path.join(candidate, "SKILL.md")).catch(() => null)) return candidate;
  }
  return null;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const host = hostParts();
  const targetName = `${options.platform || host.platform}-${options.arch || host.arch}`;
  const target = targets[targetName];
  if (!target) throw new Error(`Unsupported target ${targetName}. Supported: ${Object.keys(targets).join(", ")}`);

  const output = path.resolve(options.output || path.join(here, "../../dist/runtime/current"));
  if (output === path.parse(output).root || output === os.homedir()) {
    throw new Error(`Refusing unsafe output directory: ${output}`);
  }
  await fs.rm(output, { recursive: true, force: true });

  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "deckwise-python-"));
  try {
    const archive = path.join(tempRoot, "python.tar.gz");
    const url = `https://github.com/astral-sh/python-build-standalone/releases/download/${release}/cpython-${pythonVersion}+${release}-${target.triple}-install_only_stripped.tar.gz`;
    await download(url, archive);
    const actual = await sha256(archive);
    if (actual !== target.sha256) throw new Error(`Python archive checksum mismatch: ${actual}`);

    await fs.mkdir(output, { recursive: true });
    run("tar", [process.platform === "win32" ? "-xf" : "-xzf", archive, "-C", output]);
    const pythonRoot = path.join(output, "python");
    const sitePackages = path.join(pythonRoot, ...target.sitePackages);
    await fs.mkdir(sitePackages, { recursive: true });

    const pipArgs = [
      "-m", "pip", "install", "--disable-pip-version-check", "--no-compile",
      "--only-binary=:all:", "--index-url", process.env.DECKWISE_PIP_INDEX_URL || "https://pypi.org/simple",
      "--implementation", "cp", "--python-version", "3.14", "--abi", abi,
      "--target", sitePackages, "--requirement", path.join(here, "requirements-desktop.txt"),
    ];
    for (const platform of target.pipPlatforms) pipArgs.push("--platform", platform);
    run(process.env.PYTHON || (process.platform === "win32" ? "python" : "python3"), pipArgs);

    await fs.copyFile(path.join(here, "verify-deps.py"), path.join(pythonRoot, "verify-deps.py"));
    await fs.writeFile(
      path.join(output, "runtime.json"),
      `${JSON.stringify({ target: targetName, pythonVersion, release }, null, 2)}\n`,
    );

    if (targetName === `${host.platform}-${host.arch}`) {
      const python = path.join(pythonRoot, ...target.python);
      run(python, [path.join(pythonRoot, "verify-deps.py")]);
      const skillRoot = await resolveSkillRoot();
      if (!skillRoot) throw new Error("PPT Master skill not found for attribution verification");
      run(python, [path.join(skillRoot, "scripts", "attribution_guard.py")]);
    }
    console.log(`DeckWise runtime assembled at ${output}`);
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
