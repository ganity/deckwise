import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createDownloadManifest } from "../../../scripts/create-download-manifest.mjs";

test("download manifest only publishes a complete set of nonempty release installers", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "deckwise-downloads-"));
  try {
    assert.throws(() => createDownloadManifest(directory, "../../wrong"), /Invalid release version/);
    assert.throws(() => createDownloadManifest(directory, "0.17.4"), /ENOENT/);
    const names = [
      "DeckWise-0.17.4-arm64.dmg", "DeckWise-0.17.4-x64.dmg",
      "DeckWise-Setup-0.17.4.exe", "DeckWise-Portable-0.17.4.exe",
      "DeckWise-0.17.4.AppImage", "deckwise_0.17.4_amd64.deb", "deckwise-0.17.4-x86_64.rpm",
    ];
    for (const name of names) writeFileSync(path.join(directory, name), "installer");
    const manifest = createDownloadManifest(directory, "0.17.4", true);
    assert.equal(manifest.version, "0.17.4");
    assert.equal(manifest.macSigned, true);
    assert.equal(Object.keys(manifest.files).length, 7);
    assert.equal(manifest.files["mac-arm64"].size, 9);
    assert.equal(manifest.files["windows-portable"].name, names[3]);
    writeFileSync(path.join(directory, names[0]), "");
    assert.throws(() => createDownloadManifest(directory, "0.17.4"), /Empty or invalid installer/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
