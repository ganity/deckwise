# Main Chat courseware generation

Scene compilation accepts up to 256 MiB of verified original selected assets. Compiler copies of native cropped foregrounds fit their mapped display bounds without enlargement; private originals and separate image objects remain intact. Normalized compiler input remains bounded at 32 MiB.
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

Successful same-session `ppt_propose_page_narration` tool receipts also expose
review buttons inside the main Chat stage card. The existing structured-result
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
Generic Chats without a saved task show no card. Failed reads remain actionable.
The shell publishes the viewing session in its layout effect before child
passive effects read scoped workflow state. Reloading or reopening a saved Chat
must not depend on a new Agent turn to establish its owner.

Sending a Chat request does not open or switch the work panel. A panel the user
opened deliberately, including its active Office/canvas tab and collapsed state,
is preserved. Preview and editor controls remain explicit artifact entrances.
The current-stage card lives inside the existing measured composer dock. Its
height contributes to the transcript reserve, keeping plan/quote controls above
the input rather than underneath the floating composer, also in smaller windows.

## Task creation and handoff

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

Session and turn are Host-bound, not model-controlled. Stop, conversation switch
and Host replacement fence late work. Compiler dispatch requests 16 minutes to
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

The right generation form stayed unmounted; only artifact editing opened there.
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
