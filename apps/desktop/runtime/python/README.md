# Bundled Python runtime

DeckWise packages a private Python runtime; client machines do not need Python installed.

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

The runtime intentionally excludes PyMuPDF/fitz and optional document conversion
packages. DeckWise uses Chromium for SVG preview and only packages dependencies needed
by PPT Master's default SVG-to-PPTX path.
