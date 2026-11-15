import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { candidateHash } from "@pi-desktop/agent-runtime";

/** Only Main's pinned saved revision may supply candidate bytes. */
export async function readCandidateSource(path: string, sha256: string, signal: AbortSignal): Promise<Buffer> {
  signal.throwIfAborted();
  const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > 50 * 1024 * 1024) throw new Error("Candidate source exceeds limits");
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of file.createReadStream({ autoClose: false })) {
      signal.throwIfAborted();
      size += chunk.length;
      if (size > 50 * 1024 * 1024) throw new Error("Candidate source exceeds limits");
      chunks.push(chunk);
    }
    signal.throwIfAborted();
    const source = Buffer.concat(chunks);
    if (candidateHash(source) !== `sha256:${sha256}`) throw new Error("Saved candidate source changed");
    return source;
  } finally { await file.close(); }
}
