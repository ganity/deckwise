# Exported PPTX credential verification — 2026-10-25

Status: **16 retained PPTX exports / 368 decompressed members / 15 ordinary
project files pass; eight targeted regression tests pass**. This closes the
known compressed-PPTX inspection gap for these artifacts, not all W04.3 or
Plan 007 acceptance. No supplier request, login, migration or deployment occurs.

The existing `scripts/check-courseware-package-credentials.mjs` now exposes
`scanPptxExport(bytes, name)`. Its existing fixed-build check additionally scans
each actual allowlisted PPTX member, after the ordinary manifest/hash/path
validation. It uses the already installed JSZip and the same credential/path
signatures; there is no new dependency or product/runtime behavior change.
Notes, metadata, relationships and embedded binary members are inspected after
decompression. Reports retain only paths, categories, sizes and hashes, never
matched credential values. Archives are never extracted to disk.

Malformed archives, escaping paths, archive links, more than 4,096 entries,
compressed inputs over 256 MiB, single decompressed files over 64 MiB and total
decompressed content over 256 MiB fail the verification. Decompression is streamed;
JSZip's older stream is wrapped in the native Node Readable before iteration.

## Evidence

- `report.json`: scans the actual retained workspace from the matching packaged
  21-scenario Chat run, including the scene-generated PPTX, imported copy,
  ordinary export, edited revisions and reviewed/adopted page redo. Source report
  hash and artifact identity are pinned. All 16 PPTX files, their 368 members and
  15 ordinary-project files pass with zero findings. This does not rerun the
  Electron gate, regenerate content or imply a new fixed-build export scenario.
- `checks.json`: exact verification-script/test hashes and eight passing tests.
  The tests cover actual ASAR, private-state paths and links, chunk-spanning
  signatures, the fixed-build allowlist/hash reader, compressed notes/metadata/
  embedded bytes, secret-free reports, malformed archives, path escapes,
  symlinks, decompressed size and entry-count limits.
- `verify-exports.mjs`: repeat the scoped retained-artifact check from the A
  worktree with `node docs/validation/courseware/export-credentials-20261025/verify-exports.mjs`.
- Run the regression suite with
  `node --experimental-strip-types --test scripts/check-courseware-package-credentials.test.mjs`.

The initial test run correctly failed because the new function did not exist.
The first implementation then failed on JSZip's non-async legacy stream; native
Readable wrapping fixed that. A symlink test initially retained its preceding
escape-directory fixture and was corrected to isolate the symlink. The final
suite passes 8/8 with no skips. No earlier failure is claimed as a passing run.

## Limits and delivery

This is a known-signature gate, not proof against unknown/obfuscated credentials,
shadowed ZIP records or other archive-forensics techniques. Nested archives in
embedded objects remain scanned as raw bytes and require separate content review;
arbitrary authored lesson content still requires teacher review. The current
samples do not establish real teacher/authenticated-service acceptance.

The current [matched Desktop/Office trial](../chat-redo-package-20261025/README.md)
is unchanged. Only verification scripts/docs changed, so no installer rebuild or
repeat of its 21 scenarios is needed. Team collaboration and virtual classroom
remain deferred. Managed text pre-call reservation still needs an approved cost
policy; this export check does not address that separate source gap.
