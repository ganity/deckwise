# DeckWise courseware runtime

Desktop-local extraction of the verified MAIC PPTX → ImportIR → PPTist route
and fixed playback. This module runs without a MAIC/cloud-web checkout or server.
It does not import a server Agent loop. DeckWise's existing pi Agent remains the
only Agent; B supplies its finite tools and A owns registration/persistence.

- `@pi-desktop/courseware-runtime/node`: `adaptCanonicalSnapshot`,
  `buildFixedCourseware`, mapping validators and saved-source identity API.
- `@pi-desktop/courseware-runtime/authoring`: strict editable-scene schema,
  local scene-to-PPTX compilation, single-page and confirmed-style batch candidates,
  canonical page baselines and byte-verified lineage.
  `syncSpeechAnimations` writes verified native OOXML behaviors for saved speech
  cues, preserves unrelated timing and resolves targets through logical-to-native
  object names. Its output must be adopted through Host's native-save journal;
  a teaching cue alone is not evidence that an animation exists in the PPTX.
  This is an isolated Node-only entry; conversion and playback do not load it.
- `@pi-desktop/courseware-runtime/player`: fixed loader, player, labels,
  authenticated ready-media resolver and `mountFixedBuild`.
- `@pi-desktop/courseware-runtime/player.css`: scoped preview styles.
- `dist/teaching-preview.mjs`: browser-only speech cue scheduler and spotlight
  geometry shared with the native WiseOffice teaching pane. Its finite sequential
  teaching adapter delegates to `PlaybackCore`/`AudioPlayer`, including local speech,
  music, legacy post-speech pauses and teacher waits. An optional native HTML video
  surface completes media checkpoints on actual video end; failed sources pause
  for explicit retry. Unsupported nodes reject before playback. Staging bundles this
  entry into `.deckwise/teaching-preview.mjs` and includes it in the resource hash
  inventory. It does not expose Node, start generation or implement another clock.
- `dist/pptx-worker.mjs`: offline worker. Run only through Host's validated job.

Build with `node scripts/build.mjs` and emit declarations using the package build
command. Stage a new dedicated worker with
`node scripts/stage-worker.mjs /absolute/new-worker-directory`. It bundles native
libraries for the current machine, not other platforms. Main/Host must own worker
selection, path containment, time/output budgets and cancellation. The builder's
file paths must come from Host's verified immutable snapshot, never renderer
paths. A owns installing resources into the final application.

`buildFixedCourseware(input, { workerDirectory, outputDirectory, signal })`
accepts an optional Host-owned `AbortSignal`. Cancellation before publication
rejects with `FixedBuildError.code === 'BUILD_CANCELLED'`, waits for the dedicated
worker to close and removes staging. File verification checks cancellation
between bounded reads; an active worker is force-terminated. Previous valid
packages remain intact. The CLI handles SIGINT/SIGTERM with cleanup and exit
codes 130/143. A cleanup failure remains an error.

The atomic rename is the publication boundary. Cancellation after rename starts
can leave a complete immutable package; Host must recheck its signal and captured
session/source/teaching state before adopting a returned build reference. This
does not replace A's snapshot ownership or adoption CAS.

The canonical Project/Snapshot module and fixtures are the exact published A1a
source, SHA-256 `dd16a1562e64cb4010f461d1c4b4bb2389e9ac2c9c9059b01421ccbc491de297`.
They remain a pinned private consumer copy until A combines the shared package.
Do not introduce another public teaching schema. Internal PPTist/ImportIR types
retain upstream representations. `provenance.json` identifies extracted source;
`provenance-final.json` distinguishes extraction from Desktop adaptations.

Mount only a verified immutable build:

```ts
import { mountFixedBuild, chinesePlayerLabels } from '@pi-desktop/courseware-runtime/player';
import '@pi-desktop/courseware-runtime/player.css';
const unmount = await mountFixedBuild(container, packageBytes, selectedBuildId,
  authorizedAssetResolver, { width: 960, labels: chinesePlayerLabels }, signal);
// On snapshot/session switch: abort the pending load, then call unmount().
```

A supplies translated labels (English/Chinese examples are exported), selected
build ID and authenticated bytes. Preserve one React instance. Serve
`assets/courseware-fonts/` as local `/courseware-fonts/` resources and load the font
stylesheets listed by `src/player/lib/courseware-fonts.ts`. Use the dedicated
preview surface: never merge management-app globals into Desktop. Rich HTML is
sanitized; scripts, fetchable tags, navigation and CSS resource URLs are removed.
This does not establish arbitrary PPTX fidelity.

`tests/fixtures/fixed-courseware/canonical-desktop.json` is an authored fixed
fixture, not a persisted Host snapshot. Build via
`node scripts/build-canonical.mjs input.json workerDirectory outputDirectory`.
Run unit tests with `node node_modules/vitest/vitest.mjs run`; typecheck with
`node node_modules/typescript/bin/tsc --noEmit`. Browser verification uses only
D port 4259 and compiled `dist/player.mjs` through the standalone Vite fixture.
No provider, generation, browser TTS fallback or second playback clock is used.

The authoring entry is a finite local compiler, not a model client or Agent.
`generatePagePptxCandidate` receives an injected authorized scene callback and
fresh baseline reader. It returns a review-only PPTX copy; it never writes the
source or adopts teaching. Target objects are editable text, preset shapes,
connectors and approved PNG layers. It preserves source canvas size, peer parts
and notes, and rejects unsupported package structures, stale state and cancellation.
It does not edit charts, masters or native animation, generate assets, authorize
images or establish arbitrary imported-PPTX fidelity. Host still owns current
Chat/source/page/teaching authority, bounded execution and reviewed adoption.

The matching private PPTXGenJS fork is bundled locally with its MIT license;
`authoring-provenance.json` pins the B54 source and import-only adaptations.
Worker staging includes the compiler, native sharp dependency, license and
provenance in the existing hash inventory.

Desktop Main's reviewed-redo producer loads `authoring.mjs` dynamically beside its
selected installed `pptx-worker.mjs`; do not bundle sharp into Main. The staged
bundle's own native dependencies and manifest stay together. A legacy installed
worker without the authoring entry refuses redo rather than resolving a compiler
from a source checkout. Existing package resources require a fresh explicit
staging/package step; a successful source gate does not update them.
 `node scripts/verify-authoring-bundle.mjs`
checks those hashes and the Desktop Linux resource validator, then runs the public
API from an isolated temporary directory. No MAIC checkout or registry PPTXGenJS
is required. This distribution gate does not mount public Chat redo or validate
a new packaged Desktop release.

The same playback suite can run in an actual Electron renderer on Linux:

```sh
# Start in a separate terminal with the fixed build produced above.
D_BUILD_DIRECTORY=/absolute/fixed/build node node_modules/vite/bin/vite.js --config scripts/playback-vite.config.mts
xvfb-run -a node scripts/verify-playback-browser.mjs /absolute/new/evidence --animations --electron=/absolute/electron
```

The fixture uses the Desktop CSP and compiled player. Electron runs with a
dedicated disposable profile, renderer sandbox preference/context isolation,
no Node integration, web security and explicit user-gesture autoplay policy. The suite verifies
native decoding and cleanup, Node isolation and no CSP violations. Its
`--no-sandbox` process flag is authorized only for this local test environment;
it does not validate OS sandbox enforcement or change product defaults. This
standalone renderer acceptance is separate from mounting in the actual
Desktop/Host snapshot workflow.

Static slides remain limited. Native transitions remain unsupported. Fixed packages
may preserve the finite `nativeObjectAnimations: "click-appear-fade/1"` capability:
saved whole-object, one-target on-click entrance appear (preset 1) and fade
(preset 10), duration 1–5000 ms, on ordinary text/shape/image targets. Every native
step must fit; unknown presets, automatic/parallel/delayed steps, grouped/media
or paragraph targets and conflicting speech cues block the build. Warning review
cannot acknowledge unsupported timing away. Generic `objectAnimations` remains
false; bounded player fade/pulse and spotlight remain separate capabilities.

Canonical teaching may also contain `{ id, type: "audio_clip", audioAssetId }`.
This is a sequential verified music/audio clip, separate from speech and PPTX
page media. The builder and loader require an archived audio asset; the existing
native audio clock owns pause, resume, seek, retry, navigation and disposal.
Clips never generate speech, run a reading timer or emit narration callbacks.
The fixed player shows their own progress control. This does not mix background
music with narration, loop across pages or change PPTX bytes.

Optional version-1 `nativeAnimations` page metadata retains click order separately
from unchanged canonical speech and waits. The strict loader compiles each click
to an explicit teacher checkpoint followed by the existing `pptxTimeline` action.
The player states that all saved native clicks precede this page's narration and
are not automatically aligned with speech. Targets start hidden; explicit clicks
reveal them, and fade pause/resume uses the engine timer with the native animation
handle. Replay resets that page's native effects. Old static packages need no new
field. This does not add automatic speech alignment or general PPTX animation fidelity.
Speech highlight/spotlight may target those revealed objects: these overlays do
not compete with the completed entrance. A speech `element_animation` cue on the
same object still rejects with `NATIVE_ANIMATION_CUE_CONFLICT` in both builder
and loader. Source/object binding and unsupported-native-timing checks still apply.
Unsupported charts/masters/linked text/formula diagnostics continue to block a
ready build. Changed saved-source identity is a review proposal; Host CAS and B's
trusted lineage are still required before adopting teaching bindings.

`tests/fixtures/office-image-crop-b20/` pins three real B20 candidate/Office-saved
PPTX variants. Its teaching, ready states and unrelated WAV are explicit test
compositions. Build the canonical inputs with the pinned worker, then run
`node scripts/verify-office-crop-browser.mjs /absolute/new/evidence` against the
same standalone Vite server (optional `--electron=/absolute/electron`). It checks
actual cropped pixels and the background outside every crop at two sizes,
native narration/pause/teacher wait, and navigation to empty first/final pages.
Generated full-slide background images remain rendered and resource-verified;
they do not acquire invented logical object IDs. Every source object must still
have its exact mapping. The scoped renderer stylesheet clips rectangular images;
explicit page navigation retains a page with no actions and reports its ID.
These samples do not establish arbitrary PPTX fidelity.

No PptEditorTab/WorkPanel/IPC/barrel/global styles/packaging registration is made
by this module. Integration, immutable snapshot export, Desktop Agent tools and
full installer acceptance remain separate A/B gates.

B7's real Office saved-byte regression is pinned under
`tests/fixtures/office-lineage-b7` with original paths and SHA-256 hashes.
`src/conversion/tests/courseware/office-lineage.test.ts` runs the dedicated worker
on the original, native-edited, reordered and copied PPTX files. It consumes an
exact, test-only copy of B7's receipt-to-lineage helper through the public Node
identity API. Edit/reorder proposals retain Host review; stale receipts,
cross-output replay and automatic copy association are rejected. Test mappings
are fixtures, not adopted Host state. The helper is not bundled into production.

`mountFixedBuild` checks cancellation again after loading, before creating its
React root. A snapshot switch during that async handoff rejects with the signal's
reason and disposes verified asset URLs. After mounting succeeds, the returned
unmount function still owns cleanup; aborting the load signal alone does not
stop an already mounted session.

Host state events derive `snapshot.sceneId` from the current cursor page. It
tracks navigation, automatic advance and pause/wait/replay; after completion
the cursor is past the last page and `sceneId` is absent. This playback cursor
is transient and is not an immutable Host build snapshot or adoption authority.

The loader captures its own package and resolved-asset bytes before asynchronous
SHA-256 verification. Parsing and playback use those same owned snapshots, even
if a caller reuses its input buffer while hashing is pending. Size limits are
checked before copying. This byte ownership does not authorize the resolver or
replace the Host's selected immutable build identity.

`tests/fixtures/media-task-c1-http` pins C's two actual local HTTP ready-image
responses and the exact PNG payload asserted by C's mock-provider harness.
The existing resolver consumes both without a contract change. The compiled
Chrome/Electron mount also decodes that image alongside fixed WAV narration,
pause/resume and teacher wait. Its one GET is replayed locally; this is offline
interoperability, not live Desktop token, paid-provider or team authorization.
Host supplies authenticated retrieval and handles HTTP status before parsing a
successful JSON envelope (C's HTTP 401 body is empty), then checks `Result.code`.

Fixed narration `pauseAfterMs` is measured in milliseconds up to 30,000. The
maximum value waits the full 30 seconds; pausing freezes the remaining silence
until resume. The extracted Desktop core uses the existing speech timer without
legacy unit guessing. Frozen server classroom behavior is unchanged.

Page-media resume failures only affect the current effect lifetime. Navigation,
replay, source replacement or a later playback mode invalidates the earlier
`play()` rejection; it cannot pause new narration or restore an old error. Native
errors on the current media element still pause playback and remain visible.

Failed fixed narration remains paused until the teacher explicitly retries the
page or skips that failed speech. The existing playback-point skip also accepts
this failure pause, but ordinary pauses and teacher checkpoints are not failure
skips. `canSkipFailedSpeech()` identifies that exact current context. Hosts may
supply the optional `skipFailedNarration` label; callers using older label sets
retain retry-only behavior. English and Chinese defaults include the label.
An explicit skip advances through the same action scheduler and still stops at
the next teacher checkpoint; it neither generates audio nor starts browser TTS.
Embedded page media failures retain page retry and explicit page navigation.

Source replacement and replay invalidate the audio generation and remove its
native ended/error listeners before unloading with `removeAttribute('src')` and
`load()`. Assigning an empty source would start an invalid Chromium request.
Fixed page media errors are bound to their source effect's lifetime. Actual
current decode/network errors, including code 4, are not filtered by code or
message. Same-speech retry also invalidates old start promises.

A8 interoperability fixtures pin actual Host output after native save, explicit
page reassociation and restart. The original project stays in review without
audio; the adapter rejects it, and explicit review alone cannot supply missing
fixed audio. `tests/fixtures/a8-narration/canonical-fixed-audio.json` is an
authored composition using those two speech actions, their 4,000 ms pause, D's
existing R8 source/mapping, unrelated local WAV test audio and a teacher wait.
It is not an immutable Host export or matching synthesized narration. Rebuild
it before running the browser suite:

```sh
node scripts/build-canonical.mjs tests/fixtures/a8-narration/canonical-fixed-audio.json .worker-desktop-02 .builds-desktop-a8-01
```

The pinned build identity is recorded in the fixture's `SOURCE.json`. Actual
compiled Chrome/Electron playback verifies both WAVs in order, pause freezing
through the four-second gap, and teacher continuation after the second WAV.


B15 native text-format interoperability pins the original PPTX and both actual
mouse-selected Office saves in `tests/fixtures/office-text-format-b15`. The
existing converter and mapper preserve each character's RGB and font size,
including a selection crossing two prior runs and an authored space. Font sizes
are normalized from source points to the 1000-unit slide, with three decimals;
they are not CSS points. Native IDs may change on Office save. Tests compare
geometry and note structure with regenerated `cNvPr` IDs excluded.

The three canonical files are explicitly authored test compositions: fixed
source bytes, local logical mappings/ready state, one existing unrelated WAV and
a teacher checkpoint on page two. They do not represent A's immutable Host
exports or matching source narration. Build them before the browser suite:

```sh
node scripts/build-canonical.mjs tests/fixtures/office-text-format-b15/canonical-original.json .worker-desktop-02 .builds-desktop-b15-01
node scripts/build-canonical.mjs tests/fixtures/office-text-format-b15/canonical-partial.json .worker-desktop-02 .builds-desktop-b15-01
node scripts/build-canonical.mjs tests/fixtures/office-text-format-b15/canonical-cross-run.json .worker-desktop-02 .builds-desktop-b15-01
```

Chrome/Electron load these actual compiled packages, measure each rendered
character's computed RGB/font size and visible range, then exercise local WAV,
pause/resume, teacher wait and unmount. The converter/player implementation is
unchanged. Notes-master diagnostics and `visualFidelity: NOT_VERIFIED` remain;
these samples establish only the asserted text/geometry boundaries.

Trimmed fixed page audio completes or loops only after native `currentTime`
reaches the authored segment end. A timeout wakes the existing trim check; it
does not establish playback progress. A stopped native clock must preserve the
current position and must not synthesize `ended`. Browser regression uses actual
fixed WAV bytes with native `playbackRate = 0`, then resumes at rate one and
checks one segment completion. This is an authored playback fixture, not a Host
snapshot or a claim about native PowerPoint timing fidelity.

Start-only trimmed loops retain native looping at the file endpoint. The existing
seek handler clamps each native rewind to the authored start; end-trimmed loops
continue using the same segment check. This avoids permanent EOF pause when the
renderer is busy. A blocked renderer can delay seek clamping; sample-accurate
loop boundaries during a blocked event loop are not claimed.

The fixed builder and player both count every manifest asset reference toward
the 256 MiB aggregate resource limit, including media extracted from the PPTX.
Identical bytes referenced by different asset IDs count separately, matching
the player's loading budget. A build exceeding that total is rejected before
publication; staging is removed and earlier immutable builds remain intact.

The fixed player and `mountFixedBuild` also accept the existing core's optional
`onSpeechStart`, `onSpeechEnd`, `onSpeechProgress`, `onInteractionStart` and
`onInteractionComplete` callbacks. They are presentation observers, not another
execution engine. Progress carries the speech action ID and native audio time;
seek updates it, pause freezes it, and stop/navigation/disposal sends `null`.
Payloads handed to observers are copies. Updating callback identities does not
restart playback. Observers must return promptly without throwing.

Drive a classroom role's speaking state from non-null progress **and** playing
mode. `onSpeechEnd` marks normal speech-action completion, after `pauseAfterMs`;
it is not an audio-ended or cancellation event. Progress is already null during
that silence. A wait starts before the `waiting_interaction` mode event; explicit
teacher continuation emits its checkpoint ID before returning to playing. A
navigation/stop cancels the wait without reporting successful continuation;
reset role presentation from existing mode/page events and null progress.

These callbacks let a passive classroom role follow the same fixed package and
clock. Do not mount the legacy classroom global player beside it: that component
starts its own parser/TTS managers. The actual classroom route and new-platform
authorization still require integration; no old account or course ID grants
access to fixed package assets. See `ADR-playback-presentation-events.md`.

Page audio/video initialization restores the verified source on every effect
setup. React StrictMode can replay cleanup/setup on the same native element;
cleanup still pauses, clears the source and releases decoding on actual unmount.
The browser suite's `fixed-media-effect-replay-video` and
`fixed-media-effect-replay-audio` cases exercise the compiled public component
under StrictMode with real MP4/WAV, native pause/resume, audio trim and navigation
cleanup. This lifecycle fix does not change the playback clock or Host ownership.


`loadTeamFixedBuild(selection, expectedBuildRef, downloadByPath, signal)` consumes
C2b's fixed multi-file projection and returns the existing `LoadedFixedBuild` for
`FixedCoursewarePlayer`. Host first authenticates the API request, checks HTTP
status and `Result.code`, and captures the selected canonical three-field build
reference. Project the pointer explicitly; its project/channel/version fields
are transport metadata, not additional canonical BuildRef fields.

```ts
import { loadTeamFixedBuild } from '@pi-desktop/courseware-runtime/player';
const expected = { buildId: pointer.buildId, snapshotId: pointer.snapshotId,
  packageSha256: pointer.packageSha256 };
const loaded = await loadTeamFixedBuild(response.data.fixedBuild, expected,
  downloadSelectedFileByPath, signal);
// Render <FixedCoursewarePlayer build={loaded} ... /> with the same React instance.
// On replacement: abort pending retrieval; unmount the player; loaded.dispose().
```

Only finite selected paths reach the Host download callback. D never fetches
`downloadUrl`, sends credentials, retries authorization or trusts package URLs.
Host must bound streamed retrieval before returning bytes and renew expired
links for the same selected immutable build; D verifies returned length/hash.
Selection, manifest, source, report and exact asset membership must agree before
the existing loader validates actions/bindings and creates playback Blob URLs.
`buildId = packageSha256 = SHA256(raw package.json)`; `manifestSha256` identifies
the separate raw manifest. There is no archive format or new playback clock.
The function forwards cancellation and returns the existing disposal boundary.

`tests/fixtures/team-fixed-files-c2b` pins C's actual HTTP response; its signed
loopback URLs are expired test evidence. Browser cases replay the nine original
files locally, verify native WAV pause/resume/teacher continuation, reject
corrupt package bytes before playback and cancel during the last file digest.
This is offline interoperability, not production authentication, Host snapshot
attestation or a live signed-URL integration. The transport projection remains
C2b's provisional interface; canonical Project/Snapshot/BuildRef are unchanged.
See `ADR-team-fixed-build-consumption.md`.

`generatePageStyleBatchCandidate` takes a Host-reviewed representative, exact
instruction/hash/page-scope confirmation, clean canonical target contexts, source
mapping and a fresh context reader. Its injected scene callback receives an owned
current-stage PPTX copy matching `sourceHash` and an independent representative
copy. Keep these bytes local; only Host-approved current source/reference PNGs
may enter the existing authorized model callback. The module returns a review-only
copy with original-source canonical reference, composed lineage and per-stage
preservation reports. It never grants review authority or adopts the output.
The representative must belong to the confirmed scope; stale/locked/dirty/read-only
targets, cancellation and unsafe package/mapping changes fail closed.

B72 adds these exports and import-only adaptations to the existing authoring
entry. Existing single-page exports and B54 provenance remain unchanged. A owns
explicit bundle staging, installation, public Chat scope confirmation and Host
CAS adoption. A source patch or this module check does not update installed apps.

`inspectPageFadeSource` returns frozen read-only compatibility facts tied to the
exact clean baseline, source hash, slide hash and actual presentation page order.
It shares the existing copy-fade transition validator. Native use additionally
requires click advance, one slide body, no target extensions and an unambiguous
layout/master chain without declared parent transitions or compatibility data.
This is not a permission or an edit lease. Main must retain the result privately,
recheck current document/session/edit-generation/save state and native page, then
use the finite Office command only after its separate mounting and acceptance.
Renderer-provided descriptors cannot grant authority. Existing copy candidates
retain their original supported scope; object animations are not edited.

### Source-bound native animation nodes

Teaching actions may include `{ id, type: 'native_animation', version: 1,
sourceSha256, stepIndex }`. Hash and ordered indices must match all actual
supported steps in the saved PPTX page. Speech, media, delays and teacher waits
may intervene. Target, preset and duration come from the PPTX. Partial, stale or
reordered bindings fail closed. Bound pages use native metadata version 2
(`teaching-timeline`) and capability `click-appear-fade/2`; legacy unbound pages
retain version 1 and before-narration teacher clicks. The loader projects each
node in place into the existing playback core. Attention must follow entrance;
speech animations cannot duplicate native ownership.

Serve an actual two-step bound package with the existing playback Vite config,
then run `node scripts/verify-playback-browser.mjs <new-absolute-evidence-directory>
--bound-native --only=fixed-bound-native-timeline`. The worker test in
`fixed-build.test.ts` authors both steps from `native-fade-timing.xml` and verifies
conversion, package loading and rejected-build preservation. This is fixed-player
support; native-sidebar authoring/execution and arbitrary native effects remain
separate requirements.


Native teaching preview also accepts these canonical nodes with an injected
`native` adapter (`sourceSha256`, `stepCount`, finite `next(index)`, `pause`,
`resume`). Bindings are checked before playing. The existing playback core
suspends at private completion checkpoints until the native driver's promise
resolves. Teacher continuation cannot release them; paused or disposed previews
cannot advance from late completion. A native failure remains stopped until a
fresh presentation. The native SDK, target identities and resource ownership
remain the editor's responsibility; the runtime never imports the Office SDK.
