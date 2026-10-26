# Direct narration save acceptance

Date: 2026-10-26
Worktree: `courseware-par-A` (`feat/courseware-par-A`, uncommitted task changes)

Generation now saves formal teaching directly. Chat and the teaching sidebar have
no narration-candidate lookup, review or adoption controls. Existing candidate
records and compatibility APIs remain intact; no user data was migrated or deleted.

## End-to-end evidence

[result.json](result.json) records a successful Electron Main / real Rust Host /
staged parser run on an isolated copy of the retained 56-page PPTX. It uses a
separate workspace and database; it does not generate teaching in the user's live
database. The source hash identifies the fixture without including its bytes.

- All 56 pages used full-slide raster images, entered the ordered deck plan and
  saved speech into authoritative teaching without candidate RPCs or adoption.
- Every page survived Host restart. Regenerating page 1 changed only page 1.
- A simulated page-2 model failure retained page 2's previous teaching while page
  1's new teaching remained saved. Another restart retained both results.
- A stored target-page draft blocked replacement and preserved formal teaching.
- Original PPTX bytes stayed unchanged. No editor/selection RPC was called.
- There were 120 deterministic model calls and no paid-provider calls. Initial
  full-deck generation took 199,939 ms; this does not measure provider latency.

The tested worker was the existing staged Linux bundle at
`/tmp/deckwise-core-delivery-runtime-final-20261023/pptx-worker.mjs`; the repository
resource copy lacks its native canvas dependency. Host and worker hashes are in
result.json. A first attempt with that incomplete resource copy failed before
project initialization; rerunning with the complete staged bundle passed.

## Validation

- Desktop narration, Chat, entry, teaching and tab suites: 166 passed.
- Agent-runtime candidate tools/authorized host/workflow/narration writer: 75 passed.
- Shared teaching/Chat change projection: 6 passed.
- Host courseware project suites: 203 passed, 1 existing fixture-dependent test
  ignored. The updated speech-audio/cue invalidation and music preservation test
  also passed separately. Chat RPC receipt tests: 5 passed.
- Direct-save tests cover durable writes, target-only regeneration, stale
  baselines, locks, validation failures, archive/write rollback and restart.
- Batch tests cover parallel generation with serialized saves, source/model
  guards, cancellation after a save, partial failure and lost replies without
  automatic replay. Entry tests verify instruction-only drafts move to Chat and
  are restored if Chat refuses the request.
- Shared/runtime builds, desktop typecheck/build/style-token lint, documentation
  checks (519 pages, 90 locale pairs), script syntax and `git diff --check` passed.

## Limits

Real-provider teaching quality, paid TTS and packaged/cross-platform acceptance
were not run. The live desktop was not restarted and the user's real courseware
was not regenerated. Desktop assets and this worktree's default development Host
binary were rebuilt for the next launch. Regeneration intentionally clears the replaced page's old
speech audio/cues; independent music remains. No commit, push or release occurred.
