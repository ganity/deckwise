# WiseOffice teaching integration: implementation evidence

Date: 2026-10-28

This records the first implementation slice, not completion of G0–G6. The approved
[design](2026-10-28-wiseoffice-teaching-integration.md) and
[implementation plan](2026-10-28-wiseoffice-teaching-implementation.md) remain the
delivery boundary.

## Source isolation

Both repositories use their own `feat/wiseoffice-teaching-local` branch/worktree.
Desktop starts at `origin/main` `58a9c4f57` and integrates the committed courseware
branch through `578bbfeeb`. WiseOffice starts at local main `3cc37956` and integrates
the committed courseware editor branch through `632c5201`. Integration is local
and uncommitted. No other worktree's dirty source is part of the candidate. The
existing running Desktop and its original task were not edited or automated.

## Implemented

- Desktop defaults to the bundled `deckwise-editor://wiseoffice` runtime. An
  explicit HTTP(S) development override remains. No automatic remote fallback.
- The editor partition serves installation resources with traversal/symlink
  rejection, finite methods, COOP/COEP, resource policy and isolated-iframe
  delegation. Sandbox and context isolation stay enabled, Node remains disabled.
- Brotli WASM is streamed through native decompression. Testing confirmed that
  merely returning `Content-Encoding: br` from an Electron custom protocol gives
  the compiler compressed bytes and prevents native readiness.
- Packaging includes the staged WiseOffice directory. Staging inventories hashes,
  bytes and source revision/dirty status and refuses an existing destination.
- Opening reuses the validated source buffer rather than rereading the revision
  copy. Existing baseline revision creation, external-write guards and verified
  save acknowledgements are preserved.
- A real WiseOffice E2E fixture uses the DeckWise command bridge to append fade to
  one ordinary text object, verifies undo/redo, acknowledges export, checks actual
  OOXML timing/target identity, reopens and runs the native animation preview.
  Its peer object is preserved. This is not an invocation of the complete main
  Chat permission/router stack or a paid LLM.

## Checks and actual results

- Desktop targeted tests: **36 passed** (resource paths, protocol, native editor
  contract and save lifecycle).
- Desktop full TypeScript check: passed after building its workspace dependencies.
- Resource protocol TypeScript check: passed with workspace Node type roots.
- WiseOffice existing animation/bridge unit tests: **77 passed**.
- WiseOffice TypeScript check: passed.
- Real Chromium native animation E2E: **1 passed**, including native preview;
  exported PPTX and screenshot are Playwright attachments.
- Real Electron 43.6.0 source probe: **passed** with an isolated profile,
  `sandbox: true`, `contextIsolation: true`, `nodeIntegration: false`, and every
  HTTP(S) request denied. It opened the existing five-page task bytes, exported
  **11,953,409 bytes**, acknowledged save and reopened **5 pages**, with
  `crossOriginIsolated: true`, **0 remote requests**, and byte-for-byte unchanged
  source. The exported test copy was temporary; nothing was adopted into the task.
- `git diff --check`: passed.

The local Electron distribution initially had an incorrectly installed SUID
sandbox helper. The source probe used an isolated hard-linked Electron directory
with the machine's existing root-owned Chrome sandbox helper. It did not disable
sandboxing or alter the user's Electron distribution/system configuration.

## Reproduce

Build WiseOffice using its production Vite/build tooling with root resource paths.
Then, from the Desktop worktree:

```sh
node scripts/stage-wiseoffice.mjs /absolute/path/to/wiseoffice/dist
node --test apps/desktop/test/editor-host-protocol.test.mjs \
  apps/desktop/test/editor-resource-path.test.mjs \
  apps/desktop/test/ppt-editor-contract.test.mjs \
  apps/desktop/test/ppt-editor-save.test.mjs
```

Run the isolated Electron probe with a correctly installed sandbox helper:

```sh
env -u ELECTRON_RUN_AS_NODE /absolute/path/to/electron \
  scripts/verify-local-wiseoffice.mjs /absolute/path/to/fixture.pptx
```

The script never writes its input. Do not add `--no-sandbox` to bypass a failed
environment. `stage-wiseoffice.mjs` requires a new destination so an existing
bundle remains available; keep old/new staging directories separate during updates.

In the WiseOffice worktree:

```sh
E2E_PORT=4197 pnpm exec playwright test \
  test/e2e/deckwise-native-animation.spec.ts --workers=1
pnpm exec vitest run test/unit/slide-object-animation.test.ts \
  test/unit/deckwise-editor-bridge.test.ts
pnpm exec tsc --noEmit
```

## Open gates and limits

G0 still needs the complete main Chat dispatch path, the image/notes/multiple-slide
fixture, identity round trips, overlay geometry and slideshow/media completion
probes. A two-text-object fade test does not certify those capabilities. G1 still
needs packaged OS lanes, measured cold/warm budgets and safe initialized-editor
reuse. The open-time revision baseline remains intentionally present.

G2–G6 are not implemented by this slice: native teaching sidebar, unified timeline,
automatic speech/music/video sequencing, same-canvas attention preview, portable
Host-owned sidecar migration and full player parity. Existing teaching storage
authority and the current outer panel are unchanged.

Inherited documentation gates report an incomplete direct-image ADR/index,
two delivery spec index entries and two missing Chinese spec counterparts from
the integrated branch. These are not represented as passing gates. No installer,
production release, paid generation or remote deployment was performed.

## Integration into the runnable courseware branch

The local-editor increment is integrated on top of courseware commit
`81aca3013368332e02396c9ea91a282abe07ccd3`. The development launcher no longer
overrides the local editor default with a hosted URL; explicit environment
overrides remain available. The runnable worktree receives the ignored
WiseOffice bundle separately from Git. The remaining G0–G6 limits above still apply.
