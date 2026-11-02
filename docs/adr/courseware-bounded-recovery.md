# Bounded courseware recovery and original TTS results

- Status: Accepted
- Date: 2026-10-31

## Context

The ten-page Greetings run needed five corrective messages and a final manual
stop. Schema rejection protected saved content, but did not correct malformed
page narration. Changed music parameters could purchase another order for the
same authored slot. Unknown synchronous TTS had no original-result lookup, and
repeated successful music refreshes could keep the runtime active indefinitely.

## Decision

Keep orchestration and adoption in Desktop/Host. Repair invalid per-page model
output at most twice, using the exact validator feedback and unchanged evidence.
Do not replay provider failures, stale sources, cancellation or uncertain saves.
Initial one-shot scene planning uses the same two-correction limit. Main Chat
draft validation returns the actual teaching format and exact question/choices
that must be visible, rather than only a generic invalid-page error. Legacy
plans remain readable. Format checks cannot infer omitted semantic requirements;
normal plan approval still reviews fidelity to the user's brief and source.
Retain existing slot orders independently of cosmetic music request parameters;
an adopted slot is already satisfied and refresh must not write it again.

The runtime reconciles unknown/failed original jobs once per authorized turn,
continues independent work, then reports unfinished requirements. Pending saved
media with no meaningful change for ten minutes stops automatic polling.
Teaching revision/timestamp churn and repeated `saved:true` receipts are not
progress. Existing Host acceptance remains the completion authority.
After blocking, allow one report-only model pass, deny further tools and end
the run even if the model tries to rearm it. A new user run resets this guard.

MAIC uses the existing billing Redis connection to claim each Platform TTS event
UUID before synthesis and save its audio before returning it. Claims bind the
input/voice hash and have no TTL; audio retention is seven days, maximum 16 MiB.
Internal GET reads never synthesize. Missing/expired audio preserves the claim.
Storage unavailability before the claim prevents supplier dispatch.

Platform adds only versioned recovery metadata to the existing accounting event:
request hash, original account reference, project and original charge. It stores
neither narration nor audio. An authenticated recovery lookup uses the actor's
original idempotency key, rechecks ownership/project access, reads MAIC's existing
audio and settles the original reservation under the account/event locks. A
concurrent recovery or a late original response cannot charge it again. Music's
existing signed-receipt query/export flow is unchanged.

## Consequences and deployment

Deploy MAIC and Platform together, then rebuild/restart Desktop. No database
migration, new dependency, replacement order or billing-data rewrite is needed.
MAIC's existing Redis must use durable persistence and retain claim keys (no
eviction/flush during the ledger's lifetime). Audio is a bounded recovery cache;
Desktop Host still owns the durable lesson archive and adoption. Back up/restore
claim data consistently with the existing accounting ledger. A lost claim store
must not be interpreted as permission to replay old paid submissions.

This closes response-loss-after-persistence recovery. It cannot reconstruct
audio never returned by the supplier or never persisted before process failure.
Legacy hash-only accounting events and the previous run's missing page-4 audio
remain unresolved; preserve reservations for reconciliation rather than silently
refund, mark success or repurchase. Seven-day result expiry also requires an
honest unresolved handoff if Desktop never archived the original.

See the [repair validation](../spec/06-delivery/2026-10-31-workflow-gap-repairs.md).


### Follow-up: prepared requests and action-bound handoff (2026-10-31)

The later rerun exposed three remaining gaps: prepared wrong-model music was
mistaken for a paid order, narration could add and then preserve an unapproved
slot, and failed-batch results lost their saved speech identity. Enforce configured
models in the shared music coordinator; distinguish prepared from begun requests
in saved-slot recovery. Host enforces approved music during narration writes and
removes only legacy unsubmitted slots. Read-only context carries action identity
and computed counts. Runtime retains that identity and monotonic repair budgets
when handing an unchanged/blocked workflow to one final report. These changes use
existing journals, transactions, tools and checkpoint storage, with no schema
migration, new provider, concurrency change or replacement paid order.


### Follow-up: normalized media and terminal closure (2026-11-01)

Use the shared recovery classifier for image, music, TTS and saved-video
envelopes. An unknown submission without a known original task is not pending;
a provider/archive error is not service progress. Image recovery also has a
ten-minute bound based on semantic progress, excluding timestamp/revision churn.
A blocked original does not prevent healthy independent jobs from archiving and
adopting. Completed runs with advisory quality issues and unfinished blocked
runs both permit one final report and then close the turn. Only a new user run
resets that terminal guard. Required-action repairs now insert deltas anchored to
existing speech IDs, preserving original speech/audio/effects, and include
retained video requirements.


### Follow-up: final tool boundary and focus preservation (2026-11-01)

The Greetings rerun reached Host readiness but remained in tool/compaction loops.
Recognize saved readiness before the tool-use early return, retain checkpoint
validation, and expose only a status summary to the model. Final reporting removes
tool declarations as well as denying execution. Scene planning gets a validated
submit tool and bounded closing-response repair; human plan approval remains the
fidelity decision for natural-language requirements.

Successful scene-draft submission is not a terminal media result. Keep tools for
post-submit status reads and close on the model's existing final explanation,
without an additional tool-less response. The latter could cause DeepSeek to
render an intended tool call as ordinary DSML text. Cover-only rendering
corrections use image instructions against the approved hash; editing the actual
plan still requires renewed human review.

Character/name-label overlap must not erase a valid focus. Prefer one pictured
character or the explicit supplied target, preserving ambiguity between duplicate
pictures. Extend the existing preserving teaching delta path to missing focus;
Host resolves cues from verified saved audio instead of regenerating speech or
inventing timestamps. Existing effects and manual locks remain authoritative.
