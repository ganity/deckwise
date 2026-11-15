# Main Chat narration review — 2026-10-25

The main Chat now exposes narration review directly from successful tool
receipts. Teachers compare the existing/proposed text, explicitly confirm and
adopt or reject in Chat. Candidate-ID copy/paste is no longer required for these
receipts. The existing editor lookup remains available for older candidates
outside the loaded transcript window.

The existing Main/Host APIs remain authoritative for the candidate, current
Office page, source identity, revisions and adoption. There is no new model,
storage or decision API. Stored manual drafts block review/adoption. A failed
decision discards only the transient review; reopening reads persisted status
instead of silently replaying a write. Session changes fence late responses.

Successful adoption publishes only a revision invalidation hint. A clean, idle
teaching sidebar rereads Host; busy/manual-draft views retain their edits. Each
hint is consumed once so a later manual save cannot trigger a refresh loop.

## Verified

- 66 targeted Node checks pass across Chat UI, narration entry and candidate
  generation. Includes receipt-envelope decoding, distinct native/Chat session
  IDs, draft protection, repeat clicks, task switching, uncertain decisions and
  sidebar refresh guards, including one-time consumption.
- Desktop typecheck, production build and configured repository lint pass.
- `e2e-final/report.json`: all fifteen scenarios pass on the new
  **linux-unpacked** package. This includes three task routes, official ordinary
  generation/repair/export, native editing/save, main-Chat narration comparison,
  an unchecked adoption confirmation, automatic sidebar text refresh and full
  restart without model replay. The report records `mainChatNarrationReview=true`.
- `e2e-final/chat-narration-review.png` shows the actual main-Chat comparison UI.
- `package/appimage-smoke.json`: the actual AppImage starts and five runtime
  payload hashes match linux-unpacked. This separate launcher smoke does not
  claim that all fifteen scenarios used the AppImage launcher.
- `package/package-check.json`: ASAR and changed bundled resources match the
  staged build; worker provenance passes. `package/credential-check.json`
  inspects 18,955 files and 1,047 symlinks without detected credential findings.
- `source-frozen-before.json` and `source-frozen-after.json` match all 1,122
  product-source inputs; aggregate SHA-256
  `848f7cebf9dc843c7f6c82e32c6d85ef6a94116d9fb5310edfa4f7683986e50f`.
  `built-frozen-inputs.json` pins the corresponding build inputs.

The initial `e2e/report.json` is intentionally retained as **FAIL**. It exposed a
native Office mount session ID being incorrectly compared to the Chat session
ID, hiding valid review entrances. A focused regression first reproduced the
failure, then passed after the fix. The final packaged run uses the corrected
scope handling and separately verifies the sidebar refresh. Intermediate input
snapshots are retained as debugging evidence, not the final accepted inputs.

## Current trial

`apps/desktop/release/chat-narration-review-20261025/DeckWise-0.17.7.AppImage`

SHA-256: `fc3f55b17b44c456022884edcd1c55ec1a8b470576730b4d0214733c730576ae`.

Keep `--no-sandbox` as authorized. The matching, separately served WiseOffice
output remains
`/home/jhz/code/train/document-worktrees/courseware-par-A-preview/dist-w15-canvas-target-20261023`.
This AppImage does not embed or deploy that service. The old trials are preserved.
Python/PPT Master dependency evidence is inherited from the preceding trial;
their full dependency gates are not rerun here. Previously recorded additional
Python bytecode caches do not establish full-tree equality.

Reproduce with that Office output on unused loopback port 4368, a fresh output
directory, and no source runtime overrides:

```sh
DECKWISE_E2E_PACKAGE_ROOT="$PWD/apps/desktop/release/chat-narration-review-20261025/linux-unpacked" \
DECKWISE_E2E_OUTPUT=/tmp/deckwise-chat-narration-new-run \
DECKWISE_EDITOR_URL=http://127.0.0.1:4368 \
xvfb-run -a node scripts/e2e-courseware-chat-first.mjs
```

## Acceptance boundary

The real Electron/Main/Host/Agent/converter/Office run used loopback identity,
model and media fixtures: 59 fixture model requests, no paid calls. One-page
fixtures prove integration/persistence rather than production generation quality.
Real teacher/deployed managed-service acceptance, representative scene/audio
quality, approved managed-text atomic budgets and formal release/PR gates remain
open. Audio/playback/publication gates are not rerun by this increment. Team
collaboration, collaborative publication, W16 and Chat master automation retain
their deferred/excluded scope. Full Plan 007 is not marked complete.
