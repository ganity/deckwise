# Packaged Chat core — 2026-10-25

This is a preserved earlier trial. The [subsequent main-Chat narration trial](../chat-narration-review-20261025/README.md)
removes the candidate-ID review step recorded below and verifies clean-sidebar
synchronization. Its artifact/hash and evidence are separate from this package.

The new Linux trial passes the same fifteen bounded Chat scenarios as the
[source run](../chat-first-20261025/README.md). This is a new artifact; the older
music-adoption trial remains unchanged. This gate completes the current package
check for the Chat increment, not the complete Plan 007 or production acceptance.

## Trial and matching editor

AppImage, relative to this worktree:
`apps/desktop/release/chat-first-20261025/DeckWise-0.17.7.AppImage`.

SHA-256: `4c4f79cb259e84ddf73429c6128cb74a11ee08c7fb5397471e4136d51e9a4ea3`.

Use the authorized `--no-sandbox` launch flag. This trial does not install or
deploy WiseOffice. Its matching separately served Office output is
`/home/jhz/code/train/document-worktrees/courseware-par-A-preview/dist-w15-canvas-target-20261023`.
The isolated test preview used loopback port 4368; existing user services were
not changed. All 2,899 pinned Office files match; see `office-check.json`.
The test preview is stopped after validation; it is not a persistent service.

## Actual checks

- `e2e/report.json`: fifteen checks passed on **linux-unpacked**, with
  `app.isPackaged=true` and the actual ASAR/executable paths recorded. No source
  Host, worker, Node or Python override was provided.
- The three new-task entries hand requirements to the main Chat. The scene path
  saves/reviews a plan, explicitly reviews three image submissions, compiles an
  editable PPTX and opens actual Office. Import supports discussion before
  selection, cancellation and importing original PPTX bytes.
- Ordinary generation uses official PPT Master checks, the real SVG preview,
  repair after a changed page and explicit PPTX export. The same Chat adds native
  Office text, explicitly saves the original file, reviews source associations,
  proposes narration from the saved page and waits for explicit adoption.
  Full restart restores the edited PPTX and adopted narration without replay.
- `appimage-smoke.json`: the **AppImage itself** starts its packaged Main UI.
  Five payload hashes equal the corresponding unpacked resources. This separate
  smoke check does not claim all fifteen scenarios ran through the AppImage launcher.
- `package-check.json`: current ASAR output, Host, Agent, worker, skills, plugins
  and editor-host match the staged build. The worker provenance check passes.
- `credential-check.json`: 18,955 files and 1,047 symlinks inspected, no detected
  credential findings. Signature scanning has the limits recorded in that report.
- `source-before.json` and `source-after.json`: 1,121 product source files match
  before/after building and testing; aggregate SHA-256
  `64d4fbc98a256855b1719ac745490625bd9c26db8ff75cf0fd6198c2915fcf7e`.
  `built-inputs.json` records the changed build inputs. The existing worktree is
  uncommitted; this is a manifest-pinned trial, not a PR integration candidate.

The real Electron/Main/Host/Agent/Office and conversion tools ran against local
identity/model/media fixtures. There were 59 fixture model requests and no paid
calls. These controlled one-page samples prove wiring and persistence, not
provider generation quality, real billing or complex imported-deck fidelity.
Narration adoption currently uses the existing editor review UI; the test still
enters a candidate ID there. A direct main-Chat review action remains a UX gap.

Python/PPT Master dependency evidence is inherited from the prior accepted trial.
`inherited-dependencies/reference-code-check.json` confirms every preexisting
staged dependency entry matches; 551 additional entries are only generated
Python bytecode/cache directories. Full-tree equality is **false** and is not
claimed. Current package code/resource checks and this end-to-end run are separate
evidence, rather than substituting inherited dependency results for current tests.

## Reproduce the packaged Chat gate

Start the matching Office preview on a free local port, then run from this
worktree after building the candidate:

```sh
DECKWISE_E2E_PACKAGE_ROOT="$PWD/apps/desktop/release/chat-first-20261025/linux-unpacked" \
DECKWISE_E2E_OUTPUT=/tmp/deckwise-packaged-chat-new-run \
DECKWISE_EDITOR_URL=http://127.0.0.1:4368 \
xvfb-run -a node scripts/e2e-courseware-chat-first.mjs
```

The output directory must not exist. Do not set development runtime overrides;
the launcher rejects them. All external generation services in this gate are
local fixtures. Keep original teacher data and existing running clients separate.

## Remaining core acceptance

Real teacher identity and deployed Platform/MAIC/llm-ha calls, representative
scene/media/narration quality and the approved managed-text atomic budget/fallback
price policy remain open. This gate does not rerun audio playback or fixed
publication; their earlier evidence remains separate. Collaboration,
collaborative publication, W16 and Chat master automation retain the user's
deferred/excluded scope. No deployment, push or user-data migration occurred.
