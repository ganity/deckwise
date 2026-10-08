#!/usr/bin/env node

import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { extractTarGz } from "./extract-tar.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_OUTPUT = join(ROOT, "apps", "desktop", "dist", "ppt-master");
const PPT_MASTER_COMMIT = "6e3ce9c5a3b994a0e223a14a0f7eddf42fd0b9f5";
const PPT_MASTER_ARCHIVE_SHA256 = "8064591bba8ed97cd1dc77987232157be31fe088d5821c6ffb05a178084c83df";
const PPT_MASTER_ARCHIVE_URL =
  `https://github.com/hugohe3/ppt-master/archive/${PPT_MASTER_COMMIT}.tar.gz`;
const REQUIRED_FILES = [
  "SKILL.md",
  "scripts/attribution_guard.py",
  "workflows/routing.md",
];

function parseArgs(argv) {
  let output = DEFAULT_OUTPUT;
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--output") output = resolve(argv[++index]);
    else throw new Error(`Unknown argument: ${argv[index]}`);
  }
  return { output };
}

async function exists(path) {
  return Boolean(await stat(path).catch(() => null));
}

async function sha256(path) {
  const hash = createHash("sha256");
  const bytes = await readFile(path);
  hash.update(bytes);
  return hash.digest("hex");
}

async function download(url, destination) {
  let lastError;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const response = await fetch(url, { redirect: "follow" });
      if (!response.ok || !response.body) throw new Error(`Download failed (${response.status})`);
      await writeFile(destination, Buffer.from(await response.arrayBuffer()));
      return;
    } catch (error) {
      lastError = error;
      if (attempt < 3) await new Promise((resolveDelay) => setTimeout(resolveDelay, attempt * 1_000));
    }
  }
  throw new Error(`Unable to download PPT Master: ${lastError instanceof Error ? lastError.message : lastError}`);
}

async function findExtractedRoot(extractRoot) {
  const entries = await readdir(extractRoot, { withFileTypes: true });
  const top = entries.find((entry) => entry.isDirectory());
  if (!top) throw new Error("PPT Master archive has no root directory");
  return join(extractRoot, top.name, "skills", "ppt-master");
}

async function assertSkillRoot(skillRoot) {
  for (const file of REQUIRED_FILES) {
    if (!(await exists(join(skillRoot, file)))) {
      throw new Error(`PPT Master package is incomplete: missing ${file}`);
    }
  }
}

async function localSkillRoot() {
  const configured = process.env.DECKWISE_PPT_MASTER_SKILL_ROOT?.trim();
  const candidates = [
    configured,
    join(ROOT, "..", "ppt-gen", "vendors", "ppt-master", "skills", "ppt-master"),
  ].filter(Boolean);
  for (const candidate of candidates) {
    if (await exists(join(candidate, "SKILL.md"))) return candidate;
  }
  return null;
}

async function main() {
  const { output } = parseArgs(process.argv.slice(2));
  if (output === "/" || output === resolve(process.env.HOME || "", "") || output === ROOT) {
    throw new Error(`Refusing unsafe output directory: ${output}`);
  }

  const local = await localSkillRoot();
  if (local) {
    await assertSkillRoot(local);
    await rm(output, { recursive: true, force: true });
    await mkdir(dirname(output), { recursive: true });
    await cp(local, output, { recursive: true });
    console.log(`PPT Master staged from local checkout at ${output}`);
    return;
  }

  const tempRoot = await mkdtemp(join(tmpdir(), "deckwise-ppt-master-"));
  try {
    const archive = join(tempRoot, "ppt-master.tar.gz");
    const extractRoot = join(tempRoot, "extract");
    await download(PPT_MASTER_ARCHIVE_URL, archive);
    const actual = await sha256(archive);
    if (actual !== PPT_MASTER_ARCHIVE_SHA256) {
      throw new Error(`PPT Master archive checksum mismatch: ${actual}`);
    }
    await mkdir(extractRoot, { recursive: true });
    await extractTarGz(archive, extractRoot);
    const extracted = await findExtractedRoot(extractRoot);
    await assertSkillRoot(extracted);
    await rm(output, { recursive: true, force: true });
    await mkdir(dirname(output), { recursive: true });
    await cp(extracted, output, { recursive: true });
    await writeFile(
      join(output, ".deckwise-ppt-master.json"),
      `${JSON.stringify({ commit: PPT_MASTER_COMMIT, sha256: PPT_MASTER_ARCHIVE_SHA256 }, null, 2)}\n`,
    );
    console.log(`PPT Master ${PPT_MASTER_COMMIT} staged at ${output}`);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
