# ADR: Host-owned courseware projects and teaching records

- Status: accepted for the approved courseware implementation, 2026-10-19.

## Context

Plain generation, scene generation and import converge on an editable PPTX plus
page teaching data. Native slide IDs can change across save, so page order/native
IDs cannot identify teaching. Parallel generation and manual editing must not
silently overwrite one another. The user approved WiseOffice editing, the
existing main Chat, Host-owned teaching and fixed build inputs.

## Decision

Keep PPTX files in the existing editor revision lifecycle and bound teaching in
the existing Rust-owned SQLite `kv` extension, using a canonical workspace/project
key and logical page IDs. The initial bounded project model has a strict shared
runtime validator and success/conflict fixtures also consumed by Rust tests.
Teaching writes compare source/teaching revisions, respect manual locks and use
an atomic compare-and-set SQL update. Resolve workspace ownership from a
persisted session, rather than a caller-supplied path or global selected folder.

Reuse of `kv`, as with project groups, avoids a speculative set of future tables
and conflicts with newer upstream database migrations. No second SQLite store or
Main-owned teaching authority is introduced. Candidate/snapshot/task/build refs
describe cross-line boundaries; a ref does not grant authorization or imply the
corresponding lifecycle has been implemented.

## Consequences

The optional `educationContext.visualStyle` keeps scene style requirements in the
same Host-owned task/project context and existing revision-checked requirements
update. No extra style store, route or database migration is introduced. New
records remain within the existing text/task budgets; binaries with older strict
context schemas can reject the additive field and must be updated together.

Verified source candidates reuse the saved-source review's bounded attention
validation. Fade preserves current and peer highlight/spotlight targets; redo
and batch preserve non-target cues. Host checks original target identity
before preparing or adopting a copy, and existing non-target identity comparison
prevents a generator from changing those objects. Rebuilt targets with cues
require explicit object reassociation in the existing candidate review before
adoption. Host journals those choices together with the rebound project and
new identity so recovery does not repeat association or regenerate audio.
No silent cue deletion, ordinal identity inference or second teaching store is
introduced. Existing cue-free requests and journals default to no choices.

Local unfinished narration and per-page instructions use a separate
`coursewareTeachingDrafts.v1` namespace in the same Host kv. The key adds the
durable Chat and logical page; records capture the complete authoritative
baseline and a draft revision. Main's view token derives all identities.
Serial draft CAS never writes teaching, snapshots or PPTX and accepts unfinished
speech text. Only identical unlocked baselines recover into editable UI;
older records remain available for copying or explicit revision-checked
discard. Acknowledged storage survives ordinary process restart under existing
WAL settings. Last unacknowledged keystrokes and power loss are not guaranteed.
No renderer localStorage or second data authority is introduced.

Private TTS request intents stay in Host SQLite. Main owns the finite orchestration
and authenticated HTTP transport; renderer IPC receives a redacted task view.
An account partition derives from the configured platform plus tenant/user and
does not grant server authorization. Host durably marks submission unknown before
Main dispatches. Recovery never POSTs; late canonical task references may be
retained without teaching/audio adoption. See
[authorized media](../spec/03-runtime/27-courseware-authorized-media.md).

Pending PPTX copies use a separate private `coursewareSourceCandidates.v1`
namespace in that same Host database. Preparation captures the full project and
mapping before the single parser job is released. Host archives verified output
bytes under its own data directory before committing pending status; retrieval
rechecks content hashes after restart. Source and teaching are never replaced by
preparation, staging or rejection. Recoverable file/SQLite adoption remains
required before a coordinator can mount source switching. Files created
before a failed database update may remain unreferenced; deletion is deferred
until reference-aware collection exists.

Completed narration proposals are retained separately in the existing `kv`
store. Host stages B's canonical write under a verified saved-source seed and
captures the full current project. Explicit adoption archives that baseline,
uses the existing teaching CAS/lock check and marks the candidate adopted in one
transaction. Rejected/stale proposals cannot silently overwrite teaching.
Audio/effect-bearing targets reject until action-specific invalidation exists.
This internal storage boundary does not grant renderer/model execution or mount
an unconfigured generation transport.

Explicit human review may associate speech text and bounded page-local pauses
with already-saved changed source bytes. Pending reviews pin the full previous project, mapping revision
and trusted parser identity in Host SQLite. Each user choice starts unassigned;
no ordinal/fingerprint association is implied. Adoption archives the old project,
binds a new source identity, updates the project and consumes the review in one
transaction with full-record CAS. Locks and narration stay unchanged, copied
pages receive new identities. Previously adopted audio may follow an explicitly
associated logical page when its speech/action and private receipt still match;
object cue/effect-bearing projects continue to reject intact.
Optional integer `pauseAfterMs`
from 0 through 30,000 is copied unchanged; it carries no asset/object binding.
Associated pages use automatic saved-source, target and media validation.
This operation never replaces PPTX bytes and does not authorize generated
candidate adoption or arbitrary caller-supplied lineage.

The D2f baseline stores a strict, digest-verified saved-source identity in the
same SQLite transaction as initial project creation. It uses a separate
`coursewareIdentities.v1` namespace keyed by workspace/project and source hash;
Host binds canonical page UUIDs, object UUIDs and a mapping revision. It survives
temporary-parser cleanup and restart. General identical-source worker/schema drift
requires explicit review rather than overwriting these identities. A narrow
legacy fallback-to-primary parser migration may replace parser metadata only
for byte-identical source hashes, unchanged ordered native page IDs, and a
complete one-to-one match of page-local native shape IDs and exact object names.
Only equal object kinds or the fallback's shape-to-text correction are allowed;
missing/duplicate native IDs, ambiguous names or parser errors reject intact.
Host archives the previous identity in `coursewareIdentityHistory.v1`, preserves
every logical UUID and the entire teaching project, and advances only the mapping
revision in the same transaction. Unchanged UUIDs retain existing speech/audio
and cue references; this does not restore previously deleted cues or missing
narration, infer bindings across changed bytes, or authorize generation. This adds
no renderer-supplied mapping authority and no cross-save adoption permission.

The first module provides storage/RPC, not a completed editor workflow. The
coordinator must verify source bytes and lineage before internal initialization;
ambiguous save/reorder/copy matches require review. Snapshots need actual immutable
archives, and adoption needs safe file replacement and Office save fences before
those features are enabled. Media payloads/keys remain outside these records.
Independent action/build and server authorization checks remain necessary.


Finite renderer review remains coordinated by Main without moving persistence
out of Rust. A Main-owned review token binds an already persisted narration
candidate to the active native source/page and owning Chat. The renderer cannot
supply canonical targets or replacement actions through adoption. A fresh
saved-source parse plus full Host CAS guards explicit decisions; a lost response
requires persisted-status recovery. This does not grant model generation access.


A10 retains exact original PPTX bytes before temporary parser cleanup. A finite
internal context read derives complete generator mapping from the current
Host-bound identity in a consistent transaction and verifies the private original
archive. Rejected/stale or corrupt contexts fail; callers cannot supply mappings.
Actual Host/B4/D2f fixture acceptance validates fresh redo/fade generation and
exact-byte lineage interoperability. It does not persist verified lineage or
mount a production generator. Candidate views still require review and report
`applied:false,lineageVerified:false`; native-source ownership and file-switch
recovery remain separate gates. Archives may outlive failed/rejected records;
reference-aware cleanup and quota are not implemented.


A11 mounts production Main generation for a fixed current-page fade via existing
Chat/ToolSearch and Rust permission/audit. Main keeps the opening lock while
releasing the original parser lease and parsing the output. The sealed B4 runtime
port preserves non-target package parts; Host archives remain authoritative for
bytes/status. This adds no canonical schema or source-adoption authority.
Generation receipts explicitly remain pending, unsaved and unapplied.

A12 retains a strict fade attestation from the production Main generator, bound
to original/output hashes, Host mapping revision and the single target. Main
checks exact non-target package preservation and fixed transition semantics;
Host independently checks actual archived hashes and all ordered page/object
parser fingerprints against its saved identity. This trusts Main's generator
for ZIP/XML operation semantics; Host does not independently inspect transition
XML or authenticate arbitrary callers using a signature. Only these validated
fade records report `lineageVerified:true`. Legacy records remain false and
replay cannot clear evidence. Optional storage preserves old record CAS without
a schema migration. Verified evidence is not adoption authority: output review,
recoverable file switching and teaching/Office rebinding remain separate gates.

A14 adds pending source-adoption intent and a workspace teaching fence in two
private namespaces in the existing Host `kv`. Commit requires the exact freshly
parsed candidate revision and atomically updates project/history/identity and
candidate/journal status. Cancellation requires the original revision. Fixed
fade retains page/object logical IDs and portable narration; neither method
mutates live files. This split retains Host authority while Main must separately
freeze Office, retain the live path and coordinate file replacement/recovery.
SQLite WAL NORMAL supports process-restart tests here; a durability barrier is
required before coupling this transaction to live file replacement. No second
database, renderer persistence or automatic file adoption is introduced.


A15 couples these responsibilities through recoverable intent, not a claimed
cross-store atomic transaction. Host optionally pins and verifies Main's live
source path and requires a successful FULL WAL checkpoint before prepare/get/
resolve replies. Main closes the clean owning Office session, retains a synced
original sibling backup and installs the candidate exclusively. Actual live
bytes determine fresh revision commit or cancellation; unknown external bytes
block automatic recovery. Only a retained reviewed fixed-fade candidate can be
adopted. The renderer sends an opaque review token and owns no persistence.
Successful resolution reopens the same Office document; terminal journal replay
avoids duplicate teaching writes. Real power loss, other platforms and installer
packaging require independent acceptance.

A16 keeps immutable exports in the same Host database, separate from the mutable
project: one frozen canonical snapshot, complete project, bound identity and
fixed audio metadata, with content-addressed source/audio files. Exact IDs replay
but cannot overwrite different content. Reads verify the frozen data and files
without falling back to live state. Teaching edits use the existing Main-owned teaching view and Host CAS; the
renderer owns no revisions, paths or snapshot storage. Per-page confirmation is
not a workflow gate (runtime contract 22, 2026-10-30 correction). A fixed snapshot is build input, not a publication
or promise of supported rendering/audio. D must independently validate actions,
assets, bindings and conversion warnings before playback. See runtime spec 26.

A22 reuses that immutable Host audio archive and a private kv receipt keyed by
workspace/project/Main-derived account/intent. Main owns authorized downloading
and actual decoding; Host validates bounded bytes/hash and the retained task,
then persists metadata independently from teaching. Explicit attachment uses
fresh teaching CAS plus exact original source/text/previous-audio checks and
atomically saves the teaching change and receipt. Replays cannot attach stale
or replaced audio. Fresh CAS allows multiple already-generated speech tasks to
attach without repurchasing after the first attachment changes the global
revision. Checked FULL WAL acknowledgements and retained receipts support
recovery after uncertain responses. No second database or new schema is needed.
Explicit saved-source association may advance only the adopted receipt's
`boundSource`, atomically with the reviewed project. The original paid intent
and immutable bytes never move or regenerate. Source review checks the old
binding, logical page/action and speech before advancing; Main/Host snapshot
capture independently require the current binding. Copies stay empty and old
snapshots retain their previous source and asset bytes. A verified native-save commit also advances a separate optional `boundSource`
on already-dispatched TTS journals, including not-yet-archived/adopted work, when
the old source binding and unchanged logical page/action/text match both projects.
It changes no original paid request, selection, key or task. Cancelled saves,
changed speech, copied/deleted pages and arbitrary source switches cannot grant
this authority; adoption still requires fresh teaching CAS, account and lock
checks. This does not grant generated-candidate audio migration or object-effect
rebinding.
This Host-only checkpoint does not certify playback or expose private paths to
the renderer/model; Main decoding and narrated integration remain required.


A23 measures downloaded audio with Electron's bundled Web Audio decoder in an
isolated, hidden, nonpersistent renderer without preload/Node/network access;
Main remains an orchestrator and Host retains archive/database authority. This
reuses the shipped codec rather than introducing a bundled ffmpeg binary or
trusting server duration/header metadata. A finite archive IPC exposes only
intent/duration/status and cannot attach teaching audio. Existing verified Host
receipts recover without network. Decoder input/time/concurrency bounds are not
an exact decoded-memory cap; renderer failure rejects the artifact. Actual
platform/package codec gates and explicit adoption/snapshot/playback work remain.

A25 lets Main reference an adopted TTS receipt when capturing a snapshot.
Host resolves that reference inside its existing account/project partition and
rechecks current source/speech binding and immutable bytes. It does not relax
workspace-file import to arbitrary Host paths. Snapshot persistence retains
only the existing fixed asset metadata, so no migration or second storage
authority is introduced. Narrated playback and price UI remain separate gates.

A37 retains page PNGs and human inspection approval only in Main memory. It
reuses Host's canonical saved project and teaching coordinator, never creates a
second persisted teaching/asset authority, and renders through a separate readonly
Office session. Finite main-window IPC exposes review images and opaque tokens;
renderer/model input cannot supply source paths, page mappings or approval state.
Fresh owner/source/page/full-project checks gate each approval/private consumption.
Revocation cancels preparation and invalidates retained guards. Restart requires
new review. Public Chat generation and candidate adoption remain separate gates.

A39 connects the finite redo proposal to the existing owning Chat and Rust
high-risk tool permission path. Main alone resolves approved PNGs, the current
vision model, installed compiler and canonical saved-page mapping. The result
is an archived, verified pending copy, available for readonly preview/rejection;
rebuilt-page adoption remains disabled. Visual approval tolerates selection-only
native generation changes while retaining clean-source/page/teaching guards.
Proposal execution still pins its fresh native generation across generation.

A40 uses the same retained candidate review and recoverable source installation
for verified rebuilt pages. Main freezes and reopens primary Office through the
existing adoption coordinator; Host owns the durable intent, page/object identity
migration and teaching transaction. Saved teaching needs no sidebar confirmation.
Only target object IDs are replaced; page IDs, peer object IDs and supported
speech/pauses/locks persist, with target teaching validated against saved mappings. No new file
writer, canonical store or model-facing adoption tool is introduced. This
supersedes A39's temporary Desktop rebuilt-page adoption restriction.

A43 extends that same private candidate/journal transaction to a finite confirmed
batch. The request retains a verified current single-page representative and an
exact instruction/page scope, never another canonical project store. Host verifies
archive hashes, ordered parser identities and full-project CAS; only scoped target
object IDs are retired, all page IDs and peer teaching/identities remain. Optional
fields preserve old record serialization without a migration. Main still owns
actual human representative/scope review, ZIP semantics and live-file installation;
this internal RPC does not expose batch Chat or renderer authority. Rejected or
stale representative input cannot authorize batch adoption.

Owner online preparation receipts reuse the same Host kv extension, keyed by
the persisted workspace, Chat and hashed account principal. Main retains network
orchestration and server authorization; Host retains the frozen upload/start
selection and strict phase CAS across response loss/restart. Acknowledged writes
complete the existing durability barrier. Only explicit successful completion
transactionally binds the local task to that team project together with the bound
receipt. Uncertain operations cannot acquire a fresh request ID, and reads never
replay remote writes. This adds no schema table, second database, file/credential
storage or generic Renderer/agent entry. The private protocol is specified in
[Host RPC](../spec/03-runtime/06-host-rpc-protocol.md#owner-online-preparation-receipt).

### 2026-10-24: Optional team teaching seed and leased narration sidebar

Local saved-source teaching remains Host-authoritative. Team teaching is
Platform-authoritative; the online sidebar uses the same mounted native attempt
and Main-held account/source/session/lease binding, not local Host writes or a
second canonical database. The public view exposes an opaque page view and lease
deadline, never the lease proof. Initial-source logical page selection is manual;
it does not establish live native slide mapping. Structural changes require
reconciliation before relying on that selection.

The separate explicit Owner preparation with narration reads an existing trusted
Host context, admits only a new remote source/teaching baseline, and initializes
before start/bind. Optional private receipt pins are exactly local `projectId`,
`teachingRevision`, `mappingRevision` and canonical `payloadSha256`; upload request
identity is reused in the independent teaching idempotency domain. Old receipts
retain PPTX-only meaning. Local audio references block this initial seed until
verified team asset adoption exists; they are never dropped to simulate support.

The sidebar preserves opaque actions and unsaved in-memory drafts on conflicts.
An uncertain save freezes its exact body and permits explicit replay through
Main, not a blind new write; this pending state is not durable across restart.
This source decision does not certify actual Electron/Platform teaching closure,
live native mapping, remote media synchronization or consistent publication.


The Linux project-copy operation reads this SQLite authority and exports a strict
portable PPTX/teaching/media backup through the Host transaction writer. It does
not redirect existing reads/writes, migrate authority or delete private/legacy
records. See [portable project commits](courseware-portable-project-commits.md)
for the mounted copy boundary and the still-pending normal-save authority migration.
Opening a Linux portable `lesson.pptx` now attaches its verified baseline before
ordinary saved teaching operations. An unrelated profile imports canonical
teaching into this same SQLite authority; an existing import keeps local edits.
Changed PPTX bytes require the existing explicit source review. Preserved local
media follows reviewed logical page/action IDs and unchanged speech text, without
fabricating provider receipts. Main validates bytes with its sandboxed decoder
before local preview or fixed snapshot capture. Normal saves still do not update
the exported backup sidecar, and no editing-authority switch is implied.

### 2026-11-08: Fixed assessment SVGs in ordinary presentation drafts

New PPT Master projects reuse the shared learner-facing assessment projection
before body authoring. Main writes fixed Quiz/checkpoint SVGs and a draft plan;
the model only designs body SVGs. Every physical slide still passes the official
SVG preview, quality and explicit-export gates. This avoids a second mixed-page
exporter while removing disposable model-designed assessment layouts. The draft
manifest is not a teaching store: Host adoption, UUID mapping, canonical teaching
and the existing media lifecycle remain authoritative. Conflicting drafts are
preserved, adopted Office content is never regenerated, and old exports without
a draft manifest remain supported.

### 2026-11-09: Native rendering with shared teaching playback

WiseOffice remains the desktop PPT rendering surface: native animation fidelity
is not replaced by a DOM reconstruction. Its teaching timeline uses the shared
PlaybackCore/AudioPlayer, and Quiz grading, question responses and reference
answers now reuse the shared runtime views rather than a second handwritten
native Quiz implementation. The native adapter owns PPT animation readiness,
pause/resume and temporary schedule restoration. Page-entry effects can run
beside narration; only explicit speech bindings wait on their owned effects.

Keep the fixed player for portable courseware and team builds. Those callers
cannot be removed until a portable native PPT renderer exists. This does not
claim that arbitrary native effects can be published through the finite portable
animation projection; unsupported publication remains an explicit limitation.

### 2026-11-14: Document-scoped native execution

Native authoring is bound to a Host task's real document, independently of the
currently viewed Chat. Reuse an open target's engine; otherwise use a hidden
WiseOffice editor with the same teaching/media/candidate services and source-save
checks. Do not maintain a second XML mutation implementation or disable ownership
checks on the shared foreground editor. Canonical classroom persistence stays in
its existing saved workflow. No public IPC schema or storage migration is added.

One ordered native lane also fences visible open/close transitions. This bounds
memory and prevents two writable engines from owning the same source during
handoff. It trades simultaneous native mutations for deterministic saves while
independent generation services can still run concurrently. A failed save retains
its engine and archived revisions instead of discarding or replaying changes.
Engine readiness is independent of the teaching sidebar's DOM/visibility.
