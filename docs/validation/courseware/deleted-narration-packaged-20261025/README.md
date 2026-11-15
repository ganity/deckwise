# Packaged deleted-page narration recovery — 2026-10-25

**PASS: six actual packaged Electron/Office groups**, plus 12 targeted component/
parent-integration tests. This closes the pending packaged recovery interaction
from the historical source increment, `docs/validation/courseware/w06/deleted-page-teaching-20261024/README.md`,
which is not included in this checkout.
It does not close all W06.1 or Plan 007 requirements.

## Verified path

The runner uses the existing `chat-pptx-review-20261025/linux-unpacked` executable
with its own Main/Host/worker and the unchanged separately served WiseOffice.
No product code, package resource or provider configuration changed. All 1,179
frozen product source inputs still match. The matching AppImage remains
SHA-256 `1ae9725ae35dac79a3376c85acebf4b1ee02fadce8bb48aea173fa22a569aa36`.
[Acceptance](acceptance.json) pins the package and exact passing report.

1. Open a private copy of the retained three-page PPTX and save a teacher's
   narration through the real teaching UI.
2. Use native Office duplication/deletion and save its PPTX. In the existing
   visible source-review UI, explicitly mark the copy as a new logical page
   while retaining the other two original associations.
3. Load deleted-page history on the new empty page and select the saved version.
   Reading/previewing leaves source bytes and persisted teaching unchanged.
   The copy button stays disabled until explicit consent. The visible warning
   explains that old audio/highlight/spotlight bindings are not recovered.
4. Copy, edit and retain the narration as a local draft. Independent SQLite
   readback proves no authoritative teaching write occurred; action IDs differ
   from the deleted original. The two untouched pages retain their actions.
5. Fully restart Electron and Host, explicitly read the current teaching page
   and observe the edited draft. It remains unapplied until Save narration.
6. Save, fully restart again and verify applied narration, no remaining draft,
   unchanged PPTX hash and unchanged other pages. History copying is disabled
   when the destination already contains narration.

The runner reuses `scripts/e2e-courseware-teaching.mjs --deleted-recovery`, with
the bounded flow in `scripts/e2e/deleted-narration-recovery.mjs`. Native SDK calls
drive real editing; source review, history selection, consent, copy, text editing
and saving use visible UI. SQLite is read-only test observation, never product
state mutation. Identity is a local fixture; no model/TTS/media request is made.

## Evidence and reproduction

- [`electron-final/report.json`](electron-final/report.json): **6/6 PASS**,
  `packaged: true`, `paidCalls: false`; native source, teaching snapshots,
  historical options, draft and screenshot are retained beside it.
- [`targeted-tests.txt`](targeted-tests.txt): **12/12 PASS**, no skips.
- Both scripts pass `node --check`; `git diff --check` passes.
- Owned temporary profile/workspace and Office preview are stopped/removed;
  user services and existing Desktop state are untouched.

With the pinned Office output already served on an unused loopback port:

```sh
env DECKWISE_E2E_OFFICE_ROOT=/home/jhz/code/train/document-worktrees/courseware-par-A-preview \
  DECKWISE_E2E_PPTX=/home/jhz/code/train/docs/validation/courseware/w08/bilingual-ordinary-20261023/project/exports/hello-colors-grade1-en_20261023_033342.pptx \
  DECKWISE_EDITOR_URL=http://127.0.0.1:4368 \
  DECKWISE_E2E_PACKAGE_ROOT="$PWD/apps/desktop/release/chat-pptx-review-20261025/linux-unpacked" \
  DECKWISE_E2E_OUTPUT=/tmp/deckwise-deleted-history-new-run \
  xvfb-run -a node scripts/e2e-courseware-teaching.mjs --deleted-recovery
node --test apps/desktop/test/courseware-teaching-history-ui.test.mjs \
  apps/desktop/test/courseware-teaching-history-integration.test.mjs
```

Earlier failures are preserved and not relabeled: `electron/` used an obsolete
checkbox selector that matched effect controls; `electron-semantic-lock/`
invalidated the UI pin by opening another teaching view from the test;
`electron-independent-read/` incorrectly expected Read current page to stay
enabled after restoring an unsaved draft; `electron-accepted/` then expected
draft content before explicitly reading the page after restart. The final test
uses the specific lock checkbox, independent read-only persistence observation,
and the actual explicit-read/draft/save lifecycle. No product change was made
to satisfy these test assumptions.

This fixture has text narration and no adopted historical audio, effect cues or
destination music. Their omission/preservation semantics retain the earlier
Host/component evidence; they are not fresh real-Office assertions here. Real
teacher/managed-service quality, formal installation/upgrade/rollback and PR/main
integration remain separate. No commit, push or deployment was performed.
