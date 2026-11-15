# Implemented native teaching

Date: 2026-11-09. Branch: `feat/native-teaching-implementation` in both repos.

## Ownership and file format

ONLYOFFICE owns editable page teaching, object references, locks and native Undo /
Redo. Desktop does not create a mutable Host teaching project for a native file.
Host owns credentials, team/account scope, generation intents and paid task
receipts, plus immutable export snapshots. These private records are not in PPTX.

A presentation-related custom XML part in `urn:deckwise:native-teaching:1` stores
`deckwise-native-teaching/1`: document and revision IDs, page UUIDs, actions,
logical object identities and media metadata. Each adopted audio/video payload
has a separate immutable custom XML part in
`urn:deckwise:native-teaching-media:1`. Metadata carries MIME, SHA-256, length and
measured duration. This avoids rewriting all audio while typing a sentence.
A new local document can initialize teaching from its already loaded slide notes.
General legacy database migration is outside this request.

## Unified commands

| Entry / operation | Native behavior |
| --- | --- |
| Embedded sidebar and Desktop panel | Same bound document route and revision-checked writes |
| Chat narration context / rewrite | Reads live page and applies only to the pinned page, revision and Chat turn |
| Speech, delay, question/checkpoint, cue and action order | Page actions in document custom XML |
| Lock / unlock / confirm | Native revision-checked mutation |
| Undo / Redo | SDK native history; native mode has no separate Host teaching stack |
| Highlights / spotlights / animation links | Logical object IDs resolved to live SDK objects |
| TTS prepare / quote / submit / status | Private Host journal, original task identity on uncertain results |
| TTS adoption | Verified decoded bytes and action link in one native history action |
| Music / video generation and recovery | Private journal, native planned slot, same bound adoption route |
| Reuse / preview adopted media | Local embedded bytes; no provider receipt required |
| Chat assessment media | Native checkpoint question speech; no canonical classroom fallback |
| Save / copy | Complete PPTX, including all adopted media |
| Fixed build | Immutable snapshot from saved PPTX; no editable Host teaching mirror |

Portable checkpoints use text response options. Canonical server classroom and
option-image authoring remain separate workflows. A native assessment command
never writes those canonical records. Narration edits clear their old audio
binding and invalidate text-based timing; old immutable media remains available
for native history. Adoption rejects stale targets, locked pages and wrong owners.

## Identity, history and groups

The SDK import guard captures package shape IDs before SDK ID regeneration.
Object names and slide indexes are display/import evidence, not identity.
The live model retains UUIDs through rename, reorder and native Undo references.
Slide duplication assigns fresh page/action/cue/object identities and remaps
references while reusing immutable media. Saving derives current package IDs
without adding an Undo step. Cross-document teaching clipboard transfer is not
claimed.

Explicit native step bindings also retain a signature of their logical target,
preset and timing. Changed/reordered effects reject playback/build until rebound;
they cannot silently select another effect with the same ordinal. A unique
speech-linked effect can be detached from native timing for one playback owner.

The fixed converter flattens groups. Immutable snapshots therefore retain separate
logical group aliases. The builder verifies membership from exact source group
ancestry and derives invisible attention anchors. Finite native group animations
run on wrappers around the actual descendant elements, preserving their common
transform origin, timing, grouping and paint order. Cycles, duplicate parents and
unresolved targets fail validation. Arbitrary Office effects are not silently
approximated: supported presets require their exact verified behavior pattern.

## Save and playback

Main independently validates the exported ZIP, identity and audio/video hashes.
Native save skips legacy teaching open/prepare writers. It publishes immutable
bytes, verifies the prior source digest, flushes files and replaces the source
with a same-folder rename. Late external changes reject commit. Linux directory
entries are synced. Cross-platform power-loss testing remains a release activity.

Preview uses loaded media locally. Fixed playback validates strict schemas,
source/mapping versions and finite animation capabilities. Delayed callbacks
are scoped to their page and execution lifetime; navigating or replaying cannot
apply an old native effect to the new page. Pause/resume preserves delayed Web
Animation timing. Question response configuration reaches the actual player.

Current package limits: 100 pages, 1,000 actions per page, 1,000 media entries,
50 MiB per adopted asset and 60 MiB total adopted media. Unknown schemas, missing
assets or ambiguous identities reject rather than falling back to old authority.
