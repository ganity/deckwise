#!/usr/bin/env node
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readdir, readlink, realpath, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Readable } from "node:stream";

const root = fileURLToPath(new URL("..", import.meta.url));
const require = createRequire(join(root, "apps/desktop/package.json"));
export const asar = require(require.resolve("@electron/asar", { paths: [dirname(require.resolve("electron-builder"))] }));
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const normalize = (name) => name.replaceAll("\\", "/").replace(/^\/+/, "");

// Public templates and CA trust bundles are distribution inputs, not account state.
export function pathCategory(name) {
  const path = normalize(name);
  if (/(^|\/)\.env(?:\.[^/]+)?$/iu.test(path) && !/\.env\.(?:example|sample|template)$/iu.test(path)) return "environment-state";
  if (/(^|\/)(?:\.deckwise|\.pi-desktop|\.pi|\.git|\.ssh|\.aws|\.azure|\.config|userData|Local Storage|Session Storage|IndexedDB|Cookies|Login Data)(\/|$)/iu.test(path)) return "private-user-state";
  if (/(^|\/)(?:auth(?:-state)?\.json|profile\.json|credentials(?:\.json)?|session\.(?:token|json)|secrets\.(?:json|bin)|\.npmrc|\.pypirc|\.git-credentials|id_rsa|id_ed25519)$/iu.test(path)) return "credential-file";
  if (/\.(?:db|sqlite|sqlite3)(?:-(?:wal|shm))?$/iu.test(path)) return "database-state";
  if (/\.(?:key|p12|pfx)$/iu.test(path)) return "private-key-file";
  return null;
}

const signatures = [
  ["private-key-material", /-----BEGIN (?:RSA |EC |DSA |OPENSSH |ENCRYPTED )?PRIVATE KEY-----[\s\S]{24,10000}?-----END (?:RSA |EC |DSA |OPENSSH |ENCRYPTED )?PRIVATE KEY-----/u],
  ["provider-token", /\b(?:sk-(?:proj-|ant-)?[A-Za-z0-9_-]{32,}|gh[pousr]_[A-Za-z0-9]{32,}|xox[baprs]-[A-Za-z0-9-]{24,}|AKIA[A-Z0-9]{16})\b/u],
  ["bearer-literal", /\bBearer[ \t]+(?=[A-Za-z0-9._~-]{32,})(?=[A-Za-z0-9._~-]*[0-9])[A-Za-z0-9._~-]+/u],
  ["jwt-literal", /\beyJ[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{15,}\.[A-Za-z0-9_-]{20,}\b/u],
  ["server-key-literal", /\b(?:OPENAI|ANTHROPIC|DOUBAO|MXAPI|DASHSCOPE|VOLC|DEEPSEEK|QWEN|GEMINI)[A-Z_]*(?:API_KEY|ACCESS_TOKEN|SECRET_KEY)["']?\s*[:=]\s*["']?([A-Za-z0-9_./+-]{24,})/u],
];
export function contentCategories(bytes) {
  const text = bytes.toString("latin1");
  const found = signatures.filter(([, expression]) => expression.test(text)).map(([category]) => category);
  if (bytes.subarray(0, 16).equals(Buffer.from("SQLite format 3\0"))) found.push("sqlite-content");
  return found;
}

export async function scanPptxExport(bytes, name) {
  const report = { path: name, sha256: digest(bytes), passed: false, files: [], findings: [],
    limits: ["Known credential signatures only; arbitrary or obfuscated values require content review.",
      "Nested archives inside embedded objects are scanned as bytes, not recursively decoded."] };
  const fail = (path, category) => { report.findings.push({ path, category, blocking: true }); return report; };
  if (bytes.length > 256 * 1024 * 1024) return fail(name, "archive-size-limit");
  const JSZip = createRequire(join(root, "packages/courseware-runtime/package.json"))("jszip");
  let zip;
  try { zip = await JSZip.loadAsync(bytes); } catch { return fail(name, "invalid-pptx-archive"); }
  const entries = Object.values(zip.files);
  if (entries.length > 4096) return fail(name, "archive-entry-limit");
  if (!zip.file("[Content_Types].xml") || !zip.file("ppt/presentation.xml")) return fail(name, "invalid-pptx-archive");
  let totalBytes = 0;
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const original = (entry.unsafeOriginalName ?? entry.name).replaceAll("\\", "/");
    const path = `${name}!/${normalize(entry.name)}`;
    if (original.startsWith("/") || /^[A-Za-z]:/u.test(original) || /(^|\/)\.\.(\/|$)/u.test(original))
      return fail(path, "archive-path-escape");
    if ((Number(entry.unixPermissions) & 0o170000) === 0o120000) return fail(path, "archive-link");
    const category = pathCategory(entry.name);
    if (category) fail(path, category);
    if (entry.dir) continue;
    const categories = new Set(), hash = createHash("sha256");
    let size = 0, overlap = Buffer.alloc(0);
    try {
      for await (const chunk of new Readable().wrap(entry.nodeStream())) {
        size += chunk.length; totalBytes += chunk.length;
        if (size > 64 * 1024 * 1024 || totalBytes > 256 * 1024 * 1024) return fail(path, "archive-size-limit");
        hash.update(chunk);
        const window = Buffer.concat([overlap, chunk]);
        for (const value of contentCategories(window)) categories.add(value);
        overlap = window.subarray(Math.max(0, window.length - 16384));
      }
    } catch { return fail(path, "invalid-pptx-member"); }
    report.files.push({ path, bytes: size, sha256: hash.digest("hex") });
    for (const value of categories) fail(path, value);
  }
  report.passed = report.findings.length === 0;
  return report;
}

export async function scanPackage(resources) {
  resources = await realpath(resources);
  const files = [], findings = [], links = [];
  const inspect = async (name, source) => {
    const path = normalize(name), categories = new Set();
    const category = pathCategory(path);
    if (category) categories.add(category);
    const hash = createHash("sha256");
    let bytes = 0, overlap = Buffer.alloc(0);
    for await (const chunk of source) {
      hash.update(chunk); bytes += chunk.length;
      const window = Buffer.concat([overlap, chunk]);
      for (const value of contentCategories(window)) categories.add(value);
      overlap = window.subarray(Math.max(0, window.length - 16384));
    }
    files.push({ path, bytes, sha256: hash.digest("hex") });
    for (const value of categories) findings.push({ path, category: value, blocking: true });
  };
  const walk = async (directory, prefix = "") => {
    for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(directory, entry.name), name = prefix + entry.name;
      const category = pathCategory(name);
      if ((entry.isDirectory() || entry.isSymbolicLink()) && category) findings.push({ path: name, category, blocking: true });
      if (entry.isSymbolicLink()) {
        const target = await readlink(path);
        let inside = false;
        try { const relativeTarget = relative(resources, await realpath(path)); inside = relativeTarget !== ".." && !relativeTarget.startsWith("../") && !isAbsolute(relativeTarget); } catch { /* A broken link must fail closed. */ }
        links.push({ path: name, target, inside });
        if (!inside) findings.push({ path: name, category: "external-or-broken-link", blocking: true });
      } else if (entry.isDirectory()) await walk(path, name + "/");
      else if (entry.isFile()) {
        await inspect(name, createReadStream(path));
        if (name.endsWith(".asar")) {
          asar.uncache(path);
          for (const member of asar.listPackage(path).map(normalize).sort()) {
            const stat = asar.statFile(path, member, false);
            if (stat.files) continue;
            const memberName = name + "!/" + normalize(member);
            if (stat.link) findings.push({ path: memberName, category: "asar-link-requires-review", blocking: true });
            // Unpacked payloads are independently walked under resources; do not follow archive-directed paths.
            else if (stat.unpacked) continue;
            else await inspect(memberName, [asar.extractFile(path, member)]);
          }
        }
      } else findings.push({ path: name, category: "special-file", blocking: true });
    }
  };
  await walk(resources);
  return { schemaVersion: "courseware-credential-gate/1", checkedAt: new Date().toISOString(), resources,
    passed: findings.length === 0, fileCount: files.length, linkCount: links.length,
    inventorySha256: digest(JSON.stringify(files)), files, links, findings,
    limits: ["Signature detection cannot prove absence of unknown or obfuscated credentials.",
      "PPTX/ZIP and other compressed payloads are not recursively decoded; dependency archives and binaries are scanned as bytes.",
      "Private user-auth/profile locations are never read; only packaged paths are inspected."] };
}

export async function checkFixedBuild(directory) {
  const { readFile } = await import("node:fs/promises");
  const { openCoursewareBuildUpload } = await import(pathToFileURL(join(root, "apps/desktop/electron/main/courseware-build-files.ts")).href);
  const manifest = JSON.parse(await readFile(join(directory, "manifest.json"), "utf8"));
  const upload = await openCoursewareBuildUpload(directory, manifest.buildId);
  const members = [{ path: "manifest.json", bytes: upload.manifestBytes }, ...upload.files];
  const findings = members.flatMap(({ path, bytes }) => [...new Set([pathCategory(path), ...contentCategories(Buffer.from(bytes))].filter(Boolean))]
    .map((category) => ({ path, category, blocking: true })));
  const pptxExports = [];
  for (const { path, bytes } of members.filter(({ path }) => path.toLowerCase().endsWith(".pptx"))) {
    const inspected = await scanPptxExport(Buffer.from(bytes), path);
    pptxExports.push(inspected);
    findings.push(...inspected.findings);
  }
  return { directory, passed: findings.length === 0, buildId: manifest.buildId, manifestSha256: upload.manifestHash,
    files: members.map(({ path, bytes }) => ({ path, bytes: bytes.length, sha256: digest(bytes) })), findings, pptxExports,
    limit: "The allowlist prevents attaching arbitrary local files. PPTX members are decompressed and scanned for known signatures; nested embedded archives and arbitrary user-authored content still require review." };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const value = (flag) => { const index = args.indexOf(flag); return index < 0 ? null : args[index + 1]; };
  if (!value("--resources") || !value("--output")) throw new Error("Usage: --resources DIRECTORY --output REPORT.json [--fixed-build DIRECTORY]");
  const report = await scanPackage(value("--resources"));
  if (value("--fixed-build")) report.fixedBuild = await checkFixedBuild(value("--fixed-build"));
  await writeFile(value("--output"), JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify({ passed: report.passed && (report.fixedBuild?.passed ?? true), files: report.fileCount,
    links: report.linkCount, findings: report.findings, fixedBuild: report.fixedBuild && { passed: report.fixedBuild.passed, files: report.fixedBuild.files.length, findings: report.fixedBuild.findings } }));
  if (!report.passed || report.fixedBuild?.passed === false) process.exitCode = 1;
}
