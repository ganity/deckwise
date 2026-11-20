# Saved narration

For newly generated narration, a semantic reviewer may supply the complete corrected text of an individual speech block. Apply a local edit only when all findings have unambiguous corrections, then validate the draft and review the whole page again before saving. Preserved scripts and existing speech under effects repair retain their words.

## Independent native activities

Native body narration always rejects executable interaction and teacher-continuation
blocks, including imported PPT and PPT Master pages without generation metadata.
The single-page candidate and required-action repair entry points obey the same
rule. Spoken learner prompts and fixed waits remain ordinary narration.
Accepted Quiz/checkpoint units insert a real new PPT page after the requested
stable page ID. Visible practice text or an accidental checkpoint on an original
body slide must not force conversion/reuse of that body slide. Mapped independent
activities remain idempotent.

The native assessment editor uses saved Quiz content, generated page requirements
or a bound activity unit to identify page purpose. Short-answer checkpoints remain
interactive pages. Original or planned body pages containing historical questions
keep the body narration editor and retain their saved actions/media unchanged.
Older standalone activities without planning metadata retain their editor only
when their content consists of a checkpoint and its exact question reading.
No automatic migration, deletion or expansion of historical questions is performed.

## Grounded teaching moves

Teaching requirements and the education context determine the learning objective,
audience and teaching move. Actual exported slide text and visual evidence constrain
claims about the slide. Speaker notes and existing narration are reference drafts,
not proof that a planned object exists and not a script to copy verbatim.

Saved-deck paths use structured visual observations when vision is available.
Native Scene layers may instead supply bounded supplier name/description hints
whose embedded PNG hash still matches the current local image. The compiler
stores these optional hints in picture alternate descriptions; they survive
Office save/reopen. They are not exact OCR or executable instructions. Missing,
replaced, cropped, rotated/flipped or grouped images use observation; known
neighboring identities are not rediscovered. Isolated current layer images and
UUID bindings accompany independent narration and final content review. Neither
review nor any business completion gate is removed. Older metadata-free files
remain compatible and are not silently migrated.
Observations retain current UUID and shape validation, with one JSON-format repair.
Missing concrete visuals required by the teaching plan fail that page before saving
narration or requesting its TTS; repair the source page instead of inventing content
or changing the objective. Conflicting notes are excluded from the in-memory evidence
and reported in diagnostics; original files remain intact. If vision is unavailable,
the text/notes fallback explicitly reports that visual completeness was not verified.
Cached evidence includes the current teaching requirements in its identity.

Validated page briefs are cached with that evidence, the requested instruction,
approved plan, model and education context. A failed-page retry may reuse the
unchanged arc; otherwise the legacy saved-project planner receives the full outline as context but emits
only the selected body-page briefs in their exact order. The strict JSON schema
is supplied to the model and unexpected fields are named in repair feedback.
Neither a partial save nor a cached plan certifies whole-course completion.

A full sentence text carrier does not suppress matches for the word or character
it names. Longer pictured identities still disambiguate shorter aliases; foreign
UUIDs, unrelated targets and empty backplates remain invalid.

A speech block represents a complete teaching move on one focus, keeping related
sentences together. Focus changes or learner turns start new blocks; the canonical
writer no longer mechanically splits every sentence into a new audio task. The
existing 4000-character action bound and lossless long-text splitting remain.
Kindergarten guidance prefers 2-4 concise moves, without truncating required content.
Reading cues contain their exact target expressions; waits belong only to real
learner turns. Whole-deck planning receives assessment-page context without generating
body narration for those pages, so the final body bridge need not close the lesson
prematurely. These guidance rules do not certify model-generated pedagogy without
review of the actual output.

Focus normalization splits at complete sentence boundaries, not commas or colons.
Adjacent detached reading cues may join the following speech only without an
intervening wait/media block or incompatible explicit focus. Mid-sentence anchors
are validated but start focus with the intact sentence; sentence-boundary anchors
can still leave preceding complete speech unfocused. Text, learner waits and
entrance-once behavior remain intact. Existing saved speech/audio is not migrated.

The deck plan may additionally carry bounded `mustMention`, `avoidRepeating` and
`deliveryContract` lists per page. Planning receives logical-page teaching metadata
and later assessment context. Exact visible target expressions inform modelling;
prior explanations inform repetition avoidance, not a vocabulary blacklist.
Older plan shapes remain accepted. Before a generated write is saved for TTS,
detached reading cues, narrowly recognized unsupported classroom-result claims and
omitted literal Latin target expressions backed by visible text reject with
page-specific `INVALID_OUTPUT`. The existing at-most-two page corrections repair
these failures without rewriting successful peers or retrying provider failures.
This is not a general semantic validator: paraphrased objectives, Chinese target
coverage and all possible unsupported-result phrasings still require review.

`durationSeconds` is a classroom activity budget, not synthesized speech duration.
Do not pad speech or silence to fill it or repeat a later assessment's independent
task. More than four kindergarten speech moves and fixed waits exceeding the page
budget produce advisory diagnostics only. Actual audio duration still comes from
decoded TTS; pacing advice neither changes existing media nor purchases new TTS.

## Native animation ownership

Generated object-animation cues are attached to their speech action. Host audio
adoption writes a version-one speech-start trigger using the decoded audio clock;
the model never supplies an estimated duration. Existing cues without this marker
remain playable without new TTS. Native teaching playback reuses an unambiguous
saved effect on the mapped target or its nearest animated PPT group, preserving
the saved preset and duration. It does not require every native effect to have a
speech owner. Ambiguous effects stay unlinked and play automatically on page
entry, in native order, before narration starts. Static elements gain no animation.
Explicit links retain strict identity/ambiguity checks, and temporary playback
timing is restored without rewriting the saved PPT or history.

The audio player retains the completed clip's decoded duration after releasing
its element, until stop or the next clip resets it. Speech-tail cue validation
and end-triggered animation use that duration; valid completed audio must not
fail with `SPEECH_TIMING_AUDIO_REQUIRED`. Editor mode keeps all objects visible.
The native slideshow hides entrance targets until their speech trigger, and
object location refreshes the native selection outline, including group members.

When a saved speech cue changes or is removed, the editor reconciles the previous
native timing mirror in the same teaching history action. Target, preset and
duration identify the previous mirror; unrelated native effects stay intact.
Adding a new preset while leaving the old mirror behind is invalid: it can pass
metadata checks but conflict at fixed playback construction. Replacement, removal,
Undo/Redo and save/reopen are checked against the real SDK timing tree and existing
embedded audio is retained.

## Direct save (2026-10-26)

Scene visual observations permit one validation repair within the original
request, with the exact validation error and bounded previous output treated as
untrusted data. The repaired output passes the same UUID, shape and bounds
checks; provider/transport errors do not trigger this format repair. Successful
page evidence is cached even when peer observations fail. Subsequent calls
observe only missing pages under the same session, source, mapping and model
identity, while whole-deck planning still includes all available evidence.

Saved context distinguishes initial outline text from detailed narration. Host
may split the outline into multiple `narration-N` speech actions; none counts as
detailed narration unless it carries `source:"generated"`. Existing custom
speech IDs retain their readiness behavior. `hasNarration` still reports that
outline text exists, independently of `narrationReady`.

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

During media completion, read the full media context for catalogs and recovery,
then use `courseware_narration_context` with explicit page numbers for subsequent
TTS work. Prefer `courseware_media_prepare(kind:"tts", actionIds:[...])` for
missing speech on the same page; synthesis and verified archives run in waves of
at most ten, followed by sequential revision-checked adoption. Refresh pending
same-page `intentIds` in batches to preserve parallel download/decode/archive.
Full-deck context includes all teaching actions and can be large.
Preserve pages already marked `narrationReady` unless a new revision was requested;
an earlier completed generation instruction must not be replayed after context
recovery. Pending `attention` annotations are valid before TTS adoption resolves
them into timed visual cues. These tool instructions guide the model; they are
not a prohibition against explicitly requested narration revision.

Host extracts bounded plain text, tables, speaker notes and saved-page objects.
Main renders a sanitized disposable copy of the saved PPTX with local
`libreoffice` and `pdftoppm`, without opening an editor. The copy removes external
relationships, macros and embedded objects; the original source is unchanged.
If rasterization is unavailable, bounded embedded images are used and a diagnostic
is returned. Image-only pages are supported when the authorized model can read
their visual evidence; pages without readable evidence fail individually.

The legacy saved-project whole-deck plan includes all available pages, including on subset
retries. Native PPT generation uses the bounded batches described below instead. Per-page model requests include the canonical JSON output schema, and
outputs still pass strict validation before saving.

The outline format takes precedence over narration-format instructions: it uses
string-valued goal, purpose, bridge and focus, never speech actions or object
arrays. JSON/shape validation reports the exact field or ordered-page mismatch.
Only an invalid model output gets one in-call correction with the same source,
outline and teaching instruction; transport errors, cancellation and source/model
changes are not retried as format errors. No page is saved before the corrected
outline passes validation. A second invalid output fails with its specific
diagnostic rather than prompting the user for approval or silently narrowing the
requested page range. The existing per-call and overall deadlines still apply.

Visual observations for the ordered deck feed one whole-deck plan, then each
requested page receives its own evidence, purpose and adjacent-page bridges.
Successful page evidence is cached for the same session, source, mapping and
model. A batch has at most three concurrent calls, a 180-second per-call timeout
and a 14-minute overall deadline. This does not establish real-model quality.

Focused speech splitting keeps trailing punctuation with the preceding speech;
it must not create punctuation-only TTS requests after a quoted phrase.

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

Session identity, model and authorization checks read at most one recent message
instead of loading the full transcript. Explicit text completions requesting
session context retain the existing full-history behavior.

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

### Logical-page scene requirements (2026-10-30)

The scene batch supplies saved `coursePlan.teaching` by logical page identity,
including after native slide reorder. It takes precedence over the ordinal of a
page in the original approved plan. Vision evidence receives the same metadata.
Detailed generation honors typed questions and music positions and uses short
focus-specific speech with observed aliases. Native animation projection and
advisory quality repair are specified in the
[scene implementation record](../../design/2026-10-30-scene-teaching-parity.md).
The canonical human editing surface is the native WiseOffice right sidebar.


## Approved music and legacy cleanup (2026-10-31)

Retained logical-page teaching is authoritative for scene narration. When it
contains no music requirement, a generated music block fails canonical validation
with `INVALID_OUTPUT` and actionable feedback. The existing two-correction page
loop can remove it before any Host save. Host independently rejects new unapproved
music slots at direct-save and legacy-candidate adoption boundaries.

A narration save or `repairRequiredTeaching:true` repair may remove an existing
unapproved slot only if no matching original music order has entered submission.
Host checks all workspace music journals using the saved slot hash in automatic
draft IDs, across source-hash transitions; prepared/rejected intents remain in
history. Submitted/unknown orders and adopted clips remain anchored. Paid speech,
effects, questions, other pages, revisions and transactional history retain their
existing checks. Missing retained requirements preserve legacy behavior; omission
of a slot on an approved music page never deletes it. This is targeted repair,
not a generic ability for narration to delete media or reset accounting.

## Required-action delta repair (2026-11-01)

For an already narrated scene page, repairRequiredTeaching uses a separate bounded
model response: insertions[{afterSpeechId, block}]. Only missing approved question,
music and video blocks are accepted, once each, at existing saved speech anchors.
Speech text never passes through model echo, trimming, segmentation or attention
generation. Main assembles the saved actions and insertions; Host independently
copies original speech/audio/effects and checks exact question text (boundary
whitespace only), response kind, ordered choices and answer indices. Normal
generation diagnoses substitute questions before saving. Missing actions remain
Host completion blockers. Re-reading saved requirements after a lost save reply
makes repeated delta repair idempotent. Format correction remains bounded to two
attempts; source conflicts or uncertain saves never cause a blind replay.

Required-effect repair also checks existing focus and animation coverage. Missing
effects bind only to unambiguous supplied objects named in saved speech; a missing
highlight prefers a visible text object. Host retains existing cues and audio,
appends newly timed cues using the verified saved audio duration and distinct cue
IDs, and rejects duplicate focus repairs. An unbindable requirement fails explicitly
instead of reporting a successful repair with missing effects.

## Teaching-object ownership (2026-11-09)

PPT Master/plain, imported and scene narration share object validation before
saving and before TTS. Vision may annotate identities but may not move native
shape/text lettering between UUIDs. Images may retain observed OCR; native objects
retain their parsed text, allowing only whitespace/NFKC differences in observations.

An empty shape enclosing multiple separately mapped text carriers must not stand
in for those carriers when speech names their text. Check against all native
layers before filtering visual targets, including when the vision model marks
the child labels non-targets. Exclude such backplates before alias matching so a
long copied alias cannot hide the independent words. Explicit single- and
multi-object bindings must match named teaching objects when a literal match is
available. Preserve unambiguous pictures and meaningful standalone vector shapes.

Invalid visual ownership uses the existing single observation correction; invalid
narration bindings use the existing maximum two output corrections. Persistent
failure saves nothing for that page; successful pages and paid media remain
untouched. Version the evidence cache to discard old cross-layer observations.
These checks catch structural ownership and literal mismatches, not every possible
visual misidentification. Existing saved bindings are not silently migrated.

### Supplied native narration

Source-material adoption uses `courseware_narration_import`, not generated speech
candidates. Accepted text, original-page identities and policy persist in the
native enrichment extension. Automatic generation cannot replace preserved
original pages or fill their missing/silent paragraphs. A focus-only repair is
valid without generated scene requirements and never calls speech generation.
The current live object evidence remains required for binding effects. Ordinary
manual text editing is retained and reported as source divergence. Explicit source
revision/policy changes are distinct from automatic repair.


### Part A import integration (2026-11-11)

- Background page checks retry transient read races; persistent non-transient failures
  surface after five attempts. Foreground opens retry only known read races with a
  bounded delay. Generic writes and paid submissions are never retried by this UI policy.
- Legacy recovery drafts compare project/source context and the target page; another
  page's revision alone does not expire the draft. Native autosave remains authoritative.
- Explicit `Slide N` and bracketed page headings supplement existing Chinese-number
  and Page/P headings. Body lines, original-page identity and order validation survive.
- Loading voice models preserves a valid selected model/voice and otherwise selects
  the first available model/voice. Generation still requires explicit fee confirmation.
- Legacy archive previews read at most the declared, bounded byte length and verify
  regular-file type, exact length and SHA-256; portable/native audio remains preferred.

### Generated-language review (2026-11-11)

The shared batch path adds advisory page diagnostics for newly generated speech
containing third-person teacher directions or instructional-design narration.
It reuses a small subset of the zpj_deck language rules. It does not change text,
reject saving, regenerate speech, add a model call, or affect completion status.
These heuristic warnings may identify intentional quotations; they are not a
semantic quality certificate. Broad learning-objective/stage labels are excluded.

Run this review only after automatic speech generation, outside shared candidate
validation. Explicit notes/external-source selection, accepted scripts and
effect-only required-teaching repair retain their exact wording and existing audio.
Use existing native evidence, history, save and diagnostic paths; no alternative
renderer or persisted teaching model is introduced.

### Bounded native narration batches

The public narration tool schema and both Main handlers reject more than five
pages per call, including an omitted native generation scope. Read-only status
queries retain their full-deck scope. Agent skills and automatic required/focus
repair also submit at most five pages, await save and reread source SHA before
the next call; no full-deck outer request is accepted.

Native PPT generation processes at most five consecutive requested pages per
batch. Nonadjacent selections start separate batches. Each batch reads and sends
only its own pages and up to two actual neighboring pages on each side; it never
sends the complete deck outline to the relay. Neighbor text, notes, objectives and
already-saved speech summaries are limited to 400 characters each. Images and
full object evidence belong only to the current requested pages. Planning emits
at most five briefs; individual speech requests retain their own page evidence
and adjacent bridges. Approved requirements, source policies and output validation
remain authoritative; a summary is context, not proof of unseen slide content.

Each batch performs visual grounding, planning and individual native page writes,
then the Chat tool waits for the normal native save acknowledgment before starting
the next batch. It rereads source/revision after that save. Document identity and
page order remain pinned across batches. Existing saved speech supplies continuity
for the following batch, without a new summarization model request.

The 180-second model-call limit and 14-minute safety limit apply to a small batch,
not the complete 56-page request. Deadline expiry is not an owner cancellation.
A fatal transport, owner, cancellation or uncertain-save failure stops later
batches and returns acknowledged peer pages plus explicit failed/not-started page
numbers. Classified page-local output/plan/content failures allow independent
later groups to continue. Successful prior batches are not replayed. Only
unfinished pages should be requested for recovery; an explicit rewrite remains
an authorized rewrite. A failed save never reports that batch as persisted.
No TTS or replacement media is purchased by this text-generation path.

### Native narration validation and retry scope

Match Chinese character targets and literal paragraph clauses using normalized
layout whitespace, without removing Latin word boundaries or relaxing wrong-object,
ambiguous-picture or backplate checks. Reuse this matcher for validation and
inferred focus. An effect binding error on otherwise structured valid narration
may request only an object-ID delta by speech-block index; it cannot rewrite its
words, waits or media. Validate the amended candidate through the normal boundary.

A changed package SHA alone must not discard generated narration. Before accepting
the updated live binding, verify the remaining native project identity/revisions,
all captured text/layout/requirements/source policy and selected pixels. Navigation
and selection are likewise harmless only when actual content is unchanged. Real
edits still trigger bounded rereading of unfinished pages; external teaching edits,
locks and owner changes remain blocking.

Validate page briefs independently, retain validated peers and the original goal,
and request one repair only for failed page numbers. A failed brief never supplies
fabricated content or blocks saving a valid peer. Root JSON/schema failures retain
a bounded whole-scope repair when rows cannot be safely identified.

The active durable user turn shares at most three page-generation/delta calls for
the same page content/model/repair mode. Instruction changes, batch regrouping,
autosave SHA and successful-peer teaching revisions do not renew that budget.
Check terminal failures before further paid visual or planning work. A later
explicit user request gets a fresh bounded budget; changed actual local content
has a fresh key. Terminal planning/output/exhaustion errors carry per-page codes
and `retriable:false`. Agent guidance must continue independent unfinished pages
and report these failures without automatic single-page retries. Missing required
live content still requires correcting the page or its approved mapping.

### Native repairs with retained audio

For effect-only repair, the native adapter supplies verified saved speech durations
before normalizing the teaching view. Durations are indexed by page ID and speech
ID so equal speech IDs on different pages cannot share timing. The generator can bind multiple focus cues
to one existing speech, including an entrance animation, spotlight and title
highlight. It preserves speech IDs, text, audio assets and unrelated cues, checks
current page evidence/revisions, and refuses unknown targets or missing verified
durations. It neither rewrites a final script nor starts TTS. Native writes and
original-audio recovery also resolve pending attention against retained embedded
audio; a fresh synthesis/adoption is unnecessary.

Automatic teaching saves wait for outstanding native commands. Context reads
join an in-progress save and verify document ownership afterwards. Mutation
results return the source SHA and teaching revision read after save; stale writes
remain rejected and must use freshly read context.

The first automatic open may skip saving when no editor document exists; regular
saves and foreign/read-only documents keep their existing guards. Native automatic
teaching saves require conversation/document ownership without requiring the editor
to be the foreground panel; direct Office selection edits still require visibility.
A refused close during an outstanding save retains the conversation binding and
review state; these are cleared only after the controller accepts the close.
Native automatic media continuation rereads context after each adopted page. A refresh exception
gets one reconciliation against current native state using the original orders;
a second exception stops. Local query/adoption exceptions never prove provider
generation failure and do not authorize a replacement purchase. Native saved
completion also governs the continuation when only optional assessment images
remain.

Activity insertion keeps source evidence separate from its reference answer.
Teacher-led `short_answer`, `discussion`, `practice` and `pbl` require
`referenceAnswer: { summary, keyPoints }` and empty option/answer-index arrays.
Validation errors preserve the requested response kind. Explicit inline user
activity requirements can be mapped as lesson-plan source material without an
attachment; missing accepted units still prevent insertion. Native teaching
evidence identifies group containers as `group`, separate from their leaf shapes,
text and images. Narration visual grounding uses those leaf objects for synchronized
effects, preventing a decorative backplate/subject group from becoming an entrance
animation target.
Native teaching operations use shared courseware tools independently of Office selection-edit
capabilities. English question templates use English helper copy; Chinese
question templates retain their existing copy.

For native imported decks with accepted Quiz/checkpoint units, body narration also
uses independent-assessment validation: extra interaction blocks and teacher-led
continuation cannot silently add another activity inside a lecture page. Invalid
model output is corrected within the existing bounded narration retry, preserving
the accepted activity quantities.

Native narration/media context use identical assessment completion criteria.
Missing optional option images remain in `assessmentMedia.targets` and keep its
`ready` false, but do not invalidate core teaching completion. Missing question
audio remains unfinished. Explicit user media requests still require checking
and completing their actual targets before reporting that request complete.

Saved-audio effect repair replaces the selected speech's existing focus of the
same type and its associated motion, preserving unrelated cues, words and audio.
An object has one entrance per page; later emphasis on the repaired object uses
a repeatable pulse. Repair must not mutate its input project.

Assessment-only narration requests retain existing question readings without
visual recognition, course planning or speech generation. Their diagnostics direct
callers to assessment media for missing question audio; body narration is not an
assessment-repair mechanism.

New mapped activities receive a separate semantic review against actual page text,
saved narration, proposed answer and source evidence before preview/adoption.
The review rejects contradictory answers and missing conditions; a generated plan
is not independent factual proof. This model review supplements structural checks
and does not guarantee factual correctness.

Native CJK paragraphs may be paraphrased while a short page title is also spoken.
Object matching accepts a long text carrier when several distinctive content
words totaling at least six Han characters occur in the speech; shared title
words alone do not establish a match. Short labels keep exact-name matching.
Binding errors include the draft speech and candidate target text so bounded
repairs can correct the actual mismatch. Focus repair supplies explicit valid
block indices, preserving all accepted and draft speech words.

Native activity review also receives the mapped activity title. A stale title on a
revised question must be corrected before insertion; broad relevant titles remain
valid. This semantic review is a bounded model check, not a guarantee of factual
correctness, so real acceptance still reviews the final question and answer.

Visual evidence format repair names the required and received root fields and
expected object count. An omitted issues field must be returned explicitly
(including issues:[] for no issues); it is not silently defaulted, and visual
content validation remains mandatory. The repair budget remains one correction.

## Bounded reviewer recovery and saved-content acceptance (2026-11-17)

Narration generation and semantic-verdict format repair share the existing two
repairs. An invalid verdict is requested again against the same draft and page
images; it never authorizes saving or regenerating an otherwise valid draft.
Uncertain evidence and exhausted page-local output errors are terminal for the
unchanged page, allowing independent native batches to continue. Source/owner
changes and provider failures keep their existing stop behavior. Activity-review
format recovery is also bounded to two retries; an actual content rejection
requires a corrected proposal rather than repeated unchanged review.

Model evidence advertises short, exact `objectRef` handles that are resolved by
the program to the current saved IDs before validation/review. Existing exact
UUIDs remain accepted; names, aliases and unknown references remain invalid.
`courseware_activity_insert.referenceEvidence` is optional: omission reads the
accepted unit evidence verbatim. Explicit quotes retain their exact-source
validation. An omitted `speechCount` stays unconstrained; only an explicit user
count should be supplied, and supplied counts remain enforced.

Native `courseware_media_context` exposes `contentReviewAvailable`. Ordinary
status reads remain model-free. For an authorized complete teaching course,
Runtime requests `reviewContent:true` after technical/media readiness, before
reporting completion. The shared foreground/background document runtime reviews
current saved PNGs, teaching, questions, options, answers and every analysis
statement. Returned `contentReview` and augmented `completion` are bound to the
same source hash and teaching revision. This is distinct from natural playback
acceptance and introduces no new publishing or media-generation authorization.

Only an existing generated Quiz's `analysis` field can be corrected automatically,
through the existing classroom revision-checked write/save. Every correction is
reviewed again; format and analysis corrections share two repairs per page.
Questions/options/answers, scripts/audio, peer pages, locks and original imported
pages are preserved. Missing original-page metadata protects an imported page.
Unresolved factual/visual/uncertain problems block reviewed completion rather
than causing unbounded regeneration. Results are cached for the unchanged source,
model and user turn; status rereads cannot reset failed repair budgets.
Minor accepted image spacing and unequal-tick imperfections are not hard failures;
wrong essential counts/units and unreadable required content remain failures.

### Recovery alignment after the paid three-route rerun

Native non-image text is authoritative when visual OCR conflicts. Discard the conflicting role/aliases as well as OCR text; empty native carriers cannot become text targets. Image lettering still requires actual visual evidence, and unknown IDs, unsafe containers and factual conflicts still reject.

Attention generation, binding repair and saved intents share the existing rendered-cue limit of 200 distinct targets. Every target must belong to current verified page evidence; a complete multi-layer diagram may use one simultaneous focus. This does not authorize unrelated targets or decoration.

Review-format corrections have a separate bounded budget from narration-content corrections. Exhausted non-retriable review failures cannot be caught again as generic narration-format failures. No unchecked draft is saved.

For generated narration, the desktop runtime forwards the user's own bounded
conversation requirements when available; agent-selected page numbers still
scope the work. Agent-generated SVG IDs are not teaching requirements. Explicit
repair instructions retain their separate scope. Native Scene files may reopen
with the generic `plain` project type: use pixel-bound supplier identities, not
that type, to recognize an isolated layer. Current-page object references and
unique saved names resolve before structural and semantic checks. On dense
slides, inspect object inventories in groups and confirm any apparent missing
teaching fact against the whole page before caching a content mismatch.

Malformed review responses exhaust a bounded *review* attempt, not a source
repair. A new turn can review unchanged saved work. A supported rectangular
region repair must be adopted and reviewed on the saved page; prose suggesting
one is not a successful repair. Prepared presentations can be adopted by
workspace-relative export path and digest, using the saved plan directly.

Final review receives the slide coordinate system and an identity-resolved timeline
for each saved speech cue, including all spotlight targets. A verified binding
finding on an unlocked generated body with saved audio goes to scoped narration
repair, with the page-specific finding, followed by another final review. A
source defect on another page does not discard that repair. Protected originals,
missing pixels and uncertain findings remain blocked. A target-only repair may
address an existing cue by ID and keeps its clock, style, order, and independent
animations. Simultaneous spotlights share one mask across their visible targets.
For a substantive desktop course, native timing warnings from the official PPT
Master export are surfaced before attachment or TTS; an explicitly PPTX-only
export may retain PowerPoint-only effects without claiming desktop playback.
A proposed teaching-region crop can name the mapped foregrounds it must
contain. The host expands the proposed box to their measured slide bounds
before editing; unresolved targets or a required whole-slide crop do not
silently pass. Imported-original protection follows the Host task route even
when a reopened editor identifies its teaching project as ordinary.

## Page-scoped narration recovery

After artwork acceptance, a malformed visual finding receives field-specific feedback. When the correction still has malformed findings, the runtime can use separately validated object identities and omit uncertain notes. A rejected object batch can contribute only native text from visible mapped text boxes. Binding and timing still require validation against the saved speech and its page. Inline script and lesson-plan adoption verifies the teacher’s quoted text against the current session before preview or write. Attached sources retain their immutable source IDs. Page-local generated narration uses the narration tool.
