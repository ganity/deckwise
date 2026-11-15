# MAIC assessment sidebar and physical Quiz projection

## Contract baseline

Remote main was fetched before implementation:

- MAIC `22465d4ccf2adb8ad0c82c09182547721d3b8a03`: `lib/types/stage.ts`,
  `lib/interaction/types.ts` and `lib/types/action.ts`.
- cloud-web `2bac709be56c7a492eff4fb2630db3d7de36dd43`:
  `components/scene-renderers/quiz-view.tsx` and
  `components/canvas/editor-panels/interaction-constraint-prompt.tsx`.

Quiz remains an independent `type:quiz` scene with `content.type:quiz` and no
canvas. Chapter interaction remains a slide canvas plus a
`type:interaction_checkpoint`, `checkpointKind:chapter_summary` action. Physical
PPT objects are an editor projection and never become the canonical Quiz data.
No legacy-course migration is introduced.

## Editor behavior

The existing canonical classroom form has a sidebar mode. The current native
page selects the corresponding canonical scene. Quiz and chapter interaction
pages automatically display their form beside the native PPT surface, replacing
only the native teaching inspector in that space. All page types retain the same
native Teaching Flow header, icon buttons and status row. On assessment pages,
the existing undo, redo, save, refresh and preview icons act on the canonical
editor draft. Its save status and page type appear in the existing status row;
there is no additional assessment title or text-button toolbar. Ordinary pages
retain their native teaching workflow.

Playback reports preparation immediately in the shared status row, with an
indeterminate progress indicator while reading the saved questions, preparing
audio/media and starting the native slideshow. Start buttons are disabled until
preparation finishes; save-status updates cannot overwrite playback progress or
errors. Failures clear the busy indicator and leave an explicit retry available.

Chapter checkpoint context may have an empty `sourceSceneIds` list, as allowed
by canonical MAIC storage and export, including after native page reconciliation.
Native preview preserves that context, plays the question and waits for explicit
teacher continuation. It does not invent source bindings to enable playback.

The native sidebar follows cloud-web: choice/judge type, stem, question/option
images, 2–4 option cards with letter buttons for the correct answer, and analysis.
Existing multiple-choice/short-answer data remains editable without conversion.
Interaction pages show question, constraint prompt, reference answer and individual
key points with add/remove controls. Reference regeneration updates the answer
and points together; scene/chapter/source identity stays in collapsed settings.
Classroom feedback settings are also collapsed below the Quiz form.
Every authored Quiz page contains exactly one question. It cannot add or remove
questions inside that page; additional questions use additional physical pages.
Feedback settings are collapsed below the question form. The sidebar autosaves
and exposes no redundant manual save button. Course preview uses the same
canonical actions as export. Archived native media, bounded pauses, native
entrances and calibrated speech cues are converted before preview; unsupported
actions report an exact reason rather than silently playing an incomplete
course. Interaction editing includes question, constraint
prompt, reference summary/label/key points, chapter and source context. The two
fixed MAIC playback literals retain their upstream defaults. The existing full
course editor retains scene creation/reorder/copy/delete and speech tools.

The same document draft survives selection changes, with revision-fenced
recovery and existing autosave/error handling. Native teaching requests are serialized across assessment saves and subsequent page loads. Native dirty edits disable canonical editing until the
PPT is saved. Source hash changes refresh a clean canonical view. Page selection
is read serially at 800 ms intervals; no overlapping context requests are sent.

Native assessment selection reads the saved canonical classroom directly when
its source revision, teaching revision, page count and per-page native identity
still match the current editor project. Native reconciliation stamps that
verified teaching revision on bound scenes; a mismatch or source conflict uses
the existing full reconciliation path before editing. Assessment reads encode
only images referenced by the selected Quiz, and Chat ownership checks request
only the minimal session window.

## Shared assessment media

Import, scene and PPT-master workflows use `courseware_media_assessments` against
the saved canonical classroom. Quiz speech reads the question and option labels;
each chapter checkpoint has a managed speech immediately before its wait.
Question or option text changes invalidate only the corresponding audio.
Existing exact narration and archived option images are retained. Missing choice
option images use the existing quoted image relay and trusted archive pipeline.
Whole-course completion waits for these assets; pending orders retain their
original identity and are refreshed without duplicate submissions.

The same question TTS and option-image controls are mounted in the standalone
editor and WiseOffice sidebar. Question and narration speech use a single
Generate/Regenerate action: obtain the trusted quote internally, submit once,
poll the original task and apply its archived audio. No quote, fee confirmation
or manual refresh is shown. Insufficient points produces a clear error and keeps
existing audio; uncertain submissions remain queryable without resubmission.
Model and voice selection remain available. Option-image quoting is unchanged.
WiseOffice loads canonical question audio through
the bound Main preview handler and plays it in its native timeline. Embedded
questions keep the ordinary body teaching controls and do not exempt the body
page from narration or media generation. Native import/PPT-master teaching can
initialize canonical questions without a generated scene plan.

Background generation uses the owning Agent turn and saved PPTX, independently
of the visible Chat or Office page. Generated Quiz images use the same compiler,
source hash fence and durable native-save receipt as editor saves. Canonical-only
Quiz courses bypass native parsing. Provider calls are mocked in regression
tests; real Host, PPTX compilation/archive and headless WiseOffice playback are
covered locally.

## PPT synchronization

Quiz gets a fixed white/blue template: title, question, optional question image,
option cards with optional images, and an answer-area prompt for short answers.
Every projected Quiz contains one question; the native save writer and compiler
reject multiple questions even in assessment-review mode. Planning inserts Quiz
pages among body pages, after their related learning content, without reducing
the body page budget. Generic MAIC import/playback retains upstream review-mode
compatibility. PPT is a static projection; runtime answer interactions
remain in the canonical MAIC player. Answers, analysis and grading instructions
are not exposed on the learner-facing PPT.

The native writer compares complete Quiz content. Changes confined to the current
Quiz page use a finite `document:apply-quiz-page` bridge command: validated layout
elements and locally normalized PNG bytes update named native objects in one
history group, without destroying the editor or reopening the PPT. Missing object
bindings, stale context and invalid images reject before changing the page. PNG/JPEG/WebP uploads
remain workspace-archived and revision-fenced. Compilation resolves local images
inside the workspace, bounds input size/pixels, converts to PNG, and contains
images in their template boxes. It makes no network or model calls.

The existing Host save receipt commits PPT identity and classroom together. The
current-page path releases the teaching read lock before native export takes its
save lock. Main retains the canonical draft on a failed save for an atomic retry,
and clears it only on commit or document disposal. Structural edits and other
assessment pages retain the file compiler and restore selection after reopening. The WiseOffice adapter is built from source through Desktop's
existing transform pipeline; its source checkout is not modified.

## Validation

- Runtime fixed-template tests compile and reimport actual PPTX files, check
  option-only changes and embedded images, preserve other pages, and reject an
  unavailable image resolver.
- Main/real Host fixture saves options, questions and page operations, restarts
  Host, and verifies saved PPT text and canonical Quiz independence.
- Renderer browser fixtures exercise sidebar forms, cross-page drafts, autosave,
  reference labels, image retry and all four question types.
- PPT workpanel browser fixtures verify sibling geometry, native visibility,
  native teaching restoration, and sidebar retention during reopen.
- The actual bundled native SDK browser probe selects and reads another page
  through the module bridge without writing teaching actions.
- A real 12-page course switches body → Quiz → checkpoint → body repeatedly;
  warm assessment reads do not parse or refresh the PPT, encode body-slide
  images, or read full Chat history. Changed source/page/teaching revisions
  still take the existing synchronization path.

Fixtures use isolated temporary workspaces/profiles, with no paid services or
access to the user's running Desktop.

## Upload and text round-trip guarantees

Image attachment accepts the current validated classroom draft and commits it
with the archived image in one revision-fenced native save. The current Quiz page
stays mounted throughout upload and export; there is no separate pre-upload save. Failed
uploads retain the draft and original revision for retry. Unchanged Host writes
retain their revision after validation; stale revision/source fences still reject.

Native checkpoint rich text decodes numeric and named HTML entities before it
becomes plain question text or a new physical assessment page. Previously stored
partial-decoder output is repaired only when it still matches its saved canvas
and native baseline; independently edited questions are preserved.

## Live Quiz regression coverage

`wiseoffice-quiz-live.browser.mjs` drives the real WiseOffice SDK: initial image
insertion with an unsaved question, repeated replacement, stale context rejection,
invalid image rejection, native undo/redo, and actual PPTX export. It asserts the
same iframe and presentation objects survive. `courseware-classroom-save.test.mjs`
checks Coordinator.image through the real Host receipt and restart, with Office
export as its external boundary. `ppt-editor-save.test.mjs` checks export failure,
retry with the same canonical draft, blocked close during save, and no reopen.

## Page-scoped thumbnail hydration

Native assessment reads resolve only the selected Quiz page's image bytes. Moving
to another Quiz may keep the same classroom/source revision while providing a
new resource URL map. The mounted canonical editor merges this display-only map
when all three identity fields match; it preserves its document draft and undo
history. Local asset paths never replace data URLs simply because page selection
changed. `wiseoffice-quiz-images.browser.mjs` checks actual image decoding on two
Quiz pages and returning to an edited question in the same iframe.
