# ADR: Portable teaching sources extend the native teaching carrier

- Date: 2026-11-10
- Status: implemented in the Part A candidate; qualification is recorded in the execution evidence.
- Related: [native document authority](native-teaching-document-authority.md).

## Decision

Keep the native PPT as the only mutable teaching authority. Add an optional bounded
`enrichment` member to `deckwise-native-teaching/1`, versioned separately as
`deckwise-teaching-enrichment/1`. It contains original logical page IDs, accepted
script segments/policy/bindings, intentional silence, and lesson-plan units with
source evidence and existing activity identities. Existing actions remain the
executable representation. Metadata and changed actions enter the same native
history transaction. Assessment insertion joins visible slide objects, answer
content and the plan binding in the same transaction.

Raw extracted attachments remain private Host records in the existing SQLite KV
store, scoped by workspace and task session, immutable by SHA-256. They are not a
second mutable teaching project. No schema migration or new database is required.
Only a source hash, accepted text and portable IDs enter the presentation. No
credentials, provider orders, local paths or attachment URLs enter this extension.

## Compatibility and rollback

Old files without enrichment retain their current behavior. New Main checks the
editor's `enrichmentCapabilities.version` before adopting sources. It cannot apply
new metadata with an older installed editor. New readers reject unknown extension
versions and unexpected/private fields. The independently validated saved-package
reader applies the same bounds as the live editor.

Current writers copy the carrier with a spread and change the requested page;
they preserve an enrichment field even when no enrichment argument is passed.
Tests cover that old writer shape, native save preparation and actual x2t save /
reopen. This is evidence for the current paired resources, not a promise about all
historical builds or external PowerPoint/WPS. External writers that strip custom
XML lose provenance; missing provenance must not be presented as an accepted
preserve policy. A rollback to a build without this capability must retain a copy
of the original PPT and must not continue automatic rewriting of fixed scripts.

Original-page labels bind once to logical IDs. Reordering/insertion does not change
these anchors. Deleted anchors and copied external speeches without an explicit
mapping remain diagnostics. Manual edits are retained and reported as divergence
from an accepted fixed source, rather than being overwritten.

## Alternatives

A second Host teaching table would create competing authority and require a new
synchronization protocol. Re-importing generated scene/PPT Master decks would lose
richer evidence. A new top-level carrier version would unnecessarily reject older
files and writers that already preserve unknown members. The bounded, separately
versioned extension provides the needed capability gate with a smaller change.
