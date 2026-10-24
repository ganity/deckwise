import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cp, mkdir, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = process.argv[2];
assert(output && path.isAbsolute(output), 'Supply a new absolute worker directory');
await mkdir(output);
const packages = new Map();
async function copy(name, require, optional = false) {
  let source;
  for (const parent of require.resolve.paths(name) ?? []) {
    try { source = await realpath(path.join(parent, name)); break; } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  if (!source) { assert(optional, `Missing worker dependency: ${name}`); return; }
  const pkg = JSON.parse(await readFile(path.join(source, 'package.json'), 'utf8'));
  if (optional && ((pkg.os && !pkg.os.includes(process.platform)) || (pkg.cpu && !pkg.cpu.includes(process.arch)))) return;
  if (packages.has(name)) { assert.equal(packages.get(name), pkg.version); return; }
  packages.set(name, pkg.version);
  await cp(source, path.join(output, 'node_modules', name), { recursive: true, dereference: true, filter: file => path.basename(file) !== 'node_modules' });
  const childRequire = createRequire(path.join(source, 'package.json'));
  for (const dependency of Object.keys(pkg.dependencies ?? {})) await copy(dependency, childRequire);
  for (const dependency of Object.keys(pkg.optionalDependencies ?? {})) await copy(dependency, childRequire, true);
}
try {
  await cp(path.join(root, 'dist/pptx-worker.mjs'), path.join(output, 'pptx-worker.mjs'));
  await cp(path.join(root, 'dist/authoring.mjs'), path.join(output, 'authoring.mjs'));
  await mkdir(path.join(output, 'licenses/pptxgenjs'), { recursive: true });
  await cp(path.join(root, 'vendor/pptxgenjs/LICENSE'), path.join(output, 'licenses/pptxgenjs/LICENSE'));
  await cp(path.join(root, 'authoring-provenance.json'), path.join(output, 'authoring-provenance.json'));
  for (const name of ['sharp', '@napi-rs/canvas', '@fontsource/abeezee']) await copy(name, createRequire(import.meta.url));
  const files = [];
  async function inventory(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      assert(!entry.isSymbolicLink());
      if (entry.isDirectory()) await inventory(file);
      else { const bytes = await readFile(file); files.push({ path: path.relative(output, file), bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }); }
    }
  }
  await inventory(output);
  await writeFile(path.join(output, 'manifest.json'), JSON.stringify({ schemaVersion: 'deckwise-local-worker/1', status: process.platform === 'linux' && process.arch === 'x64' ? 'LOCAL_LINUX_WORKER_BUNDLE' : 'LOCAL_NATIVE_WORKER_BUNDLE', platform: process.platform, arch: process.arch, nativePackages: Object.fromEntries(packages), files }, null, 2));
  console.log(JSON.stringify({ files: files.length, bytes: files.reduce((sum, file) => sum + file.bytes, 0) }));
} catch (error) { await rm(output, { recursive: true, force: true }); throw error; }
