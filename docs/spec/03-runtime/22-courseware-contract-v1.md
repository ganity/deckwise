# Courseware contract v1

The shared TypeScript source is `packages/shared/src/courseware-contract.ts`; fixtures are in its sibling `courseware-contract.fixtures/` directory. `schemaVersion` is `deckwise-courseware/1`.

Status: shared consumption contract, Host storage/RPC, saved-source teaching UI and explicit human review of saved-source changes implemented. Automatic cross-save lineage, immutable snapshot storage/export, generated-candidate storage/adoption and full Desktop composition remain pending. Native Chat integration is described in [23](23-courseware-native-chat.md).

## Scene planning drafts

Reviewed scene generation preserves an immutable semantic object map in the
existing Host database. Compiler shape IDs come from exported OOXML, not array
positions; Host validates them against the saved parser identity and approved
plan before association. The teaching view can include current-page
`teachingObjects` with canonical `objectId`, display name/role, spoken aliases
and an explicit mapping status. Main projects only these bounded fields from
Host context; generation prompts and archive paths remain private. Missing or
changed objects cannot be represented as confirmed associations. Old projects
without this optional record remain readable. The side panel shows review
status; highlighting, spotlight authoring and automatic narration alignment
remain separate capabilities.

Before opening a generated PPTX, a selected `scene` task can plan and revise
its lesson through the existing Main Chat and pi tools. The Host-selected
artifact is `.deckwise-ppt/scenes/<sessionId>/plan.json` inside that persisted
session's workspace. It is an editable generation artifact, like ordinary
generation's SVG files, not a second authoritative teaching record or an
approved media request. It survives restart through the existing workspace and
session persistence; Main never creates a second database for it.

The JSON has exactly `{title,pages}`; each of 1-30 pages has exactly
`{title,visibleText,visualIntent,narration}`. Titles are nonempty and at most 200
UTF-16 units, visible text has at most six nonempty strings of at most 160 units,
visual intent at most 1000 and narration at most 2500. The UTF-8 file is bounded
to 256 KiB. Reading uses the same strict parser as initial model planning,
derives draft-only page identifiers/content hashes and returns a raw-file
SHA-256. These provisional identifiers are not canonical Office page IDs.

The main-window-only `deckwise/courseware/scene-plan/read` takes exactly
`{sessionId}` and returns `{plan: CoursewareScenePlanSnapshot | null}`. A missing
file returns null. Main obtains task and workspace from the persisted Host
session, allows only an ungenerated `scene` task, derives the exact current-Chat
path, rejects redirected paths/symlinks, nonfiles, malformed/oversized/non-UTF-8
JSON, and rechecks file/task identity before returning. No caller file path,
credential, media submission or project mutation is accepted. The normal
preload allowlist and sender checks apply.

`deckwise/courseware/scene-plan/approve` takes exactly `{sessionId,sha256}`,
where the hash is the raw-file hash returned by the current planning read.
Main revalidates that draft; Host independently reopens the exact owning file,
bounds and validates its content, and rejects a different hash before storing
anything. This explicit workbench action is not exposed as a model tool and
never submits media. A stale caller receives conflict rather than confirming
unreviewed content. Unknown fields, caller paths and extra arguments reject.

Host `courseware.scenePlan.approve` persists `{sha256,plan,educationContext}` in
the existing `coursewareScenePlans.v1` kv namespace, keyed by canonical workspace
and durable Chat ID. `courseware.scenePlan.get({sessionId})` returns
`{approval:record|null}` for that scene task. The stored plan is a content
snapshot; later Chat file edits do not mutate it. Reapproving the same bytes is
idempotent. A later explicit approval replaces the current checkpoint only
after revalidation. This does not create an approval-history or media-task API.
An approved task cannot change type or teaching context. No database schema
migration or second database is introduced.

The readable draft adds `approvedSha256:string|null`. The UI marks the current
draft approved only when it equals the current raw-file hash; a later file
edit shows that review is required again. The previous checkpoint stays intact
on malformed edits or rejected approval. Full restart restores both states.
Approval alone is not a paid request, asset assignment, generated PPTX or
canonical Office-page identity.

The workbench displays page text, visual intent and narration. Initial and
page-specific changes submit to the existing Main Chat with a readable request
and page number/title. Paths, hashes and serialization instructions stay in
Main's model policy, not the visible user message. Normal permission,
Plan-mode, cancellation and file-edit rules still apply. Late UI reads cannot
update a different Chat. A page-specific prompt asks to retain other pages and
read the latest file; this is model guidance, not a new transactional file-CAS
guarantee. Invalid edits are shown as errors rather than accepted plans.

Planning availability does not enable layered media generation or PPTX
compilation. The `generate` phase still requires an available scene pipeline;
no ordinary-generation fallback is permitted. An attached generated source
requires reopening WiseOffice and the latest PPTX/teaching edit path. Asset
review, paid tasks, durable asset-task associations and complete scene compilation
remain separate subsequent stages. Age/subject guidance comes from the task's
saved education context; choosing `scene` alone never implies kindergarten.

## Recovering deleted-page narration

After explicit saved-source association removes a logical page, its old
teaching remains in the existing Host history. The current-page side panel can
read up to 20 recent deleted-page versions, preview their text, pauses and
teacher-continue checkpoints, and explicitly copy one into the current page's
local draft. The destination must be unlocked and contain no existing teaching
other than independent music clips, with no pending draft/request. Existing
music clips remain after the recovered narration. Saving narration is a separate
explicit action through the existing revision-checked write; reading history
or copying its text does not mutate authoritative teaching or PPTX bytes.

`deckwise/ppt-editor/teaching/history` takes exactly `{viewId}` from the normal
main-window sender. Main derives the saved session/job and rechecks workspace,
source, page, editor ownership and the complete teaching baseline before and
after reading. The preload's derived invoke allowlist includes this channel;
the renderer never supplies history paths or project selectors.

Host `courseware.teachingHistory.list({sessionId,jobId})` is read-only. It uses
the persisted session workspace and verified saved-job seed, requires the
current source hash/page count to match, and queries only that workspace/project
history key range in bounded batches. It returns exactly
`{entries,skippedEntryCount}`. Each entry has `teachingRevision`, `sourceRevision`,
`pageId`, historical `pageNumber`, `actions`, `omittedAudioCount` and
`omittedCueCount`. Current logical page IDs are excluded. Stored identity/JSON
corruption fails closed. Legitimate unsupported or over-budget page versions
are omitted whole and counted, rather than partially recovered. The list has
at most 20 entries and a 2 MiB serialized response budget.

Recovery projects only speech text (at most 32,000 UTF-16 units), optional
`source` (`notes|external|original|light_rewrite|generated`), optional integer
`pauseAfterMs` (0–30,000), explicit `delay` nodes and `teacher_continue` checkpoints. All action and
checkpoint IDs are newly assigned. Historical speech audio, independent audio
clips, highlight/spotlight bindings and other timing/object metadata are never
rebound. The preview names these omissions. Users must regenerate/review audio
and effects before confirming a new playback snapshot. This recovers teaching
text onto an explicitly selected destination; it does not restore the deleted
slide's visual contents or replace Office Undo.

## Stable identity and revisions

- `projectId` identifies the local courseware project. `taskType` is `plain`, `scene`, or `import`; age, grade, and subject are context and do not choose the task path.
- Optional `educationContext` preserves MAIC's `schoolStage`, `grade`, `subject`, `customSubjectName`, `textbookVersion`, `chapter`, `lessonType` and `fullEnglishTeaching`. Missing context remains missing; no age/English policy is inferred from `taskType`. Provided text fields are capped at 500 UTF-16 code units, known optional fields may be omitted but not null, and unknown keys are rejected. The context survives page writes/locks and restart. It is immutable through the initial teaching RPC; a later context-change operation must advance the teaching baseline and invalidate affected candidates/audio.
- `pageId` is a stable logical ID owned by the project, not an Office slide index or native slide ID. Reorder preserves it; a copied/new page receives a new ID. If source lineage is ambiguous, do not attach existing teaching to a guessed page.
- Desktop additionally accepts optional `educationContext.visualStyle` under the
  same string/null/size guards. It stores the user's scene art direction; it does
  not choose the task route or grant image approval. Existing records omit it
  without migration. The matching updated Host is required to accept the added
  field; older strict readers may reject records that contain it.
- `source.revision` and `source.sha256` pin the current saved PPTX bytes. `teachingRevision` changes when page actions, lock, or review state changes.
- A page write carries both expected revisions. The Host accepts it only when both match and that page is not locked. A stale write must return conflict without changing the project.
- Teaching writes mark the changed page `review`; they preserve other page actions and source bytes. Lock changes also advance the teaching revision. Explicit unlock is required before a manual write; there is no model-side override flag.
- Candidate inputs pin project, source revision/hash, teaching revision, target logical page IDs, and output hash. Adoption must re-check the pin and editor clean/save state; generating a candidate never overwrites the opened source.
- A snapshot is immutable and pins source, teaching, mapping, and ready asset identities. A build reference points to the snapshot and immutable package hash; a task reference points to the server task and request idempotency key. Neither reference grants authority by itself.

## Host persistence and RPC

The existing Host-owned `kv` extension stores a bounded project record in namespace `coursewareProjects.v1`. Its key is the JSON tuple of canonical workspace path and logical project ID. There is no new SQLite database or `user_version` migration. Normal source/revision files remain outside SQLite. Creation is internal and refuses to replace an existing row; the editor coordinator must first verify saved source bytes and page lineage. Renderer/LLM project creation and source replacement are deliberately not exposed by these methods.

`courseware.project.get` takes `{sessionId, projectId}` and returns `{project: CoursewareProject | null}`. `courseware.teaching.write` takes `{sessionId, write: TeachingWrite}`. `courseware.teaching.setLock` takes `{sessionId, projectId, pageId, expectedSourceRevision, expectedTeachingRevision, locked}`. Mutations return `{project}` only after the SQLite update succeeds. All parameter envelopes reject unknown fields. All three methods require the normal handshake and resolve the workspace from the persisted session; no caller-provided workspace or mutable global selection is used.

The atomic SQL update compares the entire previous record, in addition to the source/teaching revisions checked in memory. Concurrent/stale requests cannot overwrite a newer record. `COURSEWARE_CONFLICT` and `COURSEWARE_LOCKED` use JSON-RPC code 1008; missing project/page uses 1007; invalid data uses 1002. A SQL failure is returned and preserves the previous record. This is process/restart persistence under existing SQLite WAL settings, not a new power-loss durability guarantee.

## Saved-source editor integration

`courseware.project.openSaved` accepts only `{sessionId, jobId}` from Main's
coordinator. Host resolves that persisted session's workspace, verifies that
the completed parser job belongs to it, and accepts only a saved archive under
`.deckwise-ppt/revisions/<documentId>/rNNNN/<file>`. It reopens the file safely
and checks its bytes against the parser hash before creating a project.
Project ID is `office-<documentId>` scoped to that workspace; page IDs are
Host-generated UUIDs. The initial task type is `import`; generation-specific
creation/context is a later coordinator entry, not inferred from filename.

This first UI integration intentionally reopens **only byte-identical sources**.
Changing source bytes or parsed page count returns `COURSEWARE_CONFLICT` and
preserves all existing teaching. Page ordinal maps to a logical UUID only
inside those exact saved bytes. Cross-save reorder, copied pages, replacements
and edited content require explicit review below or a future trusted lineage
flow, never ordinal-based automatic teaching migration. The local project is not
a published snapshot.

Main's `CoursewareTeachingCoordinator` owns the parser lifetime and a random
view token bound to the real Office session, saved hash/revision, current page,
edit generation and durable Chat session. Opening/changing the view, dirty or
uncertain native state, readonly, page/context changes and malformed extra
fields reject teaching writes. Renderer supplies only the view token, expected
teaching revision and actions/lock; it cannot select files or authoritative page
IDs. Existing Host revision CAS and page lock checks remain the write authority.
The native editor binding's workspace hash is **not** the courseware project ID,
and its random editor session is **not** the durable Chat session ID.

The existing editor has a page narration panel. At narrow widths it sits below
Office; in expanded editing it sits beside Office. The first load is explicit;
afterward native navigation follows only without drafts, instructions, reviews
or active media operations. Saving refreshes the current native view and requires
the exact logical page and complete baseline before the existing teaching CAS.

Local recovery drafts use `coursewareTeachingDrafts.v1` in the existing Host
SQLite kv, keyed by canonical workspace, durable Chat, project and logical page.
`courseware.teachingDraft.get` takes `{sessionId, projectId, pageId}`;
`courseware.teachingDraft.set` additionally takes required `expectedRevision`
and `draft`, each nullable. A non-null draft contains the full baseline project,
bounded actions (including unfinished empty speech) and at most 4,000 UTF-16
instruction units; content is limited to 2 MiB. Writes require the exact current
baseline, unlocked page and prior draft revision. Null clears only the matching
draft revision. AppState serializes these operations. No project, audio,
snapshot, model or billing mutation occurs. This uses existing WAL restart
durability, not a new power-loss guarantee.

Main derives identities and baseline from its opaque teaching view; renderer
draft IPC accepts only that token, content and expected draft revision. Draft
storage does not require native page selection to remain fixed. On explicit
load, exact-baseline drafts recover as unsaved content. Stale/locked drafts are
retained and displayed for copying or explicit discard; they are never applied
to current teaching. Draft writes are serial and a visible status distinguishes
pending persistence, failure and acknowledged recovery storage. Formal teaching
still changes only through explicit Save narration and its existing guards.

An acknowledged recovery draft may remain while reviewing saved PPTX changes.
The review entry waits for serial draft persistence and refuses pending/failed
storage; it does not apply or clear the draft. Cancelling review permits explicit
reload of that draft. After explicit page association, an original logical page
retains its prior recovery record as stale, copyable content. A copied page has
a new logical ID, empty teaching and no inherited recovery draft. Reordered pages
keep teaching and locks only through their explicitly confirmed associations.

Manual editing preserves non-speech actions and speech IDs/voice/pacing. Changed
speech text removes its old audio references and audio-clock cue/timing fields;
the page becomes `review`. Regeneration/review is required before publication.
Lock is a separate persisted Host operation, with no AI call or speaker-note
mirror. Other locales currently use explicit English fallback copy for these
new labels; Simplified and Traditional Chinese are translated.

The same narration sidebar exposes each speech action's integer `pauseAfterMs`
(0–30,000 ms) and an explicit teacher-continue wait immediately after that segment,
including the final segment. Timing-only edits retain speech text, audio and all
other action fields; text edits keep the existing audio invalidation behavior.
Only bounded `interaction_checkpoint` actions with `checkpointKind: teacher_continue`,
`id` and `checkpointId` can be explicitly removed. Unknown checkpoint kinds or
extra fields remain visible as preserved actions without deletion controls.
These edits use the existing serial recovery draft and explicit Save narration
path, with unchanged editor, review, page-lock and source/teaching revision gates.
Pauses and waits are never narration text or TTS input; playback of a checkpoint
requires the teacher's explicit continue action rather than a timer.

The native WiseOffice teaching timeline also supports independent
`{id, type: "delay", durationMs}` nodes. Host accepts exactly these fields and an
integer duration of 0–30,000 ms. Delays can be inserted between any nodes, edited,
reordered and removed using normal teaching drafts/CAS and page-lock gates. A
delay consumes no TTS/media service. Editor preview and the fixed player share
the existing pausable timer: Pause freezes the remaining duration, Resume
continues it, Teacher Continue cannot skip it and Stop/navigation cancels it.
Fixed-build input and package loading validate the same bound. Historical-page
recovery assigns a fresh delay ID and retains its duration. Source review keeps
it without object mapping. Legacy speech `pauseAfterMs` remains unchanged; there
is no implicit migration before the new sidecar schema is introduced. Older
strict fixed players reject packages containing delay nodes rather than silently
omitting time; regenerate/use a current player for these packages.

The native teaching pane offers explicitly labeled **Undo unsaved edits** and
**Redo unsaved edits** for the current draft. They restore whole action payloads,
including original audio/cues when undoing an unsaved narration edit, and persist
the result through the existing serial recovery-draft CAS. They do not write the
canonical teaching project, submit media work or change WiseOffice native history.
A new edit discards redo. History retains at most 20 edits and 4 Mi UTF-16 units
per direction, and is cleared when loading/saving/adopting a new authoritative view
or changing native page/source context. Persisted recovery content remains, but
this in-memory undo stack is not restored after an editor restart. Controls lock
on draft errors and during mutations. Browser text-field undo retains its normal
meaning. This is not compound PPTX/teaching undo or saved-version rollback; those
still require Host operation receipts and native history correlation.

## Persisted saved-source identity baseline

`openSaved` also consumes the optional Host-verified D2f identity from its own
successful parser job. In one SQLite transaction it initializes the project
and stores a bound identity under `coursewareIdentities.v1`, keyed by canonical
workspace/project storage key and exact source SHA-256. Identity records are
bounded by 16 MiB, 100 pages and 10,000 total objects. Page logical IDs come from
the canonical project; object IDs and `mappingRevision` are Host-generated UUIDs.
Worker/import/native IDs remain lookup keys inside those exact source bytes.

Byte-identical reopens preserve every logical ID and mapping revision. A legacy
project can attach its first identity without changing page IDs, narration,
locks, or teaching revision. Incompatible identity output for the same bytes
returns a conflict; this review cannot repair incompatible exports for identical
bytes or overwrite the baseline. A failed identity insert rolls back a newly
initialized project too.
Records outlive parser release and Host restart. Older workers can reopen the
project without deleting its existing identity; no schema migration is added.

No new renderer/Agent RPC accepts identity JSON, mapping IDs, paths, lineage or
replacement bytes. The existing strict `openSaved` request remains unchanged.
The baseline alone does not authorize changed-source adoption; the explicit
review below is a separate operation. Generated-candidate adoption and immutable
snapshot export remain unfinished. No highlight or spotlight targeting is enabled.

## Explicit review of an already-saved source

The existing narration sidebar offers **Review saved PPTX changes**. First save
Office's native edits through the normal editor Save flow. Reviewing never writes
or replaces PPTX files. It moves teaching to those already-saved exact bytes only
after a user explicitly chooses the association for every new page. All choices
start empty. Old page numbers label user choices; they are never evidence of
page identity or automatic matches. The previous narration is listed for review.

This operation supports speech actions with `id`, `type: speech`, string `text`
and optional integer `pauseAfterMs` from 0 through 30,000, or empty actions.
An optional `source: notes | external` records the user's selected narration
origin and is preserved exactly. Other origin values/types remain invalid.
A8 extends A4 to preserve these page-local pauses unchanged after explicit
association; the existing review UI displays each pause. Saved-source review may
also preserve a `tts-<sha256>` `audioAssetId` when Host verifies its previously
adopted private receipt against the old source, unchanged logical page/action,
speech text and asset. Host updates the receipt's optional `boundSource` in the
same transaction as source adoption; the original paid intent, request key,
task, account, voice and audio bytes stay unchanged. Missing/unadopted/mismatched
receipts or failed receipt writes roll back the complete adoption. Main and Host
snapshot capture both check the current source binding, including after restart.
Old receipts without `boundSource` retain their original source requirement.
Copied pages never inherit audio, and old fixed snapshots remain immutable.
Generated-source candidate adoption now supports the same previously adopted
TTS provenance, with a separate read-only preflight before live-file replacement
and atomic rebinding on commit; its finite policy remains independent of manual
source review. See [candidate audio preservation](25-courseware-source-candidates.md).
Manual saved-source review additionally supports bounded speech highlight and
spotlight cues after explicit per-target association. It returns the old cue
targets and current saved object inventory, requires a reviewed choice for every
target on its associated page, and derives fresh UUIDs transactionally. Choices
start empty; omitted cue-bearing pages, merges, unsupported kinds or incomplete
associations reject. Only target UUIDs change; speech, adopted audio, timing and
checkpoints remain exact. Source-copy redo/restyle still rejects cues pending
its own reviewed object migration. Voice settings, standalone waits, malformed
pauses and unknown action fields reject intact. No action is silently stripped. Associated
pages retain logical page IDs, narration and manual locks; new/copy pages get new
IDs and empty narration. Old pages may be associated at most once. Every locked
old page must be associated; there is no implicit unlock or lock override.
Unassociated old pages stay in the archived previous project. Every adopted page
is `review`, never publication-ready. Object logical IDs are newly allocated;
only explicitly reviewed supported cue targets are rebound to those new IDs.

`courseware.review.prepare({sessionId, jobId})` accepts only the same trusted
successful saved-revision parser seed used by `openSaved`. It requires both the
new worker identity and the previous Host-bound identity, and persists one
pending review per workspace/project in `coursewareReviews.v1`. The record pins
the complete previous project, mapping revision, new exact-source identity and a
Host review UUID. Identical preparation returns the same record. A changed
baseline replaces the pending review without changing the project. This record
survives restart; Main reparses and issues a fresh view token on UI reopen.
Unsaved UI association choices are not recovered after restart.

`courseware.review.adopt({sessionId, jobId, reviewId, bindings})` takes the pending
Host review UUID and an array of old logical page IDs or `null` (new page), one
entry per new page. Main derives those IDs from user-selected old-page indexes
inside its pinned review; renderer/Agent cannot supply project/page authority,
source paths, hashes, identities or lineage. Main rechecks the active Chat,
workspace, Host process, saved Office binding/hash/revision/edit generation and
current page for the final load, then runs a fresh parser job before dispatch.
The user may navigate slides while choosing associations. The native bridge also
advances its context generation on navigation/selection; that old value is not
used as a content-change signal across the review. The clean saved-snapshot fence
still rejects dirty/uncertain edits, changed source, readonly or binding. The
fresh adoption parse pins its own current context/generation. Context changes
reject and require a new review; this is not a retryable automatic adoption.

Host rechecks source bytes through that fresh job, complete previous project and
mapping revision. A stale source, teaching write/lock, different target identity,
duplicate/unknown page, missing locked page, or consumed review rejects. Returning
to an already-mapped historical source through Office undo is allowed only when
its fresh parser export exactly matches that immutable historical identity and
every explicitly associated logical page equals the historical page binding.
The historical identity is reused without rewriting it; incompatible page
associations reject. Current teaching is preserved, not restored from history;
all pages require review and attention targets still require explicit association.
One SQLite transaction archives the complete previous project in
`coursewareHistory.v1`, inserts a new bound identity only for a previously unseen
source, updates the canonical project using the existing full-record CAS,
allocates a fresh teaching revision, selects the saved source revision and
consumes the pending review with a record CAS. Failure rolls everything back.
Previous identity and PPTX revision archives remain unchanged. History currently
has no browse/restore UI or automatic retention pruning.

The UI has explicit association confirmation because it changes authoritative
teaching associations. Native Chat edits retain their existing Full auto policy;
this review is not a new permission prompt for Chat. B-generated candidate
generation/review/source replacement, automatic fingerprint/lineage matching,
audio/effect adoption, immutable snapshot/player and collaboration remain outside
this saved-source operation.

## Validation boundary

The [A5 narration-candidate store](24-courseware-narration-candidates.md) now
persists canonical teaching proposals separately and adopts one logical page
under full-project/source CAS. A6 adds explicit existing-sidebar review and A7
mounts single-page narration generation in the existing main Chat; their authority
and limits are documented there. PPTX/fade candidate file adoption remains separate.

Identifiers use 1–128 ASCII letters/digits/underscore/dot/hyphen; hashes are 64 hex digits. Records are capped at 2 MiB of JSON, 100 pages and 1000 actions per page, with unique logical page/action IDs. Project/source/page/write/reference envelopes are strict. MAIC action payloads retain their fields; this module checks unique bounded `id`/`type` envelopes. A valid envelope does not establish speech, effect, asset, timing or render support: B/D must run their action/build validators and C must authorize immutable asset retrieval. `reviewState=ready` alone never enables publishing.

`references.json` contains successful candidate/snapshot/build/task references. `checkCoursewareCandidate` checks the source hash/revision, teaching baseline, logical targets and editor dirty state. It is a preflight helper; adoption still needs host-owned clean/save state, verified output bytes, locked teaching protection and safe file replacement. `requestHash` matches C's task terminology. Provider task IDs, keys and temporary URLs do not enter public refs.

## Read-only team asset references (A32)

`CoursewareTeamAssetRef` / `isCoursewareTeamAssetRef` accept C4's exact public
`{projectId,assetRef}` response data. The project is a remote team project UUID,
not a local workspace/project identifier. The nested ref pins asset UUID,
lowercase SHA256, MIME, 1 byte–16 MiB byte length and the exact project/asset content
route. Images support PNG/JPEG/WebP metadata with optional positive integer
width/height; audio supports WAV/MP3 with optional nonnegative duration. Null,
unknown/private fields, cross-kind dimensions/duration, external URLs,
queries/fragments and mismatched routes reject. Missing optional metadata never
invents dimensions or duration. C4's PNG and WAV response fixtures are retained
byte-for-byte beside the existing contract fixtures.

This is structural validation, not membership, codec validation, a generation
request, an adoption instruction or permission to send assets to a model. Each
read must reauthorize through C. Main's authenticated transport pins a fresh
metadata read to the supplied immutable ref before fetching the finite content
route; it never follows a supplied URL or substitutes a changed hash. The
Main-only PNG resolver adds account/cancellation/budget and actual decoder
checks. JPEG/WebP metadata acceptance does not enable PNG-only scene generation.
See [authorized media transport](27-courseware-authorized-media.md).

Project/snapshot/teaching persistence and all previous contract validators stay
unchanged. No team-to-local binding, public picker or Host asset table is added.

## Explicitly outside this version

This contract does not define collaborative editing, a shared cloud project, provider credentials, arbitrary OOXML patches, media generation requests, player events, or the MAIC fixed-build adapter. D's `deckwise-fixed-build/1` is an internal builder input and must be adapted from a verified canonical snapshot; it is not a second source of truth.

## Consumers and checks

The shared package owns the TypeScript runtime validators and fixtures. Host storage validates the same identifiers/revisions and consumes the same success/conflict JSON files in real SQLite tests. B/C/D should use the fixture semantics: `accepted.json` is a valid two-page project/write, while `stale-write.json` must report a stale revision and perform no write. Tests run with `pnpm --filter @pi-desktop/shared exec vitest run src/courseware-contract.test.ts` and `cargo test -p host-core --locked courseware_projects`. The package root exports the module; vendor copies in other repositories must record the exact source hash and update as one unit.

## Read-only canonical source context (B83 proposal)

### Legacy fallback parser compatibility

`courseware.project.openSaved` can migrate a Host-bound identity carrying
`pptx_fallback_ooxml` to a verified primary-parser export of the exact same
source SHA256. Ordered import page IDs, complete object counts, unique page-local
native shape IDs and exact nonempty native object names must correspond. Object
kinds must match except for the fallback's `shape` to primary `text` correction.
Neither export may contain parser errors, and a still-fallback export is not an
upgrade. Any other drift retains the existing explicit-review conflict.

Migration archives the previous identity in `coursewareIdentityHistory.v1`,
retains page/object UUIDs, and advances the mapping revision atomically. It does
not write the PPTX or alter teaching revisions, locks, actions, TTS assets,
classroom content or workflow authorization. Archive failure rolls back the
operation; subsequent reopen/restart is idempotent. Pending source adoption
continues to block the operation. `project.context` remains read-only and cannot
perform this migration.

### Context projection

`courseware.project.context({ sessionId, projectId })` returns
`{ project, mapping: { revision, sourceSha256, pages } }` from one SQLite read
transaction. Each mapping page contains `pageId`, `importPageId` and
`objects: [{ objectId, importElementId }]`, matching the existing source-candidate
context. The Host validates the saved identity envelope, source hash, page count,
ordered canonical logical IDs and mapping revision before projecting it.

The request rejects unknown fields and uses the persisted session workspace,
including the existing source-adoption barrier. Missing projects or sessions
return `1007`; invalid/unbound identity or forged parameters return `1002`.
Reading never initializes a project/identity, changes teaching/locks/revisions,
creates or archives a candidate, or writes a source file. Existing `project.get`
and candidate APIs keep their response shapes.

This is Main's read input for native source preflight, not an editing grant.
Main must still bind actual clean saved bytes, document/session/page/generation,
canonical teaching/locks and current Chat ownership before and after inspection
and after permission. The model cannot provide mapping or authorization. A
caller holding a returned mapping cannot bypass Host permissions or the dedicated
finite Office execution channel. Native fade mounting remains a separate gate.


## Native slideshow ownership during teaching preview

The native teaching pane observes the pinned SDK's start/slide-change/end
slideshow callbacks. Ordinary native slideshow entry disposes editor teaching
preview, unloads audio/video, clears cue overlays and fences pending readback.
Exiting re-enables teaching preview without automatically starting it.

The separate **Present this page's teaching** command prepares existing local
speech/music/video through the same Host reads and preview core, then owns an
explicit native slideshow canvas for one saved page. The pinned presentation
controller leaves this marked canvas in place rather than opening a second
native preview. Native click animation steps remain native user clicks. Teaching
starts only after the transition stops and `IsMainSeqFinished` reports completion;
no estimated timeout advances an animation. The current supported animation
subset is static-geometry appear/fade main sequences. Triggered sequences,
animation builds, motion/exit/other effects, automatic page advance and embedded
native media reject before playback; normal native slideshow remains available.

During native preparation the owned canvas also exposes **Next PPT animation**,
native Pause/Resume and actual completed-step counts. The command uses the pinned
SDK's `OnNextSlideAnimPlayer`, never the next-page fallback. Its promise resolves
only when that exact native effect reports `isAtEnd`; pending/paused/transitioning
or stale runs cannot advance another step. Disposing or replacing the sequence
rejects pending completion, and an unexpected later-step start cancels ownership.
Resume starts the current page's animation player directly, avoiding `Play`'s
possible next-page fallback. Manual canvas clicks remain supported. These controls
are removed when native preparation finishes. They do not yet persist or schedule
per-node animation bindings in the teaching timeline.

Once teaching starts, the shared core owns speech, audio clips, video clips,
standalone delays and teacher-continue waits. Pause/Resume/Teacher Continue/Exit
live below the canvas. Native play is not resumed after main-sequence completion
because that can advance a slide. Teaching completion returns to editing.
Escape, manual page navigation, source mutation, ownership change or disposal
stops teaching, unloads media and removes overlays/listeners. Controls on this
read-only surface do not invalidate document edit-generation stamps; actual
editor interactions still do. A response from any stopped preview cannot
restart playback.

Highlight/spotlight use the native slideshow's actual slide rectangle, canvas
backing size and CSS bounds, including letterboxing and device scale. They retain
saved-source and current-target identity checks.

Fixed exports also allow highlight/spotlight on objects revealed by the supported
native appear/fade entrance clicks. Those clicks finish before narration starts,
and the overlays do not alter object geometry or become a second animation owner.
The builder and loader continue rejecting speech `element_animation` cues on the
same native target with `NATIVE_ANIMATION_CUE_CONFLICT`. All mapping, supported
native timing and attention-target validation remains required. This does not
introduce per-node native animation binding or change existing package schemas.

**Present the entire lesson** runs those same current-page previews in saved
native page order. Each page is opened through a fresh Host teaching view and
recovery-draft read; source hash, teaching revision, page identity, native slide
instances and context generation must still match. A changed source/revision,
missing/duplicate page mapping or unsaved/recovered teaching draft stops the run.
There is no media generation, adoption, write or approval during this command.
It reads and releases existing local media one page at a time, retaining the
per-page memory bound. A covering preparation screen prevents presenting the
underlying editor while switching pages and provides Stop/Escape. Read-only
preparation controls do not invalidate document interaction stamps.

Natural page completion cleans up that page, advances, and starts the next
validated page. Native click steps still require actual canvas clicks. Pause,
teacher waits and retryable media errors keep their current-page meanings;
failed media never advances the lesson. Stop, manual navigation, Escape, dirty
source and disposal invalidate the whole run, including late media responses.
Successful lesson completion returns to its original editing page. Cancellation
never forcibly restores a page over the user's navigation. Ordinary sidebar
repaint cannot cancel a run owned by internal page preparation; unrelated edits
and context changes retain cancellation behavior. Per-node native-animation
scheduling, arbitrary native effects and packaged-platform certification remain
separate design gates.

### Saved-source native animation timeline nodes

A local teaching page may contain `{ id, type: "native_animation", version: 1,
sourceSha256, stepIndex }`, with no extra fields. The hash is the exact lowercase
SHA-256 of the saved PPTX. `stepIndex` is an integer 0–199 in that logical page's
supported native main sequence, never an SDK runtime ID. Native nodes follow
ordinal order starting at zero; speech/media/delay/teacher waits may intervene.
Host validates structure, source and ordinal order; actual PPTX inventory is
validated during conversion. Local snapshots preserve bindings. Source-change
narration projection refuses to carry them; remove or explicitly rebind them.

Fixed export requires every actual supported native step exactly once on a bound
page. Count, target, preset and duration come from the converted saved PPTX.
Stale/gapped/duplicate/reordered bindings fail with
`NATIVE_ANIMATION_BINDING_MISMATCH`. Bound pages emit native metadata version 2,
`sequence: "teaching-timeline"`, and report capability `click-appear-fade/2`.
Unbound legacy pages retain version 1 and before-narration teacher clicks; mixed
packages report the highest native capability in use.

The loader independently verifies capability, metadata and bindings before
playback. Each bound node projects into the existing element-animation/timeline
execution at its position, without extra teacher gates or another playback
clock. Native entrance targets begin hidden. Speech attention on a native target
must follow its entrance node; otherwise builder and loader return
`NATIVE_ANIMATION_TARGET_NOT_REVEALED`. Duplicate speech/native animation
ownership remains prohibited. The supported main-sequence subset and existing
mapping/asset validation remain unchanged.

The native sidebar now binds all supported saved-page steps in one operation.
Native nodes can move around narration/media/delays while preserving native
ordinal order. Individual deletion is disabled; removing all bindings restores
legacy preparation. Binding requires a clean source matching page-lineage SHA.
Saved writes and recovery drafts use the existing Host authorities.

For bound pages, owned native presentation starts teaching once the transition
ends, before entrance steps. The shared core projects native nodes to private
completion checkpoints and invokes the finite native driver. Actual effect end,
never a timer or teacher click, releases the checkpoint. Pause freezes the native
player and completion; native failure requires restarting presentation. The
checkpoint namespace cannot collide with explicit teacher waits. Unbound pages
retain manual preparation. Native input on the owned canvas is blocked during
bound playback; Escape and teaching controls remain available. Source/page/effect
mutation and unexpected advancement stop ownership. Editor-only playback refuses
bound nodes and directs users to teaching presentation.

Before bound presentation, current source, count, order and cue target identities
must agree. Attention cannot precede a target's entrance or duplicate native
animation ownership. These checks use saved object proofs and actual native
shape identities, not positions or labels. Portable sidecar migration, compound
saved undo and packaged acceptance remain separate design gates.

### Portable teaching file (G5, Linux copy mounted; migration pending)

Rust validates `deckwise-teaching/1` in
`db/courseware_projects/portable.rs`. Its strict header is
`{schemaVersion, projectUuid, commitId, project, identity, media}`. `project` is
canonical editable content, including education context, manual locks and review
state; unlike a fixed snapshot, unfinished speech and unresolved video slots are
valid. The journal pins the actual source SHA and commit UUID. Updates preserve
the persistent UUID and canonical legacy project ID.

`identity` is the existing bound saved-source identity with ordered logical
pages, object/native export evidence and mapping revision. Its diagnostics must
be empty; diagnostics stay in Host storage. No unknown field is accepted at a
portable envelope, action, cue, checkpoint or media boundary. Unknown legacy
nodes fail explicitly rather than being dropped during migration. Node and
checkpoint IDs are unique within each page timeline, matching canonical authoring
which may reuse `narration-0` on different pages. Attention/cue targets must be eligible mapped objects
on the same page. Native source pins and prefix ordering use canonical validation;
actual native inventory/owner conflicts remain SDK/fixed-build responsibilities.

Each media entry is exactly
`{id,path,sha256,mimeType,byteLength,durationMs}` with
`path = media/<sha256>.bin`. MIME/duration come from authenticated decoder output,
not provider estimates. Paths cannot refer to remote URLs or escape the project.
All referenced media must exist with the recorded byte length and hash before
publishing teaching, on recovery, and on reads. Cues require pinned audio and must
fit its measured interval. Missing or tampered media prevents success. This
format introduces no renderer filesystem write route, paid generation path or
SQLite authority change; opt-in migration and its RPC/UI are separate work.


`assetLocks` and `sceneObjects` are optional strict authored metadata fields, with
explicit null rejected. Scene objects retain the original bound identity and the
validated generated mapping, including aliases, role and regeneration instruction;
this preserves historical/missing object context without inventing a new binding.
Current-source image locks must match saved mapping/fingerprints/native shape proof.
Historical locks remain pinned to their original source and require explicit review
before rebinding. These records contain authored data, not private provider receipts.

The retained internal project-copy IPC takes only `{sessionId}` over
`deckwise/ppt-editor/project/copy`. Main reparses the current saved revision and
calls `courseware.project.copy` with `{sessionId,jobId,expectedSourceRevision,
expectedTeachingRevision}`. Host rejects caller paths/metadata, stale revisions,
foreign jobs and missing media provenance. It writes a new
`<session-workspace>/courseware-copies/<uuid>.deckwise/` containing `lesson.pptx`,
`lesson.teaching.json`, content-addressed media and recovery metadata. Existing
copies/originals are not overwritten. It returns the copied path, UUID, pinned
source/teaching revision and media count to Main; renderer gets only path/count.
No network, generation, charge or SQLite authority switch occurs. Unfinished
narration and review state are preserved; only already saved teaching is copied.
This internal compatibility operation has no editor toolbar entry; the user's
2026-10-29 scope correction removed the complete-project-copy and advanced-teaching
buttons. Desktop never mounts the outer teaching panel alongside WiseOffice.
Teaching, voice and attention editing use its native right sidebar exclusively.
Main attaches a Linux portable
project before opening saved teaching; whole-editor fresh-profile acceptance
remains separate from the installed-parser and component tests.

The Host restore boundary is `courseware.project.restore` with exact
`{sessionId,jobId,sourcePath}`. The path must resolve to a workspace-contained
portable `lesson.pptx`; no caller project ID, sidecar content or media metadata is
accepted. Host verifies committed public/archive bytes and fresh parser mapping,
archives verified relative media, then transactionally imports teaching, logical
identities, scene metadata, locks and a portable baseline marker. The canonical ID
is `portable-<projectUuid>`, and that parser job is bound to it after success.
Portable identities deliberately exclude free-form parser diagnostics; all
source/page/object evidence must still match. Identical repeated imports preserve
local edits. Different same-UUID baselines, missing markers, changed sources and
invalid media reject without overwriting teaching. SQLite remains the editing
authority; this does not enable normal sidecar saves.

The private automatic boundary is `courseware.project.attach`, with the same
exact `{sessionId,jobId,sourcePath}` input. Main obtains `sourcePath` from the
authorized editor, never renderer input, after parsing its saved revision. Host
returns exactly `{attached:boolean}`. Ordinary PPTX files return false without
creating project metadata. Portable `lesson.pptx` files require the committed
sidecar, immutable baseline/source archive and verified media. A retained commit
with a removed sidecar fails. Initial import uses strict restore; existing
same-baseline imports keep local teaching and bind every new saved parser job to
the durable UUID. A changed public PPTX must match parsed bytes and enter the
existing explicit source-review flow. It cannot overwrite teaching or silently
change page/object associations. A changed baseline rejects even for an already
imported UUID. Unsupported platforms reject portable attachment; ordinary PPTX
behavior is retained.

`courseware.project.localMedia` takes exact `{sessionId,projectId,pageId,actionId,
expectedSourceRevision,expectedTeachingRevision}` and returns `{media:null}` or
`{media:{asset:{id,sha256,mimeType},path,byteLength,durationMs}}`. The absolute path
is Host-to-Main only. Provenance requires bound current source identity,
page/action kind, asset reference and unchanged speech text to match the imported baseline, with
archived bytes reverified. Portable media never serves as a provider authorization
or paid task receipt. Re-copy validates imported and provider-backed media
separately. Explicit source review may preserve these exact logical references;
changed speech, cross-page reuse and unbound source edits do not acquire proof.

Native speech/music/video preview first checks imported local provenance. Main
reads bounded no-follow regular files, verifies SHA-256 and byte length, then
validates MIME and exact declared duration with the sandboxed Electron decoder.
Portable limits remain 50 MiB/file, 128 MiB total, 1000 assets and one hour/file.
Renderer receives bytes/MIME only. Corruption rejects without a network retry or
paid generation. Ordinary and newly generated media retain their previous path.
Local-only preview and snapshot capture require no account/provider lookup.

Snapshot assets admit the exclusive local form `{asset:{id,sha256,mimeType},
local:true}`. False, unknown or combined path/provider proofs reject. Host checks
every current page/action referencing that ID against its imported baseline,
rechecks archived bytes and requires exact MIME/hash. Main includes speech,
music and video in snapshot completeness and decodes repeated assets once while
checking each reference. Fixed snapshots consume the normal immutable asset
archive. Whole-editor playback/export acceptance, coordinated normal sidecar
saves and authority migration remain pending.

### Scene teaching follow-up (2026-10-30)

Scene page metadata optionally carries validated `teaching` requirements: page
type, phase, objective, duration, required objects, typed question and music.
Identity follows the saved logical page ID after reorder. Scene semantic evidence
persists current UUID-bound role, spoken aliases, text and target eligibility;
it grants neither geometry changes nor inferred re-association.

Question responses optionally retain `{kind,options,answerIndices}` with strict
bounds for single, multiple, judge, short_answer, discussion, practice and pbl.
Objective index sets are evaluated locally; open responses require teacher
evaluation. Legacy question checkpoints without a response remain compatible.
`music_slot` retains `{id,type,title,prompt}` until the corresponding verified
music result replaces it with an `audio_clip` at the same action position.

The bounded speech motion vocabulary adds zoomIn, slideInLeft, slideInRight and
gentleRotate to fadeIn/fadeOut/pulse. Native projection occurs on corresponding
teaching-page load and never overwrites a manual animation sequence. Fixed-build
deduplication requires exact validated SDK behavior plus canonical target/group/
timing equality. Highlight and spotlight remain sidecar overlays. Advisory quality
uses `blocking:false`; unresolved quality is reported independently from editable
artifact availability and technical playback readiness. See the
[implementation and device acceptance record](../../design/2026-10-30-scene-teaching-parity.md)
for verified scope and remaining differences.


### Native teaching editing clarity (2026-10-30)

Native teaching reads may retry at most twice when the editor renews its
selection generation on the same writable page during a saved-source read.
Every retry uses a fresh context and the existing Host source/page/session
validation. Writes and paid operations are never retried by this recovery.
A failed animation projection must not permanently suppress subsequent context
refreshes. Existing manually authored native sequences remain untouched.

Every speech inspector exposes spotlight, highlight and native animation
editing. Missing audio, object mappings or an unlocked page are stated
explicitly instead of hiding the entry points. Saved teaching needs no per-page
confirmation or effect-review checkbox. The native sidebar has no confirmation
operation. Multiple eligible targets may be selected; existing cue targets,
times, preview, edit and remove actions remain visible. Native animation editing
opens the SDK panel without imposing the narrower synchronized-playback preset
restrictions.

Adopted music and video steps load their verified local bytes into a native
media control only while selected. They display duration, allow playback/seek
and preserve recorded gain. Selection changes, page changes, stop and disposal
release playback and object URLs. Loading never autoplays or creates a paid
job. Speech model/voice/task identifiers stay in collapsed voice settings.
Imported teacher-continue checkpoints are labeled as legacy teacher pauses and
explain their manual continuation; new pauses remain narration-tail settings.

## Teaching approval boundary (2026-10-30 correction)

Only teaching-plan approval and first-page style confirmation gate the teaching
workflow. Saving narration, adopting verified media, editing attention cues and
building saved teaching never require individual page approval. `reviewState`
is retained solely for v1 stored/wire compatibility; neither value grants or
revokes editing, generation progress, snapshot capture or playback. Readiness
follows actual saved actions, resolved attention, media slots and verified assets.
Legacy confirmation RPCs remain compatible with older clients but are not exposed
as required steps in the current UI. Locks and exact source/page/revision/session
checks still apply.

A completed source association is complete immediately. Chat change plans remain
auditable receipts, including pending or uncertain operations, without a manual
request-disposition prerequisite for snapshots, portable exports or fixed shares.
This does not grant source-replacement, destructive deletion or external-publication
authority; existing explicit user choices for those operations remain intact.
This correction supersedes earlier per-page teaching-review language in this
contract and the Host-owned-courseware ADR.

### Native enrichment extension

The native carrier optionally carries `enrichment` with schema version
`deckwise-teaching-enrichment/1`. The cross-process types/validator live in
`packages/shared/src/courseware-enrichment.ts`; the paired document reader uses
the same versioned wire contract. The teaching view exposes capability version 1
and the extension separately from the strict courseware project projection.
Unknown extension versions and unexpected/private fields fail before writes.
The existing carrier remains `deckwise-native-teaching/1`. See
[the compatibility ADR](../../adr/shared-teaching-enrichment.md).
