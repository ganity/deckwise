# WiseOffice teaching integration: implementation evidence

Date: 2026-10-28

This records the first implementation slice, not completion of G0–G6. The approved
[design](2026-10-28-wiseoffice-teaching-integration.md) and
[implementation plan](2026-10-28-wiseoffice-teaching-implementation.md) remain the
delivery boundary.

## Source isolation

Both repositories use their own `feat/wiseoffice-teaching-local` branch/worktree.
Desktop starts at `origin/main` `58a9c4f57` and integrates the committed courseware
branch through `578bbfeeb`. WiseOffice starts at local main `3cc37956` and integrates
the committed courseware editor branch through `632c5201`. Integration is local
and uncommitted. No other worktree's dirty source is part of the candidate. The
existing running Desktop and its original task were not edited or automated.

### Current continuation worktrees

The source-isolation paragraph above records the initial candidate. Continuing
implementation now uses Desktop `feat/courseware-par-A` at
`deckwise-desktop-worktrees/courseware-par-A` (base HEAD `8b18bd9a0`) and WiseOffice
`feat/wiseoffice-native-teaching` at
`document-worktrees/wiseoffice-native-teaching` (base HEAD `632c52012699ba20f27881991693b51021e6a50b`).
The changes below are uncommitted working-tree evidence, not release-candidate or
PR integration acceptance. Existing dirty changes and the running application
remain intact. No commit, push, deployment or paid generation was performed.

## Implemented

- Desktop defaults to the bundled `deckwise-editor://wiseoffice` runtime. An
  explicit HTTP(S) development override remains. No automatic remote fallback.
- The editor partition serves installation resources with traversal/symlink
  rejection, finite methods, COOP/COEP, resource policy and isolated-iframe
  delegation. Sandbox and context isolation stay enabled, Node remains disabled.
- Brotli WASM is streamed through native decompression. Testing confirmed that
  merely returning `Content-Encoding: br` from an Electron custom protocol gives
  the compiler compressed bytes and prevents native readiness.
- Packaging includes the staged WiseOffice directory. Staging inventories hashes,
  bytes and source revision/dirty status and refuses an existing destination.
- Opening reuses the validated source buffer rather than rereading the revision
  copy. Existing baseline revision creation, external-write guards and verified
  save acknowledgements are preserved.
- A real WiseOffice E2E fixture uses the DeckWise command bridge to append fade to
  one ordinary text object, verifies undo/redo, acknowledges export, checks actual
  OOXML timing/target identity, reopens and runs the native animation preview.
  Its peer object is preserved. This is not an invocation of the complete main
  Chat permission/router stack or a paid LLM.

## Checks and actual results

- Desktop targeted tests: **36 passed** (resource paths, protocol, native editor
  contract and save lifecycle).
- Desktop full TypeScript check: passed after building its workspace dependencies.
- Resource protocol TypeScript check: passed with workspace Node type roots.
- WiseOffice existing animation/bridge unit tests: **77 passed**.
- WiseOffice TypeScript check: passed.
- Real Chromium native animation E2E: **1 passed**, including native preview;
  exported PPTX and screenshot are Playwright attachments.
- Real Electron 43.6.0 source probe: **passed** with an isolated profile,
  `sandbox: true`, `contextIsolation: true`, `nodeIntegration: false`, and every
  HTTP(S) request denied. It opened the existing five-page task bytes, exported
  **11,953,409 bytes**, acknowledged save and reopened **5 pages**, with
  `crossOriginIsolated: true`, **0 remote requests**, and byte-for-byte unchanged
  source. The exported test copy was temporary; nothing was adopted into the task.
- `git diff --check`: passed.

The local Electron distribution initially had an incorrectly installed SUID
sandbox helper. The source probe used an isolated hard-linked Electron directory
with the machine's existing root-owned Chrome sandbox helper. It did not disable
sandboxing or alter the user's Electron distribution/system configuration.

## Reproduce

Build WiseOffice using its production Vite/build tooling with root resource paths.
Then, from the Desktop worktree:

```sh
node scripts/stage-wiseoffice.mjs /absolute/path/to/wiseoffice/dist
node --test apps/desktop/test/editor-host-protocol.test.mjs \
  apps/desktop/test/editor-resource-path.test.mjs \
  apps/desktop/test/ppt-editor-contract.test.mjs \
  apps/desktop/test/ppt-editor-save.test.mjs
```

Run the isolated Electron probe with a correctly installed sandbox helper:

```sh
env -u ELECTRON_RUN_AS_NODE /absolute/path/to/electron \
  scripts/verify-local-wiseoffice.mjs /absolute/path/to/fixture.pptx
```

The script never writes its input. Do not add `--no-sandbox` to bypass a failed
environment. `stage-wiseoffice.mjs` requires a new destination so an existing
bundle remains available; keep old/new staging directories separate during updates.

In the WiseOffice worktree:

```sh
E2E_PORT=4197 pnpm exec playwright test \
  test/e2e/deckwise-native-animation.spec.ts --workers=1
pnpm exec vitest run test/unit/slide-object-animation.test.ts \
  test/unit/deckwise-editor-bridge.test.ts
pnpm exec tsc --noEmit
```

## Open gates and limits

G0 still needs the complete main Chat dispatch path, the image/notes/multiple-slide
fixture, identity round trips, overlay geometry and slideshow/media completion
probes. A two-text-object fade test does not certify those capabilities. G1 still
needs packaged OS lanes, measured cold/warm budgets and safe initialized-editor
reuse. The open-time revision baseline remains intentionally present.

G2–G6 are not implemented by this slice: native teaching sidebar, unified timeline,
automatic speech/music/video sequencing, same-canvas attention preview, portable
Host-owned sidecar migration and full player parity. Existing teaching storage
authority and the current outer panel are unchanged.

Inherited documentation gates report an incomplete direct-image ADR/index,
two delivery spec index entries and two missing Chinese spec counterparts from
the integrated branch. These are not represented as passing gates. No installer,
production release, paid generation or remote deployment was performed.

## Integration into the runnable courseware branch

The local-editor increment is integrated on top of courseware commit
`81aca3013368332e02396c9ea91a282abe07ccd3`. The development launcher no longer
overrides the local editor default with a hosted URL; explicit environment
overrides remain available. The runnable worktree receives the ignored
WiseOffice bundle separately from Git. The remaining G0–G6 limits above still apply.

## Native sidebar implementation increment

Desktop branch `feat/courseware-par-A` now enables a bounded teaching request
channel for its local WiseOffice session. The Host teaching coordinator remains
the persistence authority; native UI requests reuse its source, page, revision,
lock and current-conversation checks. Deferred draft recovery writes retain their
original view identity after navigation. No filesystem path or provider credential
is returned to the editor.

WiseOffice source is in `document-worktrees/wiseoffice-native-teaching` on branch
`feat/wiseoffice-native-teaching`, based on `632c52012699ba20f27881991693b51021e6a50b`.
Its native right property area now contains the teaching timeline and a rail entry:

- Automatically read current-page narration and available voices/tasks.
- Edit/reorder/delete narration and existing audio/video/interaction nodes; add
  narration and teacher-continue nodes; edit legacy post-speech pauses.
- Persist versioned recovery drafts and reject stale baseline recovery.
- Save through existing teaching writes; narration changes invalidate old speech
  audio and attached cues using the same invalidation fields as Desktop.
- Use one speech card for narration, voice/model selection, explicit quoted TTS
  generation, status checks, archive/adoption and verified local audio preview.
- Check pending TTS outcomes every ten seconds without resubmitting generation.
- Edit existing highlighter/spotlight cue lists and add cues against Host-provided
  eligible mapped objects. Host validation remains unchanged.
- Keep original WiseOffice animation controls. Native property buttons and teaching
  share one area. The outer tools are available under Advanced Teaching Tools
  for workflows not yet migrated; they are not the default second sidebar.

Known remaining work: same-canvas attention geometry/preview, whole-timeline media
preview and pause/resume, native slideshow synchronization, video/music picking and
regeneration inside the native timeline, sidecar migration, automatic Main Chat
refresh push, and the full native Chat animation acceptance matrix. Existing
teaching data stays in its current Host store; this increment does not claim the
complete G2–G6 design is finished.

Validation uses the actual production WiseOffice SDK in Chromium with a simulated
Host response harness for UI save/reload. It does not prove a new production paid
TTS request or a real Host database write end to end. Desktop coordinator tests
cover current-page fences, draft dispatch, TTS request routing and verified local
speech playback bytes. Existing save and TTS regression suites remain required.

The production bundle was staged into the runnable Desktop worktree after the
native sidebar Chromium test passed. The previous bundle is retained in
`.cache/wiseoffice-before-native-teaching`. The isolated Electron probe now also
checks a simulated Host teaching response inside the native pane before its
PPTX save/reopen round trip. Observed result: 5 pages, cross-origin isolated,
11,953,409 saved bytes, zero remote requests, nativeTeaching=true. No user source
file, active application session or production paid-generation task was changed.


## Same-canvas attention preview increment

On `feat/courseware-par-A`, the native timeline now offers **Preview this cue**
and **Stop preview**. Speech audio preview displays active highlight/spotlight
intervals on the native canvas. The existing fixed player's `SpeechCueScheduler`
reads native audio time; pause, buffering, seek, end and cleanup reuse that clock.
Native PPT animations still use WiseOffice's animation controls.

Desktop staging bundles the shared browser-only scheduler and spotlight geometry
into `deckwise-runtime/teaching-preview.mjs`, including bytes and SHA in the resource
inventory. WiseOffice loads this same-origin resource lazily; there is no server,
new dependency, generation request or filesystem path returned to the editor.

Host projects expose current saved shape IDs and compiler-owned object names only
for mapped scene objects. The real SDK probe found that native import renumbers
OOXML shape IDs. Generated scene object names survive import, so a clean opened
source additionally resolves its exact unique compiler name. Missing/ambiguous
objects, wrong source hashes, deletion, replacement and groups fail closed; display
ordinals and spoken aliases never select a target. Geometry reads all four native
transformed corners and the SDK's CSS coordinate conversion, clipped to the slide
viewport. Effects are overlays only and do not create document history entries.

This slice requires a clean opened PPTX. Saving and reopening is required after
PPT edits/source changes before preview; portable identity rebinding remains a
later gate. Generic imported objects without a compiler-name/current-ID proof do
not gain inferred native bindings. Text editing, page changes, sidebar closure,
stop and disposal release audio, scheduler frames, overlays and Blob URLs.

Validation: targeted Host/coordinator and native geometry tests; real Chromium
production SDK with actual WAV playback, 50/100/150 percent zoom, cue preview,
pause, forward/backward seek and unchanged PPT history. Host responses in this
browser test are simulated. No paid generation or production task was changed.
Whole-page sequencing, music/video picking, native slideshow synchronization,
portable sidecar authority and full Chat animation acceptance remain open.


Observed checks for this increment:

- Desktop targeted teaching/TTS/editor/resource tests: **131 passed**.
- WiseOffice targeted sidebar/geometry/bridge/action tests: **102 passed**.
- Desktop and WiseOffice TypeScript checks: passed.
- Shared package build and isolated runtime browser/Node builds: passed.
- Actual SDK Chromium preview/narration acceptance: **1 passed**, using the shared
  compiled runtime and real local WAV. No production Host database was used.
- Staged resource inventory: **2894 files** verified byte-for-byte against SHA.
  The runnable Desktop bundle is updated; the previous sidebar bundle remains at
  `.cache/wiseoffice-before-attention-preview`.
- Isolated Electron probe: 5 pages reopened, 11,953,409 saved bytes, zero remote
  requests, nativeTeaching=true, previewPrimitives=true. The source was unchanged.

To include the preview assertions in the WiseOffice browser harness, first build
Desktop's courseware runtime, then run from the WiseOffice source worktree:

```sh
DECKWISE_PREVIEW_RUNTIME=/absolute/desktop/packages/courseware-runtime/dist/teaching-preview.mjs \
E2E_PORT=4199 pnpm exec playwright test test/e2e/deckwise-teaching-sidebar.spec.ts --workers=1
```

These are source-worktree validation results; no installer, commit/push, paid
provider request, deployment or full G0–G6 completion is claimed.


## Sequential narration preview increment

The native sidebar can now play this page's adopted narration in timeline order,
including legacy post-speech silence and explicit teacher-continue checkpoints.
Pause/resume, failed-source retry, speech progress, seek and cancellation delegate
to the existing `PlaybackCore` and `AudioPlayer`. This is not another timeline
engine. No browser speech synthesis or reading-time fallback can report a missing
recording as completed. A failed source pauses on the same node and displays the
error; a teacher checkpoint requires its distinct Continue Teacher action.

The pane reads verified local speech bytes using the existing TTS preview request,
with an aggregate 256 MiB preparation budget. One run identity fences preparation
and playback callbacks. Stop remains usable during preparation and prevents a
late runtime/media response from starting playback. Stop, edit, navigation and
completion dispose playback, attention overlays and prepared Blob URLs. Active
nodes are marked without changing native slide history. Highlight/spotlight
intervals follow the core's speech progress; native PPT animation preview remains
separate pending its synchronization gate.

The shared preview module now exports the finite timeline adapter. Desktop staging
uses the same browser environment definitions as the runtime build. Desktop-owned
`.deckwise` resources bypass WiseOffice's service-worker cache; a revised resource
URL also avoids a previous worker's cached scheduler-only module.

This is specifically **Play this page's narration**. Existing music/video and other
checkpoint nodes are rejected before playback with a visible explanation; they are
not skipped or reported complete. Native music/video acquisition, full teaching
playback, explicit-delay schema migration and native slideshow parity remain open.

Validation uses the real core with a simulated browser-audio edge (26 runtime
checks), 103 WiseOffice geometry/sidebar/bridge checks and a real SDK Chromium flow
with two actual WAV speeches and a teacher checkpoint. The browser flow checks
pause/resume, distinct teacher continuation, natural completion, overlay cleanup,
unchanged native history and existing teaching edits/save/reopen. Host responses
remain simulated; no paid provider operation or production task is modified.


The narration-sequence production bundle is staged into the runnable worktree.
All 2894 resource entries were checked against their byte lengths and SHA hashes;
`.cache/wiseoffice-before-narration-sequence` retains the preceding bundle. The
isolated Electron source probe opened/saved/reopened 5 pages with 11,953,401 export
bytes, zero remote requests and the new timeline export present. Its source file
remained byte-for-byte unchanged. WiseOffice and runtime TypeScript checks pass;
`git diff --check` passes in both worktrees. Changes remain local and uncommitted.


## Adopted music/video preview increment

The native sidebar now provides **Play this page's teaching** for saved speech,
legacy post-speech silence, teacher waits, adopted music and adopted MP4 clips.
It prepares only already archived local media. No provider query, download,
submission or fee is triggered by preview. Unprepared video slots and unsupported
interactions reject before playback instead of disappearing from the sequence.

`CoursewareNativeMedia` receives only the pinned view, teaching revision and
current action ID. Music resolves through the existing adoption/snapshot receipt
and export archive. Video uses the additive `courseware.video.asset.get` RPC.
Video snapshot capture and native preview share one DB attachment/scope validator.
The Host verifies adoption, account, session, source, current slot and archive;
Main verifies bounded regular-file length and SHA again, then rechecks the editor
and principal before returning bytes/MIME. Paths and credentials stay out of the
editor. Symlink reads, corrupt files and late context/account changes reject.

The finite preview adapter reuses `PlaybackCore` and `AudioPlayer` for speech and
music. Its video surface completes the core's existing media checkpoint only on
actual video `ended`. Native video controls and timeline pause/resume use the same
HTML video element. Video time comes from `currentTime`; teacher continuation
cannot skip a running/failed video. Decoder/play failure pauses on the same clip
for explicit retry. Stopping removes listeners, pauses/unloads the video, clears
effects and revokes all prepared URLs. A per-attempt fence ignores late rejected
play promises from a canceled attempt.

Current video presentation is the native teaching pane's video preview area.
This increment does not place clips inside native PPT shapes or synchronize
WiseOffice's own slideshow. Existing media is playable; picking/reusing another
asset and generating new music/video from this pane remain separate work.
Portable sidecar authority, full Chat animation/save/readback acceptance and the
remaining G0–G6 gates remain open. Earlier narration-only rejection notes above
are historical and superseded for adopted music/video by this increment.

Validation:

- Host project DB/RPC tests: **214 passed, 1 ignored** (the existing ignored test
  is not counted as passing), including the new full-dispatch video archive read.
- Desktop targeted coordinator/bridge/TTS/editor tests: **145 passed**.
- Shared runtime/core/scheduler tests: **31 passed**. Browser media is the mocked
  edge in unit tests; sequential core execution and its cancellation remain real.
- WiseOffice sidebar/geometry/bridge/action tests: **104 passed**.
- Actual production SDK Chromium flow: **1 passed**, including local MP3 and H.264/
  AAC MP4 decoding, natural completion, pause/resume, teacher waits, speech cues,
  unchanged native history, saved edits and reopen. Browser Host responses are
  simulated; separate Rust tests exercise the actual DB/RPC authorization path.
- Runtime browser/Node builds, Host debug build, and Desktop/runtime/WiseOffice
  TypeScript checks passed. No real task or paid provider operation was changed.

These remain local source changes, not a committed or packaged release. Restarting
the dev app is necessary to pick up the new Host RPC and staged editor bundle.

The final media-preview bundle is staged in this branch's
`apps/desktop/resources/wiseoffice`. All **2894 entries** match their recorded
lengths and SHA-256 hashes; `.cache/wiseoffice-before-adopted-media` retains the
previous bundle. A fresh isolated Electron probe reopened 5 pages, exported
11,953,410 bytes and made zero remote requests (`nativeTeaching=true`,
`previewPrimitives=true`); the original PPTX was unchanged. Rust formatting and
both worktrees' diff checks passed. The latest real Chromium sequence also
includes two adjacent videos to exercise old-event isolation. Changes remain
local and uncommitted; the user's running app and real generation task were not
restarted or modified.


## Existing-media authoring increment

The native teaching pane now automatically lists archived music and adopted
videos belonging to the current project/session/account. Choose an existing item
under **Add existing music or video** and append it to the current page's teaching
timeline. The existing move/delete/save controls then apply. Unsaved narration
must be saved first, so adding media cannot overwrite an editing draft. Already
attached music is disabled in the selector; video may be deliberately reused at
multiple positions or on another unlocked page.

Listing and previewing remain local, without provider requests. Explicit reuse
performs the existing original-task permission GET, verifies the archive and uses
Host teaching-revision CAS. It never submits generation, downloads the media again
or buys another export. Music uses the existing adoption coordinator. Video keeps
one original generation intent/task and adds backward-compatible optional
`placements` receipts; old records without placements still deserialize. The
same placement proof authorizes preview and final-snapshot capture.

Each video insertion has a stable action ID across unknown-response retries.
Duplicate acknowledgements return the existing insertion, while a deleted node
cannot be resurrected by retrying that operation. Deleting the original video
node preserves access through a still-attached authorized placement; deleting
all placements removes that access. Session/account/source changes and forged
asset references still reject. This is a project-local library of existing
tracked assets, not an arbitrary-file importer or a new generation UI.

Validation:

- Desktop native media/sidebar, existing music adoption, teaching and TTS tests:
  **121 passed**, including no-provider listing, explicit permission-only reuse,
  stale editor rejection and reused-video snapshot provenance.
- Host project DB/RPC suite: **214 passed, 1 existing ignored**. An additional
  targeted run passed after adding original-node/all-placement deletion checks.
  Cross-page reuse, duplicate retry, restart persistence and deleted-node rejection
  use the real database; the RPC tests exercise full dispatch and archive checks.
- WiseOffice sidebar/geometry/bridge/action unit tests: **106 passed**.
- Real production SDK Chromium flow: **1 passed**, including selection, insertion,
  actual playback of the newly inserted MP4, saving and reopening its timeline.
  Browser Host responses remain simulated. No production task is edited.
- Desktop and WiseOffice TypeScript checks, Rust formatting and both repository
  diff checks passed. Runtime primitives are unchanged from the prior increment.

G4 still needs explicit delay nodes and remaining authoring/history coverage.
Portable sidecar migration, complete main Chat/native-animation acceptance and
WiseOffice native-slideshow/media synchronization remain open. This increment
supersedes the earlier note that existing-media selection was not implemented;
it does not complete G0–G6.

The production SDK build is staged into the runnable Desktop branch with all
**2894 entries** checked against their length and SHA-256 manifest. The previous
bundle is retained at `.cache/wiseoffice-before-media-library`. Host debug build
and 37 editor-save/protocol regression tests passed. Restart the dev application
to load both the new Host RPC and the new bundled editor; an explicit
`DECKWISE_EDITOR_URL` still overrides the bundle and must point to a build carrying
the same teaching bridge. No source or data from the real five-page task was
rewritten by this increment.

The fresh Electron probe is **not passing evidence** for this increment: the
ordinary display run produced no completion and was terminated; the isolated
Xvfb run reported WebGL1 blocklisting and hit its 150-second outer timeout
(exit 124). The exact cause of the Electron hang remains unproven. The successful
Chromium SDK E2E above remains valid; prior Electron probes belong to their earlier
bundles and do not certify this new staged bundle. Manual Desktop acceptance and
packaged operating-system lanes remain outstanding.


## Explicit-delay timeline increment (2026-10-29)

The native pane now adds independent **Delay** nodes with editable integer
`durationMs` from 0 through 30,000. They use the existing reorder/delete/save
and recovery-draft path. Invalid duration edits retain the previous value and
show an error. Delays do not request TTS or media. Speech `pauseAfterMs` remains
unchanged; schema migration is deferred to the planned sidecar version change.

The fixed player's existing pausable timer executes delay nodes, so there is no
second scheduler in the editor. Pause freezes remaining time; Resume continues
it; Teacher Continue cannot skip it. Stop/disposal cancels the pending timer.
Host validates the exact delay shape on writes, preserves it through snapshots,
source review and deleted-page recovery (with fresh IDs). Both fixed conversion
and verified package loading accept the same bounded node; invalid packaged
values reject before playback. Old strict players reject new delay packages;
this additive authoring feature does not silently omit intervals on old players.

Validation from the current uncommitted trees:

- Runtime preview/core/verified loader/fixed-conversion tests: **84 passed**,
  including actual conversion to a package and loading its preserved delay.
- Shared teaching-history contract tests: **5 passed**.
- WiseOffice sidebar/geometry/bridge/native action tests: **91 passed**.
- Desktop sidebar/teaching coordinator tests: **69 passed**.
- Host courseware project DB/RPC suite: **215 passed, 1 existing ignored**.
  Includes real snapshot preservation, invalid durations and deleted-page
  history recovery retaining duration while replacing the old identity.
- Production SDK Chromium E2E: **1 passed**. It plays speech -> teacher wait ->
  explicit delay -> MP3 -> two MP4s -> speech. Pausing longer than the delay
  leaves the active delay unchanged, Teacher Continue stays disabled and Resume
  completes it before music. Save/reopen and existing-media reuse still pass.
  Host responses in this browser test remain simulated, separately covered by
  real DB tests and actual fixed-package conversion/load.
- Runtime build/typecheck, Shared build, Desktop/WiseOffice TypeScript checks,
  Host debug build, Rust formatting and both worktree diff checks passed.

All **2894 staged editor resource entries** were verified by length and SHA-256.
The preceding resource bundle is retained at
`.cache/wiseoffice-before-explicit-delay`. Restart Desktop to use the new Host
and bundled editor. No running user application or real task was modified and
no paid generation, commit, push or deployment was performed. Generated native
screenshots are in `.cache/teaching-attention-evidence`.

This advances G4 and fixed-player parity for silent intervals, not completion of
the full design. G3 main-Chat native-animation acceptance, timeline undo/history
coverage, native slideshow synchronization, G5 portable sidecar migration and
remaining G0–G6 acceptance gates are still open. The earlier Electron probe hang
remains unresolved; this increment has actual Chromium SDK evidence, not a new
successful Electron or packaged-OS acceptance run.


## Native draft undo/redo increment (2026-10-29)

The native pane now exposes explicitly labeled **Undo unsaved edits** and
**Redo unsaved edits**. They restore whole current-page action drafts, including
original speech audio/cues when undoing text invalidation. Node insertion,
reorder/delete, delay edits and cues use the same edit history. Undo/redo stop
active playback and persist recovery drafts through the existing serialized Host
CAS path; they neither commit teaching nor mutate the native PPT history.

A new edit discards redo. History is bounded to 20 snapshots and 4 Mi UTF-16
units per stack. Authoritative save/adoption, native page/source context change
or reinitialization clears the stack; recovery draft content remains available.
Failed saves preserve draft history. Browser text-field undo keeps its ordinary
meaning. The pane states these limits rather than advertising saved-version or
compound PPTX/teaching rollback. Host receipts and native operation correlation
remain necessary for the complete design's persistent/compound undo gate.

Validation:

- Native sidebar/geometry/bridge/animation unit suites: **97 passed**, including
  exact original action restoration, redo invalidation, add/reorder/delete,
  failed-save preservation, page/source isolation and the twenty-step bound.
- WiseOffice TypeScript and both worktree diff checks passed.
- Actual production SDK Chromium flow: **1 passed**, exercising text undo/redo,
  unchanged native presentation history index, save resetting both controls,
  reopen and all existing speech/delay/music/video playback steps. The first
  attempt failed because the new assertion referenced a test-local variable
  outside its scope; that test error was fixed before the passing run.
  Browser Host responses remain simulated. No Desktop/Host authority code or
  protocol changed in this increment, so the preceding DB/RPC results were
  not rerun or claimed as new results.

No paid provider operation or real user task was modified. Source changes remain
local and uncommitted. Native slideshow synchronization, G5 sidecar migration,
main-Chat animation roundtrip, persisted/compound undo and Electron/packaged-OS
acceptance remain open; this is not completion of G0–G6.

The tested production editor is staged into `feat/courseware-par-A`'s local
resources. All **2894 manifest entries** match their byte lengths and SHA-256
hashes. `.cache/wiseoffice-before-draft-undo` retains the prior bundle. Restart
Desktop to load this pane; explicit development URL overrides still take
precedence. Screenshots are in `.cache/teaching-attention-evidence`.


## Native slideshow capability and playback ownership (2026-10-29)

Added an actual SDK capability E2E (`deckwise-slideshow-capability.spec.ts`). It
creates a native fade, starts a dedicated native slideshow canvas, verifies its
unfinished main sequence, steps the animation, pauses the real native elapsed
clock and resumes to native completion. It observes actual slide/end callbacks,
positive slideshow geometry and unchanged presentation history. This establishes
that the pinned build exposes usable native completion/clock/viewport state;
it does not prove arbitrary step seeking, full-screen cue alignment or combined
lesson sequencing. JSON evidence is attached to the Playwright report.

The production sidebar now cancels its owned teaching preview immediately on
native slideshow start, page change and end. Its audio/video, effects, active node
and object URLs are disposed. Page teaching play stays disabled during native
slideshow, and the notice explains that native slideshow does not yet consume the
teaching timeline. Exit re-enables the teaching controls without auto-playing.
Preview-run fencing also rejects speech or overlay preparation that finishes
after Stop or slideshow enter/exit. Pane disposal removes SDK subscriptions.
This keeps one active playback owner while the complete slideshow adapter is
still under construction.

Validation:

- WiseOffice sidebar/geometry/bridge/native-animation unit suites: **99 passed**,
  including disposal of active media, callback cleanup and late speech readback
  after both slideshow entry and exit without a resurrected audio element.
- WiseOffice TypeScript and both worktree diff checks passed.
- Actual production SDK Chromium E2E: **2 passed** (native capability probe and
  full teaching sidebar flow). Entering native slideshow during actual speech
  removes teaching video/overlay/active markers and disables teaching play;
  exit restores controls without automatic media. Existing delay/music/video,
  draft undo/redo, save and reopen checks still pass. Browser Host responses are
  simulated; this increment changes no Host authority or media service code.

Combined teaching/native slideshow, native-step-to-speech bindings, full-screen
attention geometry, portable sidecar migration and remaining G0–G6 gates remain
open. This is new measured capability evidence and a required playback ownership
transition, not a claim of synchronized native lesson playback. No real user task,
paid generation, running app, commit, push or deployment was changed.

The tested production bundle is staged into `feat/courseware-par-A`. All **2894
resource entries** match their length and SHA-256 inventory. The prior bundle is
retained at `.cache/wiseoffice-before-slideshow-ownership`. Restart Desktop to
load it; an explicit editor development URL continues to override the bundle.
The unresolved Electron probe and packaged-OS acceptance gaps remain unchanged.

## Owned current-page native teaching slideshow (2026-10-29)

Implemented the native sidebar's **Present this page's teaching** command. It
prepares existing Host-authorized local media, opens the saved slide in an owned
native slideshow canvas, waits for native transition/main-sequence completion,
and starts the existing shared teaching core. Click-triggered native animation
steps remain actual canvas clicks, not estimated timers. Speech, music, videos,
standalone delay and teacher-continue waits then run in order. The canvas toolbar
provides Pause, Resume, Teacher Continue and Exit; successful completion returns
to the editor. Escape, page changes, dirty source and disposal cancel playback.

The actual SDK exposed two integration defects during this increment. Its
presentation controller opened a second default preview in response to the
custom canvas start notification; a narrowly scoped marker check now preserves
only DeckWise's owned canvas in both vendored controller builds. Separately,
read-only slideshow input was counted as document interaction, which reloaded
the teaching pane and stopped playback when a control was clicked. The existing
interaction observer now excludes this surface while continuing to invalidate
ordinary document input. This changes neither native animation history nor
saved project/media data. Vendor updates must retain the marked-canvas guard.

Attention projection uses the native slideshow rectangle and canvas backing/CSS
sizes. Saved-source, target identity and geometry guards remain active. Native
automatic page advance, embedded media (including groups), non-main/triggered
sequences, builds and animations outside appear/fade reject before playback.
This avoids duplicate native media and claiming motion/exit target coordinates
without a verified projection adapter.

Validation:

- Nine relevant WiseOffice unit suites: **199 passed**, including native
  completion, pause, callback cleanup, manual navigation, stale source/native
  errors, unsupported timing/media and read-only interaction stamps.
- WiseOffice TypeScript and both worktree diff checks passed.
- Chromium production-SDK E2E: **2 passed** on the final `dist-e2e-4220` build.
  The integrated flow creates a real native fade, exports and reopens PPTX,
  rebinds its saved hash, verifies no teaching before the click animation ends,
  then plays actual browser audio/music/consecutive videos with cues, delays,
  teacher wait and pause/resume. Cue SVG bounds match the SDK rectangle within
  two CSS pixels. Natural completion, explicit Exit and Escape leave no active
  media/markers/overlays; native history remains unchanged. Ordinary native
  slideshow still cancels separate teaching preview without auto-starting it.
- Browser Host replies are simulated; SDK export/reopen, native animation,
  geometry and browser media elements/decoding are real. No production media
  request, user project mutation or paid generation occurred.

Staged the tested editor into `feat/courseware-par-A`'s built-in local resources,
verifying **2894 files** against their byte lengths and SHA-256 inventory. The
previous bundle is retained at `.cache/wiseoffice-before-teaching-slideshow`.
Restart Desktop to load the staged bundle. `DECKWISE_EDITOR_URL`, when explicitly
set, still overrides these resources and must serve an equally updated editor.
No commit, push or deployment was performed.

Remaining gates include native animation steps interleaved with individual
speech nodes, whole-deck native teaching scheduling, motion/exit/triggered/native
media compatibility, portable sidecar migration, compound saved undo and the
packaged Electron/OS acceptance described above. Current-page preview is usable;
it is not completion of G0–G6 or the entire design.

## Whole-lesson native teaching playback (2026-10-29)

Extended the native sidebar with **Present the entire lesson**. The command
visits the saved native pages in order and reuses each page's native teaching
preview and shared timing core. It does not create a second media scheduler or
read teaching from a different storage path. Each page is loaded through a fresh
Host view and recovery-draft read, and existing local speech/music/video is read
only for that page. Page completion disposes media/Blob URLs/cues before advancing.
A preparation cover spans page changes and provides Stop/Escape. Native show
controls display lesson page progress. Successful completion restores the starting
editing page; manual navigation/cancellation does not commandeer the user's page.

A run retains the source hash, teaching revision, logical page inventory and
actual native slide instances. Every page must still match, with no recovered or
unsaved draft, duplicate mapping or context-generation change. A mismatch stops
before that page plays. Each native main sequence must actually finish before
its teaching starts; supported native click effects remain actual canvas clicks.
Unsupported native effects/media retain the prior explicit capability guards.
Media errors remain paused/retryable, rather than counting as page completion.
The command neither generates/submits/adopts media nor writes teaching content.

Internal page reads/repaints now preserve only their own lesson run. Ordinary
sidebar refresh, human navigation, dirty source, Stop/Escape, native exit and
pane disposal retain cancellation. Pending media readback cannot restart a
cancelled lesson. A return-to-editor error after all pages played is reported
separately rather than swallowed or confused with playback completion.

The representative browser fixture now has two distinct saved pages and actual
PPTX export/reopen with a native fade. The test drives a whole lesson through
native animation, speech/cues, teacher wait, delay, actual music/consecutive
videos, automatic page advance, second-page speech/wait, original-page restoration
and another run cancelled with Escape. Existing single-page/native/editor,
media adoption, draft undo/save/reopen checks remain in the same flow.

Targeted unit evidence: **207 passed** across nine WiseOffice suites. Added cases
cover both starting pages, fresh page-scoped Host/media reads, changed source or
teaching revision, unseen recovery draft retention, cancellation during media
preparation, unexpected user navigation and editor-restoration failure. TypeScript
and worktree diff checks passed. The final browser/build and resource staging
result are recorded below after verification.

Remaining design gates still include native steps interleaved with individual
teaching nodes, portable sidecar migration and project copying, compound saved
undo, fixed-export scheduling parity and packaged Electron/OS certification.
Whole-lesson playback preserves the already verified appear/fade subset; it is
not a claim that the complete design or E1–E20 is finished.

Final verification: production-SDK Chromium suites **2 passed** against
`dist-e2e-4225`, including the full two-page flow and Escape cancellation plus
the native capability probe. Unit suites **207 passed**; TypeScript passed.
Browser Host responses are simulated; native export/reopen, animation, geometry
and media decoding/completion are real. No provider request, paid generation or
real user project mutation was performed.

The final build is staged into `feat/courseware-par-A`'s built-in local editor.
All **2894 files** match the staged length/SHA-256 inventory; the previous bundle
is retained at `.cache/wiseoffice-before-whole-lesson`. Voice/status/media catalog
reads remain automatic for every prepared page, so stopping there leaves an
editable teaching pane; late catalog repaint cannot interrupt newer preview media.
Restart Desktop to load it. An explicit `DECKWISE_EDITOR_URL` still overrides the
built-in resources. No commit, push or deployment was performed, and packaged
Electron/OS acceptance remains open.

## Fixed export attention after native entrances (2026-10-29)

Continued on `feat/courseware-par-A`. Investigation of per-node animation work
found an earlier compatibility gap: native preview accepted attention after a
completed native entrance, but both fixed builder and loader rejected every
speech cue targeting that object. Narrowed the conflict to speech
`element_animation` cues. Highlight/spotlight are now accepted on objects already
revealed by the existing supported before-narration native appear/fade sequence.
The saved native sequence, teacher gates, audio clock, mappings and package schema
are unchanged. Unsupported native timing and competing animation owners still
fail explicitly; this is not per-node native animation binding.

Added an authored native-fade OOXML fixture and a real worker-to-builder-to-loader
test. The test checks native click order and the two mapped attention cues, rejects
all three competing speech effects, preserves the prior package on failure and
checks staging cleanup. Loader tests also reject missing primary/additional
attention bindings and competing fadeIn/fadeOut/pulse cues with the exact error.

Validation: **73 tests passed** in five targeted runtime suites; runtime TypeScript,
bundle isolation, browser-script syntax and diff whitespace checks passed. The
new `fixed-native-attention` browser case **passed** against the compiled runtime
and actual worker-built package. Chromium observed native click gating, actual
Web Animation pause/resume, local WAV playback, highlight/spotlight on the revealed
target, paused seeking, replay and navigation cleanup. The screenshot was also
inspected. The fixture is authored test content, not an exported real user project.

Local evidence is under
`packages/courseware-runtime/.cache/native-attention-CLSmFk/browser-evidence-2/`;
the matching package hash is
`31ec10185e29004b9e17b7498f6ec555742f86a86a5414007270ac7dd3fbb0b3`.
Runtime bundles were rebuilt for the Desktop branch. WiseOffice source/resources
were not changed in this increment; the existing native sidebar bundle remains
staged. No user file, provider, commit, push or deployment was touched.

The next remaining work still includes saved per-node native animation bindings,
portable sidecar migration and copying, compound saved undo and packaged
Electron/OS acceptance. The before-narration compatibility fix above completes
only that specific fixed-export parity case; G0–G6 and E1–E20 remain open.

## Native per-step control and completion gate (2026-10-29)

The previous goal turn made verified progress on fixed-export attention parity.
This increment continues the native-step capability needed for persisted
interleaving, rather than treating that compatibility fix as completion.

The owned native teaching slideshow now has Next PPT animation, native
Pause/Resume and actual completed-step counts. The finite step command calls
`OnNextSlideAnimPlayer`, which cannot fall through to another slide. Its promise
resolves only from the selected effect's actual `isAtEnd()` state while the run
is current and unpaused. There is no duration-based completion timer. Resume
uses `StartAnimation(currentPage)` instead of the broader native Play command,
which can advance pages when no animation is paused. Existing manual canvas
clicks remain available; the native controls disappear when preparation ends.

The driver rejects duplicate commands, active/paused/transitioning steps,
changed pages/effect instances and disposed runs. Foreign advancement beyond a
pending step rejects that operation and stops the owning preview. Disposal and
SDK refusal reject pending completion. Before starting, timing must expose the
pinned state APIs, bounded integer duration, zero delay, click-effect node type,
a single supported main sequence and one direct current object per effect.
These checks do not widen native presets or allow embedded native media.

Real SDK capability evidence now uses two native fades. After the first actually
ends, the second remains idle and the page/main sequence remains unfinished.
Only the second finite step completes the sequence. The sidebar browser case
exports/reopens the saved fade and exercises the new controls before speech,
attention and media. Manual clicks, whole-lesson playback, source fences,
Escape, media reuse, recovery and native takeover remain covered.

Final validation: **211 unit tests passed** across nine WiseOffice suites;
TypeScript and diff whitespace checks passed. Both actual production-SDK
Chromium suites **passed** against final `dist-e2e-4227` (about 2.3 minutes).
Host responses in that browser harness are simulated; SDK state, PPTX
export/reopen and media playback are real. No paid/provider generation, live
user project changes, packaged Electron acceptance, commit or push occurred.
Logs are `/tmp/wise-native-step-final-unit.log` and
`/tmp/wise-native-step-final-e2e.log`; screenshots are retained under
`.cache/teaching-attention-evidence/native-steps-*.png`.

The final bundle is staged into the default built-in editor of
`feat/courseware-par-A`; all **2894 resource files** were length/SHA-256 verified.
The previous bundle remains at `.cache/wiseoffice-before-native-steps`. Restart
Desktop to load it; an explicit `DECKWISE_EDITOR_URL` continues to override the
built-in editor. WiseOffice source remains in the dedicated native-teaching
worktree, with Desktop's runtime bundle updated for local testing.

Remaining work is still substantial: saved source-bound native-step nodes,
Host validation and source-change handling, sidebar binding/reordering,
shared-core/native completion integration and fixed-export interleaving parity,
portable sidecar authority/migration, compound saved undo and packaged acceptance.
No timeline binding schema was added in this increment; G0–G6/E1–E20 are not
complete. The new step driver is the native execution seam for that next work.

## Source-bound native timeline storage and fixed playback (2026-10-29)

Added strict version-1 `native_animation` teaching nodes bound to the saved PPTX
hash and page-local ordinal. Shared and Rust Host validation reject extra fields,
invalid versions/indices, source mismatch and non-prefix order. DB restart and
immutable snapshots preserve valid nodes. Source-change narration projection
refuses to carry old ordinals. Host validates the stored contract; actual native
inventory is validated during conversion, not during teaching writes.

Fixed export requires complete original-order bindings and emits version-2 native
metadata / `teaching-timeline`, capability `click-appear-fade/2`. Loader validation
is independent. Bound nodes execute in place through the existing playback core;
legacy unbound pages retain before-narration clicks. Attention before entrance
and duplicate speech/native animation ownership are rejected. No second preset,
object geometry or playback clock is stored in teaching nodes.

Final verification: **133 runtime tests passed** across eight suites, including
actual worker conversion/loading, canonical adaptation, invalid bindings and
previous-package preservation. **140 Host courseware tests passed, one ignored**.
**15 shared contract/editor tests passed**. Runtime/shared TypeScript and runtime
bundle build passed. A test XML assembly bug initially selected an inner closing
tag; selecting the main sequence's final closing tag fixed the fixture without
weakening production validation.

Compiled Chromium passed `fixed-bound-native-timeline`: introduction before
entrances, two ordered fades, highlight, teacher wait, delay, spotlight, animation
pause/resume freezing, replay reset and old-media cleanup on navigation. Audio
and Web Animations are real; no provider was called. Evidence:
`packages/courseware-runtime/.cache/native-timeline-xV8quH/browser-evidence-2/`;
package SHA-256:
`2ffb6c824c9b9c199319023815c157e01afcc1f147603f7fbf9a7d13bf483ef1`.
Logs: `/tmp/native-binding-runtime-final.log`,
`/tmp/native-binding-runtime-types.log`, `/tmp/native-binding-host-final.log`,
`/tmp/native-binding-shared-final.log`, `/tmp/native-timeline-browser-2.log`.

Changes are local on `feat/courseware-par-A`. WiseOffice source and staged editor
resources retain the previously verified native-step-control bundle. Sidebar
binding authoring/reordering and native/shared-core per-node execution are still
pending; the native preview explicitly rejects these nodes instead of skipping
them. Portable sidecar authority/migration, compound saved undo and packaged
acceptance remain open. No user PPTX, paid generation, commit, push or deployment
was touched; G0–G6/E1–E20 are not complete.


## Native sidebar bindings and automatic step completion (2026-10-29)

The preceding turn was verified progress on persistence and fixed playback. This
increment connects that contract to native authoring and owned teaching
presentation. The sidebar now offers **Bind this page's PPT animations** and
**Remove animation bindings**. Binding reads the existing supported main sequence
of the clean source matching page lineage. It appends all native steps with exact
source/ordinal pins. Users move nodes around speech/media/delays; changing native
ordinal order is rejected, and individual native deletion is disabled so a page
does not accidentally retain incomplete bindings. Existing draft undo/recovery
and Host writes remain the authority. No paid operation is added.

Bound presentation starts teaching after transition completion, before native
entrances. The shared playback core uses private completion checkpoints to call
finite native `next(index)`. Actual SDK effect end releases a step; no estimated
duration or teacher click does. Native pause/completion fencing and explicit
teacher waits remain distinct, including colliding user checkpoint names. Errors
stop bound playback and require restart, rather than replaying an ambiguous
ordinal. Before starting, source/count/order and cue target proofs are checked;
attention before entrance and duplicate native/speech animation ownership fail.
Canvas/key advancement is blocked while bound playback owns the presentation;
Escape and teaching controls remain. External SDK advancement, effect replacement,
source mutation and navigation reject ownership. Legacy unbound/manual
preparation is preserved. Editor-only playback directs bound pages to teaching
presentation instead of silently skipping their animations.

Final checks: **150 WiseOffice unit tests passed** in six relevant suites;
**78 runtime tests passed** in four suites; **70 Desktop coordinator/native
bridge tests passed**. WiseOffice and runtime TypeScript passed; runtime bundles
and declarations built. Whitespace checks passed. The two actual production-SDK
Chromium suites passed on final `dist-e2e-4228` in about 2.5 minutes, including
sidebar binding, moving, saving/reloading, automatic entrance, attention,
pause/resume, blocked canvas advance, Escape and binding removal. The existing
whole-lesson, media, manual preparation, source fences and native takeover cases
remain in that run. Host responses in browser are simulated; native animation,
PPTX save/reopen and media are real. Logs:
`/tmp/native-bound-wise-e2e.log`, `/tmp/native-bound-wise-final-unit.log`,
`/tmp/native-bound-runtime-final-unit.log`, `/tmp/native-bound-desktop-tests.log`.

The final production editor bundle is installed in Desktop's default resource
directory on `feat/courseware-par-A`. All **2894 resources** were length/SHA-256
verified; the previous bundle is retained in
`.cache/wiseoffice-before-native-bindings`. Restart Desktop to load this bundle.
An explicit `DECKWISE_EDITOR_URL` still overrides the built-in bundle. WiseOffice
source remains in `document-worktrees/wiseoffice-native-teaching`, branch
`feat/wiseoffice-native-teaching`, with its existing uncommitted integration work.
No commit, push, provider generation, live app attachment or real user document
mutation occurred. Existing browser screenshots were moved out of the WiseOffice
source root to Desktop `.cache/teaching-attention-evidence/native-bindings-*.png`.

G0–G6/E1–E20 remain open: this proves the supported appear/fade timeline path,
not arbitrary timing/media ownership, portable sidecar authority/migration,
compound saved native+teaching undo or packaged Electron/OS acceptance. The full
design objective is retained; these outstanding gates are not redefined away.

## Portable project commit journal foundation (2026-10-29)

The previous goal turn made verified native-sidebar binding/playback progress.
This increment starts G5 in its required order: a Host-owned recoverable file
commit before portable schema/RPC migration or switching teaching authority.
The proposed decision is recorded in
`docs/adr/courseware-portable-project-commits.md`; the existing accepted SQLite
teaching authority remains unchanged.

`courseware/project_commit.rs` owns a bounded PPTX/JSON pair under an authorized
existing project directory. An OS file lock excludes independent handles and
other Host processes. Retained directory descriptors and no-follow/regular-file
checks anchor filesystem access. Source/teaching objects are content addressed,
hash verified and file/directory synced before publishing a strict pending
journal. Reopen rolls forward only from recorded old/new hashes. Unknown journal
versions/fields, damaged archives, unexpected index changes, foreign public bytes
and symlink/non-file entries refuse without accepting a mixed project. A current
index already naming the next version requires exactly the next public bytes;
it cannot authorize overwriting an external revert. Stale caller revisions and
reused current commit IDs reject. Teaching-only updates do not rewrite PPTX.

An early implementation used check-then-rename for public files. Before mounting
anything, this was replaced with Linux no-replace capture/publication: retain the
actual predecessor, reverify it, then publish only into an empty destination.
An external save filling that gap is preserved and blocks recovery. A process
still holding the old source descriptor can write its retained predecessor;
those bytes remain recoverable rather than being unlinked. Missing source during
the capture/publish gap is accepted only with the verified retained predecessor.
Unpublished temporary files are never current content. Orphans, old objects and
predecessors remain until reference-aware cleanup exists.

Validation uses an actual isolated PPTX fixture and JSON file-pair fixtures (not
a claim of the future teaching schema). Return-based fault injection covers ten
logical archive/journal/capture/publication/index/ack boundaries for both initial
and update commits. Separate child Host-test processes exit without destructor
cleanup at each of ten boundaries; another process also proves OS lock exclusion
and release. Tests cover source-preserving teaching edits, stale revisions,
external edits/reverts, racing publication, late writes through old descriptors,
corrupt/missing archives, strict journals, symlinks, bounds and directory copy
followed by deleting the original. No SQLite or provider is involved in that file
pair copy test; it does not yet certify portable teaching/media migration.

This writer is Linux-only and is deliberately not mounted on an RPC, existing
save path or user project. It accepts bounded JSON at the file-transaction layer;
strict teaching/mapping/media schema validation must precede activation. Public
project-copy UI, durable verified media, opt-in migration marker and post-migration
sidecar authority, coherent native/teaching Save and compound undo are pending.
No private receipt/account data was exported, no real user source was edited,
and no editor resource staging, commit, push or deployment occurred this turn.

Final journal evidence: **15 focused Rust tests passed** (including the child
process probe), covering **20 initial/update interruption cases** plus **10
actual child-process exits**, and the conflict/copy/lock cases above. Log:
`/tmp/portable-commit-verified.log`. `cargo check` passed with dead-code warnings
because this module is intentionally not mounted; no warning was suppressed.
The pending strict schema/migration integration must replace that unmounted state.
Agent-policy synchronization and diff whitespace checks passed. Full G5 is not
claimed complete by this infrastructure test.

## 2026-10-29 — G5 strict teaching/media file validation

Continued on `feat/courseware-par-A`. Added
`db/courseware_projects/portable.rs` and connected its strict teaching schema to
`ProjectCommitStore` commit, verified read and pending-journal recovery. The
previous opaque JSON fixtures now use the actual portable envelope. It preserves
unfinished narration, lock/review state, education context, bound mapping evidence
and the supported timeline union. Source/commit pins and persistent project
identity must agree; unknown/private fields, invalid targets/timing, duplicate
IDs and stale/out-of-order native bindings reject without silently rewriting
content. Actual native step existence/ownership still requires the existing SDK
or fixed-build inventory checks.

Portable media uses only `media/<sha256>.bin` plus explicit ID/hash/MIME/length
and measured duration. The Host transaction writer archives bytes durably,
verifies length/hash before publishing teaching and rechecks them during recovery
and verified reads. Missing or altered bytes and symlinks fail. MIME/duration must
come from the existing authenticated decoder flow; this increment does not add
a decoder or trust provider duration. Legacy canonical IDs stay intact beside a
persistent project UUID. No provider account, intent, receipt or signed URL is
accepted in portable structured metadata.

Evidence:

- **22 focused tests passed**, including all original 20 initial/update boundary
  cases and 10 actual child-process exit/reopen cases, strict negative cases,
  media symlink refusal and malformed-but-hash-consistent journal refusal.
  Log: `/tmp/portable-schema-complete-tests.log`.
- **310 courseware regression tests passed, 1 existing ignored** after the schema
  and union additions; the last extra media-symlink test then passed in the
  22-test focused run. Log: `/tmp/portable-schema-courseware-final.log`.
- Directory-copy test carries actual fixture WAV bytes, teaching cues, native
  binding, delay, wait, lock and review state; deleting the original still permits
  complete content/media recovery without SQLite. The source/identity is an
  isolated schema fixture, not proof of real parser lineage or a mounted Desktop
  fresh-profile migration. Full-union validation also covers synthetic video
  metadata; it does not claim real video generation/decoding/playback.

No existing RPC, save route, SQLite authority or user project was redirected.
The accepted Host/SQLite ADR remains unchanged. Opt-in migration and its marker,
normal editor-save coordination, project-copy UI, actual fresh-profile import and
playback, compound saved undo and final G6 acceptance remain pending. Existing
native sidebar resources were not restaged this increment, and no running user
app or real deck was touched. G5 and the full G0–G6 / E1–E20 scope remain open.

## 2026-10-29 — G5 mounted Linux project-copy path

Continued on `feat/courseware-par-A`. The editor toolbar now offers **复制完整课件**
for a clean saved PPTX and **打开课件副本目录** after success. It copies already saved
teaching; pending sidebar drafts must first be saved. Main accepts only the
session, uses the existing saved-source parser lock and current native binding,
and forwards exact source/teaching revisions to `courseware.project.copy`.
Unchanged sidebar and prepared source-review context survive a read-only copy or
missing-media failure; parser cleanup failure still invalidates them. Native edit,
Chat/session changes and malformed Host results are fenced.

Host resolves the persisted session workspace, verifies fresh parser lineage and
reads canonical teaching in one SQLite transaction. The TTS review/adoption
matcher now also returns matched audio metadata; its existing source-change
validation/rebinding callers retain their behavior. Copy uses that matcher plus
existing local music/video adoption records. Manual page locks do not prevent
copying already adopted media. No platform permission refresh, provider download,
generation, charge or receipt reclassification is introduced.

The transaction writer creates a new
`courseware-copies/<new-project-uuid>.deckwise/` under the owning workspace, commits
PPTX/teaching/media durably and re-verifies before acknowledging. Existing copies,
symlinked parents and foreign destinations cannot be overwritten. Known WAV fixture
bytes traverse the actual dispatched Host RPC and installed PPTX worker in an
isolated test. Copying that output elsewhere, deleting the original workspace and
Host database, then reopening verifies the exact real PPTX, complete teaching and
audio without the old SQLite. The provider receipt is simulated locally; this is
not a new paid-generation or packaged GUI test.

Inspection found a real compatibility detail: generated pages reuse IDs such as
`narration-0`. Portable node/checkpoint uniqueness is therefore page-local, matching
canonical authoring and playback; same-page duplicates still reject. The real
worker test now includes repeated IDs on different pages and unfinished speech.

Strict optional authored metadata now includes scene semantic roles/aliases,
regeneration instructions and original bound scene identity, plus image-lock
records. The existing image-lock validator is shared, not replaced. Current-source
locks must match current mapping/object fingerprints/native shape proof. Historical
pins remain historical, with no automatic rebinding. Metadata round-trip tests
prove preservation and reject invalid proofs/private diagnostics.

Verification:

- **315 courseware regression tests passed, 2 ignored** in
  `/tmp/portable-copy-final-regression.log`. One ignored case is the installed-worker
  test below, explicitly run separately; the other is pre-existing.
- **Real parser + dispatched copy RPC test passed** against current sources in
  `/tmp/portable-copy-real-verified.log` (4.33s). Includes foreign-session and stale
  revision refusal, different globally selected workspace, locked/unfinished
  teaching, exact original bytes and private-receipt exclusion.
- **69 Desktop teaching coordinator tests passed**:
  `/tmp/portable-copy-main-verified.log`.
- Shared build and Desktop type checking passed; final type log:
  `/tmp/portable-copy-types-verified.log`.
- `cargo check -p host-core --locked` passed in `/tmp/portable-copy-check.log`.
  Two dead-code warnings remain for standalone reopen/returned source fields,
  whose production restore path is not yet mounted; warnings were not suppressed.
- Agent-policy synchronization and whitespace checks passed. The changed Rust
  modules and tests were formatted. No user app, real deck or provider was touched.

Still pending: UUID-based automatic project reopening/media rehydration in the
editor, opt-in/idempotent authority migration and marker, source-only-copy notice,
normal Save/Save As coordination, compound saved undo and G6/E1–E20 final
acceptance. Copying saved content is now mounted; opening a copied PPTX does not
yet automatically restore its teaching. SQLite remains authoritative for ongoing
editing. No commit/push or WiseOffice resource restaging occurred this increment.

## 2026-10-29 — G5 Host portable restore and local media provenance

Implemented the Host layer for restoring a portable copy into the existing SQLite
authority. This increment does **not** activate automatic editor restoration or
change normal save authority.

- `courseware.project.restore` derives ownership from the persisted session and
  a successful saved parser job. The workspace-contained `lesson.pptx` directory
  is opened component by component through retained directory descriptors, with
  symlinks refused before recovery can write. Commit/public files, strict teaching,
  fresh mapping evidence and all media hashes/lengths must verify.
- Media enters the existing Host archive before a single transaction imports the
  canonical project, identities, scene roles/aliases/prompts, image locks and
  portable baseline marker. A metadata conflict rolls back every database record;
  failed archival may retain immutable orphan files under the existing cleanup
  policy. Existing unexpected archive bytes are never silently repaired.
- UUID-derived `portable-<uuid>` identity is independent of the new editor job and
  old profile path. Successful restore binds that parser job to the UUID, so
  ordinary `openSaved` and copying resolve the same canonical project. Original
  parser output is retained. Only portable seed diagnostics are cleared, matching
  the intentional omission of private diagnostic messages in copied identities;
  actual source/page/object/native evidence still compares exactly.
- An identical baseline reopens without overwriting local edits. A different
  baseline with the same UUID, a markerless existing project or changed local
  source rejects. This marker is for idempotent import, not authority migration.
- `courseware.project.localMedia` checks exact current source/teaching revisions,
  page/action/type and asset reference against the portable baseline. Changed
  speech text cannot reuse previous TTS. It rechecks archived bytes before
  returning a private Host-to-Main path. No account, provider receipt or network
  request is fabricated. Re-copy combines still-valid imported files and newly
  adopted provider assets through separate provenance checks.

The installed-worker test now moves the copy, destroys the original profile,
creates an unrelated Host database, parses a new editor revision, dispatches
restore and ordinary open, retrieves the actual WAV, and re-copies the restored
project. It also checks damaged copied media before first import, stale views,
cross-page refusal, unchanged local edits and changed-text audio refusal. Unit
tests cover TTS/music/video reference provenance, source/fingerprint mismatch,
scene/image-lock restoration and transaction rollback. Symlink-walk refusal is
tested before external metadata creation.

Validation logs are retained under `/tmp/portable-restore-*.log`. A parallel
courseware regression run encountered one existing immediate-reopen file-lock
contention in `every_commit_boundary_recovers_an_entire_previous_or_next_pair_after_restart`.
That case passed in isolation (`portable-restore-journal.log`); the final full
regression is run serially and recorded in `portable-restore-regression-serial.log`.
The cause of the parallel-only contention has not been proved or fixed in this
increment. It must not be reported as an unconditional parallel-suite pass.

Final verification:

- **317 courseware tests passed, 2 ignored**, serialized, 703.06s:
  `/tmp/portable-restore-regression-serial.log`. The installed-worker test is one
  of the ignored tests and is run explicitly below; the other remains pre-existing.
- **Installed parser + dispatched restore/open/media/re-copy test passed**, 18.73s:
  `/tmp/portable-restore-real-final.log`. Uses isolated real PPTX/WAV fixtures and
  synthetic provider receipts only to construct the original local adoption.
  No paid provider request is made.
- `cargo check -p host-core --locked` passed:
  `/tmp/portable-restore-cargo-check.log`. One existing dead-code warning remains
  for the standalone test-used `ProjectCommitStore::open`; the mounted restore
  uses the stricter workspace-anchored reader. No warning is suppressed.
- Targeted rustfmt checks, policy synchronization and `git diff --check` passed.
  Main/WiseOffice sources did not change in this increment, so their previous
  type/UI results are not claimed as fresh checks.

Still required before automatic editor restore: Main's authorized source-path
handoff and detection, known-local-source/review handling after native saves,
portable MIME/duration decoder validation, native sidebar media playback and
fixed snapshot/export consumption of local provenance. No renderer restore route
or automatic `withSaved` call is enabled here. The copied-project open flow is
therefore still incomplete. Normal Save/Save As, opt-in authority migration,
old-client behavior, compound saved undo and final G6/E1–E20 acceptance remain
open. No real user deck, running app, paid provider or WiseOffice resource was
touched, and no commit/push was performed.

## G5 automatic attachment and portable media consumers (2026-10-29)

This increment continues on Desktop `feat/courseware-par-A`, HEAD
`8b18bd9a0412d469debe846da28344b9d9c0d01b` plus the preserved uncommitted
implementation tree. No WiseOffice resource was changed or restaged. Results
below concern the isolated source tree, not a release or refreshed-main candidate.

### Implemented behavior

- `PptEditorController.teachingSnapshot` retains the actual authorized source
  path separately from the archived saved-revision path. Under its existing
  exclusive parser lock, Main calls private `courseware.project.attach` after
  parsing each original saved source and before open, review, copy or capture.
  Replies are strict; cancellation, source-path/page/session changes and errors
  release the parser without running the saved operation. Candidate-output
  parsing never acquires the original project's UUID implicitly.
- Host distinguishes plain PPTX files from portable `lesson.pptx` files without
  writing metadata for plain files. Sidecar/current/pending markers require
  verification. A removed sidecar with retained commit metadata cannot silently
  open an empty project. Unsupported platforms retain ordinary PPTX behavior
  and reject portable attachment.
- First attachment imports the existing strict, byte/identity/media-verified
  portable baseline into canonical Host SQLite. Subsequent attachment checks
  the same baseline and binds every new parser job to the stable UUID without
  overwriting local teaching edits. An already imported project may associate
  changed public PPTX bytes only when they match the fresh parser. Ordinary
  `openSaved` still rejects until explicit source review associates pages and
  effect targets. The old backup sidecar is never overwritten by this flow.
- Source review preserves imported media only for the exact logical page/action,
  kind, asset ID and unchanged speech text. These references bypass private
  provider receipt rebinding, not source/page/effect review. Current source
  identity must be bound before subsequent reuse; an arbitrary source-hash edit
  fails. Changed text or asset replacement cannot inherit local proof.
- New `CoursewarePortableMedia` reads private Host-authorized media through
  no-follow bounded regular-file I/O, verifies hash/length, and reuses the muted
  sandboxed Electron decoder for MIME and exact duration. Speech and clip routes
  reject each other's action kinds. Renderer receives bytes/MIME, never paths.
  Corruption is an error rather than a provider fallback or new generation.
- Native speech/music/video preview and full-project snapshot capture now reuse
  portable local files without an account lookup. Mixed local/provider projects
  retain the existing provider checks for the remaining references. Snapshot
  completeness includes video, fixing the earlier audio-only check. Exclusive
  `local:true` proofs are verified by Host for every current reference, preventing
  a valid shared asset ID from authorizing a different sentence elsewhere.

### Verification

- Main coordinator/editor/media regression: **147 passed**, 0 failed;
  `/tmp/teaching-integration-main-verified.log`.
- Opt-in real Electron decoder and media component test: **16 passed**, including
  actual WAV/MP3/MP4 decode, bytes-only preview and all-media snapshot routing;
  `/tmp/teaching-integration-electron-final.log`. Uses a disposable profile and
  muted decoder windows, not the user's running application.
- Desktop TypeScript check passed; `/tmp/teaching-integration-types-verified.log`.
- Host portable regression: **10 passed, 1 ignored**;
  `/tmp/teaching-integration-portable-final.log`. The installed-worker case is
  explicitly run separately. Review regression: **57 passed**;
  `/tmp/teaching-integration-review-final.log`. Snapshot regression: **17 passed**;
  `/tmp/teaching-integration-snapshots-final.log`. Attachment filter: **3 passed**;
  `/tmp/teaching-integration-attachment-final.log`. Music adoption filter:
  **3 passed**; `/tmp/teaching-integration-music-final.log`. Retained/pending marker
  detection: **1 passed**; `/tmp/teaching-integration-markers-final.log`.
  Filters overlap and their counts are not an aggregate suite total.
- The installed-parser test in `/tmp/teaching-integration-real-host-complete.log`
  passed with actual PPTX/WAV files in an unrelated Host profile: automatic
  attachment, canonical restoration, local snapshot capture/readback, repeat
  attachment preserving local edits, missing-sidecar rejection, a second real
  parser job for changed PPTX bytes, ordinary source review/adoption, imported
  audio retention and reopening the same project. No provider is contacted.
  A final extension additionally checks complete re-copy after reviewed source
  changes: **1 passed**, 69.13s;
  `/tmp/teaching-integration-real-host-recopy.log`. The new copy retains the
  reviewed source hash and imported audio without original-profile receipts.
- `cargo check -p host-core --locked` passed;
  `/tmp/teaching-integration-cargo-check-final.log`. The existing dead-code warning
  for standalone test-used `ProjectCommitStore::open` remains; production uses
  workspace-anchored opening. Cross-platform compilation was not run.
- Targeted rustfmt, agent policy synchronization and `git diff --check` pass.

One intermediate installed-worker run failed because a test-only direct kv
fixture rewrite did not use canonical project serialization, causing the ordinary
adoption CAS to reject. The fixture now uses the canonical project writer. No
production CAS was weakened. The separate earlier parallel file-lock contention
remains unresolved; this increment does not certify a parallel full-suite run.

### Remaining delivery boundary

Automatic Main attachment, MIME/duration validation, local native preview and
fixed snapshot capture supersede the pending component list in the prior section.
Whole-editor fresh-profile open, audible timeline/sidebar playback and restored
fixed export still need acceptance. Ordinary Save/Save As do not synchronize the
backup sidecar; creating another complete copy exports current canonical data.
Normal-save transactions, opt-in authority migration, source-only-copy notice,
old-client behavior, compound saved undo and the full G6/E1–E20 matrix remain open.
No real user deck, user app/profile, paid provider, commit or push was touched.

## Scope correction: one native sidebar (2026-10-29)

The user rejected the competing Desktop panel and the added complete-project-copy
and advanced-teaching toolbar entries. This correction supersedes earlier notes
that presented those entries as the normal teaching workflow. Portable storage
requirements do not authorize extra editing commands.

### Implemented

- `PptEditorTab.tsx` no longer imports/mounts `CoursewareTeachingPanel`. It exposes
  no advanced-teaching toggle, project-copy button, or copied-directory launcher.
  Normal Office save, fullscreen, retry and close remain. Teaching is owned by
  WiseOffice's native right-property area, including while readiness is pending.
- WiseOffice `lib/deckwise-teaching-sidebar.ts` presents highlight/spotlight as a
  visible section under narration. Existing cues show localized names and target
  names. Add/edit/delete preserve cue identity and existing narration/audio;
  editing participates in the existing Host draft and undo path.
- The native form supports multiple mapped targets, start/end milliseconds,
  highlight outline/fill/glow/color/opacity and spotlight dim opacity. Invalid
  times, empty targets and stale audio do not create a draft cue.
- Canvas selection resolves through the same unique saved mapping proof as the
  overlay; grouped/off-page/ambiguous objects are refused. The existing live slide
  overlay and audio-clock scheduler are reused. No new native PPT animation
  editor, assistant, provider request, or shape is added.
- The header wraps rather than squeezing its title into a narrow column. Native
  locked-page text no longer directs users to the removed advanced-tools entry.

### Verification and installed resources

- WiseOffice: **44 tests passed** in sidebar, geometry/selection and slideshow
  suites; `/tmp/wiseoffice-cues-tests.log`. Both WiseOffice and Desktop TypeScript
  checks passed; `/tmp/wiseoffice-cues-types.log` and
  `/tmp/desktop-single-sidebar-types.log`.
- Desktop: **34 tests passed**, including actual isolated React/Chromium mounting
  with native readiness both false/true, no duplicate sidebar/copy controls,
  ordinary save, retry, Chat rebinding and existing save/bridge regressions;
  `/tmp/desktop-single-sidebar-tests.log`.
- Real production-SDK Chromium flow: **1 passed**, 2.8 minutes, build
  `dist-e2e-4231`; `/tmp/wiseoffice-single-sidebar-e2e.log`. It exercises real
  narration/audio/video/waits/native animation, zoom-aligned overlays, editing a
  highlight's fill/color/opacity, resolving a selected SDK object, changing the
  same cue to spotlight, saving and rereading, and unchanged native PPT history.
  Host data is an isolated fixture, not the user's database. The initial run's
  low-level selection changed the SDK context and invalidated the test form;
  the fixture now refreshes the saved-page binding after that direct selection.
- Resource protocol/path checks: **2 passed**;
  `/tmp/desktop-single-sidebar-resources-tests.log`. Policy sync and both
  worktree whitespace checks passed.
- The tested WiseOffice source remains on `feat/wiseoffice-native-teaching` in
  `document-worktrees/wiseoffice-native-teaching`. The built editor and shared
  preview runtime are installed in the current Desktop `feat/courseware-par-A`
  worktree at `apps/desktop/resources/wiseoffice` (2894 manifest entries).
  The prior bundle is preserved at
  `.cache/wiseoffice-before-single-sidebar-20261029`. Restart Desktop without
  `DECKWISE_EDITOR_URL` to load these bundled resources; an explicit HTTP URL
  still bypasses this bundle.

### Remaining acceptance boundary

This corrects the editing surface and native cue authoring; it does not certify
all G5/G6 gates. Preview still requires the current saved PPTX: following native
object moves while the PPT is dirty and ordinary Save/Save As sidecar
synchronization remain open. Cue authoring still requires a mapped ready page
and linked speech audio; general standalone timed-span authoring is not added.
No user deck/profile, paid provider, commit or push was touched. Stop development
after this correction for the user's manual device verification.


## Timeline read latency diagnosis (2026-10-29)

### Reproduced causes and changes

- `CoursewareTeachingCoordinator.open` previously started, polled and released a
  full PPTX parser worker on every page/selection read. A regression reproduced
  two parser starts for two page reads of the same saved bytes. It now retains
  only a successful saved-source read identity (workspace, Host, chat/editor
  session, path, revision and SHA-256). Warm reads verify the actual source and
  fetch fresh canonical teaching and object mappings from Host without another
  parser job. Canonical teaching is not cached and parser jobs are still released.
- Changed source/binding, failed reads, read-only context and external source
  changes invalidate the read identity. Mutations retain the existing fresh-parse
  path and all source/ownership checks.
- WiseOffice selection changes previously rebuilt the timeline and queried the
  voice/model/media catalogs. When the same saved source, full teaching view and
  editable form remain valid, only the Host binding is renewed. The textarea,
  draft and undo history remain in place. Page/source/teaching changes still
  reload the timeline. Returning from lesson playback still rebuilds disabled
  controls as editable controls.

### Save limitation — unresolved

The screenshot's `Save or reopen the PPTX before editing teaching` is thrown by
`PptEditorController.teachingSnapshot` when the native PPT is dirty. Teaching draft
writes are already automatic, but this is separate from committing PPT bytes.
Ordinary PPT Save/Save As does not yet reconcile canonical page/object identity,
attention bindings and native-animation source proofs. Adding a timer or removing
the dirty check would not implement this missing transaction. This change does
**not** claim to fix PPT autosave or editing/preview against dirty PPT geometry.
The error remains possible until that source/teaching synchronization is complete.

### Validation

- Desktop coordinator/native-sidebar suites: 91 tests passed, including fresh
  Chat teaching on warm reads and revision/path/document/source invalidation;
  `/tmp/teaching-load-desktop-tests.log`.
- WiseOffice sidebar/preview/slideshow suites: 45 tests passed, including retained
  textarea and catalog request counts after a same-page selection change;
  `/tmp/teaching-load-wiseoffice-tests.log`.
- Desktop and WiseOffice TypeScript checks passed. No real user deck/profile,
  paid provider, commit or push was touched. Cold-load latency on the user's
  machine has not been benchmarked.

- Real production-SDK Chromium flow passed (1 test, 2.7 minutes), including
  selection-change notification without manual timeline refresh and retained
  textarea identity: `/tmp/teaching-load-e2e-verified.log`, build `dist-e2e-4234`.
  The first validation exposed disabled editing controls after lesson playback;
  the fast path now requires an already editable form. The second exposed a
  fixture-only low-level selection lacking an SDK/input notification; the test
  now dispatches the normal native input notification.
- Installed the tested build in `apps/desktop/resources/wiseoffice`; all 2894
  manifest hashes/lengths verified. Previous bundle retained at
  `.cache/wiseoffice-before-timeline-read-20261029`. Restart Desktop without
  `DECKWISE_EDITOR_URL` to use the updated local bundle. Native PPT autosave
  remains unimplemented; this installation changes read latency only.

## 2026-10-29 — Native PPT autosave and teaching identity synchronization

This supersedes the ordinary workspace-PPT autosave limitation recorded above.
The scope is the existing working-directory PPTX/Host project, not completion of
all portable Save As, migration or G0–G6 delivery gates.

- DeckWise embed mode requests a save after 1.5 seconds without a native edit.
  SDK history and input/context events observe edits while the SDK's modified
  flag remains true, including changes within one undo point. Only one export
  runs at a time. A failed edit is not resubmitted continuously; another edit or
  explicit Save can retry. Non-DeckWise browser editing keeps its previous save
  behavior.
- The native export receipt includes session-bound page references and object
  references, verified saved names, native-animation continuity and both byte
  hashes. The host wrapper now forwards the complete receipt to Main.
- Main verifies the editor owner, workspace, path-derived document identity,
  save request and byte hashes. It parses the baseline once and each new export,
  releasing the single parser between jobs. Subsequent saves reuse only the
  successfully verified source identity; they do not repeatedly parse the old
  deck.
- Host prepares a durable pending record before the live file changes. The
  SQLite write fence prevents competing canonical teaching/media changes.
  After file replacement, Main resolves the record against the actual file
  hash before acknowledging success to Office. Reopening resolves interrupted
  saves whose file matches either prepared version. Unknown external bytes
  remain blocked and both archived versions are retained.
- Existing page/object UUIDs follow actual SDK references, not slide position,
  shape ordinal or copy names. Copies receive new identities. The surviving
  page's narration, media actions and audio provenance are preserved. Native
  animation bindings follow the new source only when their native timeline is
  unchanged. Invalid attention/animation references are stopped, with a visible
  warning and the original canonical teaching retained in history.
- Matching persisted teaching drafts follow verified source changes. Their
  original contents are archived before rebasing; deleted targets are disabled
  while narration is retained. Divergent baselines remain preserved rather than
  overwritten. Saving succeeds before the right sidebar reloads automatically.
  Selection-only refreshes retain the existing warm-read fast path.
- A real Host test exposed JSON field-order incompatibility with the existing
  typed-project optimistic write comparison. Native commit now uses typed
  serialization, and a regression test edits teaching after the source commit.

Validation evidence (isolated temporary workspaces/profiles, no paid APIs):

- Desktop targeted suites: 127 passed, with the environment-gated real Host
  case run separately (5 passed, including its four unit cases).
- WiseOffice lineage/embed/sidebar: 127 passed; TypeScript checks passed in both
  repositories. Runtime saved-identity suite: 10 passed.
- Host native-save tests: 3 passed (restart recovery, external hash rejection,
  copy identity, draft migration, stopped targets/history, post-save writing).
  Existing Host identity/context tests: 7 passed.
- Production SDK Chromium autosave: passed, including repeated edits while
  dirty, actual export hashes, names in OOXML, consecutive exports and renewed
  source baseline. The same exported PPTX files passed Main -> real parser ->
  real SQLite Host -> second save, preserving narration and object UUIDs.
- Production SDK teaching sidebar passed narration, attention editing and
  playback plus automatic refresh after a native PPT save. No user profile or
  real courseware source was changed. Commit/push were not requested.

Evidence logs: `/tmp/native-save-desktop-tests.log`,
`/tmp/native-save-wise-tests.log`, `/tmp/native-save-rust-tests.log`,
`/tmp/native-save-identity-tests.log`, `/tmp/native-save-runtime-tests.log`,
`/tmp/native-save-e2e-final.log`, `/tmp/native-save-real-host-final.log`, and
`/tmp/native-save-sidebar-e2e-final.log`.

The safety boundary remains the exact saved source: this does not play teaching
against unsaved geometry. Autosave removes the routine manual save/reload step.
New/copied/deleted/ambiguous objects may need their teaching configured again;
unknown associations are never guessed. Portable sidecar commit migration,
compound saved undo and cross-platform crash acceptance retain their separately
specified delivery gates.

Installation for the current worktree: the tested WiseOffice bundle (2894 files)
and local parser bundle (155 files) were hash/length checked and installed under
`apps/desktop/resources/wiseoffice` and `apps/desktop/resources/pptx-worker`.
The previous bundles are retained at `.cache/wiseoffice-before-native-save-20261029`
and `.cache/pptx-worker-before-native-save-20261029`. The dev Host executable was
rebuilt. Restart Desktop to load Main/Host changes; no `DECKWISE_EDITOR_URL` is
needed for the bundled editor. No running user application was restarted.

### 2026-10-29 — Teaching autosave and preview entry points

The native sidebar now commits teaching edits after 1.2 seconds of inactivity,
including compatible recovered drafts. Draft recovery remains in place until
Host confirms the authoritative write. Audition, canvas preview, slideshow and
refresh commit pending edits first; a failed write retains the draft and blocks
playback with a visible error. Errors do not trigger an endless retry loop.
Pending cue forms and active previews defer idle commits so a save does not close
an unfinished cue form or interrupt its preview. Saving briefly prevents further
sidebar edits; narration cursor/selection and sidebar scroll are restored after
success. The existing explicit save remains available.

The two page entries are labelled `画布预览` and `幻灯片放映`. Canvas preview
stays on the editing canvas; native PPT animation steps require slideshow.
No generation API, billing, platform routing or real user courseware was changed.

Validation: 148 unit tests passed across sidebar, preview, slideshow, lineage and
embed suites; TypeScript, formatting and diff checks passed. Production SDK
Chromium tests passed both the basic autosave/cursor case (22.6 seconds) and the
full media/attention/slideshow regression. The latter uses real editor/media
playback with a fixture Host transport, not the user's live SQLite project.
The 2894-file bundle was verified against its file-size/SHA-256 manifest and
installed at `apps/desktop/resources/wiseoffice` in `feat/courseware-par-A`.
Previous resources remain at `.cache/wiseoffice-before-teaching-autosave-20261029`.
Logs: `/tmp/teaching-autosave-final-tests.log`,
`/tmp/teaching-autosave-types.log`, `/tmp/teaching-autosave-e2e-focus.log`,
`/tmp/teaching-autosave-e2e-final.log`. No app restart, paid generation, source
courseware modification, commit or push was performed.

### 2026-10-29 — Native canvas clicks during teaching slideshow

Reproduced the reported SDK EditingError (-25): during unbound teaching playback,
a native canvas mouseup called OnNextSlide -> NextSlide. Its slide-change callback
synchronously disposed the teaching slideshow, clearing the SDK Canvas, while
NextSlide continued painting. CalculateRectDemonstration then read null.width;
the SDK's generic error handler switched editing to read-only.

All teaching slideshows now fence native canvas advancement (pointer/mouse/touch,
wheel and keyboard), including slides without a bound native animation timeline.
Explicit native-step/playback controls and Escape remain available. External
slide-change cleanup is deferred to a microtask so SDK observers cannot destroy
the canvas inside NextSlide's synchronous painting stack. Standalone native PPT
slideshow behavior is unchanged. The sidebar help points to the explicit native
step control instead of telling the user to click the picture.

The exact browser reproduction failed with -25 and the null.width stack before
the fix and passed after it (22.6 seconds). Related unit suites: 50 passed;
TypeScript and formatting checks passed. Unit coverage includes unbound pointer
fencing, usable controls/Escape, listener cleanup and deferred page-change exit.
Logs: `/tmp/teaching-click-red.log`, `/tmp/teaching-click-green.log`,
`/tmp/teaching-click-tests-final.log`, `/tmp/teaching-click-types-final.log`.

Full production-SDK Chromium media/attention/sidebar regression passed in 2.9
minutes (`/tmp/teaching-click-full-final.log`), including repeated canvas clicks,
explicit native animation controls, Escape/exit, replay, audio/video playback,
autosave and subsequent editing. The verified 2894-file bundle is installed at
`apps/desktop/resources/wiseoffice` in `feat/courseware-par-A`; the previous bundle
is retained at `.cache/wiseoffice-before-teaching-click-fix-20261029`. Restart and
reopen the already-faulted editor to clear its SDK-imposed read-only state. No
user courseware bytes or running user app were modified; no commit/push.


## 2026-10-30 — local-media policy and user-edited native animation playback

The production editor reproduced the exact Chromium error `MEDIA_ELEMENT_ERROR:
Media load rejected by URL safety check`. Its CSP had no `media-src`; `default-src
self` rejected the local blob URL even though Host had already returned verified
bytes. `bin/editor-csp.mjs` now grants only `media-src self blob:`. Script, worker
and remote-media permissions are unchanged. The Electron round-trip probe now
requires actual speech and music playback to finish, so HTTP-only or mocked
media tests cannot hide this production-policy regression.

Teaching playback previously required each native effect to equal the original
generated cue in count, preset, duration and position. Editing native animation
therefore locked the teaching preview. Playback now resolves the actual saved
native click groups against the ordered speech/object identities. PPT remains
authoritative for presets and durations; multiple click steps may run for one
speech, once and in native order. Pause holds queued steps, and Stop cancels them.
Unbound or reordered manual sequences retain native/manual playback before the
teaching timeline instead of overwriting animation or guessing a speech binding.
Existing validation for unsupported native effects and stale source remains.

Validation: 75 editor unit tests, 52 runtime tests (including real audio-player
and playback-core logic), two local-protocol tests, editor/runtime typechecks,
and production build passed. A real SDK Chromium test generated 14 effects,
saved/reopened PPTX, appended a manual native effect with a 1200 ms duration,
saved/reopened again and played all eight click groups without replacing effects.
The production Electron probe played speech and music, opened/exported/reopened
three slides and issued zero remote requests. The installed bundle's 2894 files
match its inventory hashes. The full real-SDK teaching sidebar regression also
passed in 3.2 minutes, including media, attention, autosave, slideshow and return
to editing (`/tmp/teaching-media-animation-sidebar-e2e.log`).
Logs: `/tmp/teaching-two-bugs-final.log`,
`/tmp/teaching-media-animation-runtime-regression.log`,
`/tmp/teaching-native-edits-e2e.log`, `/tmp/teaching-media-candidate-electron.log`.

The verified local bundle is installed under `apps/desktop/resources/wiseoffice`
on `feat/courseware-par-A`. The previous bundle remains at
`.cache/wiseoffice-before-media-animation-fix-20261030`. Restart the desktop and
reopen the PPTX to replace the already-loaded HTML policy/runtime. No running
user app was restarted, user courseware was not rewritten, no paid generation
was requested, and no commit/push was performed.
