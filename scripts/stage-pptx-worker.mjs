import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cp, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm } from 'node:fs/promises';
import path from 'node:path';

const checkOnly = process.argv[2] === '--check';
const [bundleArgument, destinationArgument] = process.argv.slice(checkOnly ? 3 : 2);
assert(
  bundleArgument && (checkOnly || destinationArgument) && process.argv.length === 4,
  'Supply the Linux worker bundle and a new destination directory, or --check and the bundle',
);
assert(path.isAbsolute(bundleArgument));
if (!checkOnly) assert(path.isAbsolute(destinationArgument));

const bundle = await realpath(bundleArgument);
assert((await lstat(path.join(bundle, 'manifest.json'))).isFile(), 'Manifest must be a regular file');
const manifest = JSON.parse(await readFile(path.join(bundle, 'manifest.json'), 'utf8'));
assert.equal(manifest.status, 'LOCAL_LINUX_WORKER_BUNDLE');
assert.equal(manifest.platform, 'linux');
assert.equal(manifest.arch, 'x64');
assert(Array.isArray(manifest.files) && manifest.files.length > 0);

const expected = new Map();
for (const entry of manifest.files) {
  assert(
    typeof entry.path === 'string' &&
      entry.path.length > 0 &&
      entry.path !== 'manifest.json' &&
      !entry.path.startsWith('/') &&
      !entry.path.includes('\\') &&
      entry.path.split('/').every((part) => part && part !== '.' && part !== '..'),
    `Invalid bundle path: ${entry.path}`,
  );
  assert(!expected.has(entry.path), `Duplicate bundle path: ${entry.path}`);
  const file = path.join(bundle, ...entry.path.split('/'));
  assert.equal(await realpath(file), file, `Unexpected symlink: ${entry.path}`);
  const metadata = await lstat(file);
  assert(metadata.isFile(), `Not a regular file: ${entry.path}`);
  const content = await readFile(file);
  assert.equal(content.length, entry.bytes, `Size mismatch: ${entry.path}`);
  assert.equal(
    createHash('sha256').update(content).digest('hex'),
    entry.sha256,
    `Hash mismatch: ${entry.path}`,
  );
  expected.set(entry.path, true);
}
assert(expected.has('pptx-worker.mjs'), 'Bundle is missing the worker entry');

async function inventory(directory, prefix = '') {
  const found = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    const file = path.join(directory, entry.name);
    assert(!entry.isSymbolicLink(), `Unexpected symlink: ${relative}`);
    if (entry.isDirectory()) found.push(...(await inventory(file, relative)));
    else if (entry.isFile()) {
      if (relative !== 'manifest.json') found.push(relative);
    } else assert.fail(`Unexpected bundle entry: ${relative}`);
  }
  return found;
}

const actual = await inventory(bundle);
assert.equal(actual.length, expected.size, 'Bundle contains unlisted files');
for (const file of actual) assert(expected.has(file), `Unlisted bundle file: ${file}`);

if (checkOnly) {
  console.log(JSON.stringify({ bundle, files: expected.size, status: 'VERIFIED' }));
  process.exit(0);
}

const destination = path.resolve(destinationArgument);
const relativeDestination = path.relative(bundle, destination);
assert(
  relativeDestination === '..' || relativeDestination.startsWith(`..${path.sep}`) || path.isAbsolute(relativeDestination),
  'Destination must be outside the bundle',
);
const parent = path.dirname(destination);
await mkdir(parent, { recursive: true });
try {
  await lstat(destination);
  assert.fail(`Destination already exists: ${destination}`);
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
}
const temporary = await mkdtemp(path.join(parent, '.pptx-worker-stage-'));
try {
  await cp(bundle, temporary, { recursive: true, dereference: false });
  await rename(temporary, destination);
  console.log(JSON.stringify({ destination, files: expected.size, status: 'STAGED' }));
} catch (error) {
  await rm(temporary, { recursive: true, force: true });
  throw error;
}
