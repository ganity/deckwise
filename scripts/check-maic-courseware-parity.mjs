#!/usr/bin/env node
/** Fail-closed acceptance: real desktop journey plus the actual cloud-web Quiz consumer, without server publication. */
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { spawn, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { createServer } from "node:http";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { pathToFileURL } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const out = process.env.DECKWISE_E2E_OUTPUT ? resolve(process.env.DECKWISE_E2E_OUTPUT) : await mkdtemp(join(tmpdir(), "maic-parity-"));
await mkdir(out, { recursive: true });
const cloud = resolve(process.env.MAIC_CLOUD_WEB_ROOT || join(root, "../../cloud-web-trainwise"));
const maic = resolve(process.env.MAIC_SERVER_ROOT || join(root, "../../evo-trainwise-maic-server"));
const runtimeRequire = createRequire(new URL("../packages/courseware-runtime/package.json", import.meta.url));
const desktopRequire = createRequire(new URL("../apps/desktop/package.json", import.meta.url));
const cloudRequire = createRequire(join(cloud, "package.json"));
const { build } = runtimeRequire("esbuild");
const { chromium, expect } = runtimeRequire("@playwright/test");
const JSZip = runtimeRequire("jszip");
const revision = cwd => execFileSync("git", ["rev-parse", "HEAD"], { cwd, encoding: "utf8" }).trim();
const changedPaths = execFileSync("git", ["ls-files", "--modified", "--others", "--exclude-standard", "-z"], { cwd: root, encoding: "utf8" })
  .split("\0").filter(path => /\.(?:tsx?|m?js|css|rs|json)$/.test(path)).sort();
const fingerprints = await Promise.all(changedPaths.map(async path => ({ path, sha256: createHash("sha256").update(await readFile(join(root, path))).digest("hex") })));
const sourceFingerprint = createHash("sha256").update(JSON.stringify(fingerprints)).digest("hex");
const report = { status: "RUNNING", revisions: { deckwise: revision(root), maic: revision(maic), cloudWeb: revision(cloud) }, checks: [],
  workingSource: { dirty: fingerprints.length > 0, sha256: sourceFingerprint, files: fingerprints },
  artifacts: [], limitations: ["Publication signatures require the MAIC server publisher; this test exports unsigned local content.", "Native-backed PPT generation/save/reorder is tested by the separate generator integration gate."] };
let browser, server;
function run(file, env) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(process.execPath, [file], { cwd: root, env: { ...process.env, ...env }, stdio: "inherit" });
    child.on("error", reject);
    child.on("exit", (code, signal) => code === 0 ? resolveRun() : reject(new Error(`${file} failed (${code ?? signal})`)));
  });
}
const step = async (name, action) => { console.log("START", name); await action(); report.checks.push(name); console.log("PASS", name); };
try {
  const electronOut = join(out, "electron");
  await step("Actual Electron/Main/Host editing, uploads, undo, restart and export", async () => {
    try { await run(join(root, "scripts/e2e-maic-courseware.mjs"), { DECKWISE_E2E_OUTPUT: electronOut }); }
    finally {
      if (existsSync(join(electronOut, "report.json"))) report.electron = JSON.parse(await readFile(join(electronOut, "report.json"), "utf8"));
    }
    assert.equal(report.electron?.status, "PASS"); assert(report.electron.checks.length >= 10);
  });
  const quizSource = join(cloud, "components/scene-renderers/quiz-view.tsx");
  const authority = await readFile(quizSource, "utf8");
  const runtimeCard = await readFile(join(root, "packages/courseware-runtime/src/player/components/courseware/MaicInstantQuizCard.tsx"), "utf8");
  report.referenceQuizSha256 = createHash("sha256").update(authority).digest("hex");
  const exported = await JSZip.loadAsync(await readFile(join(electronOut, "mixed.zip")));
  const meta = JSON.parse(await exported.file("meta.json").async("string"));
  await step("Actual MAIC asset normalization and package projection preserve the exported mixed course", async () => {
    const exporterPath = join(maic, "lib/server/classroom-package-export.ts");
    const source = await readFile(exporterPath, "utf8");
    const output = join(out, "maic-consumer.mjs");
    const serviceNames = new Map();
    for (const match of source.matchAll(/import\s*\{([^}]+)\}\s*from\s*["']([^"']+)["']/g)) {
      if (/^@\/lib\/(?:server\/(?:classroom-storage|trainwise-sync|oss-client)|logger)$/.test(match[2]))
        serviceNames.set(match[2], match[1].split(",").map(name => name.trim()).filter(Boolean));
    }
    await build({ stdin: { contents: `export {buildPackagedClassroom} from 'authority-package'; export {normalizeClassroomAssetManifests} from '${join(maic, "lib/server/classroom-asset-manifests.ts")}';`, resolveDir: maic, loader: "ts" },
      outfile: output, bundle: true, format: "esm", platform: "node", packages: "external", treeShaking: true, plugins: [{ name: "maic-package-consumer", setup(builder) {
        builder.onResolve({ filter: /^authority-package$/ }, () => ({ path: exporterPath, namespace: "package-authority" }));
        builder.onLoad({ filter: /.*/, namespace: "package-authority" }, () => ({ contents: `${source}\nexport {buildPackagedClassroom};`, loader: "ts", resolveDir: maic }));
        builder.onResolve({ filter: /^@\// }, async args => {
          if (serviceNames.has(args.path)) return { path: args.path, namespace: "package-service" };
          return builder.resolve(join(maic, args.path.slice(2)), { resolveDir: maic, kind: args.kind });
        });
        builder.onLoad({ filter: /.*/, namespace: "package-service" }, args => ({ contents: serviceNames.get(args.path).map(name => name === "createLogger"
          ? "export const createLogger=()=>({info(){},warn(){},error(){},debug(){}});"
          : `export const ${name}=()=>{throw Error('Unexpected publication service: ${name}')};`).join("\n"), loader: "js" }));
      } }] });
    // Resolve external installed dependencies relative to the reference repository without changing it.
    const bundled = await readFile(output, "utf8");
    const maicRequire = createRequire(join(maic, "package.json"));
    await writeFile(output, bundled.replace(/from (["'])([^"'.][^"']*)\1/g, (text, quote, specifier) =>
      specifier.startsWith("node:") || ["fs", "path", "crypto", "buffer", "stream", "util"].includes(specifier) ? text : `from ${quote}${pathToFileURL(maicRequire.resolve(specifier)).href}${quote}`));
    const consumer = await import(pathToFileURL(output).href);
    const manifests = consumer.normalizeClassroomAssetManifests(meta.classroom);
    const projected = consumer.buildPackagedClassroom(meta.classroom, manifests);
    assert.equal(projected.scenes.length, meta.classroom.scenes.length);
    assert.deepEqual(projected.scenes.map(scene => [scene.id, scene.type, scene.order]), meta.classroom.scenes.map(scene => [scene.id, scene.type, scene.order]));
    const beforeQuiz = meta.classroom.scenes.find(scene => scene.type === "quiz").content.questions[0];
    const afterQuiz = projected.scenes.find(scene => scene.type === "quiz").content.questions[0];
    for (const key of ["id", "type", "question", "answer", "analysis", "hasAnswer", "points"]) assert.deepEqual(afterQuiz[key], beforeQuiz[key]);
    assert.deepEqual(afterQuiz.options.map(option => [option.value, option.label, option.image?.src]), beforeQuiz.options.map(option => [option.value, option.label, option.image?.src]));
    const beforeInteraction = meta.classroom.scenes.find(scene => scene.actions?.some(action => action.type === "interaction_checkpoint"))
      ?.actions.find(action => action.type === "interaction_checkpoint");
    const afterInteraction = projected.scenes.find(scene => scene.actions?.some(action => action.type === "interaction_checkpoint"))
      ?.actions.find(action => action.type === "interaction_checkpoint");
    assert(beforeInteraction && afterInteraction, "Interaction checkpoint missing from MAIC package projection");
    for (const key of ["question", "constraintPrompt", "referenceAnswer", "context"]) assert.deepEqual(afterInteraction[key], beforeInteraction[key]);
    const path = join(out, "maic-consumer-projection.json"); await writeFile(path, JSON.stringify(projected, null, 2)); report.artifacts.push(path);
  });
  const question = structuredClone(meta.classroom.scenes.find(scene => scene.type === "quiz").content.questions[0]);
  for (const image of [question.image, ...question.options.map(option => option.image)].filter(Boolean)) {
    const entry = exported.file(image.src); assert(entry, "Reference consumer image missing");
    image.src = `data:${image.mimeType};base64,${await entry.async("base64")}`;
  }
  const stubExports = new Map();
  for (const match of authority.matchAll(/import\s*\{([^}]+)\}\s*from\s*["']([^"']+)["']/g)) {
    if (!match[2].startsWith("@/")) continue;
    stubExports.set(match[2], match[1].split(",").map(name => name.trim().replace(/^type\s+/, "").split(/\s+as\s+/)[0]).filter(Boolean));
  }
  const bundle = join(out, "consumer.js");
  await step("Bundle actual cloud-web consumer and retained grading helpers", async () => {
    await build({ stdin: { contents: `import React from 'react'; import {createRoot} from 'react-dom/client';
      import {ClassroomInstantSingleQuestionView,gradeChoiceQuestions,buildShortAnswerCommentPrompt} from 'cloud-authority';
      import {MaicInstantQuizCard} from '${join(root, "packages/courseware-runtime/src/player/components/courseware/MaicInstantQuizCard.tsx")}';
      const question=${JSON.stringify(question)}; const root=createRoot(document.getElementById('root')); let epoch=0;
      window.grade=answer=>gradeChoiceQuestions([question],{[question.id]:answer})[0];
      const assessment=${JSON.stringify(meta.classroom.scenes.find(scene => scene.content.interactionMode === "assessment_review")?.content.questions)};
      window.assess=(type,answer)=>{const q=assessment.find(q=>q.type===type);return gradeChoiceQuestions([q],{[q.id]:answer})[0]};
      window.shortAnswerPrompt=()=>buildShortAnswerCommentPrompt(assessment.find(q=>q.type==='short_answer'));
      window.render=which=>root.render(which==='cloud'?<ClassroomInstantSingleQuestionView key={++epoch} questions={[question]} sceneId="consumer"/>:<div data-maic-quiz-card style={{height:'100%'}}><MaicInstantQuizCard question={question} onAnswer={()=>{}}/></div>);
      window.render('cloud');`, loader: "tsx", resolveDir: cloud },
      outfile: bundle, bundle: true, format: "esm", platform: "browser", jsx: "automatic", treeShaking: true,
      define: { "process.env.NODE_ENV": '"production"' }, plugins: [{ name: "reference-consumer-boundaries", setup(builder) {
        builder.onResolve({ filter: /^cloud-authority$/ }, () => ({ path: quizSource, namespace: "authority" }));
        builder.onLoad({ filter: /.*/, namespace: "authority" }, () => ({ contents: `${authority}\nexport {ClassroomInstantSingleQuestionView};`, loader: "tsx", resolveDir: cloud }));
        // Both consumers must use one React instance. Services are unreachable in this pure reference view.
        builder.onResolve({ filter: /^react(?:-dom)?(?:\/.*)?$/ }, args => ({ path: desktopRequire.resolve(args.path) }));
        builder.onResolve({ filter: /^@\// }, args => {
          if (args.path === "@/lib/utils") return { path: join(cloud, "lib/utils/cn.ts") };
          if (args.path === "@/lib/hooks/use-draft-cache") return { path: join(cloud, "lib/hooks/use-draft-cache.ts") };
          return { path: args.path, namespace: "service" };
        });
        builder.onLoad({ filter: /.*/, namespace: "service" }, args => ({ contents: (stubExports.get(args.path) ?? []).map(name => name === "createLogger"
          ? "export const createLogger=()=>({info(){},warn(){},error(){},debug(){}});"
          : `export const ${name}=()=>{throw Error('Unexpected reference service invocation: ${name}')};`).join("\n"), loader: "js" }));
      } }] });
    const { compile } = cloudRequire("@tailwindcss/node");
    const compiler = await compile('@import "tailwindcss"; @custom-variant dark (&:is(.dark *));', { base: cloud, onDependency() {} });
    const candidates = [...authority.matchAll(/["'`]([^"'`\n]+)["'`]/g), ...runtimeCard.matchAll(/["'`]([^"'`\n]+)["'`]/g)]
      .flatMap(match => match[1].split(/\s+/));
    await writeFile(join(out, "consumer.css"), compiler.build(candidates));
  });
  server = createServer(async (request, response) => {
    const file = request.url === "/consumer.js" ? "consumer.js" : request.url === "/consumer.css" ? "consumer.css" : null;
    response.setHeader("content-type", file?.endsWith("js") ? "text/javascript" : file ? "text/css" : "text/html");
    response.end(file ? await readFile(join(out, file)) : '<!doctype html><html lang="zh-CN"><meta charset="utf-8"><link rel="stylesheet" href="/consumer.css"><style>html,body,#root{height:100%;width:100%;margin:0;font-family:Arial,sans-serif}</style><div id="root"></div><script type="module" src="/consumer.js"></script></html>');
  });
  await new Promise(resolveServer => server.listen(0, "127.0.0.1", resolveServer));
  const chrome = process.env.CHROME_BIN || (existsSync("/usr/bin/google-chrome") ? "/usr/bin/google-chrome" : undefined);
  browser = await chromium.launch({ headless: true, args: ["--no-sandbox"], ...(chrome ? { executablePath: chrome } : {}) });
  const page = await browser.newPage(); const errors = []; page.on("pageerror", error => errors.push(error.stack));
  await step("Actual cloud-web consumer accepts exported image questions and stable answers", async () => {
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    await expect(page.locator("h3")).toHaveText(question.question);
    await expect(page.locator("img")).toHaveCount(3);
    await page.waitForFunction(() => [...document.images].every(image => image.complete && image.naturalWidth > 0));
    assert.equal((await page.evaluate(() => window.grade("A"))).correct, true);
    assert.equal((await page.evaluate(() => window.grade("B"))).correct, false);
    await page.getByRole("button", { name: /B.*Bye/ }).click();
    await expect(page.locator("button.border-red-300")).toHaveCount(1);
    await page.getByRole("button", { name: /A.*Hello/ }).click();
    await expect(page.locator("button.border-emerald-300")).toHaveCount(1);
  });
  await step("Actual cloud-web assessment consumes multiple/judge answers and edited short-answer guidance", async () => {
    assert.equal((await page.evaluate(() => window.assess("multiple", ["B", "A"]))).correct, true);
    assert.equal((await page.evaluate(() => window.assess("multiple", ["A"]))).correct, false);
    assert.equal((await page.evaluate(() => window.assess("judge", "T"))).correct, true);
    assert.equal((await page.evaluate(() => window.assess("judge", "F"))).correct, false);
    const prompt = await page.evaluate(() => window.shortAnswerPrompt());
    assert(prompt?.includes("Hello, my name is Pandy."), "Edited reference answer did not reach cloud-web grading prompt");
    assert(prompt.includes("认可正确问候和自己的姓名。"), "Edited assessment guidance was lost");
    const short = meta.classroom.scenes.find(scene => scene.content.interactionMode === "assessment_review").content.questions.find(q => q.type === "short_answer");
    assert.deepEqual(short.keyPoints, ["问候语", "姓名"]);
  });
  for (const viewport of [{ width: 1844, height: 908 }, { width: 1280, height: 800 }]) {
    await step(`Reference and runtime card geometry agree at ${viewport.width}x${viewport.height}`, async () => {
      await page.setViewportSize(viewport);
      const measurements = [];
      for (const mode of ["cloud", "runtime"]) {
        await page.evaluate(mode => window.render(mode), mode);
        await expect(page.locator("h3")).toHaveText(question.question);
        await page.waitForFunction(() => [...document.images].every(image => image.complete && image.naturalWidth > 0));
        const path = join(out, `${mode}-${viewport.width}.png`); await page.screenshot({ path }); report.artifacts.push(path);
        measurements.push(await page.locator("h3,img,button").evaluateAll(elements => elements.map(element => {
          const rect = element.getBoundingClientRect(); return { tag: element.tagName, text: element.tagName === "IMG" ? "image" : element.textContent, x: rect.x, y: rect.y, width: rect.width, height: rect.height };
        })));
      }
      assert.equal(measurements[0].length, measurements[1].length);
      measurements[0].forEach((reference, index) => {
        const actual = measurements[1][index]; assert.equal(actual.tag, reference.tag); assert.equal(actual.text, reference.text);
        for (const key of ["x", "y", "width", "height"]) assert(Math.abs(reference[key] - actual[key]) <= 2, `${index}.${key}: cloud=${reference[key]}, runtime=${actual[key]}`);
      });
    });
  }
  assert.deepEqual(errors, []); assert(report.checks.length >= 5); report.status = "PASS";
} catch (error) { report.status = "FAIL"; report.error = error.stack; process.exitCode = 1;
} finally {
  await browser?.close(); if (server) await new Promise(resolveServer => server.close(resolveServer));
  await writeFile(join(out, "parity-report.json"), JSON.stringify(report, null, 2));
  console.log(`${report.status} MAIC parity: ${out}`);
}
