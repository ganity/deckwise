# Authorized private courseware media transport

## Shared generation concurrency (2026-10-30)

Main shares five generation slots across TTS, images, image-layer decomposition,
music collections/exports and video for the current authenticated principal.
Both legacy and confirmed submission paths, including the local audio relay,
use the same FIFO queue. A decomposition counts as one generation job, including
its bundled foregrounds. Returning a remote task ID does not release a slot:
`ready`, `failed`, `cancelled` and `archive_failed` do. Catalogue, quote, status
and asset reads do not wait for generation capacity.

When queued work needs capacity, Main reads the original active jobs at
three-second intervals without repeating submission. It skips still-running
submission calls. A failed submission retains its slot until read-only lookup
finds a terminal task or confirms absence. Missing previously accepted tasks,
unknown submissions and status-read failures fail waiting calls visibly and
retain unresolved capacity; they never authorize another paid POST. No timer
runs when there is no waiting work.

Before actual dispatch, Main rechecks authentication, cancellation, quote expiry
and the originating coordinator's context guard, including approved scene plan
and selected references. Queued cancellation sends no request. Existing durable
intent/key, ownership, billing and adoption rules remain in force.

This is an in-process limit for one authentication lifetime. Restarted or other
Desktop instances and supplier fan-out need server scheduling for a global cap;
existing receipts still recover through their original read-only paths. Coverage:
`courseware-generation-queue.test.mjs`, `courseware-media.test.mjs` and
`courseware-local-media.test.mjs`; no paid-provider concurrency claim follows.

## Course visual consistency and student text (2026-10-26)

New scene plans contain an optional-for-compatibility `visualBible` object with
nonempty `artDirection`, `characters` and `setting` strings, at most 1000 UTF-16
code units in total. Main and Host validate it and preserve it through draft
approval. Legacy drafts remain readable. Image prompts include this shared bible,
page-required subjects, character identity constraints and a coherent default
setting; teaching-related location changes remain allowed.

For later visual masters, Main and Host automatically bind the selected first-page
master from the same approved plan and private account/session scope. Its immutable
archive bytes are supplied to the image role through llm-ha. Style conditioning
preserves palette, lighting, materials and recurring character identity without
copying the representative page's composition or character count. Models lacking
reference-image support, missing selection, changed references and foreign scopes
refuse before submission. Decomposition continues to reference only its own page's
selected master through the decomposition role. No model ID is hardcoded in Desktop.

The visual master is a complete teaching-page design, including every approved
`visibleText` string exactly once. The Host prompt ports MAIC's complete-master,
full-canvas environment, focal-action, text-hierarchy and independent-component
rules from `lib/generation/kindergarten/image2-pptist/slide-authoring.ts` at
`fdb27892e642c997cde6f29a07257540fda75f4e`. It preserves the course art direction
and character identities; it no longer requests a textless illustration or an
empty header reserved for later text. Only `visibleText` authorizes printed copy;
internal lesson/page titles and teacher narration do not add display text.
Empty `visibleText` still permits a deliberately textless page. Literal strings
are JSON-encoded without paraphrasing. The existing 4000 UTF-16-unit request
limit remains enforced, with an actionable error for oversized prompt data.

The right preview shows the actual master, with a separate text checklist for
exact wording. Decomposition reuses MAIC's native prompt unchanged: complete
text carriers retain their original lettering. The compiler places the base and
every returned foreground image at its supplied bounds and stacking as separate
PPTX image objects. It adds no native text, shapes, connectors or internal titles.
Missing/duplicate foregrounds and non-image objects block compilation. Text
remains raster artwork, so glyphs are not editable as native PowerPoint text.
These checks establish request/data flow, not guaranteed supplier text accuracy
or final rendered legibility.
Existing generated assets are neither regenerated nor charged automatically;
requested regeneration creates a new intent without rewriting original tasks.

## Scene progression and actual MAIC coverage (2026-10-26)

The right work panel has a dedicated scene image preview, page/layer list and
first-page style confirmation. The main Chat footer links to that preview instead
of rendering an overflowing task list. GET status and verified archive preview
remain available during the owning Chat turn; generation/selection mutations
still require their existing active-turn and ownership checks.

The image preview uses the existing SVG workbench's three-pane arrangement:
numbered pages and lazy archive thumbnails at left, a central aspect-preserving
image and previous/next navigation, and page text, visual requirements, per-page
asset choices and persistent actions at right. Both side panes can be collapsed.
Pages come from the approved plan, not the number of image intents; layers and
replacement attempts stay inside their page. A prepared cover explicitly asks
for generation. Preview failures expose a retry and never expose selection of
an unseen image. Operation errors survive successful background list polling.

The existing refresh tool accepts optional `generatePrepared:boolean` (default
false). With true, it submits only the same known prepared intent through the
existing generation service and model rebinding. Current-plan and cover-style
guards apply before submission. Unknown/submitted/rejected requests are never
resubmitted by this option. A result without an asset sets
`requiresHumanSelection:false` and reports `requiresGeneration` for prepared
requests. The scene skill reports model errors and requests review only after
verified archive bytes exist. Existing Chat prose is not rewritten.

Image prepare returns the submission snapshot. Refresh defaults to one snapshot;
optional `waitForUpdate:true` polls the original job every three seconds for up
to 30 seconds, returning sooner on readiness or failure. After style confirmation,
independent missing assets proceed even when another submission is unknown.
When only pending jobs remain, the Agent keeps its turn active and continues
bounded refreshes without asking the user to continue. The mounted preview also
queries original jobs. Stop/session/auth/plan changes prevent later dispatch or
adoption. Unknown outcomes stay query-only for that intent; they do not revoke
style confirmation or block independent intents. No query resubmits an unknown
request. `styleConfirmed` reflects the saved selected cover, while
`requiresHumanSelection` refers only to an unselected, archived cover master.
Only that first visual master requires human style confirmation. After it,
later verified images and complete decomposition groups are selected
automatically and Chat proceeds to compilation. Pending, failed, generated and
selected remain separate UI states.

The runtime enforces completion through pi-agent-core's `finishTurn` hook.
Submitting an image or explicitly refreshing with `waitForUpdate` /
`generatePrepared` arms the current turn's scene continuation; status-only
workflow reads do not authorize generation. If the model closes the turn while
jobs remain, runtime queries the original intents every three seconds through
the existing scoped tools, without another model request on each timer tick.
It waits beyond an individual tool's 30-second window. Verified progress feeds
a saved-state system update into the same Agent loop so it can generate the next
missing assets or compile. This update is superseded by newer tool results and
expires at the next user turn. No synthetic human message or renderer-triggered
Chat restart is used. A ready unselected cover yields for style review; job
failure is returned for reporting, while Stop, steering, mode change and plan
replacement interrupt waiting. Invalid state, failed queries and a repeated
unchanged closing response are local failures, never provider retry loops or
evidence of completion. The same turn guard also waits on saved-page TTS/music/video
jobs. A full-course compile or explicit saved-course media context read uses
`continueTeaching:true`; omitted/false preserves PPTX-only/status behavior. Read-only status never starts generation or adopts a new scope.

Saved narration context distinguishes the initial outline seed from detailed
narration and exposes actual speech IDs and per-page audio readiness. The Agent
can generate missing detailed teaching, then use `courseware_media_context`,
`courseware_media_prepare` and `courseware_media_refresh` without opening Office.
These tools reuse existing Host journals, principal/source/teaching checks,
server quotes, durable submission and verified archive/adoption. Music completes
its original generation and export before mounting a separate playable clip.
Prepared jobs are not polled as submitted; uncertain submissions are query-only.
Successful page results remain saved when other pages fail. Planned video uses a quoted five-second supplier task; an unknown submit receipt stays query-only, and a ready MP4 is decoded, Host-archived and attached to its saved page before the turn can complete.

| Capability | Current automatic scene/saved workflow | Remaining boundary |
| --- | --- | --- |
| Plan and detailed narration | Approved outline; saved evidence, whole-course arc and per-page generation | Preserve full teaching design; initial plan text alone is insufficient |
| Visual masters | Role catalog, submit, original status, verified archive, preview | First-page style decision required |
| Layer decomposition | Selected master; clean base and foregrounds; automatic selection | Real supplier quality acceptance remains separate |
| Editable PPTX | Validated native objects and saved outline narration | Intermediate, not complete MAIC playback |
| TTS | Saved speech IDs, original jobs, byte/decode verification and automatic adoption | Normalization splits to the 4000-unit transport limit; live provider and final playback acceptance remain |
| Music | Saved-page generation, export, verification and playable clip adoption | Lesson song-slot planning/placement parity remains |
| Highlight and spotlight | Mapped narration intent resolved against decoded speech duration | Final executable snapshot/player verification remains |
| Animation and interaction | Mapped finite fadeIn/pulse plus saved teacher-led questions, reference answers and teacher-controlled checkpoints | Automated answer recognition/grading is not claimed |
| Video and sound | Saved five-second video slots, quoted async supplier tasks, owner-bound Host receipts and verified MP4 archive | Live supplier and packaged playback acceptance remain |

Desktop modes are ordinary generation, scene generation and PPT import. They
share one PPTX editor and baseline teaching features. Scene mode supports both
kindergarten and primary; stage influences pedagogy, never basic capability.
Video and music are driven by actual lesson requirements. Do not infer that only primary needs interaction or that video replaces
object animation. See [the inspected MAIC workflows](../../validation/courseware/maic-stage-workflows-20261027.md)
and [the saved-media decision](../../adr/courseware-saved-media-continuation.md).
No full-parity claim follows from transport or TTS/music tests alone.

## Scene teaching readiness (2026-10-27)

Teaching-plan approval remains a human decision, followed by first-page visual
style selection. Later generated masters, decomposition, detailed narration,
TTS and generated teaching results need no per-page approval. Status reads do
not start generation. Source, account, lock and Stop fences remain enforced.

Narration uses current mapped scene roles/names/aliases together with actual
page evidence. The shared attention intent accepts optional `animation:fadeIn`
or `pulse`. TTS adoption resolves finite motion and focus using decoded duration,
with entrance before focus. The editor supports the fixed player's bounded
fadeIn/fadeOut/pulse cues, at most five seconds and one animation per page object.
Source association preserves the explicit logical object references.

Host marks a generated scene page ready atomically after media adoption only if
all generated speeches have adopted audio, no unresolved attention remains, and
strict page actions, mapped targets and durable TTS/music/video receipts validate,
with no unresolved video slot.
Incomplete, imported and locked pages are not automatically confirmed. Saved
context exposes actions and `teachingReady`; audio readiness alone does not end
an authorized complete baseline teaching workflow.

A lost submission response with a transport failure queries the retained intent;
it does not purchase another task. Other errors are surfaced. The current
transport's 4000 UTF-16-unit speech limit is applied during normalization without
text loss or invalid surrogate splitting; pauses stay on the final segment.

Editing returns PPTX plus unified teaching data, with no snapshot or PPTist build
triggered at generation completion. Publication alone freezes source/teaching
versions and builds the teaching package. The snapshot adapter strips recognized
speech provenance for strict player validation; unknown fields remain invalid.
Finite teaching cues do not claim native PowerPoint timing authoring or full
MAIC assessment/video/motion parity.

## llm-ha scene images and Seedream decomposition (2026-10-26)

Desktop connects directly to llm-ha for image catalogs, internal quotes, confirmed
submission, status and original assets. Platform authenticates users and provides
billing quotes, reservations and settlement; supplier inputs and image task data
stay in llm-ha. Provider keys and actual models are configured there. Main uses
its existing managed llm-ha URL / `DECKWISE_LLM_BASE_URL`, while TTS/music keep
their existing Platform routes. See [the routing decision](../../adr/courseware-images-direct-llm-ha.md).

Master images use the native MXAPI async adapter. `image-layers` uses Seedream
5.0 Pro with `layer_decomposition:true` and the exact selected visual-master
reference. One confirmed task returns a private
`application/vnd.trainwise.image-layers+json` bundle with a base and 1–16
foreground PNGs, normalized crop bounds and stacking indices. Platform reserves
at most 17 output images, then settles the actual count at the frozen quoted
rate. Missing pricing or changed quotes refuse before supplier generation.

Main verifies the ready/settled receipt, downloaded hash, PNG decoding, foreground
alpha and bounds before Host archives the complete group. Host saves one parent
cleanPlate and deterministic derived layer intents in the existing private scene
journal. Children share the original submitted task/key/hash and cannot begin
another generation. Archive replay verifies existing entries without duplication;
changed assets/targets reject. Journal metadata saves only after all inputs pass.
The first page visual master requires human style selection. After that approval,
Chat selects verified later masters and complete decomposition groups automatically.

Assets optionally carry `normalizedBoundingBox:[left,top,right,bottom]` (0–1000)
and `sourceZIndex`. Compilation preserves these with the base's aspect-fit scale
and offset, clearing guessed image rotation/cropping. Legacy images retain their
existing behavior. Gateway receipt JSON contains supplier URLs; Desktop downloads
2–17 images, each ≤8 MiB and 4096×4096. One native group may total 44 MiB
of original bytes (Base64 JSON ≤60 MiB), remaining below the existing 64 MiB
Host RPC frame. Downloads and safety checks share Electron defaultSession DNS
and proxy routing. Existing whole-course compiler/journal budgets still apply.

Omitting the model in Chat preparation uses the first server catalog model for
the role; explicit unavailable IDs reject before Host preparation. cleanPlate
prefers a decomposition model and reuses its foregrounds. Catalog/auth/network
errors remain visible. Before quoting a current `prepared` request whose model
has disappeared from the matching catalog, Main selects the first compatible
model of the same image kind. Host atomically verifies its expected request hash,
retains prompt/reference/target/intent identity and issues a new request hash/key.
Main obtains a fresh server quote after replacement and submits automatically.
Chat preparation and the image panel's Generate action use the same coordinator;
no payment prompt or fee confirmation is shown. Quote proofs remain in Main and
the durable begin checkpoint still precedes dispatch. Old prepared attempts can
use Generate in the existing Chat. Begun, uncertain, submitted,
archived and selected requests retain their original model/key. New `gw-`
receipts persist in llm-ha SQLite. Old non-gateway receipts have read-only
Platform recovery; only an explicit gateway task-not-found permits old by-key GET.
New submission never falls back to Platform. Lost paid replies remain unknown
and may retain reserved funds for operator reconciliation. Query/download/archive
recovery never submits another generation. Team permission and ownership checks
remain mandatory, including asset reads after revocation.

Status: A19–A26 implement private transport/journal, finite Main orchestration,
validated audio archive/adoption and fixed narrated preview. A27 adds existing-task
query/retrieval/explicit adoption to the teaching panel. The quote-confirmed generation
controls are now connected through Main/IPC; live provider/billing/installer/publication
acceptance remains IN_PROGRESS.
The checkpoint sections below retain their original scope; later checkpoints
supersede their pending-state notes.

## Canvas music generation and separate export (2026-10-24 source increment)

Music reuses the private Main credential/HTTP boundary and strict response
parsers. `music` ready tasks are collections with `assetRef:null`, not a single
song; `music-export` ready tasks require their own MP3 asset. Every candidate
retains its opaque local ID, supplier order, state, duration and exportability.
The Java/TypeScript/Rust canonical request hash includes the exact lyrics and
title/style/negative-style/instrumental values; null versus missing optional
values are equivalent, while empty strings remain distinct.

Host owns immutable generation and export journals, their original scope and
idempotency key. Main holds expiring quote tokens and independently confirms
each paid operation. Lost replies are recovered only with authenticated GET.
Preview GET never requests an export or creates another generation. Both
candidate preview and exported MP3 originals are privately archived and verified
on local restart reads. Accounts and visible Chats fence async results; a valid
late receipt is first stored in its original Host scope, then rejected for stale
UI. Definite team permission refusals remain terminal rejected attempts; there
is no personal billing fallback.

The canvas exposes saved title/lyrics, separate editable style fields, explicit
cost confirmation, all candidates, read-only audio controls, separate export
confirmation and retained request history. Style options freeze with the prepared
intent; unsaved local style fields are not a shared draft schema. Neither
generation nor export writes PPTX or its teaching timeline. This does not close
music adoption/synchronization, real price/quality, deployed-account, package or
full W15.2 acceptance. Existing image/TTS/team transport behavior is retained.

### Explicit sequential teaching music adoption

An archived `music-export` MP3 can be explicitly appended to the saved current
page's teaching actions. A candidate preview is not an export. The canvas first
opens a teaching view and shows the deck title, page number and append order;
a second confirmation supplies only `sessionId`, `intentId`, `viewId` and
`expectedTeachingRevision`. Main derives project/page/source from that view,
verifies local bytes and actual decoded duration, and rechecks the current
export task and permission by GET before the Host mutation. This path makes no
generation/export submission and never writes audio into PPTX.

Music uses the dedicated `musicAdoptionContext` and Chat bridge `assertOwned`.
The media canvas may be visible while the same Chat retains its hidden WiseOffice
editor; hiding that editor alone must not invalidate this explicit adoption.
Owner checks run before and after asynchronous saved-source validation. Source
hash, native document/page/revision, edit generation, dirty/read-only state,
session, Host, teaching pin, current server permission and Host CAS checks remain
mandatory. A switched Chat or lost editor ownership still rejects. Native Chat
tools and TTS continue to require the active editor through `assertActive`;
the retained-editor allowance is specific to music adoption.

Host owns the atomic teaching CAS and adoption receipt. It requires Agent mode,
the original session/principal and matching captured team scope, the exact source
and teaching revision, an unlocked target and a verified original MP3 archive.
It appends `{id, type:"audio_clip", audioAssetId}` without changing existing
speech/TTS. Repeating a valid adoption returns its existing action; a removed
action is not silently recreated. The same export can be explicitly reused on
another page without another paid export. Teaching review is required after
adoption. The sidebar can reorder or remove clips through its existing durable
draft/save workflow. Success in the canvas asks the user to reload the teaching
page; it does not replace an existing unsaved sidebar draft.

Snapshots collect independent Host music receipt proofs, not renderer file
paths or TTS intents. All current clip references must match adopted provenance;
missing, surplus, foreign or corrupt assets fail closed. Music-only and mixed
speech/music decks share this path, with identical-byte assets deduplicated.
Saved-source review rebinds retained clips; narration candidates preserve clips
at their previous action indices, bounded by the new action list's length.

The fixed package requires `teachingAudioClips:"sequential/1"` iff a clip is
present. Builder/loader validate audio assets and retain action order. Playback
uses the existing local audio clock and pause/resume/seek/stop/error controls;
music has separate progress and no narration callback, reading timer or browser
TTS fallback. Older strict loaders reject this new capability, so matching
Main/Host/runtime must ship together. Existing packages without clips remain
unchanged.

The compiled fixed player passed two focused groups in Chrome and two in
Electron: real MP3 decoding/time progression, pause/resume/seek, native `ended`
before the teacher wait, narration followed by music, callback/TTS separation,
page navigation cleanup and active-audio cleanup on unmount. All playback runs
offline after verified package/asset/style/font loading. See
`docs/validation/courseware/w15/music-playback-browser-20261024/README.md` in the
root workspace `/home/jhz/code/train`.
The separate source Desktop/Office/Host adoption runner now passes seven actual
groups, including native page-change refusal, canvas adoption, teaching
reorder/save, fixed native playback and full Electron/Host restart with local
MP3 recovery. It uses isolated identity/media/TTS fixtures. Its root evidence is
`docs/validation/courseware/w15/music-adoption-electron-20261024/README.md`;
it does not establish real supplier or matching packaged acceptance.

This increment is sequential music playback on a page. Background mixing,
ducking, cross-page loops, lyric/subtitle synchronization and native PPTX audio
editing retain their separate requirements. Neither these checks nor the
standalone player gate establish supplier quality or package acceptance.

## Team media generation authorization (2026-10-24 increment)

Personal media submission retains `/courseware/media/tasks[/confirmed]`, its
existing request hash and response format. Team submission uses the distinct
`/courseware/team/projects/{projectId}/media/tasks[/confirmed]` routes. Main's
TTS, scene-image and canvas-image coordinators derive this project only from
the saved Host task at durable begin; Renderer and model requests cannot choose
it. Each new TTS/scene/canvas intent stores `submissionScope` containing the
persisted Chat ID and an explicit nullable team project together with
`submission-unknown`, before the WAL acknowledgement. Main routes only from
that receipt; missing, malformed or foreign receipts cannot fall back to personal. An older backend's missing team route must fail
without retrying the personal endpoint.

Platform stores nullable `team_project_id` on the task; deploy the additive
`migration-20261024-courseware-media-team.sql` before the updated server.
Existing NULL tasks stay personal. Inside the submission transaction, current
Owner/Editor membership is locked and checked before budget locking, idempotent
replay, quote validation, reservation or enqueue. The original private
tenant/user/key uniqueness remains. Equal keys cannot switch between projects
or between personal/team scope, even though content hashes stay compatible.
Tenant identity always comes from authentication. Application login roles do
not override the courseware project's Viewer role.

Task status and GET-by-idempotency remain private to the original tenant/user
after revocation for fee reconciliation. Original-owner cancellation of queued
work remains available. Result downloads additionally check current membership
in the stored team project inside a transaction; revocation denies bytes, while
Viewer membership still permits reading one's own result. Other team members
do not gain access to private task status by knowing its ID. Team asset adoption
continues to require Owner/Editor separately.

Host serializes begin and task binding using its existing state lock. Binding
before begin makes a prepared intent team-scoped; binding after begin does not
retarget an already started personal request. Historical requests retain their
original scope/key/hash and recovery remains GET-only. Legacy unknown/submitted
records without scope remain readable and bindable but cannot begin again.
TTS now also rejects a second begin, including after a lost durability reply;
two independent Main coordinators cannot obtain a second dispatch acknowledgement.
Repeated task selection preserves any existing team association.

This media increment does not complete W09.1. The managed LLM increment below
adds project authorization separately. New-package and intended-environment
acceptance remain open. No claim of production login/OSS or complete
team generation follows from source tests. Already authorized remote tasks may
finish after revocation; cancellation/reconciliation is distinct from new
submission authorization and downloaded local bytes are not remotely erased.

## Definite team media refusal (2026-10-24 increment)

Only the exact Platform envelope errors `46100` and `46102` from the pinned
team submission route can end a begun attempt as `rejected`. Platform checks
these permissions before looking up/creating a task or reserving points. A
new intent can dispatch only once; an unknown attempt is never resubmitted to
obtain a denial. A generic HTTP 403, timeout, missing lookup result or malformed
response remains `submission-unknown`, with GET-only recovery.

Main records `rejected` through the private TTS/scene/canvas `.reject` RPC,
providing the original idempotency key and request hash. Host accepts only the
matching, unbound `submission-unknown` intent with a saved team scope. The
checked write and WAL acknowledgement retain its request/scope/history across
restart. It cannot begin or bind a later task; personal, prepared, submitted,
foreign or mismatched records cannot be rejected this way.

The existing UI shows localized permission guidance, disables task lookup for
this terminal attempt and does not imply pending generation. A deliberate new
attempt preserves the old record, gets a new key and quote, and requires new
cost confirmation. Scene preparation must not reuse the rejected intent for an
otherwise identical prompt. No background retry or fallback to a personal route
is allowed. Main and Host must be upgraded together; older Hosts do not support
the new phase/RPC. This does not certify live supplier quality or complete W09.

## Managed team LLM authorization (2026-10-24 increment)

Main's managed provider credential resolver reads the persisted Chat and Host
task for each model request. Personal requests retain the configured base URL.
A saved team binding selects the dedicated llm-ha base URL
`/v1/courseware/team/projects/{projectId}`; Renderer/model parameters do not
choose the project. Main Chat/managed subagents, Main one-shot narration/scene
completion, prompt enhancement and automatic title summarization share this
resolver. Enhancement uses the original persisted Chat ID when present; its
temporary launch ID cannot select project scope. Enhancement without a Chat
remains personal. Invalid scope, missing session or Host
replacement fail closed. Team gateways require HTTPS, with HTTP permitted only
on loopback. Tokens stay in the existing Main/sidecar credential path.

The dedicated gateway exposes `responses`, `responses/compact`,
`chat/completions` and `models`. Before normal model admission/routing, llm-ha
calls Platform `GET /courseware/team/projects/{projectId}/llm-context` with the
bearer token. Platform checks current tenant/project Owner or Editor membership
inside the existing membership-lock transaction, then returns trusted identity,
project and LLM billing-entitlement headers with HTTP 204 and `Cache-Control:
no-store`. llm-ha requires the matching project and valid identity/entitlement;
client-supplied identity headers do not authorize a request. Team checks never
use the general identity cache. Viewer, revoked/cross-tenant and absent-route
responses refuse; transport/server failures report unavailable. A static gateway
key or disabled Platform authentication cannot authorize this path.

Successful requests retain the existing provider model allowlist, usage and
billing path. No new database or billing source is introduced. A missing team
route never retries a personal route. Platform and llm-ha must support the new
paths before the updated Desktop team flows are used; the existing `/llm-ha/v1/`
gateway prefix forwards them without a separate proxy location.

Scope is selected at each model credential resolution. Binding after resolution
does not retarget that already started request; the next call reads the binding.
Revocation stops newly authorized team requests, not an already admitted stream.
This is project-scoped managed generation authorization, not a prohibition on
a user's unrelated personal or BYO-provider LLM usage. BYO credentials keep their
existing route; team adoption/source writes remain separately server-authorized.
Local downloaded bytes and local copies are not remotely erased or locked by
revocation. No universal prevention of local editing is claimed.

## Canvas image request journal (W15.2, in progress)

Canvas image generation uses a separate Host KV namespace,
`coursewareMediaCanvasImages.v1`, partitioned by canonical workspace, persisted
Chat and authenticated principal hash. It never stores receipts in the editable
canvas document. A caller-generated explicit attempt ID makes preparing the same
attempt idempotent; a deliberate new variant uses another attempt ID and a new
Host-generated media idempotency key. Identical prompts therefore remain separate
candidates without turning an uncertain POST into an automatic retry.

Private RPCs `courseware.mediaCanvas.image.prepare/list/get/begin/bind/reference`
freeze the saved draft identity/revision, exact prompt/model/reference metadata,
request hash, original key and eventual task receipt. Prepare requires exact
canvas/draft revisions, Agent mode and a selected plain/scene/import task. Begin
rechecks the draft and marks `submission-unknown` behind a checked WAL barrier
before Main may POST. A second begin is refused. Bind accepts only the original
key/hash and never replaces a different receipt. Existing records remain readable
and late receipts can bind after draft deletion, content changes or switching to
Plan; these operations cannot dispatch or apply anything to a slide.

The existing platform image transport accepts at most 4,000 UTF-16 units and one
PNG/JPEG reference. Larger saved drafts/multiple references are rejected before
preparation, without truncating or silently dropping data. Reference IDs and
versions must resolve to an archived image in the same principal/Chat/workspace
scene or canvas-image journal, and its content-addressed bytes must verify. Current scene
selection does not revoke a frozen reference version; another account's metadata
does not authorize bytes. Preparation/reference resolution never sends bytes to a
provider. Provider capability and explicit cost/reference consent remain required
at Main submission.

The canvas now exposes a saved-image-draft/model selector, request preparation,
explicit maximum-cost/reference-egress consent, confirmed generation and retained
task/status controls. Unsaved drafts cannot prepare. Main owns expiring quotes;
Renderer cannot provide a server quote token, principal or reference bytes. Every
operation freezes its arguments before awaits. Account/Chat/Host/running-turn
changes reject stale replies. A validated late task receipt is nevertheless bound
to its original Host partition before stale UI rejection, preserving recovery.
An unknown POST is status-only and uses the original key/hash GET query; a local
Main restart loses the quote and requires a new quote for an unsubmitted intent.

Candidate archives use additive private RPCs `courseware.mediaCanvas.image.asset.stage`
and `.asset.get`. Metadata pins the original task receipt, SHA-256, MIME, byte
length and dimensions. Main verifies the ready/settled authenticated result and
native image decoding before Host checks the original receipt, format, bytes and
hash, writes the content-addressed archive, and confirms journal readback/WAL.
The optional `asset` field preserves older journal compatibility. Metadata and
bytes cannot be replaced with another result. General task views expose metadata
only; the private asset-get path is consumed by Main and never sent to Renderer.

The panel previews original references before offering cost/egress confirmation,
and supports explicit candidate download/archive, local preview and side-by-side
comparison of at most two archived candidates with their frozen prompts, models,
draft revisions and reference versions. Prompt/model changes never generate
automatically or replace previous candidates. Draft edits/deletion and Plan mode
do not revoke archived candidate reads; account/Chat/Host changes reject late
reads, and account/Chat changes clear private UI state. Archived local previews
need no provider download or generation POST after restart.

These canvas generation controls expose no adoption button and do not change a
slide. The separate [native Chat image-review flow](23-courseware-native-chat.md#archived-canvas-candidate-source)
handles target-reviewed insertion/replacement. Music and real supplier acceptance
remain W15.2 work.
References resolve to same-scope scene or canvas-image journals as specified
below. A missing or corrupt archive is rejected rather than silently replaced.
Explicit original-file retrieval is described below. No new real-provider claim follows from the
fixture-based checks.

### Reuse archived canvas images as references (2026-10-24)

The explicit reference loader lists selected current archived scene images and
all successfully archived PNG/JPEG canvas candidates in the current Chat. A
candidate remains available after its source draft changes; `current` describes
the draft match, not ownership of immutable archived bytes. WebP, pending and
unarchived candidates are not offered. This works for plain, scene and import
tasks and does not require a scene plan.

Canvas-image references use `canvas-image:<intentId>` as their opaque `assetId`,
with the immutable SHA-256 as `revision`. Older scene reference IDs keep their
existing meaning; no journal migration is required. The UI includes a short hash
in candidate labels so same-name variants can be distinguished without truncating
their saved title. The updated UI needs the matching Host for canvas references;
older Hosts refuse those IDs rather than resolving a different asset. Host resolves the prefix
only in the same canonical workspace, Chat and principal canvas journal. It
checks archived metadata, hash, MIME and byte length during preparation, begin
and reference reads; missing or foreign canvas IDs never fall back to scene
assets. Shared content-addressed bytes alone do not grant access.

Loading the list and selecting a reference do not generate media. Selection is
saved through the existing draft CAS. A new variant requires its own prepared
intent, supported model, fresh quote, local original-byte preview and explicit
maximum-cost/reference-egress consent. Main sends the exact pinned reference
bytes through the existing authenticated Platform media route. Original
candidates, prompts and receipts stay unchanged. Account/Chat changes invalidate
late lists. Choosing a reference is a user action, not an automatic quality
approval. No real-supplier or release acceptance follows from fixture tests.

### Explicit canvas archive restoration (2026-10-24)

An archived candidate exposes **Retrieve original image (no regeneration)**.
Preview, comparison and reference loading remain local-only and never trigger
retrieval. The action uses the immutable original task receipt through the
existing authenticated result GETs; it does not quote, prepare, begin, POST a
task or select/adopt a slide. It remains available for historical drafts and
Plan mode. Expired, inaccessible or changed remote results fail without fallback
generation or changes to the saved request, receipt or archive metadata.

The additive main-window-only `coursewareCanvasImageRestore` IPC accepts exactly
the current Chat and intent IDs. Main rechecks account/Chat/Host/turn state across
awaits and serializes retrieval with ordinary archiving. The ready/settled result
must match the original task, request hash, model and all archived hash/MIME/size/
dimension fields; native decoding and hash checks precede any write. No Renderer
path, bytes or result URL is accepted.

The private Host RPC `courseware.mediaCanvas.image.asset.restore` requires an
already archived, owned submitted intent and exactly unchanged asset metadata.
It verifies the original bytes and explicitly repairs that content-addressed
file using a synced temporary file and atomic rename. Existing destination
symlinks and non-regular files are refused; archive paths stay beneath Host data.
Journal readback/WAL and archive verification precede acknowledgement. Ordinary
`asset.stage` and all other generic archive callers continue refusing corrupt
existing files. No journal migration is needed; matching updated Main/Host is
required. Restoration of identical bytes can also repair fixed snapshots that
share that hash, without changing their references or manifests.

## Uncertain fixed team publication recovery (2026-10-23)

Fixed sharing now records a Host-owned `coursewareFixedShare.v1` KV intent
before any remote upload/publication dispatch. Its partition pins the
authenticated principal hash and original persisted Chat/workspace. The immutable
selection pins the local project/snapshot, build hash, manifest hash, team project
and exact shared/formal channel. Only metadata is stored: no credentials, signed
URLs or Main-owned DB.
Host verifies the persisted snapshot and existing task association. The checked
Host WAL barrier precedes acknowledgement and any network write.

The intent remains `unknown` until Main receives a validated publication response
and Host atomically records the original task's team binding plus `bound` state.
An existing different team binding cannot be replaced. A lost remote success
response, local completion failure or process exit retains the same intent;
another share request cannot dispatch a POST while that record is unknown.
Local validation/file-read failures before intent preparation do not create it.

The playback panel reads the current account/Chat's retained record even without
a live preview after restart. **Query share result** performs only authenticated,
non-cached GETs of the pinned fixed build and current channel pointer. Build,
snapshot, package/manifest hashes, team and channel must all match before Host
completes the original binding. Recovery never uploads, republishes, substitutes
another preview or overwrites a newer channel pointer. Current account, Host,
Chat and workspace checks surround the asynchronous operations; an auth change
clears the displayed private record. Revoked permission or a competing pointer
keeps the unknown result visible and performs no publication.

This is bounded matching-result recovery, not a full retry/abandon protocol.
The existing backend exposes the current build/pointer but no publication intent
receipt/history. A crash after local preparation but before POST, a successful
upload without publication, GET absence or a later competing pointer therefore
cannot prove that the original publication did not/will not commit. Such records
remain unknown and block new sharing in that Chat/account. The UI explicitly
states that these records cannot yet be automatically cleared or republished.
A future server-owned idempotent publication receipt is needed to resolve those
cases safely; no endpoint or automatic retry is invented in this checkpoint.

## Scene image archive and page review (2026-10-23)

Scene planning in the existing Main Chat reuses the vendored MAIC audience,
subject and language policies through the Agent runtime's public profile API.
Stage/subject normalization is local to policy selection; the stored education
context and explicit full-English setting remain unchanged. Kindergarten English
uses the bounded short-expression/praise policy; unrelated subjects do not gain
English praise merely by selecting the scene task. The product scene skill and
one-shot planning helper follow the same policy. `visibleText` is student-facing,
`visualIntent` may describe unspoken teaching/participation intent, and `narration`
contains only spoken words. The plan schema does not encode executable waits;
teachers add reviewed pauses/checkpoints through the shared teaching sidebar.
Prompt wiring and fixture-model tests do not prove real teaching quality.

### Reference-conditioned image requests

New background and foreground requests from the scene workbench require the
current page's selected, reviewed visual master and an image model whose
`supportsReferenceImage` capability is explicitly `true`. Missing capability
means unsupported. A visual master itself remains a text-to-image request.
The fee confirmation displays the private reference preview, intent identity
and full SHA-256, and expressly includes consent to send that image to the
image provider. The image is not uploaded to a team project.

Host preparation accepts optional `referenceIntentId` and freezes its
`{sha256,mimeType,byteLength}` metadata in the private account/session/plan/page
journal. Only a selected archived visual master from that scope is eligible.
PNG/JPEG originals up to 8 MiB qualify; existing WebP archives can still be
reviewed or compiled but do not qualify for reference conditioning. Preparation
and quotation do not send image bytes over the network. At confirmed submission,
Main rechecks the exact selection, current plan, account and capability, reads
and verifies the private archive, and durably begins the retained request.
Host rechecks reference selection under its begin lock. A changed selection,
unsupported model or corrupt archive refuses the submission.

The existing confirmed media request admits optional
`referenceImage:{sha256,mimeType,byteLength,bytesBase64}`. Bytes are canonical
base64 of the original reviewed archive; renderer paths, URLs, team uploads and
private intent IDs are not provider inputs. Reference request hashing preserves
the original four UTF-16 length-prefixed fields and appends SHA-256, MIME and
decimal byte length with the same length-prefix rule. Base64 is not hashed
separately. Old requests and journals without references retain their exact
schema/hash and remain recoverable. An unknown submission uses the saved key
and hash for GET recovery, never another POST. The backend admits only its
existing reference-capable MXAPI adapter and rejects unsupported providers before
reservation. Transport tests and fixtures do not establish real model fidelity.

### Reviewed private assets to editable PPTX

The scene workbench exposes an explicit **Generate editable PPTX** action only
when every approved page has selected a reference, a distinct clean background
and at least one named transparent foreground. Main re-resolves and verifies
the private original bytes; Renderer never supplies compiler images, paths,
principals, model overrides or narration. This route does not forge team assets
or submit any new image task. Layout uses the current Chat's configured
image-capable model and existing managed/BYOK transport; the model call is a
separate operation from image generation and may incur its normal model cost.

The canvas is 1280 x 800 (16:10). Reference/background bytes are normalized to
PNG with proportional, centered fitting and white letterboxing where necessary;
no crop or stretch is applied. Independent transparent foreground PNGs retain
their bytes and dimensions. Original private archives remain unchanged. The
teacher must review art consistency, background cleanliness and final layout.
Every reviewed foreground must appear as an independent image object with a
bounded semantic role. Unknown or silently omitted foregrounds reject before
compilation. Host retains canonical semantic associations, checks the approved
plan's ordered source hashes and reprojects missing/content-changed states
after saved-source review. The current teaching panel exposes only display
roles, spoken aliases and review states. It does not expose regeneration
prompts or enable effects merely because an object was matched.
The native compiler reads the generated slide XML before returning its mapping.
Each semantic element must match exactly one actual `cNvPr` object name and
numeric shape ID on that page. Missing, duplicate or unexpected objects fail
compilation. The returned `sourceShapeId` is scoped to the exact exported PPTX
and page; it is not a canonical teaching object ID or proof that a later Office
save preserved identity. Saved-source reconciliation remains Host-owned.
Each page's native scene schema is validated, requires an editable native
object and rejects reference-image flattening. Existing scene generator and
compiler assemble one native PPTX; approved per-page narration is carried
separately into Host teaching, never rasterized or newly generated by layout.

Only one generation runs in Main at a time. Explicit cancellation aborts its
signal; Chat/account/Host/active-turn changes abort pending work. Main checks
the current approved plan, exact selections and model before/after asynchronous
operations and immediately before staging writes. A 15-minute timeout fails
without automatic retry. Host rechecks current selected intent IDs, plan and
archive hashes under its project-initialization/attachment lock. Initialization
requires the approved title and exact ordered narration. Selected inputs that
change during layout cannot attach an outdated deck.

Staging preserves the compiled content-addressed workspace file and publishes
its initial saved revision using the existing WiseOffice document ID and
revision writer. Parsing that saved revision gives Host and WiseOffice the
same project identity; no generated-path exception to Host's saved-source
validation is introduced. A retry reuses an identical saved revision and
refuses to overwrite a different existing revision. Staging initializes actual
parsed pages and teaching, attaches the task and opens the same WiseOffice
editor used by ordinary/import tasks. A failed handoff preserves
the file for recovery; a cancelled/failed attempt never automatically resubmits
media. Once attached, existing native save, teaching review and reopening apply.
This is a source feature; native supplier quality, automatic layer extraction,
reference-conditioned generation, animation authoring, TTS and final publication
are separate acceptance gates. The historical archive-only limits below are
superseded only for this reviewed compiler/handoff route.

The same task flow now distinguishes `target:{kind:visualMaster}`, `cleanPlate`
and `layer` with a bounded, teacher-visible `name`. Old requests and stored
journals without a target default to `visualMaster`; their original prompt,
request hash, receipt and idempotency key remain intact. Preparation accepts
optional bounded `instructions`. Each prompt includes the approved page intent
plus role-specific constraints and the teacher's requirements. Identical
plan/page/target/prompt/model requests reuse their existing intent; changed
requirements prepare a new request requiring a fresh quote and explicit cost
confirmation. Merely editing a field never submits or replaces an asset.

Selection CAS is now scoped to plan/page/target, including a layer's exact name.
A page can retain its reference, background and multiple named layers together;
replacing one layer preserves the other choices. The UI invalidates its quote
when page/model/purpose/name/requirements change. Archived layers must be PNGs
with both actual transparent and visible pixels after native decoding. A native
Seedream crop pinned by sourceZIndex and normalizedBoundingBox may be fully
opaque (for example a rectangular text card); it still needs visible pixels and
retains its original PNG bytes. Independently generated opaque layers and
completely invisible results cannot be archived or selected as layers;
there is no automatic background removal or paid retry. Host additionally
rejects non-PNG layer metadata before storage.

These requests currently use the existing text-to-image provider contract.
The selected reference image is **not** sent as a conditioning image; matching
art direction and a semantically clean background still require teacher review.
Transparency alone does not prove that an isolated subject is correct. This
checkpoint does not establish supplier support/quality, scene compilation,
16:10 layout, a complete editable PPTX or WiseOffice handoff.

The existing scene workbench can explicitly archive a ready/settled original
image task and preview its private bytes. Main binds the authenticated receipt,
model, request key/hash and actual image metadata. Original PNG/JPEG/static WebP
bytes are checked against SHA-256, MIME, 8 MiB and 4096-per-axis limits. Encoded
dimensions are checked before native allocation; native decoding and pixel size
must agree. PNG validation additionally checks chunks/CRC and refuses animation.
Static WebP chunk dimensions must agree; animated WebP is refused.

Host reuses `courseware-assets` and the existing `coursewareSceneImages.v1`
journal. Optional `asset`/`selected` fields preserve older journal readability.
Archive is immutable and retry-safe; a different receipt/metadata or corrupt
existing file rejects rather than replacing it. Late old-plan results may be
archived privately, with no automatic adoption. Preview verifies the bounded
private file again and sends only a raster data URL/metadata to Renderer.
No supplier URL, archive path, credentials or task proof crosses this IPC.

An unchecked review control and explicit action select an asset for
that exact plan/page/purpose. Main rechecks context, actual bytes and current approved
draft; Host checks the previous selected intent and changes only that page's
selection. Plan/Chat/account changes invalidate UI callbacks and confirmations.
Selection/archives survive full restart. Old-plan selections remain historical;
they cannot authorize a new plan. Refresh reads durable state, and cached
preview never redownloads or resubmits. These actions neither charge, change
PPTX/teaching nor share private images. A selected reference is not a clean
plate, layer decomposition or editable scene; those remain separate plan gates.

## Adopted audio after an explicit saved-source review (2026-10-23)

Changing the native PPTX does not itself regenerate or attach audio. After the
teacher explicitly associates saved pages, Host may retain an already adopted
TTS asset only on its same logical page/action with identical speech text and
a receipt matching the previous source. It atomically advances `boundSource`
on the private receipt while preserving the original request/idempotency key,
task reference, account, voice, decoded metadata and immutable audio bytes.
No media HTTP request, new task or points reservation is part of source review.
Failed/missing receipt updates roll back the project and receipt together.

Legacy receipts use their intent's original source. A rebound receipt must be
adopted and match the current source revision/hash. Main snapshot collection
and Host capture both enforce that rule, along with current page/action/text
and exact asset metadata. A new copied page starts without teaching/audio;
previous immutable snapshots are unaffected. Object highlights/spotlights and
generated-PPTX candidate adoption remain outside this migration operation.

## Team member control ownership (2026-10-23)

The existing team tab's owner-only controls use the authenticated member list,
grant and revoke endpoints. Opening another team's controls clears the previous
selection and role before loading. A list response or failure applies only to
the same still-open request. Controls stay disabled while members load or a
mutation is pending; choosing an existing editor preserves their role. A member
mutation captures its original project, user and role. Leaving the team,
refreshing, an auth event or unmount invalidates follow-up reads and UI updates;
it does not undo a mutation already dispatched to the server. No automatic
mutation retry is introduced.

Only the latest project-list response may replace the visible list. Auth events
refresh it and invalidate member selection; unmount removes the event listener.
Create failures remain visible when other projects already exist. Server
membership checks remain authoritative. This finite UI behavior is not push
notification of remote permission changes, real second-account acceptance or
simultaneous editing. Explicit refresh/current server requests still resolve
remote changes in this checkpoint.

## Image catalogue, quote and confirmed transport (2026-10-23)

The existing private media transport additionally exposes `getImageModels`,
`getImageQuote`, `submitConfirmedImage` and read-only `findImage`. Image models
use the same bounded catalogue shape with empty voices and no default voice.
Quotes use the existing version with `kind: image`; kind/model, price ceiling,
character bound, expiry and token are validated before confirmed submission.
Extra fields, a TTS quote or a voice in an image request reject. The confirmed
ceiling is copied before asynchronous transport for both image and TTS, so
mutating the caller's quote cannot expand the permitted reservation.

Platform signs image quotes with an empty voice list and rejects any voice.
The existing confirmed-submit endpoint verifies the current offer before a new
reservation; an exact idempotent replay returns its original task even when the
original quote has expired. Existing account/tenant proof binding remains.
The llm-ha adapter requests `IMAGE` / `imageCount: 1` pricing from the existing
platform `PricingService`, rather than TTS character pricing. Its frozen rate
uses `billing-image-<ruleId>-<raw>-<scale>`; settlement rounds the price of one
image upward, independent of prompt length and later tariff changes. No current
IMAGE price means no offer, with no fallback to a TTS or client tariff. Existing
TTS price-version encoding and character settlement are preserved.

`findImage({idempotencyKey,requestHash})` only queries the authenticated existing
lookup endpoint. Only an explicit task-not-found response returns null; auth,
transport and pin failures reject. It never submits, regenerates or releases
points. Existing legacy image transport remains for compatibility; a new paid
scene flow must use confirmed submission and a retained key. Platform-priced
image tasks cannot bypass confirmation through the legacy submit endpoint.

The scene workbench now consumes this transport through the finite checkpoint
below. Asset adoption, layered generation and full scene-to-PPTX/Office remain
separate work. No model catalogue, quote or recovery GET submits a supplier
request. Existing server configuration and credential ownership are unchanged.

## Approved-plan image request journal (2026-10-23)

The scene planning panel can prepare one image-reference request for a selected
page and server-configured model. It is not layered scene generation and does
not mark a task generated. The teacher first confirms the current reviewed plan,
then requests a nonpaying quote, reviews the derived prompt and checks an explicit
page/model/maximum-cost confirmation before submission. Main retains the server
quote proof; Renderer receives only an opaque quote ID and bounded price view.
Changing the page/model/plan, losing authentication or restarting clears the
visible confirmation. The existing outer Chat remains the plan editing surface.

Host stores `coursewareSceneImages.v1` records under canonical workspace,
owning Chat and authenticated principal. A record pins the approved plan SHA,
page ID, Host-derived request, request hash and original idempotency key. Prepare
for the same plan/page/model returns the same record, including unknown or
submitted records. Revised plans require explicit reapproval and receive new
requests; old results remain queryable but stale. The renderer cannot supply
request text, credentials, file paths, task references or idempotency keys.

Host validates the current approved file before prepare/begin and persists a
verified `submission-unknown` checkpoint plus the existing WAL barrier before
Main may POST to the confirmed endpoint. Main binds the valid response to its
original partition even if the visible context changed after acceptance. Failed
or lost responses keep the original key. Status for unknown records performs
only the authenticated GET lookup; not-found does not authorize a retry. Known
records use GET by their pinned task ID. Binding a different receipt rejects.
No status call submits media, attaches assets, changes teaching or releases fees.

Six main-window-only `deckwise/courseware/scene-image/*` channels expose models,
list, prepare, quote, submit-confirmed and status. Main requires the active owning
Chat and a nonrunning turn, and rechecks authentication and context around
asynchronous work. The five Host RPCs are prepare/list/get/begin/bind;
models and quotes use the existing platform transport. Quote IDs are scoped
to the principal/Chat/intent/hash, expire, remain Main-only and cannot authorize
another intent. A restart requires a fresh quote for prepared requests; unknown
and submitted requests recover without another POST.

The current checkpoint offers page visual references and task/cost state. It
does not yet archive/adopt the resulting images into a scene, generate layers,
compile a scene PPTX or establish real supplier quality/fees. These remaining
steps must consume the retained requests instead of inventing new keys.

## TTS catalogue, quote and confirmed transport (2026-10-22)

### Normal media progress cadence

Platform's existing AsyncTask queue waits five seconds between normal
`COURSEWARE_MEDIA` query/archive stages (`MEDIA_QUERY_PENDING` and
`MEDIA_ARCHIVE_PENDING`). Actual dispatch also includes the existing queue-drain
cadence. This avoids two unconditional one-minute delays for an already received
inline audio result. Unknown submission, receipt recovery, query/archive errors
and other media waiting reasons keep the existing one-minute backoff. Import,
generation and unrelated task timing retain their prior policies. No transition
resubmits the provider request or creates a new reservation; waiting still uses
the existing claim fencing and does not consume the failure retry budget.

### Lost submission receipt recovery

Main's `findTts({idempotencyKey, requestHash}, signal?)` queries
`GET /courseware/media/tasks/by-idempotency?key=...&requestHash=...` on the
configured platform. The authenticated tenant/user and both persisted pins must
match. The server returns the existing `courseware-media-v1` view, without task,
queue, provider, asset or billing mutations. A missing task returns 46006;
hash conflict returns 46002; invalid input returns 46001. Main treats only 46006
as absent. Transport/authentication failures remain errors. Neither absence nor
failure grants permission to submit again.

When a Host intent is `submission-unknown` without a task reference, the existing
status/repeated-submit path performs this GET and binds a matching receipt in
Host. Prepared intents do not query. Bound intents keep using GET by task ID.
The key, request hash and model must match; account changes reject. A valid late
receipt may be retained for its original journal after the editor changes, but
the stale editor receives no successful current result and no audio is attached.
Missing results retain the unknown journal. A recovered local `submitted` phase
means the platform task reference is known: the server can still report
`submission_unknown/reserved`. Lookup cannot resolve supplier uncertainty or
release a reservation. Explicit audio retrieval/adoption remains separate.

This endpoint is implemented in the integrated A platform worktree. Previously
started platform binaries and the separate `courseware-mainline-tts` worktree do
not acquire it until built from the matching source. Local Electron/Host tests
use a platform stand-in; real database/controller checks run separately.

Main's media client adds `getTtsModels(signal?)`, `getTtsQuote(model, signal?)`
and `submitConfirmedTts(key, request, quote, signal?)`. They use the same private
platform root, authenticated bounded transport and account-change guards as task
reads. Catalogue reads accept unique model IDs, validated voice IDs and an explicit
provider-default-voice flag. Quote reads accept only `courseware-media-quote-v1`,
the requested TTS model, a price version, positive maximum points (up to 1,000,000),
a character limit of 1–4000, a future UTC expiry and an opaque token whose expiry
matches the displayed expiry. Extra fields and malformed/expired replies reject.

Confirmed submission posts `{request, confirmation: {priceVersion, maxPoints,
quoteToken}}` to `/courseware/media/tasks/confirmed` with the retained idempotency
key. Request hashing remains the existing content/model/voice hash, independent of
quote refresh. Oversized text and mismatched/expired quotes reject before network
submission; response reservations above the confirmed ceiling reject. Catalogue or
quote failure never falls back to POST or a hardcoded client price/voice.

The matching implementation is integrated in
`platform-worktrees/courseware-par-A`; `courseware-mainline-tts` is the earlier
TTS validation worktree and lacks later combined services. C's delivery remains
preserved. The service signs five-minute proofs bound to the
current user/tenant, offer, configured voices and provider account, with a distinct
HMAC domain using the existing server JWT signing secret. Signing-key rotation
invalidates outstanding quotes. Verification runs inside existing task submission,
after idempotent replay and before task insertion or points reservation. No new
reservation ledger or quote database is introduced. Legacy `/tasks` is preserved
for existing callers; new Desktop paid UI must use `/tasks/confirmed` exclusively.

The existing narration panel now loads the server catalogue, selects a speech
segment/model/voice, prepares a durable intent, and requests a quote without a
charge. The displayed ceiling/expiry must be explicitly confirmed before invoking
`pptEditorTtsSubmitConfirmed`. Quote tokens stay in a bounded Main-only cache;
Renderer receives an opaque quote ID, intent, model/voice, ceiling and expiry.
Main binds confirmation to the authenticated project/intent/request hash, rejects
missing/expired/foreign confirmations before the durable begin checkpoint, and
consumes the quote before dispatch. Restart requires a new quote for a prepared
intent. Existing unknown/submitted intents are read, never re-posted. Legacy
submission APIs remain for existing callers; this new UI uses confirmed submission
only. Voice/segment/model changes, page/revision changes and auth events clear the
visible confirmation. A lost submission receipt refreshes existing journals rather
than automatically generating another request. Existing query/archive/adopt controls
remain the way to retrieve and apply finished audio.

Targeted coordinator/transport tests and component handler tests verify these
transitions using test doubles; they do not prove live platform/provider playback.
Actual configured platform/provider acceptance is still required.

## A32 — authenticated reads of existing team assets

Main's existing `DesktopAuthSession.coursewareMedia` additionally exposes
`downloadTeamAsset(teamAssetRef, signal?)`. It accepts only the canonical strict
remote team ref. Before any asynchronous work it captures immutable pins and
the owning auth profile. It queries
`GET /courseware/team/projects/{projectId}/assets/{assetId}`, requires all fresh
metadata pins to match, then reads the derived `/content` endpoint. Every read
uses a fresh current access token, omits cookies/cache, refuses redirects and
rechecks the account after streamed reads. A JSON error on the content route is
handled as a sanitized platform error; MIME, length and SHA256 must match the
pins. Metadata is capped at 64 KiB and content at C's 16 MiB limit. The caller's
ref is never mutated and changed server metadata never replaces its pins.

Team/media reads issue GETs only; existing login/refresh keeps its own protocol.
There is no share/adopt, task submission, retry, receipt or fee operation.
Every invocation reauthorizes; identical bytes under another asset ID still
require that asset's own reads. Server membership remains authoritative. A later
revocation blocks the next request; it cannot revoke already downloaded bytes.
The remote team project UUID does not establish a local project association.

`DesktopAuthSession.resolveTeamSceneImages(refs, signal?)` is the Main entry. It
validates/captures the bounded canonical refs and owning account before loading
the PNG module, then calls the existing authenticated reader and
`resolveCoursewareTeamPngs`. The caller cannot supply another account guard. No
renderer IPC or model capability is registered.

`resolveCoursewareTeamPngs` is a private Main helper for an already selected batch
and the owning account guard from `getCoursewarePrincipal()`. It captures the
reader/guard/refs, caps the whole operation at 30 seconds and accepts at most 202
distinct asset IDs, PNGs up to 8 MiB each and 32 MiB unique content. Hash aliases
merge only after their own authorized reads. It verifies present dimensions,
derives missing dimensions from the actual PNG header and runs A31's real
bounded Electron decoder before returning image inputs. The batch is bounded
to 32 Mi decoded pixels / 4096 per side; account changes, aborts and malformed
bytes reject. MIME declarations alone never grant a decoder bypass. Native
source/current-page ownership and user approval remain the coordinating caller's
responsibility. Returned buffers are not an ongoing account grant: the generation
coordinator must retain its original principal guard through model work and
candidate review/adoption. No renderer/model tool can invoke this reader directly.

The retained actual C4 PNG has a valid SHA256/length but an incorrect IDAT CRC.
Electron refuses it. A32 keeps those exact bytes and metadata as a codec
negative; an in-memory CRC-only diagnostic isolates the failure and proves a
repair changes the pinned hash. It is never silently repaired or adopted. The
positive Electron/auth/model test uses a separate nativeImage-generated PNG
with a different explicitly synthetic asset ID and hash. Therefore C's archived
`ready` state and valid metadata do not prove Main scene usability. Actual C4
WAV bytes and metadata are also consumed by the generic read transport.

No new Spring/provider run, real team-account permission or real model output
is claimed: transport gates use actual C4 response bytes and local authorization
responses. They exercise actual DesktopAuthSession, Electron net.fetch, PNG
decode and pi-ai image wire input. Production team selection/sharing UI,
team-to-local binding, durable Host asset use/snapshots, visual-master/clean-plate
production and public Chat redo remain subsequent gates. JPEG/WebP transcoding,
video/music/effects and complete package/installer acceptance remain open.

The original `DesktopAuthSession.coursewareMedia` TTS path is Main-only and finite. It uses
the existing configured platform root and `resolveAccessToken`, including stored
refresh-token recovery. No vendor key, token, arbitrary URL, local path, generic
HTTP endpoint or generation IPC is exposed to the renderer or model.

The methods are `submitTts(idempotencyKey, request, signal?)`,
`get(taskRef, signal?)` and `download(taskRef, signal?)`. Submission accepts only
`kind=tts`, model, exact nonblank input (at most 4000 UTF-16 units) and optional
voice. It preserves whitespace and Unicode and rejects malformed surrogate
strings. Its SHA-256 request hash matches C's Java length-prefixed UTF-16/UTF-8
algorithm, with absent/null voice both represented as null. Model admission,
voice/provider capability, authorization, reservations and charges remain server
decisions; a successful transport does not certify speech quality.

The caller supplies an already retained idempotency key. The client never
generates a retry key, submits during query/download or automatically retries a
POST. A network error, timeout or cancelled local wait can occur after server
acceptance. Persisting the intent before submission and recovering the same key
are mandatory for the coordinator. A20 provides the private Host journal below;
the transport alone does not provide persistence. `submission_unknown` and `archive_failed` remain
queryable; neither means permission to create a new paid task. Remote
cancellation is not inferred from aborting a local wait.

Only exact `courseware-media-v1` responses and canonical task references are
accepted. Task/key/hash (and model on submit) must match. Ready TTS requires a
settled receipt and a bounded WAV/MP3 asset. Download first queries the authorized
task again, then uses its finite task asset route under the configured platform
root. A supplied foreign `downloadPath` rejects and is never followed. Format,
byte length and SHA-256 must match the authorized reference. MIME/hash agreement
does not prove codec validity or playable generated speech; the downstream
decoder/player still validates it.

HTTPS is required except loopback HTTP for local validation. Credentials in the
root URL, queries/fragments, dot-segment task IDs and redirects reject. Every
request resolves a current platform token, omits cookies and disables cache.
Account/profile identity is checked before dispatch and after each streamed read;
sign-out or account replacement invalidates late results. Tokens can rotate for
the same profile. No operation can undo a server submission accepted before
sign-out. JSON is capped at 64 KiB and audio at C's 16 MiB cap, including chunked
bodies. Network waits have a 30-second timeout and optional abort signal; existing
login/refresh resolution must finish before dispatch and is checked again for
cancellation. Stable
local/HTTP/business error codes omit remote error messages and credential-bearing
URLs.

The verified path uses the actual DesktopAuthSession and Electron `net.fetch`
against a loopback platform stand-in. A retained actual C Spring response is
also consumed byte-for-byte. This is not a live Spring/llm-ha/provider integration
run. The fixture is transport evidence only: its mock MP3 payload is not speech.

No Host asset record, teaching action, preview readiness rule, SQLite schema or
canonical courseware contract changes in A19–A21. A22 adds private audio receipts
and explicit teaching attachment below. A21 adds finite task-status IPC
below. A18 continues to block every
speech-bearing preview until trusted audio ingestion, durable intent/recovery,
source/teaching/text/voice binding and narrated build/play are verified together.

## A20 — private Host TTS request journal

Host reuses SQLite `kv` namespace `coursewareTtsIntents.v1`; schema 18 and protocol
11 stay unchanged. Five finite internal Main-to-Host methods are available. None
is registered as renderer IPC or a model tool. No method makes a network call,
archives audio, changes teaching or grants publication authority.

| Method | Strict parameters |
| --- | --- |
| `courseware.tts.prepare` | `{sessionId,selection}` |
| `courseware.tts.get` | `{sessionId,projectId,principalKey,intentId}` |
| `courseware.tts.list` | `{sessionId,projectId,principalKey}` |
| `courseware.tts.begin` | Same as `get` |
| `courseware.tts.bind` | Same as `get`, plus `taskRef:{taskId,idempotencyKey,requestHash}` |

`selection` contains `intentId`, `principalKey`, `projectId`, `pageId`, `actionId`,
`expectedSourceRevision`, `expectedTeachingRevision`, `model` and optional `voice`.
Identifiers are bounded ASCII; voice uses at most 64 ASCII letters/digits/`_`/`-`.
`principalKey` is a lowercase SHA-256 hex string, reserved for Main's derivation
from the configured platform root plus tenant/user identity. It is local account
partitioning, not server authorization. A21 wires the trusted Main caller below.
Host derives workspace from the persisted session and derives exact speech
text from the stored page/action. Caller-supplied input, workspace, URLs, paths,
tokens and unknown fields reject. Rust text is valid Unicode; its limit/hash use
the server's UTF-16 length semantics.

`prepare` stores the exact request, source hash/revision, teaching revision,
logical page/action and a fresh UUID idempotency key before acknowledgement. Same
intent ID plus identical selection returns the retained request/key, even if it
is now stale. Reusing the ID with different selection rejects. A genuinely new
explicit generation action needs a new intent ID and intentionally gets a new
key, including regeneration of unchanged text. Main must preserve that action ID
across local uncertainty; it must never manufacture a new one during recovery.

The phases are `prepared` → `submission-unknown` → `submitted`. Before any paid
POST, Main must call `begin` and receive success. Host checks exact current source
hash/revision, teaching revision, page/action/text and unlocked page; source
adoption also blocks a new preparation or dispatch. `begin` durably records
uncertainty before network dispatch. Repeating `begin` for an unknown submission
retains the same key and still requires current content; it does not authorize
an automatic retry. Submitted requests reject `begin` and must be queried.

`bind` records only the canonical task reference after dispatch. Wrong hash/key,
binding before `begin`, or replacing an existing task rejects. An identical bind
is replayable. Late valid references remain retainable after content changes;
they cannot modify teaching or make stale speech current. Responses to
prepare/get/begin/bind are `{intent,current,audioReady:false}`. List returns
`{intents:[...]}` summaries including selection, phase, hashes/key/task reference
and current status, without request input. Recovery reads remain available while
source adoption is pending. Each account/project journal is bounded to 1000
intents; reaching the cap rejects new generation, without deleting history.
Retention/compaction is not implemented.

Every successful prepare/begin/bind acknowledges only after the existing checked
FULL WAL checkpoint (`source_adoption_barrier`). A failed checkpoint may leave a
committed record; it does not give permission to dispatch. Retry/recovery uses
the same intent/key. Ignored/failed SQL writes and corrupt retained requests
reject. Tests include a pinned WAL reader, full reopen, workspace/account
isolation, changed teaching and actual Host termination with SIGKILL.

### Required server recovery extension

C's current `MediaTaskController` exposes submission, query by task ID, queued
cancellation and asset download. It has no read-only query by idempotency key.
If submission was accepted but the response/task ID was lost, a same-key POST
can recover an existing task **or create a task if the first POST never arrived**.
It is therefore unsuitable as a read-only recovery query, especially after the
content changed. The client must retain unknown state and not automatically POST.

C must supply a strictly authenticated lookup by retained idempotency key plus
request hash, scoped to the same tenant/user. Found returns the normal canonical
view; absence and mismatched/foreign scope have explicit non-creating outcomes.
Lookup must never reserve points, submit provider work or generate an ID, and
must have concurrent-request/restart tests proving that. Endpoint and wire shape
remain C-owned and are not invented by A20. Until it exists, lost-ID unknown
requests remain a visible recovery gap. A20's fixture task reference is not an
actual server task or generated audio.

## A21 — finite Main orchestration

`CoursewareTtsCoordinator` is instantiated by the existing PPT editor IPC
registrar with the existing teaching coordinator and DesktopAuthSession.
`ttsContext` requires a retained current-page teaching view and exact teaching
revision. It reuses the saved-source hash, native document/revision, page/edit
generation, owning Chat, Host and workspace checks; it never accepts a renderer
project/page/source path or speech input. A changed pin or hidden editor rejects.

The Main-only account key is SHA-256 of the UTF-8 JSON array
`["courseware-principal-v1", normalizedPlatformBaseUrl, tenantId, userId]`.
Tenant/user IDs must be positive safe integers. The same account/platform gets
the same key after restart; the captured profile object additionally fences
logout/re-login and account replacement during a request. Token rotation for the
same profile is allowed. Neither key nor credential is returned through TTS IPC.

Four finite main-window-only channels are allowlisted under
`deckwise/ppt-editor/tts/`. All require exactly the following fields:

| Operation | Parameters | Behavior |
| --- | --- | --- |
| `prepare` | `{viewId,expectedTeachingRevision,actionId,model,voice}` | Main generates an explicit intent UUID; Host derives/persists exact speech and key. No network submission. `voice` is null or a bounded voice ID. |
| `submit` | `{viewId,expectedTeachingRevision,intentId}` | Only a current `prepared` intent can start; durable `begin` must acknowledge before one application-level submission. |
| `status` | Same as `submit` | Read journal, query an already bound task if present, then reread journal. Never POST. |
| `list` | `{viewId,expectedTeachingRevision}` | Read account/project journal, return only current-page summaries. Never POST. |

No model tool invokes these operations. Model/voice admission and charging remain
server decisions. The renderer can select model/voice identifiers, never a
vendor, endpoint or key. The renderer API is wired, but this checkpoint adds no
generation button or fee confirmation UI; those must precede user-facing paid
generation. Preparation alone cannot charge. A lost preparation response is
recoverable through `list`; it must not be handled by preparing again silently.

Overlapping submissions of the same scoped intent reject locally. A restarted
coordinator reads persisted phase first. `submission-unknown` without a task ID
returns unknown without another POST; a bound task only uses GET. New
preparation always means a separate explicit generation intent and a new key.
There is no timer, background poller or automatic regeneration. Repeated submit
on unknown/submitted state performs the same read-only behavior as status.

The HTTP implementation may replay a request internally after a connection
failure, even though Main calls submit only once. Every such request carries the
same durable key/hash. Server idempotency, not a claim of exactly-once HTTP,
must prevent duplicate reservations/provider work. Actual Electron testing
observed this on an early socket close. A response truncated after headers
provides the verified lost-response recovery scenario.

A valid response binds the canonical task reference before checking whether the
editor is still current, preserving late receipts without overwriting teaching.
If the transport itself rejects on account replacement or a bind acknowledgement
is lost, unknown recovery remains subject to C's missing key lookup. Source or
teaching edits after dispatch cannot undo accepted provider work. A late query is
reread against Host currentness; it cannot make old speech current.

Renderer results contain only intent/page/action/model/voice, journal phase,
currentness, `audioReady:false` and optional server state/fee amounts/error code.
They omit request text, account partition key, idempotency key, request hash,
task/asset IDs, URLs, paths, receipts and credentials. Even server `ready` does
not download, decode, archive or attach audio and cannot unlock preview.

Verification uses actual Electron `net.fetch`, actual DesktopAuthSession and
Main teaching/TTS coordinators, a real Host/parser, a loopback platform stand-in
and a controlled native-editor context. Full Host restart preserves unknown
submissions; teaching edits during dispatch retain stale receipts; another
account cannot query the old journal. This is not an actual Office UI,
Spring/llm-ha/provider, generated-speech or narrated-playback acceptance.

## A22 — private Host audio archive and explicit adoption

Three finite Main-to-Host methods reuse the Host content-addressed asset archive
and the private `coursewareTtsAudio.v1` kv namespace. Schema 18 and protocol 11
are unchanged. No renderer IPC, model tool, network request or fee is added.

| Method | Strict parameters |
| --- | --- |
| `courseware.tts.audio.stage` | `get` scope from A20, plus `audio` and `bytesBase64` |
| `courseware.tts.audio.get` | `get` scope from A20 |
| `courseware.tts.audio.adopt` | `get` scope, plus `expectedTeachingRevision` and nullable `expectedAudioAssetId` |

`audio` contains the exact retained `taskRef`, SHA-256, `mimeType`, `byteLength`
and `durationMs`. Only WAV/MP3 up to 16 MiB and positive decoded duration up to
24 hours are accepted. Main must supply duration measured by actual audio
decoding, after the authorized download; a server duration, extension, MIME or
magic header does not prove playability. That Main decoder/caller is not wired
in A22. Host validates ownership/task binding, bounded Base64, length, format
header and hash, then syncs immutable archive bytes before retaining metadata.
Existing corrupt archives reject instead of being overwritten. Staging does
not change teaching, even if its source/speech is stale. Same-task identical
metadata is replayable; different audio rejects.

Get verifies archived bytes on every read and returns asset metadata and a
Host-owned path to trusted Main only. The asset ID is `tts-<sha256>`. Paths,
audio bytes and private task references must not be exposed as arbitrary
renderer/model file access. Workspace is always derived from the persisted
session; account partition remains Main-derived and is not server authorization.

Adoption verifies archive integrity, exact original source hash/revision and
speech action ID/type/text, an unlocked page, the fresh current teaching revision
and expected previous audio ID. Existing legacy `audioId/audioUrl/audioData`
requires explicit migration and rejects here. It changes only the selected
speech's `audioAssetId`, returns the page to review and preserves all cues,
pauses, effects, other actions/pages and source bytes. Project mutation and the
adoption receipt commit in one SQLite transaction with checked writes/readback.
Source adoption blocks attachment but not receipt recovery.

The fresh adoption CAS deliberately differs from the intent's original global
teaching revision: attaching one speech changes that revision and must not force
another already-generated speech to be purchased again. After unrelated teaching
edits, trusted Main must explicitly obtain/review a current view before adoption;
unchanged source/text and previous audio remain mandatory. This is no authority
for an old asynchronous response to attach itself automatically.

A lost adoption reply replays without a second project mutation, provided current
source/text/audio still match the adopted receipt. Replacing the binding or
changing speech/source rejects replay. Successful stage/adopt acknowledgements
require the checked FULL WAL checkpoint. A checkpoint error can occur after
commit; read/retry the same receipt, never create another paid task. Orphaned
archive files can remain after a failed metadata save; reference-aware cleanup
is still pending.

All results retain `audioReady:false`. Synthetic PCM Host tests cover archive,
ownership, atomicity, stale/locked rejection, SIGKILL/restart and corruption;
they do not certify generated speech or actual codec decoding. The A18
speech-preview fence stays in place until Main decoding, binding invalidation,
snapshot asset capture and narrated build/player acceptance are connected.


## A23 — Main decoded audio ingestion

A fifth finite main-window-only channel, `deckwise/ppt-editor/tts/archive`,
accepts exactly `{viewId,expectedTeachingRevision,intentId}`. It uses the same
saved-source, current-page, owning Chat and captured-account checks as A21.
The renderer API is wired; no generation button, fee UI or model tool is added.
No caller can supply bytes, paths, URLs, duration, private task references or
account keys. The response is only
`{intentId,archived:true,durationMs,audioReady:false}`.

Main first reads the private intent and checks its project/page/account scope.
A bound task is required. It then asks Host for an already verified archive;
only `COURSEWARE_NOT_FOUND` permits download. Corruption, permission and I/O
failures propagate; they never trigger replacement. Existing archives recover
without HTTP, decoding, POST or another reservation, including after an uncertain
stage response or full Host restart. A historical intent can retain its archive;
archiving never claims that its speech is current or adopts it.

For a missing archive, the existing authorized media client retrieves the bound
ready task and bounded bytes, verifies MIME/size/hash and fences account changes.
Main checks model identity and editor/account currentness before decoding and
again before staging. Actual decoded duration replaces any server duration.
The exact task reference, hash, MIME, byte length and measured duration are sent
to A22's immutable Host archive. An editor/account change after staging may
reject the visible response even though the original partition retained bytes;
retry reads that receipt rather than submitting another generation.

The decoder uses Electron's bundled Web Audio codec in a hidden BrowserWindow
with an isolated nonpersistent session. It has no preload, Node integration,
credentials or network access, denies permissions/window creation/navigation/
webviews, and loads only one fixed data document with `default-src 'none'`.
OfflineAudioContext decodes bytes without an output device. WAV/MP3 header and
16 MiB input checks precede decoding; output duration must be positive and at
most 24 hours. One process-wide decode runs at a time; overlap rejects. A
30-second deadline, crash/closed rejection and finally-destroy bound worker
lifetime. Raw codec exceptions are sanitized. No ffmpeg runtime dependency is
added. The deadline/input cap are not a decoded-memory reservation; extreme
compressed files can exhaust the isolated renderer and must fail rather than
be attached. Platform/installer codec behavior still requires release testing.

Archive calls for the same scoped intent cannot overlap. They never submit a
provider request, mutate teaching, attach audio or unlock playback. Lost-ID
requests still need C's non-creating idempotency-key lookup. Explicit Main audio
adoption, stale-binding cleanup, generated-asset snapshot capture, visible
fee/generation controls and narrated playback remain separate required work.
Every result keeps `audioReady:false`; A18 remains fenced.


## A24 — Main explicit audio adoption

A sixth finite main-window-only channel,
`deckwise/ppt-editor/tts/adopt`, accepts exactly
`{viewId,expectedTeachingRevision,intentId}`. Main requires the same current
saved-source, owning Chat, editor page/generation and captured account context
as archive. It reads the durable journal and private Host archive; only a
submitted task with matching project/page/account/task reference and verified
`tts-<sha256>` archive asset proceeds. The renderer cannot supply action ID,
speech text, source, previous audio ID, asset ID, bytes or revision overrides.

Main delegates the mutation to the teaching coordinator using its pinned page.
That coordinator finds the selected speech action in the exact current page,
derives the expected previous audio asset ID (null when absent), rejects locked
pages, malformed/legacy audio and non-speech actions, then calls Host with the
current teaching revision and source/project/account/intent scope. Host remains
authoritative: it checks the archived file, original saved source and source
revision, exact generated speech text, page/action and previous audio CAS. It
atomically attaches only the selected `audioAssetId`, marks the page for review,
preserves all other actions/cues/pages and records the adoption receipt.

Main checks the returned full project against the retained project/source and
selected action/asset before replacing its pinned view. The renderer receives
the ordinary updated teaching view; private audio path/task/hash metadata do not
come from the adopt result. An acknowledgement lost after Host commit is
recovered by reopening the saved project and retrying the same intent; Host
returns the existing receipt without a second revision. Replacing that binding
or changing speech/source blocks replay. A page/editor/account switch during
the request cannot update the new pin; the Host mutation remains attached only
to its original logical action and the next view reloads persisted truth.

Adoption does not generate audio, modify PPTX bytes, make a snapshot, set
`audioReady`, or unlock preview. Changing the narration through the existing
teaching editor clears `audioAssetId` and associated duration/cues before its
write, so old audio is not carried onto different speech. UI confirmation,
visible fee/generation controls, actual snapshot audio assets and narrated
playback are still separate; keep the A18 speech-preview fence.

## A25 — Adopted audio in immutable snapshots

The existing snapshot IPC keeps its exact retained-view payload. Main derives
every speech action across all pages from the saved teaching pin, then resolves
its `tts-<sha256>` asset through the signed-in account's private Host journal.
Only submitted intents with the exact page/action, source hash, speech text,
task reference and adopted archive receipt qualify. Missing, replaced, stale or
foreign audio rejects the complete capture; Main does not download, decode,
generate, reserve points or silently omit speech. Assets are deduplicated by
immutable ID. No-speech snapshots retain their existing login-independent path.

Internal Host snapshot assets now accept exactly one source: the existing
bounded workspace `path`, or `tts:{principalKey,intentId}`. A TTS selector is
resolved by Host in the persisted session's workspace/project partition. Host
requires an adopted receipt, the current source hash and matching current
speech text/action/audio binding, exact asset ID/hash/MIME, and verified archive
bytes. Main cannot use this selector to import an arbitrary absolute path.
Existing path callers and persisted snapshot records remain compatible.

The snapshot stores only frozen asset metadata alongside source, teaching and
mapping. Account/intent selectors and archive paths are not persisted in the
snapshot or returned to the renderer. Trusted Main export still receives
hash-verified local paths for the fixed builder. Current-view checks and fresh
saved-source parsing/CAS remain mandatory, with account checks immediately
before capture and after its reply as well.
This checkpoint validates capture,
not narrated build/player acceptance or visible generation controls; every TTS
result keeps `audioReady:false`, and the A18 UI speech fence remains in place.

## A26 — Fixed narrated preview

A25's adopted-audio snapshot now passes through the existing Main fixed builder,
actual offline converter and isolated Desktop player. The build reads frozen
teaching/assets even after live narration changes; exact warning approval and
all package/asset hash, ownership and cancellation checks remain in force.
Native WAV `playing`/`ended`, page navigation, tampered-byte refusal, Chat change,
main reload and Host-exit cleanup are verified against the adopted snapshot.
The fixture is a synthetic 100 ms WAV from a loopback platform, not evidence
of live provider speech, quality, billing or installation.

The existing preview button now enables for confirmed drafts whose every speech
has an apparent content-addressed TTS ID. Missing/malformed IDs on any page still
disable it and explain the requirement in all eight locales. This UI check does
not grant audio authority: the unchanged capture path revalidates the exact
source/text/account/adopted receipt and actual bytes. Errors remain visible and
do not start a build. Canceling a pending capture prevents a late build.

This supersedes the earlier blanket A18 speech-preview fence only for validated
adopted audio. TTS task/archive views still report `audioReady:false`; those
views alone never certify a preview. Visible paid-generation/fee confirmation
remains pending C's quote contract; A27 adds independent existing-task controls.
Fixed local
preview does not publish a team/platform course or certify native PPTX effects.

## A27 — Existing-task controls in the teaching panel

The existing page narration sidebar owns a compact audio task section, not a
separate assistant. It uses the existing finite list/status/archive/adopt IPC
with only the retained view ID, expected teaching revision and selected intent
ID. There is no new transport, path, credential, automatic polling, preparation,
submission or idempotency-key replacement. The initial list is explicit and
scoped to the current page/account. Previous reserved/actual points appear only
after a status query; they are historical task costs, not a generation quote.
Prepared and unconfirmed submissions cannot be retrieved. Querying an unknown
submission never POSTs or infers that a charge was cancelled.

Retrieval validates and stores audio without applying it. Only after a successful
archive response does an unchecked confirmation expose explicit adoption of
that exact segment, replacing any previous audio. A locked page or removed
speech segment cannot be adopted. `current:false` warns rather than categorically
disabling adoption: adopting another segment advances the global teaching
revision, and Host may still accept this request after fresh source/text/previous
audio checks and current teaching CAS. The UI never overrides those checks.
No task/archive response alone sets preview readiness. Successful adoption
reloads the returned teaching state; page review is required before preview.

While a task request runs, parent teaching edits, page loading, locking, candidate
operations and preview are disabled. The task child remains enabled for its own
completion. Draft edits, editor disablement, view/revision changes and auth
events clear private rows, archive markers and confirmation, invalidate pending
callbacks and release the parent busy state. Cleanup unsubscribes from auth
events. Late status/archive/adoption replies cannot apply to a new view/account;
an already committed Host action is not rolled back by dismissing its result.
Reloading the saved page remains the way to reconcile persisted truth.

The seven real React parent/child interaction groups complement the actual
Electron/Main/auth/Host/parser/decoder gate. Only preload replies are replaced
in the component gate; neither gate claims a generated speech quality test,
actual Office plus task-control integration, live paid billing or installation.
Paid submission awaits a non-reserving quote with submit-time price/expiry
validation. Lost task-ID recovery awaits non-creating lookup by the retained
key; neither is replaced by a client price or automatic resubmission.

## Courseware media canvas drafts (W15.1)

The existing Main Chat may revise the selected canvas draft's title, prompt or
reviewed-reference metadata through `courseware_canvas_get` and
`courseware_canvas_edit`. These Agent tools dispatch through the existing Host
permission/audit path; Host binds reads to the local courseware task, owning
session and workspace, and requires Agent mode for writes. Writes require both
the document revision and selected draft revision,
and return the persisted document for exact verification. They cannot create
assets, call suppliers, spend credits, or edit slides. Canvas draft state is
Host-persisted and survives restart; it remains separate from the private image
archive, generation receipts, teaching narration and PPTX.

Canvas draft tools remain available when the task has an active WiseOffice
document. Office edits still require their existing native context and fresh
edit generation; a draft change grants no slide-edit capability. Submitting a
canvas draft through the current Main Chat keeps its visible canvas tab open
in that same session, so the saved result refreshes after the turn. Normal
generation and native Office routing retain their existing behavior.

Renderer changes are scoped to the active Chat and use Host CAS persistence.
Unsaved writes block Chat submission; failed saves retain the local draft and
require explicit retry or confirmed discard. Reviewed references are loaded
only by explicit user action from the current task's selected archived scene
images. They are metadata references, not provider authorization or bytes.
This is a prompt-planning surface only: image/video/music/sound generation,
supplier billing, asset adoption, slide insertion and playback are not part of
W15.1. Local component/Host tests do not prove packaged Electron interaction.
