import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { adaptCanonicalSnapshot, buildFixedCourseware, FixedBuildError } from '../dist/node.mjs';
const [inputFile, workerDirectory, outputDirectory] = process.argv.slice(2);
assert(inputFile && workerDirectory && outputDirectory, 'Usage: node scripts/build-canonical.mjs input.json workerDirectory outputDirectory');
const { project, snapshot, files } = JSON.parse(await readFile(inputFile, 'utf8'));
const controller = new AbortController();
let exitCode;
const interrupt = () => { exitCode = 130; controller.abort(); };
const terminate = () => { exitCode = 143; controller.abort(); };
process.once('SIGINT', interrupt);
process.once('SIGTERM', terminate);
try {
  const result = await buildFixedCourseware(adaptCanonicalSnapshot(project, snapshot, files), {
    workerDirectory: path.resolve(workerDirectory), outputDirectory: path.resolve(outputDirectory),
    signal: controller.signal,
  });
  // A cancellation after publication must not print an adoptable receipt for the interrupted job.
  if (controller.signal.aborted) throw new FixedBuildError('BUILD_CANCELLED');
  console.log(JSON.stringify({ ...result, buildRef: { buildId: result.buildId, snapshotId: snapshot.snapshotId, packageSha256: result.packageHash } }, null, 2));
} catch (error) {
  if (!(error instanceof FixedBuildError) || error.code !== 'BUILD_CANCELLED') throw error;
  console.error(error.code);
  process.exitCode = exitCode ?? 1;
} finally {
  process.removeListener('SIGINT', interrupt);
  process.removeListener('SIGTERM', terminate);
}
