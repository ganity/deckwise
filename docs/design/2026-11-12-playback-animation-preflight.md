# Playback animation conflicts and generation preflight

## Scope and root causes

This change continues Part A on `feat/courseware-par-A`. It repairs the two
failures reproduced with the unchanged real lessons from
`/home/jhz/deckwise-validation/part-a-fresh-20261112`.

1. Scene, page 1: a withdrawn title pulse remained in native PPTX timing after
   speech repair. The source editor had a previous-mirror reconciliation fix,
   but the staged WiseOffice module still contained the old append-only code.
   The native timer and the speech fade then competed in fixed playback.
2. Master, page 1: the red circle was a two-component group. Conversion handled
   its fade but left its later pulse bound to a group the mapping validator did
   not permit for speech animation. This was a valid visual target, not a missing
   object. Separate component scaling would distort general grouped geometry.
3. Saved-state acceptance checked narration/media/object existence, not the
   conversion rules used by fixed playback. Object requirements also used exact
   display-name equality, producing false missing-content failures.

## Implementation

- `projectPlaybackAnimations` is shared by conversion and saved-file preflight.
  Saved speech owns its visual targets' clock. Competing unbound native timing
  from older files is suppressed in the playback projection with a diagnostic;
  unrelated native animations and the original PPTX bytes are preserved.
  Explicit native teaching bindings still require valid sequencing.
- Group speech pulses and transforms use the existing native shared-center DOM
  wrappers. A wrapper-only timeline needs no synthetic click or delay. Existing
  group fades and attention overlays retain their behavior.
- Native completion runs bounded offline parsing after media is ready, then the
  shared resolver, before reporting completion. Parsing uses the existing pinned
  worker, not native image modules in Electron main. It creates no publication
  snapshot and makes no provider calls. Acceptance is cached by exact source hash,
  with owner/source/revision checks after asynchronous work.
- Preflight binding errors retain page numbers. Safe corrections use existing
  bounded narration repair, preserving speech and media. Unresolved descriptions
  first use unique verified object semantics, then visual review with exact
  aliases; they are not automatically declared missing source content.
- The rebuilt WiseOffice integration is staged in Desktop resources. It removes
  superseded speech mirrors atomically with the teaching change, including
  Undo/Redo and saved-file reopen. The old bundle remains in the evidence folder.

## Continuation and testing boundaries

The earlier validation harness hard-coded an old Master workspace and explicitly
requested a stop after export. Those were test orchestration interventions, not
proof that the product required another user turn. A corrected run must derive
paths from the current session, keep the original full-course request, and only
supply actual plan/style confirmations. It must not replay paid generation when
waiting for editor readiness or recovering an original media receipt.

Existing runtime continuation handles bounded read retries, original receipt
polling and sequential repairs in batches of at most five pages. Added regression
coverage proves that an unresolved semantic alias can be repaired and rechecked
within the same active turn without another user message or another audio order.
Cancellation, genuine source loss, exhausted repairs and unknown paid outcomes
remain explicit stops. Unlimited retries would hide failures rather than make
execution autonomous.

Saved-effect preflight is not full visual or audio playback acceptance. The
validation report distinguishes original-file playback, targeted automatic repair,
and a fresh uninterrupted full-course generation run; only observed runs count.

## Evidence

Evidence directory: `/home/jhz/deckwise-validation/part-a-playback-fix-20261112`.
The final report there records hashes, tests, real player results and the live
Chat preflight/repair receipts. The preserved input files are 3 scene pages,
3 Master pages and 4 imported pages, all generated with real services previously.

## Fresh generation follow-up

A new scene run exposed a source-grounding false positive: the vision model
reported absent spotlight/highlight/fade state as missing page content. Source
observation now receives only explicit required object descriptions, rather than
the complete teaching objective/effect plan. Its prompt states that effects are
created after observation. The full teaching requirements remain available to
narration generation and saved-effect acceptance; genuinely missing required
pictures still block writing. A regression exercises this boundary with an
objective containing highlight and fade instructions.

The fresh Master run also reproduced a readiness error after assessment audio
adoption. `PptEditorNotReadyError` reached Main correctly, but the plugin execution
reply replaced its code with `COURSEWARE_WORKFLOW_REJECTED`. The continuation
therefore could not recognize an otherwise retryable read. Main now preserves the
typed readiness code and opening/saving phase across the Host boundary, while
other failures retain their existing classification. The receiver-boundary test
fails on the old code for both phases and passes after the correction.

Fresh Master also saved the same fade on a group and one of its children. The
shared preflight correctly rejected the duplicate after group expansion, but the
Chat did not finish the correction. Playback projection now coalesces identical
component clocks introduced by expansion within one speech action, comparing
target, effect, start/end, trigger and native linkage. Different timing or effects
remain conflicts; duplicate source clocks without group expansion are not erased.
Both group-first and child-first ordering have regression coverage. Original PPTX
teaching/audio remains unchanged.
