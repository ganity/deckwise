import { execFile } from "node:child_process";
import { basename, dirname, join, resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export async function extractTarGz(archive, output) {
  const archivePath = resolve(archive);
  // Git Bash tar cannot reliably resolve native paths on another Windows drive.
  const tar = process.platform === "win32"
    ? join(process.env.SystemRoot || "C:\\Windows", "System32", "tar.exe")
    : "tar";
  await execFileAsync(tar, ["-xzf", basename(archivePath), "-C", resolve(output)], {
    cwd: dirname(archivePath),
  });
}
