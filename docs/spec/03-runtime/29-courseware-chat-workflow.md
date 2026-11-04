# Main Chat courseware generation

Scene compilation accepts all verified selected assets in the approved plan without an aggregate byte ceiling. Individual image validation and compiler canvas fitting remain in force; compiler copies of native cropped foregrounds fit their mapped display bounds without enlargement. The final playable package retains its existing output-size validation.
When every foreground has a native placement, compilation uses those coordinates and supplier labels directly. It does not ask a model to reconstruct the image lettering or invent replacement layout metadata.
Saved teaching continuation remains available after compilation without an active Office editor binding. Native canvas edits still use the existing editor binding checks.

Status: implemented locally. Source Electron/Host/Agent-to-WiseOffice plain,
scene and import gates pass with loopback provider/media fixtures. Ordinary
generation/repair/export uses the actual official tools. Production-model
quality, complex decks and release acceptance remain separate.

## Ownership

The existing main Chat owns requirements and generation progression. The work
panel remains an inspection/editing entrance. Task types remain `plain`, `scene`
and `import`; school stage is guidance, not routing. No second assistant, model
loop in the renderer, database owner or generation engine is introduced.

Agent workflow, image generation/decomposition, compilation and saved narration/
media operations retain the session supplied by Main's live turn. Main's turn
guard validates session/turn ownership and cancellation; navigation to another
Chat or settings neither redirects that work nor cancels it. Saved operations
still recheck Host, workspace, source, project/page identity, revisions, locks
and media account ownership before writes. Explicit Stop or a replaced/ended
turn prevents further dispatch. No foreground session is assigned by a background
tool. Panel reads, narration candidate reviews/decisions and native current-canvas
edits retain their existing foreground ownership checks. Only Main's trusted
Agent calls supply the internal turn guard; renderer IPC cannot provide one.

Successful same-session `ppt_propose_page_narration` tool receipts also expose
review buttons inside the courseware workspace, sourced from the main Chat. The existing structured-result
decoder reads only the current Chat transcript; assistant prose, failed calls
and delegate calls cannot create entrances. A receipt's baseline session ID is
the native Office mount ID, not the Chat ID. Main validates Chat ownership when
reading the saved candidate. Candidate IDs are internal, never a
required copy/paste step. Opening a review explicitly calls the existing Main
review API; it rereads saved candidate status and enforces current Office page,
source identity, manual locks and revision checks. The existing comparison and
confirmation component renders in Chat without opening another workbench.
Adoption/rejection uses the same Main/Host decision and storage path as the editor.
Successful adoption publishes an in-memory revision invalidation hint, containing
no teaching content. A clean, idle teaching sidebar rereads Host through its
existing open/apply path. Busy views and manual drafts are never overwritten by
this hint; their normal revision checks remain. No duplicate teaching store is
introduced.
Closing or rejecting either Chat candidate review, or exiting after a failed
operation, publishes a one-shot `reread` hint for its owning session. A clean,
idle sidebar rereads even when source/teaching revisions are unchanged, because
the intervening Main review invalidates its private active view. This does not
decide, regenerate or replay a candidate. Manual drafts and disabled/busy/error
views retain the existing refresh guards; switching Chat suppresses late hints.
Review and decision check for a stored manual narration draft and refuse to
supersede it. A failed decision closes the transient review and requires a fresh
read of persisted status before another decision; it is never replayed silently.
Session navigation and active model turns fence actions. The editor's manual
candidate-ID lookup remains available for older or off-window receipts. Chat
receipt visibility follows the existing transcript window; this is not an
independent complete candidate-history browser.

Successful `ppt_propose_page_redo`, `ppt_propose_page_fade` and
`ppt_propose_page_style_batch` receipts also expose PPTX reviews in the main
Chat. Tool names must match their candidate kind; a valid output hash and
unapplied/unsaved pending receipt are required. The shared receipt decoder still
grants no authority. Main rereads the retained candidate through the existing
review API, including lineage, source, teaching and scope checks. The existing
candidate component supplies read-only preview, unchecked replacement consent,
explicit highlight/spotlight object reassociation and optional representative
style-scope review. Confirmed adoption uses the existing recoverable source
replacement and WiseOffice reopen. Successful adoption publishes the new source
hash through the existing in-memory invalidation hint; a clean, idle teaching
sidebar rereads Host once, preserving active drafts. No new generation or storage
API is added.

Current-page stored narration drafts block opening and adoption. Drafts on other
pages retain their existing recovery semantics; this is not a new project-wide
draft transaction. Definite adoption/rejection hides that receipt entrance for
the mounted Chat view. Reloaded historical receipts must still read persisted
status and may be outdated. Failed operations close the transient review and
require a fresh read, never replay a write. Task switches, disabled actions,
active Agent turns and repeated clicks fence asynchronous dispatch. The same
edit skill directs the teacher to Chat review; the retained editor lookup is a
fallback for off-window history. After a generated/imported source exists, the
collapsed page-visuals section in the main Chat prepares and explicitly approves
the current saved Office page's original/native-textless previews. Preparation
checks stored narration drafts, never calls a model, and leaves the source
unchanged. Its existing Main coordinator remains the sole approval owner; the
sidebar no longer mounts a second visual reviewer. Busy preparation fences Chat
stage actions. Agent turns disable its controls without clearing approval needed
by the proposal. Switching Chat/unmounting clears it; source/page/teaching changes
still reject in Main. Completion/failure notifies a clean, idle sidebar to reread
its teaching pin, preserving manual drafts. An idle mount or clear does not emit
that notification: only an active preparation/review operation ending does, so
opening teaching cannot race a spurious reread from the visual component mount.
WiseOffice must already be open on
the saved page; this is not automatic save or source association. Other native,
teaching and publication operations retain their editor entrances. This does
not certify production model quality.

Ordinary tasks do not use the scene-specific `generatedPath` attachment. Their
existing project inspector exposes the same single visual-review section after
it finds a current exported PPTX. Scene/import retain their attachment flags.
Refreshing an ordinary project, receiving new Chat messages or starting a turn
keeps its last inspected result mounted while rechecking, so approval is not
revoked before the proposal can use it. A changed project path resets inspection;
a returned stale/missing export removes that entrance. Main remains authoritative
for the actual clean Office source/page and all approval guards. This adds no
attachment metadata, migration or alternate export logic.

Native-textless preview validation accepts ordinary nested groups in the slide,
layout and master when every descendant is a supported opaque shape or picture.
The same shadow, transparency, text-warp and unknown-object refusals still apply;
traversal rejects excessive nesting or more than 1,000 objects. This allows the
ordinary PPT Master's grouped native output to use Chat visual review without
flattening its editable objects or changing the document. Raster image text still
needs human review. The editor change requires the matching updated Office build;
it is not supplied by updating Desktop alone.

The main-window-only `deckwise/courseware/workflow/get` IPC accepts exactly
`{sessionId}`. Main validates the active viewing Chat, stable Host and workspace.
Chats without a saved task show no automatic courseware entrance. Failed reads remain actionable.
The shell publishes the viewing session in its layout effect before child
passive effects read scoped workflow state. Reloading or reopening a saved Chat
must not depend on a new Agent turn to establish its owner.

## Single courseware workspace

Chat keeps the conversation and a compact Open courseware / edit entrance above
its transcript. There is no workflow card in either composer. A newly created
courseware task opens the right workspace only when it has no retained panel
resources. Later messages and session restoration preserve existing panel tabs,
collapsed state and native editor state. The old `scene-images` entrance maps to
`ppt`; opening the same attached PPT reuses that workspace.

The workspace replaces the disabled task-settings form and manual image console.
Task creation still owns the three routes and education settings. Scene planning
uses the approved version's actual title, pages and visual guide. Confirm plan
pins that hash and sends a specific cover-generation continuation. Confirm style
adopts the verified cover with the existing selection CAS, then sends a specific
remaining-pages continuation. Cover revisions accept an explicit instruction.
Plan changes still invalidate their affected approval and assets. Failed sends
remain visible and can be resumed without repeating approval.

Cover confirmation continues the original requested deliverables, including
previously requested narration, speech audio and music. Its localized message
does not introduce a new full-course decision or expand a PPTX-only request.
Already supplied requirements are not asked again.

ToolSearch activation of compilation or any saved narration/media workflow tool
also activates the finite saved-teaching tool group (narration context/propose,
media context/prepare/refresh). Activation receipts record every added name for
normal replay and restart recovery. Mode and Host authorization checks still
apply independently; discovery never executes generation. Saved narration
context uses the same bounded tool budget as saved media context so parser
admission and source verification can finish without a premature outer timeout.

The same body shows these states, without introducing additional stage tabs:

| Evidence | Workspace content |
| --- | --- |
| Unapproved saved plan | Review plan and confirm plan / generate cover |
| Archived cover without selection | Cover preview, style revision and style confirmation |
| Incomplete page masters | Read-only previews, placeholders and actual completed-page count |
| Masters complete, required assets incomplete | All page previews; actual asset-complete page count |
| All selected assets valid, no active compiler | Waiting for PPT conversion |
| Main reports matching active compiler | Converting PPT; retain image previews and selected page |
| Saved generated/imported source, or validated ordinary export | Mount the existing PPT editor in place, including during an active Agent turn |

Chat activity alone never implies compilation, teaching completion or a fixed
percentage. Compiler state is ephemeral, scoped to session and approved plan,
and errors are retained until another compile or plan change. After restart,
only durable assets/source determine readiness; no job is recreated by reading.
Image-service waiting, unknown submission, failure and inactive work are shown
separately from the stage. Resume rereads the original task under the existing
Agent/Host authorization; it never directly submits a new image from the renderer.
The existing Stop action and account/session/source fences remain authoritative.

The editor keeps its native save, inspection, narration, media and publication
controls. Audio and reviewed-page counts appear in the editor toolbar, derived from validated
native teaching responses pinned to the saved source. Reading progress never opens
a second teaching view or reintroduces the retired React sidebar;
a saved PPT is not a claim of complete teaching readiness. Candidate reviews and
source-visual approval move into the workspace's collapsible review area, retaining
their existing draft, revision and permission checks. Ordinary projects retain
SVG preview, quality repair and explicit export; imports open their saved source.
Images remain images: embedded lettering is not promised as editable text.

Renderer validation: `scripts/e2e-courseware-workspace.mjs` exercises the actual
components with isolated IPC/media fixtures, including 520px width, the two
confirmations, intermediate previews and editor mount stability. It does not run
the native Office engine, paid services or the entire Agent/Host generation loop.
The older full-generation evidence below predates this layout and is not proof
of this workspace's native integration.

## Task creation and handoff

The new-task dialog participates in the work-panel native-surface blocker, as
does global search. Both direct-file and courseware Office mounts hide their
isolated view while blocked and restore it on dismissal without closing or
reopening the document. Late native readiness cannot override a blocker. The
courseware publish/import dialog also blocks its underlying Office view.

The three-route creation dialog accepts an optional brief, audience/grade and
subject. Textbook, chapter and lesson type are under expandable teaching details.
Scene creation also offers six localized style presets (3D cartoon, 2D cartoon,
flat vector, watercolor, paper-cut and realistic illustration) and an editable
500-unit style description. Choosing a preset fills that description; typing
custom text preserves it verbatim. An empty value leaves style to the brief.
The optional `educationContext.visualStyle` is saved with the task before Chat
activation, not appended to or substituted for the user's brief. Switching routes
retains the input in the form but omits it when creating plain/import tasks.
Both planning entrances treat the saved style as an explicit user requirement
and carry its medium, palette, materials, lighting and exclusions into the
approved visualBible and page intents. Age alone cannot override it. Host master
prompts no longer force a hand-painted picture-book fallback for legacy plans.
Approval and cover selection retain their existing lifecycle; changes after
approval still require plan revision and invalidate affected asset bindings.
Existing paid images are not silently regenerated.
Both planning entrances describe concrete original identities for generic lesson
characters in the visual bible: silhouette, proportions, face and color/outfit
combinations. Generic animal names do not imply commercial mascots. Preserve
required names, species, count, style and explicit appearance requirements.
Originality corrections revise the combined design consistently across pages,
rather than just swapping an accessory; approved identities otherwise remain
unchanged. The visual-master planner and actual provider prompt carry the same
original-character guidance, including the deterministic Host fallback and
legacy plans without a visual bible. It stays within the existing 4000 UTF-16
unit limit. Image size remains 1280x800 / 16:10; the MAIC layer-split prompt,
human approval gates and llm-ha relay role are unchanged. This prompt guidance
reduces accidental resemblance; it does not certify originality or supplier
acceptance, and existing images require explicit revision/regeneration.
When a later page's deterministic visual-master prompt exceeds that limit, Host
shortens its repeated generic art instructions before preparation. The approved
visual intent, visual bible, required objects, exact display text, additional
instructions, plan hash and cover style reference remain unchanged. If even the
compact prompt cannot fit, Host still rejects it before image submission.
Changing stage or subject preserves entered grade/custom-subject text; an
incompatible full-English option is reset. The dialog traps keyboard focus,
including its textarea and expandable details, and blocks duplicate submission.

Creation saves the task and teaching settings before activation, then puts the
exact brief in the owning Chat composer for review and explicit send. It does
not automatically submit a model request, import a file or pay for media. The
existing home draft and attachments are retained. Empty briefs do not replace
drafts, failed creation leaves the form available, and navigation fences prevent
late results from installing a brief into another Chat. Unsent text retains the
existing in-memory composer-draft lifetime; only submitted messages are durable.

## Finite Agent operations

These sequential Agent-mode tools use existing `tools.execute` permission,
admission, audit and cancellation. Only reading is low risk; the rest are high.

| Tool | Responsibility |
| --- | --- |
| `courseware_workflow_get` | Read saved requirements, plan/approval, image requests, advertised models and exact asset blockers. |
| `courseware_requirements_update` | Persist confirmed education settings with CAS before approval or attachment. |
| `courseware_scene_image_prepare` | Prepare an image intent through the existing service, without payment/submission/adoption. |
| `courseware_scene_image_refresh` | Query the original task and archive verified ready/settled bytes for human review. |
| `courseware_scene_compile` | Revalidate approved plan and selected assets, then use existing compilation/staging. |

Session and turn are Host-bound, not model-controlled. Stop, turn replacement
and Host replacement fence late work; foreground navigation alone does not.
Compiler dispatch requests 16 minutes to
outlast its existing 15-minute internal timeout; global timeouts are unchanged.
The existing generation service checks captured scope and aborts when it expires.
Uncertain outcomes require reading saved state, never automatic replay.

The scene skill and route distinguish unapproved planning from approved
progression. Natural-language continuation reads readiness instead of rewriting
the plan. Existing `asktool` collects essential missing answers. Latest saved
settings override the initial prompt snapshot; changed settings require revising
an unapproved plan. This remains model-directed finite orchestration, not a
deterministic language parser or unlimited autonomous loop.

## Saved requirements

Host RPC `courseware.task.updateEducation` accepts exactly
`{sessionId, expectedEducationContext, educationContext}`. It uses the existing
strict schema, 500 UTF-16 units per string and 4096-byte task bound. The complete
new context replaces the old; unspecified existing fields must be preserved.
Host serializes updates and rejects stale context, any previous scene approval,
or imported/generated source attachment. Task identity and unrelated fields are
unchanged. Later teaching changes use existing reviewed revisions. No migration.

## Routes and human decisions

- **Ordinary PPT:** keep PPT Master and SVG/notes/final-quality gates. Main Chat
  opens page preview/editing, requests checked final export and opens saved PPTX.
  Card and workbench share project inspection; quality rules are not duplicated.
  **Refresh status** re-inspects the ordinary project's saved inputs/report and
  exports even when Chat is idle. A failed or stale quality report disables
  export and offers **Repair current pages in Chat**, using the same bounded
  report excerpts and repair request as the retained workbench. Repair preserves
  the current project/pages and requires both official planning and final SVG
  checks plus saved page narration. It does not synthesize a passing report in
  the renderer. A later refresh or completed Agent turn exposes the new result.
  The ordinary project inspector also owns the card's stage and initial hint;
  the parent does not infer ordinary readiness from the task attachment flag.
  Before a project is referenced, the stage is requirements; an active Agent shows working;
  inspection, pending pages, failed/stale quality, a changed export, preview-ready
  pages and a current PPTX each have distinct translated stages. Once a project
  is referenced, the card stops asking the user to supply a topic again.
- **Scene:** show actual draft text, visual intent and narration. Trusted UI pins
  approval to the reviewed hash, verifies its receipt, then prompts the same Chat
  to advance. Readiness names missing reference, clean background and foreground
  objects per page, duplicates, identical images, archive gaps and size overflow.
  Compilation still validates bytes. References precede dependent assets.
- **Images:** show exact prompt, real quotation and any private reference. An
  unchecked fee/egress consent and valid quote are required for submission.
  Unknown outcomes query the original request. Human preview/selection uses
  existing selected-intent CAS and then continues Chat. Preparing never pays;
  readiness never selects. Revised prompts may create new intents; exact dedup
  and recovery remain service-owned.
  Image rows show the saved submission phase, task/fee status and provider error
  code. Unknown receipts stay query-only; a definite rejection does not offer a
  status retry or silently create another paid request.
- **Import:** use the existing authorized picker/token import, then open saved
  PPTX. Cancellation preserves the same task for retry. The model cannot choose
  arbitrary file paths. Before selection or an active Office binding, Chat may
  collect requirements and save pre-import teaching settings. It reads task
  readiness and requests the in-Chat picker or Open PPT editor action; it cannot
  claim to have inspected pages/notes. Source inspection and editing still need
  native-bound tools; file/shell tools and local converters are not an import or
  editing substitute. Existing notes, narration and effects use editor APIs.

Preview/Office may open their artifact work panel; no workbench form is needed
for generation. Existing editor review and publication controls remain available;
candidate review also has the main Chat entrances described above. Collaboration,
animation coverage and media canvas are unchanged.
Images retain individual confirmation/selection; no bulk spend or paid retry.
Status refresh is explicit or Chat-driven, not indefinite polling. Whole-plan
approval/asset invalidation remains unchanged; narration-only draft changes do
not gain automatic reuse of paid assets.

## Compilation model and local resources

Tasks may inherit the application model instead of storing an explicit
provider/model pair. Compilation resolves that inheritance through the same Main
launch resolver as Chat; it does not rewrite session configuration or invent a
model. Explicit selections retain their existing priority. Captured inputs and
image completion recheck the effective model/thinking level, mode and Host; a
changed default during generation invalidates the attempt before adoption.
Image capability and credential checks remain in the existing completion path.

Development source launches discover the staged `resources/pptx-worker` beside
the built Desktop, after checking installed resources. An explicit worker
override retains priority and a missing explicit path fails without falling back.
The adjacent compiler and actual worker must both exist; discovery never downloads
or installs a runtime. Packaging support remains a separate validation gate.

## Editing after generation

After opening Office, the same Chat switches to the existing `ppt-edit` skill
and finite native tools for all three task types. An ordinary task must not
return to its older SVG to apply a native edit. Native edits are unsaved until
the user explicitly saves; changed source bytes require the existing reviewed
page association before teaching can be edited again.

For PPTX, Desktop waits for a valid native bridge context matching the opened
document and access mode before publishing editor readiness. WiseOffice's
`document:opened` acknowledges construction and can precede SDK readiness.
Only its two known loading responses are polled, within the existing opening
deadline and cancellation scope; other failures stop opening. This also applies
when reopening an adopted candidate, so a clean teaching sidebar can refresh
against the replacement instead of consuming its hint before the SDK loads.

Narration and reviewed page candidates resolve their effective model through
the same Main launch resolver as Chat and scene compilation, including inherited
defaults and thinking level. They do not write provider/model fields into the
session. Before completion and before staging/retaining a result, recheck saved
session configuration, effective defaults, active scope and current source/teaching.
A changed model or thinking level rejects the candidate. Unavailable resolution
does not start a completion. Narration candidates use the saved Office page text
and remain pending until explicit human review/adoption; this neither rewrites
the PPTX nor generates audio.

Tests: `courseware-chat-workflow-ui.test.mjs`, `courseware-narration.test.mjs`,
`courseware-task-creation.test.mjs`, `courseware-project-required.test.mjs`,
`courseware-scene-plan.test.mjs`, `courseware-chat-workflow.test.mjs`, `courseware-workflow-tools.test.ts`,
`courseware-workflow.test.ts`, Host `chat_requirements_*`, and scene/PPT Master
regressions. Fixtures do not certify actual provider behavior or real Office
integration. See the corresponding delivery E2E scenario.

On 2026-10-25 the source Electron gate passed nine scenarios: three-route
creation/unsent-brief handoff, Agent/Host plan writing, exact approval leading to
image preparation, unchecked quotation, full process restart without replay,
three explicit fixture image submissions/reviews advancing automatically into
actual PPTX compilation, real WiseOffice opening with separate text/image objects
and planned narration, import requirements before source selection, and picker
cancellation/retry importing unchanged bytes into Office. Ordinary-route coverage
in this gate is creation/handoff, not its complete generation path.

The extended gate later passed twelve scenarios. A one-page ordinary task used
the actual loaded skill, Agent file/shell tools and bundled Python to author
planning, SVG and narration, run official project/final quality checks, start the
preview and navigate the real Browser plugin. A deliberately changed page blocked
export after an idle refresh. The same Chat repaired it and reran both official
checks. Explicit export ran the official notes splitter, finalizer and native
SVG-to-PPTX exporter. Independent ZIP inspection matched the editor's source hash,
native text and notes; actual WiseOffice readback found three independent native
objects, including the explanatory text. The exact narration remained page-bound.
The loopback model supplied deterministic page content/tool choices; this proves
the integrated path, not unattended real-model authoring or design quality.

The post-generation extension passed fifteen scenarios, continuing the same
ordinary Chat through a native text addition, explicit source save/association,
pending narration rewrite, explicit adoption and full Desktop/Host restart.
Native readback and saved hashes prove the text persisted; the completion
received the saved edited page, and adopted teaching retained its logical page,
speech and pause. Restart made no new model requests. The gate also exposed and
closed candidate generation's inherited-model gap described above.

The subsequent source gate passed sixteen scenarios, adding real main-Chat fade
preview/adoption, automatic clean-sidebar refresh, direct teaching confirmation
and restart with the adopted source. It exposed the premature native-readiness
issue fixed above. The installed PPTX preserved 22 non-target parts plus native
slide content/timing and narration. Evidence:
`../../validation/courseware/chat-pptx-review-20261025/README.md`.

Historical layout evidence (before the single workspace): the right generation form stayed unmounted; only artifact editing opened there.
At 1080x760, the workflow stayed above the composer. Identity, model JSON and
media used loopback fixtures; no real cost, production-model quality, audio,
publication or packaged-release acceptance is claimed. Evidence is recorded in
`../../validation/courseware/chat-first-20261025/README.md`.

Seedream layer decomposition follows the MAIC native images/generations request
with layer_decomposition, PNG/2K output and URL results. Host reuses MAIC's
foreground/environment prompt unchanged. Lettering remains in its returned image
layers; compilation never erases it or reconstructs native text.
A returned JPEG base is normalized to PNG before archive; foreground PNG bounds
and stacking are preserved. The gateway distinguishes executing `submitting`
from terminal `submission_unknown` and persists safe error codes for provider
HTTP/timeout and result validation failures. Desktop reports layer-download failures. Chat polls only
executing jobs; error or unknown outcomes are reported without another style
confirmation, infinite polling, or paid resubmission. A definite provider 4xx
rejection (except request timeout) releases the reservation; lost outcomes and
post-generation archive failures retain their actual reserved fee status.
Process startup marks interrupted calls unknown; config reload preserves live
calls. Neither operation sends generation requests.

Layer delivery: llm-ha preserves the supplier URL result and metadata without downloading layer images. Desktop downloads public HTTPS layers without credentials or redirects, bounds response sizes, validates the images, and archives them locally. Legacy inline Base64 bundles remain readable. A failed download retries delivery from the existing receipt, never generation.

Native layer delivery uses the Electron default session for both DNS safety checks and image fetching. A group is bounded to 44 MiB raw and 60 MiB JSON, preserving the existing 64 MiB Host frame; the per-image 8 MiB and 4096×4096 validation still applies. Oversized groups report COURSEWARE_SCENE_IMAGE_LAYER_BUNDLE_TOO_LARGE rather than a generic asset failure.

### Planning review presentation

The planning review uses a numbered page outline, with the first page expanded by default. Each page separates student text, visual intent and narration. The course visual guide remains available in a disclosure. The review body scrolls independently of the approval footer, keeping the existing approval action reachable at narrow panel widths. Disclosure state is local presentation only; approval hashes, generation prompts and workflow transitions are unchanged.


## Host completion acceptance and resumable repair

A complete saved-course request uses Host-derived `completion.ready`, in addition
to narration/audio/teaching/video readiness. `completion.issues` checks detailed
speech on every page, missing speech audio, pending media/focus, and the retained
scene mapping's logical-page requirements. A missing required page, exact question text and full response contract, song or structured video cannot disappear from acceptance when
its action is omitted. Quality diagnostics remain advisory; subjective teaching
quality is not certified by this gate. Legacy plans without structured teaching
metadata retain their existing baseline checks. Optional `teaching.video` retains one required five-second silent clip; absent slots emit `VIDEO_MISSING`, and unresolved slots emit `VIDEO_PENDING`. A required adopted clip must have a matching original Host target/receipt. Free-text video intentions are not inferred for legacy plans.

`courseware.workflow.get(sessionId, projectId)` reads acceptance and the durable
checkpoint without starting work or changing it. The internal
`courseware.workflow.checkpoint` RPC uses the session's owned running Agent turn,
project/source binding and an expected revision. The Host stores status
(`running`, `blocked`, `completed`), diagnostic hashes and bounded repair counts
in `coursewareWorkflow.v1`. Counters are monotonic. No historical prompt, status
read, interrupted checkpoint or application startup authorizes generation. An
explicit complete-course continuation restores budgets against current saved
state; Stop/cancellation still ends execution. The runtime resets only ephemeral
turn instructions. Original media journals retain submission identities and results.

The Main sidecar proxy explicitly allows these two workflow RPCs and forwards
their original session, project, turn and revision fields to Host validation.
Other courseware methods and secret/configuration access remain denied unless
independently allowlisted. A continuation-hook failure is a local request failure,
not a provider failure: preserve cancellation and existing local diagnostics,
surface a terminal error, and never retry a successful model response to repair
checkpoint access or persistence. Host-verified completion persists its checkpoint,
permits one final report without tools, and then ends the active run.

Only verified native-save commit may rebind an existing checkpoint to changed
PPTX bytes. It increments the checkpoint revision atomically, retains repair
budgets, invalidates the previous no-progress fingerprint and requires a formerly
completed course to be checked again. Arbitrary source changes cannot rebind it.
This transition preserves source/account/turn fences and does not resume a stopped turn.

`completed` is refused unless Host acceptance passes and adopted audio provenance
validates. Model prose and booleans from the caller cannot certify completion.
This does not publish, freeze a snapshot, or prove visual/pedagogical quality.

Missing approved question/music actions on pages with detailed narration use
`courseware_narration_propose(repairRequiredTeaching:true)`. The runtime dispatches
this operation directly when those are the only remaining acceptance issues. The
model must retain the exact saved speech texts in order and place the new required
actions between those anchors. Host retains every original action, including audio,
effects and media, and accepts only the missing question/response or music slot.
Rephrased, omitted or reordered speech and incomplete repairs fail without replacing
teaching. Ordinary explicit narration revisions keep their existing replacement
behavior. New music still uses the existing quote/submit/archive/adopt chain.

Required repairs are bounded to two attempts for the same logical-page diagnostics,
including after runtime replacement. Locked/missing pages and exhausted or failed
repairs produce an unfinished/blocked outcome with actual errors. They never
silently remove requirements or regenerate successful media to claim completion.

Runtime original-job reads reconcile explicit transient status/transport codes
with two bounded waits (1s, 2s). Paid prepare, compilation and narration mutations
are not automatically replayed by this retry policy. Unknown submissions remain
query-only; invalid input, cancellation and unclassified errors do not enter a
blind retry loop. A tool failure retains the authorized goal for the next saved-state
check rather than discarding all continuation state.


## Action-bound recovery and reporting (2026-10-31)

Saved media context jobs include optional `actionId` metadata for TTS, music and
video. It identifies the original saved action; it is not an additional refresh
argument. The runtime sends only the existing refresh request fields and retains
that original action identity across single results, unknown submissions and
per-intent batch failures. Host completion issues likewise include `actionId` for
specific missing/pending actions. A failed original speech is blocked work, not
an unsubmitted independent speech; other missing actions on the same page remain
eligible for completion.

When an unchanged continuation produces no saved progress, transition to blocked
and allow one report-only pass instead of throwing a retryable provider-shaped
failure or repeatedly asking the model to complete the same work. Preserve repair
counters and the resume fingerprint until the blocked checkpoint is persisted;
only a new authorized run resets ephemeral execution state. No-progress and
blocked-original paths preserve original jobs and do not claim completion.

Host completion now includes `counts` for pages, speeches, ready/missing speech
audio, adopted music clips, pending music slots and questions. These are counts
of saved actions, not estimates of supplier orders or a new audio-verification
certificate. Quality diagnostics expose per-code `counts`. Reports consume those
revision-bound fields and `completion.ready`; free-form model prose is not an
acceptance receipt and cannot override Host readiness.

## Verified bindings and recovery closure (2026-11-01)

Native-save transactions rebind music targets and video boundSource only after
logical page/action content survives verification. Original request, key, hash and
account scope remain immutable. Ambiguous legacy music keeps its original and is
reported through unresolvedOriginals; further generation requires explicit
resolution. Source changes alone never authorize replacement purchases.

One normalizer distinguishes prepared, pending, unknown, failed, archived, adopted
and human selection. Known tasks continue to reconcile; unknown outcomes without
a task are queried once per run, not polled forever. A failed original does not
suppress independent healthy jobs. Ten minutes without semantic progress closes
the run with a report. Completion, including advisory diagnostics, enters one
terminal reporting phase; another user request starts a new authorized run.

Main acquires the independent per-type queue slot and rechecks quote, owner and
source before Host begin. Same-original local status refreshes coalesce and CAS
conflicts reread the committed journal; they never cause another POST.


## Per-page image pipeline (2026-11-02)

After human plan and first-page style approval, an authorized whole-course run
uses `courseware_scene_image_refresh` with the selected first-page master
`intentId` and `generateRemaining:true`. This flag cannot be combined with
retry, prepared submission or polling flags. Default refresh remains read-only
apart from verified archive/adoption; single-page and scoped retry requests do
not authorize the whole-course pipeline.

Desktop Main coordinates up to five master workers. Each verified, archived and
selected master immediately hands off its own cleanPlate decomposition, including
the first page, without occupying a master worker until decomposition completes.
All submissions reuse the existing independent image and image-layers queues
(five in-flight jobs each); task-ID receipts do not free capacity. There is no
all-masters barrier, extra queue service, or business logic in llm-ha.

The pipeline pins the approved plan and selected cover bytes and reuses saved
prepared/submitted intents. Decomposition references that page's selected master
ID and hash. It never resubmits failed/unknown Seedream jobs or requests foreground
layers separately. Confirmed failures use the local fallback described below.
Per-page failures retain original IDs
and errors while independent pages finish. Concurrent whole-course invocations
for the same Chat are refused. Stop prevents further dispatch; started work is
joined and recovery reads the original durable journals. A bounded 15-minute
pass reports timeout rather than waiting indefinitely. Completion returns
`pipeline.ready`, exact blockers and per-page failures; compilation remains a
separate action and revalidates all required selected assets.

After cover approval, refreshing the latest replacement intent for a later page
automatically adopts its verified archived result using the previous selection ID
as a compare-and-set guard. Late completion of an older unselected request cannot
replace a newer request. The pipeline resolves the latest later-page master,
including previously generated unselected replacements, before decomposition.
Host atomically clears that page's background and foreground selections when
its master changes, and foreground selections when its background changes.
Archived bytes and paid receipts remain intact; other pages remain selected.
Plan approval and cover style approval are still human decisions. Courseware
failure recovery uses saved workflow tools and exact errors, not application
source or private database searches without an explicit debugging request.

Image failure snapshots include the optional original upstream response (HTTP
status, MIME, request ID, bounded verbatim body and encoding/truncation metadata).
Main requests this additive field from llm-ha explicitly for compatibility with
older strict clients. The preview displays the original body and the pipeline
retains it with per-page failures; llm-ha does not interpret supplier policy.

## Validated drafts and bounded final status (2026-11-01)

`courseware_scene_plan_submit({})` validates the owning Chat's current plan file
with the same parser used for review and returns its hash plus draft/review state.
It does not approve or generate assets. Workflow discovery activates this tool.
Runtime validates detected scene-plan writes before accepting a closing response,
returns exact business-validation feedback for at most two corrections, and
reports an unfinished draft if validation still fails. Generic JSON parsing and
file-write success are not plan acceptance. Explicit requirements such as song
names and placement still need fidelity review in the normal plan approval.
Validation reports field paths, actual invalid enum values and expected constraints
across all pages in one response, including missing visible questions and choices.
The budget permits the initial failed validation and two further attempts,
regardless of whether corrections use Write or a shell. Explicit submission
results are reused rather than submitted again by continuation. Failed file edits
and shell reads do not trigger automatic revalidation. After validation failure, partial Edit repairs are rejected before
Host dispatch; the model must reread and use one complete Write while retaining
required fields and explicit requirements. Scene-plan Write content must parse
as JSON before Host dispatch, so malformed replacements leave saved bytes intact.
Product validation still owns plan acceptance. Both plan approval
and first-page visual-master approval remain required human decisions.
Only Write/Edit target paths identify a draft mutation, including the legacy
`file_path` alias. Shell reads of current or reference drafts, unrelated file
contents mentioning a draft path, and backup files neither start planning recovery
nor consume corrections. Shell-authored drafts still require the explicit submit
tool; command text alone is not evidence of a draft mutation. While recovery is
active, shell reads do not trigger another automatic validation.
Successful draft validation keeps tool declarations available for post-submit
status reads. An unapproved valid draft ends on the model's existing closing
response, without a second tool-less model pass. Validation of an unchanged
approved draft does not re-enter human review or stop authorized image work.
Cover-only rendering/composition corrections before style confirmation use the
existing image-prepare `instructions` with the same approved plan hash. The model
keeps plan bytes and original image receipts; only the new cover needs style
review. Actual edits to the plan, including course-wide required subjects,
invalidate the old hash approval and require renewed human plan review.

For an authorized complete-course run, a successful media-context tool result
with no original pending jobs and Host `completion.ready:true` enters saved
acceptance handling at that tool-result boundary, including tool-use turns.
Checkpoint/source/revision checks and advisory repair budgets still apply.
Final reporting retains tool declarations for the existing tool-call history and
sets provider `toolChoice:none`, avoiding a schema-less response that can leak
DeepSeek DSML as prose. The execution fence still blocks calls from a provider
that ignores this choice. Compaction cannot rearm the continuation. Status-only
reads never authorize work.

Model-facing media context and continuation reports omit full page actions,
speech text and the original approved plan. Internal result details retain that
evidence for reconciliation; `courseware_narration_context({pageNumbers:[...]})`
continues to supply exact page details when needed.

Focus normalization distinguishes one pictured character from its matching name
label while retaining an explicit valid target. Multiple matching pictures remain
ambiguous. `repairRequiredTeaching:true` also adds missing unambiguous focus to
existing speech. Host preserves original speech IDs, text, audio, pauses and
existing effects; verified archived/portable audio supplies timing. Existing cues
cannot be overwritten and missing audio evidence rejects the write atomically.
No TTS order is generated for focus repair.

## Stop, immediate input and idle receipts (2026-11-01)

Send now promotes and steers queued input through Agent Host. It does not also
stop the receiving turn. Pending steering fences the remaining tools in an old
assistant batch until the new input reaches the model; delegates already running
continue under the existing TaskWait interruption rules. Undeliverable promoted
input stays queued for the next turn boundary.

Explicit Stop fences Main dispatch synchronously before awaiting the sidecar,
and Runtime blocks subsequent tool calls. The turn retains normal graceful
settlement; it is not recorded as an abort. Already submitted supplier jobs keep
their original identities and results. This does not cancel a request already
dispatched to the supplier.

An idle workflow does not periodically reread the aggregate workflow. Message,
activity and explicit refresh changes still reread it. The image panel continues
discovering and refreshing pending jobs, but retains terminal task receipts across
list refreshes and does not query those jobs again. Authentication changes clear
those receipts and fence late responses. Explicit image-panel refresh rereads the
original jobs once; subsequent timer ticks retain the refreshed terminal receipts.
No renderer refresh submits generation.

### Local layer fallback

A confirmed Seedream decomposition failure with final accounting switches to
MagicLayers in Desktop Main, including when resuming a failed page. Pending,
unknown and cancelled requests do not trigger fallback. A timeout only resumes
the saved job. Planning and first-page style remain the two human approval gates.

Main verifies the same approved plan, selected source master, original bytes,
principal and captured personal/team scope before each dispatch and archive.
The configured scene vision completion locates objects in the actual source PNG;
its manifest is saved in the principal-scoped Host media journal before upload.
MagicLayers receives revision 2, extract_only and best_effort, using local SAM2
and LaMa without cloud segmentation or generative repair. A complete, unflagged
background plus all requested foregrounds is required before existing private
bundle staging/adoption and compilation. Partial results, placeholder layers,
low-confidence backgrounds and unsafe ZIP entries report errors with no adoption.
The existing Seedream receipt, original error and accounting remain unchanged.

MagicLayers uses a stable submission key and durable content fingerprint. A lost
POST response is recovered by GET; repeating the same upload returns the same
job, changed content conflicts, and an expired/deleted result cannot rerun the
same key. Local final failures are reported rather than resubmitted. Submission
uses the existing image-layers concurrency limiter. The MagicLayers service owns
its existing single CPU worker, not a new DeckWise queue.

llm-ha forwards authenticated multipart uploads, status JSON and ZIP responses
through `/v1/courseware/media/magiclayers/jobs/:key` (POST/GET) and `/:key/result`
(GET), with equivalent team paths. It preserves HTTP statuses/error bodies and
isolates upstream job identifiers by tenant, user, captured project and service
binding. Supplier credentials stay server-side. llm-ha does not decide fallback,
create object manifests, unpack archives, or modify billing outcomes. Deployment
requires the `magiclayers` relay account and updated MagicLayers service; see
llm-ha `docs/courseware-images.md` for configuration.
