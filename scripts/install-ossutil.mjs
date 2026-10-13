import { createHash } from "node:crypto";
import { appendFileSync, chmodSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

// Checksums published at https://help.aliyun.com/en/oss/developer-reference/ossutil-overview/
const packages = {
  "linux-x64": ["linux-amd64", "85edf66b2fb7238f5c7e25cab820cf29312319fe4935b7c86a6b8485eb434f3c"],
  "darwin-x64": ["mac-amd64", "86685f129c76dbf94d7f9298152e24bb895289d866cb1a6115aa141c1a1b455b"],
  "darwin-arm64": ["mac-arm64", "26e51080c6d6c9848fe3aea8a6b0cbd88453e65cd41c5a27573c59335a78a41d"],
  "win32-x64": ["windows-amd64", "dd68cffb62d88e59ff3d7fde6055ac7b8e2197e2adce7e540bcd6c706a2c4a49"],
};
const target = packages[`${process.platform}-${process.arch}`];
if (!target) throw new Error(`Unsupported ossutil runner: ${process.platform}-${process.arch}`);
const directory = process.env.RUNNER_TEMP;
if (!directory || !process.env.GITHUB_PATH) throw new Error("GitHub runner environment is required");
const [platform, checksum] = target;
const name = `ossutil-2.4.0-${platform}`;
const archive = path.join(directory, `${name}.zip`);
execFileSync("curl", ["-fsSL", "--retry", "3", "-o", archive,
  `https://gosspublic.alicdn.com/ossutil/v2/2.4.0/${name}.zip`], { stdio: "inherit" });
const actual = createHash("sha256").update(readFileSync(archive)).digest("hex");
if (actual !== checksum) throw new Error(`ossutil checksum mismatch for ${name}`);
const extracted = path.join(directory, "ossutil");
mkdirSync(extracted, { recursive: true });
if (process.platform === "win32") {
  execFileSync("powershell.exe", ["-NoProfile", "-Command",
    "Expand-Archive -LiteralPath $env:OSSUTIL_ARCHIVE -DestinationPath $env:OSSUTIL_EXTRACTED -Force"],
  { stdio: "inherit", env: { ...process.env, OSSUTIL_ARCHIVE: archive, OSSUTIL_EXTRACTED: extracted } });
} else {
  execFileSync("unzip", ["-qo", archive, "-d", extracted], { stdio: "inherit" });
}
const binaryDirectory = path.join(extracted, name);
const binary = path.join(binaryDirectory, process.platform === "win32" ? "ossutil.exe" : "ossutil");
if (process.platform !== "win32") chmodSync(binary, 0o755);
execFileSync(binary, ["version"], { stdio: "inherit" });
appendFileSync(process.env.GITHUB_PATH, `${binaryDirectory}\n`);
