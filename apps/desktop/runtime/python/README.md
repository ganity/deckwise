# Bundled Python runtime

DeckWise packages a private Python runtime; client machines do not need Python installed.

Run these commands from `apps/desktop`. Stage PPT Master first with
`pnpm run prepare:ppt-master`; runtime assembly verifies its attribution guard
from `dist/ppt-master`. Explicit `--output` paths resolve from the working directory.

```bash
pnpm run runtime:linux:x64
pnpm run runtime:linux:arm64
pnpm run runtime:mac:x64
pnpm run runtime:mac:arm64
pnpm run runtime:win:x64
```

Release packaging uses `build:python-runtime` for the current platform and stages the
result in `dist/runtime/current`. Windows arm64 is not supported because
`skia-pathops` has no matching wheel.

Both PPT Master and Python archives are extracted by `scripts/extract-tar.mjs`,
which passes the archive filename from its containing directory. This keeps GNU
tar from interpreting a Windows drive colon as a remote archive address.

The runtime intentionally excludes PyMuPDF/fitz and optional document conversion
packages. DeckWise uses Chromium for SVG preview and only packages dependencies needed
by PPT Master's default SVG-to-PPTX path.
