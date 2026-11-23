# ADR: Verified courseware media bindings and retained requirements

- Status: Accepted, 2026-11-01.

## Context

Saving a PPT changes its source hash without necessarily changing saved teaching.
Paid request identity must survive; matching by page ordinal or a supplier prompt
cannot establish a current target. Required-action repairs must preserve adopted
speech/audio. Free-text video intent cannot support deterministic acceptance.

## Decision

Extend existing Host-owned v1 KV records additively: music has optional `target`
(version 1, projectId, pageId, actionId, source, baseline slot prompt), or
`unresolvedProjectId` for an ambiguous legacy automatic order. Video has optional
`boundSource`, separate from immutable original source/request/hash/key. These are
record extensions, with no SQL schema/table change. Verified native saves update
bindings atomically only when logical targets and actions survive unchanged.
Legacy music resolves only by an exact source/page/slot identity with one match;
other originals remain visible and block replacement generation. No fuzzy prompt
matching, ordinal rebinding or replacement purchase is allowed.

Optional scene `teaching.video` contains purpose and prompt, bounded like music.
It requires one existing five-second silent clip. Planner serialization and the
compiled mapping preserve it. Missing slots and unverified clips block Host
completion. Question satisfaction compares exact text (trim boundary whitespace
only) and the full ordered response. Delta repair inserts only missing approved
actions at existing speech IDs and preserves original speech/audio/effects.

## Compatibility

New readers accept old records. Absent optional fields are omitted during
serialization, preserving legacy canonical page/plan hashes. Video-bearing plans
receive a different hash and use the existing approval transition. Free-text old
video intentions are not inferred or retroactively rewritten.

Old strict readers may reject records containing these new fields. Upgrade
Desktop, shared/runtime packages and Host together; do not downgrade a profile
after writing new bindings/requirements without restoring a compatible profile
backup. Silently dropping required video or verified bindings is unsupported.

## Verification and consequences

`pnpm test:courseware-workflow` builds the local Host and runs isolated real
Main/parser/Host persistence boundaries, Runtime closure and shared/Rust fixtures.
Only synthetic model/supplier output is used. Native editor/player behavior and
live provider performance remain separate acceptance checks. Unknown original
submissions can require explicit user resolution; no retry budget authorizes a
replacement purchase.


## Addendum — explicit assessment image scope (2026-11-16)

Keep the existing required-option-image default. A user's explicit text-only
choice requirement is saved as optional Quiz content
`optionImagePolicy: { required: boolean, reason: string }`, using the existing
classroom/native PPT carrier and revision-checked save. The existing
`courseware_media_assessments` tool gains `mode:configure` with exact scene IDs
and current classroom/source revisions; it creates no job or new approval gate.
A free-text chat assertion alone does not change readiness. Missing question
speech remains required. Excluded images are listed separately, retained images
are preserved, and new agent image preparation is refused for excluded pages.
Original job refresh remains available to reconcile already purchased work.

A blanket exemption would hide explicitly required images. Classifying numeric
answers or subjects in code would add brittle business rules. The saved explicit
scope uses neither approach. Existing courses without the field retain strict
readiness; old passthrough readers can preserve the content but may still report
excluded pictures missing. Upgrade the matched Desktop/runtime when relying on
this policy. No Host RPC, database, billing identity or architecture changes.


## Addendum — narration semantic review (2026-11-16)

Use the existing authorized narration model and page-rendering evidence for an
independent review before automated narration/effect saves. A trusted callback
lets the shared candidate module defer paraphrase judgments to that reviewer,
while retaining structural, object-identity and baseline checks. Text-only
matching remains the compatibility path for consumers without this callback.

Reuse the existing two bounded repairs: binding-only deltas preserve words;
content fixes replace only unsaved drafts; accepted-script effect repair retains
words/audio. Every repair is reviewed again, with current source checked after
review. Invalid/uncertain review output is an explicit failure rather than
permission to save or rewrite content. This adds LLM latency/cost and model
variance, but avoids extending subject-specific lexical rules or introducing a
parallel workflow engine. No RPC or persisted schema changes.

## Addendum — reviewer recovery and final saved-content review (2026-11-17)

Invalid verdicts still cannot authorize saves. Recover their format against the
same draft within the shared two-repair narration budget; do not regenerate a
valid draft merely because its reviewer returned malformed JSON. Page-local
uncertainty remains explicit and does not block independent page work.

Use the existing media-context tool's opt-in `reviewContent` flag at Runtime's
native full-course completion boundary. Review saved pixels and all question
analyses, not only body narration. Correct generated Quiz learner titles, existing analyses and objective reference answers through
the existing classroom CAS/save, refresh managed stale hints when necessary and review the saved page again. Preserve original imports,
locked content, speech/audio and all peer fields. This adds selected-model latency
and cost; ordinary status reads remain model-free. The result is source/model/
turn-bound, not a new durable approval, provider, workflow engine or publication
permission. Final visual/source issues outside safe field-only repair remain
unfinished and require the existing authoring workflow.

The 2026-11-18 follow-up extends the same narrow write boundary to existing
generated checkpoint guidance (`constraintPrompt`). Canonical checkpoint
details, rather than only strict playback actions, are supplied to review.
Only that named hint may change; questions, answer keys, accepted speech/media,
source CAS and the two-repair limit are retained. No new editing authority or
automatic raster replacement is implied.


## Addendum — exact teaching-region extraction (2026-11-18)

The user accepts complete teaching regions containing some surrounding scenery.
For Scene diagrams embedded in an opaque background, use a local pixel partition
and the existing native image/timing/Undo machinery. This avoids both purchasing
another stochastic decomposition and treating arrow-only effects as diagram
coverage. It does not add a universal image editor or weaken content review.

The original background's region becomes white until its crop enters; this is
intentional entrance behavior. Original decoded pixels and foreground layering
are preserved. The crop joins existing speech timing and spotlight, leaving
all speech/audio unchanged. Keep one region per page, current-pixel/revision
proof, native locks, rollback and post-save review. Native metadata records the
region identity to avoid repeated extraction. Unsupported backgrounds or failed
rechecks remain unfinished. This requires the matching companion editor bundle;
no Host database, public media API or player schema migration is introduced.


## Addendum — executable tool guidance (2026-11-18)

Observed wrong-directory and parameter failures should be prevented at the
existing tool boundary rather than by adding another generation pipeline.
Expose Host-owned paths and valid Quiz identities, describe current-document
hashes explicitly, and match refresh schemas to Main's existing validation.
Keep authoritative validation, approval, source checks and original paid jobs.

For known input failures during automatic continuation, return static repair
guidance to the model under a two-correction per-operation turn budget. This
makes recoverable mistakes actionable without automatic replay of writes or
new paid attempts. The limit is intentionally runtime-local; it is not a new
durable repair ledger. Unknown outcomes and exhausted repairs remain failures.
No database migration, workflow-stage change or relaxed acceptance is needed.


## Addendum — retain native generation budgets (2026-11-18)

A same-turn coordinator reconstruction renewed three exhausted narration calls.
Reuse the Host repair KV record instead of adding a second state store: extend it
with optional turn-scoped narration reservations and terminal failure codes.
Old records without the field remain valid; guard-only writes preserve it. New
Desktop requires the matching Host to accept the additive write field.

Keep transient editor identity for ownership fences but exclude it from stable
content identity. Reserve attempts before narration dispatch and keep the
existing ceiling. Preserve failed visual-format/planning stages instead of
relabelling them as exhausted narration. CAS and a post-generation reread prevent
budget updates from conflicting with successful semantic-repair clearance.
The tradeoff is conservative unused reservations on interruption; this is safer
than silently renewing spent attempts. This does not journal every vision or
planning request or authorize replacement media purchases.
