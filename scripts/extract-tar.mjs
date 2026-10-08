import { execFile } from "node:child_process";
import { basename, dirname, resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export async function extractTarGz(archive, output) {
  const archivePath = resolve(archive);
  await execFileAsync("tar", [process.platform === "win32" ? "-xf" : "-xzf", basename(archivePath), "-C", resolve(output)], {
    cwd: dirname(archivePath),
  });
}
