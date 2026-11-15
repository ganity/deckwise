import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { lstat, readFile, readdir, readlink, writeFile } from 'node:fs/promises';
import path from 'node:path';

const [root, output, mode] = process.argv.slice(2);
assert(root && path.isAbsolute(root) && output && ['source', 'stable-source', 'built'].includes(mode));
const paths = mode !== 'built' ? [
  'apps/desktop/electron', 'apps/desktop/src', 'apps/desktop/runtime',
  'apps/desktop/resources/editor-host', 'apps/desktop/resources/skills',
  'apps/desktop/package.json', 'apps/desktop/electron.vite.config.ts',
  'apps/desktop/courseware-player.html', 'apps/desktop/index.html',
  'packages/shared/src', 'packages/i18n/src', 'packages/agent-runtime/src',
  'packages/agent-runtime/package.json',
  'packages/courseware-runtime/src', 'packages/courseware-runtime/vendor',
  'packages/courseware-runtime/scripts', 'packages/courseware-runtime/authoring-provenance.json',
  'crates/host-core/src', 'crates/host-core/Cargo.toml', 'Cargo.lock',
  'scripts/stage-pptx-worker.mjs', 'scripts/prepare-ppt-master.mjs', 'pnpm-lock.yaml',
] : [
  'target/release/pi-desktop-host-core', 'packages/shared/dist', 'packages/i18n/dist',
  'packages/agent-runtime/dist-bundle', 'packages/courseware-runtime/dist',
  'apps/desktop/out', 'apps/desktop/resources/pptx-worker',
  'apps/desktop/resources/editor-host', 'apps/desktop/resources/skills',
  'apps/desktop/resources/plugins', 'apps/desktop/resources/models.dev',
];
const files = {};
async function visit(relative) {
  if (mode !== 'built' && /(?:\.test\.|\/tests?\/|(?:^|\/)(?:tests|[^/]+_tests)\.rs$)/.test(relative)) return;
  if (mode === 'stable-source' && relative.startsWith('packages/courseware-runtime/')) return;
  const file = path.join(root, relative), stat = await lstat(file);
  if (stat.isDirectory()) {
    for (const name of (await readdir(file)).sort()) await visit(`${relative}/${name}`);
  } else if (stat.isSymbolicLink()) files[relative] = { symlink: await readlink(file) };
  else {
    assert(stat.isFile(), relative);
    const bytes = await readFile(file);
    files[relative] = { bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
  }
}
for (const relative of paths) await visit(relative);
const digest = createHash('sha256').update(JSON.stringify(files)).digest('hex');
await writeFile(output, JSON.stringify({ root, mode, files, sha256: digest }, null, 2) + '\n', { flag: 'wx' });
console.log(JSON.stringify({ mode, files: Object.keys(files).length, sha256: digest, output }));
