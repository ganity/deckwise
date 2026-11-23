# 讲解直接保存

审核新生成的讲解时，模型可给出某个讲解段落的完整替换文本。所有意见都能明确落到对应段落时，程序只替换这些段落的文字，再校验并复核整页后保存。用户要求保留的讲稿和只需补效果的已有语音保留原文。

> **原文镜像说明：** 本页保留完整英文规范，尚未提供全文中文译文。协议字段、约束和验收条件以 [英文源规格](/spec/03-runtime/24-courseware-narration-candidates) 为准。


## Direct save (2026-10-26)

Narration generation directly saves authoritative teaching. There is no candidate
review or adoption step in Chat or the teaching sidebar. The existing tool names
are retained for compatibility. Source-edit candidates keep their separate review.

`courseware.narration.save` accepts strict `{sessionId,jobId,baseline,write}` and
returns `{project}`. Host derives the workspace from the persisted Agent session,
verifies the saved parser source, validates the complete project baseline and
write revisions, rejects locked target pages and stored target-page drafts, then
archives the old project and writes teaching in one SQLite transaction. A failure
rolls back both writes. Independent music is retained; replaced speech audio and
cues are cleared. Other pages and the original PPTX remain unchanged.

The single-page receipt contains `kind:"page-narration"`, its original `baseline`,
new `teachingRevision`, `pageNumber`, `applied:true`, `saved:true`, `audioReady:false`.
The runtime validates that receipt without rereading the obsolete pre-save
teaching revision. Chat progress records `saved`, without a candidate reference.
The batch receipt contains sorted `savedPages`, per-page `failures`, `diagnostics`
and the deck plan. Its aggregate `saved` is true only when every requested page
saved; `applied` reports whether any page saved. Cancellation may retain completed
pages. Never retry an uncertain save without rereading authoritative teaching.

Legacy candidate records and RPCs below remain supported for compatibility; their
review/adoption contract no longer describes new narration generation. No legacy
data is automatically adopted or deleted. Current behavior is specified here and
in the saved-page section below.

## Legacy candidate compatibility

## Scope and authority

A narration generator produces a **proposal**, not authoritative teaching. The
trusted coordinator stages B's canonical `TeachingWrite` only after validating
its generator response against the latest clean native editor and project.
Host then stores the proposal separately from the current project. Explicit
adoption changes only the selected logical page's actions and teaching revision.
Source bytes, source revision, page IDs, other pages and education context remain
unchanged. New speech has no ready audio and remains `review`.

An existing `audioAssetId` does not prevent proposing replacement narration.
The proposal contains fresh speech IDs and no audio reference: old audio cannot
silently narrate new text. Until explicit adoption, current teaching and audio
remain unchanged. Adoption archives the old project through the existing
history transaction; previously captured fixed builds remain immutable. Locked
pages and unsupported actions/cue-bearing teaching retain their rejection guards.

An already adopted `teacher_continue` checkpoint also permits a subsequent
narration proposal, including after restarting the app. Its strict fields are
`id`, `type`, `checkpointId` and `checkpointKind`; malformed IDs, other checkpoint
kinds and extra audio/text/cue payloads reject before model use. Only speech text
is passed as existing narration, so checkpoint IDs are not spoken content. A
new structured checkpoint can be proposed again and still requires explicit
review and adoption. This rule is shared by plain, import and scene task types;
it does not enable the deferred scene-generation entry.

These methods are internal Main-to-Host operations. They are not generic
renderer IPC or tools advertised to the model. The A7 Main adapter uses
the existing `tools.execute` permission/turn/cancellation path for proposals and
validates active Chat ownership, native binding/page/generation, dirty,
readonly and uncertain-save state before dispatch. A parser job alone cannot
prove the native editor is still clean or that the on-disk live file still equals
its saved archive. These native-selection requirements apply to the legacy tools;
the explicit saved-page tools below use independently verified saved source.

## Host methods

All request envelopes are strict. Workspace authority comes from the persisted
session; stage/adopt require its successful saved-Office-revision parser job.
Host reopens the archived bytes and verifies the completed-job hash on each call.

| Method | Parameters | Result |
| --- | --- | --- |
| `courseware.narrationCandidate.stage` | `{sessionId, jobId, candidateId, write, pageScoped?}` | Candidate view |
| `courseware.narrationCandidate.get` | `{sessionId, projectId, candidateId}` | Candidate view |
| `courseware.narrationCandidate.reject` | `{sessionId, projectId, candidateId}` | Candidate view |
| `courseware.narrationCandidate.adopt` | `{sessionId, jobId, candidateId}` | `{project}` |

The view is `{candidateId, kind:"page-narration", status, write, audioReady:false}`.
It contains actions for the trusted review consumer; do not return this whole
object to the model. B3's Agent receipt remains a distinct, bounded response
without action payloads. `candidateId` is the trusted producer/coordinator's
bounded operation ID, not an authorization token. Requests never select a
workspace path, source hash, replacement project, provider, key or lineage.

`write` uses the existing canonical `TeachingWrite`: project/page IDs, expected
source/teaching revisions and actions. IDs must match the verified seed and
current project, and the target must exist and be unlocked. The entire current
project is captured as the private baseline. A same-ID/same-baseline/same-write
stage replays its original view; different input conflicts. A rejected record
is never resurrected by a stage replay. Staging after adoption does not
automatically generate or apply another proposal.

## Persistence and transitions

`coursewareNarrationCandidates.v1` uses the existing Host-owned SQLite `kv`
pattern, keyed by canonical workspace/project and candidate ID. Each strict,
bounded record contains the complete baseline project, canonical write and
`needs-review`, `adopted` or `rejected` status. No schema migration or change to
the standalone canonical module/hash is required. Each record is at most 2 MiB.

Staging never writes teaching. Pending status/data survive parser release and
Host restart and can be retrieved using the saved candidate ID. Status denotes
the lifecycle, not proof that the baseline is still current. There is no list,
generation-progress, expiry or historical recovery UI in this checkpoint.

Rejecting a pending record uses record CAS and leaves the project unchanged.
Rejection is idempotent, including after baseline changes. Adopted proposals
cannot be rejected or adopted again. Different workspaces cannot retrieve,
reject or adopt another project's proposal, even with a known ID.

Adoption revalidates saved source hash, page count and canonical project identity
against the fresh parser seed. It compares the **complete current project** to
the captured baseline, covering source/teaching revisions, all page content and
locks, task type, title and education policy. For legacy candidates, a change on
another page also invalidates the proposal under the project-wide teaching revision.
Any future education-policy setter must advance that revision too.

One SQLite transaction archives the complete old project in
`coursewareHistory.v1`, applies the existing teaching-write CAS/lock check and
sets candidate status to `adopted` with record CAS. Failure at any point rolls
back all three. A lost post-commit response is resolved by retrieving candidate
status and the current project; do not blindly replay adoption. A stale proposal
can still be rejected, but must be generated/staged under a new ID to update it.

## Supported actions and limits

The target's existing actions and new proposal support speech with `id`,
`type:"speech"`, string `text` and optional integer `pauseAfterMs` in 0–30000,
plus the existing `interaction_checkpoint` action with
`checkpointKind:"teacher_continue"` and bounded `id`/`checkpointId`.
The checkpoint has no spoken text or duration; the fixed player waits for the
teacher's existing continue control. Fixed waits remain `pauseAfterMs` on speech.
Text is at most 32,000 UTF-16 code units per speech; existing envelope/action
count and total record limits also apply. Empty action arrays are valid proposals
and still require explicit review before adoption.

An existing speech `audioAssetId` is allowed as described above, but is never
copied into a replacement proposal. Voice settings, cue/effect actions and
other unsupported fields on the target reject intact. No unsupported field is
silently removed. Other pages'
actions, including audio/effects, are preserved by adoption. Action-specific
media invalidation, voice preservation and safe cue rebinding remain separate
work. B's structured wait blocks already map to `pauseAfterMs`; the frozen B2
fixture exercises that real producer shape. A4's native-source migration
historically rejected additional pause fields. A8's explicit saved-source review
now preserves bounded pauses, as described below.

## Verification and remaining integration

Real SQLite tests cover the frozen B2 output, idempotency, restart before/after
adoption, target-only writes, archived history, stale source/teaching/lock/policy,
workspace isolation, rejection, malformed/oversized actions and SQL failure after
the project update. Actual Host/D2f integration additionally checks strict RPC
envelopes, parser workspace ownership, saved-byte tampering and terminal recovery
across process restarts.

The actual B output's action payload is rebound to real Host IDs for this Host
gate. It does not validate an authorized generation service, real model quality,
existing-main-Chat candidate tools, native clean-state coordination or UI review.
No PPTX/fade candidate bytes, candidate file replacement, Office reopening,
immutable snapshot/player, TTS/media, collaboration or packaged acceptance is
implemented by these four methods.

## Existing-sidebar review (A6)

The existing narration panel accepts the bounded candidate ID from a receipt.
This is recovery/review of an already persisted proposal, not a generator or a
candidate catalog. A7 returns the ID through the existing Chat proposal tool;
there is no second assistant or separate generation button. Main never accepts actions, project/page
IDs, paths, source hashes or workspace from this renderer operation.

Two finite, main-window-only IPC channels are added:

- `deckwise/ppt-editor/narration/review`: strict `{sessionId,candidateId}`.
- `deckwise/ppt-editor/narration/decide`: strict `{reviewId,decision:"adopt"|"reject"}`.

Review requires the active visible editor's owning Chat, current editable page,
clean completed saved revision and unchanged native binding/generation. Main
reuses the saved-source parser lifecycle, resolves the canonical project/logical
page from those exact bytes, then retrieves the scoped candidate. A receipt for
another page rejects. A final native/owner check rejects late results. Main
returns an opaque review token plus current teaching, proposed actions, status,
page number, `audioReady:false` and a `stale` hint. Renderer cannot choose a
Host project or use a candidate ID to adopt directly. Reloading teaching or
preparing another review invalidates the old Main token.

The UI shows current/proposed speech, structured pauses, an explicit empty-page
warning and missing-audio note. Adoption requires an unchecked-by-default
confirmation. Known stale revisions/locks disable adoption; terminal proposals
are read-only. Reject remains available for a pending stale proposal. Closing
review changes no persisted status. Save/discard a local narration draft before
opening a candidate. Draft narration and source-association review cannot be
edited while a candidate review is open.

Before either decision Main checks current native page/generation, binding,
saved hash/revision, clean/readonly/uncertain-save state, workspace, Host and
active Chat owner again. It reparses saved bytes and repeats the fences before
calling the finite Host method. The shared teaching coordinator now also checks
the actual original file in its current workspace using a bounded streaming
hash; externally changed bytes or an escaping symlink reject even when the
archived saved revision is intact. It rechecks native state after that I/O.
This check also protects ordinary narration and source-association review. An
external writer is not transactionally locked across the final Host CAS; edits
after the last check require reload/review and are never written by adoption.
Host full-baseline CAS remains authoritative:
`stale:false` is a UI hint, never permission or proof that policy/other pages are
unchanged. Main consumes the token before dispatch; lost replies require opening
the known candidate again to inspect persisted terminal status, never automatic
retry. A committed adoption cannot be undone by a late UI/cleanup error.

The A6 Electron gate stages frozen B2 actions with actual Host RPC while Desktop
is stopped, then restarts the real app. This proves review/adoption/rejection and
restart, not generation, main Chat proposal transport, live model quality or
packaging. The raw Host methods remain unavailable as generic renderer RPC.


## Existing Chat generation (A7)

`deckwise/ppt-edit` instructs the existing main Chat to discover
`ppt_propose_page_narration` with ToolSearch. The model supplies only a fresh native
`editGeneration` and a nonempty instruction of at most 8,000 characters. A11 also advertises a fixed current-page fade-copy tool; page redo is not mounted.
See [source candidates](25-courseware-source-candidates.md).
The runtime privately obtains `ppt_get_narration_context` through Host, then
submits a baseline-bound proposal through the same permission/audit transport.
Rust classifies private context as low risk and the proposal as high risk,
regardless of caller-declared risk. Durable Plan mode rejects both.

Main resolves the visible owning editor, clean saved source, logical page and
full canonical project, including education policy and all page locks. The
internal `courseware.pageText({sessionId,jobId,pageNumber})` verifies the saved
archive and the parser IR digest pinned at completion. It extracts only bounded
text/table content from the exact current page. Paths, notes, asset URLs and
other pages are not model inputs. Image-only pages reject; image/video/chart
understanding is not implemented. HTML text markup is retained as document data.

B's frozen generation profile registry, kindergarten English commands,
single-page generator and strict output schema are vendored with provenance.
Only import/type adaptation and the existing kindergarten-stage predicate are
replaced locally. Canonical school stage/subject are normalized to uppercase;
`fullEnglishTeaching` is preserved. Task type does not choose school stage.
Without an education context, the existing enterprise/default profile applies;
Main does not infer kindergarten from the user's request. Policy setup UI is
separate from this single-page integration.

The existing Main plugin one-shot completion is reused with the current Chat's
provider/model/thinking setting and existing managed-platform-token, vendor OAuth
or provider authentication resolver. It retains the configured relay path,
including llm-ha. There is no new unauthenticated production endpoint, nested
sidecar RPC or renderer API key. Completion explicitly skips editor recapture
and rejects provider/model fallback. Only current-page text, current narration,
instruction and teaching policy are sent; no full Chat history is requested.
Usage is added to the existing active turn.

Output must be a JSON object containing 1–100 strict speech/english_phrase/
wait/praise blocks, including speech. No Markdown/control markers/unknown keys
are accepted. At most one praise and two `english_phrase` blocks are accepted
per page; `english_phrase` and praise blocks are rejected unless the configured
stage and subject are kindergarten and English. Each `english_phrase` must
match the existing kindergarten command bank, including its approved `Good!`
encouragement. Praise is one of four modest participation phrases.

The shared generator supplies the same stage-specific block instructions and
JSON format to the model: ordinary and non-English subjects permit speech/wait;
kindergarten English additionally permits its bounded English/participation
blocks. Main forwards that prompt unchanged and validates the returned JSON
through the same shared schema. It must not append a conflicting universal
praise example. Source acceptance requires rebuilding agent-runtime before
Desktop so an older dist cannot mask the current stage restrictions.

Waits attach to the preceding speech as `pauseAfterMs`;
leading waits or cumulative pauses over 30 seconds
reject. The schema's longer wait allowance is therefore narrowed at the canonical
adapter. No answer recognition, correctness assessment, TTS or ready audio is
claimed. The target's unsupported audio/voice/cue/effect fields reject intact.

Before and after model work Main rechecks native binding/page/generation,
visibility/owner/turn, clean/readonly/saved source, full project equality and
current Chat model settings. Late source, policy, teaching, other-page or lock
changes reject. Host staging/adoption keeps its own authoritative baseline CAS.
A final external-file/native/model check is not an atomic lock on those external
resources; explicit later review and Host CAS remain required.

AbortSignal propagates runtime → `tools.abort` → Host `ppt.cancelExecution` →
Main dispatch cancellation → model completion. Main also checks active ownership
at 100 ms intervals and bounds generation to 180 seconds. Parser waits observe
abort and release/cancel their job. A result already staged before a lost or
cancelled reply can remain pending; it is never automatically adopted. Inspect a
known receipt ID rather than blindly retrying. No candidate-list recovery UI is
added. Native edits dispatched before cancellation remain a separate limitation.

The Chat receives only a bounded needs-review receipt with candidate ID,
baseline, `applied:false`, `saved:false`, `audioReady:false`; no action payload or
source bytes. The user opens that ID in the existing sidebar, compares text and
pauses, and explicitly adopts or rejects. Adoption updates only the logical
page's teaching; PPTX bytes and other pages remain unchanged. A4's source
review preserves speech text and bounded pauses after explicit page association;
media/object-bound actions still reject intact.

A7's local deterministic SSE fixture exercises the real Composer, runtime, Host,
Main completion, Office, review UI, SQLite and restart. It does not verify real
paid-provider credentials or model quality, full packaging, PPTX/fade replacement,
immutable snapshot/player, TTS/media or collaboration.


## Saved-source review after narration generation (A8)

After adopting generated speech with `pauseAfterMs`, a subsequent native Office
edit/save still requires explicit source review. Host now accepts optional integer
pauses from 0 through 30,000 ms on speech; the complete action, including its ID,
text and pause, is cloned unchanged onto the explicitly associated logical page.
No timer conversion, ordinal association or automatic adoption is performed.

The existing source-review panel displays pauses using the existing localized
pause label. All page choices start empty and final confirmation remains
mandatory. New/copied pages start with empty teaching; a selected old page may
appear only once, and locked pages cannot be omitted. Every resulting page stays
`review`, even when its narration and logical ID are retained. This preserves
timing data without claiming the old explanation still fits edited visuals.

Pause is page-local silence attached to speech; it has no audio asset, object
anchor or absolute media-clock reference. Unsupported audio/voice/cue/effect
fields, standalone wait actions and malformed/out-of-range pauses still reject
intact. Full project/mapping/source CAS, transactional history/identity/project/
review consumption and native clean/save/owner fences are unchanged. Adoption
never rewrites PPTX bytes. This does not implement generated PPTX switching,
media invalidation/rebinding, automatic lineage or immutable playback.

Run the existing real Chat gate with `DECKWISE_E2E_EXPECT_NARRATION=1` and
`DECKWISE_E2E_EXPECT_SOURCE_PAUSES=1`: generate through Main, explicitly adopt,
edit/save in native Office, observe the teaching conflict, review/associate all
pages in the real sidebar, explicitly confirm, then fully restart Desktop/Host.
Speech IDs/text/pauses and non-target teaching remain unchanged, source hash
advances to the actual saved PPTX, and restart restores the entire adopted project.


## Trusted narration source selection (B99 proposal)

`CoursewareCandidateCoordinator.selectNarrationSource(sessionId, selection,
canDispatch)` accepts exactly `{kind, baseline, text}` from a trusted Main/Host
consumer. `kind` is `original-notes` or `external`. The consumer must prove the
notes came from the exact saved source/logical page, or explicitly bind the
user-selected external text to that page. Self-reported kind/hash and an ordinal
alone do not prove either origin or consent. This method is not a new model tool
or renderer IPC; no source-selection UI is mounted by this proposal.

Selection is copied before any await; the existing speech schema trims outer
whitespace, preserves internal newlines, limits text to 8,000 characters and
rejects speakable wait/praise markers. The existing saved-source/native owner,
page, edit generation, full canonical project, policy, manual lock, cancellation
and staging guards remain. No provider/model is consulted for selected text.
Generated narration and current fade/redo/confirmed-batch behavior retain their
model/permission/review paths. Explicitly selected notes may serve a textless
page; generated narration still requires nonempty extracted page text.

Both sources use the canonical narration writer and actual Host pending store.
The bounded receipt remains `candidateId/kind/baseline/reviewState/applied`, with
`applied:false`, and exposes no selected text, actions, source proof or path.
Existing review/adopt/CAS decides authoritative teaching; source PPTX and notes
are never written. Current vendored writer rejects interactive or audio-bearing
target actions rather than silently discarding them. New speech has no ready
audio. Notes are an input option, not a second teaching authority.

## Saved-page narration (2026-10-25)

The main Chat exposes `courseware_narration_context` and
`courseware_narration_propose` independently of the Office binding. The former
returns a saved deck outline, source hash and optional explicitly numbered page
text. The latter accepts explicit page numbers, that source hash and an
instruction; it processes the complete requested range without human navigation.
It directly saves each completed page and returns savedPages plus per-page errors.
No PPTX or audio is generated or applied. Model calls reuse the current Chat's authorized
model, including its vision input path when available.

Host extracts bounded plain text, tables, speaker notes and saved-page objects.
Main renders a sanitized disposable copy of the saved PPTX with local
`libreoffice` and `pdftoppm`, without opening an editor. The copy removes external
relationships, macros and embedded objects; the original source is unchanged.
If rasterization is unavailable, bounded embedded images are used and a diagnostic
is returned. Image-only pages are supported when the authorized model can read
their visual evidence; pages without readable evidence fail individually.

Visual observations for the ordered deck feed one whole-deck plan, then each
requested page receives its own evidence, purpose and adjacent-page bridges.
Successful page evidence is cached for the same session, source, mapping and
model. A batch has at most three concurrent calls, a 180-second per-call timeout
and a 14-minute overall deadline. This does not establish real-model quality.

Speech may carry bounded `attention` intent (`highlight` or `spotlight`, with
1–8 unique saved logical object IDs). Runtime and Host reject invented,
cross-page or unsupported targets. Generation supplies no model-authored timing.
After narration is saved, the existing TTS flow converts this intent
into speech-local visual cues from zero through the decoded audio duration on
audio adoption. It removes the intent and requires fresh teaching review.
No audio is generated or adopted automatically.

Main derives the source from the persisted Chat task, verifies workspace-contained
saved bytes, reuses the Office revision archive and Host parser, and releases the
parser on success, failure and cancellation. Saved-source, teaching, model and
turn changes prevent saving. Preview visibility, selection and page navigation
are absent from this path. Interactive native edits keep their existing binding.

Main serializes current-state checks and direct saves so parallel model calls do
not mistake peer saves from this batch for user edits. Each successful save
advances the expected project. Source, policy, identity, lock, model or external
teaching changes still stop later saves. Failed pages are reported independently;
successful pages remain authoritative and survive Host restart.

Chat displays saved page receipts and invalidates the clean teaching view for
reread. No candidate lookup, review or adoption is shown for narration. Existing
stored drafts are preserved; the sidebar moves its instruction-only draft into
the Chat request before generation so it cannot block its own save.

The human Office sidebar has Narration, Voice, Effects, Assets and Review tabs.
Narration is selected initially. Inputs remain mounted across tab changes, while
only selected-tab content is visible. Source-edit review forms and recovery records
are in Review; detailed usage copy is collapsed. Keyboard arrows, Home and End
navigate the tabs. This human UI is not an Agent execution dependency.

## 单页讲解修复

画面定稿后，视觉回复格式错误时，工具指出具体字段。纠正后仍有格式错误的检查意见时，可使用已经单独校验的对象，并排除未经核实的备注。对象批次整体无效时，仅可采用当前页可见原生文本框中的文字。效果目标和时序仍需与已保存的讲解核对。预览或采用内联讲稿、教案前，工具核对当前会话中的用户原文。附件继续使用原始材料 ID。单页生成讲解使用讲解工具。
