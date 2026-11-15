# Fixed courseware snapshots

## Product status update (2026-11-13)

Portable courseware and team publication are **TBD**: their product definitions,
user workflows, playback destinations and relationship to the standalone fixed
player await user decision. The existing snapshot, export, sharing and player
descriptions below document implementation; they do not define an approved
workflow or justify retaining the standalone player. This status change does
not alter existing code, packages or publication records.

Desktop PPT playback acceptance uses WiseOffice's native teaching slideshow.
Standalone fixed-player results cannot substitute for that acceptance. See the
[ADR status update](../../adr/host-owned-courseware-projects.md#2026-11-13-portable-courseware-and-team-publication--tbd).

## Implementation history

Status: A16 implements private Host snapshot
capture/export. A17 adds Main-owned fixed build IPC and a separate sandboxed
Desktop player for an already persisted snapshot. A18 adds visible snapshot,
warning-review, build and play controls for saved drafts without speech.
A25 captures adopted TTS audio; A26 permits saved drafts with that audio
through the same controls and validates fixed building/native playback.
Visible paid generation, live-provider acceptance and platform publication
remain separate gates.

## Team publication and durable recovery

The Main-window-only `coursewareFixedShare` handler accepts strict
`{previewId,projectId,sessionId,channel?}`; only `shared` and `formal` are
accepted and the default remains `shared`. Main pins the account, Host, Chat,
workspace and retained fixed preview around every asynchronous boundary. It
reads the complete pinned build before any publication request.

For ordinary snapshots the owning task must exist and have no conflicting team
binding. An online snapshot instead needs the Host's persisted online-origin
proof, and its target must be that same team project. It does not require or
create a local task, and an unrelated local task is preserved. The private
`courseware.snapshot.onlineOrigin({sessionId,projectId,snapshotId})` returns
`{teamProjectId:null|string}` after resolving the persisted workspace and
checking the immutable snapshot against its online-import provenance record.
The origin record is committed with `importOnline` in the existing kv extension.
A marker with different snapshot content rejects. A renderer field cannot turn
a local snapshot into an online snapshot.

Main persists `courseware.fixedShare.prepare` before authenticated upload and
pointer CAS. The existing keyed publication receipt is then followed by
`courseware.fixedShare.complete`. Ordinary completion transactionally binds the
same task and marks the journal bound; online completion only marks the journal
bound after rechecking its original team origin. Failure after intent creation
retains an unknown result. It is recovered by querying that intent's authorized
receipt and exact frozen build, even if the channel has since advanced. Missing
receipts never authorize a second POST. Cancellation cannot undo a request
already accepted upstream. No automatic retry or remote rollback is attempted.

## Teaching approval compatibility

Teaching workflow approvals are the teaching plan and first-page style
confirmation. Saved pages and individual effects need no human approval before
editing, generation progress, capture, export or playback. Readiness comes from
validated saved actions, resolved targets and verified media.

The v1 `reviewState` field and strict `courseware.teaching.confirm` /
`pptEditorTeachingConfirm` operations remain compatible with older clients. They
retain ownership, clean-source and full-record CAS validation, but neither flag
value is an eligibility check. The current native sidebar exposes no confirm
operation; current teaching panels expose no page/effect confirmation controls.
Chat change receipts preserve failure/omission history without a manual
request-closing prerequisite for snapshots, portable exports or fixed shares.
Source replacement, destructive removals, conversion warnings and external
publication retain their existing explicit user choices.

## Private Host API

| Method | Strict parameters |
| --- | --- |
| `courseware.snapshot.capture` | `{sessionId,jobId,snapshotId,expectedSourceRevision,expectedTeachingRevision,assets:[{asset:{id,sha256,mimeType},...source}]}`; source is exactly one of `path` or `tts:{principalKey,intentId}` |
| `courseware.snapshot.get` | `{sessionId,projectId,snapshotId}` |
| `courseware.snapshot.onlineOrigin` | `{sessionId,projectId,snapshotId}`; returns finite original team or null |
| `courseware.snapshot.importOnline` | `{sessionId,jobId,snapshotId,sourceByteLength,project,mapping,assets:[{asset:{id,sha256,mimeType},path}]}`; private pinned online input described below |

Both resolve workspace from the persisted session and reject while source
adoption is pending. Capture requires a successful fresh parser job for the
unchanged saved Office revision. Host checks exact source hash/page count and
the parsed identity against its previously bound complete mapping. The caller
cannot supply a project, mapping, revision archive path or authoritative identity.
All teaching pages must be explicitly ready. Every speech must contain nonblank
text and reference one supplied fixed audio ID; duplicate, missing, unrelated or
invalid assets reject. Currently only WAV/MPEG/OGG/MP4/WebM audio MIME declarations
are admitted. Other action details, render bindings and playable media remain
the D build/loader's validation responsibility.

The fixed loader preserves PPTist connector geometry: line elements use finite
`start`/`end` coordinate pairs and a nonnegative stroke `width`; they do not
require a rectangular `height`. Other element types still require finite,
nonnegative width and height. Lines remain ineligible for speech focus and
object animation targets.

### Independent pinned online input (W14.2 Host seam)

`importOnline` is an internal Main-to-Host operation, with no renderer/model
generic entry. Main supplies an already pinned remote canonical project and
complete mapping, obtained from its authenticated publication boundary. The
mapping has exact fields `{revision,sourceRevision,sourceSha256,pages}`; each
page is `{pageId,importPageId,objects:[{objectId,importElementId}]}`. Its source
revision must equal the project's source revision, and its SHA must equal the
project and the unchanged freshly parsed file. `sourceByteLength` must match
the actual source bytes and be in 1..20 MiB. Unknown envelope/mapping fields,
partial mappings and missing parser identity reject.

The parser job may read a private online-download input within the owning
workspace; it is not required or permitted to impersonate the current saved
Office binding. Host verifies the complete ordered import page IDs and object
IDs against the fresh parser identity before binding the supplied logical IDs.
It retains all parser fingerprints and diagnostics, rejects duplicate logical
IDs, and checks logical page order against teaching. It does not infer identity
from slide count/index/text or manufacture logical IDs. This structural check
does not attest remote authorization, a native synchronization barrier, or
semantic reassociation after changed PPTX; Main must obtain that trusted pinned
mapping upstream, and absence of it is not recoverable by guessing.

The immutable record is stored directly in the existing snapshot namespace.
No canonical project, identity registry, teaching history, source-adoption
journal, task/team association or Office file is changed. Source/teaching and
mapping revisions remain the supplied pinned revisions. Same snapshot ID accepts
only identical complete record content; restart/get uses only verified archives.
The export shape remains the ordinary `{snapshot,project,mapping,sourcePath,assets}`
(its mapping omits the redundant import-only `sourceRevision`), so the existing
builder, warning review and publication flow remain reusable.

Every page must still be ready and every speech/music action must reference a
supplied fixed audio asset. Only the explicit `{asset,path}` capture form is
supported for imported audio; local `tts`/`music` receipt selectors, including
null or mixed forms, and reserved `tts-`/`music-` asset IDs reject: a workspace
path cannot substitute for their local adoption provenance. Main must first obtain verified fixed remote bytes
inside the allowed workspace. Existing audio/source hashing, file/total limits,
codec limitations and orphan-archive retention apply. This operation does not
synthesize or upload audio, silently remove narration, confirm pages, or establish real-engine or deployed-service acceptance by itself.

### Read-only final-save source review (W14.2)

Main can request a temporary comparison before it submits any explicit human
reassociation. These private RPCs do not change the local Office binding,
canonical project, complete mapping, source archive or snapshot records:

| Method | Strict parameters |
| --- | --- |
| `courseware.onlineSource.baseline` | `{sessionId,jobId,sourceByteLength,project,mapping}` |
| `courseware.onlineSource.review` | `{sessionId,baselineId,jobId,target:{source:{revision,sha256},byteLength,sessionEpoch,callbackId}}` |
| `courseware.onlineSource.resolve` | `{sessionId,baselineId,reviewId,jobId,target,pages,removedPages,cues}`; explicit projection described below |
| `courseware.onlineSource.clear` | `{sessionId,baselineId}` |

The baseline's `project` is the old canonical teaching. Its mapping is the
complete exported `{revision,sourceSha256,pages}` shape without a redundant
`sourceRevision`. Host checks its full ordered import page/object identities
against a successful fresh parse of the original bytes, its hash and 1..20 MiB
length, and teaching's logical page order. It keeps exactly one in-memory
baseline, scoped to the persisted session and canonical workspace. The baseline
expires after ten minutes, is lost on Host shutdown/restart, and can be explicitly
cleared. Every replacement attempt first invalidates the previous baseline,
including malformed or failed replacements. Baseline cache content is bounded
to 8 MiB; full review responses are bounded to 2 MiB.

The parser holds one active job, so Main must establish the old baseline before
releasing that job and parsing the final saved bytes. Review rechecks the new
file's unchanged bytes, source hash and length. Target source revision must be
a new lowercase UUID, distinct from the original; it may be a publication-only
snapshot/request UUID, and need not replace the current online editing source.
Target epoch is positive and JavaScript-safe, and callback ID is lowercase
SHA-256 text. These are caller-supplied archive pins: Host verifies their shape
and the actual parsed bytes, not the remote callback's authorization or a
native multi-client synchronization barrier.

Review returns `{baselineId,reviewId,original:{project,mapping},previousPages,
target,requiresExplicitAssociations:true}`. Previous pages expose only the old
logical page/object IDs, display numbers/indexes and kinds. Target pages expose
the fresh import page/object IDs, display numbers/indexes and kinds; target also
retains the distinct source/hash/length/epoch/callback pins. `reviewId` hashes
the complete view, including both original and target pins. No selected
association, candidate matching, remapped teaching or mapping is returned.
Import IDs and display order do not prove semantic identity across a save.
The later publication coordinator must present actual source visuals, collect
explicit page/object decisions, preserve or invalidate affected teaching/audio/
cues, and atomically pin the resulting independent publication record upstream.
The review response alone does not apply those decisions or certify readiness.

`resolve` adds an explicit read-only projection, with no matching or UI entry.
It recomputes the owned review from the real parser job and unchanged file,
requires the exact `reviewId`, and accepts these strict decision forms:

```ts
pages: Array<
  {kind:'carry',targetImportPageId:string,oldPageId:string,confirmReady:boolean} |
  {kind:'new',targetImportPageId:string,confirmReady:boolean}
>
removedPages: Array<{oldPageId:string,confirmDelete:true}>
cues: Array<{
  oldPageId:string,actionId:string,cueId:string,deleteCue:boolean,
  targets:Array<
    {oldObjectId:string,decision:'keep'|'rebind',targetImportElementId:string} |
    {oldObjectId:string,decision:'remove'}
  >
}>
```

Every fresh import page needs exactly one decision; old pages need exactly one
carry or explicit deletion. Locked old pages cannot be deleted. Output order
comes from the fresh parsed source, never the input decision array. New pages
receive fresh IDs and empty actions. Every carried attention cue and old target
needs a decision. Targets must exist on the explicitly selected fresh page and
be text/shape/image objects. `keep` preserves the old logical object ID on its
explicitly chosen actual object, consistently across all cues. `rebind` changes
only that cue's target to the selected object's final logical ID; different
cues may choose different targets. Final targets within one cue must be unique.
`remove` drops that target. Dropping a whole cue requires `deleteCue:true` and
all its targets removed; removing highlight's final target or spotlight's
primary target requires that explicit deletion. Other cue style/timing and
original speech/audio/checkpoint content stay unchanged. Unsupported original
action/cue forms reject, rather than being silently stripped.

Return shape is exactly `{reviewId,project,mapping,removedPageIds,assetIds}`.
The mapping is complete `{revision,sourceSha256,pages}`. Source uses the pinned
independent target revision/hash; teaching revision stays at the old baseline
for Platform capture CAS (Platform later issues a new one). IDs/mapping revision
are deterministically derived from normalized explicit decisions and the pinned
review; reordered decision arrays or a different ephemeral parser job ID do not
change the output. No second result cache or persistent record is written.
Each page's `confirmReady` controls `ready` versus `review`; associations alone
do not imply confirmation. Both request and response are bounded to 2 MiB.
Audio IDs are sorted references only, with no asset path/bytes or provenance
claim. Exact UUID-backed team music clips are admitted by online canonical and
immutable-record validation; default local music validation and import's actual
byte/provenance gates remain intact. UI/Main decisions, media resolution,
authenticated Platform capture, native barrier and publication are still
separate integration work.

Capture returns `{snapshot,project,mapping,sourcePath,assets}`. `snapshot` is the
unchanged six-field shared `CoursewareSnapshot`; `project` is the frozen canonical
project. `mapping` is derived from Host identity:
`{revision,sourceSha256,pages:[{pageId,importPageId,objects:
[{objectId,importElementId}]}]}`. `sourcePath` and each returned asset `path`
resolve to verified Host-owned files, never the mutable workspace inputs. These
paths are private Main-to-Host data and must not enter renderer IPC or model tools.
The receiver separately pins the converter manifest and reviewed warning codes.

Canonical action IDs are unique within each logical page. If an export repeats
an action ID on different pages (for example imported `narration-0`), the fixed
adapter qualifies every playback action ID with a SHA-256 of its logical page
and original ID. This is deterministic and independent of page order. Only the
parsed fixed-build copy changes: Host teaching, immutable canonical exports,
audio references and visual cues remain intact. Exports whose action IDs are
already globally unique retain their previous bytes and build identity. The
fixed builder and player still reject duplicate playback action IDs, protecting
their global speech/cue lookup. Playback callbacks carry the fixed action ID.

## Persistence and bytes

Host archives exact source bytes using the existing content-addressed PPTX
archive. Audio lives under `<hostData>/courseware-assets/<sha256>.bin`.
Archive input must be a bounded regular file inside the allowed root; Linux
opened-file checks reject escapes. Files are nonempty, SHA-256 checked, written
to exclusive temporary files, synced and exclusively linked without overwriting
existing bytes; an existing corrupt archive rejects. Audio is bounded to 50 MiB
per file, 128 MiB total and 1,000 references. A MIME declaration alone does not
prove codec validity or speech/text correspondence.

A25's TTS selector resolves an already adopted receipt within Host's existing
workspace/project/account partition. It verifies current source/text/action/audio
binding and exact archive metadata/bytes rather than importing a Host-private
path as a workspace file. See [authorized media A25](27-courseware-authorized-media.md#a25--adopted-audio-in-immutable-snapshots).

One SQLite transaction captures project, full bound identity and sorted fixed
asset metadata in existing `kv`, namespace `coursewareSnapshots.v1`, scoped by
canonical workspace/project/snapshot ID. It checks pending adoption inside the
transaction. Exact same-ID/same-content capture replays; a different baseline or
content conflicts. There is no update/delete snapshot API. Existing protocol 11,
schema 18 and canonical shared contracts remain unchanged.

Get reads and validates only the persisted record and reopens/hash-verifies all
archives on every call. Restart, parser release, later live teaching edits and
changes/deletion of original workspace files cannot change it. Missing/corrupt
records or archives reject; there is no live-project/file fallback. Capture/get
do not change live project, teaching history, source or editor state.

Files are archived before the DB insert. Failed validation/SQL may retain
unreferenced archives. Reference-aware cleanup, storage quotas and hardware
power-loss guarantees are separate work; current acceptance covers process
restart. This is not a distributed or adversarial-filesystem transaction.

## Desktop fixed build and preview (A17)

### Unsupported native animation degradation

Unbound native effects that cannot use a verified finite playback preset degrade
to a 500 ms whole-object fade when the parsed target is unique, visible and safe.
Unresolved/media/paragraph targets and branches already skipped by the bounded
timing parser remain skipped with warning diagnostics. Supported effects and
speech-owned motion remain intact. These degradation warnings are accepted by the
conversion policy and retained in the package report, including its accepted
warning-code list; unrelated content warnings retain their existing review gate.
Source PPTX bytes are never rewritten. Explicit source-bound native teaching steps,
linked speech animation drift, malformed/oversized timing, ambiguous mappings and
conflicting motion owners retain their rejection guards. A speech motion targeting
a Master group with exactly one mapped visible child resolves to that child;
multi-child groups are not guessed.

Main consumes the imported D22 runtime module unchanged. The finite,
main-window-only channels below use the existing generated preload whitelist:

| Channel suffix under `deckwise/courseware/fixed/` | Strict parameters |
| --- | --- |
| `build` | `{sessionId,projectId,snapshotId}` |
| `approve` | `{reviewId,codes}` |
| `play` | `{previewId,locale}` where locale is `en` or `zh-CN` |
| `cancel` | No arguments |

Build retrieves the persisted Host export, checks ownership before and after
async boundaries, pins the trusted worker manifest, and passes exact frozen
project/mapping/source/assets to D's adapter and builder. It never implicitly
captures live editor state. One build runs at a time. Cancellation during initial
workspace lookup also invalidates the request. No file paths enter renderer
requests or public build results.

`CONTENT_REVIEW_REQUIRED` returns a Main-local one-use review token, snapshot and
diagnostics. Approval must contain exactly the retained unique warning codes.
Main rereads the same immutable Host snapshot before rebuilding. Content errors
cannot be approved. A ready result contains a Main-local preview token, canonical
`CoursewareBuildRef`, snapshot and conversion report. `ready` means structural
readiness, not visual fidelity or native animation support. Reports retain
conversion warnings and capability limits.

Play opens the existing compiled D player in a separate BrowserWindow with
context isolation, no Node integration, sandbox enabled and a nonpersistent
session. Main permits only this window's exact top frame and URL to read the
selected package or a finite manifest asset ID, one read at a time. Files must
be bounded regular files, remain in the selected build directory and match SHA-256
on read. D independently validates package/schema/bindings/media before mounting.
The bridge exposes only `readPackage()` and `readAsset(id)`. There is no generic
filesystem, Host, model or media-generation bridge. Local fonts/styles are bundled;
external network requests and permissions are denied. Playback uses fixed audio
bytes and an explicit user gesture, without online TTS fallback.

Chat/workspace changes, editor deactivation and explicit cancellation close the
player and expire build/review selections. Host exit does the same immediately.
Main-window navigation closes the player; selection ownership is still checked
on subsequent operations. Player pagehide unmounts the playback core and releases
its Blob resources. A late completed build cannot become selected after cancel.
A published but unselected immutable directory may remain for later GC.

## Integration still required

No visible Desktop build/play button, renderer-triggered snapshot capture,
authenticated media receipt, real TTS integration or platform publication is
introduced by A17. The next coordinator must pin a clean saved native source,
resolve C-authorized media and capture before invoking this persisted-build path.
The preview window is a dedicated playback surface, not an embedded work-panel
player or a replacement editor. Do not mark a silent WAV test fixture as
synthesized narration or auto-approve warnings to obtain a successful build.

A17 acceptance uses production-compiled source Electron on Linux with the
user-authorized `--no-sandbox` command-line flag (the window's sandbox preference
remains enabled), local auth and a 100 ms silent PCM fixture. Native audio
`playing`/`ended`, navigation, file tampering, Chat changes, main reload and Host
exit are tested. Installer, development HMR, cross-platform behavior, normal OS
sandbox, real provider output and arbitrary PPTX visual fidelity are not certified.

## Visible saved-draft preview (A18)

A19 adds a [Main-only authorized TTS transport](27-courseware-authorized-media.md)
through the existing login session. It does not yet add trusted Host ingestion
or remove the speech-bearing preview fence described below.

The existing narration sidebar contains one preview section; there is no new AI
assistant. `pptEditorSnapshotCapture({viewId,expectedTeachingRevision})` is a
main-window-only finite IPC. Main derives the session/project/source from the
retained teaching view, rechecks clean native binding/page/generation/owner,
starts a fresh saved-source parse, compares the complete fresh project baseline,
and calls Host capture with a generated snapshot ID. Only the canonical snapshot
reference returns to the renderer; archive paths, mapping and asset paths remain
private. All pages must be explicitly confirmed. Extra keys/arguments and stale,
dirty, hidden or foreign views reject. Parser jobs release on every exit.

A18 initially rejected all speech-bearing drafts. A26 replaces that blanket UI
fence with a missing-audio check: every speech must reference a `tts-<sha256>`
asset before the button enables. This shape check is only an affordance; Main
and Host still reject missing, stale, foreign, unadopted or forged bindings at
capture. Every page must also be confirmed. They never omit narration, use
browser TTS or synthesize replacement audio. This is fixed local preview,
not acceptance of complete narrated publication or speech quality.

The renderer first captures, then builds that snapshot. Each unique warning code
requires a separate explicit checkbox before Main approval; approvals do not
carry into another build. Preview version details show snapshot/build references.
Visual fidelity remains unverified and native PPTX animation/transition limits
are visible. While a frozen preview is selected, teaching controls are disabled;
close/cancel to resume editing and rebuild after changes. The Office view remains
editable; dirty/disabled or unmounted teaching UI cancels builds and closes the
player. Main also independently enforces Chat/workspace/Host ownership.

Cancellation invalidates renderer continuations, so a late capture result cannot
start a build. A capture already executing may finish and leave an unused
immutable snapshot; cancellation is not rollback or snapshot garbage collection.
Closing the player window alone leaves the fixed selection available for replay;
closing the preview section clears it and unlocks teaching.

## Attention cue authoring (W12.1)

The existing teaching sidebar can add, edit and remove fixed-player highlight
and spotlight cues on a selected speech action. These use the existing
`speech.visualCues` shape and the parent speech's audio time in integer
milliseconds; they do not provide word alignment or native PowerPoint animation.
Highlight and spotlight may target multiple current saved-page logical objects.
Users choose timing and targets directly. Changes use the existing serial
teaching draft and page save; no additional review checkbox or page confirmation
is required. Fixed capture validates source, targets and media.

All three task types use the same authoring form, draft, save and
fixed-player path. Scene courses retain their existing semantic projection and
only admit current mapped `native_text`, `native_shape` or `image_layer`
associations. Plain and imported presentations use the current Host-bound saved
identity and admit only actual `text`, `shape` or `image` kinds. Connectors,
missing or changed scene associations and unknown kinds remain unavailable.

The existing private `courseware.project.context` response adds a read-only
`savedObjects:{sourceSha256,mappingRevision,pages:[{pageId,objects:
[{objectId,kind,index}]}]}` projection. It is derived in the same read transaction
as the unchanged project and mapping. The source and page identities must match
the current project; object IDs are the Host-bound UUIDs, not raw source shape
IDs, importer IDs or the worker's initial logical IDs. `kind` is copied from the
validated saved-source identity; `index` is the one-based object order on that
saved page and grants no identity or cross-save association.

Main checks plain/import projection hash, mapping revision, ordered pages and
every object UUID against the same context's canonical mapping. Only the current
page projection, derived eligibility and optional display kind/index reach the
renderer. Generic labels identify kind and current page order rather than
inventing a semantic role. The UI explains the order's limits and asks the
teacher to inspect the saved page and fixed preview. The scene path does not
infer generic identities when a semantic association has become stale. After
explicit source-effect review, only current canonical cue-referenced UUIDs that
also pass the current saved mapping may appear as generic effect targets;
unreviewed semantic associations retain their existing invalidation states.
No authoritative mapping, native ID or new canonical teaching field is accepted
from the UI.

Effects require an unlocked saved page and existing fixed
audio on the selected speech. Main rereads the current saved-source owner and
Host project/object context before writing, rejects stale baselines and invalid
targets, and validates the exact supported cue shape and bounded interval.
Narration and its audio reference must remain unchanged for effect edits.
Unedited cues, pauses and interaction checkpoints remain intact; unsupported
existing cues are displayed as preserved and are not editable in this form.
The existing narration replacement helper still invalidates audio and audio-time
cues when speech text changes.

Explicit timing review does not repair source associations or certify that a
chosen millisecond interval matches spoken words. A native source save keeps
effect editing unavailable until the existing saved-source review is adopted.
That review requires explicit page associations and one object association for
every distinct old highlight/spotlight target. No object selection is prefilled.
Target choices and preserved timing are validated as part of the effect save.
Pages with cues cannot be omitted, and distinct old targets cannot be merged.

The Host's review projection contains only the previous cue target UUID,
verified old kind/order and the current saved parser's kind/order. An adoption
adds optional `effectBindings:[{pageIndex,objectId,targetIndex}]`: `pageIndex` is
zero-based in the newly saved source, `objectId` is the old Host UUID on the
explicitly associated old page, and `targetIndex` is one-based in that exact
review's current parsed page. These positions grant no cross-save identity.
The Host validates both old and new real kinds as text, shape or image and binds
the selected current objects to new Host UUIDs. It rewrites only supported
highlight/spotlight target references in the same transaction as page/source
adoption and adopted-audio rebinding. Speech, audio bytes/paid intent, cue
timing/styles, pauses, checkpoints, locks and peer teaching remain unchanged;
all pages require confirmation again. Unknown cues/actions, missing targets,
duplicate/foreign associations and changed source, mapping or teaching fail
closed without clearing cues or partially adopting. Existing no-effect review
callers may omit `effectBindings`.

The fixed compiler and loader independently verify logical bindings, supported
render targets, exact audio bytes and effect capabilities before playback.

## Registered native client coordination (W14.2 continuation)

The existing Owner narration sidebar now offers explicit registered-window pause,
inspection and resume operations. Main retains pause/barrier request UUIDs and
exposes only an opaque UI view, epoch, counts and finite state. Additive main-frame
channels `deckwise/courseware/online/barrier/{read,start,resume}` accept exactly
`{ownerId}` for read and `{viewId}` for mutations. Native keys, Docs identities,
raw server pause/barrier IDs, credentials and signed editor config stay private.
No generation or publication action is started by these controls.

Start freezes the local teaching UI before awaiting any network operation. Main
requires no pending teaching save, obtains a held server teaching pause, then
starts the native barrier with exact retained IDs. Each config-issued native
mount has its own UUID and signed Docs user suffix. Its worker sends serial
five-second heartbeats, performs the fixed native quiesce/status/resume actions,
and reports held only after an exact native ACK with a server index. Platform
serializes config issuance, registration and admission freeze on the editing
session row. Expired, disconnected, unavailable, revoked or unmanaged clients
are not treated as held. Legacy signing permanently marks that epoch unmanaged.
Legacy Platform launches remain usable for ordinary editing.

Owner resume releases the native barrier before resuming teaching. Clients resume
only after observing that same barrier's explicit released state, which remains
queryable. Closing, timeout, null reads and account changes do not infer release.
Main retains exact mutation IDs after an unknown result; UI must successfully
recheck before offering an explicit replay. An old released record or another
pause cannot replace an uncertain request's identities. Unknown UI state remains
read-only even if an independent teaching-pause read reports no pause.

After an admission-blocked join, Main retains only the original authenticated
project selection for recovery. It independently reads the active server epoch,
source and pause/barrier, then permits explicit recovery/release without mounting
an editor. This selection grants no teaching/native authority and cannot start
a new barrier. New owner/project/account selection or close invalidates it. After
release the user explicitly retries joining; narration stays disconnected until
native ready. This prevents the admission freeze from making its recovery UI
unreachable after restart.

The native ACKs and registry are still client-reported evidence. Responses expose
`allRegisteredClientsHeld`, `proof:'client-reported'`, `authoritativeCoverage:false`
and `consistentPublicationReady:false`. A held registry does not open the
consistent-publication gate. Authoritative Docs connection coverage, real
multi-process recovery acceptance and the joined
archive/resolve/audio/capture/build/publication workflow remain separate work.

## Online saved-source review orchestration

The online editor's Main coordinator uses the held teaching pause, exact original
source download and complete original mapping to establish a Host baseline. A
requested server force-save supplies a separate verified archived PPTX candidate.
Both sources are staged as private read-only workspace copies; the single Host
parser slot is released between original baseline, target review and explicit
target resolution. No parser position is treated as retained logical identity.

The existing association leaf is reached through the editor and the additive
`deckwise/courseware/online/source/{begin,resolve,preview,clear}` channels. Main
retains source/job/baseline/review identities and resolved project/mapping. Only
the finite review projection and ready/total counts return to the main frame.
Account, native owner, Host, Chat or workspace changes invalidate continuations.
Private file cleanup releases the captured Host's parser first; an unknown
parser outcome is a cleanup failure, not permission to delete in-use files.

Review begins only with teaching paused and the registered native clients held.
That candidate can be inspected without claiming authoritative coverage of all
Docs connections. Resolution is read-only and does not create a snapshot, update
the live source or teaching, adopt audio, build or publish. An active review
blocks pause/native resume until clear. See the
[editor interaction contract](../04-ux/12-courseware-online-source-review.md).

Generation preflight validates converted page geometry with the fixed player's
slide schema before reporting readiness. Final fixed builds invoke the actual
`loadFixedBuild` loader against staged package bytes and staged asset bytes,
then dispose its temporary URLs before publication. Schema, asset hash and
binding failures prevent a published build; a source/mapping preflight alone is
not sufficient final acceptance.

Inherited layout and master artwork keeps its geometry and appearance but carries
no slide-local shape ID or group ancestry. Native snapshots bind these render-only
elements to the verified parser fingerprint (`inherited-<object hash>`), while
slide objects still require exactly one native identity match. Generation preflight
uses the same distinction; inherited artwork cannot impersonate a teaching target.
Parser errors also block generation readiness. A plain theme `bg1` fill on a
notes/handout master remains a review warning; custom artwork or fills still block.

Playback headings prefer a saved native generation title, excluding the old
Master placeholder that merely repeats its internal learning objective; independent
checkpoint questions take priority to avoid exposing an internal answer/objective.
For imported pages without saved titles, actual named title frames take priority
over a misclassified body label, and generic internal filenames use a page label.
Audio priming uses a managed `audio/wav` Blob URL, revoked on retry or destruction,
so it works under the existing `media-src blob:` policy without weakening CSP.
