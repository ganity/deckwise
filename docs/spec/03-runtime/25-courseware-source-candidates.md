# Durable PPTX candidate copies

## Saved-source change groups (W03.3)

The existing saved-source review creates a Host-owned receipt in
`coursewareSourceChanges.v1`, keyed by workspace/project/review ID. It retains
the full baseline project, the parsed saved target hash, and, after association,
the resulting project and explicit page/effect choices. A project-scoped
`coursewareSourceChangeLatest.v1` pointer selects the current record. Repeated
preparation of the same review is idempotent; a newer review leaves earlier
receipts intact. Existing projects need no receipt. Legacy pending reviews gain
one in the existing adoption transaction; no canonical project migration occurs.

Source association and its receipt commit or roll back together. A later failed
teaching write cannot erase the saved source or the association receipt. The
existing teaching draft retains unsaved actions; retry must use the latest source
and teaching baseline. Old writes never roll back or overwrite later teaching.

`courseware.project.context.sourceChange` is an optional read-only summary. It
reports the group ID, baseline/target hashes, baseline/association/current teaching
revisions, expected and completed steps, and pending logical page IDs. Readiness
is derived from current Host teaching: a later edit reopens review; another source
makes the older receipt `superseded`. A summary cannot grant permission or replay
an Office command. The teaching sidebar validates and displays it, refreshing
after teaching saves, confirmation and audio adoption. Existing source-hash,
explicit-review and audio gates continue to prohibit inconsistent snapshots.

This increment starts after a native PPTX has been saved and parsed. It does not
record the intent of unsaved native commands, atomically undo Office and teaching,
or prove completion of a free-form compound Chat request. Joined Main/Host
late-TTS, stale saved-source review and intervening teaching-write acceptance now
passes with fixture editor state. A late unadopted audio receipt remains private
and recoverable but cannot acquire the new source binding, even when its bytes
equal already adopted audio. Fresh review preserves later teaching. Actual native
UI concurrency remains a separate W03.3 requirement.

A separate before-dispatch journal now records actual native/candidate tools by
Chat turn; see `23-courseware-native-chat.md`. It coexists with the saved-source
association receipt, whose baseline/result and review authority are unchanged.
The execution journal is not a predeclared natural-language plan or proof of
source/teaching adoption.

## Attention cues across candidate adoption (2026-10-23)

Verified fade candidates preserve bounded highlight/spotlight cues on every
page, including the current page. Redo and style-batch candidates preserve cues
on non-target pages, including locked peers. Host validates each cue against the
saved canonical page/object identity before preparation and adoption. Missing,
cross-page or unsupported targets and invalid effect/timing fields reject intact.
The existing candidate identity comparison prevents a preserved page or object
from changing; adoption retains its logical IDs, actions and audio provenance.

Rebuilt target pages with cues may generate and stage a candidate. Host's current
candidate read adds `effectTargets` (previous page/object UUID, kind and display
index) and `effectPages` (candidate-page parser object indexes/kinds) when target
reassociation is required. Main validates complete target coverage, retains the
exact inventory with its review token and presents candidate objects with no
default association. The user previews the copy, chooses every replacement and
separately confirms retained cue timing. No automatic target guessing, silent cue
removal or identity inference from display order is allowed.

`sourceAdoption.prepare` accepts optional `effectBindings` with strict
`{pageIndex,objectId,targetIndex}` entries. Page indexes are zero-based canonical
candidate pages; object IDs are previous Host IDs; target indexes are one-based
parser indexes scoped to the exact reviewed output. Every rebuilt target must
have exactly one eligible replacement on the same page; merging two old targets,
extra/missing choices and unsupported object kinds reject before source writes.
Verified unchanged peers retain their targets without user remapping. Host
allocates rebuilt object IDs, rewrites only supported cue references, preserves
actions/timing/styles and receipt-backed audio, and stores choices and the rebound
project in its existing pending adoption journal. Pending replay requires the
same choices; crash recovery uses the journal without requiring the user to
choose again. Original source/teaching/mapping CAS and rollback remain unchanged.
Legacy cue-free requests default to empty choices; existing journals default to
no choices. Protocol and SQLite schema versions are unchanged.

The Host regression covers fade, redo and batch adoption through database reopen,
including unchanged receipt-backed audio. The public Main Electron regression
uses actual Host, parser and compiler for redo with peer and target cues, fade
with current-page cues, review/preview/rejection, Main file replacement/Host commit
and restart. Host tests additionally cover batch choices, retained audio and
transaction rollback. Its native editor/render and HTTP model are fixtures;
it does not certify a visible Office adoption path, live-model quality or a new
packaged build.

A separate visible source Desktop regression now passes twelve groups through
the existing main Chat, actual WiseOffice candidate preview, initially empty
target selectors, separate timing/replacement confirmations, Main source
installation, writable Office reopen and complete Desktop restart. Three local
WAV adoptions traverse the actual quote/archive/Host-receipt APIs against a
loopback service. The fixed player resolves the new object UUID and displays
its highlight and spotlight, including paused seek to 1000 ms; audio completes
without a media error or another speech submission. Independent PPTX/teaching
readback verifies 29 unchanged package parts and rejects four corrupt records.
Auth/model/audio remain fixtures; this is source Linux acceptance, not supplier
quality, batch Main audio acceptance or a new package.

A subsequent actual frozen-package gate passes fifteen groups for two reviewed
style-batch target pages and one locked peer. Both rebuilt pages require explicit
object/timing/replacement review; missing choices keep adoption disabled. Actual
Main/Agent/release Host/Office adoption, full restart and all three pages' fixed
highlight/spotlight, paused seek and retained audio pass without resubmission.
Independent ZIP/XML/canonical readback retains 27 original parts and rejects four
corrupt records. Product and package bytes are unchanged; only the test driver
and attention-playback helper changed. Identity/model/audio remain local fixtures;
this closes the joined batch fixture gate, not real design quality or full W11/W12.
Evidence: `/home/jhz/code/train/docs/validation/courseware/w11/batch-attention-20261023/README.md`.

## Saved-source Office undo recovery (W03.3 increment)

An explicit saved-source review can now return to previously mapped PPTX bytes.
Host requires exact equality of the fresh parser export with the immutable
historical export and requires the user's page associations to match the
historical ordered logical page IDs. It reuses that mapping without changing
its revision or object IDs. Different exports or historical page associations
reject intact; arbitrary historical re-association is not supported.

Recovery clones the current canonical teaching, preserves later narration,
pauses and page locks, archives that current baseline and creates a new teaching
revision. It never restores historical teaching. Every page becomes review-only
until explicitly confirmed, so an inconsistent/unreviewed recovery cannot be
captured for publishing. Current attention cues require complete explicit target
associations even when historical object IDs are available. Existing private
adopted-audio provenance checks and atomic source rebinding remain unchanged;
paid intents and audio hashes remain immutable. Scene semantic metadata remains
subject to its existing review requirements.

The existing SQLite transaction and full-project/review CAS cover stale reviews,
SQL failure and retry after reopening the database. The focused Host regressions
exercise A-to-B-to-A undo, redo, later teaching preservation, historical mapping
immutability, explicit cue remapping and previously adopted audio across undo.
This is not a ChangeGroup browser/selective-rollback feature, a power-loss
guarantee or an actual native Office undo/Electron acceptance claim. W03.3 remains
open for those other explicit requirements and joined failure-injection paths.

A subsequent bounded packaged case now verifies actual native Undo/Save and the
public source-review UI. The native text/geometry returns to its original state,
later page-2 pause and adopted audio persist, unconfirmed snapshots reject and
complete restart/fixed effect/audio playback pass. Exact historical PPTX-byte
reuse keeps its separate Host evidence: native Undo serializes new bytes. The
supported no-video fixture has no referenced native media; the original fixture's
native video timing remains a retained fixed-build refusal. No product or package
code changed for this acceptance. ChangeGroup and joined partial-failure/late-audio
gates remain open. Evidence:
`/home/jhz/code/train/docs/validation/courseware/w03/office-undo-recovery-20261023/README.md`.

## Current public-entry regression (W11.2, 2026-10-23)

The existing public Main entry is already connected: `CoursewareCandidateCoordinator.execute`
uses the real saved-source teaching parser, reviewed current-page images, current
Chat model callback, installed `authoring.mjs`, and Host candidate staging. The
existing sidebar provides review, read-only preview, rejection and separate
explicit adoption. A46 verifies that complete single-page UI path; A48 verifies
the representative/scope batch path in source and a Linux unpacked package.
Older milestone paragraphs below describe their historical delivery boundary;
their missing-connection statements are superseded by those later records.

`apps/desktop/test/courseware-redo-main.electron.mjs` additionally enters the
current public Main coordinator and real teaching coordinator, uses the frozen
compiler/worker and Rust Host, and verifies the pending receipt through public
review/preview/rejection and Host restart. It checks editable target text,
byte-identical peer slides/target notes, unchanged source/teaching/pauses/peer
lock, temporary-copy cleanup, and dirty/cancel rejection. Native editor/render
and the local HTTP model are explicit fixture boundaries; Electron PNG decoding,
compiler generation, parsing, lineage, durable staging and candidate review are
real. This regression now includes preserved peer attention, current-page fade
cues and explicit rebuilt-target cue association through source adoption and Host
restart as described above. It does not certify live model quality, within-page
locked asset preservation, joined Main audio adoption, visible Office adoption,
shared live editing or power-loss recovery, and does not update a frozen installer.

## Main Chat batch candidate and review (A48)

The batch candidate is produced by the existing Main Chat flow after the
representative visual review and exact page-scope confirmation. Main retains
the ordered logical page IDs and review ID, renders each target against the
previous stage's actual WiseOffice copy, and passes only the retained
`editGeneration` into the Chat tool. A scope comparison is field-based so
transport property ordering cannot make an unchanged approval stale; any
different review ID, ordered page list or instruction is rejected.

The result is a `page-style-batch` pending candidate, never an automatic source
write. The review UI lists every target and provides read-only preview. Explicit
adoption reuses the existing Host/Main source transaction, rechecks current
hash/teaching/lock/identity state, preserves non-target pages and teaching, and
reopens the primary Office. Candidate and adopted bytes are independently
checked in the A48 ZIP evidence. A failed or canceled Chat leaves the source
unchanged; a restart clears the transient scope and requires a new review.

## Trusted Main batch staging (A47)

`stagePageStyleBatchCandidate` consumes only `CoursewareStyleReviewCoordinator`'s
retained confirmed inputs, never a model-supplied page list, instruction, path or
approval flag. Original confirmation callbacks, exact ordered page scope and
source/project/teaching/native/owning-turn checks remain pinned across awaits.
Re-approving a different scope on the same review invalidates an in-flight batch.
Host receives its representative archive ID; the compiler confirmation retains the
separate compiler/media ID.

The coordinator reads original page texts/mapping through the saved Host parser
and resolves each slide part against real source bytes. The existing public batch
compiler reuses the representative and sequentially rebuilds peers. Before every
peer completion, Main writes the owned current-stage copy into a private temporary
directory and renders that exact hash/page in readonly native Office. It checks
page count, normal/textless tokens and hashes, then supplies the target PNG pair
and retained actual representative preview to the existing authorized completion.
PPTX bytes remain local. Original-source screenshots are never reused for a later
stage. Scope/model/source changes or cancellation reject the late result.

Final output is size/hash/scope checked, parsed through the existing output parser
and staged in Host with `deckwise-main-style-batch/1` evidence. Only a current,
lineage-verified, exact-scope pending receipt is returned. Temporary stage/output
files are removed on success/failure; Host owns durable archives. Source and
teaching are unchanged. This internal Main entry is not yet registered as a Chat
tool or exposed for Desktop batch adoption. Those product connections, broader
scope/partial-failure acceptance and new-package acceptance remain pending.

## Agent proposal input ownership (A46)

All three existing single-page proposal tools capture their original validated
instruction and generation before context I/O, and bind the original Host
callbacks with their receiver. Their baseline and receipt remain independent of
mutable dispatched requests and later context reads. Context/capability/clean/
lock checks before and after generation remain authoritative; late results do
not gain adoption authority. This changes no proposal schema, candidate kind,
registered capability, permission policy or explicit-review requirement.

## Actual representative and target-scope review (A45)

After a successful reviewed Chat redo, Main retains one compiler result, canonical
reference, original instruction, mapping, original Host project and saved native
binding. Compiler IDs remain separate from Host archive IDs because embedded media
parts use the compiler ID. The original byte/report/reference object never crosses
renderer/Agent IPC. Host remains the only persistent candidate/project authority.
This memory is optional for ordinary single-page preview/adoption and disappears
on full application restart; an old durable candidate remains usable singly, but
style expansion requires generating a new representative in the current Chat.

The existing candidate-review sidebar can prepare a style review for that retained
single-page result. Main resolves the verified current Host archive and renders its
actual candidate/page through a separate readonly native renderer, checking output
hash, page count, saved-source/Host project and owning Chat across awaits. That
private renderer permits only the parent directory of the Main-selected hash-bound
path, as existing candidate preview does; callers cannot submit a path through the
new IPC. Native cache revision need not equal the original editor revision for a
copy, while original-source callers still enforce their known revision.

The sidebar displays this generated page, exact original instruction and numbered
page checkboxes. Confirmation requires 2-20 unique unlocked pages, including the
representative. Main normalizes to source page order and retains the exact scope,
representative output and instruction hash. The model/renderer cannot provide an
approval flag, source bytes, path, project, replacement instruction or extra fields.
The rendered page alone grants nothing. Explicit clear/re-prepare, representative
replacement/rejection, source/project/teaching/page/lock/owner changes invalidate
approval. Native selection-only changes do not. A confirmed scope can survive
closing the candidate-review component for use by the owning main Chat; pending
rendering is cancelled on clear/unmount. Hidden editor/Chat switches clear review.

These three main-window channels only review and confirm; they do not execute a
model, generate a batch, adopt a candidate, or overwrite the PPTX. A45 deliberately
leaves production batch Chat tools/coordinator and batch adoption UI disabled until
per-stage rendering, the exact confirmed instruction/scope and existing Host
staging/adoption are connected. Existing single-page behavior remains available.

## Main source-bound representative callback (A44)

The existing authorized Main scene generator accepts an optional trusted
`sourceVisual` page/source binding and `representativePreview` containing an exact
representative page/output hash and locally rendered PNG. Reviewed-style requests
must supply owned current-stage and representative PPTX bytes matching their
pinned hashes. These bytes are checked locally and never sent to the model.
The target reference/background must be distinct, dimension/aspect matched and
bound to the actual current-stage source/page; they must be rendered for each
stage, not reused from the original source after another page was rebuilt.

The representative PNG shares the existing native PNG validation/copy/image
budget and actual model/auth/cancellation path. It is style context only, excluded
from available/output assets. Reference-image aliases and target visual-master
aliases cannot become image layers. Late mutable inputs and cancelled replies
cannot change the pinned completion context or return a usable scene. Legacy
single-page callers remain valid without these new optional inputs; they still
receive the alias protection and existing upstream source-review checks.

This callback accepts only Main-owned inputs. A hash or model field does not
prove human review, rendering provenance, page scope or consent. A44 does not
register a batch Chat tool, approval IPC, scope UI or production batch coordinator.
Host A43 and compiler A42 remain separate dependencies until those owner checks
are connected. Actual callback/native save tests do not claim whole-app batch
adoption, live style quality or installed batch acceptance.

## Host confirmed-style batch candidate (A43)

The existing internal prepare/stage/read/preview/reject and adoption methods also
accept `page-style-batch`. This is a Host persistence/verification capability,
not a public Chat tool or renderer authorization. Main must retain actual human
representative review and scope confirmation before invoking it.

Prepare retains the existing `pageId` as the representative page and adds strict
optional `styleBatch` only for this kind: `representativeCandidateId`, exact
`representativeOutputSha256`, `instructionHash` (`sha256:` plus lowercase digest)
and 2-20 unique `pageIds`, including the representative. All targets must exist and
be unlocked. The retained representative must be a current verified pending
single-page redo for the same page, original source, complete teaching project and
mapping. A rejected/unverified/different representative cannot authorize expansion.
Its later rejection invalidates a pending batch. This reference proves Host state,
not that a person actually reviewed the result.

Stage adds strict optional `batchEvidence` with protocol
`deckwise-main-style-batch/1`, original/output hashes, mapping revision and ordered
`targets: [{pageId, slidePart}]` matching the confirmed scope. Targets have unique
bounded slide-part paths. Fade, redo and batch evidence are mutually exclusive.
The Host compares actual parser identities: unchanged complete page order and all
non-target page/object content and geometry. It independently verifies archive
hashes; Main remains responsible for exact ZIP operation semantics and trusted
slide-part/rendering bindings, as with single-page redo.

Explicit adoption reuses the existing file-independent intent, workspace fence,
fresh parser check, journal/checkpoint, full-project CAS and recovery transaction.
Every page keeps its logical ID; each rebuilt target object gets a fresh ID;
peer identities remain unchanged. Supported speech/pauses/locks persist and every
target page requires teaching review. Previously adopted TTS audio follows the
receipt checks described in the Host adoption section; unsupported legacy
audio/cue/effect bindings still reject intact. Unverified copies may be
previewed/rejected but cannot adopt.

New optional fields are omitted for legacy single-page records, preserving their
serialization and replay. Protocol/schema and the existing Host database remain
unchanged. A43 does not enable Main candidate-review UI or live-file batch
installation; those and actual main Chat/native/package acceptance are separate
integration work. No automatic or model-facing adoption is introduced.

## Private confirmed-style batch compiler (A42)

The isolated `@pi-desktop/courseware-runtime/authoring` entry additionally exports
`generatePageStyleBatchCandidate`, `pageStyleBatchConfirmationSchema` and
`coursewarePageBaseline`/`CoursewarePageContext`. Existing single-page exports,
conversion and playback entry points remain unchanged. The compiler has no model,
network, database, source-file writer or user-review authority.

A trusted coordinator must retain the reviewed representative candidate and its
canonical reference, bind its ID/output hash, exact instruction hash and 2-20
unique logical pages including the representative, and supply fresh clean Host
contexts and source mapping. These inputs are not renderer/model assertions.
Every asynchronous stage rechecks the original project/teaching/page baselines.
The callback receives separate owned copies of the current-stage PPTX and retained
representative for local source-bound rendering; PPTX bytes must not be sent to
the model. Existing authorized image completion remains a separate Main concern.

Each stage verifies page structure and non-target parts before composing lineage.
The result is a `page-style-batch` review-only copy with original-source canonical
reference, composed lineage and per-stage preservation reports. Dirty, readonly,
locked, stale, unconfirmed, unsafe or cancelled inputs reject without adopting
or overwriting the source. Module checks do not establish trusted human review.

A42 does not register a batch Chat tool or IPC, grant batch adoption to the
existing finite Host candidate path, or update installed packages. Actual
representative/scope review, source-bound visuals, Host staging/adoption and
installed batch acceptance remain required before advertising this capability.

## Reviewed rebuilt-page adoption (A40)

The existing sidebar accepts verified `page-pptx` and `page-fade` candidates.
Generation and preview never adopt. The user must open candidate review and
explicitly check the review confirmation before choosing Adopt and reopen.
Main requires its retained current review, clean writable owning editor and a
fresh original parser seed. Host rechecks the full source/teaching/mapping
baseline, archive integrity and trusted operation evidence before its durable
intent. Stale, rejected, unverified, unsupported-media/effects or foreign inputs
cannot be installed merely by submitting a candidate ID.

A40 reuses source adoption without introducing another file writer or authority:
freeze the owning native editor, retain the original backup, install the verified
copy, reparse the installed saved revision, commit the existing Host transaction,
and reopen primary WiseOffice only after resolution. The existing journal,
rollback/third-party-change protection and lost-reply/restart recovery apply.
Page IDs and peer object IDs remain unchanged; all rebuilt-page objects get fresh
Host IDs. Supported speech/pauses and locks are retained; the target page becomes
`review`. Receipt-backed unchanged TTS audio follows the Host adoption checks
below. Valid highlight/spotlight cues follow the preserved-page policy above;
rebuilt-target cues require the explicit candidate association described above.
Voice fields, legacy audio and unsupported effects reject rather than silently
remapping to rebuilt objects.

These current rules supersede historical fade-only Desktop statements below.
Whole-deck style, bulk adoption and automatic adoption remain separate work.

## Main Chat single-page redo (A39)

The existing owning Chat can discover `ppt_propose_page_redo` through ToolSearch.
Its only model inputs are fresh native `editGeneration` and a bounded plain-text
`instruction`. Main derives the saved logical page, source/teaching revisions,
reviewed PNG bytes and compiler location; the model cannot supply paths, XML,
assets, project identity or an adoption request.

Capability is available only with explicit current-page visual approval and an
installed authoring module beside the selected parser worker. The current Chat
provider/model must support images. Main pins the Chat, workspace, model and
thinking selection, clean native owner/page/generation, saved source and full
teaching baseline across awaits. Changing or cancelling them rejects the result.
Image-only source pages may use redo; narration retains its text requirement.

Visual approval pins the saved page, source and full teaching project rather
than the native text selection generation. Moving the selection without editing
must not revoke an approved image of the same saved page. Dirty/uncertain saves,
page or owner changes, readonly state, source hash/revision and teaching changes
still reject. Each proposal independently pins its fresh native generation.

The current model receives the approved original/native-textless PNGs, current
page text and strict editable-scene schema. The local compiler creates a copy;
Main verifies byte lineage before actual Host staging. The finite receipt is a
pending candidate, with `applied=false` and `saved=false`. Existing sidebar
review, read-only native preview and rejection apply. A40 also allows explicit
reviewed adoption of a current verified rebuilt page through the existing
recoverable Main/Host installation path, described below. An old worker without the compiler retains existing features
and does not advertise redo capability.

These rules supersede the earlier checkpoints' statements that Chat redo is
unmounted. Deck-wide restyling, arbitrary animation, target-object rebinding,
automatic adoption and live-provider quality remain separate gates. Explicit
visual review must check raster text and duplicate foreground content: omitting
native text is not a guaranteed clean background.

Status: A15 adds explicit reviewed fixed-fade adoption in the desktop: durable
Host intent, original backup, recoverable live-file installation, fresh saved
revision binding and primary WiseOffice reopening. A13 read-only preview and
rejection and A14 Host transactions remain available. Linux source execution is
the acceptance target; installers, other filesystems and real power loss are
separate gates.

A30 additionally accepts trusted single-page redo evidence in the Host adoption
transaction. At A30, Desktop/Main/Chat redo remained unmounted; A39/A40
supersede that checkpoint limitation.

## Private Main scene completion (A31)

`createMainCompletion` reuses the existing provider/model launch, managed-token,
vendor OAuth and configured-key resolution. Its original `complete` wrapper
remains the text-only Plugin SDK path. `completeScene` and
`createSceneGenerator` are Main service methods only: no renderer IPC, plugin
capability, model tool, new credential store or paid media submission is added.

Main captures PNG bytes before asynchronous work, pins SHA256 and decoded
dimensions, rejects animated/trailing/malformed PNGs and merges identical-byte
aliases. Limits are 202 unique asset IDs, 8 MiB per PNG, 32 MiB of unique PNG
bytes, 32 Mi decoded pixels and 4096 pixels per side. Generation retains
bounded private copies and returns fresh buffers without multiplying copies for
aliases. Context contains only the explicit system/data and these images; it
does not capture the editor, prior conversation, tools, local paths or remote
URLs. Integrity checks do **not** establish source/team asset authorization.

Scene completion requires a current Agent session with the exact selected
provider/model/thinking level and image-input support in the resolved model
metadata. Main checks Host identity and persisted session selection before
launch, after launch and after completion; cancellation, changed Host or
selection rejects the result. Managed credentials are resolved through the
existing fresh-token callback, never sent to the renderer or included in scene
output. The ordinary plugin text wrapper retains its previous semantics.

The single-page callback accepts B54's actual canvas-pinned Zod schema through
its `parse`/`toJSONSchema` interface. It sends that schema and pinned page/source,
instruction, current page text and resolved asset IDs with actual image parts.
Output must be strict JSON within 1 MiB and pass the supplied schema, exact
page/source/canvas/background checks, the 200-element cap and resolved-image
lookup. No Markdown recovery or arbitrary XML/code/path is accepted. The
callback returns scene/assets only; it neither writes PPTX nor issues Host
attestations or adopts a candidate. Batch/representative inputs reject until
reviewed-preview binding exists.

At checkpoint A32, the private authenticated team-asset reader was added as described in
[authorized media transport](27-courseware-authorized-media.md). Canonical
native source lookup, team selection/approval, visual-master/clean-plate preparation,
current native/source ownership checks, deadline/usage integration, compiler
packaging, Main lineage attestation and reviewed redo adoption were subsequent
gates at that checkpoint; A33–A40 provide the integrations described above. The transport and compiler fixture checks do not authorize Chat redo or
prove live-model design quality. A40 supersedes the earlier fade-only UI guard.

## Boundary

Page redo and fade operate on a PPTX copy. They must not overwrite the live
editor source while generation runs. Host first captures the complete project
and its existing saved-source mapping revision. The coordinator can then release
the original parser job, generate a copy and parse that copy with the existing
single-job parser. A completed candidate is stored independently of parser cache
and original workspace input, so both may be removed without losing it.

These finite methods are Main-to-Host only. They are not renderer IPC, advertised
Chat tools or proof that the native editor is clean. Workspace authority comes
from the persisted session. A candidate ID is scoped data identification, not
authorization. No caller can submit authoritative parser identity, archive
path, replacement project or bytes through these methods. Only the trusted Main
generator can retain the optional operation attestation described below.

| Method | Strict request | Result |
| --- | --- | --- |
| `courseware.sourceCandidate.prepare` | `{sessionId,jobId,request}` | Candidate view |
| `courseware.sourceCandidate.stage` | `{sessionId,projectId,candidateId,jobId,outputSha256,fadeEvidence?,redoEvidence?}` | Candidate view |
| `courseware.sourceCandidate.context` | `{sessionId,projectId,candidateId}` | Current candidate and complete Host mapping |
| `courseware.sourceCandidate.get` | `{sessionId,projectId,candidateId}` | Candidate view |
| `courseware.sourceCandidate.reject` | `{sessionId,projectId,candidateId}` | Candidate view |

`request` is strict `{candidateId,pageId,kind,expectedSourceRevision,
expectedTeachingRevision}`. `kind` is `page-pptx` or `page-fade`. Preparation uses
the session's successful saved-Office-revision parser job, reopens those bytes,
checks source/page count, expected revisions, exact parser identity against the
persisted mapping, and the unlocked logical target. A missing project is not
created. Speech text, bounded page-local pauses, teacher-continue checkpoints
and receipt-backed adopted TTS audio can survive source migration. Valid
highlight/spotlight cues follow the preservation/association policy above. Legacy
audio, voice fields and unsupported effects still reject intact; unresolved target
associations block adoption, not candidate generation.

## Persistence and transitions

`coursewareSourceCandidates.v1` uses existing Host SQLite `kv`, scoped by
canonical workspace/project/candidate. Each strict record, at most 2 MiB,
contains the complete baseline, mapping revision, request, optional parsed output
identity/hash/page count, optional operation attestation and `preparing`, `needs-review`,
`rejected` or `adopted` status. Only the separate A14 commit transaction may mark
an output adopted; stage/reject cannot change that terminal state.
There is no schema migration or standalone canonical contract change.

Same-ID/same-input preparation replays the stored state, including rejection;
different baseline/request/mapping conflicts. Preparing can be rejected before
generation finishes. Stage cannot resurrect a rejected record. Stage compares
the complete current project and mapping revision with preparation, covering all
pages, actions, locks and education policy. Another page's changes also invalidate
the candidate. Stage/reject use full candidate-record SQL CAS; staging uses a
transaction. A failed/zero-row update leaves the prior preparation intact.

Stage requires a successful parser job in the same workspace for the output
PPTX. Host reopens and bounds the actual input to 50 MiB, recomputes its hash and
checks it against the job's pinned hash and the coordinator's `outputSha256`.
The identity file is digest/source checked against completed-job metadata, then
validated with the existing D2f envelope. Legacy output without identity rejects.
Output must change the source hash and retain the original page count. The old
`openSaved` path restriction remains unchanged; arbitrary workspace candidates
cannot initialize authoritative teaching through that operation.

During preparation, Host archives the verified original bytes before storing the
baseline. Before committing `needs-review`, it also archives the verified output under
`<hostData>/courseware-candidates/<sha256>.pptx`. A unique temporary file is
flushed and atomically linked into place without replacing an existing archive;
the directory is flushed too. Existing archives must match their content hash.
The archive directory cannot resolve outside Host data, and reads reject
symlinks/nonregular files using the existing source-file checks. This archive
path is private and is never returned in the view.

Parser release, workspace-candidate deletion and Host restart retain the record
and archive. Get rechecks archived bytes on every retrieval. Missing/corrupt
archives cause an error; rejection remains possible without reading the archive.
Preparation/rejection never changes canonical project, identity, history, editor
revision or live source. Rejection retains bytes, since archives may be shared
by several records with the same hash. These candidate methods do not adopt;
the separate A14 transaction is described below.

The filesystem archive is written before SQLite status. A later validation/SQL
failure or crash can leave an unreferenced archive, or a temporary file after an
unclean exit. It cannot mark an incomplete archive as a usable candidate or
change the original PPTX. Garbage collection/total storage quota and candidate
catalog/progress recovery remain separate work; no automatic deletion or retry
is introduced. Known IDs recover preparations and results after lost replies.

## Generator context

`context` reads the complete baseline and current saved identity in one SQLite
transaction. It rejects rejected/stale candidates and malformed, unbound,
incomplete or source-mismatched identity. The response is `{candidate,mapping}`;
mapping is B4's `{revision,sourceSha256,pages:[{pageId,importPageId,objects:
[{objectId,importElementId}]}]}` shape derived from the Host-bound identity.
All pages and objects are included; no caller can provide this mapping. The RPC
also reopens/hash-verifies the private original archive on every context read.
It returns neither fingerprints nor filesystem paths nor original bytes.

Context survives parser release, original workspace-file deletion and Host
restart. An old A9 record without the original archive can still be read/rejected;
context fails until preparation is replayed against a fresh parse of the same
original saved bytes. Missing or corrupt archives never fall back to mutable
workspace input. Full project/mapping changes invalidate the context.

This read grants no native editing/adoption authority. Main must still check
ownership, active turn, permissions, document binding, dirty/readonly state and
actual source bytes before generation and before any later review/switch.

## View and interpretation

The bounded view contains `candidateId`, `projectId`, declared `kind`,
`targetPageIds`, original `source`, `teachingRevision`, `mappingRevision`,
`status`, `stale`, optional `outputSha256`/`pageCount`, `applied:false` and
`lineageVerified`. Preparing views have null output fields. Legacy/unattested
records retain `lineageVerified:false`; an attested fade or A30 Host redo reports true.

`stale` compares Host project/mapping state, not the live native document or
current workspace bytes. A false value never grants adoption. The Main
coordinator repeats A7's ownership/turn/permission/clean-source fences and
verifies original bytes around generation. Later review/switching must repeat them.

Kind/target alone describe intent. Parsing and hashing alone do not establish
the requested fade. A12 additionally retains the trusted Main generator's
attestation and independently checks parser identities, as below. These methods
assign no old logical IDs to output pages or objects. Even a verified candidate
remains unapplied and review-required; this flag grants no source-switch authority.

## Fade attestation (A12)

`fadeEvidence` is strict `{protocol:"deckwise-main-fade/1",sourceSha256,
outputSha256,mappingRevision,pageId,slidePart}`. It is Main-to-Host only, never a
renderer/model argument. Main derives the target slide part from the actual
presentation relationships and complete Host mapping. Its deterministic generator
reopens the output and checks the fixed fade and exact preservation of non-target
package parts. Main checks the retained result's actual output hash, kind, single
target, single changed part and absence of added parts before submitting evidence.

Host reopens/hash-checks original and output archives, parses identity from the
successful output worker job, and binds the attestation to the prepared source,
output, target and mapping revision. Independently of Main's report, Host compares
every page and object's ordered import IDs, content fingerprints, object types,
geometry fingerprints and source shape IDs with the saved original identity.
Only hash-derived logical IDs may differ. No insert/delete/reorder/object change
is accepted. Invalid protocol, fields, scope, identity or full-project CAS leave
the prior record unchanged. This is a trusted Main attestation plus independent
Host parser checks; Host does not independently inspect ZIP transition XML or
authenticate an untrusted process with a signature.

The optional field is omitted in serialized legacy records, preserving existing
record CAS. Replaying the same staged output can atomically add verified evidence;
different evidence conflicts. A legacy stage replay cannot remove evidence.
Rejected records cannot be upgraded. Evidence survives restart/rejection and
staleness is still reported separately; it proves the retained operation against
its captured baseline, not that the live editor is currently clean or unchanged.

## Host redo attestation (A30)

`redoEvidence` has the same strict six fields as fade evidence, with protocol
`deckwise-main-redo/1` and kind `page-pptx`. Both attestations together reject.
Missing optional fields stay omitted in stored legacy records, preserving their
exact serialized CAS. Same-output replay may add evidence; different evidence,
rejected/adopted records and stale full-project baselines reject atomically.

A trusted producer must verify the actual source/output ZIP bytes against B54's
single-page lineage contract before attesting: unchanged presentation page order,
the logical target resolved through complete Host mapping and actual relationships,
unchanged non-target parts, and only the generated target slide, its relationships,
PNG additions and required PNG content-type declaration changed. Hashes or a model
claim alone are insufficient. Host does not inspect ZIP internals or run that
compiler; its independent D-worker identity check requires unchanged ordered page
import IDs and exact content/object inventories outside the target. Only target
content and object inventory may differ. Both archives are still hash-verified.

This is the Host consumer boundary. The production Main scene/model adapter,
approved PNG inputs, redo attestation producer, native-owner/clean/turn checks,
desktop review/adoption and public Chat mounting remain separate gates. No new
renderer IPC, advertised tool, dependency, source-file writer or package resource
was added by A30. Its initial fixed-fade-only Main/UI guard is superseded by A40.

## Acceptance

`scripts/e2e-courseware-source-candidates.mjs` takes absolute worker, saved source,
pre-generated candidate, declared kind and new evidence directory, plus
`PI_DESKTOP_HOST_BIN`. Run separately against B's frozen redo and fade outputs.
It exercises real Host RPC, D2f parsing, SQLite, archives and full Host restarts:
prepare/recover, exact-byte staging/replay, source unchanged, parser/input cleanup,
cross-workspace/extra-field/hash/tampering rejection, missing/corrupt archives,
full-project staleness, explicit rejection and terminal recovery.

Rust tests cover locks, source/teaching/policy/action/mapping changes, changed
output/reused ID, invalid identity/page count, unsupported media, storage CAS
failure, archive tampering and symlink escape. Existing actual Host identity,
legacy-worker, saved-source association and narration-candidate gates must still
pass after the shared seed-reading change.

With the test-only absolute `DECKWISE_CANDIDATE_GENERATOR_MODULE`, the same
harness obtains fresh Host context and page text, invokes a sealed B4 generator
against the exact original archive, then parses/stages the newly generated bytes.
The A10 evidence adapter validates B4 lineage with that complete real Host mapping
and passes it to D2f reconciliation. It checks both redo and fade, three matched
pages, mandatory review, and rejection of abort, wrong original/target, rehashed
non-target modification, page reorder, unexpected part and different-save hash.
Redo uses a deterministic editable-scene fixture; native document/clean flags are
explicit fixtures. This is interoperability acceptance, not model/native acceptance.

Legacy/unattested redo candidates remain `lineageVerified:false`; attested fade
and A30 Host redo candidates retain validated attestation. Only Chat fade generation is mounted,
not page redo. A13 adds candidate review and preview as described below, but it
does not adopt output, replace/recover source files or reopen the main Office
editor on adopted bytes. Fixed snapshot/player and media/team integration remain
later gates. Host archive operation is verified on Linux x64; other platform
filesystems and power-loss recovery are not accepted here.


## Main Chat fade-copy generation (A11)

`ppt_propose_page_fade` is discoverable through existing ToolSearch and ppt-edit.
The model supplies only a fresh native `editGeneration`. Private context retains
its existing `ppt_get_narration_context` transport name and advertises
`page-narration` plus `page-fade`; blank-text pages advertise only `page-fade`.
Rust treats the proposal as high risk and uses existing permission/audit/abort
handling. Plan/Goal deny it. There is no second assistant or direct renderer RPC.

`CoursewareCandidateCoordinator` checks the active turn, owning visible editor,
clean saved bytes, page/generation, full teaching project and locks. Main prepares
an ID, retrieves authoritative mapping and reads only its pinned saved revision.
The runtime port of sealed B4 tree `16b92c8446c5ef2eee6348b020a884d00b66c374`
resolves slide order through actual presentation relationships and generates one
medium-speed, click-advanced fade. It preserves non-target package-part bytes,
page objects, notes and existing object timing. Unsupported transitions, sound,
auto-advance, ambiguous wrappers, macros, signatures and unsafe ZIP/XML reject.
No model completion is needed for this fixed operation. JSZip 3.10.1 and saxes
6.0.0 match the sealed producer dependencies.

The saved-source parser lease is released before parsing output; Main retains
its exclusive opening lock across this handoff. Failed, aborted and successful
jobs are released by the same lifecycle. A private sibling temporary directory
holds output only until actual Host parse/stage completes, then is removed.
Main rechecks source/native/full-project state throughout. Host retains both
archives independently of those temporary files. The model receives only an ID,
output hash, `needs-review` and `applied:false,saved:false`; source and teaching
remain unchanged. Cancellation or a lost reply can leave a pending preparation
or result, never automatic adoption. Catalog/cleanup remain open work.

`scripts/e2e-courseware-main-fade.mjs` loads production Main coordinators and uses
actual Host, worker, archives and restart with explicit native-state fixtures.
It checks exact package-part preservation, wrong/dirty/hidden requests, abort,
page/teaching changes, competing opens, lease ordering and temporary cleanup.
`scripts/e2e-courseware-chat.mjs` with `DECKWISE_E2E_EXPECT_FADE=1` additionally
exercises actual Electron, native Office, main Chat/Skill/ToolSearch, sidecar and
Rust authorization using deterministic local SSE. Neither fixture tests paid
model reasoning or provider authentication. No candidate switch UI is claimed.

A12 adds actual Main/Host wrong-source/output/mapping/page/part/extra-field
rejections and legacy replay, with verified state after Host restart. Rust tests
cover all-page/object fingerprint drift, evidence upgrade/idempotence, rejection,
restart and a zero-row CAS failure. Main tests reject forged retained generator
reports and unverified Host receipts. Existing Host/Electron gates still apply.

## Candidate review and read-only preview (A13)

The desktop user enters a candidate ID in the existing WiseOffice work panel.
Main opens the saved-source project and requires the candidate to match its
current source hash, project, single logical target, page count and output hash;
stale candidates are not eligible for preview. Lineage verification is displayed;
preview itself does not require it or grant adoption authority. A dedicated child
window opens the Host-archived candidate through the existing WiseOffice editor
in read-only mode. Main verifies the opened document hash and `readOnly/canSave`
state before showing the window. Closing the preview and explicitly rejecting
the candidate changes its review status only; it does not replace the main
editor's file or alter teaching.

`scripts/e2e-courseware-chat.mjs` with `DECKWISE_E2E_EXPECT_FADE=1` now exercises
the full Main Chat → deterministic local SSE → native Office edit/save/restart →
fade candidate → manual lookup/review → separate read-only preview → rejection
flow in actual Electron. The test presses Ctrl+S in preview and checks that the
archived candidate hash is unchanged, then checks original PPTX and teaching are
unchanged. A separate lifecycle regression covers editor IPC/contents teardown.
This verifies source-tree execution on Linux x64, not an installer build.

Adoption is a separate transaction not implemented here. It still needs a
durable original backup and journal, source/hash/owner/teaching rechecks, atomic
or recoverable file replacement coordinated with Host identity/project updates,
rollback after partial failure, and reopening the primary Office editor against
the adopted bytes without losing logical page/object IDs or safe narration.

## Host adoption transaction (A14)

These additional methods are internal Main-to-Host only. No renderer IPC, model
tool or visible adoption button is added by A14.

| Method | Strict request | Result |
| --- | --- | --- |
| `courseware.sourceAdoption.prepare` | `{sessionId,jobId,candidateId,sourcePath?,effectBindings?}` | `{adoption,path}` |
| `courseware.sourceAdoption.get` | `{sessionId,projectId}` | `{adoption,path,archiveError}` |
| `courseware.sourceAdoption.commit` | `{sessionId,jobId,adoptionId}` | Adoption receipt |
| `courseware.sourceAdoption.cancel` | `{sessionId,jobId,adoptionId}` | Adoption receipt |

`path` is a private, hash-verified output archive path returned only to Main.
Prepare and commit require both original and output archives to verify. Get
always returns the persisted recovery receipt; if an archive fails verification,
it returns `path:null` and an observable `archiveError`. A healthy get returns a
verified path and `archiveError:null`. Cancellation relies on the freshly parsed
original revision, so a corrupt candidate archive cannot prevent recovery.
The receipt contains `adoptionId,candidateId,projectId,status,sourceSha256,
outputSha256,sourcePath,project`; `sourcePath` is null for legacy Host-only
records. Project is null until committed and otherwise represents
that committed operation, not a fresh read of any later teaching changes.

Preparation requires a current `needs-review` fixed-fade or single-page redo candidate with verified
Main evidence and a fresh original saved-revision parser seed. Host compares the
entire project, mapping, saved-source export and candidate again. It persists the
intended next project/identity and a workspace lock in one SQLite transaction,
without changing source files, canonical teaching or candidate status. The
record lives in `coursewareSourceAdoptions.v1` keyed by workspace/project; the
single pending lock uses `coursewareSourceAdoptionLocks.v1`. Both use existing
`kv`; protocol 11/schema 18 and historical records remain unchanged.

While pending, normal courseware project/teaching/review/candidate RPCs in that
workspace fail with a conflict. Other workspaces and temporary parsing remain
available. This is a Host teaching fence, not a lock on native Office or external
filesystem writers. Main must close/freeze the owning native editor separately.

Commit requires a fresh successful saved-revision parser seed in the same
project, matching the exact archived candidate hash and full output identity.
Host rechecks the full baseline and writes history, next mapping, next project,
candidate `adopted`/`applied:true`, committed journal and lock removal in one
transaction. Zero-row writes and SQL errors roll all of these back, retaining
the pending journal. Fixed fade preserves every ordered page/object identity;
Host retains their logical IDs, speech/pauses and locks, allocates new mapping
and teaching revisions, and marks the target for review. Valid highlight and
spotlight targets retain their logical IDs. Unsupported media/effects and
historical target mappings still reject.

For redo, the same transaction preserves every ordered page ID and all non-target
object IDs. It assigns fresh Host UUIDs to every target object, even when its
parser shape ID or text happens to match an old object. Original target IDs are
retired in the new mapping; historical mappings remain intact. Target objects
may be added, removed or changed. Speech text, bounded pauses and page locks
survive; the target page requires review and peer review states remain unchanged.
Adopted TTS audio survives fade, single-page redo and representative/batch
restyle only when its existing private receipt matches the previous source and
the exact unchanged logical page, speech action ID, text and audio asset ID in
both projects. Adoption preparation validates this provenance without writing
receipts, before Main can replace source bytes; retry preparation rechecks it.
Commit repeats the check and atomically rebinds only the receipt's source along
with history, identities, teaching, candidate and journal. Paid intents, task
references, archived audio hashes and the original adoption revision remain
unchanged. Missing, unadopted or mismatched receipts reject intact; altered
speech cannot reuse its audio. Unsupported voice fields and legacy audio still
reject before candidate preparation. Supported highlight/spotlight cues on
rebuilt pages require the explicit candidate association described above before
adoption; unchanged peer targets are preserved. This does not regenerate or pay
for TTS.

Cancellation requires a fresh parse of the original saved revision. It only
marks the journal cancelled and removes the lock; the candidate stays pending
and teaching stays unchanged. A later explicit prepare allocates a new token.
Wrong tokens and opposite terminal operations reject. Matching commit/cancel
replays return their stored receipt without a second teaching write. After Host
restart, `get` recovers pending or terminal intent by known project ID.

This is process-restart recovery only. The existing database uses WAL NORMAL;
a verified durability barrier is still required before Main may replace live
files. A14 neither replaces files nor proves they were replaced: its parser seed
proves a saved revision's bytes, not the live editor/source state. Before mounting
the UI, Main must retain the original live path, validate owner/clean state,
freeze/close Office, publish an immutable candidate revision, atomically replace
the live file with hash checks, resolve/roll back pending intent by actual live
bytes, and reopen the adopted file. Unknown third-party bytes must never be
overwritten. Successful database commit alone is not user-workflow acceptance.

Validation: Rust tests cover pending/terminal restart, IDs/actions/history,
unverified/stale/wrong-source rejection, cancellation, competing intents and
zero-row faults at each transactional write. The optional
`DECKWISE_E2E_EXPECT_SOURCE_ADOPTION=1` mode of
`scripts/e2e-courseware-main-fade.mjs` generates through production Main, then
uses actual Host/D2f/SQLite to prepare/cancel/restart/commit/replay. It checks
workspace/field fences, corrupt archives, post-parse changes and immutable old
revisions. It explicitly simulates revision publication and native state; it
does not test live file replacement, real Office adoption or power loss.


## Desktop reviewed adoption and recovery (A15)

The existing candidate review adds an unchecked replacement confirmation and an
explicit **Adopt and reopen** action. Initially limited to verified fixed-fade
candidates, A40 also enables current verified single-page redo candidates. The main-window-only
`deckwise/ppt-editor/pptx-candidate/adopt` accepts exactly `{reviewId}`. Main
retains the candidate token, archive path, source path and owning Chat; none is
selected by the renderer. Model tools still only propose candidates.

Main reparses the saved original, rechecks native binding, clean state, current
page/generation, owner and teaching baseline, then prepares intent with its
canonical absolute live `sourcePath`. Host verifies the path remains within the
workspace, that its path-derived project ID matches the parser seed, and that
actual bounded live bytes match the seed. Prepare replay requires the same path.
Commit/cancel recheck the live file against the newly parsed saved revision too.

After journal writes, prepare/get/resolve execute SQLite
`PRAGMA main.wal_checkpoint(FULL)` and require no busy result and all frames
checkpointed. A blocked checkpoint fails before Main may install bytes. This
adds a durability barrier to the existing WAL NORMAL database; it is not a claim
of tested hardware or OS power-loss behavior.

Main freezes/closes the owning clean Office session and fences ordinary
open/save/close while adopting. It creates an exclusive private sibling
`.NAME.pptx.adoption-ID` directory, writes and syncs the hash-verified candidate,
renames the source to `original.pptx`, syncs files/directories, rechecks the
moved original, then links the staged candidate into the vacated source path
exclusively. File permission bits are retained. A competing file is never
replaced. This is recoverable installation with a short absent-source interval,
not one atomic database/filesystem transaction. The original, staged candidate
and existing saved revisions remain available; no backup GC is introduced.

Resolution uses actual live bytes: original hash cancels, candidate hash commits,
unknown bytes leave intent pending and preserve all versions. Missing live files
are restored only if the backup still matches the journal's original hash and
the source path is still absent. A changed backup remains untouched. Before
commit/cancel Main publishes or reuses a hash-verified immutable saved revision,
parses it, verifies the live hash again and submits its fresh parser seed.
Running parses are cancelled and released on interrupted recovery. Successful
resolution reopens the same source in the owning Chat. Lost commit responses
recover from terminal journal status without a duplicate teaching mutation.

If resolution fails while intent is still pending and live bytes match the known
candidate, Main can restore the verified original through the same exclusive
installation procedure, retain the displaced candidate, then cancel. It never
automatically rolls back unknown bytes or an already committed operation. Opening
the document after process restart first retries pending resolution; unsafe or
unavailable recovery blocks opening instead of silently accepting mismatched
teaching. Legacy pending records without a live path cannot be auto-recovered
by the desktop coordinator.

The initial A15 scope was fixed medium click fade, preserving ordered logical
page/object IDs, speech/pauses and locks; A40 adds reviewed single-page redo
with fresh target object IDs. Arbitrary deck-wide restyle/animation, media/effect
rebinding, snapshot/player integration, backup quotas, installer and Windows/
macOS filesystem behavior remain unaccepted. Directory fsync and hard-link
support are required; unsupported filesystem errors fail closed.

## Desktop-local editable candidate compiler (A35)

`@pi-desktop/courseware-runtime/authoring` now distributes the exact B54 finite
scene compiler and single-page candidate/lineage implementation, with import-only
Desktop adaptations recorded by `authoring-provenance.json`. Its pinned private
PPTXGenJS 4.0.1 fork and MIT license travel with the bundle; no MAIC checkout,
server Agent or registry PPTXGenJS is needed. Conversion, worker and player
bundles do not import this isolated Node authoring entry.

The caller supplies an authorized scene callback, immutable source bytes and a
fresh baseline reader. Strict scene validation permits native text, supported
preset shapes, connectors and approved PNG layers. Generation preserves the exact
source canvas, peers and notes; unsupported packages, stale baseline and aborted
work reject. Output remains `needs-review`, `applied:false`; neither source files
nor Host teaching are changed. Returned lineage still requires current Main/Host
verification and the existing explicit review/adoption transaction.

Existing worker staging also inventories `authoring.mjs`, its license/provenance
and native dependencies. Linux x64 output includes the status expected by the
existing Desktop resource validator; other platforms are not mislabeled Linux.
The relocated public-API gate verifies source hashes, allowed dependencies and
Desktop resource validation before compiling/replacing pages outside the checkout.
Public declarations and exact-source compiler/candidate tests are checked too.

The actual Electron scene-completion gate now passes Main's authenticated image
completion callback directly into this bundled compiler for both 16:9 and 4:3.
It uses local fixture responses/PNGs and synthetic mappings. It verifies editable
native output, peer/notes preservation, source immutability and logical page
lineage. It does not exercise a public Chat redo tool, actual source-page visual
master/clean-plate production, review/adoption UI or a new packaged application.
Linux `--no-sandbox` remains a test-only allowance. Native charts, masters,
arbitrary animation and imported-PPTX fidelity are outside this compiler gate.

Next integration must resolve real authorized source visuals and clean plates,
then connect bounded Main generation/byte-lineage verification to existing Host
staging, review and recoverable Office reopen. Do not expose public redo based
solely on the compiler's success, or reuse the original rendered text-bearing
page as a fabricated clean plate.

## Private source-page rendering (A36)

Main's `PptEditorController.renderSavedPagePreview` uses the existing bound
editor channel and request correlation. It accepts only a newly opened readonly
saved PPTX, with no dirty/pending/uncertain-save state. Ordinary editor opening
now requests private page lineage; Agent tools continue stripping those tokens
from model-visible context. No renderer IPC or public Chat tool is added.

The producer is an independent A-owned Office consumer derived from the exact
A34 sources plus B61 PNG integrity and B64 native textless rendering. A finite
optional one-based `page` field extends `document:render-page-preview`; it draws
that slide directly without navigating the current document. Omitted `page`
retains B64 behavior. Parent/source/generation/history/readonly guards, unsupported
native-text omission refusal and renderer cleanup remain in place.

Main retains source hash, exact original ordered page tokens and requested page.
It checks them and editor identity before/after native rendering and a fresh
context read; cancellation closes the request boundary. Replies must have exact
source/page/token, PNG MIME, omission flag and finite fields. Images use the
1600-pixel longest-edge contract, bounded dimensions/bytes, actual native decode
and full PNG chunk CRC checks before copying into scene inputs. The CRC check
also applies to existing team/model PNG inputs. Returned images are owned copies.

This is an internal rendering primitive for the future candidate coordinator.
It does not map private page tokens into Host logical IDs, create an automatic
clean plate, grant asset authority or mutate teaching/source. Pictures may retain
raster text even when native text is omitted; explicit review is required. Pages
with unsupported grouped/chart/translucent/warped/shadow content need another
reviewed clean plate. Main/Host owner/baseline binding, bounded lifecycle,
clean-plate review UI and the actual Chat redo/adoption/reopen path remain next.

## Current-page visual review (A37)

`CoursewareVisualReview` binds one in-memory visual review to the existing owning
Chat, active workspace, clean saved writable editor, source path/hash/revision,
native editor identity/generation/current page and full canonical Host project.
The existing teaching coordinator owns saved-source parsing and releases its
parser lease after success, failure or cancellation. Host resolves the logical
page from that verified source; renderer input cannot choose a path or page.
Missing/locked pages refuse preparation. Approval and subsequent private loading
repeat editor/owner/workspace and Host checks around asynchronous reads.

Main opens the live source through a separate forced-readonly native controller
and hidden isolated window. It validates the same saved revision, then uses
A36's finite renderer for ordinary/native-textless PNGs. It rechecks source and
canonical page count/token mapping, retains owned bytes and disposes the temporary
controller/window in all outcomes. A combined cancellation/90-second preparation
deadline aborts outstanding work. The owning editor is never navigated or edited.
The optional Main-only readonly open flag preserves ordinary writable defaults
and prevents reuse of a differently configured editor session.

The existing teaching sidebar previews both images. Native text omission does
not remove words inside pictures or duplicated non-text foreground content;
explicit human inspection, an unchecked checkbox and a separate approval action
are mandatory. Unsupported native content must use another reviewed background.
Preview, model inference and publication approval are distinct operations.

Only Main's private `load` can release approved visuals and a fresh-state guard.
Preparing again, clearing, editor open/close/hide or sidebar disable/unmount/Chat
replacement revokes the retained review. Source/page/generation/teaching/lock,
workspace or owner changes invalidate later approval/loading even when the old
preview is still visible. A stale/failed approval clears its UI proposal. Parent
narration/image/TTS/playback interactions are disabled during preparation; busy
status does not disable its own cancel control. Restart loses review/approval;
no SQLite teaching record, durable asset grant or source byte is changed.

This checkpoint exposes visual preparation/review only. No public Chat redo tool,
scene-model invocation, editable candidate staging/adoption or package acceptance
is implied. Those must consume the fresh private guard and independently verify
compiler lineage, followed by explicit candidate review and recoverable adoption.

## Reviewed single-page redo staging (A38)

`stagePageRedoCandidate` is a private Main producer. It accepts only the current
approved `CoursewareVisualReview.load` result and the current saved-source/page/
teaching/model guard supplied by the owning coordinator. It rechecks approval
around asynchronous baseline reads and before/after model work, parsing and
staging. Project/page/source mismatches reject before Host writes. A cancelled
or stale completion cannot replace the source; a late stage may leave only a
pending review candidate.

Main reads its pinned saved revision with the same bounded, no-follow,
SHA256-checked reader used by fade generation. It resolves the current logical
page through Host's private mapping and passes both reviewed native PNGs to the
existing scene callback. The local compiler is dynamically loaded beside Main's
selected installed PPTX worker, preserving its native dependency resolution.
No renderer, model or tool supplies a compiler path. Missing compiler fails
before candidate preparation. Existing old worker bundles are not silently
upgraded or rewritten.

The retained compiler result must pass the byte-lineage verifier, exact output
hash and 50 MiB output limit. Main reparses the private output using Host before
attesting `deckwise-main-redo/1` with exact source/output/mapping/page/slide-part
fields. Host must return a current verified, unapplied `needs-review` receipt.
Temporary output is removed on success or failure. Only an opaque candidate
receipt and warnings leave the function; source replacement/adoption are absent.

This checkpoint uses actual approved native images and Host/parser, with a local
deterministic scene callback. It does not mount the public Chat redo tool, extend
the fade-only adoption guard, or claim live-provider quality. Native-textless
background limitations and unsupported teaching/media/effect rebinding persist.

## Explicit saved-image locks (W11.2)

The existing teaching sidebar can lock or unlock a current saved ordinary PNG/JPEG
picture by its Host logical UUID. This is separate from a whole-page teaching
lock: an image lock does not prohibit redo or confirmed batch restyling. Main's
`CoursewareAssetLockCoordinator` accepts exact view/revision/UUID commands; it
derives the source path, native node, bytes and proof privately from the current
saved teaching view. The Renderer cannot submit an XML ID, asset hash or path.

Host retains revisioned lock records in `coursewareAssetLocks.v1`. Each entry is
bound to source SHA256, mapping revision, page/object UUID, parser content and
geometry fingerprints, original object index, raw media SHA256 and the picture
XML SHA256. Only the native `cNvPr` numeric ID is normalized in that XML hash.
The native ID locates a node inside the exact saved revision; it never serves as
a stable identity across native saves. Main is the trusted local PPTX proof
producer; this private Host RPC is not a Renderer or public network contract.

Generation pins the lock record revision along with the existing source/teaching
baseline. Any later lock mutation makes an old candidate and its batch
representative stale. The existing compiler grafts the verified original picture
node at its saved object index, retains its original image relationship/media,
and renumbers only a colliding numeric native ID. All other picture XML, raw
media bytes, geometry, layer index and non-target package parts remain verified.
Insufficient generated siblings to retain the saved index reject the candidate;
no hidden shape padding or geometry change is invented. Existing advanced
object/crop/group/effect/transform cases remain ineligible.

Main verifies byte lineage and Host independently checks the reparsed output's
image kind, content, geometry, index and attested output native ID. Only those
explicitly locked pictures retain their canonical UUID during source adoption;
other rebuilt objects receive fresh IDs. The existing adoption transaction also
rebinds current lock entries to the adopted source/mapping/native ID. Two
successive redo/adopt cycles must preserve the same locked UUID and picture
proof. Narration, adopted audio, checkpoints, peers and existing fail-closed
unsupported-cue rules remain unchanged.

A native source save does not silently rebind a lock. Stale locks must be
explicitly cleared and the current saved picture explicitly relocked after the
existing saved-source review. The current page can clear its stale entries and
deleted-page orphan entries; an existing peer-page lock cannot be cleared from
another page. Lock mutations use source, teaching and lock-revision CAS, refuse
read-only/dirty/stale/foreign views and respect the page/adoption lock barriers.
