import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFile as execFileCallback } from 'node:child_process';
import { builtinModules } from 'node:module';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { build } from 'esbuild';

const execFile = promisify(execFileCallback);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const provenance = JSON.parse(await readFile(path.join(root, 'authoring-provenance.json'), 'utf8'));
for (const entry of provenance.files) {
  assert.equal(createHash('sha256').update(await readFile(path.join(root, entry.path))).digest('hex'), entry.sha256, entry.path);
}
const graphs = JSON.parse(await readFile(path.join(root, 'dist/graphs.json'), 'utf8'));
const builtins = new Set(builtinModules.map(name => name.replace(/^node:/, '')));
assert(graphs.authoring.external.every(name => ['sharp', '@napi-rs/canvas'].includes(name) || builtins.has(name.replace(/^node:/, ''))), 'Authoring has an undeclared runtime dependency');
assert(graphs.authoring.inputs.every(name => !path.isAbsolute(name) && (!name.startsWith('../') || /^(?:\.\.\/)+node_modules\//.test(name))), 'Authoring imports another checkout');
const directory = await mkdtemp(path.join(tmpdir(), 'deckwise-authoring-'));
try {
  const runtime = path.join(directory, 'runtime');
  await execFile(process.execPath, [path.join(root, 'scripts/stage-worker.mjs'), runtime], { cwd: directory, timeout: 60_000 });
  if (process.platform === 'linux' && process.arch === 'x64') {
    const check = await execFile(process.execPath, [path.resolve(root, '../../scripts/stage-pptx-worker.mjs'), '--check', runtime]);
    assert.equal(JSON.parse(check.stdout).status, 'VERIFIED');
  }
  await build({
    absWorkingDir: root,
    entryPoints: ['tests/authoring-consumer.mjs'],
    outfile: path.join(runtime, 'verify.mjs'),
    bundle: true, platform: 'node', format: 'esm', target: 'node24',
    external: ['./authoring.mjs'],
    banner: { js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);" },
  });
  const result = await execFile(process.execPath, [path.join(runtime, 'verify.mjs')], {
    cwd: directory, timeout: 30_000,
    env: { ...process.env, NODE_PATH: '', NODE_OPTIONS: '' },
  });
  process.stdout.write(result.stdout);
  const manifest = JSON.parse(await readFile(path.join(runtime, 'manifest.json'), 'utf8'));
  assert(manifest.files.some(file => file.path === 'authoring.mjs'));
  assert(manifest.files.some(file => file.path === 'licenses/pptxgenjs/LICENSE'));
  console.log(`PASS relocated runtime with ${manifest.files.length} inventoried files; no source checkout, aliases or registry PPTXGenJS`);
} finally {
  await rm(directory, { recursive: true, force: true });
}
