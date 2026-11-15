# 课件原生 Chat 编辑

> **原文镜像说明：** 本页保留完整英文规范，尚未提供全文中文译文。协议字段、约束和验收条件以 [英文源规格](/spec/03-runtime/23-courseware-native-chat) 为准。

Status: source Electron integration verified (A2, 2026-10-19); packaged acceptance
pending. No new assistant or conversation UI.

## Before-dispatch Chat receipts (W03.3)

`ppt_record_change_plan` records a current-page checklist before compound edits.
The existing Agent first obtains a clean saved/unlocked page baseline through
authorized `ppt_get_narration_context`; the model supplies only edit generation
and 1–20 labelled finite tool names. Host validates its persisted Chat workspace,
native/courseware identities, current source/teaching revisions and page scope.
The metadata call uses existing high-risk `tools.execute` permission/admission/
audit/cancellation and is handled inside Host, without `plugins.execute` or any
native operation. Recording is once per Chat turn, before its first mutation;
duplicate/late declarations reject without replacing the original record.

Declared groups use additive `coursewareChatPlannedChanges.v1`; legacy execution
groups keep their existing namespace and serialization. Older builds ignore the
new namespace. Context merges the latest ten groups under the shared 1000-group
bound. Empty-operation groups are valid only with a validated declaration.
Existing single-operation/generic callers remain usable without a declaration.

The existing sidebar shows every declared item and its actual operation status.
Matching uses the exact tool and logical/native page, consuming each operation
at most once. Unexecuted items remain not-recorded; missing/failed outcomes
remain unknown. Native acknowledgements do not certify saving. Proposal steps
retain separate candidate/adoption progress. Labels are untrusted text, not
semantic-completion evidence. A plan never grants capabilities, selects an
object, replays an operation, saves or adopts. Reviewed batch-style scope is outside
this current-page declaration contract.

### Explicit human disposition and fixed-publication barrier

Every declared group remains open until an explicit human disposition. Ordinary
page confirmation and even all-green tool/candidate states do not close it.
New snapshot capture and new fixed-share preparation scan all declarations in
the project, including those outside the ten displayed records, and reject
unresolved groups. Existing immutable snapshots remain readable/playable; the
barrier does not revoke already shared versions or rewrite unknown share intents.

The existing teaching sidebar offers a review form with a bounded disposition
note and a separate unchecked confirmation. Users can finish missing work through
the existing Chat/manual tools, or explicitly cancel remaining requirements and
retain the current result. It reuses `courseware.teaching.confirm` with an optional
`resolution` object (`changeGroupId`, `receiptSha256`, `note`); there is no model
tool for human approval. Main pins the active owner, clean saved source, page and
teaching revision. Host checks the owning persisted Chat, no running owning turn,
the exact immutable declaration/operation digest, unresolved state and current
source/teaching revisions. A retained target must be the reviewed current page;
a removed target requires all retained pages confirmed before disposition.

Within one Host transaction, disposition creates a new teaching revision with
the current actions preserved, marks that page reviewed, archives the previous
project in existing history and writes an immutable `coursewareChatResolutions.v1`
record. It pins the note, receipt digest, saved source, new teaching revision and
project digest. Storage failure rolls back all of these writes. Original failures,
unknown outcomes and unexecuted items remain visible; closure is human acceptance
of the current result, not a claim that missing edits were executed. Closed turn
receipts cannot receive new operations or outcomes. Subsequent work uses a new
turn and the latest source; no replay or rollback overwrites later edits.

Unresolved groups are displayed before closed/legacy history. After restart,
users review the current saved content and continue from existing drafts/tools;
there is no automatic semantic matching, regeneration or retry. Older builds
ignore these additive namespaces and do not enforce the new barrier; use the
updated Host/Main together. The frozen prior trial has not been replaced by
source acceptance alone.

After existing permission checks and before desktop dispatch, Host records each
mutating native/candidate tool for an initialized courseware project in
`coursewareChatChanges.v1`. The key is workspace/project/Chat/turn; the group
retains its initial authoritative teaching project and each tool's call ID,
arguments, source/teaching baseline and eventual bounded outcome. Workspace
identity must match the native binding. Existing generic PPT editing before
courseware initialization and read-only tools retain their prior behavior.

Preparation commits and checkpoints before `plugins.execute`. A failed intent
write prevents dispatch. Repeated call ID in the same group rejects rather than
replaying an operation that may already have affected Office. A missing outcome
survives Host restart as unknown. A native failure, cancellation or timeout is
recorded as uncertain; an acknowledgement is not evidence of saving or adoption.
If outcome storage fails, report an error and retain the prior pending record.
Records do not change teaching, source files, manual locks or existing candidate
review/adoption authority. Main still checks the active owner, turn, capabilities
and native edit generation immediately before any side effect.

`courseware.project.context.chatChanges` projects the latest ten groups without
stored arguments. Main validates and reduces them to acknowledged/uncertain/
pending counts and bounded candidate progress. The existing teaching sidebar displays these records after a
fresh load; no second Chat, automatic replay or new mutation IPC is introduced.
Storage rejects more than 100 operations per group, 1000 groups per project,
64 KiB arguments per operation or a 2 MiB group. Cleanup/export beyond these
bounds remains a separate lifecycle concern; do not silently delete unknown
receipts to permit another edit.

Explicit narration/source-candidate adoption writes an immutable result reference
in `coursewareChatCandidateAdoptions.v1` inside the same existing candidate/
teaching transaction. The record contains the candidate kind/ID, adopted source
and teaching revisions and target-page action hashes. It does not change legacy
candidate serialization, project schema, permissions or public mutation routes.
A receipt-write failure rolls back the Host adoption, leaving its existing
source-adoption recovery protocol responsible for any installed file.

Fresh context links actual tool candidate IDs to the current private candidate
status. Pending, stale and rejected candidates are distinguished from adopted
results. An adopted result remains current across unrelated page or review-state
changes while its source and target actions match; later target/source changes
are shown as superseded, retaining the original adopted revision. Old adopted
candidates without a result receipt remain unknown; never fabricate history from
the current project. Nothing is automatically adopted, regenerated or replayed.
The sidebar shows candidate IDs and these states in its existing collapsed Chat
history. This is adoption evidence, not semantic or publish-readiness proof.

Execution-only groups record actual tool requests; declared groups additionally
retain the model's finite checklist. Neither certifies that the model captured
every clause or that an unexecuted narration change happened. Source association/
page confirmation retain separate receipts and gates. Native selection lacks a
canonical pre-dispatch object ID: retain the exact command/generation and verified
page result, and require saved-source review for page/object mapping. Universal
semantic matching remains unavailable. Cross-turn human disposition uses the
current saved result and explicit note above; it does not infer which later
tool satisfied a prior missing clause.

## Main Chat style-batch tool (A48)

The existing Main Chat owns the batch tool; this does not create a second
assistant or editor chat. `ppt_propose_page_style_batch` is advertised only
after Main has retained an actual representative review and an explicit ordered
2–20 page scope containing that representative. The model supplies only
`editGeneration`; it cannot supply page IDs, a review ID, a path or an
approval flag. Main compares the reviewed scope by values (not serialized
object property order), rechecks owner/workspace/editor/source/teaching state,
and rejects stale or changed requests.

After the tool call, Main renders every target from the current staged PPTX in
WiseOffice before each model/compiler stage, then stages one Host
`page-style-batch` candidate. The existing candidate sidebar shows all target
pages and opens the generated PPTX read-only. Only an explicit user adoption
installs it through the existing source-adoption transaction. Adoption preserves
non-target pages, locks, teaching actions and logical IDs, then reopens the
primary Office writable. Cancellation aborts the owning completion; restart
revokes the in-memory style review and old scope. See the A48 handoff for the
real Electron evidence.

## Entry and authority

Opening the existing Office tab associates the editor with Main's currently
viewed durable Chat session. The renderer does not supply an authoritative
workspace, document binding or logical page ID for agent edits. On each Agent
launch, Main reads the persisted session, checks its workspace/mode against the
active editor, and captures the native binding. Hidden editors and another
Chat's editor are unavailable. Opening/closing an editor revokes old captures.

`pptEditorBinding` crosses Main → sidecar as launch metadata. A changed or absent
binding retires an idle runtime instead of retaining its previous editor tools.
The existing tool catalog advertises fourteen finite native tools, A7 narration, A11 fade-copy and A39 single-page redo proposals, activated with the
existing `ToolSearch`. The existing `Skill` tool loads `deckwise/ppt-edit`.

| Model tool | Operation | Save behavior |
| --- | --- | --- |
| `ppt_get_presentation_text` | Bounded native text plus fresh page/selection/generation/capabilities | Read only |
| `ppt_replace_selection` | Replace the reviewed native text selection | Verified in Office, unsaved |
| `ppt_add_slide_text` | Add a native text box to the current page | Verified in Office, unsaved |
| `ppt_set_slide_font_family` | Current plain-text selection, exact already-loaded font from the latest capability enum | Verified in Office, unsaved |
| `ppt_set_slide_font_size` | Current plain-text selection, 1–96 pt in half-point increments | Verified in Office, unsaved |
| `ppt_set_slide_text_color` | Current plain-text selection, six uppercase RGB digits | Verified in Office, unsaved |
| `ppt_set_slide_text_box_position` | Whole selected rectangular text box, explicit xMm/yMm coordinates | Verified in Office, unsaved |
| `ppt_replace_slide_image_from_asset` | Current ordinary image, explicitly reviewed immutable team PNG | Verified in Office, unsaved |
| `ppt_set_slide_text_bold` | Set/clear bold on the current nonempty plain-text selection, explicit boolean | Verified in Office, unsaved |
| `ppt_set_slide_text_italic` | Set/clear italic on the current nonempty plain-text selection, explicit boolean | Verified in Office, unsaved |
| `ppt_set_slide_text_box_size` | Whole ordinary rectangular text box, explicit widthMm/heightMm, top-left preserved; review reflow | Verified in Office, unsaved |
| `ppt_set_slide_image_size` | One selected ordinary image, explicit widthMm/heightMm, image asset and top-left preserved | Verified in Office, unsaved |
| `ppt_set_slide_image_position` | One selected ordinary image, explicit top-left xMm/yMm, dimensions and image asset preserved | Verified in Office, unsaved |
| `ppt_insert_slide_image_from_asset` | Freshly authorized reviewed PNG, empty canvas selection, explicit on-page rectangle | Verified in Office, unsaved |
| `ppt_set_slide_fade` | Current saved canonical page only, retained Main inspection, fixed 750 ms click fade | Verified in Office, unsaved |
| `ppt_propose_page_narration` | Generate a saved-page teaching proposal under current Chat model/policy | Pending only; explicit sidebar adoption |
| `ppt_propose_page_fade` | Generate one current-page medium click-fade copy | Archived pending copy; explicit reviewed sidebar adoption (A15) |
| `ppt_propose_page_redo` | Rebuild the saved current page from explicitly approved visuals using the current vision model and installed compiler | Archived pending copy; read-only preview/rejection; separate explicit reviewed adoption and primary Office reopen (A40) |

Each mutation requires the generation returned by a fresh read. Model parameters
contain text/generation, never paths or binding IDs. The B module creates request
IDs and checks response correlation; the native controller consumes each request
ID once. The Main bridge rechecks current ownership, Host generation, native
binding, generation, readonly and advertised capability before dispatch.

## Async input and receipt ownership (A46)

The Agent captures the original Host callbacks with their receiver when creating
the tools. Before context I/O it copies the finite scalar model parameters; a
later mutation cannot replace the requested generation, text, font, color,
position or asset. Validated native context is independently cloned. Dispatch
receives a separate command copy, and response correlation uses the original
request, page and parameters. The native receipt is copied before the final
context await so shared-object mutation cannot rewrite a validated result.

Fresh Host/Main checks, loaded-font and reviewed-asset capabilities, cancellation,
permission routing, private-token filtering and unsaved semantics still apply.
This adds no tools, retries, automatic saves, selection authority or native
capabilities. A cancelled or uncertain dispatched edit still requires inspection
before a user retries.

## Permissions and cancellation

Use the existing `tools.execute` → Rust permission/admission/audit →
`plugins.execute` → Main executor → `plugins.resolveExecution` transport. Its
historical notification name does not make these tools installed plugins. Native
names are a finite allowlist; an arbitrary `ppt_*` name is not dispatched.
`ppt_get_context` is internal transport only and has no model-facing tool schema.

Rust owns classification: context/text reads are low risk, native mutations are
high risk, regardless of caller `declaredRisk`. Existing Ask/Auto/session-grant
policy and permission cards apply. The current DeckWise Composer selects Full
auto, so normal editing does not add a confirmation step. Ask approval and
cancellation are covered by Host RPC tests; no Ask selector is added.
Plan/Goal deny all editor operations, even if a
caller claims Agent or supplies plan-safe actions. No Main-local mutation skips
Host authorization. Permission approval is not authority to change targets.

After any awaited session/context read, Main checks that the owning Chat turn
remains dispatchable immediately before native execution. A cancelled turn, stale
Host generation, changed editor, page or selection fails closed. The adapter
sends `tools.abort` on cancellation; Host's existing cancellation registry covers
native approval waits too. Cancellation after native dispatch can leave an edit
applied; no automatic replay occurs. Inspect fresh content before retrying.

Successful native edits remain in Office's unsaved state. The existing Save
button, archive/source write and native save acknowledgement complete saving.
Save-in-progress and uncertain-save states block the bridge. Actual saved bytes
remain the source for inspection and teaching initialization. A changed source
still requires page-lineage reconciliation before existing teaching can reopen.

## Prompt and lifecycle policy

A Main-bound editor turn loads `ppt-edit`, never the generation skill first.
Sending from the existing Composer preserves the visible owning PPTX tab.
Ordinary generation still activates the PPT workbench; a background Chat cannot
borrow the foreground editor. Existing Full auto behavior remains unchanged.
For local desktop prompts dispatched through Agent Host, including queued
follow-ups after cancellation, Main reads its current viewing-session ID at
dispatch rather than retaining an enqueue-time editor snapshot. Remote
principals receive no editor-view context. Missing or mismatched views remain
fail-safe in the prompt handler and the native bridge.
The runtime system prompt and generation wrapper agree that SVG owns generation
candidates only. Never overwrite Office changes from an older SVG export or edit
the live open PPTX with shell/file tools. Main checks are the native capability
boundary; prompts are not a filesystem sandbox against the existing general
file tools. Persistent workflow-phase enforcement across closed editors remains
part of later project lifecycle integration.

The B import/scene skill assets are imported unchanged but are not registered by
this increment. Their task entries need their actual generation/import services.
These finite native tools expose only the listed edits and one inspected fixed fade. They do not provide arbitrary slide regeneration, transitions,
highlights/spotlights or fixed playback. A39 adds the separately guarded single-page
redo proposal described in [source candidates](/spec/03-runtime/25-courseware-source-candidates).
A7 adds narration proposals as a separate
finite tool with explicit sidebar adoption, as described below. The edit skill reports an unavailable operation when its required service
is not installed; it cannot fabricate a candidate or mark an unsaved edit saved.
Manual page narration/locks continue through the separate Host teaching model.

## Verification

Run B's shared/tool/route tests, the runtime regression suite, Main bridge tests,
Host RPC permission/dispatch/cancellation test, Desktop typecheck/build, and the
existing native-save regression tests. `scripts/e2e-courseware-chat.mjs` exercises
the existing Composer with a deterministic local SSE fixture, actual sidecar,
Rust permission policy, native Office edit, explicit save, whole-app restart and
unbound-Chat tool discovery rejection.
It uses isolated local data and no paid provider; it proves dispatch behavior,
not model reasoning quality, arbitrary Office fidelity or a packaged release.

The final `electron-07` report passes actual Composer/native add-text, unchanged
source until Save, whole-app restart/readback and unbound-Chat discovery rejection.
Selection replacement has module/bridge coverage; this acceptance does not claim
an actual Chat selection-replacement gesture. The final Host RPC test passes Ask
approval, abort during approval, read dispatch and durable Plan rejection.

A7 narration uses a private `ppt_get_narration_context` read and high-risk proposal
through the same transport. Host now notifies Main on dispatched PPT cancellation;
Main aborts a pending model completion. Native writes already dispatched remain
non-reversible through cancellation. See [narration candidates](/spec/03-runtime/24-courseware-narration-candidates)
for authority, education policy, review and current limits.


A11 uses the same private context/authorization transport for current-page fade
copies. Main hands off the exclusive parser lease between original and output,
then stages the independently archived output without changing live source or
teaching. See [source candidates](/spec/03-runtime/25-courseware-source-candidates) for strict
limits. A successful receipt is not an applied animation or a saved editor edit.

## Optional native formatting

All four format tools require a fresh advertised capability and current edit
generation. Font and opaque RGB changes require one nonempty plain-text native
selection; unsupported objects and states withhold the capability. Position moves
one unrotated, unflipped, ungrouped, non-placeholder rectangular text box on a
slide containing native shapes and ordinary ungrouped images; the whole box must remain on-page. Coordinates must be explicit
user-reviewed millimeters, never inferred from a vague request. Native readback
must match the requested value and page. Older Office peers retain their existing
capabilities. Missing capability, readonly, cancellation and stale session/page/
selection reject without automatic retry or clean-copy overwrite.

The B40 proposed overlay verifies real native formatting/save/reopen separately
from the authorized Chat/Main module flow. Its module tests use a native boundary
fixture and compiled exact Rust predicates; they do not establish full main Chat,
Host RPC, restart or installed/package acceptance for these three additions.

A29 integrates B50's finite wiring with an independently built production Office
from B49 tree `1c6ed0754bc3859aa5f85c556b034be5e0f09f9b`. Actual Composer-to-Host
formatting and complete Desktop restart pass in source and Linux unpacked modes,
alongside narration and fade adoption. The model/auth are local fixtures. Saving
native changes still requires the existing explicit source/page association review
before teaching can use the new PPTX; formatting does not bypass that protection.

A33 mounts B57's font-only overlay through the existing shared/Agent/Main/Rust
path. Font family uses the newest native capability's finite enum; all four
faces must already be loaded. An unavailable family fails without downloading
or retrying. Aliases may resolve to substitute faces, so this is not a guarantee
of proprietary glyph fidelity. A34 connects explicitly reviewed team-image
replacement as described below. Set `DECKWISE_E2E_EXPECT_FONT_FAMILY=1` alongside formatting to exercise
the additional actual Main Chat edit and verify exact family after save/restart.

## Explicitly reviewed image replacement

### Selected ordinary image size (W11.1)

`ppt_set_slide_image_size` is an additive finite native operation, distinct from
the preexisting text-box size tool. Its only model inputs are the fresh
`editGeneration`, `widthMm` and `heightMm` (finite 1–1000 mm). Office advertises
it only when the current target is one writable ordinary rectangular image and
the native `ImgApply` guard succeeds. Cropped, tiled, transparent, masked,
grouped, placeholder, rotated, flipped, off-page, multi-selection, busy,
slideshow, master and locked targets withhold the capability. The requested
rectangle must remain entirely on the current slide.

The existing Agent/Host high-risk permission and Main ownership, binding,
generation and current-capability checks dispatch `document:execute` once.
Office calls only `ImgApply({Width, Height})`; it does not load image bytes,
resolve an asset, choose another object, or execute model code. Exact native
readback checks dimensions, the same selected image/page/document, unchanged
top-left and other transform fields, image reference and style, peer order,
peer geometry and text. An uncertain result is reported for inspection/Undo
without automatic replay. Success remains unsaved until the existing explicit
save flow. This is not generic shape resizing, cropping, rotation, media
replacement or insertion. Native live save/restart acceptance is recorded
separately from the source/module regression evidence.

### Selected ordinary image position (W11.1)

`ppt_set_slide_image_position` accepts only explicit top-left `xMm`, `yMm`
(finite 0–1000 mm) and fresh `editGeneration`. It shares the image-size native
eligibility and fingerprint guard. Cropped, tiled, transparent, masked, grouped,
placeholder, rotated, flipped, off-page and multiple-image targets remain
unsupported; writable/current page, selection, generation, native history and
owner checks must still succeed. Requested coordinates plus the original width
and height must fit entirely on the current slide, including its edges.

The finite Agent/Host/Main route dispatches once through `document:execute`.
Office calls only `ImgApply({Position:{X:xMm,Y:yMm}})`. Readback verifies the
requested native coordinates, identical image/API/document/slide/page, original
dimensions, media reference, remaining transforms, style and effects, and peer
order/geometry/text. It loads no asset, chooses no other object and executes no
model code or XML. Late selection/context changes and uncertain native results
are rejected without replay; success remains unsaved until explicit Save.
Current-source and actual native save/restart evidence are recorded separately
under `docs/validation/courseware/w11/native-image-position-20261023`.

### Reviewed asset replacement

The existing DeckWise teaching sidebar accepts a team project ID and asset ID,
previews the authenticated immutable PNG, and requires an explicit checkbox and
Use in this PPTX action. Preview alone grants no tool capability. Main binds
the review to the authenticated principal, owning Chat, workspace, editor binding,
and saved source revision/hash. This temporary approval is not a persisted
team-to-local project association and does not grant team membership.

Only a selected ordinary ungrouped, non-placeholder image supported by the
native replacement predicate exposes the tool. Cropped, masked and unsupported
images withhold it. The model receives the finite approved asset-ID enum, never
download URLs, credentials or native image IDs. The existing Skill/ToolSearch,
Agent, Rust high-risk permission and Main transport handle the command.

Before execution, Main downloads through the existing authenticated C team
asset client again; pinned metadata, size, digest, MIME, dimensions and the real
Electron decoder must agree. Source, owner and authentication checks repeat
after awaits and immediately before dispatch. Office receives reviewed metadata
through `document:review-image` and fresh `Uint8Array` bytes through
`document:execute-image`; the ordinary execute route cannot reuse old bytes.
Office verifies the PNG and current selection/generation, calls native ImgApply,
and verifies geometry. Successful changes remain unsaved. No automatic retry
occurs after an uncertain native result.

The review is cleared by input changes, account/Chat/editor changes, a dirty or
saved source change, and restart. It is memory-only. Save still requires the
existing source/page association review before teaching reopens. This increment
supports one reviewed PNG up to 4 MiB, without a catalog/list picker, image
generation, batch replacement or arbitrary URL/file loading.

#### Archived canvas candidate source

The same main-window image-review IPC additionally accepts exactly
`{sessionId,intentId,operation:"replace"|"insert"}`. Main resolves the immutable
archive through Host `courseware.mediaCanvas.image.asset.get` using the current
principal and owning Chat. Renderer supplies neither a file path nor image
metadata. Historical archived candidates remain usable after their draft changes.
Original task receipt, digest, dimensions, MIME, decoded pixels and local bytes
are reverified. JPEG/WebP sources become a PNG derivative for the existing native
tools; the original archive is unchanged. Derivatives above 4 MiB are refused
without resizing or a supplier call.

Preparation returns the existing review plus `target:{page,operation}` with a
one-based page number. It grants no edit capability. Approval sends the distinct
`document:review-image-target` message with `{binding,asset,target}`; its private
target also pins `editGeneration`. Office synchronously validates the original
target, updates reviewed metadata and verifies the requested native capability,
then replies `document:image-target-reviewed` with the new native context.
Old Office builds cannot acknowledge this approval with generic context replies.

Main retains that returned generation and exact insert/replace operation. The
existing Chat/permission/native command flow loads locally verified bytes only
when the command matches both. A fresh context for another selection does not
authorize that target. Native target/generation checks still run at execution.
Source/account/Chat/workspace/Host changes or restart revoke the temporary review;
missing or changed archives refuse without download, generation, retry or edits.
Successful read-only presentation-text commands preserve the native snapshot and
generation when its page, selection, history, readonly state and session remain
current. Reading the baseline must not invalidate its target-bound approval.
Changed, aborted or failed reads do not restore a stale snapshot; request IDs
remain single-use, and native mutations still require fresh context.
Preview and approval do not modify PPTX. Successful execution remains unsaved
until explicit native Save and the existing source/page association review.

`DECKWISE_E2E_EXPECT_IMAGE=1` exercises actual sidebar preview/approval, current
main Chat replacement, rejection after remote access revocation, explicit save,
complete restart and other-Chat isolation against a local authenticated platform
stand-in. Independent saved ZIP/XML readback pins the one replaced PNG and
preserves peer media, text, notes, geometry and relationships. It proves source
integration, not a live Spring account, supplier generation or packaged release.

## Native selected-object entrance animation

`ppt_add_slide_object_animation` accepts only `effect: "appear" | "fade"` and
fresh `editGeneration`, using the existing high-risk Agent/Host/Main command
route. Office advertises it for one current writable ordinary rectangular
shape/plain-text box or image supported by the existing ordinary-image transform
predicate. Whole-object text-box selection is sufficient. Groups, placeholders,
rotated/flipped/off-page shapes, unsupported images, animation preview, locks,
foreign animation-pane selections and complex timing remain unsupported.

The SDK's six-argument `asc_AddAnimation(1, preset, 0, null, false, false)` appends
an entrance without replacing effects or starting preview. Preset 1 is appear
(native 1 ms), preset 10 is fade (native 500 ms); both use on-click node type 2
and zero delay. Existing timing must be a simple main sequence of the same
verified presets, without build lists or node references. Readback confirms one
new effect on the selected object, preserves previous effects and all slide
object fingerprints, and returns `{effect,page,verified:true}`. It remains
unsaved; uncertain edits are never retried. Native SDK, current-source caller
and saved/reopened PPTX evidence is recorded under
`docs/validation/courseware/w11/native-object-animation-20261023`.

## Source-inspected native fade (B84 proposal)

Fresh `ppt_get_context` can advertise `set_slide_fade` only after Main resolves
the actual current saved revision, persisted Chat workspace, canonical teaching
project/locks and `courseware.project.context` mapping. Main reads bounded source
bytes, resolves the logical page through actual presentation relationships and
runs the packaged `inspectPageFadeSource`. Its returned source/page/slide hashes
remain Main-private. A source inspection failure leaves the existing tools
available and keeps guarded clean-copy fade as fallback.

`ppt_set_slide_fade` accepts only `editGeneration`. It uses the existing Agent
Host high-risk permission and finite desktop dispatch. After permission Main
rechecks native/source/teaching/mapping/locks and current owning Chat, consumes the
retained grant once, then uses `document:execute-fade`. Ordinary editor execution
rejects this tool even when Office previously reviewed a grant. Hashes, mapping,
proof and authorization never enter model inputs or receipts. Unknown input
fields remain invalid.

Dirty/save/disposal, owning Chat changes, ordinary commands, context changes and
cancellation invalidate retained work; Office independently validates the exact
native snapshot. Successful fade is fixed current-page 750 ms smooth click fade,
unsaved until explicit normal save. No presentation-wide loop change, arbitrary
object animation, XML execution, SVG rollback or uncertain automatic retry is
introduced. Actual source Chat/save/restart evidence is separate from installed
package or provider-quality acceptance.

## Bundled WiseOffice runtime (2026-10-28)

Normal Office opening uses `deckwise-editor://wiseoffice` and installation-owned
resources. Missing resources fail explicitly; there is no remote fallback.
An explicit HTTP(S) development override remains supported. Document bytes still
come from authorized workspace resolution, with the existing revision baseline
and external-write hash guard. The initial validated buffer is reused for the
open command rather than rereading its archived copy. This does not remove the
archive baseline or change save acknowledgement semantics.

The editor session serves only the bundled tree, rejects traversal and symlink
escapes, retains sandbox/context isolation, and enables cross-origin isolation
through COOP/COEP and explicit iframe delegation. Its Brotli WASM is decoded by
the protocol handler because Electron does not perform HTTP content decoding for
a custom-protocol response. Ordinary file MIME handling remains with Chromium.

`stage-wiseoffice.mjs` records build source revision, dirty state, resource sizes
and SHA-256 hashes. Staging refuses an existing destination. The packaged artifact
includes that directory. Release provenance must identify both repositories; a
dirty development manifest is not a release certification. Native teaching sidebar,
portable sidecar ownership and combined lesson playback remain separate gates in
the approved implementation plan.
