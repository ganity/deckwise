import { statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export function createDownloadManifest(directory, version, macSigned = false) {
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?$/.test(version)) {
    throw new Error("Invalid release version");
  }
  const names = {
    "mac-arm64": `DeckWise-${version}-arm64.dmg`,
    "mac-x64": `DeckWise-${version}-x64.dmg`,
    "windows-setup": `DeckWise-Setup-${version}.exe`,
    "windows-portable": `DeckWise-Portable-${version}.exe`,
    "linux-appimage": `DeckWise-${version}.AppImage`,
    "linux-deb": `deckwise_${version}_amd64.deb`,
    "linux-rpm": `deckwise-${version}-x86_64.rpm`,
  };
  const files = Object.fromEntries(Object.entries(names).map(([id, name]) => {
    const stat = statSync(path.join(directory, name));
    if (!stat.isFile() || stat.size === 0) throw new Error(`Empty or invalid installer: ${name}`);
    return [id, { name, size: stat.size }];
  }));
  return { version, publishedAt: new Date().toISOString(), macSigned, files };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const directory = process.argv[2];
  if (!directory) throw new Error("Usage: node scripts/create-download-manifest.mjs <directory> <version> [--mac-signed]");
  const manifest = createDownloadManifest(directory, process.argv[3], process.argv.includes("--mac-signed"));
  writeFileSync(path.join(directory, "downloads.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`Download manifest generated for ${manifest.version}`);
}
