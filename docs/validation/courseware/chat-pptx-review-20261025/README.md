# Main Chat PPTX candidate review — 2026-10-25

The main Chat now exposes successful page-redo, page-fade and page-style-batch
receipts as candidate review entrances. Teachers can open the retained read-only
preview, reject, or explicitly confirm adoption without copying an ID into the
editor. The existing review component retains lineage/staleness warnings,
replacement consent, attention-object reassociation and representative style
scope. Candidate kinds have readable localized labels. The edit skill points to
these Chat entrances; original/native-textless visual preparation still uses
the existing teaching sidebar. The retained editor lookup remains available.

The shared receipt decoder also serves narration review. It accepts only
successful, matching, non-delegated tool receipts with pending/unapplied/unsaved
state. Native Office session IDs are not compared with Chat IDs. Receipts grant
no write authority: existing Main/Host APIs reread the candidate and validate
source, teaching, ownership, lineage and target scope.

Current-page stored narration drafts block opening and adoption. Active Agent
turns, disabled controls, task switches and repeated clicks fence actions.
Uncertain operations discard transient review and require rereading persisted
status; there is no automatic write or generation retry. Definite decisions hide
the entrance for the current mounted view. Historical receipts can reappear on
reload and must still read current persisted status. A successful replacement
publishes a source-hash invalidation hint; a clean, idle teaching sidebar rereads
Host once. Manual drafts and busy panels remain protected. This adds no IPC,
persistent store, migration, model transport or generation engine.

## Validation

- `targeted-tests.txt`: **72/72 pass** across main Chat workflow, candidate effect
  UI, existing source adoption/file recovery, narration entry and packaged skill
  registration. The source-refresh regression was red before the guard change
  and passes afterward. Shared narration receipt behavior remains covered.
- `dom-final/report.json`: **5/5 groups pass** using actual React/DOM,
  candidate/style review components and Chinese locale. Covers all three kinds,
  preview/rejection, unchecked consent, explicit attention-object choices,
  drafts, a committed adoption with a lost response, running turns and navigation
  during a held read. `dom-final/chat-pptx-review.png` captures the scoped review
  interaction, not the complete Desktop window or a visual acceptance result.
- Desktop typecheck and production Main/preload/renderer build pass. Existing
  DOMPurify mixed-import and large-chunk build warnings remain.
- i18n build and **28/28** catalog/copy checks pass. Configured repository lint
  passes; this is its configured coverage, not a new full-source lint audit.
- `git diff --check` passes. Earlier `dom/report.json` retains the successful
  pre-fixture-tidy run. The first attempt to create its output failed because
  the report parent directory was absent; creating that parent resolved it.

Reproduce the focused DOM gate with an unused output directory whose parent
already exists:

```sh
node --test apps/desktop/test/courseware-chat-workflow-ui.test.mjs \
  apps/desktop/test/courseware-candidate-effects-ui.test.mjs \
  apps/desktop/test/courseware-source-adoption.test.mjs \
  apps/desktop/test/courseware-narration-entry.test.mjs \
  apps/desktop/test/plugin-skills.test.mjs
DECKWISE_E2E_OUTPUT=/tmp/chat-pptx-review-new-run \
  node scripts/e2e-courseware-chat-pptx-review.mjs
pnpm --filter @pi-desktop/i18n test
pnpm --filter @pi-desktop/desktop typecheck
pnpm --filter @pi-desktop/desktop build
pnpm lint
```

## Delivery boundary

The request continues on `feat/courseware-par-A` after `62fd96871`; no upstream
merge, remote write or deployment is included. The DOM gate uses in-memory
store/IPC fixtures. Existing source-adoption tests cover its coordinator and
filesystem separately; those results are not combined into a new actual
Electron/Main/Host/Office acceptance claim. No paid API, user desktop or live
service was used. The earlier AppImage and separate Office output are unchanged;
this increment is source-only and is not present in that trial package.

Real-teacher/deployed managed-service acceptance, representative content/audio
quality and approved managed-text atomic budgets remain open. Project-wide
atomic draft handling is not added. Collaboration, collaborative publication,
W16 and Chat master automation retain their deferred/excluded scope. Full Plan
007 is not marked complete.
