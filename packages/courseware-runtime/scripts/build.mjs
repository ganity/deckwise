import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { build } from 'esbuild';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outdir = path.join(root, 'dist');
await mkdir(outdir, { recursive: true });
const graphs = {};
for (const [name, entry, platform] of [
  ['node', 'src/node.ts', 'node'],
  ['authoring', 'src/authoring.ts', 'node'],
  ['player', 'src/player.ts', 'browser'],
  ['pptx-worker', 'src/conversion/scripts/pptx-byte-worker.ts', 'node'],
]) {
  const result = await build({
    absWorkingDir: root, entryPoints: [entry], outfile: path.join(outdir, `${name}.mjs`),
    platform, bundle: true, format: 'esm', target: platform === 'node' ? 'node24' : 'chrome130',
    external: platform === 'node' ? ['sharp', '@napi-rs/canvas'] : ['react', 'react-dom', 'react/jsx-runtime'],
    banner: platform === 'node' ? { js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);" } : undefined,
    define: platform === 'browser' ? { 'process.env': '{}' } : undefined,
    metafile: true,
  });
  const inputs = Object.keys(result.metafile.inputs);
  assert(!inputs.some(file => /(?:^|\/)lib\/(store|server|api|ai|media|generation)\//.test(file)), 'Server or editor runtime entered the desktop module');
  const external = Object.values(result.metafile.outputs).flatMap(output => output.imports.filter(item => item.external).map(item => item.path));
  if (platform === 'browser') assert(external.every(item => /^(react|react-dom)(\/|$)/.test(item)), 'Privileged import entered player');
  if (name === 'player' || name === 'node' || name === 'pptx-worker') {
    assert(!inputs.some(file => file.startsWith('src/authoring/') || file.startsWith('vendor/pptxgenjs/')), 'Authoring entered conversion or playback');
  }
  graphs[name] = { inputs, external, outputs: result.metafile.outputs };
}
await writeFile(path.join(outdir, 'player.css'), await readFile(path.join(root, 'src/player.css')));
await writeFile(path.join(outdir, 'graphs.json'), JSON.stringify(graphs, null, 2));
console.log('PASS isolated desktop Node/authoring/player/worker bundles; no server or editor runtime');
