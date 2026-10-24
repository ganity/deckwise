import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import { basename, dirname, join, relative } from "node:path";
import { resolveRealOpenablePath, resolveRealPathForCreateWithinRoot } from "./fs-panel";
import { validateOfficeBytes } from "./office-file";
import { jobIdFor, listRevisions, publishRevision } from "./ppt-editor-files";

export const sourceHash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

export async function syncPath(path: string): Promise<void> {
  const file = await fs.open(path, "r");
  try { await file.sync(); } finally { await file.close(); }
}

async function safePath(workspace: string, path: string): Promise<string> {
  if (await resolveRealPathForCreateWithinRoot(workspace, relative(workspace, path)) !== path) throw new Error("Source adoption path escaped its workspace");
  return path;
}

export async function readLiveSource(workspace: string, path: string): Promise<Buffer> {
  if (await resolveRealOpenablePath(path, workspace) !== path) throw new Error("Source adoption file is missing or redirected");
  const stat = await fs.lstat(path);
  if (!stat.isFile() || stat.size > 50 * 1024 * 1024) throw new Error("Source adoption requires a regular PPTX under 50 MiB");
  return Buffer.from(validateOfficeBytes(await fs.readFile(path), "pptx"));
}

function directoryFor(path: string, adoptionId: string): string {
  if (!/^[\w.-]{1,128}$/u.test(adoptionId)) throw new Error("Invalid adoption identity");
  return join(dirname(path), `.${basename(path)}.adoption-${adoptionId}`);
}

export async function restoreMissingSource(workspace: string, path: string, adoptionId: string, originalHash: string): Promise<void> {
  await safePath(workspace, path);
  try { await fs.lstat(path); return; } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  const original = join(directoryFor(path, adoptionId), "original.pptx");
  if (sourceHash(await readLiveSource(workspace, original)) !== originalHash) throw new Error("Original adoption backup changed; preserve all versions");
  try { await fs.link(original, path); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  await syncPath(dirname(path));
}

/** Reserve a private backup, displace the source and install without overwriting any competing writer. */
export async function installSourceCandidate(workspace: string, path: string, adoptionId: string, candidate: string, originalHash: string, outputHash: string): Promise<void> {
  await safePath(workspace, path);
  const candidateStat = await fs.stat(candidate);
  if (!candidateStat.isFile() || candidateStat.size > 50 * 1024 * 1024) throw new Error("Invalid source candidate archive size");
  const bytes = Buffer.from(validateOfficeBytes(await fs.readFile(candidate), "pptx"));
  if (bytes.length > 50 * 1024 * 1024 || sourceHash(bytes) !== outputHash) throw new Error("Candidate archive changed before installation");
  if (sourceHash(await readLiveSource(workspace, path)) !== originalHash) throw new Error("Live source changed before adoption");
  const originalMode = (await fs.stat(path)).mode & 0o777;
  const directory = await safePath(workspace, directoryFor(path, adoptionId));
  await fs.mkdir(directory, { mode: 0o700 });
  await syncPath(dirname(path));
  const staged = join(directory, "candidate.pptx");
  await fs.writeFile(staged, bytes, { flag: "wx", mode: originalMode });
  await syncPath(staged); await syncPath(directory);
  const original = join(directory, "original.pptx");
  try {
    await fs.rename(path, original);
    await syncPath(original); await syncPath(directory); await syncPath(dirname(path));
    if (sourceHash(await readLiveSource(workspace, original)) !== originalHash) throw new Error("Live source changed during adoption; both versions retained");
    // link is exclusive: a file created by an external writer is never replaced.
    await fs.link(staged, path);
    await syncPath(dirname(path));
  } catch (error) {
    try { await restoreMissingSource(workspace, path, adoptionId, originalHash); }
    catch (recovery) { throw new Error(`Source adoption interrupted: ${String(error)}; recovery failed: ${String(recovery)}`); }
    throw error;
  }
}

export async function rollBackSourceCandidate(workspace: string, path: string, adoptionId: string, originalHash: string, outputHash: string): Promise<void> {
  const current = sourceHash(await readLiveSource(workspace, path));
  if (current === originalHash) return;
  if (current !== outputHash) throw new Error("Unknown live bytes cannot be rolled back automatically");
  const original = join(directoryFor(path, adoptionId), "original.pptx");
  if (sourceHash(await readLiveSource(workspace, original)) !== originalHash) throw new Error("Original adoption backup changed; preserve all versions");
  await installSourceCandidate(workspace, path, `${adoptionId}-rollback`, original, outputHash, originalHash);
}

export async function adoptionRevision(workspace: string, path: string, bytes: Buffer) {
  const root = await safePath(workspace, join(workspace, ".deckwise-ppt/revisions"));
  const jobId = jobIdFor(workspace, path);
  const revisions = await listRevisions(root, jobId);
  let revision = revisions.at(-1);
  if (revision?.sha256 !== sourceHash(bytes)) revision = await publishRevision({ root, jobId, bytes, extension: "pptx", cause: "edited", expectedRevision: revision?.revision ?? 0 });
  if (sourceHash(await readLiveSource(workspace, revision.documentPath)) !== sourceHash(bytes)) throw new Error("Adoption saved revision changed");
  await syncPath(revision.documentPath); await syncPath(join(dirname(revision.documentPath), "revision.json"));
  await syncPath(dirname(revision.documentPath)); await syncPath(dirname(dirname(revision.documentPath)));
  return revision;
}
