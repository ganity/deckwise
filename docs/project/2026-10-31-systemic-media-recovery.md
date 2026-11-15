# Systemic media preparation, narration and continuation repairs

- Date: 2026-10-31
- Worktree: `deckwise-desktop-worktrees/courseware-par-A`
- Branch: `feat/courseware-par-A`
- Scope: issues 2, 3 and 4 from the post-restart Greetings rerun.

## Confirmed failures and changes

1. A wrong-model music request was persisted before provider validation. Slot
   deduplication then reused that prepared request even after its model changed.
   The common generation/export coordinator now checks the configured catalog
   before preparing an intent. Saved-slot lookup prefers begun orders and reuses
   prepared requests only for an exact request hash. Export recovery similarly
   replaces only unsubmitted requests with unavailable models. Old records remain
   intact; uncertain/submitted generation and exports keep their original identity.
2. Narration could introduce music absent from retained logical-page requirements.
   Baseline preservation then resurrected it after apparent repairs. Canonical
   validation now supplies actionable feedback to the existing bounded repair
   loop. Host independently validates direct saves and legacy adoption, and both
   paths use the same normalization. Legacy unapproved slots are removable only
   with no matching submitted/unknown order in the workspace journals. Original
   speech/audio/effects and all accounting records remain intact in required-
   teaching repair. Saved-scene automatic music preparation also rejects those
   unapproved slots before purchase.
3. An original batch failure retained its intent/error but lost the speech
   association. Continuation could therefore classify that blocked speech as
   independent unsubmitted work. Context jobs and action-specific completion
   issues now carry action identity; runtime preserves it through failure handling
   without passing metadata as unsupported refresh arguments. Independent work
   on the same or other pages remains eligible. Unchanged continuation now enters
   a blocked, report-only handoff rather than throwing. Stop retains monotonic
   repair counters until checkpoint persistence; one report ends the run.
4. Counts were previously left to model interpretation. Host completion now
   counts saved speech/audio/music/questions; shared quality inspection counts
   diagnostics by code. The regression fixture verifies 211 speeches, 210 audio
   references and 20 focus warnings. These are saved-state counts, not provider
   order totals. Host acceptance remains authoritative even if prose disagrees.

No dependency, database migration, new worktree or concurrency change was added.
The existing independent limits remain TTS 10, image 5, decomposition 5,
music generation 2, music export 2 and video 2.

## Red-to-green evidence

New regressions failed before their corresponding fixes:

- Unsupported model left one durable intent instead of zero.
- Corrected generation still quoted the stale model; corrected export still
  quoted its removed prepared model.
- Host accepted a new unapproved music slot.
- Canonical narration accepted an unapproved music block.
- Failed original speech returned an independent-work continuation.
- Completion counts/action identity and quality counts were absent.
- Clearing state before a blocked checkpoint erased monotonic repair counters.

The representative paths use real Main coordinators, canonical narration,
DesktopAgentRuntime and Host database transactions. Only real external boundaries
(provider transport, Host RPC in Main tests, model stream) are fixtures. Host
persistence tests use isolated temporary databases; the user's saved lesson and
running Desktop were not changed.

## Validation

- Main: `node --test apps/desktop/test/courseware-saved-media.test.mjs
  apps/desktop/test/courseware-canvas-music.test.mjs
  apps/desktop/test/courseware-saved-narration.test.mjs
  apps/desktop/test/courseware-narration.test.mjs` — 96 passed.
- Agent runtime: Vitest over `courseware-turn-continuation`,
  `courseware-stalled-continuation`, `courseware-workflow-recovery`,
  `courseware-quality-continuation`, `courseware/narration-write`,
  `courseware-workflow-tools` and `runtime` tests — 409 passed.
- Shared teaching quality: 9 passed.
- Host courseware database tests: 165 passed, 1 existing ignored real-worker
  fixture test. The eight workflow tests were also rerun after adding legacy
  adoption assertions and consolidating normalization.
- Shared and agent-runtime TypeScript builds passed. Desktop typecheck passed.
- Host Clippy with all targets passed with existing warnings.
- Task-only whitespace checks passed. New Rust ranges were formatted without
  reformatting unrelated existing edits.

## Remaining validation limits

`pnpm build:js` is blocked by seven existing dead links in documentation outside
this repair. The direct affected-package builds and Desktop typecheck passed.
Whole-repository `cargo fmt --check` reports existing formatting differences;
those unrelated files were preserved.

No live supplier generation, paid rerun or Electron UI verification was performed.
The earlier five-report live trace motivates the handoff regression; the local
fixture reproduces the failed-original state and uses the real runtime lifecycle,
not the entire historical provider stream. The original server-side TTS HTTP 500
is issue 1 and remains outside this repair. Computed counts and Host readiness
cannot certify the pedagogical quality or truth of arbitrary model prose.
