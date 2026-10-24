import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { basename, dirname, extname, join, relative } from "node:path";
import type { OfficeExtension } from "@pi-desktop/shared";
import { validateOfficeBytes } from "./office-file";

export type Revision = {
  revision: number;
  cause: "generated" | "edited";
  createdAt: string;
  file: string;
  size: number;
  sha256: string;
  documentPath: string;
};

export function jobIdFor(workspaceRoot: string, sourcePath: string): string {
  const rel = relative(workspaceRoot, sourcePath).replaceAll("\\", "/");
  const name = basename(sourcePath, extname(sourcePath))
    .replace(/[^a-zA-Z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40) || "presentation";
  return `${name}-${createHash("sha256").update(rel).digest("hex").slice(0, 12)}`;
}

export async function listRevisions(root: string, jobId: string): Promise<Revision[]> {
  const revisionsRoot = join(root, jobId);
  let entries;
  try {
    entries = await fs.readdir(revisionsRoot, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const revisions: Revision[] = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isDirectory() || !/^r\d{4}$/.test(entry.name)) continue;
    const directory = join(revisionsRoot, entry.name);
    const manifest = JSON.parse(
      await fs.readFile(join(directory, "revision.json"), "utf8"),
    ) as Omit<Revision, "documentPath">;
    revisions.push({ ...manifest, documentPath: join(directory, manifest.file) });
  }
  return revisions;
}

export async function publishRevision(input: {
  root: string;
  jobId: string;
  bytes: Uint8Array;
  extension: OfficeExtension;
  cause: Revision["cause"];
  expectedRevision: number;
}): Promise<Revision> {
  const bytes = validateOfficeBytes(input.bytes, input.extension);
  const revisions = await listRevisions(input.root, input.jobId);
  const current = revisions.at(-1)?.revision ?? 0;
  if (current !== input.expectedRevision) {
    throw new Error(`Revision conflict: expected ${input.expectedRevision}, current ${current}`);
  }

  const revision = current + 1;
  const revisionName = `r${String(revision).padStart(4, "0")}`;
  const jobRoot = join(input.root, input.jobId);
  const finalDirectory = join(jobRoot, revisionName);
  const tempDirectory = join(jobRoot, `.${revisionName}.${randomUUID()}.tmp`);
  await fs.mkdir(tempDirectory, { recursive: true });
  try {
    const documentPath = join(tempDirectory, `document.${input.extension}`);
    await fs.writeFile(documentPath, bytes, { flag: "wx" });
    const manifest = {
      revision,
      cause: input.cause,
      createdAt: new Date().toISOString(),
      file: `document.${input.extension}`,
      size: bytes.byteLength,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    };
    await fs.writeFile(
      join(tempDirectory, "revision.json"),
      `${JSON.stringify(manifest, null, 2)}\n`,
      { flag: "wx" },
    );
    await fs.rename(tempDirectory, finalDirectory);
    return { ...manifest, documentPath: join(finalDirectory, manifest.file) };
  } catch (error) {
    await fs.rm(tempDirectory, { recursive: true, force: true });
    throw error;
  }
}

export async function replaceSourceFile(sourcePath: string, bytes: Uint8Array, extension: OfficeExtension, expectedHash: string): Promise<void> {
  const validated = validateOfficeBytes(bytes, extension);
  const temporaryPath = join(
    dirname(sourcePath),
    `.${basename(sourcePath)}.${randomUUID()}.tmp`,
  );
  await fs.writeFile(temporaryPath, validated, { flag: "wx" });
  try {
    if (createHash("sha256").update(await fs.readFile(sourcePath)).digest("hex") !== expectedHash) {
      throw new Error("Source file changed while saving; preserve both versions before retrying");
    }
    if (process.platform === "win32") {
      await fs.copyFile(temporaryPath, sourcePath);
      await fs.rm(temporaryPath, { force: true });
    } else {
      await fs.rename(temporaryPath, sourcePath);
    }
  } catch (error) {
    await fs.rm(temporaryPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

