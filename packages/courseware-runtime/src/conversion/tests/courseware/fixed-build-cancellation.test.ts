import { mkdtemp, readFile, readdir, rm, stat, watch, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest';
import { buildFixedCourseware, sha256 } from '../../lib/courseware/fixed-build';
import { adaptCanonicalSnapshot } from '../../lib/courseware/adapt-canonical-snapshot';

const io = vi.hoisted(() => ({
  afterWrite: undefined as ((file: string) => void) | undefined,
  afterRead: undefined as ((file: string) => void) | undefined,
  beforeRename: undefined as (() => void) | undefined,
}));
vi.mock('node:fs/promises', async (importOriginal) => {
  const fs = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...fs,
    readFile: async (...args: Parameters<typeof fs.readFile>) => {
      const bytes = await fs.readFile(...args);
      io.afterRead?.(String(args[0]));
      return bytes;
    },
    writeFile: async (...args: Parameters<typeof fs.writeFile>) => {
      await fs.writeFile(...args);
      io.afterWrite?.(String(args[0]));
    },
    rename: async (...args: Parameters<typeof fs.rename>) => {
      io.beforeRename?.();
      return fs.rename(...args);
    },
  };
});

const workerDirectory = path.resolve(process.env.DECKWISE_NATIVE_WORKER_DIRECTORY ?? '../../apps/desktop/resources/pptx-worker');
let outputDirectory: string;
let input: ReturnType<typeof adaptCanonicalSnapshot>;
let valid: Awaited<ReturnType<typeof buildFixedCourseware>>;
let validPackage: Buffer;
beforeAll(async () => {
  const fixtureDirectory = path.resolve('tests/fixtures/fixed-courseware');
  const fixture = JSON.parse(await readFile(path.join(fixtureDirectory, 'canonical-desktop.json'), 'utf8'));
  fixture.files.sourcePath = path.join(fixtureDirectory, 'lesson-r8.pptx');
  fixture.files.assets.forEach((asset: { path: string }, index: number) => {
    asset.path = path.join(fixtureDirectory, `page-${index + 1}.wav`);
  });
  input = adaptCanonicalSnapshot(fixture.project, fixture.snapshot, fixture.files);
  input.converter.manifestSha256 = sha256(await readFile(path.join(workerDirectory, 'manifest.json')));
  outputDirectory = await mkdtemp(path.join(os.tmpdir(), 'fixed-cancellation-'));
  valid = await buildFixedCourseware(input, { workerDirectory, outputDirectory });
  validPackage = await readFile(path.join(valid.directory, 'package.json'));
}, 30_000);
afterEach(() => { io.afterWrite = io.afterRead = io.beforeRename = undefined; });
afterAll(async () => { if (outputDirectory) await rm(outputDirectory, { recursive: true, force: true }); });

it('rejects an already cancelled job before worker or output access', async () => {
  const controller = new AbortController();
  controller.abort();
  const neverCreated = path.join(outputDirectory, 'never-created');
  await expect(buildFixedCourseware(input, {
    workerDirectory: path.join(outputDirectory, 'missing-worker'),
    outputDirectory: neverCreated,
    signal: controller.signal,
  })).rejects.toMatchObject({ code: 'BUILD_CANCELLED' });
  await expect(stat(neverCreated)).rejects.toMatchObject({ code: 'ENOENT' });
});

it('cancels during pinned-worker verification before creating output', async () => {
  const controller = new AbortController();
  const neverCreated = path.join(outputDirectory, 'never-created');
  io.afterRead = file => { if (file === path.join(workerDirectory, 'manifest.json')) controller.abort(); };
  await expect(buildFixedCourseware(input, {
    workerDirectory, outputDirectory: neverCreated, signal: controller.signal,
  })).rejects.toMatchObject({ code: 'BUILD_CANCELLED' });
  await expect(stat(neverCreated)).rejects.toMatchObject({ code: 'ENOENT' });
});

it('cancels a source read and removes staging without affecting the previous package', async () => {
  const controller = new AbortController();
  io.afterRead = file => { if (file === input.source.path) controller.abort(); };
  await expect(buildFixedCourseware(input, {
    workerDirectory, outputDirectory, signal: controller.signal,
  })).rejects.toMatchObject({ code: 'BUILD_CANCELLED' });
  expect(await readdir(outputDirectory)).toEqual([valid.buildId]);
});

it('keeps content identity unchanged with an active cancellation signal', async () => {
  const result = await buildFixedCourseware(input, {
    workerDirectory, outputDirectory, signal: new AbortController().signal,
  });
  expect(result.buildId).toBe(valid.buildId);
  expect(await readFile(path.join(result.directory, 'package.json'))).toEqual(validPackage);
});

it('does not roll back a published immutable package when cancellation arrives at commit', async () => {
  const controller = new AbortController();
  const changed = structuredClone(input);
  changed.teaching.revision = 'cancel-after-publication-starts';
  io.beforeRename = () => controller.abort();
  const result = await buildFixedCourseware(changed, {
    workerDirectory, outputDirectory, signal: controller.signal,
  });
  expect(controller.signal.aborted).toBe(true);
  expect(sha256(await readFile(path.join(result.directory, 'package.json')))).toBe(result.buildId);
  expect(await readdir(outputDirectory)).toEqual(expect.arrayContaining([valid.buildId, result.buildId]));
  await rm(result.directory, { recursive: true });
});

async function within<T>(promise: Promise<T>, phase: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`${phase} deadline exceeded`)), 5000);
  });
  try { return await Promise.race([promise, deadline]); }
  finally { clearTimeout(timer); }
}

it('waits for a real cancelled child to exit before cleaning its files', async () => {
  const controlledWorker = await mkdtemp(path.join(os.tmpdir(), 'fixed-controlled-worker-'));
  const script = `import {writeFileSync} from 'node:fs';
process.on('SIGTERM', () => {});
writeFileSync(new URL('./worker-started-' + process.pid, import.meta.url), '');
setTimeout(() => process.exit(24), 8000);`;
  await writeFile(path.join(controlledWorker, 'pptx-worker.mjs'), script);
  const manifest = JSON.stringify({ files: [{ path: 'pptx-worker.mjs', sha256: sha256(script) }] });
  await writeFile(path.join(controlledWorker, 'manifest.json'), manifest);
  const changed = structuredClone(input);
  changed.converter.manifestSha256 = sha256(manifest);
  const controller = new AbortController();
  const monitor = new AbortController();
  const events = watch(controlledWorker, { signal: monitor.signal });
  const started = (async () => {
    for await (const event of events) {
      const match = /worker-started-(\d+)$/.exec(String(event.filename));
      if (match) return Number(match[1]);
    }
    throw new Error('Worker did not announce startup');
  })();
  const pending = buildFixedCourseware(changed, {
    workerDirectory: controlledWorker, outputDirectory, signal: controller.signal,
  }).then(result => ({ result }), error => ({ error }));
  let pid: number | undefined;
  try {
    pid = await within(started, 'Worker startup');
    controller.abort();
    expect(await within(pending, 'Worker termination')).toMatchObject({ error: { code: 'BUILD_CANCELLED' } });
    expect(() => process.kill(pid!, 0)).toThrow(expect.objectContaining({ code: 'ESRCH' }));
    expect(await readdir(outputDirectory)).toEqual([valid.buildId]);
  } finally {
    controller.abort();
    monitor.abort();
    if (pid) {
      try { process.kill(pid, 'SIGKILL'); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
    }
    await pending;
    await started.catch(() => {});
    await rm(controlledWorker, { recursive: true, force: true });
  }
}, 15_000);

it('cancels after real package writes before publication and preserves the previous build', async () => {
  const controller = new AbortController();
  const changed = structuredClone(input);
  changed.teaching.revision = 'cancel-before-publication';
  io.afterWrite = file => {
    if (file.startsWith(outputDirectory) && path.basename(file) === 'manifest.json') controller.abort();
  };
  await expect(buildFixedCourseware(changed, {
    workerDirectory, outputDirectory, signal: controller.signal,
  })).rejects.toMatchObject({ code: 'BUILD_CANCELLED' });
  expect(await readdir(outputDirectory)).toEqual([valid.buildId]);
  expect(await readFile(path.join(valid.directory, 'package.json'))).toEqual(
    validPackage,
  );
});
