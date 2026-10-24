import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveElectronBinary } from './e2e/boot.mjs';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
assert((process.argv.length === 2 || (process.argv.length === 3 && ['--visual-review', '--redo-candidate'].includes(process.argv[2]))) && process.env.DECKWISE_E2E_OUTPUT && process.env.DECKWISE_EDITOR_URL && process.env.DECKWISE_E2E_PPTX);
const visualReview = ['--visual-review', '--redo-candidate'].includes(process.argv[2]);
const editorUrl = new URL(process.env.DECKWISE_EDITOR_URL);
assert.equal(editorUrl.hostname, '127.0.0.1'); assert.equal(editorUrl.protocol, 'http:');
const output = resolve(process.env.DECKWISE_E2E_OUTPUT);
await mkdir(output);
const temporary = await mkdtemp(join(tmpdir(), 'deckwise-source-preview-'));
try {
  const { build } = createRequire(join(root, 'packages/courseware-runtime/package.json'))('esbuild');
  const entry = join(temporary, 'preview.cjs');
  await build({ absWorkingDir: root, entryPoints: [visualReview ? 'apps/desktop/test/courseware-visual-review.electron.ts' : 'apps/desktop/test/courseware-source-preview.electron.ts'], outfile: entry,
    bundle: true, platform: 'node', format: 'cjs', target: 'node24', external: ['electron'],
    define: { __dirname: JSON.stringify(join(root, 'apps/desktop/out/main')), 'import.meta.url': JSON.stringify(new URL('./e2e/host.mjs', import.meta.url).href) } });
  const { electronBinary } = resolveElectronBinary(root);
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/api.?key|secret|token|password|proxy/i.test(key)));
  let log = '';
  const child = spawn(electronBinary, ['--no-sandbox', entry], { cwd: root, timeout: 150_000, killSignal: 'SIGKILL',
    env: { ...env, ELECTRON_RUN_AS_NODE: '', DECKWISE_E2E_REDO: process.argv[2] === '--redo-candidate' ? '1' : '', DECKWISE_E2E_TEMP: temporary, DECKWISE_E2E_OUTPUT: output, DECKWISE_E2E_APP: join(root, 'apps/desktop') }, stdio: ['ignore','pipe','pipe'] });
  for (const stream of [child.stdout, child.stderr]) stream.on('data', bytes => { log += String(bytes); process.stdout.write(bytes); });
  const status = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); });
  await writeFile(join(output, 'electron.log'), log);
  assert.equal(status, 0, 'Actual Main/Office preview failed; inspect retained output');
} finally { await rm(temporary, { recursive: true, force: true }); }
