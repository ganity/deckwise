# 课件数据契约

> **原文镜像说明：** 本页保留完整英文规范，尚未提供全文中文译文。协议字段、约束和验收条件以 [英文源规格](/spec/03-runtime/22-courseware-contract-v1) 为准。

The shared TypeScript source is `packages/shared/src/courseware-contract.ts`; fixtures are in its sibling `courseware-contract.fixtures/` directory. `schemaVersion` is `deckwise-courseware/1`.

Status: shared consumption contract, Host storage/RPC, saved-source teaching UI and explicit human review of saved-source changes implemented. Automatic cross-save lineage, immutable snapshot storage/export, generated-candidate storage/adoption and full Desktop composition remain pending. Native Chat integration is described in [23](/spec/03-runtime/23-courseware-native-chat).

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
`pauseAfterMs` (0–30,000) and `teacher_continue` checkpoints. All action and
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
source review. See [candidate audio preservation](/spec/03-runtime/25-courseware-source-candidates).
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

The [A5 narration-candidate store](/spec/03-runtime/24-courseware-narration-candidates) now
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
See [authorized media transport](/spec/03-runtime/27-courseware-authorized-media).

Project/snapshot/teaching persistence and all previous contract validators stay
unchanged. No team-to-local binding, public picker or Host asset table is added.

## Explicitly outside this version

This contract does not define collaborative editing, a shared cloud project, provider credentials, arbitrary OOXML patches, media generation requests, player events, or the MAIC fixed-build adapter. D's `deckwise-fixed-build/1` is an internal builder input and must be adapted from a verified canonical snapshot; it is not a second source of truth.

## Consumers and checks

The shared package owns the TypeScript runtime validators and fixtures. Host storage validates the same identifiers/revisions and consumes the same success/conflict JSON files in real SQLite tests. B/C/D should use the fixture semantics: `accepted.json` is a valid two-page project/write, while `stale-write.json` must report a stale revision and perform no write. Tests run with `pnpm --filter @pi-desktop/shared exec vitest run src/courseware-contract.test.ts` and `cargo test -p host-core --locked courseware_projects`. The package root exports the module; vendor copies in other repositories must record the exact source hash and update as one unit.

## Read-only canonical source context (B83 proposal)

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
