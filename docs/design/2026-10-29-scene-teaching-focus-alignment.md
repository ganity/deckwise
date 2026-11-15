# Scene teaching focus: diagnosis and correction

Date: 2026-10-29. Desktop branch: `feat/courseware-par-A`.

## Finding

The gap is in the generation-to-playback chain, not solely in the skill.
MAIC's kindergarten motion composer uses semantic spoken aliases, verified speech
anchors, first/repeated mention policies, focus-target correction, and provider
word timings when available. Its animation vocabulary and PPTist renderer are
also broader than Desktop's current fixed-motion contract.

Inspected MAIC references: `lib/generation/kindergarten/motion-composer.ts`
(`planKindergartenSpeechCues`, `alignKindergartenFocusActions`,
`composeSpeechCueActions`, `findAnchorTiming`) and its call from
`lib/server/classroom-generation.ts`. No MAIC source was changed.

Desktop had the following concrete failures:

1. Supplied layer bounds use the native compiler path, without the semantic model
   pass that normally supplies spoken aliases. Existing narration vision produced
   a plain summary rather than UUID-bound identities. The fallback matched only
   literal object text, so image-only characters often received no focus.
2. Source-review projection could replace valid same-UUID semantics with generic
   object metadata, losing aliases on later narration generation.
3. A long speech was bound to one whole-segment focus. There was no validated
   spoken anchor; focus could begin during an unrelated introduction.
4. Prompt, normalizer, Host, portable validation, fixed compiler and loader
   enforced one animation per object per page. Later emphasis was deleted or
   rejected even though each speech has an independent serial audio clock.
5. The cue scheduler consumed zero-time cues during initialization. Fixed slide
   rendering also let future emphasis overwrite an earlier entrance/current cue.

## Implemented correction

Reuse the existing scene vision request to annotate saved object UUIDs with
observed identity, spoken aliases, text-carrier content and target eligibility.
Validate exact coverage, field bounds, duplicate/unknown IDs and ambiguous or
uncertain targets. Add no provider request and change no decomposition/placement.
Preserve verified semantic metadata only across the same mapped UUID.

Ask for short focus-specific speech. Accept an authoring-only exact unique
`attention.anchorText`, split its spoken prefix before focus, and remove anchor
metadata before canonical save. A conservative alias/longest-name fallback splits
scene clauses and binds one unambiguous object; Latin names use word boundaries.
Explicit group focus stays intact. Individual named references can correct an
incorrect single target. Uncertain matches receive no inferred focus.

Use a first intentional fade-in and allow later pulses, including repeated
emphasis on one object. All validators share the same sequence rule within their
runtime: one motion per target per speech; later pulse allowed while visible;
repeated entrance, same-speech duplicate motion and pulse after exit rejected.
Native PPT ownership guards stay enforced. TTS adoption uses actual decoded
clip duration; each short speech has its own audio clock. No character-ratio
millisecond estimates or fabricated word timestamps are introduced.

Initialize cue state without consuming time-zero cues. Fixed rendering chooses
the current/latest started object cue, so a future pulse cannot override an
entrance and later pulses sample independently. Reads never rewrite existing
teaching, synthesize audio, mutate original PPTX or regenerate images.

## Verified scope and remaining differences

Regression evidence includes formerly failing alias/anchor, repeated-animation,
zero-time scheduler and future-style cases; saved narration and semantic
projection tests; actual Host TTS adoption/readiness; portable validation;
fixed compiler/loader and playback-style sampling.
The targeted runs passed 223 unit/integration tests (16 agent, 95 Desktop,
92 courseware runtime, 20 Host). A standalone Chromium 155 run with real local
HTMLMediaElement decoding also passed `object-animation-speech-boundaries`:
future entrance held, earlier exit retained, and the same object reached scale
1.1 on each of two later speech clocks after pause/seek. Evidence:
`/tmp/scene-focus-browser-evidence-20261029/result.json` and its screenshot.
 Package builds and Desktop
typechecking cover consumers. Validation uses local fixtures, no paid services.

The following paragraph records the October 29 boundary. The native projection,
expanded motion vocabulary, typed questions, music slots and quality repair
follow-up is documented in [the October 30 implementation and acceptance record](2026-10-30-scene-teaching-parity.md).

This corrects the shared generation and fixed-playback defects. It is not full
MAIC equivalence: synchronization is by focus segment, not provider word timing;
Desktop motion remains fade/pulse rather than MAIC's zoom, path and rotation
vocabulary. WiseOffice native teaching preview currently renders focus overlays
and explicitly bound native PPT animation steps; generated speech
`element_animation` cues execute in fixed playback and are not silently converted
to native OOXML animations. Native playback parity requires a verified native
motion adapter/write-and-bind path, not a skill-only instruction or a second
animation owner. No native SDK modification is included in this correction.

Existing lessons keep their saved narration/audio. The new authoring behavior
applies when narration is generated/regenerated, then its audio regenerated;
reopening an old lesson cannot retroactively add missing cues. Real-provider
output quality and native-device playback remain unverified in this round.
