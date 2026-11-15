# Courseware generation driven by the main Chat

Date: 2026-10-24
Status: generation progression implemented locally; see
`../spec/03-runtime/29-courseware-chat-workflow.md` for delivered scope and
acceptance gaps. The full interaction design still includes later work.

## 1. Product decision

The existing central Chat is the primary execution entrance and orchestration
surface for the complete courseware lifecycle. Its existing Agent reads task
context, resolves intent, collects missing requirements, selects the appropriate
skill and calls authorized domain tools to advance planning, media preparation,
compilation, narration, editing, preview and publication preparation. It observes
real operation results and decides the next permitted step. This is a workflow
change, not merely relocating buttons or displaying progress messages in Chat.

The existing right work panel displays artifacts and supports direct visual
editing: generation previews, WiseOffice, page narration, attention effects and
media. It does not own a separate generation workflow. There is one conversation
and one execution path, available even when the right panel has never mounted.

“Runs in the main Chat” describes product interaction and Agent orchestration.
Agent execution remains in the existing runtime, domain operations retain their
existing service boundaries, and Host owns authoritative state and validation.
The React Chat components do not become a generation engine or a database.

New-task creation collects a starting point, rather than becoming a compulsory
configuration wizard. The three task types are **Ordinary PPT**, **Scene-based
courseware**, and **Import existing PPT**. Age, grade and subject are independent
teaching settings; kindergarten is not a separate editor or task-routing rule.

Keep the existing right-side controls as secondary entrances for now. Their
actions use the same task workflow and authoritative validation as Chat; they
must not retain indispensable transitions inside component-local callbacks.
Closing the right panel must never prevent generation from advancing in Chat.

### Expected conversation behavior

1. User gives a topic or imports a PPT in the main task conversation.
2. The Agent reads saved context, asks for essential missing information, saves
   validated answers and invokes the selected planning/import skill.
3. It presents the actual plan or import result and requests the necessary
   review. The user's “continue” advances the owning task to its next permitted
   operation; it does not repeat planning indefinitely.
4. It prepares required media inputs and obtains real quotes through tools.
   Paid submission pauses for a trusted confirmation in Chat. After confirmation,
   orchestration proceeds within that exact authorization and dependency scope.
5. It reads task results, presents required asset review/selection, compiles the
   ready deck, and offers the resulting editable PPTX. It reports the precise
   missing requirement or failed operation if progress is blocked.
6. Later requests such as “rewrite page 3 narration” or “change the visual
   style” are handled in the same Chat through the existing native/candidate
   tools. The right panel reflects results and permits manual visual edits.

Advance non-blocking steps within the user's authorized request automatically.
Do not require another “next” click merely to move between status messages.
Pause for missing decisions, applicable human review, scoped cost confirmation
or conflicts; completion must be established by tool results and persisted state.

## 2. Initial implementation observations (historical)

This table records the pre-implementation snapshot from 2026-10-24. Chat
progression, typed requirement updates, plan approval and the optional creation
brief are now implemented; use the runtime specification for current scope.

| Evidence | What exists | Gap relevant to this design |
| --- | --- | --- |
| `apps/desktop/src/components/CoursewareTaskDialog.tsx` | An uncommitted creation dialog selects all three types and teaching settings. | It creates a session; it does not itself collect a brief, select an import file, or advance generation. Preserve this work. |
| `apps/desktop/src/components/workpanel/PptMasterTab.tsx` | Task settings, PPT import, preview and export actions live in the work panel. | Teaching settings are disabled once messages exist; follow-up answers cannot simply reuse these controls. |
| `apps/desktop/src/components/workpanel/CoursewareScenePlanPanel.tsx` | Chat can generate/revise a plan; the panel reads and approves its exact hash. | Approval and the next-stage entrance are outside Chat. |
| `apps/desktop/electron/main/ipc/agent-ipc.ts` | A scene task without an Office binding is routed to planning. | Saying “continue” in Chat does not itself switch into media preparation or compilation. |
| `packages/agent-runtime/src/courseware-route.ts` | Planning instructions explicitly stop before assets and compilation. | Moving a button or changing its label cannot repair stage routing. |
| `apps/desktop/src/components/workpanel/CoursewareSceneImages.tsx` | Individual media preparation, quotation, explicit paid submission, status and selection. | Users currently coordinate pages, reference images and asset types manually. |
| `apps/desktop/electron/main/courseware-scene-images.ts` | Compilation checks an approved plan and selected assets against their current bindings. | Every page requires exactly one visual master, one distinct clean plate and at least one foreground layer. “Missing images” needs an actionable explanation. |
| `apps/desktop/src/components/AskToolCard.tsx` | Existing Chat questions support choices and custom answers. | Answer presentation is reusable; typed teaching-setting persistence still needs wiring. |
| `docs/adr/host-owned-courseware-projects.md` | Host owns teaching records, revisions, drafts and adoption. | Do not introduce a second project model inside Chat messages or renderer storage. |

These are historical source observations, not current acceptance results.

## 3. Page structure

```text
+------------------+-----------------------------------+-----------------------+
| Tasks            | Main Chat                         | Work panel            |
|                  |                                   |                       |
| Current course   | Course title / task type           | Page preview / Office |
| Other courses    | Requirements and answers          |                       |
|                  | Plan summary and review actions   | Current page teaching |
|                  | Generation receipts and results   | Media / review details|
|                  |                                   |                       |
|                  | Current stage / next action       | Task settings         |
|                  | Composer                          | (secondary, retained) |
+------------------+-----------------------------------+-----------------------+
```

- Keep the current restrained application styling and existing components.
- Before any artifact exists, collapse the right panel by default and give Chat
  the space. Do not automatically re-close a panel the user opened deliberately.
- When a first reviewable artifact is ready, show an **Open preview** action.
  Opening it reveals the appropriate existing panel; ordinary progress updates
  must not steal focus or switch editor tabs.
- On a smaller window, show Chat and the work panel as switchable views. Preserve
  the draft and current operation when switching; no fixed three-column minimum.
- Use one current-stage card immediately above the composer. Historical messages
  keep their receipts, while their expired action buttons become read-only.
- Do not add a second assistant, conversation, chat input or permanent long form.

## 4. New-task interaction

The dialog shows task type, a short optional brief, optional audience/grade and
subject. An expandable **Teaching details** section keeps textbook, chapter and
lesson type. The applicable teaching-language option stays with subject. Existing entered values
must survive changing the visible options unless incompatible and explicitly
explained. The user may create a task before the brief is complete.

For import, the delivered entrance is **Select PPT** in the main Chat after
creation; selecting a file in the creation dialog remains future convenience.
Reuse the authorized import operation and its picker
token; do not treat a typed local path as an authorized file selection. A
cancelled picker leaves a recoverable task rather than a failed generation.

Creation saves the selected metadata, opens the task, and places focus in Chat.
It does not submit model or paid media work. A supplied brief is carried into the
owning Chat composer for review and explicit send, preserving existing text and
attachments. It becomes the first user request only when sent; retries must not
duplicate sessions or messages. Unsent drafts retain their existing in-memory
lifetime and do not imply a durable conversation message.

## 5. Clarification in Chat

Read the saved task and supplied materials first. Ask only for information that
changes the next action; never ask again for an answer already supplied.

| Situation | Required behavior |
| --- | --- |
| No topic and no usable material | Ask for the topic or an upload before planning. |
| Target age materially affects the lesson | Ask audience/grade, with choices and custom input. Do not silently guess. |
| No exact page count | Offer a visible suggested range; do not block solely for an exact count. |
| Missing textbook/chapter without a curriculum-specific request | Leave optional. |
| User asks for a specific textbook but omits its edition/content | Ask for the missing source or edition; explain the limitation. |
| Existing PPT has no narration policy | Offer keep notes, use external narration, or generate narration. |
| Missing model/account needed for the next operation | Show the concrete setting/login action; do not ask the LLM to invent configuration. |

Reuse the existing question card for choices and custom answers. File selection
and cost approval remain dedicated controls. A natural-language answer goes
through bounded field extraction and validation; ambiguous answers remain a
question rather than becoming guessed metadata.

Show the accepted requirements as a compact summary, for example:

```text
Audience: Primary grade 3  |  Subject: Mathematics
Topic: Fractions          |  Suggested length: 12–15 pages
Style: Illustrated        |  Narration: Detailed teacher speech
[Edit requirements] [Create plan]
```

Task type becomes stable once work starts. Teaching metadata must be editable
through a separate revision-checked update; do not unlock the existing all-in-one
task selector after the first message. Before generation, a metadata change
invalidates affected planning approval. After Office editing begins, it changes
future teaching guidance and offers an explicit scoped revision; it never
silently regenerates or rewrites the saved deck.

## 6. Planning and the next action

The Chat plan summary contains title, audience, page list, teaching progression,
visual approach and a short narration example. The right panel holds full-page
details when opened. Users can reply **Shorten page 3** or **Make the narration
more playful**, or use **Edit plan**.

Approval must pin the actual reviewed plan, not an assistant sentence saying it
is ready. The button is **Confirm plan and continue** and performs:

1. Re-read current readiness and the reviewed plan identity.
2. If current, record human approval using the existing approval operation.
3. Compute and display the next requirement: assets, quotation, compilation or
   source review. Approval itself never silently submits paid jobs.
4. If the plan changed, show its changes and request a fresh review.

The primary button names the next operation: **Review required images**, **Build
editable PPT**, or **Open source review**. Do not leave an unexplained disabled
**Generate** button or an instruction to find a control in the other panel.

## 7. Three concrete generation paths

### Ordinary PPT

Requirements -> PPT Master planning and page narration -> reviewable generation
preview -> user revisions -> final checks -> editable PPTX -> WiseOffice.

Retain the existing SVG candidate preview and export checks. Put their summary
and export entrance in Chat. Once Office edits exist, subsequent requests use
the current PPTX and teaching baseline; an older SVG is never restored over it.
An SVG preview is not a completed editable PPTX, and a PPTX is not a published
playback package.

### Scene-based courseware

Requirements -> page text/visual intent/narration plan -> human approval ->
asset preparation -> reviewed asset selection -> editable PPTX compilation ->
existing staging/review -> WiseOffice.

Derive the asset checklist from the approved plan and actual compiler needs.
Translate internal terms into **Overall page reference**, **Background without
foreground objects**, and **Movable objects**. The normal user reviews pictures
and cost rather than manually entering every layer name or provider argument.
Advanced controls stay available in the existing media panel.

The current service requires the reference image before dependent clean-plate
and layer preparation. Therefore use dependency-ordered groups:

1. Show required page references and their real quotes; confirm and submit only
   those exact intents.
2. Show the resulting references, select/review them, and prepare dependent
   assets. Present a new quote/confirmation where required.
3. Review selected assets, then compile only when the actual readiness check
   passes. Successful generation does not imply automatic asset adoption.

Bulk preparation is a proposed orchestration improvement, not an existing bulk
API. Initially the central workflow may sequence the existing finite operations.
Never present a guessed total as an exact quote before dependent work is known.
Each confirmation pins its items, price limits, account and expiry; a change
requires renewed confirmation. A batch click must not implicitly authorize
unknown future calls or paid retries.

Current approvals and assets use a whole-plan hash. Changing even narration in
that draft may invalidate asset bindings. Keep archived results visible and
explain this before accepting a plan change after paid work. Per-page visual
dependency reuse would need an independently validated change to the binding
model; it is not promised by moving the UI. After PPTX adoption, narration edits
use the existing teaching lifecycle and must not trigger image regeneration.

### Existing PPT import

Authorized file selection -> import/parse -> existing notes and page summary ->
narration choice -> preserved or generated teaching proposals -> source/teaching
review where required -> WiseOffice editing.

The source PPT remains the editing starting point. Selecting **Import** does
not start a topic-based generation workflow. Show page/format diagnostics and
the concrete remedy when import cannot continue. Reuse usable notes without
requiring their regeneration; generated narration must respect the selected
age, subject and language policy and remain editable page by page.

## 8. Editing, narration and effects

Keep WiseOffice in the work panel. Use the existing adjacent teaching controls
for narration, highlight/spotlight targeting, timing and audio. They are DeckWise
UI bound to Office context; this proposal does not claim they become native
Office document properties or require a separate Office conversation.

Main Chat understands explicit scope such as **page 4**, or an intentionally
quoted current selection. If **this page** is ambiguous, ask which page. Resolve
logical page/object identity freshly before execution, never solely by text or
old page number. Manual edits and Chat commands use the same teaching/source
revisions and lock checks.

- Native-supported edits use the existing finite WiseOffice tools.
- Page regeneration/style changes use the existing candidate and review path
  when native editing cannot satisfy the request.
- Narration proposals show a page-scoped before/after review; adoption remains
  explicit. Existing manual text editing stays available.
- Narration edits expose the affected speech/audio bindings. Changed speech
  needs an explicit new audio operation and quote; text changes never silently
  regenerate paid audio or discard unrelated audio.
- Highlight/spotlight requests show target and timing for review. Unsupported or
  stale targets are actionable failures, not a claimed successful effect.
- Show the distinction between a draft, applied-but-unsaved Office edit,
  saved PPTX, adopted teaching, and a fixed playback version.

## 9. Progress, interruption and failure

Use named stages with measured counts where available: **Planning**, **Waiting
for review**, **Preparing images: 4/10**, **Building PPT**, **Ready to edit**.
Do not invent percent completion when only stage completion is known.

The active card always shows what exists, what is missing, and one next action:

```text
Plan approved. References ready for 6/6 pages.
Page 3: background missing. Page 5: movable object not selected.
[Prepare missing assets] [Review existing assets]
```

| State | Visible action and behavior |
| --- | --- |
| Required input missing | Inline question or file picker, with the reason. |
| Review required | Open the exact artifact and confirm its current version. |
| Busy | Operation name and cancel where supported; block duplicate dispatch. |
| Failed operation | Plain-language cause and retry only that eligible step. |
| Submitted task has unknown outcome | Query original status; do not resubmit. |
| Quote expired | Refresh the quote; keep prepared inputs. |
| Stale plan/source | Reload and show what must be reviewed again. |
| User switches tasks | Show only the owning task's progress and actions. |
| App restarts | Re-read durable state and offer resume/status; do not replay work. |

Cancellation is specific to the active operation. A compiler cancel does not
imply that an external paid job was cancelled or refunded. Failed generation
preserves previous good artifacts and successful media tasks.

## 10. Preview and publication

Editing completion offers **Preview**, **Export PPTX**, and **Prepare
publication**. Narration/attention edits can be saved without immediately
generating speech. Explain which operations require fixed audio.

The preview/publication readiness card enumerates unsaved source changes,
pending associations, narration review, audio, unresolved change groups and
conversion diagnostics using the existing gates. Building a fixed package and
publishing it are separate actions. Conversion belongs here; PPTist is not the
live editing authority.

Team sharing, simultaneous editing and virtual classrooms remain outside this
interaction change. Existing controls are not removed, but they are not new
mandatory stages in the core generation path.

## 11. Implementation seams and ownership

| Concern | Smallest implementation direction |
| --- | --- |
| New task | Finish the existing task dialog and session creation wiring. |
| Missing requirements | Reuse `AskToolCard`/`asktool`; add validated persistence for the answered domain fields. Generic question output is not a metadata update API. |
| Chat workflow orchestration | Extend the existing Agent/runtime courseware route and expose the missing finite domain operations. Stage advancement must work independently of mounted work-panel components. |
| Current stage card | Project the running Chat-owned workflow into a bounded feature component. Keep `ChatTranscript`, `Composer`, and the central store thin; the card is not the workflow implementation. |
| Task readiness | Read existing task, plan, job, asset and source/teaching records; project actionable blockers and available actions. Revalidate at execution. |
| Scene phase routing | Keep the planning skill's boundary; add a real authorized transition/orchestration entrance after approval. Do not tell the model to bypass its phase policy. |
| Media and compilation | Expose existing prepare/quote/status/selection/compile services through the bounded Chat workflow where missing. Paid submission requires the applicable trusted approval. Panel actions enter the same workflow. |
| Editing | Reuse current Office binding, native tools, teaching drafts and candidate review. |
| Human approvals | Keep trusted UI-bound handlers for plan, paid calls and adoption. A generated Chat message cannot create its own approval. |
| Persistence | Host remains authoritative. A transcript summarizes work; it does not authorize it or become the job database. |

Natural-language **continue** is a required primary interaction. Resolve it
against current readiness, the active request and available finite actions.
Ambiguous or paid work opens the relevant question/confirmation. A Chat approval
control may submit the same explicit decision; the model cannot mint human
approval from its own prose. Do not implement an uncontrolled auto-run loop or
parse assistant prose as a successful operation receipt.

Renderer state holds input drafts and view state. Main coordinates existing
services. Host validates task ownership, saved revisions and durable updates.
New requirement-update contracts need producer/consumer validation and spec
updates; no new database owner or renderer-to-provider call is introduced.

## 12. Bounded delivery sequence

1. **Unblock progression**: connect the existing Chat Agent to stage readiness
   and missing authorized operations; add the central next-action presentation,
   plan approval entrance, actionable asset blockers and compilation entrance.
   Verify scene planning continues from Chat with no dependency on mounting or
   visiting the right control form. Moving controls alone does not complete this
   increment.
2. **Collect missing requirements**: finish creation, inline questions and typed
   metadata updates; cover plain, scene and import entry paths.
3. **Reduce media operation burden**: dependency-ordered preparation, exact paid
   confirmations, review and recovery over existing services. No advanced canvas
   redesign is required to restore the core path.
4. **Unify editing feedback**: page-scoped narration/effect requests, source and
   teaching state receipts, then preview/publication readiness.

Each increment must preserve the secondary panel entrance. Do not extend this
task into upstream integration, arbitrary animations, collaboration or a new
generation engine.

## 13. Acceptance scenarios for implementation

1. Create each of the three types and advance its representative path from Chat
   with the right panel never mounted; open it only to inspect or edit artifacts.
   Use natural-language follow-up and “continue” to exercise actual routing and
   domain execution, rather than only clicking relocated panel buttons.
2. A brief already naming grade/topic is not queried again. A missing required
   audience/source prompts once; a selected/custom answer persists after reopen.
3. A scene plan approval leads directly to the actual next-stage card. A changed
   plan cannot use an old approval or quote.
4. Missing assets are identified by page and role; **prepare missing** preserves
   accepted results and cannot submit without applicable cost confirmation.
5. Compilation readiness matches the backend: missing, duplicate, stale or
   identical master/clean-plate assets do not become an enabled successful path.
6. An import task retains its deck and selected narration policy. Cancelling
   the picker offers **Select PPT** without creating a second task.
7. Double clicks, task switching, expired quotes, unknown outcomes, cancellation
   and restart cannot cause cross-task edits or duplicate paid submissions.
8. Chat narration edits affect only the intended page; stale/manual drafts and
   locks receive an explicit resolution rather than being overwritten.
9. Panel and Chat actions immediately show the same authoritative progress;
   closing either surface cannot destroy an acknowledged operation.
10. Keyboard operation, focus restoration, narrow windows, and translated labels
    remain usable. Historical approvals are visible but no longer executable.
11. Within an authorized request, completing a non-blocking step advances the
    workflow without a redundant “next” prompt. Human review and paid work still
    stop at their actual approval boundaries.

Use targeted component/interaction and Host/IPC tests for these transitions.
Reserve a disposable-profile Electron smoke path for the real creation -> Chat
approval -> compilation -> Office boundary. Mock external providers for routine
tests; real cost-bearing acceptance is a separate explicitly authorized check.

## 14. Initial design verification

Inspected the listed local implementation, task dialog work in progress,
existing question component, route policy, scene readiness and Host ownership
ADR. The initial design delivery changed documentation only and did not establish runtime,
paid-provider, visual or packaged-release acceptance.

## 15. Creation and Chat handoff verification (2026-10-25)

The real source Electron/Host/Agent gate
`scripts/e2e-courseware-chat-first.mjs` passed with disposable local data and
loopback identity/model/quotation fixtures. It exercised all three task-creation
routes, optional brief review before sending, retained grade, keyboard focus,
Chat-only plan writing and approval, actual image-intent preparation and an
unchecked fee confirmation. A full process restart recovered the reviewed plan
and image intent without a model replay or media submission. Import requirements
could be discussed before selecting a source PPTX.

The gate exposed and fixed two interaction failures: the floating composer
covered workflow actions, and initial workflow reads raced viewing-session
publication after restart. The workflow now participates in composer dock
measurement, and the shell publishes ownership before child passive reads.
Source screenshots were inspected at 1080x760. Targeted regressions, typechecking,
lint and Desktop build remain required alongside the gate. This bounded check
does not establish live-model generation, paid images, final PPTX compilation,
real WiseOffice or packaged-release acceptance for the new interaction.

The later 2026-10-25 gate extended this evidence through all three explicitly
confirmed fixture images, actual PPTX compilation and real WiseOffice. Native
text and an independent image object survived, with the exact planned narration
attached to the page. It also cancelled/retried the main Chat import picker and
opened unchanged source bytes in Office without mounting the generation form.
This exposed and fixed inherited-model rejection during compilation and missing
source-launch compiler discovery. See
`../validation/courseware/chat-first-20261025/README.md` for the bounded evidence
and remaining live-provider/ordinary-generation/release gaps.

The ordinary Chat preview/export entrance now receives the parent refresh action,
so idle status refresh rechecks saved SVG, narration, planning, quality report and
export freshness. Failed or stale quality gates offer an in-place repair request
in the same Chat. That request is shared with the retained workbench; its original
project-preservation and official validation instructions are unchanged. Targeted
interaction tests cover preview, failed inspection, repair, successful inspection,
explicit export request, editor opening, invalidation after another source edit,
stale task clicks and retry after a refused send. These component/inspection
checks do not establish a complete model-driven ordinary generation run.

The later twelve-case source gate extends ordinary acceptance beyond those
component checks: actual Agent writes, official project/final SVG checks,
real preview Browser navigation, deliberate source invalidation, same-Chat
repair, explicit official SVG-to-PPTX export and actual native Office readback
all pass. ZIP/source hashes and page notes are independently checked. The
one-page content and model tool choices are deterministic loopback fixtures;
production-model quality, longer decks and release acceptance remain open.
See `../validation/courseware/chat-first-20261025/ordinary-full-report.json`.

Ordinary task stage feedback now comes from that same project inspection rather
than the generic task attachment flag: saved pages move to preview readiness,
failed/stale quality to repair, changed inputs to re-export and a current PPTX
to editable. Inspection and incomplete-page stages remain distinct from initial
requirements. The ordinary child owns the single heading/status and initial
hint, so a referenced project does not keep requesting a topic. Scene and import
continue using their existing authoritative task/plan state.
