# Saved-courseware media continuation

- Status: Accepted
- Date: 2026-10-27

## Context

Scene compilation saved a PPTX and the outline's short narration, then ended the
Chat. Detailed narration, TTS and music existed through separate editor-bound
operations. Making a teacher open every page or confirm each media result would
break the authorized automatic course workflow. Treating compilation or a task
receipt as course completion would hide missing teaching and media.

## Decision

Add sequential `courseware_media_context`, `courseware_media_prepare` and
`courseware_media_refresh` tools. Main binds them to the saved source and logical
page instead of the visible Office selection. Reuse the existing Host TTS/music
journals, principal checks, quotes, durable submission boundary, verified archives
and compare-and-swap adoption. Host remains authoritative; no second job store,
renderer agent, credential path or automatic retry of uncertain submissions is
introduced. Context reads never start paid work.

Use `continueTeaching:true` on scene compilation or a saved media context read
only for an authorized complete teaching course. The context flag resumes an
already compiled course; it does not itself submit media. Existing callers and explicit PPTX-only requests retain their
compile-only behavior. The runtime polls original media jobs every three seconds
inside the same turn and supplies actual progress to the Agent. Stop, steering,
account/session/source changes and real failures retain their existing fences.

## Alternatives and consequences

Requiring the editor's current selection would retain the navigation bottleneck.
A separate automatic media implementation would duplicate billing, provenance
and uncertain-submission recovery. The saved-page adapter reuses these boundaries
and accepts own audio adoptions while rejecting concurrent source/teaching edits.

The optional continuation arguments are additive; existing tool callers need no change.
The new tools require an Agent turn and existing Host tool permissions. Detailed
narration is marked as generated; old outline seeds remain distinguishable. Old
records require no migration. Successful pages remain saved on partial failure.

Desktop entry paths are ordinary generation, scene generation and PPT import,
sharing one PPTX editor and baseline teaching capabilities. Scene mode supports
both kindergarten and primary; school stage selects teaching strategy. Generation
returns editable PPTX plus teaching data. Only publication freezes a version and
builds PPTist. Teaching-plan approval and first-page style selection remain human
decisions; later generated assets and teaching results need no per-page approval.

TTS/music completion is not full MAIC parity. Saved media also supports planned five-second video: a bounded narration block creates a Host-owned slot; quoted supplier tasks retain their original receipt across restarts. Host accepts MP4 only after integrity checks and decoding, then replaces the slot with an archived clip. Publication includes this asset and the fixed player waits for clip playback. Live supplier and packaged playback acceptance remain unverified; reference answers are teacher-led, without automatic recognition or grading.

See [the source comparison](../validation/courseware/maic-stage-workflows-20261027.md)
and [the media contract](../spec/03-runtime/27-courseware-authorized-media.md).


## Finite teaching effects and automatic readiness

Extend the existing shared attention intent with optional `animation:fadeIn|pulse`
and expose the player's existing bounded `element_animation` cues through the
editor and source-association lifecycle. Keep highlight/spotlight and historical
records compatible. Do not accept arbitrary animation code or model milliseconds.
TTS adoption uses actual decoded duration, with a bounded entrance before focus;
repeated object targets retain focus without duplicate page animation.

After TTS or music adoption, Host atomically marks a generated scene page ready
only when every speech is generated, has adopted audio, has no unresolved intent,
and the complete page passes action, mapped-target and durable audio-provenance
validation. Imported, manually locked and incomplete pages retain their state.
No publication snapshot or player build is created here. The runtime checks
`teachingReady` as well as narration/audio readiness for the baseline chain.

An alternative was to ask for a page review after every successful adoption. That
would preserve the earlier editor workflow but break authorized automatic scene
generation. Trusting receipt IDs or string-shaped audio IDs would skip provenance;
reusing Host validation avoids that shortcut. Native PowerPoint object-animation
authoring and richer MAIC motions are separate capabilities; these cues belong to
the unified teaching data, not newly authored PPTX timing XML.

The fixed snapshot adapter removes only recognized speech-source provenance before
strict player-schema validation. Unknown fields and source values still fail;
canonical projects and immutable snapshot hashes are unchanged.


## Approved teaching requirements and video provenance

Saved narration and media context carry the Host-retained approved scene plan.
Whole-course planning and page narration use that original agenda alongside real
page evidence, so required activities and media survive the intermediate PPTX.
Video uses Platform's existing task queue and a configured per-clip tariff;
llm-ha owns only the supplier protocol. Unknown submissions are query-only.
The new Host video journal is additive, scoped by workspace/project/principal,
and cannot adopt output against changed source, slot, owner or locked pages.
No existing records need migration and video slots block automatic readiness and
publication until a verified clip replaces them.
