# Plan 003: Apply bounded recovery and terminal reporting to every media stage

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

- Priority: P1; Effort: M; fix risk: MED
- Confidence: HIGH, image and terminal-report behavior reproduced in isolated state fixtures
- Depends on: 002 for dispatch-state semantics; integrates target bindings from 001
- Category: bug / tool contract
- Result: every authorized run either advances, waits within a bound, yields for
  a real human gate, or reports its unfinished/completed result once.

## Current state

- `courseware-chat-workflow.ts:105` derives waiting from task state but misses
  journal phase `submission-unknown` when no task exists.
- `courseware-turn-continuation.ts:130-168` polls images without the ten-minute
  semantic-progress guard used by `finishSaved` at lines 212-216.
- The image loop returns at the first non-waiting failure before checking later
  independent jobs.
- `courseware-saved-video.ts:49` exposes unknown at top-level `state`;
  continuation lines 294-300 inspect nested media/task state instead.
- Continuation lines 264-266 save completed then reset before returning the
  final advisory report. `runtime.ts:2339,2660` enforce termination/tools only
  when reportOnly remains true.
- Existing pattern: saved-media blockedJobs retain action identity, checkpoints
  preserve repair budgets, and blocked runs have a report-only pass.
- Preserve ADR bounded-recovery rules: original unknown queries only; maximum
  two unchanged repairs; ten minutes without meaningful saved progress.

## Scope

- `packages/shared/src/courseware-workflow.ts` and its tests; shared index only
  if an export is genuinely needed.
- `apps/desktop/electron/main/courseware-chat-workflow.ts`,
  `courseware-saved-media.ts`, `courseware-saved-video.ts`.
- `packages/agent-runtime/src/courseware-turn-continuation.ts`,
  `courseware-workflow-tools.ts`, `courseware-workflow-recovery.ts`,
  `runtime.ts`.
- Runtime tests: turn-continuation, stalled-continuation, quality-continuation,
  workflow-recovery, workflow-tools and runtime.
- Main tests: chat-workflow and saved-media.
- Skill `apps/desktop/resources/skills/scene-courseware/SKILL.md`;
  workflow/authorized-media specs, bounded-recovery ADR, E2E plan and changelog.

Out of scope: automatic plan/style approval, generation on status-only requests,
provider retry/replacement policies, payment changes, generic agent lifecycle
refactors or a new external workflow engine.

## Design

Use one typed recovery view or one shared normalizer at the existing workflow
boundary. Its essential meanings are:
- prepared: known not dispatched, eligible only for an authorized submit;
- pending: an executing/accepted original can be polled;
- unknown: an original outcome is uncertain, reconcile once per authorized run;
- failed: terminal original failure, preserve order/error and finish independent work;
- adopted: verified output attached to the saved action;
- needs-human: actual plan/style gate, never inferred from a missing task.

Do not equate provider ready with adopted. An archived-but-unattached result still
needs adoption. Retain existing raw/provider states for diagnosis and compatible
consumers; make Runtime consume the normalized meaning.

Reuse semantic-progress calculation and blocked-job handling for images and
saved media. Progress means changed task stage, archive, selection/adoption or
satisfied saved requirement; not a timestamp, revision bump or repeated receipt.
Unknown/failed tasks must not prevent reconciliation of other independent jobs.

Represent terminal reporting separately from success/failure. Completed with
advisories and blocked both close generation for the current run while allowing
one final explanation. A new authorized user run can reset the terminal guard.
Never mark a playable course failed just to activate that guard.

## Commands

```bash
pnpm --filter @pi-desktop/shared build
pnpm --filter @pi-desktop/agent-runtime exec vitest run src/courseware-turn-continuation.test.ts src/courseware-stalled-continuation.test.ts src/courseware-quality-continuation.test.ts src/courseware-workflow-recovery.test.ts src/courseware-workflow-tools.test.ts src/runtime.test.ts
pnpm --filter @pi-desktop/agent-runtime build
node --test apps/desktop/test/courseware-chat-workflow.test.mjs apps/desktop/test/courseware-saved-media.test.mjs
pnpm --filter @pi-desktop/desktop typecheck
```

## Steps and verification

1. Add regression fixtures using actual Main response shapes, including unknown
   image with task null and top-level unknown video. Use controlled clocks.
   Add a failed image followed by an independent healthy image; rearm the model
   after a completed-with-advisories report in the same run.
   **Verify:** relevant runtime/Main tests above fail for the documented behavior.
2. Introduce the smallest shared recovery contract and update producers/consumers
   together. Keep provider payloads unchanged and validate required job identity.
   **Verify:** shared build, workflow-tool tests and Desktop typecheck pass.
3. Bring image polling under semantic-progress timeout and per-original blocked
   handling. Finish independent pending and missing work after cover approval;
   preserve plan/account/source/turn fences and interrupt responsiveness.
   **Verify:** at ten minutes of unchanged meaningful state, the fixture yields
   blocked/report-only; a real progress event resets the deadline. Unknown query
   count is at most one per run, except bounded transient read retries.
4. Make completed-with-advisories enter terminal/report-only without resetting
   the durable budget. Enforce one final pass in real DesktopAgentRuntime,
   including a model attempting another workflow tool.
   **Verify:** one agent_end, no post-terminal generation, new user run works,
   and the full listed runtime tests pass.
5. Synchronize skill and specs with actual recovery decisions.
   **Verify:** the skill planning-example test
   `node --test apps/desktop/test/courseware-scene-plan.test.mjs` passes.

## Done criteria

- Image and video unknowns are not endlessly classified pending.
- One failed image cannot suppress refresh/adoption of an independent healthy image.
- A closing model response cannot end an unfinished authorized stage prematurely
  or rearm a terminal reporting pass.
- Status-only/PPTX-only requests still do not authorize teaching generation.
- Plan review and initial style confirmation remain human gates.
- Repair budgets survive checkpoints and verified source rebinding.
- No tools or new purchases after terminal handoff; exactly one final pass.

## STOP conditions and maintenance

Stop on ambiguity about whether a provider state proves dispatch or adoption;
preserve the original identity and report it rather than guessing. If a new
checkpoint field is unavoidable, document/test its default, version and old-data
compatibility before adding it. Do not broaden global runtime behavior beyond
the courseware controller.

Every new media response shape needs a producer-to-controller contract test.
Terminal-state tests must include model tool attempts, not just a polite model
that obeys the final prose instruction.
