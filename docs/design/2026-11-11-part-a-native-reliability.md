# Part A native reliability integration — 2026-11-11

## Scope and boundaries

This follow-up adapts three selected changes from Desktop
`local/zpj_deck@fd3cbb26f5ed23b39fdf31f00c68b1ed1a0322e8` to the existing
Part A worktree (`feat/courseware-par-A`, HEAD `7706042fe`). Earlier uncommitted
lesson-planning/audio-recovery work remains intact. Document production code and
packaged resources are unchanged. There is no LibreOffice/Poppler integration,
worker packaging change, second teaching store or new generation pipeline.

## Resulting behavior

- `ppt-editor-handshake.ts` registers the matching document acknowledgement
  before dispatch and releases pending listeners on errors/cancellation. The
  controller retains WiseOffice configuration, source bytes, native identities
  and SDK readiness checks. Shell readiness retains 60 seconds; document opening
  and native context readiness receive a fresh shared 180-second budget.
- `useComposerSubmit.ts` restores the submitted draft on either false results
  or unexpected exceptions from send/steer. `ComposerStatus.tsx` displays a
  dismissible error using existing styles and translation keys. Existing draft
  recovery retains attachments, session ownership and newer typing. Session
  changes and subsequent attempts clear visible submission errors. Slash-command,
  queue scheduling and stop behavior are unchanged.
- `narration-language-review.ts` adapts only a narrow subset of the source's
  teacher-direction/design-language rules. Main invokes it on automatically
  generated batch speech before saving, adding existing page diagnostics. It
  never blocks, rewrites, regenerates or purchases anything. Explicit source
  selection and effect-only repair bypass it. Intentional quotations can warn;
  this heuristic is not a language-quality certificate or a fact checker.

## Verification

The new regression tests failed against the previous implementation. After
integration:

- Targeted Desktop suite: **283 passed**, zero failures:
  `node --test apps/desktop/test/composer-*.test.mjs
  apps/desktop/test/ppt-editor-*.test.mjs
  apps/desktop/test/courseware-narration.test.mjs
  apps/desktop/test/courseware-narration-batch.test.mjs`.
- Runtime: **51 passed** across narration-language-review,
  native-lesson-planning and narration-write Vitest files.
- Runtime TypeScript build, Desktop typecheck and Desktop production build passed.
  Desktop style-token check and scoped Biome lint passed. The production build
  retains its existing large-chunk advisory.
- `node apps/desktop/test/composer-submit-errors.browser.mjs` passed using real
  React submit/draft hooks, draft cache and status UI in headless Chromium.
  Submission outcomes and local services are controlled. It covers false/throw,
  attachment recovery, dismissing errors, late failures after switching sessions,
  newer typing and successful submission.
- `xvfb-run -a node scripts/e2e-ppt-editor-loading.mjs --no-sandbox` passed using
  the real Electron controller/preload/host with a controlled embed peer. It covers
  startup/document timeouts, slow shell/native readiness beyond the old shared
  budget, retry, save and close cancellation. The test shortens both budgets to
  two seconds. Test peer headers and native context responses now match the
  current host contract; its runtime import stays ESM rather than being rebundled
  into CommonJS. The controller unit fixture likewise imports that real ESM
  runtime explicitly.

Logs are `/tmp/part-a-reliability-final.log`,
`/tmp/part-a-runtime-review.log`, `/tmp/part-a-composer-browser.log`,
`/tmp/part-a-editor-loading.log`, `/tmp/part-a-reliability-typecheck.log`,
`/tmp/part-a-reliability-biome.log` and
`/tmp/part-a-reliability-build-final.log`.

## Qualification limits

An expanded suite also found a failure in
`apps/desktop/test/courseware-narration-entry.test.mjs:346`:
"timing and wait controls retain page lock, editor and draft recovery gates".
The disabled-state assertion at line 353 receives false. Both this test and its
`CoursewareTeachingPanel.tsx` implementation are unchanged from HEAD. The failure
was reproduced separately and is recorded in
`/tmp/part-a-existing-entry-test.log`; the expanded suite is not reported as green.

No real provider, paid generation, installed Desktop session, live WiseOffice
conversion/playback or installer acceptance was used. Current local known
`origin/main` is `58a9c4f57`; the remote head query did not return and was
cancelled. No branch history was changed, so these results qualify the local
uncommitted Part A candidate, not a refreshed PR integration candidate.

No commit, push, deployment or resource staging is part of this follow-up.
