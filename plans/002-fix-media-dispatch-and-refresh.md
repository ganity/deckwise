# Plan 002: Make queue admission and concurrent status recovery reliable

> Implemented and locally verified on 2026-11-01. See the [delivery evidence](../docs/spec/06-delivery/2026-11-01-scene-workflow-repairs.md) and [gate report](validation-report.json).
> Native editor/player and live-provider acceptance are separate, unperformed checks.
> Work only in /home/jhz/code/train/deckwise-desktop-worktrees/courseware-par-A,
> branch feat/courseware-par-A. Preserve existing edits; do not create another
> worktree, commit, publish, or call paid services without an execution instruction.

## Baseline and drift

Planned against HEAD `1ff749805` on 2026-10-31 **including the existing dirty
working tree** (204 status entries before plan creation). HEAD alone is not the
implementation baseline. `plans/baseline.json` contains the SHA-256 of each
existing scoped file and records proposed new files as absent.

Before implementation, run `git status --short` and compare the scoped files with
that manifest. Changes made by declared predecessor plans are expected; review
their diff and carry their invariants forward. Stop on unexplained drift instead
of overwriting it. Follow applicable AGENTS.md. Code, tests and repository docs
remain English. Update this plan's status in `plans/README.md` only with evidence.

All commands below run from the worktree root. No dependency installation or
database cleanup is required. Build outputs may go only to ordinary ignored
build directories. Real Host tests must use temporary profiles/workspaces and
the freshly built Host, never the user's Desktop profile.


## Status

- Implementation: DONE; verification and remaining coverage are recorded in the delivery evidence.

- Priority: P1 for dispatch; P2 for refresh conflicts
- Effort: M; fix risk: MED
- Confidence: HIGH; concurrent status conflict reproduced in an isolated fixture
- Depends on: none logically; execute after 001 to avoid overlapping file edits
- Category: bug / concurrency
- Result: queued work is never mislabeled as an uncertain paid submission;
  concurrent readers reconcile one order without failing unrelated waiting work.

## Current state

- `courseware-canvas-music.ts:171` calls Host begin before the queue-limited
  submit at line 177. Scene images (320/333) and saved video (39/41) do the same.
- `courseware-generation-queue.ts:35` rechecks ownership/quote after getting
  capacity. A check failure rejects without calling submit.
- `courseware-local-media.ts:118,157` reads a revision, performs async status
  queries, then writes using that revision. Two refreshes can race.
- `courseware-generation-queue.ts:90` currently rejects all waiting requests
  after any active status error.
- Host `media_relay.rs:55` correctly rejects stale journal writes. Keep this CAS.
- Exemplar: `courseware-local-media.test.mjs` uses deterministic in-memory
  persistence and mocked transport; `courseware-media-scope-integration.test.mjs`
  connects actual Main coordinators, an isolated Host and loopback HTTP.
- Limits are independent: TTS 10, image 5, layers 5, music 2, export 2, video 2.
  They are authenticated-process protection, not provider-wide scheduling.

## Scope

Existing Main files under `apps/desktop/electron/main/`:
`courseware-generation-queue.ts`, `courseware-media-transport.ts`,
`courseware-media.ts`, `courseware-music-media.ts`, `courseware-video-media.ts`,
`courseware-local-media.ts`, `courseware-canvas-music.ts`,
`courseware-canvas-images.ts`, `courseware-scene-images.ts`,
`courseware-saved-video.ts`, `courseware-tts.ts`.
Change only submission/refresh callers affected by the queue boundary.

Tests under `apps/desktop/test/`:
`courseware-generation-queue.test.mjs`, `courseware-local-media.test.mjs`,
`courseware-local-media-host.test.mjs`, `courseware-music-media.test.mjs`,
`courseware-canvas-music.test.mjs`, `courseware-scene-images.test.mjs`,
`courseware-saved-media.test.mjs`, `courseware-media-scope-integration.test.mjs`.
Host `rpc/courseware_projects/media_relay.rs` is a validation reference; modify
its tests only if needed, preserving production CAS semantics.

Docs: bounded-recovery ADR, authorized-media spec, delivery E2E plan and changelog.
Out of scope: different concurrency values, server queues, billing changes,
replacement orders, broad transport refactoring or removing CAS.

## Target behavior

Submission sequence:
```text
prepared -> wait locally -> acquire type-specific capacity
         -> validate owner/source/plan/quote
         -> Host begin (persist original request and bind current account scope)
         -> send once -> reconcile original result -> archive/adopt
```

A failure before begin leaves the intent prepared. A failure after begin remains
uncertain unless an existing authoritative refusal proves otherwise. Do not
automatically reset begun records on a generic exception.

Add the smallest internal admission callback needed by the existing transport.
It must execute once after capacity is acquired and before the network call.
The begin result, including submission scope, determines the actual request route;
do not precompute a route using a stale account/team binding before waiting.
Retain late receipt recording and before/after-await ownership checks.

For refresh, coalesce in-flight reads by authenticated principal and original
task identity across the existing client instances that share a journal. A
per-instance map is insufficient if background and foreground clients differ.
On a real CAS race, reread the committed result and validate identity; permit
only bounded reconciliation, never unconditional overwrite or another paid POST.
Do not propagate a reconciled stale-read conflict to every waiting task.

## Commands

```bash
node --test apps/desktop/test/courseware-generation-queue.test.mjs apps/desktop/test/courseware-local-media.test.mjs apps/desktop/test/courseware-music-media.test.mjs apps/desktop/test/courseware-canvas-music.test.mjs apps/desktop/test/courseware-scene-images.test.mjs apps/desktop/test/courseware-saved-media.test.mjs
pnpm --filter @pi-desktop/desktop typecheck
cargo build -p host-core --locked
DECKWISE_E2E_MEDIA_SCOPE_HOST="$PWD/target/debug/pi-desktop-host-core" node --test apps/desktop/test/courseware-media-scope-integration.test.mjs
DECKWISE_E2E_LOCAL_MEDIA_HOST="$PWD/target/debug/pi-desktop-host-core" node --test apps/desktop/test/courseware-local-media-host.test.mjs
```

Build shared/runtime packages first if predecessor changes require their exports.
Success: exit 0, actual integration tests execute with the env vars above.

## Steps and verification

1. Characterize the cross-layer gap. Saturate one media type, queue another
   intent, then expire its quote or end its owner turn before releasing capacity.
   Inspect Host phase and mock HTTP count, not just the thrown error.
   Add two concurrent status reads with a barrier forcing the same initial
   revision.
   **Verify:** scoped Node tests fail specifically on unknown phase/no POST and
   JOURNAL_CONFLICT before implementation.
2. Move begin to the admitted dispatch boundary for music/export, scene images/
   layers and video. Inspect every caller of the changed transport signature.
   Preserve ordinary canvas image and TTS behavior; do not nest another queue.
   **Verify:** Node tests and Desktop typecheck pass, including scope changes
   while waiting and two coordinators trying to begin the same intent.
3. Add shared in-flight refresh reconciliation and bounded CAS reread. Clean
   entries on resolve/reject, isolate principals, preserve terminal results.
   Cancellation of one waiter must not erase durable receipts or poison peers.
   **Verify:** concurrent get, candidates and TTS recovery cases pass without
   additional POSTs; ready never regresses to processing.
4. Extend real Main/Host queue admission and journal fixtures. Validate exact
   phase transitions across a Host restart.
   **Verify:** both environment-enabled Host commands pass; document the
   process-only concurrency boundary without claiming server-wide enforcement.

## Regression matrix

| Trigger | Required result |
|---|---|
| Queue full, quote expires | No POST; intent remains prepared; a fresh quote can proceed in a later authorized operation |
| Queue full, owner stops/changes | No begin/POST after the failed admission check |
| Account/team changes while waiting | No stale route; Host begin scope remains authoritative |
| Transport failure after begin | Original uncertain identity retained; no paid replay |
| Two coordinators begin same intent | At most one supplier POST |
| Foreground and queue poll same music | Compatible results; no unrelated queue rejection |
| Two TTS recoveries | One coherent adopted/recoverable result; no synthesis |
| Late processing result after ready | Saved terminal state and asset remain intact |
| Mixed media saturation | Each independent peak stays within 10/5/5/2/2/2 |

## Done criteria and STOP conditions

All matrix assertions pass, and existing independent limits/cancellation/refusal
tests remain green. Report the mock POST count and journal state for the
pre-admission and post-begin cases.

Stop if an implementation cannot distinguish the pre-begin failure from an
uncertain dispatch, requires weakening account fences, or would silently release
a genuinely unknown paid job. Do not add unbounded retry to fix CAS conflicts.

## Maintenance

The queue callback is a dispatch boundary, not a generic workflow extension
system. New clients must use it consistently. All original-result refresh
entrances must share the same coalescing scope.
