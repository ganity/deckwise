# 课件转换与播放运行时

> **原文镜像说明：** 本页保留完整英文规范，尚未提供全文中文译文。协议字段、约束和验收条件以 [英文源规格](/spec/03-runtime/22-courseware-runtime) 为准。

Status: independent module and A16–A18 snapshot/build/player/static-preview integration verified; continuous narration/audio playback, authenticated team flow and combined packaged acceptance remain pending.

`packages/courseware-runtime` owns local fixed conversion and playback. The Node
entry consumes a Host-authorized immutable source/teaching/mapping/asset export;
the renderer entry consumes only verified package bytes and an authenticated
asset resolver. No Next.js routes, server Agent loop, editor state, generation
provider or database is imported. The existing pi sidecar remains the Agent.
Main stays an orchestrator; Host retains workspace checks, durable state, source
adoption/CAS, immutable snapshots and job lifetime.

Conversion is the existing MAIC PPTX → ImportIR → PPTist route. Fixed inputs pin
source hash, source/teaching/mapping revisions, assets and converter manifest.
Content errors block builds; warning acknowledgement does not establish visual
fidelity. Old good packages survive failures. No live Office memory is read.
The worker process explicitly runs in Node mode under Electron. Dedicated worker
staging includes native dependencies; only the tested OS/architecture is covered.

Main discovers installed `pptx-worker/pptx-worker.mjs` first, then the staged
Desktop `resources/pptx-worker` in source launches. The optional explicit
`DECKWISE_PPTX_WORKER` remains authoritative even when missing, so a broken
override cannot silently select another bundle. The authoring module must be
adjacent to the selected worker. All paths remain Main-owned; discovery performs
no download or installation and preserves optional-runtime boot behavior.

The builder accepts an optional Host-owned AbortSignal. It checks cancellation
before I/O, between bounded verification reads, around worker execution and
immediately before atomic publication. Cancellation rejects with
`BUILD_CANCELLED`, force-terminates the dedicated child, waits for child close and
removes staging while retaining previous packages. Cleanup failure remains
observable. A cancellation arriving after atomic rename starts can leave a
complete immutable package; Host must fence adoption using its captured state
and signal. The CLI maps SIGINT/SIGTERM to cleanup and exit codes 130/143.

Playback reuses the extracted engine, scheduler and audio clock. Page/replay,
fixed narration, pause/resume/seek, structured teacher wait, media controls,
ducking and bounded player effects remain separate from native PPTX animations.
Fixed packages optionally advertise `nativeObjectAnimations: "click-appear-fade/1"`
with strict version-1 page `nativeAnimations` metadata. Only saved whole-object
on-click entrance appear (preset 1) and fade (preset 10), one target per step,
zero delay and 1–5000 ms duration are accepted for ordinary text/shape/image
objects. Group/paragraph/media targets, unknown timing/presets and a native target
also referenced by canonical speech cues fail closed before publication; timing
diagnostics cannot be waived by warning review. Generic `objectAnimations` stays
false. Old static packages remain valid without the optional field.

A standalone manual audio/video timing marker is handled by existing page-media
controls, not projected as an object animation. Only the inert root marker with
an indefinite manual start, one whole-shape target and no duration or repeat is
accepted this way. Scheduled, automatic, delayed, looping and partial-text media
timing retain their diagnostics and remain subject to the fixed-build refusal.

These native clicks execute in saved order before the page's unchanged canonical
speech/wait sequence. Each requires an explicit teacher action and uses the
existing `pptxTimeline`/PlaybackCore scheduler. The visible player rule states
that narration is not automatically aligned with these clicks. Targets start
hidden; replay resets the page, and pause/resume freezes/resumes the native fade
handle alongside the engine duration. This bounded conversion does not claim
general native animation or automatic speech alignment support.
Current decoder/autoplay errors pause for user retry. Async resume failures from
an old audio generation cannot affect the current page. Fixed playback never
calls generation or browser TTS as a fallback.

The Host supplies translated labels, selected build identity and authorized asset
bytes; package paths never choose a credential destination. Rich text is cleaned
before insertion; executable/fetchable tags, navigation and CSS resource URLs are
removed. Styles are scoped and fonts ship as local resources. Unmount stops audio
and releases Blob URLs; abort pending loads on snapshot/session changes.

A owns preview placement, Main/preload/RPC, public exports, shared/i18n wiring,
resource serving and packaging. B owns existing-Agent finite tools and durable
lineage. C owns remote task/asset authorization. A16–A18 verify persisted
snapshots, Desktop player mounting and static preview. This module alone does not
prove the continuous real-provider narration and playback flow, authenticated
team entry or packaged acceptance. Native chart/master/linked-text/formula
limits remain diagnostic.

Tests and reproducible commands are in the package README and D3 handoff. The
standalone browser fixture uses compiled Desktop module output on loopback 4259,
with actual WAV/video decoding and external requests blocked.
The same suite also runs under actual Electron with a disposable profile,
sandbox preference/context isolation, no Node integration, web security and explicit
user-gesture autoplay restrictions. Its fixture uses the Desktop CSP; every
case checks for policy violations. This validates the local renderer boundary,
not generated speech bound to current teaching, authenticated team entry or the
packaged application.

Saved-byte interoperability is tested against B7's pinned real Office files and
exact receipt-to-lineage helper. Session/save-request/source/output hashes must
match before a lineage reaches the public identity reconciler. Unchanged page
tokens may propose edit/reorder associations; they do not establish changed
object identity or authorize adoption. Copy/incomplete inventories require
explicit review. Host must persist trusted receipts, bind its exact previous
mapping and perform review/CAS. The regression's mappings are fixture data, and
B7's helper remains a test input rather than a second production bridge.

The public mount checks cancellation after the asynchronous loader returns and
before allocating a React root. A cancelled handoff rejects with the original
abort reason and disposes the loaded build. The signal covers pending mounting;
after mount success the caller must invoke the returned unmount function when
switching or closing its preview.

Playback state snapshots derive the logical scene ID from the cursor index,
including restored positions, navigation and automatic advance. Once exhausted,
the cursor is past the last page and the scene ID is absent. Stop resets it to
the first page. Host must treat this as transient playback state, not a durable
courseware snapshot or authorization to adopt a build.

The fixed loader owns copies of package and resolver bytes before awaiting their
SHA-256 checks. It decodes the verified package copy and creates playback Blobs
from the verified asset copies. Caller buffer mutation during hashing cannot
change accepted content. Existing package/asset budgets apply before copying;
Host still supplies the trusted build ID and authorized resolver.

Offline C interoperability pins actual local HTTP ready-image responses and
the exact PNG payload from C's verified mock-provider run. The existing resolver
and compiled player decode the verified image with local fixed narration and
teacher wait, without another task submission. Replayed HTTP is not live Desktop
authorization or team acceptance. Host owns authenticated retrieval and HTTP /
Result-envelope error handling; D does not select credentials or generation.

The fixed narration pause contract uses milliseconds, including the maximum
`pauseAfterMs: 30000`. The Desktop core must preserve that duration and freeze
its remaining time while paused. It reuses the speech timer; no second playback
clock or heuristic rescaling of valid fixed input is allowed.

Page-media `play()` continuations are scoped to their effect lifetime, including
mode, element and callback identity. Cleanup invalidates a pending rejection,
so old video/audio failures cannot pause a new page or replay. Current native
media errors remain visible and pause the current playback for user recovery.

A8's actual saved/reassociated Host narration retains two ordered speech actions
and a 4,000 ms `pauseAfterMs`. Canonical project validity does not imply build
readiness: review must be completed and each speech needs a fixed audio binding.
An explicitly authored D composition verifies these actions against the existing
fixed visual/audio source through the unchanged builder and public player mount.
Those local WAVs are test audio, not matching synthesized A8 narration, and the
composition does not substitute for A's immutable Host snapshot export.


Actual Office text formatting must survive the pinned PPTX → ImportIR → PPTist
route at character granularity, including a selected space and cross-run edits.
B15 interoperability fixes source bytes for original, partial and cross-run
saves. RGB is preserved and font sizes convert from source points to the
1000-unit viewport with three-decimal rounding. Office-native object/notes IDs
can regenerate without changing content identity; logical mappings remain
explicit, authored fixture data rather than automatically persisted identities.
Fixed builds retain all source bytes and diagnostics. Per-character browser
style checks are scoped evidence and do not imply arbitrary PPTX fidelity or
an immutable Host snapshot.

For trimmed fixed audio, the native media clock determines segment completion
and looping. Wall-clock timeout delivery only rechecks `currentTime`; it cannot
advance a stopped or delayed decoder to the segment end. Rechecks have a 10 ms
minimum delay to avoid spinning near a fractional endpoint. This uses the
existing trim helper and does not add another playback clock.

For nonempty trimmed loops ending at native EOF, retain the media element's
native loop and clamp its rewind with the existing seek handler. Native EOF
otherwise pauses before delayed trim callbacks can restart the loop. Empty
ranges and loops with a trimmed tail keep native looping disabled; disposal
restores the original loop flag. A busy renderer can delay the seek clamp, so
this is not a sample-accurate loop guarantee under event-loop blockage.

The fixed builder must enforce the same 256 MiB aggregate asset-reference budget
as the player. Include external fixed resources and converter-extracted PPTX
media; count separate asset IDs even when content-addressed paths coincide.
Reject overflow before publication and remove staging without replacing a valid
immutable build. Budget acceptance does not establish media decoding or fidelity.

The player/mount presentation boundary forwards existing core speech start/end,
native speech progress and teacher-checkpoint start/completion events. Optional
callbacks use the existing callback ref, so UI callback replacement cannot create
a new session. Mutable event values are copied. Consumers combine playing mode
with non-null progress for speaking presentation; normal speech end includes the
fixed post-speech silence, while null progress also handles cancellation. A wait
cancelled by navigation is not reported as teacher completion. This is a passive
role boundary, not a second classroom parser, TTS source, timer or asset grant.
See the package's `ADR-playback-presentation-events.md` for API consequences.

The mapper's generated first full-slide background image has no logical source
object. The loader retains and verifies its asset, allowing that single unbound
element only with the expected generated ID, background role, full-slide bounds
and zero rotation. All source objects still require exact unique mappings;
unbound ordinary elements and malformed background impostors remain rejected.
Rectangular image crops use the scoped renderer's overflow clipping. Explicit
page navigation retains and reports a selected page even when it has no actions;
the existing playback core continues to own action traversal and the clock.

Page media effect setup restores its verified source after cleanup. This supports
React StrictMode lifecycle replay on the same DOM node while actual unmount still
pauses the media, clears its source and releases decoding. Shared audio/video
behavior is verified through the compiled public component in Chrome/Electron;
no second clock, schema or Host lifecycle authority is introduced.


The independent browser entry also exports `loadTeamFixedBuild`. It consumes
C2b's fixedBuild transport projection, an already authorized canonical BuildRef
and a Host path-to-bytes callback. The runtime validates finite paths, file
budgets, exact unique membership, raw manifest/package/source/report/asset
hashes and semantic report/asset agreement, then reuses the full fixed loader.
Only validated selected paths cross the download boundary; signed URL fetching,
credentials, expiry renewal and HTTP/envelope checks belong to Host. Abort and
LoadedFixedBuild disposal retain existing semantics. This adds no canonical
schema, archive, playback clock or generation path. Offline C2b replay is not
an immutable A Host snapshot or actual team/production authorization acceptance.
