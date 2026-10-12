#!/usr/bin/env node
/** Native PDF rendering under the production CSP, with isolated Electron data. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { repositoryRoot, resolveElectronBinary } from "./e2e/boot.mjs";

const root = repositoryRoot();
const { build } = createRequire(join(root, "packages/agent-runtime/package.json"))("esbuild");
const { electronBinary } = resolveElectronBinary(root);
const temp = await mkdtemp(join(tmpdir(), "deckwise-pdf-preview-"));
try {
  await build({
    entryPoints: [join(root, "apps/desktop/electron/main/fs-panel.ts")],
    outfile: join(temp, "preview.cjs"), bundle: true, platform: "node", format: "cjs",
  });
  const html = await readFile(join(root, "apps/desktop/index.html"), "utf8");
  const csp = html.match(/content="(default-src[^"]+)"/)?.[1];
  assert(csp, "production renderer CSP missing");
  await writeFile(join(temp, "index.html"),
    `<!doctype html><style>html,body,iframe{width:100%;height:100%;margin:0;border:0}</style><meta http-equiv="Content-Security-Policy" content="${csp.replace("frame-src 'self' data:", "frame-src 'self' data: blob:")}"><iframe id="pdf" title="PDF"></iframe>`);
  const pdfContent = "0 0 0 rg\n20 20 160 160 re\nf\n";
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Resources << >> /Contents 4 0 R >>",
    `<< /Length ${Buffer.byteLength(pdfContent)} >>\nstream\n${pdfContent}endstream`,
  ];
  let pdf = "%PDF-1.4\n";
  const offsets = objects.map((object, i) => {
    const offset = pdf.length;
    pdf += `${i + 1} 0 obj\n${object}\nendobj\n`;
    return offset;
  });
  pdf += "%".repeat(7 * 1024 * 1024) + "\n";
  const xref = pdf.length;
  pdf += "xref\n0 5\n0000000000 65535 f \n";
  pdf += offsets.map(offset => `${String(offset).padStart(10, "0")} 00000 n \n`).join("");
  pdf += `trailer\n<< /Size 5 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  await writeFile(join(temp, "preview.pdf"), pdf);
  await writeFile(join(temp, "main.cjs"), `
const { app, BrowserWindow } = require("electron");
const assert = require("node:assert/strict");
const path = require("node:path");
const { readOpenableFile } = require("./preview.cjs");
app.setPath("userData", path.join(__dirname, "profile"));
app.whenReady().then(async () => {
    const window = new BrowserWindow({ show: true, webPreferences: {
    sandbox: true, contextIsolation: true, nodeIntegration: false,
  } });
  try {
    const file = await readOpenableFile("preview.pdf", __dirname, []);
    assert.equal(file.kind, "pdf");
    await window.loadFile(path.join(__dirname, "index.html"));
    const loaded = new Promise((resolve, reject) => {
      window.webContents.on("did-frame-finish-load", () => {
        if (window.webContents.mainFrame.framesInSubtree.some(frame =>
          frame.url.startsWith("chrome-extension://") && frame.url.endsWith("/index.html"))) resolve();
      });
      window.webContents.on("did-fail-load", (_event, code, description) =>
        reject(new Error("PDF failed to load: " + code + " " + description)));
    });
    await window.webContents.executeJavaScript(
      "(() => { const raw = atob(" + JSON.stringify(file.dataUrl.split(",", 2)[1]) + "); const bytes = Uint8Array.from(raw, char => char.charCodeAt(0)); document.querySelector('#pdf').src = URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' })); })()");
    await loaded;
    await new Promise(resolve => setTimeout(resolve, 500));
    const capture = await window.webContents.capturePage();
    const bitmap = capture.toBitmap();
    const { width, height } = capture.getSize();
    const darkRows = new Set();
    for (let pixel = 0; pixel < width * height; pixel++) {
      if (bitmap[pixel * 4] < 32) darkRows.add(Math.floor(pixel / width));
    }
    assert.ok([...darkRows].some(y => y > 0),
      "PDF viewer painted no dark page content");
    console.log("PDF_PREVIEW_OK");
    app.quit();
  } catch (error) { console.error(error); app.exit(1); }
});
`);
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(electronBinary, [...process.argv.slice(2), join(temp, "main.cjs")], {
    env, stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  for (const stream of [child.stdout, child.stderr]) stream.on("data", data => { output += data; });
  const timeout = setTimeout(() => child.kill("SIGKILL"), 20_000);
  let code;
  try {
    code = await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("close", resolve);
    });
  } finally { clearTimeout(timeout); }
  assert.equal(code, 0, output.slice(-3000));
  assert.match(output, /PDF_PREVIEW_OK/);
  console.log("PDF_PREVIEW_OK: contained PDF -> production CSP -> Chromium PDF viewer");
} finally { await rm(temp, { recursive: true, force: true }); }
