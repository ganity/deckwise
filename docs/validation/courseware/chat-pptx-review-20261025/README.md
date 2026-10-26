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

## Actual Electron and packaged continuation

The source and new packaged gates each pass **17/17 scenarios** in
[`electron-review-exit-accepted/report.json`](electron-review-exit-accepted/report.json)
and [`package/e2e/report.json`](package/e2e/report.json), using actual Electron,
Main, Host, Agent, the official compiler/export tools and the pinned WiseOffice
build served separately at loopback port 4368. Identity, model output and media
are local fixtures; outbound HTTP is blocked and no paid call is made.

The added scenario continues the same ordinary Chat through the actual
`ppt_propose_page_fade` tool, readonly Office preview and unchecked explicit
adoption. It confirms teaching directly in the sidebar without a manual reload,
compares installed PPTX bytes and preserves all 22 non-target ZIP parts plus the
target slide's native content/timing, logical pages and narration. Full Desktop
and Host restart restores the adopted result without model replay. This is real
integration evidence for fade adoption; redo/style retain their earlier component
evidence and are not newly certified against real Office here.

The new review-exit scenario closes an actual read-only Office preview, closes
the main-Chat review, confirms unchanged narration, then reopens and rejects
the now-stale candidate and locks/unlocks the teaching page. All actions use the
visible UI without a manual teaching reload. Review APIs invalidate Main's active
teaching pin even when no candidate is adopted. Closing, rejecting or leaving a
failed Chat review now sends the existing clean/idle sidebar a one-time reread
hint. Session switches discard late notifications; local drafts remain protected.
The same behavior applies to narration review. There is no automatic adoption,
generation replay or persistence-contract change.

The gate exposed a genuine readiness defect: WiseOffice's `document:opened`
arrives before its native SDK loads. Desktop enabled teaching too early, failed
its one-shot refresh, and a subsequent confirmation reported
`Open current-page teaching first`. Desktop now publishes PPTX readiness only
after a validated native context matches its document binding and access mode.
Only known loading errors are polled, within the existing opening deadline and
cancellation scope. Definite errors, malformed or foreign contexts fail closed.
No renderer, Host persistence, IPC contract or WiseOffice build changes are needed.

- `review-exit-tests.txt`: **96/96 pass**, including controller startup,
  cancellation, definite errors, invalid contexts, save/handshake/request/native
  Chat contracts, both review-exit paths, teaching refresh and the fade fixture.
- [`dom-review-exit/report.json`](dom-review-exit/report.json): **5/5 pass**
  with actual React/review components and IPC fixtures, including draft safety,
  explicit consent, lost-response handling and navigation during held reads.
- `native-ready-tests.txt` retains the preceding **93/93** passing result.
- `native-ready-before-fix.txt`: three new startup regressions failed before the
  fix; the focused controller suite passes afterward.
- Desktop typecheck/build, configured repository lint and diff checks pass.
- `electron/report.json` retains the first failed attempt, whose readonly SDK
  assertion was wrong. The SDK uses restriction bit 128 rather than `isViewMode`.
  `electron-final/report.json` retains the real stale-teaching failure before the
  readiness fix. Neither report is reclassified as passing. Narrow diagnostic
  runs also failed under `/tmp`; temporary product logging was removed.
- `electron-review-exit/report.json` retains the test's mistaken lookup of a
  hidden control after panel refresh. `electron-review-exit-final/report.json`
  retains Playwright's synchronous checkbox assertion failure after the actual
  async lock succeeded. The accepted run clicks and waits for the visible
  checked state; no product behavior was changed for these test assumptions.

Reproduce the actual gate after building Desktop and staging its existing runtime
resources, with a separately served pinned Office build:

```sh
DECKWISE_E2E_OUTPUT=/tmp/chat-pptx-electron-new-run \
DECKWISE_EDITOR_URL=http://127.0.0.1:4368 \
PI_DESKTOP_HOST_BIN="$PWD/target/debug/pi-desktop-host-core" \
xvfb-run -a node scripts/e2e-courseware-chat-first.mjs
```

The candidate is `f9600d629` plus the uncommitted readiness/review-exit changes in
this worktree. The test uses a private temporary profile/workspace and
`--no-sandbox`; user Desktop instances and existing services are untouched. The
assistant-owned loopback preview is stopped after validation.

## Current Linux trial artifact

The new AppImage is
`apps/desktop/release/chat-pptx-review-20261025/DeckWise-0.17.7.AppImage`:
**340,987,223 bytes**, SHA-256
`1ae9725ae35dac79a3376c85acebf4b1ee02fadce8bb48aea173fa22a569aa36`.
[`package/acceptance.json`](package/acceptance.json) pins the working changes,
known fork base, source inventory, artifact and exact passing reports.
The [single trial entry](../../../../../../docs/validation/courseware/parallel/A/current-trial.md)
contains the matching separate Office output and launch instructions.

- [`package/package-check.json`](package/package-check.json): 597 ASAR files
  and current Host/Agent/worker/resources match. Unchanged Python/PPT Master
  dependency acceptance is inherited; no new exhaustive dependency audit.
- [`package/appimage-smoke.json`](package/appimage-smoke.json): the AppImage
  itself starts and five payload hashes match. The separate 17-step packaged
  gate uses its matching `linux-unpacked` executable, not a development build.
- [`package/credential-check.json`](package/credential-check.json): configured
  scan passes across 18,969 files and 1,047 symlinks; not a proof that every
  possible secret representation is detectable.
- [`package/office-check.json`](package/office-check.json): all 2,899 pinned
  Office files match; Office is served separately, not embedded in the AppImage.
- All 1,179 product source inputs match before packaging, after build and after
  the final packaged run. Documentation/test changes are outside this inventory.

The initial builder stalled downloading Electron; only that owned process was
stopped. The successful build uses installed Electron 43.6.0, the authorized
proxy and `--publish never`; both logs are retained under `package/`.
This is an exact local fixture trial. The remote base was not refreshed this
round; PR/main integration validation and formal release remain separate gates.

## Earlier component validation

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
merge, remote write or deployment is included. The earlier DOM gate uses in-memory store/IPC fixtures; the subsequent source
Electron evidence above closes the real fade-adoption/reopen/teaching/restart
gate with local external-service fixtures. No paid API, user desktop or live
service was used. Older AppImages remain unchanged; the new trial above includes
this increment and uses the unchanged separate Office output.

Real-teacher/deployed managed-service acceptance, representative content/audio
quality and approved managed-text atomic budgets remain open. Project-wide
atomic draft handling is not added. Collaboration, collaborative publication,
W16 and Chat master automation retain their deferred/excluded scope. Full Plan
007 is not marked complete.
