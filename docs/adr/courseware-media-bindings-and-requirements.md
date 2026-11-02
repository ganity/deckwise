# Verified courseware media bindings and retained requirements

Status: Accepted, 2026-11-01.

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
