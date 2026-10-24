# 01. IPC Protocol

## Owner online preparation (W14 source increment)

Three additive main-window, top-frame-only invoke channels use the same preload
allowlist and response envelope. They reject unknown fields and extra arguments:

| Invoke | Exact input | Result |
|---|---|---|
| `deckwise/courseware/online/prepare/review` | `{sessionId,projectId,includeTeaching?:boolean}` | `CoursewareOnlinePreparationReview` |
| `deckwise/courseware/online/prepare/confirm` | `{reviewId}` | `CoursewareOnlinePreparationResult` |
| `deckwise/courseware/online/prepare/cancel` | `{reviewId}` | `{ok:true}` |

Review is read-only. Main resolves the owning Chat, persisted workspace, saved
clean writable PPTX, existing task association, current server OWNER role,
source revision and session epoch. Its opaque 10-minute review exposes filename,
length, SHA, team project, epoch, replacement indication and optional recovery
indication; no local paths, file bytes, credentials or native configuration.
A configured online deployment is required before review or confirmation.
Omitting `includeTeaching` (or passing false) retains the PPTX-only operation.
The separate Owner action to prepare with narration passes true; its public
review includes `teaching:{pageCount,narrationCount,audioCount?}` and requires explicit
confirmation of that teaching initialization. When present, `audioCount` counts
distinct already generated archived audio assets selected for team transfer;
the confirmation discloses that transfer. UI refuses a review whose
teaching mode differs from the requested action.

Only explicit confirmation may upload the exact reviewed PPTX (at most 20 MiB),
start with both reviewed epoch and uploaded-source revision CAS, bind that exact
epoch, then atomically complete the Host task association. Main rechecks Chat,
workspace, account, native saved/dirty state, source bytes and OWNER permission.
The first subsequent prepared join also pins the source revision/SHA and epoch
before native config delivery. Ordinary already-active-session join retains its
existing semantics. An unrelated active session offers ordinary join only.

Host stores a non-secret receipt scoped to workspace, Chat and principal before
each uncertain external write. Upload request identity, original source CAS,
source hash/length and epoch remain immutable. A new explicit review/confirmation
can query and resume an interrupted upload/start/bind, including after restart;
no background POST replay occurs. Lost upload responses are resolved by exact
request/hash/length match. Lost start responses require the same uploaded source
and next active epoch; if the original epoch is still inactive, only a fresh
explicit confirmation can reissue its CAS-protected start. An intervening source,
account, project, epoch or task binding rejects. Cancel invalidates only the local
review, not completed server operations. Receipts remain available for recovery.

Optional teaching initialization admits an already initialized local Host
project bound to the exact saved source and ordered logical page mapping. Review
does not create that local project. A first seed requires a remote project with
neither source nor teaching; an existing matching preparation receipt may resume.
Existing remote teaching/source, missing lineage and unproved local audio references
reject before a new upload. Main projects the local project onto the team UUID
and server-issued source revision, preserving logical page IDs and action data;
Platform issues the teaching revision. No local source revision is treated as a
remote revision. The uploaded stage initializes and verifies teaching before
start/bind, reusing the upload request ID in the separate teaching idempotency
domain. Host optionally pins `teaching:{projectId,teachingRevision,mappingRevision,
payloadSha256}`; the content hash covers the complete canonical local project
and ordered mapping, including every object/import ID. Initialization sends that
mapping in the same request. Platform stores it immutably with teaching; Main
checks its exact project/source/mapping tuple through the authorized versioned
GET before accepting initialization or resuming a committed response loss.
Changed local teaching or mapping cannot silently resume the same request.
Old PPTX-only receipts retain their behavior. A pending teaching receipt with
the earlier partial-mapping hash refuses recovery rather than reissuing a write
against different content; it requires explicit reconciliation. No mapping is
inferred from page order alone. Consistent publication remains outside this
operation. UI and fixture checks do not establish a deployed gate.

For teaching containing already adopted TTS or exported sequential music, review
performs read-only Host-receipt and authenticated task preflight. TTS receipt
selection must match each speech's page/action/text and current bound source;
music must have the adopted exported-clip provenance for the exact current
source/teaching tuple. Task kind, settled/ready state, immutable asset UUID,
SHA, MIME and length must agree. The private seed hash additionally pins that
complete audio projection and its original local content. No-audio seeds retain
their previous hash and public review shape.

Only explicit confirmation may adopt these existing assets into the selected
team project, before teaching initialization. Main first GETs each exact team
asset UUID; an already adopted matching asset is reused. Only a definite 46901
permits the explicit same-confirmation adoption POST. Unknown outcomes do not
retry automatically; a new explicit review/confirmation resolves the same
immutable assets and preparation request after restart. Downloaded private
bytes are checked against the pinned asset. Original local teaching, source,
mapping and local audio IDs are never rewritten: only the remote initialization
copy receives team UUID references. This path submits no TTS, music-generation
or export job and creates no new provider charge. Arbitrary URLs, missing
receipts and changed task/audio projections refuse instead of dropping audio.

The optional initialization `mapping` has exact fields
`{revision,sourceSha256,pages:[{pageId,importPageId,objects:[{objectId,importElementId}]}]}`.
Its source revision comes from `project.source.revision`. Main's private
`GET /courseware/team/projects/{id}/teaching/mappings/{mappingRevision}?sourceRevision={revision}`
returns `{projectId,source:{revision,sha256},mapping}` and is available to current
Owner/Editor/Viewer members. Missing/legacy mapping is 46607, not an empty mapping.
Logical IDs are globally unique and safe (1–128 characters); native import IDs
are nonblank, bounded to 200 characters without C0/DEL, unique per applicable
scope. At most 100 pages/10,000 objects and 2 MiB whole initialization request
are admitted. New deployments require the teaching-mapping SQL migration.
Stored input describes the original uploaded source: it neither proves parser
lineage nor rebinds a mapping after native content/structure changes. A saved
source with a different SHA still needs fresh parser validation and review.

## Online teaching page editing (W14 source increment)

Five additive main-window, top-frame-only invokes share the existing allowlist
and envelope. Exact inputs reject unknown fields/extra arguments:

| Invoke suffix under `deckwise/courseware/online/teaching/` | Input | Result |
|---|---|---|
| `read` | `{ownerId,pageId?:string}` | `CoursewareOnlineTeachingView` or null |
| `acquire` | `{viewId}` | `CoursewareOnlineTeachingView` |
| `renew` | `{viewId}` | `CoursewareOnlineTeachingView` |
| `save` | `{viewId,actions}` | `CoursewareOnlineTeachingView` |
| `release` | `{viewId}` | `CoursewareOnlineTeachingView` |

The same mounted native attempt supplies `ownerId`. Main pins its account,
project, active session epoch and initial source; opaque `viewId` identifies
one page baseline. The public view contains `{ownerId,viewId,project,
mappingRevision,sessionEpoch,pageId,pageNumber,leaseExpiresAtEpochMillis?}`.
No lease tokens, local paths, credentials or signed native configuration enter
Renderer. Missing lease deadline means read-only. Platform remains authoritative
for membership, lease proof, source/teaching revisions and atomic writes.

The existing online editor sidebar reads narration and offers an explicit page
selector in **initial uploaded-source logical order**. It does not follow the
live Docs selection or attest a native slide-to-logical-page association. The
UI warns users to stop and reconcile if slides are added, removed or reordered.
No unverified highlight/spotlight authoring or new AI assistant is introduced.

Explicit Edit acquires a page lease; editing renews every 20 seconds. Save
submits bounded speech text/pauses, permits speech insertion/removal, and retains
opaque/checkpoint/music actions. `replaceNarrationText` invalidates the changed
segment's old audio/timed cues; other action data is preserved. Main independently
validates admitted edits. Peer-page updates may advance the whole-project
revision if this page/source/mapping remains unchanged; target-page conflicts
refuse. Save/release/renew remain explicit finite operations with Main-held proof.

Failed or expired edits retain the local in-memory draft. Page changes/refresh
and panel Back/Retry require explicit discard before replacing that draft.
`COURSEWARE_ONLINE_TEACHING_PENDING_WRITE` means the save result is uncertain:
the original view/actions are frozen, read/switch/discard/release are blocked,
and only explicit Continue save replays the retained request/body to determine
its result, including after the original lease deadline. This pending write is
not a persisted restart-recovery receipt. Account invalidation still closes
the local view immediately. Cleanup attempts release; the server lease expiry
remains authoritative. No automatic remote teaching merge or fixed publication
claim follows from native synchronization notifications.

## Online teaching pause recovery (W14 publication prerequisite)

Two additive top-frame-only invokes recover an existing server-held teaching
pause. They use the same Main-window allowlist, exact payload validation and
error envelope:

| Invoke under `deckwise/courseware/online/pause/` | Input | Result |
|---|---|---|
| `read` | `{ownerId}` | `CoursewareOnlinePauseView` or null |
| `resume` | `{viewId}` | `{ok:true}` |

The mounted online attempt pins the account, team project, session epoch and
source. Main reads `GET /editing-session/{epoch}/write-pauses/current`; no local
pause identifier is needed after restart. The server requires current OWNER
membership, a matching active epoch and matching frozen teaching/source. Main
rechecks those bindings after each await. Its public view contains only
`{ownerId,viewId,sessionEpoch,teachingRevision}`. The pause ID, complete frozen
teaching, credentials and any archive URL remain outside Renderer.

Only the Owner's existing narration sidebar mounts the recovery controls.
Discovery is read-only. A held pause disables new narration acquisition/edits
and displays the captured teaching revision. Explicit Resume calls DELETE with
Main's retained pause ID and validates the same frozen teaching in its released
receipt. A lost response retains that proof for explicit idempotent retry; a
new read can instead establish that the pause was released. No automatic DELETE
or creation of a new pause occurs. Unsaved drafts, uncertain narration saves
and active operations block the UI's Resume; Main independently refuses Resume
while a teaching operation or uncertain save is outstanding. Resuming reloads
the current logical page, and fresh page leases are required for editing.
Account/mount invalidation expires recovery views and ignores late results.

This pause stops teaching writes only. Native Docs editing can continue. These
controls neither create a publication nor establish an all-client native save
barrier. Main's separate bounded force-save/status/archive transports preserve
`command_unknown`, `pending` and `no_changes` as distinct states; only an
archived callback with matching request/key/epoch identifies durable bytes.
Download locations remain Main-only and are not downloaded by these controls.
Complete saved-source mapping, semantic review, team audio admission and the
joined publication coordinator remain required by W14.2.

## Online publication source review (W14 prerequisites)

The original uploaded-source mapping remains immutable. Native editing changes
the PPTX SHA, and parser page/object IDs are not persistent identities across
arbitrary native saves. Replacing only the old mapping's SHA or matching by page
number cannot rebind teaching. A separate Host baseline/review RPC validates the
old parsed source and full original mapping, then the independently parsed saved
archive. It exposes explicit page/object choices without default associations;
it never adopts that archive into the current local project. These Host methods
are not Renderer IPC or a user-visible publication action.

Platform's Owner-only `POST /teaching/source-reviews` atomically captures a
publication-only candidate against an exact held teaching pause, baseline
source/teaching revision and archived force-save requested after that pause.
The candidate uses its request UUID as an independent snapshot/source revision,
the callback SHA/length, a newly issued teaching revision and a new full mapping.
Current source, teaching and native editing epoch remain unchanged; resumed R9
can continue while immutable R8 is built. Member-authorized GET returns the same
capture after restart or further edits; missing capture is 46608.

Main's authenticated `captureSourceReview` and `getSourceReview` transport
methods validate the exact project/source/request UUID, baseline revisions,
force-save request, epoch, complete ordered mapping and newly issued teaching
revision. `sourceByteLength` is the archived length, bounded to 20 MiB. These
are Main methods, not additional Renderer invokes. The Main-only
`downloadCallbackArchive` first obtains the authorized callback receipt, then
streams its signed location without a Platform token, cookies or redirects.
It checks actual length, SHA256 and the existing PPTX container boundary; only
receipt and bytes are returned. Publication still requires document status 6
and exact receipt/candidate binding.

Attention effects use the existing `speech.visualCues[]` structure:
`{id, atMs, endMs, effect}`. Highlight uses
`effect: {type: "highlight", elementIds, color?, style?, opacity?}`; spotlight
uses `{type: "spotlight", elementId, elementIds?, dimOpacity?}`. Each speech
has at most 200 unique cue IDs; each cue has 1–200 distinct targets present in
that same mapped page, with integer `0 <= atMs < endMs <= 3600000`. Optional
highlight color is a six-digit hex color, style is `outline`, `fill` or `glow`,
and opacity values are finite numbers from 0 to 1. Cues attached to non-speech
actions, unknown cue/effect fields, and standalone `highlight`/`spotlight`
actions are unsupported. This review validates existing timed effects; it does
not create native PPTX animations.

This record establishes authorized immutable input, not parser correctness or
all-client save acknowledgement. Native synchronization, explicit page/effect
review, verified team audio and Host snapshot import/build must still be joined
before a consistent publication is advertised. Existing native structural-change
warnings remain: publication review does not silently reconcile the live editor.

## Isolated team online-editor entry (W13)

### Internal fixed native barrier transport

Main's `CoursewareOnlineViewController` exposes internal
`nativeBarrierCapability(ownerId)` and
`nativeBarrier(ownerId, 'quiesce'|'status'|'resume', barrierId)` calls to the
publication coordinator. They are not renderer invoke channels or publication
actions. The isolated wrapper forwards only `barrier-capability`,
`barrier-quiesce`, `barrier-status` and `barrier-resume` on the existing
`deckwise-docs-online/1` channel. Barrier IDs are lowercase UUIDs; each call has
a fresh Main request ID and the current mount generation. Responses must match
that request, project, epoch, native key and Docs user as well as the existing
sender/frame/origin/channel guards. At most one call is outstanding per view.

Capability returns only `{available:boolean}`; an older engine can return false
without losing its ordinary text-read bridge. Other results have exact fields
`{barrierId,state,serverIndex?,error?}`. `draining` has no index/error;
`held`/`resumed` require a nonnegative safe-integer server index and no error;
`uncertain-held` requires a finite native error. Unrecognized fields, states or
errors cannot supply an acknowledgement. No signed config, private native key
or receipt is emitted to the app renderer by this internal API.

A 30-second Main deadline, malformed reply or finite native refusal fails only
that call. It does not close the editor, automatically resume, retry a command
or turn uncertainty into success. A caller may explicitly inspect the same
barrier afterward. Late replies cannot satisfy a different request. Native
dirty/clean events remain UI signals and do not resolve these calls. The fixed
version-pinned Docs extension must actually be deployed before this capability
can be used; per-client receipts do not establish complete client membership,
an all-client barrier or an archived publication.

### Public entry and isolated view

Five additive invoke channels under `deckwise/courseware/online/` accept only
the ordinary Main window's top frame. Preload allowlists their fixed names;
unknown fields, extra arguments, subframes and other windows reject. Results
use the normal IPC envelope. Renderer input cannot supply credentials, signed
configuration, editor URLs, native document keys or session epochs.

| Invoke suffix | Exact input | Result |
|---|---|---|
| `state` | No payload | `CoursewareOnlineEditorState` |
| `open` | `{ownerId,projectId}` | State after native document readiness; failures also emit an error state |
| `bounds` | `{ownerId,bounds:{x,y,width,height}}` | `{ok:true}` |
| `visible` | `{ownerId,visible:boolean}` | `{ok:true}` |
| `close` | `{ownerId}` | `{ok:true}` |

Both identifiers are lowercase UUID strings. `ownerId` identifies one mounted
UI attempt, not an account or authorization grant. Bounds are finite numbers
from 0 through 16,384; Main rounds them before setting native bounds. Stale-owner
bounds/visibility/close operations cannot affect a replacement attempt. Main
also correlates native messages with its own increasing generation, random
channel and request IDs. Account replacement, Main-window closure/crash, native
failure, explicit close and the 30-second mounting deadline cancel that attempt.
Hiding the window detaches its view; leaving the online tab closes that local
view. The local PPTX editor and its save buffer remain a separate surface.

`deckwise/courseware/online/event/state` carries only
`{available,ownerId,projectId,status,errorCode?}`. Closed identifiers are null.
Statuses are `closed`, `opening`, `ready`, `sync-pending`, `sync-reported` and
`error`; errors are finite symbols, never raw native errors or signed config.
`available` reports valid installation configuration, not service health or
permission. `ready` requires the native document-ready event, not an iframe load.
`sync-reported` means the engine reported no pending local changes; it is not a
durable callback receipt, a new source revision, or permission to publish.

The Main-only client joins an already active, bound Platform editing session.
It reads that session and requests its original epoch/key's short-lived signed
config, retaining the immutable source tuple and actual user identity. OWNER
and EDITOR are offered the team UI action; Platform remains the permission
authority. A signed read-only/view configuration rejects with
`COURSEWARE_ONLINE_READ_ONLY`, including direct IPC calls by a Viewer. Missing
or inactive sessions fail without starting, binding, replacing or ending a
shared session. Closing this local view does not disconnect other members.

Installation environment supplies `DECKWISE_DOCS_ONLINE_ENTRY_URL` ending in
`/courseware-online.html` and `DECKWISE_DOCS_API_URL` with exact path
`/web-apps/apps/api/documents/api.js`. Optional
`DECKWISE_DOCS_PLUGIN_CONFIG_URL` ends in `/config.json` on the entry's origin.
All pins require HTTPS or loopback HTTP, with no URL credentials/query/fragment.
Missing or invalid configuration disables this entry; the existing team list
and fixed preview remain usable. Project responses and normal renderer input
cannot choose these pins.

Main creates a sandboxed `WebContentsView` with its own nonpersistent session
and local `deckwise-editor://host/online.html` wrapper. The wrapper embeds the
installed trusted Office entry; only parent origin, random channel and API/plugin
pins enter its URL. The original `configJson`, including its short-lived native
JWT, crosses only Main's finite preload bridge and an exact origin/window/channel
`postMessage` handshake using `deckwise-docs-online/1`. It never enters the
ordinary app renderer, URL or public state. Main validates config/JWT payload
bindings; the Docs deployment must verify the JWT signature. Popup, download,
permission and top-navigation requests are denied. This increment exposes no
native write/Chat bridge, local save patch, automatic source promotion or
start/bind/end-session IPC.

## Canvas music tasks (W15.2 source increment)

Main-window-only channels under `deckwise/courseware/canvas-music/` are
`models`, `list`, `prepare`, `quote`, `submit-confirmed`, `status`, `preview`,
`export-prepare`, `export-quote`, `export-submit-confirmed`, `export-status`,
and `export-archive`. Exact typed Renderer payloads and result views are in
`packages/shared/src/courseware-canvas-music.ts`; no credentials, principal,
provider URLs or local paths are accepted from or returned to Renderer.

Generation freezes a saved music draft's title/lyrics plus separately entered
style/negative-style/instrumental options. The title is at most 100 UTF-16 code
units, lyrics at most 4,000, and style fields at most 1,000. Blank lyrics require
instrumental mode. Image references are not supported for music. Prices are
Main-held expiring offers; a quote is not a submission. An explicit confirmation
is required for each generation and each separate candidate MP3 export. Only
the two `submit-confirmed` operations POST. An unknown result remains queryable
by its durable original key/hash, without a retry POST or personal-route fallback.

Status preserves all ordered candidates. Preview is an authenticated GET followed
by a verified private local MP3 archive, not an implicit paid export. Export is
prepared against a specific source intent/candidate and preserves the source's
submission scope even if the draft or team binding changes. Old candidate and
export archives remain locally readable after full restart; local cached bytes
are not remotely erased by membership revocation. New remote byte reads enforce
current Platform authorization. Missing/corrupt archives fail closed and are
never silently regenerated. This increment does not apply audio to PPTX, publish
a new package, or certify real supplier prices and audio quality.

## Target-bound canvas image review (W15.2)

The existing main-window-only `pptEditorImagePrepare` also accepts exactly
`{sessionId,intentId,operation:"replace"|"insert"}` for an owned archived canvas
candidate. The existing team payload `{sessionId,projectId,assetId}` is unchanged.
`CoursewareImageReviewView` adds optional `target:{page,operation}` for canvas
reviews, using one-based page numbers. Approval and clear retain their existing
channels. Extra fields and arguments reject. Candidate preparation/approval does
not generate images, write PPTX or save. Main alone resolves authenticated Host
paths and retains bytes plus the native target generation. See
[native review contract](23-courseware-native-chat.md#archived-canvas-candidate-source).

## Canvas image tasks (W15.2 increment)

Additive main-window-only invoke channels under `deckwise/courseware/canvas-image/`:
`models`, `list`, `prepare`, `quote`, `submit-confirmed`, `status`, `archive`,
`preview`, and `reference-preview`.
All take `sessionId`. Prepare also takes `intentId,draftId,expectedRevision,
expectedDraftRevision,model`; quote/status/archive/preview/reference-preview take
`intentId`; submit-confirmed adds
`quoteId`. Main derives principal from the current authenticated session and
rejects unknown fields/extra arguments, foreign visible Chats and active turns.
No principal/token/path/provider key is accepted from Renderer. Quote tokens
stay in Main and expire; the UI receives only quote identity, model, point bound,
character limit and expiry. Only explicit submit-confirmed may POST. Status uses
the retained original receipt or key/hash GET recovery and never resubmits.
Task views include the frozen draft and phase, optional fee/state summary and
optional immutable image metadata. Archive validates an already submitted
ready/settled result against its original receipt, downloads and verifies original
bytes through Main, then stores them in Host. It never submits a generation.
Preview reads the private verified archive locally; its result is `{image,dataUrl}`.
Reference-preview returns `{intentId,reference,dataUrl}` after checking the frozen
reference identity and bytes. Neither response exposes paths, provider URLs or
task receipts. Old candidates remain previewable after draft edits/deletion or
switching to Plan. Generation/archive/preview do not apply anything to PPTX;
target-safe adoption and music remain later W15.2 work.

## 1. Goal

Define a stable contract between the renderer and main.

Principles:

1. All capabilities go through the preload allowlist
2. Requests/responses are typed
3. Long-running tasks use event streams, not a single oversized response
4. Errors must have a code + message

## 2. API Groups

Fixed team sharing adds main-window-only
`deckwise/courseware/fixed/shareStatus({sessionId})` and
`deckwise/courseware/fixed/shareRecover({sessionId,intentId})`. Both reject
extra fields/arguments, require the owning current Chat and signed-in account,
and return `{intent:null|{intentId,state,selection}}` through the normal envelope.
Main supplies the private principal key; caller paths, build bytes and replacement
selections are not accepted. Status reads the Host journal. New intents retain
`receiptAware:true` and send their UUID with the original publication. Recovery
verifies the authorized frozen build and that intent's durable successful
publication receipt before completing the original local binding, even when a
later publication has advanced the channel. It never uploads or publishes.
Legacy intents without that flag retain exact current-pointer matching; they
cannot acquire historical authority by being read. An unresolved intent prevents
another publication. Missing, denied or mismatched receipts stay unknown without
fallback to the current pointer. No general retry or clear operation is exposed.
The backend receipt migration must precede new keyed callers. See
[authorized media](27-courseware-authorized-media.md).

Scene planning adds main-window-only `deckwise/courseware/scene-plan/read`.
It accepts exactly `{sessionId}`, rejects extra arguments and caller paths,
and returns `{plan: CoursewareScenePlanSnapshot | null}` through the normal
envelope. Main resolves the persisted Host task/workspace and reads only that
Chat's validated planning draft. No generation, adoption or source write is
performed. See [scene planning drafts](22-courseware-contract-v1.md#scene-planning-drafts).

`deckwise/courseware/scene-plan/approve` is an explicit main-window action with
exactly `{sessionId,sha256}`. Main validates the current draft and Host rechecks
and persists its approved content. The response is the refreshed `{plan}` with
`approvedSha256`; mismatched hashes or redirected/invalid files reject. No
media submission or PPTX write occurs. Extra fields/arguments reject. Subsequent
Chat edits require explicit reapproval.

Approved scene visual requests add six main-window-only channels under
`deckwise/courseware/scene-image/`: `models` and `list` accept `{sessionId}`;
`prepare` accepts `{sessionId,planSha256,pageId,model}`; `quote` and `status`
accept `{sessionId,intentId}`; `submit-confirmed` additionally requires
`quoteId`. Exact fields and argument counts are enforced. Main owns the active
Chat/account check and the short-lived quote proof; Host owns durable requests.
Renderer views omit keys, principal hashes, task references and proof tokens.
Status only reads/reconciles the original request, including after restart.
No asset is adopted and no scene PPTX is generated by these operations.
See [authorized scene requests](27-courseware-authorized-media.md#approved-plan-image-request-journal-2026-10-23).

Three additional main-window-only scene-image channels support private image
review. `archive` and `preview` take exactly `{sessionId,intentId}` and return
`{image: CoursewareSceneImageView,dataUrl}`. Archive downloads only the original
ready/settled task, verifies its bytes and stores them in Host; preview reads
and verifies the existing archive without HTTP. Views include bounded image
metadata and `selected`, never private paths/task references. `adopt` takes
`{sessionId,intentId,expectedSelectedIntentId}` with an explicit string or null
selection baseline and returns the refreshed scoped list. It revalidates the
image, current approved plan and page-local selection before changing the
reference. These operations never generate media, charge, share or create PPTX.
Old-plan images remain previewable but cannot be selected for the current plan.

`deckwise/courseware/scene/generate` accepts exactly `{sessionId,planSha256}`
from the main window and returns `{path}` for the generated workspace PPTX.
Main derives the current model, approved plan, reviewed private images and
ordered narration; extra fields/arguments and foreign senders reject. It uses
the existing model route and native compiler/stager, never submits new image
tasks, and opens no arbitrary caller path. A concurrent generation refuses.
`deckwise/courseware/scene/generate-cancel` accepts exactly `{sessionId}` and
returns `{cancelled:boolean}`; a matching in-flight operation is aborted.
See [reviewed scene compilation](27-courseware-authorized-media.md#reviewed-private-assets-to-editable-pptx).

Courseware representative/scope review adds main-window-only channels under
`deckwise/ppt-editor/style/`: `prepare({sessionId,candidateId})`,
`approve({reviewId,pageIds})` and `clear()` with no arguments. Extra fields and
arguments reject. `prepare` requires the actual current Main-retained generated
representative and returns `CoursewareStyleReview`: opaque review ID, candidate
ID/output hash, representative page ID/number, original instruction, numbered
page/lock choices and one native-rendered PNG data URL. `approve` revalidates the
saved owner and complete Host state, then returns `{confirmed:true,pageIds}` in
source order for 2-20 unlocked pages including the representative. These methods
grant no model execution, source write or adoption. Full restart loses the Main
retention/approval; it does not remove Host candidates. See the
[representative review contract](25-courseware-source-candidates.md#actual-representative-and-target-scope-review-a45).

Courseware current-page visual review adds three finite main-window-only channels
under `deckwise/ppt-editor/visual/`: `prepare({sessionId})`,
`approve({reviewId})` and `clear()` (no arguments). Extra fields/arguments and
non-main senders reject. `prepare` returns `CoursewareSourceVisualReview`: an
opaque review ID, Host project/logical-page IDs, one-based page number, source
SHA-256 and two `{width,height,preview}` PNG data URLs. `approve` returns
`{approved:true}` only after current-state revalidation; `clear` returns
`{ok:true}` and aborts pending preparation. These channels grant neither model
execution nor candidate/source adoption. Main alone retains bytes and approval;
see [source visuals](25-courseware-source-candidates.md#current-page-visual-review-a37).

Courseware TTS adds six finite main-window-only channels under
`deckwise/ppt-editor/tts/`: `prepare`, `submit`, `status`, `list`, `archive`,
and `adopt`.
The exact view/revision-bound parameters and redacted response are specified in
[authorized media](27-courseware-authorized-media.md#a21--finite-main-orchestration).
Only explicit submit of a durably prepared current intent may POST. Recovery and
status never submit or expose Host RPC, tokens, paths or arbitrary HTTP.
`archive` uses the same view/revision/intent parameters as `status`, returns only
intent ID, archived=true, measured duration and audioReady=false, and performs
authorized download/actual decoding only when no verified Host archive exists.
See [decoded ingestion](27-courseware-authorized-media.md#a23--main-decoded-audio-ingestion).
`adopt` uses `{viewId,expectedTeachingRevision,intentId}` and returns the current
teaching view after a successful Host CAS; Main derives the action and expected
previous audio ID from its pinned view. See
[explicit adoption](27-courseware-authorized-media.md#a24--main-explicit-audio-adoption).

| Domain | Description |
|---|---|
| `app` | App info, health checks |
| `agent` | Conversation, queued-send stop/abort, status, and interactive asktool resolution |
| `plan` | Plan proposal listing, resolution, and change events |
| `session` | Session CRUD / history / title metadata and summarization |
| `session collaboration` | Read-only bounded collaboration status for sidebar projections; mutation stays in the reviewed plugin gateway |
| `settings` | Config read/write |
| `secrets` | Secret write/delete/exists (never return plaintext to UI logs) |
| `project` | Workspace selection, logical project groups, and query |
| `tool` | Permission confirmation callback |
| `shell` | Host shell catalog and persisted default shell |
| `log` | Diagnostics that the frontend can display |
| `plugin` | Plugin install/enable-disable/query/permissions |
| `commandPalette` | Command palette search and execution |
| `workspace` | Workspace selection and legacy working-tree diagnostics |
| `browser` | Work panel embedded preview navigation/bounds/visibility + state events |
| `fs` | Work panel workspace file listing/reading/reveal, chat file-reference completion against the project, session scratch, and attachment roots, plus user-initiated open with the OS default handler (read-only) |
| `window` | Frameless window state, controls, and compatibility work-panel geometry channels |
| `menu` | Allowlisted application-menu commands and native editing/window actions |
| `notification` | Durable inbox list/read/clear and new/activated events |
| `stats` | Completed-turn token history (host RPC; dashboard is plugin-owned) |

## 3. Channel Conventions

```text
invoke: pi-desktop/<domain>/<action>
event: pi-desktop/<domain>/event/<name>
```

Examples:

- `pi-desktop/agent/prompt`
- `pi-desktop/agent/steer`
- `pi-desktop/agent/stop`
- `pi-desktop/agent/abort`
- `pi-desktop/agent/event/message`
- `pi-desktop/agent/askTool/resolve`
- `pi-desktop/session/list`
- `pi-desktop/session/summarizeTitle`
- `pi-desktop/project/open`
- `pi-desktop/project/pickFolders`
- `pi-desktop/project/clone`
- `pi-desktop/project/cloneCheckout`
- `pi-desktop/project/openFolder`
- `pi-desktop/project-group/list`
- `pi-desktop/project-group/create`
- `pi-desktop/project-group/rename`
- `pi-desktop/project-group/update`
- `pi-desktop/project-group/memory/get` / `save`
- `pi-desktop/project-group/instructions/get` / `save`
- `pi-desktop/session/getScratchPath`
- `pi-desktop/session/openScratchPath`
- `pi-desktop/session/collaboration`

## 3.1 Logical project groups

A project group is the ChatGPT-style project container used by the renderer.
The host owns its id, display name, ordered roots, primary root, shared memory,
and shared instructions. The first selected root is primary.

```ts
type ProjectGroupRoot = { path: string; name: string; position: number };
type ProjectGroupRecord = {
  id: string;
  name: string;
  primaryPath: string;
  roots: ProjectGroupRoot[];
  createdAt: number;
  updatedAt: number;
  pinned: boolean;
  lastOpenedAt: number;
  legacy?: boolean;
};
```

`project-group/create` is additive and does not change the active workspace.
`project-group/list` returns one row per logical group; old path projects are
returned as `legacy` single-root groups. Group memory and instructions are
shared by all sessions whose primary path belongs to the group. The primary
path is the default builtin-tool workspace. The runtime advertises all registered
roots; an absolute path under an additional root is canonicalized and executed
against that root, while arbitrary external paths still require the ordinary
permission flow.

## 4. Common Response Envelope

### Saved PPTX inspection

The additive `deckwise/ppt-editor/inspect/start`, `/status` and `/cancel`
channels are restricted to the main window. Start accepts no arguments;
status/cancel accept exactly `{ checkId: string }`. Main derives the saved
PPTX revision from the ready editor. Shared `PptxInspection` returns RUNNING,
SUCCEEDED (pages, full diagnostic/error counts and bounded diagnostics with
severity/optional zero-based page index), FAILED or CANCELED with the
captured revision/hash. Long parsing stays in the Host worker; calls return
short status projections and the renderer polls while running. Neither file
paths nor a generic Host RPC proxy are accepted. See
[courseware parser](21-courseware-parser.md#saved-revision-inspection).

The ordinary response envelope still applies:

```ts
type Result<T> =
 | { ok: true; data: T }
 | { ok: false; error: AppError };

type AppError = {
 code: string;
 message: string;
 details?: unknown;
 retriable?: boolean;
};
```

## 5. Agent API

### 5.1 prompt

```ts
type AgentPromptRequest = {
 sessionId: string;
 content: string;
 /** Host-owned collaboration delivery; its ledger supplies content and provenance. */
 sessionMessageId?: string;
 attachments?: AgentPromptAttachment[];
 /** Truncate durable transcript to N leading messages before append (regenerate). */
 truncateBefore?: number;
 /** Renderer snapshot used to close the prompt-to-completion notification race. */
 viewingSessionId?: string | null;
};

type AgentPromptAttachment = {
 path: string;
 name: string;
 kind: "image" | "file";
 mimeType?: string;
 size?: number;
};

type AgentPromptResponse = {
 accepted: boolean;
 turnId: string;
};
```

Slash template expansion (D123): when `content` starts with `/name` and the
name matches a loaded pi prompt template, the main-process handler expands
the invocation (`parseCommandArgs` + `substituteArgs`) before persisting.
The persisted user message stores `content = expanded text` plus an optional
`command: string` field carrying the typed invocation for transcript
display. Reseed replays `content`, so the agent context is identical across
restarts. Builtin/plugin slash aliases never reach this channel — the
renderer executes them locally. Unknown `/foo` passes through as literal
content. Ordinary `@path` tokens are not transformed anywhere in the pipeline
(D124). Composer-owned pasted file references travel separately in
`attachments`; they are validated and prepared by Electron main at dispatch,
so a pasted image does not depend on the model being able to interpret a path
token.

Prompt execution resolves `mode`, `providerId`, `modelId`, and `thinkingLevel`
from the durable session record and snapshots the effective command shell ID and
dialect for Bash.
The renderer changes those values through
`pi-desktop/session/configure` while the session is idle:

```ts
type ThinkingLevel =
  | "off" | "minimal" | "low" | "medium"
  | "high" | "xhigh" | "max";

type SessionConfigureRequest = {
  id: string;
  mode: "plan" | "goal" | "agent";
  providerId?: string;
  modelId?: string;
  thinkingLevel: ThinkingLevel;
};
```

`session/configure` is accepted only while the session is idle. Mode, provider,
model, permission, and shell-default changes are rejected while a turn or a
Plan/Goal `pending`/`queued`/`running` record exists. The renderer may keep these
controls editable during a turn, but it queues the latest full configuration
locally and invokes this channel only after the terminal event; the running
turn never observes that optimistic next-turn choice.

Only a changed effective global `defaultCommandShell` is idle-only across all
affected sessions: any active turn or pending/queued/running Plan/Goal work blocks
that shell change, while an omitted or idempotent shell field does not.

`attachments` is an additive prompt field. The renderer sends metadata and a
source path only; it never sends binary data. Electron main validates the path
against the session scratch/project roots, persists image bytes in the
content-addressed attachment store, and derives the effective model transport
from the published model record plus the exact binding's `supportsImages`
override. An absent or `null` override follows the published image capability;
`true` enables and `false` disables image input for that configured model.
Eligible images become transient pi-ai image blocks when the effective
capability is enabled. Unknown/custom models without an explicit override,
non-vision models, and images above the 10 MB inline bound receive a safe
`@path` fallback.
Main uses streamed hashing and file copying for images above that bound, and the
sidecar uses the same bounded-read rule when rebuilding history. The durable
user message stores `content` plus attachment metadata/ref, never base64.
Invalid attachment paths fail with `PATH_OUTSIDE_WORKSPACE`.

Regenerate history (D109) also uses session channels:

- `pi-desktop/session/saveRevision`
- `pi-desktop/session/listRevisions`
- `pi-desktop/session/activateRevision`

Root user turns may include `revisionRootId`, `revisionCount`, and
`activeRevision`. Activating a revision replaces the live tail with
`prefix + archived branch` and disposes the session agent.
The sidecar receives only the prepared attachment subset needed for the
current turn. On a vision runtime, persisted image refs are hydrated from the
session-bound attachment/scratch roots when history is rebuilt; oversized or
unavailable images remain path fallbacks. This keeps renderer, main, sidecar, the models.dev catalog, and host
persistence on one capability-aware contract.

### 5.1a Steer an active turn

`pi-desktop/agent/steer` accepts `AgentSteerRequest`:

```ts
type AgentSteerRequest = {
 sessionId: string;
 expectedTurnId: string;
 content: string;
 messageId?: string;
 attachments?: AgentPromptAttachment[];
};
```

It returns `{ accepted: true, turnId }` for the existing turn. Main checks its
active durable turn, asks the existing sidecar runtime for the active project's
attachment roots and model image capability, then applies the ordinary bounded
attachment preparation. The sidecar revalidates `expectedTurnId` after that IO.
A missing, ended, stopping, or mismatched turn, or a pending plan/goal approval,
fails with `TURN_NOT_FOUND`; it never falls back to starting or queueing a turn.
An empty payload fails with `INVALID_ARGUMENT`.

The internal `agent.steeringContext` and `agent.steer` methods use only an
existing runtime. They do not run launch configuration, `runtimeFor`, or
`session.beginTurn`. Steering cannot change the active model, permission mode,
workspace, or approved execution. Slash text is literal input on this channel.

Accepted input is echoed as ordinary user message events with the current
`turnId`, main-prepared attachment refs, and `UiMessage.steering: true`. This
persisted marker protects accepted input from Smart Stop after renderer reload.
A native Pi `message_end` may additionally carry the optional additive
`replacesMessageId`: the provisional streaming row id whose durable SDK entry
this event publishes. The renderer re-keys exactly that row (active, cache,
retained) and a generic event without the field leaves every other
row untouched. The field adds no event kind, RACP kind, or storage change.
A user `message_end` can additionally
carry `precedingAssistant`, a streaming snapshot that reserves the reply's
position before the input is persisted. Main writes both through its replayable
outbox; the host replaces only that provisional assistant row with its terminal
snapshot, preserving its id, sequence and owning turn. No image bytes enter the
durable message. This is an additive desktop channel and event field; it does
not change RACP, the host RPC version, or the storage schema. See ADR active-turn-steering.

### 5.2 stop at the next turn boundary

```ts
type AgentStopRequest = {
 sessionId: string;
 turnId?: string;
};

type AgentStopResponse = {
 requested: boolean;
};
```

`pi-desktop/agent/stop` requests a graceful stop for the active runtime. The
sidecar evaluates the one-shot request after the current assistant response and
completed tool batch, at the same boundary where it would otherwise start the
next model request. The current durable turn then emits `agent_end` and is
finalized as `completed`; the request does not abort the provider stream,
cancel running tools, or open a second concurrent turn. An idle session returns
`requested: false`.

The renderer owns the removable, in-memory queued-prompt list per session. It
calls this channel only for a queued item's **Send now** action and releases
that item through the ordinary `agent/prompt` flow after the terminal event.

### 5.3 abort

```ts
type AgentAbortRequest = {
 sessionId: string;
 turnId?: string;
};
```

The abort request and response carry no Composer draft or file-reference data.
If renderer smart Stop undoes an unanswered user turn, restoration comes from
the renderer's session/turn-scoped pre-serialization snapshot; the existing
transcript rewrite removes the sent row without changing protocol version. That
rewrite is computed from the full durable transcript (`session.get` without a
window) merged with the live rows, never from the renderer's paged,
display-capped window, and it is re-evaluated on that merge: a reply row that
landed between the abort and the read turns the undo into a settle (D299). A
Stop that finds a started reply settles it in renderer memory only (streaming
assistant → `aborted`, running tools → error) and performs no transcript
rewrite; the durable copy is the runtime's own aborted final row or, if that
never arrives, the host's promoted in-flight checkpoint.

### 5.4 compact (protocol v10)

```ts
type AgentCompactRequest = { sessionId: string };
type AgentCompactResponse = { accepted: boolean };
```

`pi-desktop/agent/compact` creates a model-context checkpoint for an idle
session. It is available even when automatic context protection is disabled.
Missing provider/session configuration fails through the normal `AppError`
envelope; an active turn or compaction returns `AGENT_BUSY`.

### 5.5 Plan and Goal checkpoint approval

Contract approval is separate from a tool permission. Plan and Goal share this
whole surface; `kind` is the only discriminator (**D198**). The renderer receives
the
host-written artifact metadata from the same Agent and resolves it through
typed preload IPC; it never changes the session mode optimistically. Contract
entry
and submission remain Agent/host operations, not renderer preload methods.

```ts
type PlanningState = "inactive" | "planning" | "awaiting_approval";

type ProposalKind = "plan" | "goal";

type GlobalPermissionMode = "ask" | "accept-edits" | "auto";

type PlanApprovalAction = "approve" | "reject";

type PlanProposalStatus =
  | "pending" | "approved" | "rejected"
  | "expired" | "interrupted";

type PlanExecutionState =
  | "queued" | "running" | "completed" | "interrupted";

// Same shape for SubmitPlan and SubmitGoal; the tool name selects the kind.
type SubmitPlanInput = {
  title: string;
  markdown: string;
  question: string;
};

type PlanArtifact = {
  relativePath: string; // `.pi/plan/<unique-name>.md` or `.pi/goal/<unique-name>.md`
  sha256: string;
  sizeBytes: number;
};

type PlanProposal = {
  id: string;
  sessionId: string;
  turnId: string;
  toolCallId: string;
  // Legacy rows written before the discriminator existed read back as `plan`.
  kind: ProposalKind;
  plan: string;
  markdown: string;
  title: string;
  question: string;
  status: PlanProposalStatus;
  createdAt: string;
  updatedAt: string;
  expiresAt?: string;
  resolvedAt?: string;
  action?: PlanApprovalAction;
  targetPermissionMode?: GlobalPermissionMode;
  errorCode?: string;
  artifact?: PlanArtifact;
  version: number;
  executionId?: string;
  executionState?: PlanExecutionState;
};

type PlanExecution = {
  id: string;
  proposalId: string;
  sessionId: string;
  kind: ProposalKind;
  plan: string;
  title: string;
  question: string;
  artifact: PlanArtifact;
  targetPermissionMode: GlobalPermissionMode;
  state: PlanExecutionState;
};

type PlanningStateEvent = {
  sessionId: string;
  state: PlanningState;
  // Absent only for `inactive` transitions that carry no proposal.
  kind?: ProposalKind;
  proposalId?: string;
  title?: string;
  markdown?: string;
  question?: string;
  artifact?: PlanArtifact;
  version?: number;
  plan?: string;
  action?: PlanApprovalAction;
  targetPermissionMode?: GlobalPermissionMode;
  executionId?: string;
  executionState?: PlanExecutionState;
  proposal?: PlanProposal;
};

type PlansPendingResult = {
  plans: PlanProposal[];
  state?: PlanningState;
  // The contract being negotiated, for mode chip and approval copy.
  kind?: ProposalKind;
};

type PlanResolveIdentity = {
  proposalId: string;
  sessionId: string;
  turnId: string;
  toolCallId: string;
  version?: number;
};

type PlanResolveRequest =
  | (PlanResolveIdentity & {
      action: "approve";
      targetPermissionMode: GlobalPermissionMode;
    })
  | (PlanResolveIdentity & { action: "reject" });

type PlanResolutionResult = {
  ok: boolean;
  proposal: PlanProposal;
  state: PlanningState;
  action?: PlanApprovalAction;
  targetPermissionMode?: GlobalPermissionMode;
  execution?: PlanExecution;
};
```

Preload methods:

- `pi-desktop/plans/pending({ sessionId? }) -> PlansPendingResult`
- `pi-desktop/plans/resolve(PlanResolveRequest) -> PlanResolutionResult`

Electron forwards each host `plans.changed` notification unchanged to the
renderer through the stable shared `IPC.event.plansChanged` channel
(`pi-desktop/plans/event/changed`). This is the Plan/Goal change event surface;
the
renderer does not receive contract approval transitions as AgentEvent variants.
`plans.pending` returns only currently pending approval rows. Terminal
`plan_approvals` rows remain durable Host records, but are not renderer
hydration data; the renderer retains its latest contract snapshot only for the
current renderer lifetime while live `plans.changed` events arrive.

For `approve`, host-core and Electron require an explicit
`targetPermissionMode`; Electron never fills it from stored settings. The
renderer initializes each approval to Ask, which remains the product default,
and the host does not persist the selection as the next approval default.
`reject` carries no permission mode.
Responses with a wrong proposal, session, turn, tool-call, version, or expired
host-owned deadline fail with a stable Plan/Goal approval error. There is no
request-changes action.

### 5.5 getStatus

```ts
type AgentActivityAgent = {
  name: string;
  lastPhase?: "waiting-model" | "thinking" | "tool";
  lastToolName?: string;
};

type AgentActivity =
 | { phase: "starting"; since: number }
 | { phase: "waiting-model"; since: number }
 | { phase: "preparing"; since: number }
 | { phase: "compacting"; since: number;
     reason: "manual" | "threshold" | "overflow" }
 | { phase: "recovering"; since: number }
 | { phase: "retrying"; since: number; attempt: number;
     retryDelayMs?: number; error?: AgentActivityError }
 | { phase: "waiting-subagents"; since: number; subagentCount: number;
     agents?: AgentActivityAgent[] };

type AgentStatus = {
 sessionId: string;
 isRunning: boolean;
 currentTurnId?: string;
 modelId?: string;
 pendingToolConfirmations: number;
 activity?: AgentActivity;
};
```

### 5.6 Turn queue (D375 / D386)

The Host owns the per-session prompt queue; the renderer mirrors it. A
Send-while-running pushes through `pi-desktop/agent/queue/push` and the
headless Agent Host module admits, orders, and drains the durable entries
(`turn_queue`, schema v18). Every change is fanned out as
`pi-desktop/agent/event/queueChanged`.

```ts
type AgentQueuePushRequest = {
  sessionId: string;
  content: string;
  attachments?: AgentPromptAttachment[];
  idempotencyKey?: string;
};

type QueuedTurnSummary = {
  id: string;         // the RACP turn id, stable from admission
  sessionId: string;
  content: string;
  attachments?: AgentPromptAttachment[];
  position: number;   // 1-based queue position
  priority?: number;  // set only for a promoted entry; the click order
  createdAt: string;
};

// pi-desktop/agent/queue/push       -> QueuedTurnSummary
// pi-desktop/agent/queue/list       -> { entries: QueuedTurnSummary[] }
// pi-desktop/agent/queue/remove     -> { ok: true }   (turnId)
// pi-desktop/agent/queue/prioritize -> { ok: true }   (turnId; "send now")
// pi-desktop/agent/queue/reorder    -> { moved: boolean } (turnId, direction)
// pi-desktop/agent/event/queueChanged -> { sessionId, entries }
```

`push` returns `AGENT_BUSY` with `queueFull` once a session holds eight
entries and `IDEMPOTENCY_CONFLICT` when a key is reused with other input.
`entries` arrive in delivery order: promoted entries first in ascending
`priority` (the order they were promoted), then every remaining entry by
`position`. `prioritize` appends an entry to the end of that priority block
without touching the running turn, refuses an entry that already carries a
priority with `CONFLICT`, and refuses a turn that is no longer queued. The
renderer's "send now" then requests a graceful stop so the entry starts at
the next boundary. `reorder` swaps one non-promoted entry with its adjacent
non-promoted neighbour and reports `moved: false` for a promoted entry, a
missing entry, or a block/queue edge; a promoted entry is never a neighbour.
`remove` cancels an entry that has not started. A restored queue stays held
until the desktop attaches as the owner, so a reboot never starts work
unattended.

The promoted block is delivered as adjacent messages rather than as separate
turns: the first promoted entry starts the turn at the boundary and every later
promoted entry is injected into that same turn through the steering channel
(`pi-desktop/agent/steer` with the running turn's id), so the transcript shows
the user rows one after another and the model answers once. An injected entry
leaves the queue and its own turn is canceled because it never runs on its own.
An entry the runtime refuses to accept stays queued and leaves at the next
boundary as its own turn.

The queue's delivery contract is frozen by ADR 0265. A turn's own settlement is
authoritative for the queue: the terminal event can be dropped (a terminal event
naming a turn Main no longer owns never reaches the module) or never emitted, so
the settlement closes the turn inside the module and releases the queue the turn
was holding.

### 5.7 Session collaboration projection

The renderer has one read-only Electron channel for the sidebar hover card:

```ts
// pi-desktop/session/collaboration({ sessionId }) -> SessionCollaborationSummary
type SessionCollaborationSummary = {
  sessionId: string;
  title: string;
  status: "idle" | "waiting_permission" |
    "queued" | "running" | "completed" | "failed" | "cancelled" | "interrupted";
  observedAt: string;
  modelKey?: string;
  providerName?: string;
  modelName?: string;
  createdBySession?: { sessionId: string; title: string; available?: boolean };
  createdSessions?: Array<{ sessionId: string; title: string; available?: boolean }>;
  currentTask?: {
    messageId: string;
    senderSession: { sessionId: string; title: string; available?: boolean };
    text: string;
    status: string;
    turnId?: string;
    createdAt: string;
  };
  result?: { messageId: string; turnId?: string; status: string; text?: string; error?: string };
  recentExchanges: Array<{
    messageId: string;
    direction: "incoming" | "outgoing";
    peer: { sessionId: string; title: string; available?: boolean };
    kind: "task" | "message" | "completion";
    status: string;
    preview: string;
    createdAt: string;
  }>;
};
```

`available` is `false` when the referenced session was deleted or is otherwise
absent; the host then also falls back to the Session ID as the title. The
renderer renders an unavailable reference as text rather than a
keyboard-focusable navigation control, and activating a reference whose session
no longer exists reports a visible error instead of committing an empty
selection. Independently created sessions never receive a fabricated creator
reference. `session_collaboration_messages.source_session_id` intentionally has
no foreign key, so a delivery record survives deletion of its sender; such
references are reported as unavailable rather than removed.

Electron overlays live Agent status on the durable host projection, bounds the
exchange previews, and fetches it only while a session row is hovered or
focused. The renderer cannot invoke the host's mutating
`session.collaboration.*` methods. The plugin's `desktop.control` gateway is
the sole reviewed mutation surface and binds send/cancel authorization to the
active plugin Agent tool invocation.

A hover-card read that does not settle within the card's deadline is abandoned,
its late result is ignored, and the next bounded read is scheduled. While the
card is mounted but not visible (a hidden window, or a window without focus) the
loop keeps polling at a slower idle interval so a later focus change is picked
up. Polling still never overlaps reads and stops on unmount.

## 6. Agent Events

Pushed from main → renderer:

```ts
type AgentEventEnvelope = {
 sessionId: string;
 turnId?: string;
 ts: number;
 event: AgentEvent;
 /** Set on events emitted inside a subagent (D201, ADR 0062): the `Task` call
  * that spawned it, and the definition name. */
 parentToolCallId?: string;
 agentName?: string;
};

type AgentEvent =
 | { type: "agent_start" }
 | { type: "agent_end"; messageIds: string[] }
 | { type: "turn_start" }
 | { type: "turn_end"; subagentUsage?: MessageUsage }
 | { type: "message_start"; message: UiMessage }
 | { type: "message_update"; message: UiMessage;
     deltaText?: string; deltaThinking?: string;
     stream?: "delta"; resetText?: boolean; resetThinking?: boolean }
 | { type: "message_end"; message: UiMessage; replacesMessageId?: string }
 | { type: "tool_start"; toolCallId: string; toolName: string; args: unknown }
 | { type: "tool_update"; toolCallId: string; partialResult?: unknown }
  | { type: "tool_end"; toolCallId: string; result: unknown; isError?: boolean;
      toolUsage?: ToolTokenUsage }
  | ({ type: "planning_state" } & Omit<PlanningStateEvent, "sessionId">)
  | { type: "tool_permission_request"; request: ToolPermissionRequest }
  | { type: "compaction_start";
     reason: "manual" | "threshold" | "overflow" }
 | { type: "compaction_end";
     reason: "manual" | "threshold" | "overflow";
     ok: boolean; tokensBefore?: number; firstKeptMessageId?: string;
     willRetry: boolean; fallback?: "retained_tail";
     mark?: { id: string; throughMessageId: string;
              generation: number; summaryTokens: number;
              summarized: boolean;
              fallback?: "retained_tail" };
     error?: { code: string; message: string } }
 | { type: "error"; error: AppError }
 | { type: "status"; status: AgentStatus };
```

> These are **UI-normalized events**, not a pass-through of raw pi events.
> `packages/agent-runtime` is responsible for mapping pi events to this model.

Append-only `message_update` frames set `stream: \"delta\"` and omit growing
`content` / `thinking` from `message`. Consumers apply `deltaText` /
`deltaThinking` onto the live row (replace instead of append when `resetText`
or `resetThinking` is set). The runtime coalesces those frames on an ~16ms
interval and flushes immediately before tool, terminal, abort, error, and
retry events. `message_start` and `message_end` still carry a full
`UiMessage`. Snapshot replacements omit `stream`. These fields are additive
in protocol v11 (D412).

`status` events include an optional runtime-owned `activity` phase while a turn
is active. `starting` is the prompt handoff; `waiting-model` is the interval
after a provider request is issued and before the first assistant event;
`preparing` is the gap after a tool batch and before the next provider request;
`compacting` is an in-progress context checkpoint (threshold, overflow, or
manual); `recovering` is the silent-turn re-run; `retrying` is an abortable
provider backoff; and `waiting-subagents` is a parent wait on delegated work,
with a live running count and each target's latest coarse child action (waiting
for the model, thinking, or the current tool). The renderer keeps this status
per session and renders it as a compact inline row. The phase is cleared when
assistant or tool activity starts, or when the turn reaches a terminal event.
These phases explain quiet intervals; they do not replace message/tool
lifecycle events or imply a percentage of completion.

`planning_state` is the agent-runtime's local planning projection. Its optional
proposal and execution fields mirror the shared `PlanningStateEvent` shape
(`proposal`, `executionId`, and `executionState`). The full approved execution
descriptor uses `PlanExecution` and is carried by the host result/notification.
The authoritative host approval/queue transition is the separate `plans.changed`
notification forwarded through `IPC.event.plansChanged`.
`tools.output` is a host notification consumed by `packages/agent-runtime`
while a Bash tool runs; it is not an AgentEvent.

`turn_end` closes one model/tool turn but is not a terminal desktop run event:
another provider request may follow immediately. Renderer busy state and
durable turn completion therefore settle only on `agent_end` or `error`.
Compaction is always inline: `compaction_start` keeps the run busy, a manual
operation settles on its matching `compaction_end`, and threshold/overflow
compaction stays inside the active agent run. There is no pre-computed phase to
distinguish (D203).

`compaction_end.mark` is present whenever a checkpoint was installed. It is the
renderer's whole view of that compaction: `id`, the `throughMessageId` anchor the
transcript row sits after, `generation` (how many checkpoints this session has
installed), `summaryTokens` (the summary's estimated context cost), and
`summarized` (`false` when the window rolled over without asking the model for a
summary), and `fallback` (`"retained_tail"` when summary generation failed and
the checkpoint carries only a recovery notice plus a retained tail; the row
labels it as a failed summary, never as a summary of N tokens). The record itself is not carried — its summary and retained tail are
far larger than an event should be — and is instead read from
`SessionDetail.compactions` on session open or fork.

Automatic summary failures may still produce a successful lifecycle event with
`fallback: "retained_tail"`; this means a durable, aggressively bounded tail
checkpoint was installed and the run may continue with reduced historical
context. Manual compaction never silently falls back.

Provider `error` events may include bounded diagnostic fields in
`AppError.details`: `phase` (`request` or `stream`), `providerStatus`,
`providerCode`, `providerWaitMs`, `streamMs`, `retryAttempt`, and, for a
network failure, `networkCategory`, `networkCode`, `networkSyscall`,
`networkHost` and `networkRoute` plus the request correlation fields
`requestMessages`,
`requestBytes` and `compactionGeneration`. These fields are additive and
redacted; they never carry credentials or an unrestricted provider response,
and the request fields are counts and byte sizes only. A transient stream
failure may be replayed once inside the
same turn without a terminal `error` event or a duplicate assistant message.
The second failure emits the terminal normalized `STREAM_FAILED` error.

## 6a. Notification API (D117, protocol v4)

Durable inbox requests are allowlisted preload invokes that Electron forwards
to the singular host RPC domain without renderer access to SQLite:

- `pi-desktop/notification/list({ unreadOnly?, limit? })`
- `pi-desktop/notification/markRead({ id })`
- `pi-desktop/notification/markAllRead()`
- `pi-desktop/notification/clear()`

The renderer invokes
`pi-desktop/notification/setViewingSession({ sessionId })` whenever the chat
page's active session changes; `sessionId: null` clears the viewing context on
non-chat pages. A renderer-originated `agent/prompt` also carries a matching
`viewingSessionId` snapshot, which Electron installs before asynchronous turn
setup so a fast completion cannot beat the viewing-context update. Electron
Main also supplies its current viewing-session ID when dispatching local
desktop prompts through Agent Host, including queued follow-ups after abort.
Remote principals receive null; queued prompts do not retain stale view hints.
Electron
combines this hint with Main-owned window visibility/focus at the terminal event
boundary. Missing, null, or mismatched context fails safe to notification. It
also invokes
`pi-desktop/notification/showNative({ id, sessionId, kind, title, body })` after
localizing a new record, where `kind` is `"task" | "interactive"`. This
Electron-only request never crosses into the host RPC domain.

```ts
type AppNotification = {
  id: string;
  kind: "task.completed" | "task.failed";
  sessionId: string;
  sessionTitle: string;
  turnId: string;
  errorCode?: string;
  createdAt: string;
  readAt?: string | null;
};

type NotificationListResult = {
  notifications: AppNotification[];
  unreadCount: number;
};

type NotificationChangedEvent = {
  notification: AppNotification;
};

type NotificationActivatedEvent = {
  id: string;
  sessionId: string;
};

type SessionsChangedEvent = {
  reason: "plugin.session.import" | "plugin.session.importBatch" |
    "plugin.session.rename" | "plugin.session.delete";
  pluginId: string;
};
```

Main sends two events:

- `pi-desktop/notification/event/changed` after `session.endTurn` returns a
  newly inserted record. Renderer merges the record into its bounded local list
  and recalculates the exact unread count. A terminal result already visible in
  the focused current chat, repeated terminal updates, and aborted turns emit
  nothing.
- `pi-desktop/notification/event/activated` after the user clicks Electron's
  native system notification. Renderer follows its existing session-selection
  path, including project activation for a project-bound session.

Plugin-owned session mutations additionally emit
`pi-desktop/session/event/changed` after a successful write. The renderer
handles this host-owned event by calling its existing `refreshSessions()` path;
plugins never send a sidebar event and a skipped import does not emit one.

Calls to the renderer store's `refreshSessions()` action have at most one
session-list request in flight per store instance. Calls arriving while that
request is running share one follow-up request; their promises resolve
after that later response is committed, rather than accepting the older read.
Further calls during the follow-up form the next batch. Each batch commits
once, and a failed batch does not prevent a queued or later refresh. An import
refresh retains its own pre-refresh session baseline and project-reveal intent,
even if an earlier ordinary refresh already observed the imported rows.
Ordinary refreshes do not gain import-reveal behavior or change the current
session, project, or page. Bursts from parallel plugin workers therefore remain
current without issuing overlapping full-list reads within this refresh path.
Bootstrap and provider-refresh snapshots remain independent reads.

Electron owns the native surface while the renderer derives localized
title/body text from the structured record. Electron accepts `showNative` only
for a valid notification/session pair. For `kind: "task"`, it shows a native
notification only while the main window is unfocused; for `kind: "interactive"`,
it preserves the exact-visible-session suppression while allowing a focused
background session to alert. In both cases the platform API is best-effort,
and a shown notification restores/shows and focuses the window before emitting
`activated`. No permission, scheduled-reminder, or plugin source enters the
task notification contract. Native delivery is best-effort; the durable
inbox remains authoritative when the OS suppresses a banner. On Windows,
Electron Main registers `net.aiuo.pi-desktop` as the process AppUserModelID
before readiness and before any window is created. The ID matches the NSIS
package identity so notification attribution, notification settings, taskbar
grouping, and installed shortcuts resolve to `PI-Desktop`, never the stock
Electron host.

The viewing-session hint is advisory and fail-safe: missing, stale, hidden, or
unfocused renderer state creates the durable notification. Suppression occurs
only when the main window is visible and focused and the reported chat session
matches the finishing session. Window creation, renderer reload, and renderer
process loss clear the hint before any later terminal event is evaluated.

## 7. Session API

```ts
type SessionSummary = {
 id: string;
 title: string;
 messageCount: number;
 projectPath?: string;
 modelId?: string;
 providerId?: string;
  mode: "plan" | "goal" | "agent";
 thinkingLevel: ThinkingLevel;
 supportsReasoning?: boolean;
 supportedThinkingLevels?: ThinkingLevel[];
 updatedAt: string;
 createdAt: string;
};

type SessionMessageOrigin = {
 messageId: string;
 sourceSessionId: string;
 sourceTitle: string;
 targetSessionId: string;
 kind: "task" | "message" | "completion";
 replyToMessageId?: string;
};

type UiMessage = {
 id: string;
 role: "user" | "assistant" | "system" | "tool";
 content: string;
 /** Host-authenticated session collaboration origin; absent for human input. */
 sessionMessage?: SessionMessageOrigin;
 thinking?: string; // assistant reasoning, never folded into content
 usage?: MessageUsage; // provider-reported assistant usage
 responseDurationMs?: number; // model stream duration for throughput
 responseOutputTokens?: number; // estimated partial output when stop has no final usage
 toolName?: string;
 toolCallId?: string;
 toolArgs?: unknown;
 toolResult?: unknown;
 toolUsage?: ToolTokenUsage; // estimated tool call/result footprint
 error?: AppError;  // structured failure owned by this assistant turn
 createdAt: string;
 // Rows produced inside a subagent (D201, ADR 0062); absent on the session's own
 parentToolCallId?: string;   // `Task` call that spawned the delegate
 agentName?: string;          // delegate definition name
 // status/tool fields omitted here
};

type ToolTokenUsage = {
 argumentTokens: number;
 resultTokens: number;
 totalTokens: number;
 estimated: true;
};

type SessionDetail = SessionSummary & {
  messages: UiMessage[];
  /** Zero-based start offset when the renderer received a bounded page. */
  messageStart?: number;
  /** True when an older page can be requested with session.get. */
  hasMoreBefore?: boolean;
};
```

`messageCount` is the host-authoritative count of messages in the current
canonical transcript. The renderer uses it to distinguish an empty durable
session from a session whose title still looks untitled; title text is not a
session-state signal.

Electron main enriches session list/get/create/fork/configure results with
effective reasoning capability from the local models.dev record for that
session's exact provider/API URL and model. Sessions without a pinned
`providerId`/`modelId` inherit the app default provider/model for this
enrichment only; the durable ids remain unset so later default-model changes
still apply. An ID absent from the snapshot, or a session with no resolvable
default, gets `supportsReasoning: false` and `off`; cached/provider claims do
not replace catalog semantics. The Rust host remains authoritative only for the
durable `thinkingLevel`.

The global plugin launcher uses Electron-only allowlisted channels:

- `pi-desktop/pluginLauncher/toggle` shows or hides the centered utility window
- `pi-desktop/pluginLauncher/dismiss` hides it only when invoked by that window
- `pi-desktop/pluginLauncher/event/shown` resets its query, reloads installed
  plugins, and restores input focus after every invocation

The launcher reuses `plugin/list` and `plugin/openPanel`; it adds no host-core
plugin RPC. The Electron main process also calls the additive host method
`keyboard.setGlobalShortcut({ binding })` to enable the Windows-only fallback
for the reserved `Alt+Space` binding. Host-core emits the notification
`keyboard.shortcut({ binding: "Alt+Space" })` when its low-level Windows
keyboard hook detects the chord; the hook consumes that chord so the active
window system menu does not open. Non-Windows hosts treat the method as a
no-op. `responseDurationMs` and `responseOutputTokens` are optional transcript
  metadata persisted in message metadata, so protocol v11 and storage schema v16
remain unchanged.

The Settings font picker (ADR 0083) reads installed system font families
through one Electron-only allowlisted channel:

- `pi-desktop/app/systemFonts` returns `string[]` of installed system font
  family names (platform tooling in Electron main — `system_profiler` on
  macOS as the fallback only, with `osascript` JXA bridging the fast CoreText
  query `CTFontManagerCopyAvailableFontFamilyNames` as the primary path,
  PowerShell on Windows, `fc-list` on Linux), deduplicated, sorted, with
  hidden `.`-prefixed families excluded. The main process caches the result
  for 60 seconds; failures resolve to `[]`. The host RPC and protocol version
  are unchanged.

Minimal interface:

- `session/list`
- `session/create`
- `session/open(sessionId)` — validate and select an existing durable session
  through the reviewed desktop-control path; it does not create or mutate the
  session
- `session/fork({ sessionId, title?, throughMessageId? }) -> { session: SessionDetail }`
- `session/get({ id, messageBefore?, messageAround?, messageLimit?, contentLimit? })` — without
  read-window options returns the complete UI projection; with them returns a
  bounded newest/older page plus `messageStart` and `hasMoreBefore`. The
  content limit applies only to display values and never changes the lossless
  transcript or model context. `messageBefore` and `messageStart` are physical
  message-line positions in the transcript file, not deduplicated index counts.
  `messageAround` centers a bounded read on a stable message ID; it requires
  `messageLimit` and cannot accompany `messageBefore`. A missing target returns
  no session. Only the selected user/assistant text bypasses the display cap.
  Bounded responses also include exclusive `messageEnd` and `hasMoreAfter` for
  forward paging; reading windows never replace the live transcript cache.
  A nested target may also return `navigationParent`, the latest capped owning
  Task `UiMessage`. It is display context outside the physical page, not an
  extra history line. The renderer shares one reading view between ordinary
  paging, search navigation, and subagent details.
- `session/search({ query, offset? }) -> SessionSearchPage` forwards to
  `search.sessions`; host-core owns discovery, counts, filtering, and pagination.
- `session/searchContext(SessionSearchContextRequest) -> SessionSearchContext`
  forwards to `search.context`. This read-only text window is separate from
  `session/get` and must never enter the renderer's live transcript cache.
  Both channels are explicitly included in the preload IPC allowlist.
- `session/delete`
- `session/rename({ id, title }) -> { ok: boolean }` trims the title and
  accepts 1–80 Unicode code points. Blank or overlong titles are rejected as
  `INVALID_PARAMS`; a successful rename changes only session metadata and does
  not alter transcript content, message count, or activity timestamps.
- `session/summarizeTitle({ sessionId, userPrompt, assistantReply? }) ->
  { title }` validates the session and prompt in Electron main, resolves that
  session's provider/model, and runs one `thinkingLevel: "off"` one-shot
  completion. It never writes the title itself; the renderer applies the
  result through `session/rename` only while the session still has a default or
  first-prompt fallback title. A one-shot failure leaves that fallback intact.
- `session/getScratchPath({ sessionId }) -> { path }` returns the session
  scratch directory `<data_dir>/scratch/<sessionId>/` without creating it.
- `session/openScratchPath({ sessionId }) -> { ok, path }` resolves that same
  directory, creates it if missing, and opens it in the system file manager.
  The renderer supplies only the session id; Main rejects a path outside the
  scratch root.
- `session/importScan`
- `session/importRun(candidates) -> { imported, skipped, failed }`
- `modelConfig/importScan -> { providers }`
- `modelConfig/importRun(candidates) -> { imported, skipped, failed }`

Import candidates carry `projectPath: string | null` and
`messageCount: number | null`. A scan reads each source file fully up to the
importer's sampled-scan threshold; larger files are sampled (head + tail) so
scanning a multi-gigabyte archive stays interactive, and their `messageCount`
is null — the import list renders an em dash for it, while imported sessions
always compute their real message count at convert time. Scan titles come
from the first real user message: known synthetic injections (repo
instructions, the IDE-context family such as `# Context from my IDE setup:`
or `# Browser comments:`) are skipped, while pasted markdown starting with
`#` is kept. A corrupt or out-of-range stored timestamp falls back to the
source file's mtime, never to the import moment. A successful import
refreshes both sessions and the durable Projects index.

`modelConfig/importScan` reads Claude Code, Codex, OpenCode, Pi, and CC
Switch config files from the user home directory and returns public provider drafts
(`source`, `externalId`, `name`, `baseUrl`, `apiStyle`, `modelIds`,
`hasSecret`). Secrets stay in the main-process scan cache and are written
through `providers.create` on `modelConfig/importRun`. Re-importing a
matching endpoint, API style, and credential is skipped; a different
credential at the same endpoint remains independent. OAuth tokens from those
tools are never copied. No host protocol or storage schema version bump.

A regenerate or edit-resend truncates the durable transcript before appending
its new user turn. `agent/prompt` accepts `truncateFromMessageId` — the identity
of the first message to drop — and forwards it to host-owned
`session.truncateFrom`, which resolves that identity against its own
transcript; an unresolvable id is rejected with `NOT_FOUND` rather than cutting
at a guessed position. The kept prefix never crosses the JSON-RPC pipe
(ADR 0216 / issue #211). The older `truncateBefore` count remains accepted, but it
is only correct when the caller holds the entire history: a renderer showing a
bounded window addresses different messages than the transcript does.
`agent/prompt` itself loads only a bounded `session.get` for launch
configuration.


`session/fork` is a protocol-v5 channel that creates an independent
session from the source session's current active transcript. When optional
`throughMessageId` is present, the copied snapshot ends at that message; an
unknown id returns `NOT_FOUND`. Electron rejects
the request with `AGENT_BUSY` while that source session has an active turn.
Electron owns localization and supplies the user-facing branch title; the host
fallback title is reserved for non-UI callers.
The host assigns a new session id, message ids, and tool-call ids; it copies
the durable project/provider/model/mode/thinking/permission configuration but
does not copy turns, notifications, artifacts, scratch data, permission
grants, or regenerate revisions. The source session remains unchanged.
Message-scoped assistant Fork/Edit uses this option so the child receives a
new session id and therefore cannot reuse or mutate the source pi runtime or
its provider cache.

Protocol version 9 adds the checkpoint Plan contract: `SubmitPlan`, unique
`.pi/plan/*.md` artifact metadata, approve/reject-only responses, absolute
expiry, `plan_approvals` execution fields, shell catalog/identity fields, and
streamed stdout/stderr events. A v7 or older host, and any incompatible v8
peer, must fail the handshake so a desktop cannot display Plan while silently
losing the artifact, queue, shell, or policy boundary.
`pi-desktop/agent/compact` and `session.appendCompaction` remain part of the v9
contract. The Goal contract is additive inside v9 (**D198**): `kind` is optional
on the wire and absent means `plan`, so a peer that predates Goal keeps working
and simply never negotiates one.

Protocol version 2 adds `thinkingLevel`, `UiMessage.thinking`, and
`message_update.deltaThinking`. A v1 peer must fail the version check instead
of silently discarding these fields.

`UiMessage.error` is an optional additive field. Provider failures attach the
same normalized `AppError` carried by the lifecycle `error` event to the
assistant message before `message_end`. Error messages persist with the
transcript but are excluded from restored model context.

The context inspector consumes two additive usage signals. `MessageUsage` is
the provider-reported assistant usage and `responseDurationMs` is the elapsed
sidecar stream time used to display output tokens per second. `ToolTokenUsage`
is a runtime estimate from the tool call arguments and result; providers do not
report per-tool allocation, so the renderer labels these rows as estimates and
never merges them into the exact provider total. Older peers may omit all of
these optional fields without breaking the v6 handshake.

`turn_end.subagentUsage` is the settled subagent total since the previous
emitted `turn_end` of the same durable turn. Parent `message.usage` stays the
provider-reported assistant usage (D103). Electron sums parent-message usages
plus `subagentUsage` into `session.endTurn.usage`.

### stats

- `pi-desktop/stats/getTokenUsageHistory({ startDate?, endDate?, bucket? }) -> TokenUsageHistoryResult`

`bucket` is `day` | `week` | `month`. Omitted dates use the host default window
(53 weeks / 52 weeks / 24 months) in the host's local calendar. `week` keys use
ISO week year (`%G-W%V`). The result fills empty buckets in range. This channel
is not a Settings page; the user-facing dashboard is plugin `pi.token-insights`
(D335 / ADR 0173).

## 8. Settings / Secrets API

### settings
Non-sensitive config that can be returned to the UI:

- provider list (without secret plaintext)
- default model
- persisted `defaultCommandShell` from the host shell catalog
- persisted `largePasteThreshold` for oversized text-only composer pastes;
  host reads missing values as 600 and accepts integers from 1 through 1,000,000
- permission policy toggles
- UI preferences, including optional `AppSettings.keybindings` overrides keyed
  by the shared shortcut action ids; values are either `null` or portable
  `Mod+Shift+Key` strings and contain no platform-specific native accelerator
  strings. A missing entry uses the platform default, while `null` is an
  explicit disabled/Unbound state
- optional `AppSettings.developerMode`; absent and `false` both keep developer
  tools disabled
- optional `AppSettings.networkProxy` (`system` / `direct` / `custom` plus a
  proxy URL and bypass list). Absent means System. Custom accepts `http`,
  `https`, `socks5`, and `socks5h` URLs, including userinfo. Main applies
  Chromium `session.setProxy` (credentialed URLs through a loopback SOCKS5
  relay; issue #490) and Node env immediately; the agent sidecar is
  reconfigured without a process restart. `pi-desktop/network/testProxy`
  runs one bounded Chromium fetch through the supplied config and does not
  persist it.

`settings.set` accepts a partial settings object. Host-core merges supplied
fields into the stored app settings, so omitted fields, including
`defaultCommandShell`, are preserved. Only an incoming shell field is shell
validated; the idle Plan/configuration gate runs only when its effective shell
would change. Unrelated writes and idempotent writes of the current effective
shell remain accepted while work is active. Legacy
`planApprovalPermissionMode` is ignored and stripped from current reads and
writes; it is not exposed or recreated.

### shell

```ts
type CommandShellId =
  | "windows-powershell"
  | "windows-pwsh"
  | "cmd"
  | "git-bash"
  | "bash";

type CommandShellOption = {
  id: CommandShellId;
  label: string;
  dialect: "powershell" | "cmd" | "posix";
  available: boolean;
  isDefault: boolean;
};

type CommandShellCatalog = {
  configuredId: CommandShellId | null;
  effective: CommandShellOption | null;
  fallback: boolean;
  choices: CommandShellOption[];
};
```

Preload methods:

- `pi-desktop/commandShell/list() -> CommandShellCatalog`
- `pi-desktop/settings/set({ defaultCommandShell }) -> { ok: true }`

Settings shell writes accept only an available ID for the current platform and
reject unknown, unavailable, or wrong-platform IDs. A genuine effective shell
change is accepted only while all sessions and Plan/Goal work are idle. If a
persisted ID later becomes unavailable, the catalog selects the first available
platform shell and sets `fallback: true`; if no choice is available, Bash
returns `SHELL_NOT_FOUND`.
Each turn pins the effective ID and dialect. The runtime transports both values;
host rejects a changed pin before permission evaluation and before spawn with
`COMMAND_SHELL_CHANGED`.

### secrets
- `secrets/set(providerId, apiKey)`
- `secrets/delete(providerId)`
- `secrets/has(providerId) -> boolean`

Forbidden:
- Writing the full API key into ordinary logs
- Holding API key plaintext long-term in the renderer

### vendor accounts (OAuth, D237/D240)

Signing in with a vendor subscription is an Electron-main conversation, so it
uses IPC only — the host protocol version is unchanged. Five invoke channels
plus one event channel:

- `pi-desktop/providers/oauth/vendors() -> { vendors: OAuthVendor[] }`
- `pi-desktop/providers/oauth/start({ vendorId }) -> { loginId }`
- `pi-desktop/providers/oauth/respond({ loginId, promptId, value? })` — an
  absent `value` cancels that prompt, which aborts the flow
- `pi-desktop/providers/oauth/cancel({ loginId }) -> { ok: boolean }`
- `pi-desktop/providers/oauth/delete({ providerId }) -> { ok: true }` deletes
  one OAuth account's provider row and its scoped credential
- `pi-desktop/providers/oauth/event` streams `OAuthLoginEvent`

```ts
type OAuthLoginEvent = { loginId: string; vendorId: string } & (
  | { kind: "info"; message: string; links?: Array<{ url: string; label?: string }> }
  | { kind: "authUrl"; url: string; instructions?: string; opened: boolean }
  | { kind: "deviceCode"; userCode: string; verificationUri: string;
      intervalSeconds?: number; expiresInSeconds?: number }
  | { kind: "progress"; message: string }
  | { kind: "prompt"; request: OAuthPromptRequest }
  | { kind: "promptCancelled"; promptId: string }
  | { kind: "done"; providerId: string; accountLabel?: string }
  | { kind: "error"; message: string }
  | { kind: "cancelled" }
);
```

A flow may raise its first event before `start` has replied — OpenAI Codex
asks browser-or-device-code in the same tick the login begins — so the renderer
must subscribe to the event channel *before* it invokes `start`, hold what
arrives while `loginId` is unknown, and release the matching events in order
once the reply lands. Subscribing after the reply drops that first prompt and
the flow waits forever on a question nobody was shown.

`start` must also be called exactly once per attempt, from a user action rather
than from a React effect — StrictMode runs an effect twice on mount, and a
second attempt opens a second browser and contends for the same local callback
port. The renderer's session object keeps every event it has delivered and
replays it to a later subscriber, so a dialog may mount, unmount and mount
again without restarting anything. Main defends the same invariant from its
side: a `start` for a vendor whose attempt is still in flight cancels that
attempt and waits for it to unwind before beginning the next one.

Every flow shape — browser callback, device code, a pasted code, a vendor
choice — travels this one stream, so the renderer renders what arrived instead
of branching per vendor. `opened: false` means the browser could not be
launched and the user must copy the link. `promptCancelled` means the flow
answered a question itself (a callback that beat the paste box), so the input
must disappear on its own.

Forbidden here as well: no event carries a token, a refresh token, or an
authorization code. `accountLabel` is a display string.

## 9. Project API

- `project/open()`: system directory picker
- `project/pickFolders()`: multi-select directory picker used by the
  renderer-owned Create project dialog; returns selected absolute paths without
  changing the active workspace
- `project/clone({ url })`: pick a parent directory, `git clone` the URL into
  it, and return the cloned workspace (the renderer then activates it)
- `project/cloneCheckout({ url, parentPath })`: `git clone` a public remote
  into an explicit parent folder and return `{ path, name }` without changing
  the active workspace; the Create project dialog uses it before it creates the
  logical project group
- `project/openFolder(path)`: open a known project directory in the system file
  manager
- `project/get()`: current workspace
- `project/list()`: durable project records, including import-created entries
- `project/memory/get(path)`: read the host-owned memory for a canonical project
  path
- `project/memory/save(path, entries)`: replace that project's durable memory
  entries; the host derives a readable `content` value, caps it at 32 KiB, and
  uses it as context in the next session launch. Legacy callers may still save
  plain `content`.
- `project/set(path)`: set workspace
- `project/clear()`

Returns:

```ts
type ProjectWorkspace = {
 path: string;
 name: string;
};

type ProjectRecord = {
 id: number;
 path: string;
 name: string;
 pinned: boolean;
 createdAt: number;
 lastOpenedAt: number;
};

type ProjectMemory = {
 content: string;
 entries?: ProjectMemoryEntry[];
 updatedAt?: number;
};

type ProjectMemoryEntry = {
 id: string;
 title: string;
 content: string;
};
```

## 10. Tool Permission API

When a tool requires confirmation:

1. main sends `tool_permission_request`
2. UI shows a confirmation card
3. UI calls `tool/resolvePermission`

```ts
type ToolPermissionRequest = {
 requestId: string;
 sessionId: string;
 toolCallId: string;
 toolName: string;
 argsPreview: unknown;
 risk: "low" | "medium" | "high";
 reason: string;
 /** Definition name when a subagent asked (D201, ADR 0062); absent for the
  * session's own calls, together with the `Task` call that spawned it. */
 agentName?: string;
 parentToolCallId?: string;
};

type ToolPermissionResolution = {
 requestId: string;
 decision: "allow-once" | "allow-session" | "deny";
};
```

A session can hold more than one open request once it runs parallel subagents.
The renderer queues them per session and answers the oldest first; the resolution
contract is unchanged, because it was already keyed by `requestId`
(`04-ux/03-permission-ux.md` §6a).

Plan does not replace this generic permission contract. A Plan `Bash` call
uses the normal session-scoped permission flow: `ask` and `accept-edits` emit a
tool permission request, while `auto` executes without confirmation. Plan
approval is a separate state transition and always uses the `plan` methods
above.

## 11. Version Compatibility

- IPC/host contract version field: `protocolVersion: 11`
- Breaking changes must bump the version and record an ADR
- renderer and main validate the version at startup; on mismatch, prompt to upgrade/reinstall
- Protocol v4 adds notification records, channels, and the
  notification-bearing `session.endTurn` result. A v3 peer is rejected rather
  than silently losing durable completion/failure events.
- The optional viewing-session invoke and `createNotification` end-turn field
  are additive v4 behavior. Older callers omit the field and retain the
  fail-safe default of creating notifications.
- Protocol v5 adds the required `session/fork` snapshot operation. A v4 peer is
  rejected before chat becomes interactive instead of exposing a branch
  command that can only fail at invocation time (ADR 0023).
- Protocol v6 added durable context checkpoints plus the manual/lifecycle
  channels. A v5 peer is rejected because silently omitting a checkpoint can
  make the next provider request unsafe (ADR 0030).
- Protocol v9 supersedes the earlier v7 Plan contract. It adds `SubmitPlan`,
  exact unique artifact metadata, approve/reject-only resolution, 30-minute
  absolute expiry, `plan_approvals` execution states, shell selection and
  pinned ID/dialect, and streamed command output. A v7/v8 peer is rejected
  before the UI becomes interactive because it cannot enforce or represent this
  boundary (ADR 0053/0054). `SubmitGoal` and the optional `kind` discriminator
  ride along inside v9 and need no version bump, because an absent `kind` is
  exactly the pre-Goal behavior.

## 12. Plugin API (host UI side)

Minimal interface:

- `plugin/list`
- `plugin/loadDev(path)`
- `plugin/reload(id)` — reload a registered development plugin from its stored
  path and refresh its permission ceiling
- `plugin/installFromPath(path)`
- `plugin/enable(id)`
- `plugin/disable(id)`
- `plugin/uninstall(id)`
- `plugin/getPermissions(id)`
- `plugin/setPermission(id, permission, allowed)` (optional fine-grained)
- `plugin/setScope(id, scope)` (D192)

Returned summary:

```ts
type PluginSummary = {
 id: string
 name: string
 version: string
 enabled: boolean
 source: "installed" | "dev"
 status: "ready" | "error" | "disabled"
 errorMessage?: string
 permissions: string[]
 scope?: ActivationScope
}
```

## 12a. User MCP server API (D193)

User-owned MCP configuration is stored as one JSON file per id under
`~/.agents/servers/<id>.json` or `<project>/.agents/servers/<id>.json`.
Enablement is not written to those files; host-core stores it in the
application-local `<data>/agent-capabilities/mcp.json` state file.

- `mcp.list({ level, projectPath? })` → `{ servers: McpServerRecord[]; statuses: McpServerStatus[] }`
- `mcp.active({ projectPath? })` → the effective runtime list
- `mcp.upsert(server)` — creates or replaces the file at the requested level
- `mcp.remove({ id, level, projectPath? })`
- `mcp.setEnabled({ id, enabled, level, projectPath? })`
- `mcp.setScope` remains a compatibility-shaped call; the Settings page uses
  the explicit capability level and local state instead

A project-level request without `projectPath` is invalid. `mcp.active` removes
project records from the global set by id or case-insensitive label before it
filters disabled records, so a disabled project record still shadows a global
one. The desktop-only `mcp/test` IPC action forces one connection test and
returns its status to the MCP editor.

```ts
type McpServerStatus = {
 serverId: string
 state: "idle" | "connecting" | "ready" | "failed"
 toolCount: number
 toolNames?: string[]
 message?: string
 updatedAt: number
}
```

Tools reach the agent as `mcp_<serverId>_<toolName>`, disjoint from the plugin
bridge's `plugin_` namespace (D015).

## 12b. User skill API (D194)

User skills are Markdown documents scanned from `~/.agents/skills` and
`<project>/.agents/skills`. Both direct Markdown files and the conventional
`<skill>/SKILL.md` shape are accepted. Enablement is stored in
`<data>/agent-capabilities/skills.json`, never in the document. Catalog ids
are ASCII slugs: the frontmatter `name` when it slugifies, otherwise the
skill directory name for `SKILL.md` (not a staging folder such as
`Downloads`), otherwise a stable `skill-<hash>` so a non-ASCII title is still
listed. Folded YAML `description: >` / `|` blocks flatten into the catalog
one-liner.

- `skills.list({ level, projectPath? })` → `{ skills: UserSkillRecord[] }`
- `skills.active({ projectPath? })` → the effective runtime list
- `skills.create(skill)`
- `skills.import({ path, level, projectPath? })` — one source file is physically
  copied into the selected `.agents/skills` directory
- `skills.update({ id, ...skill })`
- `skills.read({ id, level?, projectPath? })` → `{ skill, body }`
- `skills.remove({ id, level?, projectPath? })`
- `skills.setEnabled({ id, enabled, level, projectPath? })`

The list contains frontmatter-derived `name` and `description`, not the body.
Only the description enters the prompt, and the body is fetched when the model
invokes `Skill` (D174). A missing file is removed from the list and its local
state is pruned during the next scan.

Desktop-only skill market channels (not host RPC) live on Electron IPC:

- `pi-desktop/skill/market/search` — `{ query, sources[] }` →
  `{ entries, failedSources, failureKinds, failureDetails }`. Main aggregates
  builtin-safe catalog JSON and GitHub repo SKILL.md scans. Source URLs must pass
  the public-HTTPS policy (ADR 0243). One failing source is dropped; the rest
  still return. `failureKinds` maps each name in `failedSources` to `policy`
  (the guard judged the target's own non-public address and refused it),
  `fake-ip` (it judged a fake-IP placeholder the local proxy invented for the
  name — Clash's `198.18.0.0/15`; still refused on a direct or unreadable route,
  where the guard fails closed and this app would dial that address itself, but a
  condition of the local network rather than a fact about the source),
  `unresolved` (the local DNS lookup returned no answer, so no address was
  judged), or `network`.
  `failureDetails` carries the same keys with the host that actually failed, the
  address it resolved to, the guard's own `reason`, that address's class, and the
  route the guard judged it on (`proxied`, `direct`, or `unknown` when the
  transport reported no readable route, ADR 0272), which is what lets the panel
  name *what* was refused — "your proxy answered github.com with 198.18.0.1" —
  instead of only which source went quiet. A judged refusal and a fake-IP refusal
  both surface as `NETWORK_POLICY_BLOCKED` (both are refusals the guard decided),
  and an unanswered resolver as `NETWORK_RESOLVE_FAILED` (spec 08 §3.1); the
  install sheet classifies a failed preview on those codes together with the
  structured `reason`.
- `pi-desktop/skill/market/fetch` — `{ entry }` → `{ name?, description?, body, resources? }`.
  Main fetches the document over the same policy, splits frontmatter, and may
  attach sibling `.md` files from a jsDelivr listing. The renderer installs
  through existing `skills.create`. That policy is the main-process
  public-network client: syntactic URL guard, DNS classification, per-hop
  redirect revalidation, and bounded responses — the renderer never reaches
  the network directly. Catalog ids are sanitized to host
  `valid_capability_id` (`[a-z0-9][a-z0-9-]{0,63}`).

Desktop-only MCP market channels (not host RPC) live on Electron IPC:

- `pi-desktop/mcp/market/search` — `{ query?, sources[], more? }` →
  `{ entries, failedSources, exhausted }`. Main validates source URLs, pins
  each resolved public address, follows only bounded HTTPS redirects, and keeps
  cursor state for browse and server-side search. One failed source does not
  discard successful sources; the response and caches are bounded.

## 12c. Subagent API (D202)

User-owned subagents are global-only Markdown documents under
`~/.agents/subagents/<id>.md`. There is no project-level subagent directory.
Enablement is stored in `<data>/agent-capabilities/subagents.json` and is never
written into the Markdown file.

- `agents.list` → `{ subagents: UserSubagentRecord[] }`
- `agents.active` → enabled global documents
- `agents.create(subagent)` — duplicate names fail with `SUBAGENT_INVALID`
- `agents.update(id, subagent)`
- `agents.read(id)` → `{ subagent, body }`
- `agents.remove(id)`
- `agents.setEnabled(id, enabled)`
- `agents.disabledBuiltins` → `{ disabled: string[] }`
- `agents.setBuiltinEnabled(id, enabled)` → `{ id, enabled }`

The `thinkingLevel` field accepted by `agents.create` and `agents.update` may
be a canonical thinking level, `omit`, or the empty string. The empty string
clears the override; `omit` is persisted as `thinkingLevel: omit` and tells the
runtime not to send a provider thinking override.

The `model` field accepted by `agents.create` and `agents.update` must be a
`<provider>/<model>` pin. The empty string clears the pin; a value with no
provider half is rejected with `SUBAGENT_INVALID` instead of being stored,
because no resolver could ever look it up. The provider half is matched by a
normalized alias at both ends of the app, so a display name containing spaces
is valid.

The `tools` array may include the token `inherit` (ADR 0246). `inherit` alone
is a valid grant; host-core must not drop the document. Settings round-trips
the token as `tools: inherit` or `tools: [inherit, Bash]`.

`agents.disabledBuiltins` and `agents.setBuiltinEnabled` carry activation for the
shipped builtins, which have no document to switch (ADR 0270). Handles are stored
at the global level in `<data>/agent-capabilities/subagent-builtins.json`, a file
of its own: the user-document scan prunes state for ids it cannot see, and a
builtin is never scanned, so a shared file would drop every builtin exclusion on
the next scan. `agents.setBuiltinEnabled` normalizes the id the way a document
name is normalized and rejects an empty one with `SUBAGENT_INVALID`; a handle no
current builtin uses is stored inertly rather than refused, because host-core
does not ship the builtin list.

Electron's `subagent/list` IPC channel exposes the same global-only list to
Settings > Agent > Subagents. `subagent/catalog` returns the effective Task
catalog — enabled user documents merged with the five shipped builtins, minus the
builtins the user switched off — together with `builtins`: every shipped
definition that still wins its handle, each carrying `enabled`, so the page can
render a switched-off default as a row with its own switch. The runtime catalog
combines the same sources and applies the same exclusions; it does not scan
`.pi/agents` or any project capability directory.

## 12d. Capability level and local activation

Skills and MCP management calls use:

```ts
type AgentCapabilityQuery = {
 level: "global" | "project"
 projectPath?: string
}
```

Global records default to enabled and may have a per-project override. Project
records have state for their owning project. The host prunes state for deleted
files while scanning; deleting a global file removes all of its project
overrides. These records are independent from plugin `ActivationScope`.

## 13. Command Palette API

- `commandPalette/search(query)`
- `commandPalette/execute(commandId)`

Command sources:
- Built-in commands
- Plugin contributes.commands

## 13a. Work Panel APIs

Work panel channels are Electron-main implementations. User-driven workspace
operations resolve the visible root from `workspace.get` and fail closed
without one. Agent-driven BrowserPreview routing resolves the originating
conversation through `session.get`, so a background preview never inherits the
visible session's workspace.

### workspace

- `workspace/diff()` → `WorkspaceDiff { repo, clean, files: DiffFile[], truncated? }`.
  This legacy diagnostics channel may inspect the current working tree, but it
  is not the Review source of truth. The Review UI reads message-owned review
  records from transcript tool results instead, so a commit cannot erase a
  recorded change.
- `workspace/review/rollback({sessionId, snapshotId})` →
  `ReviewRollbackResult`. The host verifies the current post-tool hash before
  restoring the snapshot; it returns `rolledBack`, `alreadyRolledBack`,
  `conflict`, or `unavailable` and never overwrites a conflicting later edit.

### browser (D100, D333)

Chrome and agent CDP live in bundled plugin `pi.browser` over `pi.browser.*`.
Renderer IPC kept for the Plan-safe preview facade and URL fallback:

- `browser/openExternal({url?})` — allowlisted http(s)/mailto, or the current
  guest URL when omitted
- event: `browser/event/state {url, title, isLoading, canGoBack, canGoForward}`
  (also pushed to plugin views as `browser:state`)
- agent preview event: `browser/event/preview {sessionId, path?, url?}`.
  Electron Main validates a workspace `path` inside that session's project,
  loads the guest when that conversation's plugin view is visible, and the
  renderer opens `plugin:pi.browser/browser` with `location` in the matching
  runtime panel context. Navigation of a background session does not steal the
  visible guest.

### fs (read-only)

- `fs/list({path})` → entries sorted dirs-first; ignores `.git`,
  `node_modules`, and the default ignore subset of
  [15-workspace-ignore-rules](15-workspace-ignore-rules.md)
- `fs/read({path, mimeType?})` → text (≤512KB) / image data URL (≤5MB) /
  PDF data URL (≤256 MiB) / binary / tooLarge. PDF detection accepts `.pdf`
  paths or `application/pdf` MIME metadata, including extensionless blobs.
  Binary and oversized files return no content bytes.
  Relative paths resolve inside the workspace root;
  `attachments/<sha256>` blobs and absolute paths already inside the
  workspace, `<data_dir>/scratch/`, or `<data_dir>/attachments/` are also
  accepted after a realpath check (D334 / ADR 0172), as is an absolute path in
  another folder of the same project group (ADR 0249 §5, ADR 0263). A known
  image extension wins over `mimeType`; extension-less blobs accept only the
  image MIME allowlist. Traversal, `~`, and other escapes are rejected
  (`INVALID_ARGUMENT`).
- `fs/readImageDataUrl({ref, mimeType?})` → `FsImageDataUrlResult`
  (`image` with `dataUrl`, or `missing` / `notImage` / `tooLarge`). Same
  containment as `fs/read`. Never returns non-image bytes. Renderer-only;
  not a plugin host API.
- `fs/reveal({path})` → reveal in Finder. Same containment as `fs/read`.
- `fs/open({path})` → open with the OS default application. Same lexical
  containment as `fs/read` (without the extra realpath step used by reads).
- `fs/resolveRef({ref, sessionId?})` → `FsChatRefResolveResult`
  (`{ match: FsChatRefMatch | null }`, the match naming the answering `root`
  (`workspace` / `scratch` / `attachments`), the `relativePath` relative to that
  root, the absolute `absolutePath`, `matchedBy` (`exact-relative` /
  `exact-absolute` / `path-suffix` / `basename`), and — for a `workspace` match
  — `projectRoot` (`{ path, name, primary }`), which names the project folder
  that answered); `sessionId` selects the
  session whose scratch store is searched. Completes a file reference the agent
  printed in chat, because the renderer cannot see the session's own scratch
  store: an absolute reference that already names a real file inside a known
  root wins outright, and an `attachments/<sha256>` blob resolves against the
  attachment store directly; otherwise the roots are searched in priority order
  — the open project first, the session's own scratch store
  (`<data_dir>/scratch/<sessionId>/`, ADR 0124) second, the attachment store
  last — and the first root that answers wins. The project is the folder group
  behind the open workspace (ADR 0249): its primary folder answers before its
  other folders, which are then searched in the group's own order (ADR 0263),
  so a shorthand resolves in a sibling folder as readily as in the primary one,
  and the match names the folder that answered. Inside one root an exact path
  beats a shorthand; among shorthands the longest matching tail wins, then the
  shallowest path. The files-panel ignore set applies. A reference that matches
  nothing returns `match: null`; resolving never opens anything (ADR 0262).
- `fs/list` stays workspace-only; traversal outside is rejected
  (`INVALID_ARGUMENT`).

### Built-in WiseOffice editor

- `deckwise/ppt-editor/open({path, mimeType?})` accepts supported Office formats
  within the workspace or the existing file-reader extra roots
  and resolves with `PptEditorState` only after `document:ready` and the
  matching `document:opened` response. It rejects on startup errors, close
  cancellation, or a 60-second handshake deadline.
- `deckwise/ppt-editor/event/state` reports `opening`, `ready`, `saving`,
  `saved`, `error`, or `closed`, with optional `path`, revision metadata, and
  `message`. `canRetry?: boolean` is true for failed startup after the native
  view has been released. Calling Open again creates a fresh view for the
  existing revision; only a successfully opened same-file view is reused.
- `readOnly?: boolean` disables saving for PDF and files outside the primary
  workspace. `savedPath?: string` reports the written file. Legacy DOC/XLS/PPT
  saves create a new OOXML sibling; source-format saves replace the source.
- Save requires a ready, editable editor. Visibility requests during opening retain
  intent but attach native editor content only after the open acknowledgement.

## 13b. Desktop Menu and Window APIs

The preload exposes a synchronous, read-only `platform: NodeJS.Platform`
value so the renderer chooses native macOS chrome or menu-free Windows/Linux
frameless chrome before first paint.

Main-to-renderer application commands use one allowlisted event:

```ts
type AppMenuCommand =
  | "newTask" | "openProject" | "openSettings"
  | "openCommandPalette" | "toggleSidebar"
  | "openHelp" | "openLogs" | "checkForUpdates";

event: menu/event/command { command: AppMenuCommand }

menu/rendererReady() -> { ready: true }
```

The renderer subscribes to `menu/event/command` before invoking
`menu/rendererReady`. Main waits for that acknowledgement when a native menu
command creates or reloads a window, so startup timing cannot drop the first
command.

Renderer-owned Windows/Linux keyboard shortcuts execute zoom and fullscreen
operations through `menu/nativeAction`. The retained compatibility surface
also supports editing and window operations. Its request is restricted to the
exported `NATIVE_MENU_ACTIONS` tuple; unknown values fail rather than becoming
a generic main-process command surface:

```ts
type NativeMenuAction =
  | "undo" | "redo" | "cut" | "copy" | "paste" | "selectAll"
  | "reload" | "zoomIn" | "zoomOut" | "resetZoom"
  | "toggleFullScreen" | "minimize" | "toggleMaximize" | "close"
  | "restoreMainWindow" | "toggleMainWindow";

menu/nativeAction({ action: NativeMenuAction })
  -> { maximized: boolean; fullScreen: boolean }
```

Developer tools use a dedicated Main-owned gate rather than a generic native
menu action:

```ts
devtools/toggle({ open?: boolean }) -> { open: boolean }
```

Main rejects the request while `AppSettings.developerMode` is not `true` or no
live window exists. The same stored flag gates F12 on all platforms,
Ctrl+Shift+I on Windows/Linux, and the macOS View-menu role. Disabling the flag
closes an already-open developer-tools window.

`window/control` accepts the exported `WINDOW_CONTROL_ACTIONS` tuple:

```ts
type WindowControlAction =
  | "getState" | "minimize" | "toggleMaximize" | "close";

window/control({ action: WindowControlAction })
  -> { maximized: boolean }
```

On Windows/Linux, `minimize` performs the native OS minimize transition so
the window remains represented in the taskbar and can be restored there. A
Windows/Linux close still follows the persisted close-behavior choice below;
it is the close path, not minimize, that can hide the window to the tray.
macOS keeps its native Dock/tray minimize behavior.

Windows/Linux close behavior (D230, ADR 0090) is read and written through
two additive Main-owned channels. `closeBehavior/get` returns the persisted
preference and whether the platform supports it (macOS keeps the native
Dock lifecycle and reports `supported: false`); `closeBehavior/set`
accepts a settable `CloseBehavior` (`tray` or `quit`) and persists it:

```ts
type CloseBehavior = "ask" | "tray" | "quit";

window/closeBehavior/get -> { behavior: CloseBehavior; supported: boolean }
window/closeBehavior/set({ behavior: "tray" | "quit" })
  -> { behavior: "tray" | "quit" }
```

`ask` is the transient unset state reported by `get`; it is never settable
— the first close prompts once, and once a choice exists it can be switched
but not reverted to prompting. `ask` and unknown values fail with
`INVALID_ARGUMENT` rather than being coerced, and `set` fails the same way on
macOS, where there is no close behavior to configure. Setting a behavior does
not touch the tray icon: D216 (ADR 0078) creates one at startup on every
platform, and minimize-to-tray needs it whichever close behavior is stored.

Maximize/unmaximize changes also emit
`window/event/maximized`. Unknown actions fail. These Electron-only channels
do not cross into host-core and do not change the host RPC protocol version.
The preload intentionally exposes no arbitrary BrowserWindow resize channel.
Plugin panel chrome uses a separate Electron-local
`pi-plugin-panel-window-control` channel with the same four semantic actions,
but the handler resolves the target strictly from the sender's live panel
window. The preload consumes this channel internally for its closed-Shadow-DOM
titlebar; it is not added to `window.pluginBridge` or the shared host protocol.
The work-panel geometry seam is retained for Electron compatibility, but the
panel is renderer-owned and never changes native window bounds (ADR 0151):

```ts
window/setWorkPanelReservation({ width: 0 | number })
  -> { requested: number; reserved: number }
```

`width` must be a finite integer JSON number equal to `0` or inside the
inclusive `244..720` range. Strings, booleans, null, fractional values, and
other malformed payloads fail with `INVALID_ARGUMENT` rather than being
coerced. The internal dock normalizes every valid request to zero and returns
`{ requested: 0, reserved: 0 }`; positive values are accepted only as a
backwards-compatible no-op. Repeating a request never changes native bounds.

The legacy chat-width/event shapes remain Electron-local compatibility surfaces,
but the visible internal dock does not call them or use them to resize the
window:

```ts
window/setWorkPanelChatWidth({ width: number })
  -> { requested: number; applied: number }

window/event/workPanelResize
  -> { phase: "preview" | "commit"; panelWidth: number }
```

`window/setWorkPanelChatWidth` and `window/event/workPanelResize` remain
available only to older Electron callers. The current renderer divider changes
the persisted `244..720px` panel width locally, and native window edges resize
the fixed application window without changing that panel target. The native
Browser view continues to follow the renderer-measured panel rectangle.
Window bounds persistence and display reconciliation therefore operate on the
ordinary application bounds; there is no panel-specific width or x-offset
reservation, and background artifacts cannot change visible window geometry.

## 13c. Composer input APIs (D123/D124/D197, ADR 0024/0059)

Electron-only channels backing composer autocomplete and file references.
`composer/commands` and `fs/index` are read-only and fail soft;
`composer/pickFiles` opens the unified native picker used by the Composer and
returns a one-shot token; the legacy `composer/pickPhotos` channel remains
available for compatibility but is not exposed by the Composer UI.
`composer/importFiles` and `composer/pasteFiles` write only to the originating
session's Electron-owned scratch directory. None adds a host RPC method or
changes the host protocol version. Renderer-supplied absolute source paths are
never accepted by the picker import channel (ADR 0181).

### composer/commands

```ts
composer/commands() -> { commands: ComposerCommand[] }

type ComposerCommand = {
  /** Slash name typed after "/", unique across the merged list. */
  name: string;
  kind: "template" | "builtin" | "plugin";
  title: string;            // display title (templates: name)
  description?: string;     // template frontmatter / palette title
  argumentHint?: string;    // template frontmatter `argument-hint`
  source?: "project" | "user"; // template provenance
  id?: string;              // builtin/plugin palette id for execution
};
```

Templates load from `<workspace>/.pi/prompts/*.md` and
`~/.pi/agent/prompts/*.md` (project wins name conflicts; short TTL cache).
Without a workspace only user-global templates, builtins, and plugin
commands return.

### fs/index

```ts
fs/index() -> { entries: FsIndexEntry[]; truncated: boolean }

type FsIndexEntry = { path: string; kind: "file" | "dir" };
```

Workspace-rooted relative paths for the `@` menu: `git ls-files -co
--exclude-standard` fast path, ignore-set recursive walk fallback,
directories derived from file paths, 8000-entry cap with `truncated: true`,
short TTL cache per root. Fails closed to an empty list without a
workspace. Fuzzy filtering happens renderer-side.

### composer/pickFiles and composer/pickPhotos

```ts
composer/pickFiles() -> { token: string | null; canceled: boolean }
composer/pickPhotos() -> { token: string | null; canceled: boolean }
```

Both dialogs run in Electron main. The Composer uses `pickFiles` as its single
file/image entry point: it accepts regular files without a type filter, and the
importer classifies each result as an image or file from MIME/extension metadata.
`pickPhotos` is retained as a compatibility channel for older renderer clients.
Directories are not part of the MVP picker contract. When the user selects
files, main stores the native paths against a token bound to the invoking
`WebContents`, with a 60-second lifetime and one-shot consumption. The
renderer receives the token but never receives the selected absolute paths.

### composer/importFiles

```ts
composer/importFiles({ sessionId, token }) -> {
  files: ComposerPastedFile[];
}
```

Electron main consumes the sender-bound picker token, resolves each recorded
path through `realpath`, requires an existing regular file, applies the same
20-file / 64 MiB per file / 128 MiB total limits as clipboard transfer, and
copies the bytes into `<data_dir>/scratch/<sessionId>/pasted/` under a
UUID-backed sanitized name. The token is deleted before import starts, so it
cannot be replayed. The returned `ComposerPastedFile` records are the only
paths the renderer stores or dispatches, so a picker selection cannot leave an
external source path in the prompt or bypass the attachment-root boundary.

### composer/pasteFiles

```ts
composer/pasteFiles({ sessionId, files }) -> {
  files: ComposerPastedFile[];
}

type ComposerPasteFile = {
  name?: string;
  mimeType?: string;
  /** Set for generated large-text pastes so host-owned clipboard history can retain the text. */
  recordHistory?: boolean;
  data: ArrayBuffer;
};

type ComposerPastedFile = {
  path: string;     // UUID-backed absolute storage path
  name: string;     // sanitized original leaf display name
  kind: "image" | "file";
  mimeType: string;
  size: number;
};
```

Electron main verifies that `sessionId` resolves to a durable host session,
limits the request to 20 files, 64 MiB per file, and 128 MiB total, strips
renderer-provided directory components, and writes unique names below
`<data_dir>/scratch/<sessionId>/pasted/` with exclusive-create semantics. The
renderer holds returned paths and kind metadata in transient reference state,
displays `name`, and submits them through `AgentPromptRequest.attachments`.
Main persists image bytes by SHA-256 and adds a path fallback only when the
selected model cannot receive that image as a visual block. Clipboard bytes
never enter the persisted prompt or host agent message as base64.
Invalid sessions and malformed/oversized payloads fail with an IPC error, and
the operation cannot write to the workspace.

### clipboard/recordPaste

```ts
clipboard/recordPaste({ text }) -> { ok: true }
```

This renderer-to-main channel is accepted only from the main application window
and records text already supplied by that window's user-initiated Composer paste
event. It never reads the OS clipboard. Empty text is ignored by the bounded
history store.

### prompt/enhance

```ts
prompt/enhance({
  sessionId?: string | null;
  draft: string;
  providerId?: string;
  modelId?: string;
  thinkingLevel?: ThinkingLevel;
}) -> { enhancedDraft: string }
```

This is an independent, one-shot completion with no session history, tools, or
attachments. Electron main resolves the provider/model and credentials, so the
renderer never receives a secret. Empty drafts, slash-command drafts, missing
models, and provider failures return the common `Result` error envelope.

### speech/getStatus, speech/transcribe, speech/synthesize

```ts
speech/getStatus() -> SpeechStatus
speech/transcribe({ sessionId?, path, mimeType?, language? }) -> { text }
speech/synthesize({ sessionId?, text, voice?, format? }) -> { path, mimeType, dataUrl? }
```

Host speech is independent of chat. Bindings live on `AppSettings.speech`.
Audio bytes never enter the renderer. See spec `20-speech.md`.

### app/openFeedback (D313)

```ts
app/openFeedback() -> { ok: true }
```

Electron Main builds a fixed GitHub bug-form URL
(`https://github.com/vastsa/PI-Desktop/issues/new?template=bug_report.yml`)
and opens it with `shell.openExternal`. Query fields `app-version`, `os`, and
`environment` are filled from Main-owned version info. The renderer cannot
supply a URL. Construction that leaves that origin or template is rejected.
This channel does not cross into host-core and does not change the host RPC
protocol version.

## 13d. Local MCP control API (D370)

PI-Desktop can expose a local automation surface for an external Agent without
changing the renderer preload contract or host RPC protocol. The server is
disabled by default and starts only when the Electron process receives:

```text
PI_DESKTOP_MCP_CONTROL=1
PI_DESKTOP_MCP_PORT=37123       # optional; defaults to 37123
```

Electron Main binds `127.0.0.1` only and serves Streamable HTTP MCP at
`/mcp`. The selected port may be `0` in tests to request an ephemeral port;
normal desktop configuration uses the default or an explicit local port. The
server uses MCP protocol version `2025-06-18` and supports `initialize`,
`notifications/initialized`, `ping`, `tools/list`, `tools/call`,
`resources/list`, and `logging/setLevel`. `initialize` negotiates `2025-06-18`
or the compatible `2025-03-26` value and never echoes an unsupported client
version. Listen is asserted to be loopback after bind. It accepts the standard
POST transport; GET is handled with 405 because this server does not offer an
SSE stream. Clients poll `pi_session_get` or `pi_agent_status` for turn
progress.

### Connection and authentication

The server creates a 256-bit random bearer token on first use and stores it in
the Electron user-data directory as `mcp-control.token`. It writes the current
connection record to `mcp-control.json`:

```json
{
  "active": true,
  "serverName": "pi-desktop",
  "protocol": "streamable-http",
  "url": "http://127.0.0.1:37123/mcp",
  "token": "<redacted>",
  "pid": 12345,
  "startedAt": "2026-09-09T00:00:00.000Z"
}
```

Both files are written with mode `0600` where the platform supports POSIX
permissions. Every request must include `Authorization: Bearer <token>` (the
`X-Pi-Desktop-Token` header is retained for simple local clients). Requests to
other paths, requests without the token, and methods other than
POST/DELETE/OPTIONS are rejected. The server is stopped before Electron waits
for host shutdown and the manifest is marked inactive.

When an `Origin` header is present, its hostname must be `localhost`,
`127.0.0.1`, or `::1`; absent Origin is allowed for non-browser MCP clients.
After initialization, requests must carry the issued `Mcp-Session-Id` and may
carry `MCP-Protocol-Version` `2025-06-18` or the compatible `2025-03-26` value.
Unknown session ids and unsupported protocol versions are rejected at the HTTP
boundary.

### Tools

The named tools cover the common Agent workflow:

- `pi_app_info`
- `pi_project_get`, `pi_project_list`, `pi_project_open`, `pi_project_clear`
- `pi_session_list`, `pi_session_create`, `pi_session_get`,
  `pi_session_rename`, `pi_session_fork`, `pi_session_delete`,
  `pi_session_configure`
- `pi_agent_prompt`, `pi_agent_status`, `pi_agent_stop`, `pi_agent_abort`,
  `pi_agent_compact`
- `pi_plans_pending`, `pi_plans_resolve`
- `pi_workspace_diff`, `pi_fs_list`, `pi_fs_read`

`pi_control_describe` returns the reviewed operation catalog. `pi_desktop_invoke`
accepts an operation id and positional IPC arguments:

```json
{
  "operation": "project/set",
  "args": ["/path/to/project"]
}
```

Only main-process channels registered in the reviewed catalog are available.
The first-version catalog is the project/session/Agent/workspace flow plus
reviewed reads. Secret get/set/delete channels, provider/OAuth/MCP secret-write
paths, settings writes, plugin/marketplace install, window/OS control, and
renderer-only native picker/dialog channels (including `plugin/loadDev`) are
not exposed. Secret-shaped argument fields are stripped before IPC dispatch.
Each catalog entry is tagged `read`, `write`, or `dangerous`; dangerous
generic operations and the named session-delete, session-configure, and
plan-resolution tools require `confirm: true`. That flag is an agent
acknowledgement, not a desktop user prompt. All calls still pass through the
existing IPC handler validation, host permissions, workspace boundaries, and
error model. Both the text payload and `structuredContent` are size-bounded.

The six `session/collaboration/*` operations are first-party-plugin-only: they
require an authenticated plugin tool invocation context, so they appear in
`pi.desktop.listOperations` and are callable through `pi.desktop.invoke`, but
they are excluded from the MCP-visible catalog (`tools/list`,
`pi_control_describe`, and the `pi_desktop_invoke` operation enum) and an MCP
caller cannot invoke them.

After successful **mutating** external calls, Electron Main may emit the existing
`pi-desktop/session/event/changed` event with additive fields:

```ts
{
  reason?: string;
  projectPath?: string | null;
  selectSessionId?: string;
}
```

The renderer refreshes sessions and applies project/session selection from that
event, so an external Agent can create a session, open a project, or submit a
prompt while the visible desktop follows the same state. A control-server
startup failure is logged and does not prevent the desktop from launching.

## 14. Error Codes — Initial registry (extensible)

| code | Meaning |
|---|---|
| `AGENT_BUSY` | The current session already has a running turn |
| `AGENT_NOT_FOUND` | Session does not exist |
| `MODEL_NOT_CONFIGURED` | No available model |
| `PROVIDER_SECRET_MISSING` | Missing API key |
| `TOOL_DENIED` | Permission denied |
| `TOOL_TIMEOUT` | Tool timed out |
| `WORKSPACE_REQUIRED` | Project directory required |
| `PATH_OUTSIDE_WORKSPACE` | Path out of bounds before an explicit outside-path permission decision |
| `INTERNAL` | Uncategorized internal error |

## Native Pi session routing (ADR 0254)

`pi-desktop/session/list` returns both Desktop and native summaries. Each summary
may carry `source: "desktop" | "pi-native"`, capability flags, and a stable
`readOnlyReason`; clients normalize omitted source to `desktop` for backward
compatibility. `session/get`, `session/open`, `session/fork`, `agent/prompt`,
`agent/stop`, and `agent/abort` route opaque `native-pi:` ids to the Node
sidecar. Native file paths never enter renderer payloads.

Native rename/delete/move/revision/configuration/scratch/Plan/Goal/queue/
collaboration operations return an explicit unsupported/invalid-argument error.
`session/fork` for a native id returns `{ session: SessionDetail }` for one new
child JSONL and never mutates the parent; an anchor id that is not a message on
the active branch is `INVALID_ARGUMENT`. The fork response carries the child's
whole projected transcript (`messageStart: 0`, `hasMoreBefore: false`) at full
fork parity, independent of general detail paging. Forking reuses the same
source ownership state list/detail report: an owned idle runtime keeps its
lease, while a live/remote/malformed foreign lease rejects with
`NATIVE_PI_SESSION_BUSY` and a changed owned source with
`NATIVE_PI_SESSION_CHANGED`. Unexpected filesystem failures surface as a
path-free `NATIVE_PI_FORK_IO_ERROR`.
Native continuation refusal codes include `NATIVE_PI_SESSION_BUSY`,
`NATIVE_PI_SESSION_CHANGED`, `NATIVE_PI_PROVIDER_UNAVAILABLE`, and
`NATIVE_PI_PROJECT_UNTRUSTED` plus format/newline/cwd-specific codes.

Native compact and queue push/list reject with `NATIVE_PI_UNSUPPORTED` before
Desktop host/queue access. Queue remove/prioritize continue to take an opaque
host `turnId`, not a session id: native paths never create host queue entries.
Supporting a native queue later requires an explicit source/session contract;
a turn-id prefix is not source authentication.

Native events include `user_message_persisted` with `optimisticMessageId` and a
projected durable `message`. The renderer replaces that submission identity in
live/cache/retained state before normal completion refresh. Identical-text
submissions remain distinct; SDK entry IDs are never rewritten. Desktop event
semantics are unchanged. Native terminal completion follows SDK settlement,
not intermediate retry/compaction loop ends. Native abort never invokes
`replaceSessionMessages` and reloads durable detail after abort returns.

## PPTX editor command bridge (W01.1–W01.2)

`deckwise/ppt-editor/getContext` and `deckwise/ppt-editor/execute` are
main-window-only invoke channels, carried by the existing preload allowlist and
the existing editor host. They are not registered as Chat tools yet. Shared
contracts and runtime validators live in `packages/shared/src/ppt-editor-bridge.ts`.

Opening a PPTX creates `{ projectId, documentId, sessionId }`. Here `projectId`
is an opaque hash of the active workspace root, not a platform project UUID;
`documentId` is the existing path-derived editor job identity; `sessionId` is
new on every open. These are local routing guards, not team authorization or
persisted page/object identities. Legacy Office opens remain supported without
enabling this PPTX bridge.

`getContext` returns that binding, `editGeneration`, one-based `page`, bounded
`selectedText`, `selectionCharacters`, `readOnly`, and `capabilities`. Generation
identifies an in-memory native target snapshot, not a saved PPTX revision. The
snapshot checks the editor/frame, page, selected objects/text, native history
and user interaction. A later context capture advances generation when the
target changed or the previous command consumed the snapshot. Requests before
the native API is ready fail explicitly; `document:opened` alone does not mean
that command tools are ready.

`execute` accepts exactly the binding plus `{ requestId, editGeneration, tool,
input }`. The allowlist reuses three existing native tools:

- `get_presentation_text`: optional integer `maxChars` in 1–8000; bounded text,
  truncation and slide counts. It reads the presentation, not only the current page.
- `replace_selection`: nonempty `text` of at most 8000 UTF-16 code units; replaces
  the current supported native text selection. Whitespace is preserved.
- `add_slide_text`: nonblank `text` of at most 8000 UTF-16 code units; inserts a
  native text box on the current page.

Write capabilities require a tracked writable native target; replacement also
requires selected text. There is no model, arbitrary JavaScript, OOXML rewrite
or direct file write in this bridge. The response includes a matching `tool`
discriminator. Read results include text and counts; verified replacement
returns `{ replaced: true, length, verified: true }`; verified insertion returns
`{ page, verified: true }`. A write is successful only with `status: 'verified'`
and a current continuation target after the executor's own native readback.
The reader's existing `sent` status is not proof of a mutation.

Responses must match sender, type, request ID, binding and generation. The host
also checks iframe origin/source. Workspace switches, closed/reopened sessions,
stale targets, duplicate request IDs and unsupported commands are rejected.
An executed snapshot is consumed; obtain fresh context and a new request ID for
the next command. Requests are serialized at the editor, capped at 4096 IDs per
session and cancelled on close, host failure or a 30-second timeout. Failures do
not automatically replay a command or clear an unrelated save operation.
Timeout/close ends the host wait, not necessarily already dispatched native
execution. An editor-side binding reset aborts the active action, using the
existing native executor's cancellation/rollback checks. Callers must inspect
an uncertain result before retrying; native history rollback is not a host-level
transaction or a guarantee that every timed-out write has been undone.

`scripts/e2e-courseware.mjs --case W01.2` exercises this bridge in the complete
desktop shell, including visible read/edit/readback and basic save/reopen.
Save races are exercised by `--case W01.3` below. Main Chat tool
registration and model intent planning are not implemented by this bridge.


### Host-confirmed editor saves (W01.3)

The desktop sends `document:save` with a unique envelope ID and
`requireHostCommit: true`. `document:saved` means export only. The editor host
preserves that ID through Blob conversion. Main accepts bytes only from the
current host webContents and the active export ID, once. Native bridge commands
and opening/closing another document are blocked while a save is pending.
Manual native edits remain available.

Main validates bytes, archives a revision, and writes the source through a
same-directory temporary file. Source hashes are checked before archiving and
again before replacement; an external change produces an error without
intentionally overwriting that file. This is not an OS-level cross-process
compare-and-swap or a power-loss durability guarantee. Reopening imports the
actual source when its hash differs from the latest archive, rather than
silently opening an archive left by a failed write.

After persistence Main sends `document:commit-save` using the same save ID and
`{ success: boolean }`. The editor only acknowledges an exported pending save.
It clears dirty only on success and an unchanged native history object, index,
head and head-item snapshot. If the disk now holds a different snapshot from
the live editor, the old SDK saved mark is invalidated (including undo races).
The response is `document:save-committed` with `{ success, dirty }` and the same
ID. Only a matching successful clean response yields desktop status `saved`.
Success with newer live edits yields `ready` with `dirty: true`; a later manual
edit also changes `saved` to dirty `ready`.

`PptEditorState` adds optional `dirty` and `canSave`. A write failure preserves
dirty and exposes toolbar retry after its failure acknowledgement. A revision
may exist even when source replacement failed; it is a recovery artifact,
not proof that the source was saved. Failed export or missing confirmation
blocks blind retry until reopen/inspection because SDK save streams have no
request ID. Export timeout is 210 seconds; acknowledgement timeout is 15 seconds.
Neither timeout cancels a filesystem operation or a dispatched native action.
Older, duplicate and wrong-sender responses never complete a new save.

Both editor and desktop must support this protocol; older editors cannot confirm
it and time out rather than claiming a clean save. Other embed callers retain
legacy export behaviour unless they opt into `requireHostCommit`.
Unsaved-close prompts, application-quit recovery, crashes, complex presentation
fidelity and concurrent editing by external processes remain separate acceptance
items; normal close remains an explicit discard of unsaved live edits.

### Saved-source teaching IPC

`pptEditorTeachingDraftGet({viewId})` and
`pptEditorTeachingDraftSet({viewId, expectedRevision, draft})` return
`{draft: CoursewareTeachingDraft | null}` through the normal envelope.
Set content is null for explicit discard, otherwise exactly
`{actions, instruction}`; Main supplies the authoritative baseline and Host
identities. Both methods require the main-window sender and active owning Chat.
Retained bounded view tokens allow a pending local draft to finish storing its
original page after native navigation; they never authorize a teaching write.
All extra fields/arguments reject. Host revision CAS and same-baseline checks,
recovery behavior and limits are specified in the courseware contract below.

Main-window-only invokes: `pptEditorTeachingOpen({sessionId})`,
`pptEditorTeachingWrite({viewId, expectedTeachingRevision, actions})`, and
`pptEditorTeachingLock({viewId, expectedTeachingRevision, locked})`, and
`pptEditorTeachingConfirm({viewId, expectedTeachingRevision, resolution?})`. The
optional resolution is exactly `{changeGroupId, receiptSha256, note}` from the
explicit existing-sidebar review, with a nonempty note of at most 500 UTF-16
units; it creates no additional IPC channel. Main pins the current clean saved
page and verifies the exact displayed unresolved receipt. See
[Chat disposition](23-courseware-native-chat.md#explicit-human-disposition-and-fixed-publication-barrier).
Responses
are `CoursewareTeachingView` through the normal IPC envelope. Preload uses the
existing generated IPC whitelist; no generic Host proxy is exposed. Extra
arguments/keys, caller-selected source or page identity are rejected. See
[courseware contract](22-courseware-contract-v1.md#saved-source-editor-integration).

Confirmation is explicit per-page review in the existing panel; Main supplies
the pinned current page. It preserves actions and locks, advances the teaching
revision, and never creates audio or publishes. Private immutable snapshot APIs
are not renderer IPC. See [fixed snapshots](26-courseware-fixed-snapshots.md).

`pptEditorTeachingReview({sessionId})` prepares an explicit review of the current
clean saved PPTX. It returns `{reviewId, project, pageCount, targetSha256}` with
the previous canonical project and a Main-local opaque token. The user chooses
one old-page index or `null` per new page. `pptEditorTeachingAdopt({reviewId,
bindings})` validates those choices against Main's pinned review, reparses the
current saved source and calls Host CAS adoption. It returns the new
`CoursewareTeachingView`. Both channels are main-window-only, reject extra
arguments/fields and are absent from the external Agent dispatch map. Source
and native context, current Chat and Host are rechecked. See the contract's
explicit saved-source review section for supported actions and limits.

When supported highlight/spotlight cues exist, the review additionally contains
`targetPages?: {objects:{index:number,kind:string}[]}[]` and
`effectTargets?: {pageId:string,objectId:string,kind:string,index:number}[]`.
The former is the current saved parser order (one-based object index); the
latter contains only old Host identities actually referenced by supported cues.
`pptEditorTeachingAdopt` optionally adds `effectBindings` with
`{pageIndex:number,objectId:string,targetIndex:number}` entries. Page indices are
zero-based new-page order, target indices one-based current parser order.
Main pins and validates the complete review and the exact explicit associations;
Host derives fresh UUIDs from its actual parser identity in the adoption
transaction. Every referenced target must be mapped exactly once on its bound
page, without merging distinct old objects, omitting cue-bearing pages or
accepting unknown target kinds. Choices start empty and require explicit review.
No model tool gains association authority, and unsupported cue kinds still
reject intact. Omitting optional fields preserves existing cue-free callers.


Courseware narration review adds main-window-only finite
`deckwise/ppt-editor/narration/review` and `/decide` channels. Parameters/results
and freshness/ownership requirements are defined in
[24-courseware-narration-candidates](24-courseware-narration-candidates.md).
They expose review of known persisted IDs, not arbitrary Host RPC or generation.


PPTX candidate review adds main-window-only
`deckwise/ppt-editor/pptx-candidate/review` (`{sessionId,candidateId}`), `/preview`
and `/reject` (`{reviewId}`). A15 adds `/adopt` (`{reviewId,effectBindings?}`), with a separate
explicit replacement confirmation in the review UI. All reject extra fields and
are absent from external Agent dispatch. Main retains authority over source,
archive and workspace; `/adopt` resolves to the normal IPC success envelope after
controlled Office reopening. See [25](25-courseware-source-candidates.md#desktop-reviewed-adoption-and-recovery-a15).

For cue-bearing rebuilt pages, review adds optional `effectTargets` (old page and
object identity, page index, kind and old display index), `effectPages` (candidate
parser object indexes/kinds), and `effectCues` (page, effect type and retained
start/end milliseconds). `/adopt` accepts at most 20,000 strict
`{pageIndex,objectId,targetIndex}` choices. Main validates complete distinct
same-page eligible targets against its retained review and rechecks fresh Host
inventory before preparing a source intent. Renderer cannot supply canonical
replacement IDs, source hashes, paths, actions or timing. Missing choices block
adoption; cue-free requests retain the old behavior. No new channel or Agent tool.

A17 adds main-window-only `deckwise/courseware/fixed/{build,approve,play,cancel}`
for persisted immutable snapshot selection, exact retained warning approval and
Main-owned player launch/cancellation. No paths, generic Host calls or snapshot
capture are exposed. The dedicated sandboxed player has a separate private
`deckwise-fixed-player:read` channel authenticated to its exact top frame and
selected build. See [fixed snapshots](26-courseware-fixed-snapshots.md#desktop-fixed-build-and-preview-a17)
for parameter/result, ownership, integrity and lifecycle rules.

A18 adds main-window-only `deckwise/ppt-editor/snapshot/capture` with exactly
`{viewId,expectedTeachingRevision}` and no extra arguments. Main verifies its
retained native teaching view and fresh saved-source parser result, then calls
private Host snapshot capture. Only `CoursewareSnapshot` returns. Renderer/API
wrappers for fixed build/review/play/cancel use `CoursewareFixedBuildView` from
shared; they import no Main or Node module. Speech-bearing capture currently
rejects until trusted generated-audio ingestion is connected; renderer-supplied
paths/assets are never accepted. See [snapshot spec](26-courseware-fixed-snapshots.md).
