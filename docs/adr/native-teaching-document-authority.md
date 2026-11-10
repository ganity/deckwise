# ADR: Native presentation teaching owns its saved document

- Status: implemented on `feat/native-teaching-implementation`, 2026-11-09.
- Applies to local presentations carrying `deckwise-native-teaching/1`.
- Supersedes the editable Host teaching authority in
  [Host-owned courseware projects](host-owned-courseware-projects.md) for these presentations.

## Decision

The live ONLYOFFICE document owns native slide teaching. A namespaced custom XML
part stores document/revision identities, page UUIDs, actions, object UUIDs and
adopted media metadata. Each immutable audio/video payload occupies a separate
custom XML part in `urn:deckwise:native-teaching-media:1`. Both kinds are related
from the presentation and survive the bundled converter. The regular `.pptx`
file is the complete saved content; no new public extension is required.

Separating payloads matters: typing narration must not stringify and replace all
adopted audio. Media adoption adds bytes and the referring action within one
native history action. Narration changes invalidate its adopted audio binding.
Metadata carries lengths, MIME, measured duration and SHA-256. Playback verifies
bytes locally and requires no provider receipt. Main independently validates the
actual exported package and all media before replacing the source file.

The existing isolated editor remains. The sidebar, desktop teaching panel,
Chat narration tools, speech task adoption, music adoption, video adoption and
assessment question speech and fixed snapshot capture use its bound command route.
Chat opens a selected closed native PPTX before issuing these commands. Native commands compare the
expected document/page/revision, respect read-only state and page locks, and
never silently fall back to mutable Host teaching records. AI generation also
pins the Chat turn and native document context before applying a late result.

Native object references retain logical identities through rename, selection,
reorder and undo. The import adapter records package shape IDs before SDK ID
regeneration; names are display data. Native slide duplication assigns new page,
action, cue and object identities while reusing immutable adopted media. Export
records current package shape IDs, including nested groups. This derived export
metadata must not add a visible Undo step.

Host retains credentials, account/team authorization, private generation intents,
quotes, submission scope and task receipts. Uncertain submissions retain their
original idempotency identity and recover by query. Public document payloads do
not contain those private records. Existing explicit quote/submit controls and
Agent tool authorization remain the admission boundaries; tests use fake providers.

Fixed builds consume immutable snapshots derived from a verified saved PPTX.
They do not refresh or write a mutable classroom/teaching mirror. Host validates
source and logical mapping and archives referenced bytes; its snapshot survives
restart and carries an internal `nativeTeaching` marker. The native snapshot
adapter uses the existing fixed builder and its capability diagnostics.

## New local generation

Scene compilation (including assessment-only lessons) and official ordinary
PPT Master adoption now package native teaching before publishing their source.
The immutable original Office export is retained. Generated page/object IDs and
package bytes are deterministic for the same input; retries cannot reinitialize
an already native document or replace a different saved revision.

The Host attaches a verified generated path and document identity to the task,
not an editable teaching project/classroom. It verifies actual parser identities,
reviewed scene proofs or official export gates, saved budgets and teacher/Quiz
requirements. The document carries public logical page requirements and education
settings; private provider receipts remain in Host journals.

Chat edits and media adoption wait for normal native save before reporting
`saved:true`. Continuation reads native completion and verified current source;
it does not call the legacy workflow checkpoint API, which requires a mutable
Host teaching project. Original paid-job recovery remains in Host. Native course
state is resumed from its saved PPTX; repair budgets remain scoped to the current
Chat continuation, rather than a legacy database checkpoint.

Immutable fixed snapshots normalize document-local clip asset IDs to the fixed
content-addressed contract and derive media duration from the verified asset.
This is export adaptation only, and does not rewrite the native document.

See [generation-loop implementation and evidence](../design/2026-11-10-native-generation-loop.md).

## Native authoring capability adapters

Native narration supplies live PNG/text/UUID evidence to the shared vision and
whole-course planning pipeline. Validated semantics persist in the document,
alongside speech, using the same revision and Office-generation fences.

The assessment editor receives an ephemeral MAIC-shaped projection. Rich Quiz
content and embedded image data remain in the native carrier (`assessments`),
with grading/reference fields in strict checkpoint actions and discussion editor
details in `checkpointDetails`. Native history/save/reopen own these writes.
Fixed export reads the hash-verified snapshot carrier and archives Quiz images;
it never consults a mutable Host classroom. The media sidebar reads existing
private jobs and adopts through the native service only on an explicit request.

## Bounds and verification

The package reader bounds compressed/expanded ZIP size, XML size, media counts,
individual and total media bytes, duplicate identities and missing/corrupt assets.
The current aggregate adopted-media bound is 60 MiB; individual assets are at
most 50 MiB. Audio/video bytes are base64 inside separate custom XML parts because
that path is supported by the bundled converter without vendor patches.

Saving publishes an immutable revision and replaces the source with a same-folder
rename after hash checks. File contents are flushed; directory entries are synced
on the qualified Linux path. Windows uses rename instead of truncating copy, but
Windows/macOS crash and power-loss qualification is not established by Linux tests.

Legacy database projects, server-owned MAIC
classrooms and old-data migration are not converted by this decision. Activation
of a new local native document reads its loaded notes; it does not silently import
old SQLite teaching. The explicitly selected real Part A fixture is copied and
converted only for validation. Original worktrees, source PPTX and user profile
remain untouched. See [current evidence](../design/2026-11-09-native-teaching/progress.md)
for tested paths and any remaining qualification gaps.
