# Courseware workflow gap repairs — 2026-10-31

## Outcome and scope

Implemented in the existing Desktop, Platform and MAIC
`feat/courseware-par-A` worktrees. Preexisting branch changes remain intact;
no new worktree, commit, push, service deployment or paid generation was made.
This is code/fixture acceptance, not a new successful paid courseware run.

The independent generation limits remain TTS 10, images 5, layer decomposition
5, music generation 2, music export 2 and video 2. Recovery reads do not submit
another generation or acquire a new paid-generation slot.

## What the five corrective interventions actually addressed

Evidence: the preceding run's `interventions.jsonl` under
`/tmp/deckwise-live-rerun-20261031-guarantees`. Times are Asia/Shanghai.

| Intervention | Time | Failure and cause |
| --- | --- | --- |
| 1. Plan requirement correction | 15:44:48 | Closing song and retained structured teaching requirements were omitted. Free-text narration/visual intent did not capture the original user requirements as executable requirements. |
| 2. Plan schema correction | 15:48:56 | The model guessed teaching field shapes/enums, including question/music fields from other schemas. The packaged skill's old example omitted the complete supported contract, and the parser reported only `Invalid scene course page 1`. |
| 3. Plan visibility guidance | 15:49:47 | The model also needed the rule that exact question text/options belong in `visibleText`, with at most six strings. This supplemented the active schema correction rather than pausing/resuming the task. |
| 4. Narration contract correction | 17:04:07 | After repeated invalid anchors, the model invented a quotation/visible-text requirement. The real optional anchor is an exact, uniquely occurring substring in the same speech. The per-page generator lacked an internal bounded correction path. |
| 5. Existing music recovery | 17:48:40 | The model changed music parameters and submitted another request for an already represented teaching slot. Request-hash deduplication could not recognize that both requests filled the same slot. Manual guidance redirected it to original generation/export recovery. |

These are five corrective messages, separate from normal plan/style approvals,
the one explicit layer-archive repair pause/resume pair, and the final stop.
They combine model output/interpretation errors with missing program guarantees;
they are not five copies of the same skill bug.

The previous patch corrected the packaged skill example and large-layer
archive transport. This patch adds application/runtime/service mechanisms.
Prompt examples help the model choose correctly; saved-state validation,
idempotent execution and bounded recovery protect the resulting task.

## Why the final loop was ineffective

One page-4 TTS request remained `submission_unknown`. The old synchronous
service had no saved original-result lookup. Meanwhile the saved-media context
could keep listing a historical music intent even after its authored slot had
audio from another original export. Refresh could adopt that music again,
return `saved:true` and increment teaching revision.

The runtime treated these receipts/revision changes as progress and continued
refreshing. The unknown TTS could neither become audio through this loop nor be
safely resubmitted. There was no saved-media no-progress deadline or explicit
unknown-result handoff, so continuing the loop could not complete acceptance.
The final manual Stop preserved the paid jobs and generated output; it was not
an additional pause/resume pair or successful recovery.

## Implemented repairs

### Planning and page narration

- Initial one-shot scene planning permits two output corrections after the first
  invalid result. It returns exact validation feedback with bounded previous
  output and the unchanged brief/settings. Provider failure, oversized output
  and cancellation are not blindly replayed.
- Main Chat draft validation returns the supported teaching structure and exact
  question/choice strings required on the page. Legacy plans remain readable;
  normal plan approval still checks semantic fidelity to the source/user brief.
- Page narration retries only invalid JSON, schema or typed candidate output,
  at most twice. This includes anchors, command-bank constraints and canonical
  wait placement. The corrected output is validated before one serialized save.
- Successes on other pages survive. Provider errors, stale baselines,
  cancellation, Host save failures and lost save replies are not classified as
  output-format repairs. No completed page is automatically regenerated.
- The common narration prompt now states the actual optional anchor contract.

Primary files: `courseware-scene-plan.ts`, `courseware-narration-batch.ts`,
`page-narration-candidate.ts`, `narration-write.ts` and their fixtures.

### Music slots and runtime continuation

- Saved-slot preparation reuses its existing order across changed music
  prompts/titles/options. Separate authored slots remain separate.
- Adopted clips satisfy their slot, including obsolete historical duplicate
  intents. Repeated prepare/refresh does not purchase, export or adopt again,
  and does not churn teaching revision.
- Runtime queries blocked/unknown originals once in the authorized turn,
  continues independent pending and unsubmitted work, then reports an unfinished
  blocked state if only those originals remain. It never prepares replacements.
- Pending saved-media polling stops after ten minutes without meaningful state
  change. Revision/timestamp noise and repeated `saved:true` alone are excluded
  from progress. Repeated model closure uses the same semantic comparison.
- Last continuation fingerprints are restored with existing Host checkpoints.
  Existing durable diagnostic repair budgets and Host completion acceptance
  remain in force; missing audio cannot be waived by advisory quality checks.
- After a blocked handoff, the runtime permits one final reporting pass and
  blocks all further tools in that pass. It then ends the run even if the model
  tries to restart generation. Only a new user-run reset can rearm continuation.

Primary files: `courseware-saved-media.ts`, `courseware-turn-continuation.ts`, `runtime.ts`
and `courseware-stalled-continuation.test.ts`.

### Original TTS result and accounting recovery

1. MAIC claims the original Platform event UUID before synthesis, binds its
   input/voice hash, and writes the returned audio before replying. Existing
   claims never authorize a second synthesis. Internal GET only reads audio.
2. Platform records versioned recovery metadata in the existing accounting event:
   original account/project, request hash and charge. It stores no speech text
   or audio, and adds no task table or database migration.
3. Authenticated GET `/courseware/media/relay/recover?key=` resolves the actor's
   original request and rechecks project access. It reads MAIC's existing audio
   and settles the original reservation under account/event locks. Concurrent
   recovery and a late original failure cannot charge twice or overwrite settled
   accounting with an unknown state.
4. Desktop lookup/status uses this original-key recovery for unknown local TTS,
   preserves task ID, validates charge bounds and MP3 bytes, and writes the
   existing Host journal with CAS before normal decode/archive/adoption.
   Unknown/legacy responses leave its original reservation/journal unchanged.

Primary files: Desktop `courseware-local-media.ts`; Platform
`MediaRelayService.java`, `MaicTtsMediaProvider.java`, `MediaRelayController.java`;
MAIC `app/api/internal/courseware/media/[providerId]/route.ts` and their tests.

## Validation

272 targeted tests passed across the final selected suites:

| Checks | Passed |
| --- | ---: |
| Desktop saved media/narration/local relay | 58 |
| Desktop adjacent TTS/media/music/concurrency | 90 |
| Desktop scene planning and draft readers | 21 |
| Runtime continuation/recovery/narration | 64 |
| MAIC original TTS recovery and existing mxapi boundary | 27 |
| Platform relay/provider and real MySQL accounting | 12 |

The MySQL test creates/drops only its own disposable schema on the existing
local fixture port. It raced two recovery calls: equal receipts, exactly one
original consumption, zero remaining frozen points, no replacement synthesis.
Other tests cover late original failure, changed/foreign identity, legacy
events, storage failures, failed/expired result replay, cancellation, partial
success and unchanged-state loops. Supplier/LLM calls use stand-ins.

Runtime build, Desktop typecheck/production build/configured style-token lint,
and MAIC TypeScript/targeted ESLint passed. Biome does not include the touched
Main/runtime paths; its scoped invocation processed zero files, so no source
Biome coverage is claimed. Production build retains the existing large-chunk
warning. No UI verification mode or production supplier run was invoked.

Local evidence and incremental-only patches:
`/tmp/deckwise-gap-fixes-20261031`. Each edited existing file has a pre-edit
snapshot, preserving the large dirty branch baseline separately from this patch.

## Deployment and limits

Deploy matching MAIC/Platform code, rebuild/restart Desktop, then perform a new
explicit live acceptance run. MAIC reuses the existing billing Redis connection;
it must have durable persistence and retain claims without eviction/flush.
Audio is retained for seven days, at most 16 MiB per result. Host remains the
durable lesson/media archive. See [the ADR](../adr/courseware-bounded-recovery.md)
for ownership and deployment requirements.

This recovers response loss after result persistence. It cannot reconstruct
supplier audio never returned or never saved before process failure. Expired
audio and old hash-only accounting records stay unresolved and require
reconciliation; neither an automatic refund nor a replacement purchase is
justified by a missing response alone. Storage availability is a deployment
precondition, not proof that all possible provider failures are recoverable.

The previous run still has its original missing page-4 speech and eleven
non-blocking focus diagnostics. Its saved project was not rewritten here. These
code tests establish bounded recovery behavior, not full visual/teaching quality,
production Redis durability, or unattended success for every future model output.
Normal semantic plan review remains necessary; format validation alone cannot
prove that a free-text lesson/source requirement was never omitted.
