import assert from "node:assert/strict";
import { createReadStream } from "node:fs";
import { createHash } from "node:crypto";
import { readdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export async function artifactChecksums(directory) {
  const files = (await readdir(directory)).filter(name => /\.(?:dmg|zip|exe|AppImage|deb|rpm|asar|blockmap)$|^latest.*\.yml$|^courseware-.*\.json$/.test(name)).sort();
  assert(files.some(name => /\.(?:dmg|exe|AppImage)$/.test(name)), "No installer artifacts");
  const result = [];
  for (const name of files) {
    const hash = createHash("sha256");
    for await (const bytes of createReadStream(join(directory, name))) hash.update(bytes);
    result.push(`${hash.digest("hex")}  ${name}\n`);
  }
  return result.join("");
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const directory = fileURLToPath(new URL("../apps/desktop/release", import.meta.url));
  await writeFile(join(directory, `SHA256SUMS-${process.platform}-${process.arch}.txt`), await artifactChecksums(directory));
}
