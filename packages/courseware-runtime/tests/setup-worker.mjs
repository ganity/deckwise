import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

export default async function setup() {
  if (process.env.DECKWISE_NATIVE_WORKER_DIRECTORY) return;
  const directory = await mkdtemp(join(tmpdir(), 'courseware-test-worker-'));
  const worker = join(directory, 'worker');
  try {
    await promisify(execFile)(process.execPath, [
      fileURLToPath(new URL('../scripts/stage-worker.mjs', import.meta.url)), worker,
    ]);
    process.env.DECKWISE_NATIVE_WORKER_DIRECTORY = worker;
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
  return async () => {
    delete process.env.DECKWISE_NATIVE_WORKER_DIRECTORY;
    await rm(directory, { recursive: true, force: true });
  };
}
