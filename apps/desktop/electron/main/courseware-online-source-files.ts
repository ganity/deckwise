import { createHash } from "node:crypto";
import { constants, promises as fs } from "node:fs";
import { isAbsolute, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { validateOfficeBytes } from "./office-file";

type Host = { call<T>(method: string, params: unknown): Promise<T> };
type Side = "original" | "target";
type Source = { source: { revision: string; sha256: string }; bytes: Buffer };
type Preview = { workspace: string; snapshot: { sourcePath: string; sha256: string }; page: number;
  signal: AbortSignal; assertCurrent(): Promise<void> };
type Input = {
  getHost(): Host | null;
  workspace: string;
  sessionId: string;
  original: Source;
  target: Source;
  signal?: AbortSignal;
  assertCurrent(): void | Promise<void>;
};
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u;
const changed = () => new Error("COURSEWARE_ONLINE_SOURCE_CONTEXT_CHANGED");
const invalid = () => new Error("COURSEWARE_ONLINE_SOURCE_INVALID");

/** Private review copies and one scoped parser job; no live-editor or teaching writes. */
export async function stageOnlineSourceFiles(input: Input) {
  if (!isAbsolute(input.workspace) || !/^[\w.-]{1,128}$/u.test(input.sessionId)) throw invalid();
  const captured = Object.fromEntries((["original", "target"] as const).map(side => {
    const source = input[side];
    if (!source || !uuid.test(source.source.revision) || !/^[a-f0-9]{64}$/u.test(source.source.sha256) ||
        !Buffer.isBuffer(source.bytes) || source.bytes.length < 1 || source.bytes.length > 20 * 1024 * 1024) throw invalid();
    const bytes = Buffer.from(validateOfficeBytes(source.bytes, "pptx"));
    if (createHash("sha256").update(bytes).digest("hex") !== source.source.sha256) throw invalid();
    return [side, { bytes, sha256: source.source.sha256 }];
  })) as Record<Side, { bytes: Buffer; sha256: string }>;
  const host = input.getHost();
  if (!host) throw changed();
  const abort = new AbortController();
  const signal = input.signal ? AbortSignal.any([input.signal, abort.signal]) : abort.signal;
  let directory: string | undefined, directoryIdentity: { dev: number; ino: number } | undefined;
  let jobId: string | undefined, terminal = false, startUnknown = false, busy = false, closing = false;
  let active: Promise<unknown> | undefined, disposal: Promise<void> | undefined;
  const check = async () => {
    signal.throwIfAborted();
    if (closing || input.getHost() !== host) throw changed();
    await input.assertCurrent();
    signal.throwIfAborted();
    if (closing || input.getHost() !== host) throw changed();
  };
  const step = async <T>(operation: Promise<T>): Promise<T> => { const result = await operation; await check(); return result; };
  const verifyDirectory = async () => {
    if (!directory || !directoryIdentity) throw changed();
    const info = await fs.lstat(directory);
    if (!info.isDirectory() || info.isSymbolicLink() || info.dev !== directoryIdentity.dev || info.ino !== directoryIdentity.ino ||
        await fs.realpath(directory) !== directory) throw changed();
  };
  const release = async () => {
    if (!jobId) return;
    const deadline = Date.now() + 10_000;
    const bounded = async <T>(operation: () => Promise<T>): Promise<T> => {
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error("COURSEWARE_ONLINE_SOURCE_CLEANUP_FAILED");
      const timer = new AbortController();
      try {
        return await Promise.race([operation(), delay(remaining, undefined, { signal: timer.signal }).then(() => {
          throw new Error("COURSEWARE_ONLINE_SOURCE_CLEANUP_FAILED");
        })]);
      } finally { timer.abort(); }
    };
    // Cleanup uses the captured Host even after ownership changes, never a new Host's parser.
    if (!terminal) {
      await bounded(() => host.call("courseware.parseCancel", { jobId }));
      for (;;) {
        const status = await bounded(() => host.call<{ status: string }>("courseware.parseStatus", { jobId }));
        if (status.status !== "RUNNING") { terminal = true; break; }
        await bounded(() => delay(100));
      }
    }
    await bounded(() => host.call("courseware.parseRelease", { jobId }));
    jobId = undefined; terminal = false;
  };
  const readPinned = async (path: string): Promise<Buffer> => {
    const file = await fs.open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      await check();
      const info = await step(file.stat());
      if (!info.isFile() || info.size > 20 * 1024 * 1024) throw invalid();
      return await step(file.readFile());
    } finally { await file.close(); }
  };
  const remove = async () => {
    if (startUnknown) throw new Error("COURSEWARE_ONLINE_SOURCE_CLEANUP_FAILED");
    if (!directory) return;
    if (!directoryIdentity) throw changed();
    await verifyDirectory();
    // Only this uniquely created directory is removed, after its parser job has released.
    await fs.rm(directory, { recursive: true, force: false });
    directory = undefined;
  };
  const dispose = (): Promise<void> => {
    if (disposal) return disposal;
    closing = true; abort.abort();
    disposal = (async () => {
      await active?.catch(() => {});
      await release();
      await remove();
    })();
    return disposal;
  };
  const onAbort = () => { void dispose().catch(() => {}); };
  try {
    await check();
    const workspace = await step(fs.realpath(input.workspace));
    const info = await step(fs.stat(workspace));
    if (!info.isDirectory()) throw invalid();
    directory = await fs.mkdtemp(join(workspace, ".deckwise-online-source-"));
    // Capture cleanup identity before checking a potentially changed account.
    const identity = await fs.lstat(directory);
    directoryIdentity = { dev: identity.dev, ino: identity.ino };
    await check();
    await step(fs.chmod(directory, 0o700));
    const paths = { original: join(directory, "original.pptx"), target: join(directory, "target.pptx") };
    for (const side of ["original", "target"] as const) {
      await step(verifyDirectory());
      await step(fs.writeFile(paths[side], captured[side].bytes, { flag: "wx", mode: 0o600 }));
    }
    const run = <T>(operation: () => Promise<T>): Promise<T> => {
      if (busy || closing) return Promise.reject(new Error("COURSEWARE_ONLINE_SOURCE_BUSY"));
      busy = true;
      const result = operation().finally(() => { busy = false; });
      active = result;
      return result;
    };
    const validateSide = (side: Side) => { if (side !== "original" && side !== "target") throw invalid(); };
    input.signal?.addEventListener("abort", onAbort, { once: true });
    await check();
    return {
      withParsed<T>(side: Side, operation: (host: Host, jobId: string) => Promise<T>): Promise<T> {
        if (busy || closing) return Promise.reject(new Error("COURSEWARE_ONLINE_SOURCE_BUSY"));
        let parsed = false;
        const result = run(async () => {
          validateSide(side);
          await check();
          await step(verifyDirectory());
          const bytes = await step(readPinned(paths[side]));
          if (createHash("sha256").update(bytes).digest("hex") !== captured[side].sha256) throw changed();
          try {
            startUnknown = true;
            const started = await host.call<{ jobId: string }>("courseware.parseStart", { sessionId: input.sessionId, path: paths[side] });
            if (typeof started.jobId !== "string" || !uuid.test(started.jobId)) throw invalid();
            jobId = started.jobId; terminal = false; startUnknown = false;
            await check();
            for (;;) {
              const status = await host.call<{ status: string; summary?: { sourceSha256: string } }>("courseware.parseStatus", { jobId });
              if (status.status !== "RUNNING") terminal = true;
              await check();
              if (status.status === "RUNNING") { await step(delay(100, undefined, { signal })); continue; }
              if (status.status !== "SUCCEEDED" || status.summary?.sourceSha256 !== captured[side].sha256) throw invalid();
              break;
            }
            parsed = true;
            const value = await operation(host, jobId);
            await check();
            return value;
          } finally { await release(); await check(); }
        });
        return result.catch(async error => {
          if (!parsed) {
            try { await dispose(); } catch { throw new Error("COURSEWARE_ONLINE_SOURCE_CLEANUP_FAILED"); }
          }
          throw error;
        });
      },
      preview<T>(side: Side, page: number, render: (input: Preview) => Promise<T>): Promise<T> {
        return run(async () => {
          validateSide(side);
          if (!Number.isSafeInteger(page) || page < 1 || page > 100) throw invalid();
          await check(); await step(verifyDirectory());
          const value = await render({ workspace, snapshot: { sourcePath: paths[side], sha256: captured[side].sha256 }, page, signal, assertCurrent: check });
          await check();
          return value;
        });
      },
      async dispose(): Promise<void> {
        try { await dispose(); }
        finally { input.signal?.removeEventListener("abort", onAbort); }
      },
    };
  } catch (error) {
    input.signal?.removeEventListener("abort", onAbort);
    try { await dispose(); } catch { throw new Error("COURSEWARE_ONLINE_SOURCE_CLEANUP_FAILED"); }
    throw error;
  }
}
