# DeckWise changes

- Reuse C import media deduplication and canonical workspace paths. Tolerate transient
  page-read races, recover page-local drafts after unrelated edits, recognize Slide
  and bracketed script headings, preserve explicit voices and bound archive reads.

- Degrade unsupported unbound native playback effects to a bounded fade when their
  object is known, otherwise skip them with diagnostics. Preserve original PPTX
  bytes, supported effects and strict source-bound teaching checks. Resolve Master
  single-child group speech motion to the exact visible child.

- Keep final imported scripts verbatim with original-page bindings, optional lesson-plan
  coverage and explicit narration policy across scene, PPT Master and import entries.
  Reuse matching speech audio, protect scripts from automatic rewriting, and insert
  missing plan Quiz/checkpoint pages with native Undo/Redo and durable source saves.
  Attached material text is retained privately by Host for restart and continuation.

- Restore structured scene narration, independent assessment constraints and native
  animation retention during rewrites. Reject changed music prompts before paid
  submission. Persist speech animation timing and keep fixed playback ownership
  consistent after native edits.

- Keep PPT Master speaker notes as generation evidence instead of adopting the
  whole note as completed speech. Generate structured teaching moves before TTS.

- Persist speech-linked animations into the actual PPTX after shared TTS completion
  for PPT Master, scene and import workflows. Preserve logical object identities,
  archived audio and unrelated native timing through the existing save journal.
  Native teaching playback no longer invents missing animations at playback time.

- Continue PPT Master course exports through saved narration, TTS and assessment
  media even when the model omits the continuation flag. Explicit PPTX-only
  requests use `continueTeaching:false`; export actions describe the full handoff.

- Keep reading cues and their target expressions together when generating
  narration and focus effects. Add per-page delivery briefs, bounded pre-TTS
  corrections for incomplete speech, and advisory classroom pacing diagnostics.

- Move saved teaching stories into the PPT workspace right sidebar beside inspection, freeing vertical editing space.

- Fix broken native Quiz option thumbnails when navigating between pages with the same classroom revision.

- Update current Quiz questions and images directly in WiseOffice without reopening the PPT; preserve atomic classroom/PPT save and retry.

- Fix Quiz image uploads interrupted by native document reopen, keep unchanged classroom revisions stable, and decode checkpoint HTML entities during native synchronization.

## Unreleased

- Reconnect native PPT narration to visual semantic grounding and whole-course
  planning. Enable assessment image/reference/question-audio editing from native
  document data, preserve Quiz images in fixed exports, and expose pending media
  jobs for explicit sidebar adoption.

- Publish new scene and ordinary PPT Master lessons with native teaching already
  embedded in PPTX, including notes, logical object identities, Quiz answers,
  teacher interactions and music/video requirements. Chat adoption saves the
  complete native document; continuation uses native readiness and original media
  journals rather than an editable database teaching mirror.


- Preserve native teaching object associations through rename and same-name
  copies using captured package IDs and verified save receipts; resolve live
  attention and animation preflight through the same identity proof.

- Keep slow native teaching model/catalog/media reads from holding later page
  loads or draft writes, with bounded read admission and unchanged mutation fences.
- Reject stale teaching object contexts when page locks change before an effect
  write, retaining the current Host-bound target validation.

- Reopen byte-identical PPTX files after the legacy fallback parser is repaired.
  Recover the current parser mapping through exact native object identities,
  archive the previous mapping and preserve saved narration, audio, cues and
  locks. Ambiguous or changed sources still require explicit review.

- Preserve body object identities when assessment images import namespaced PPTX
  layouts/masters. Recover original question audio across unrelated classroom
  revisions without repurchasing, and checkpoint course continuation before
  native saves. Reuse validated narration briefs on failed-page retries and keep
  named portraits eligible beside sentence text carriers.

- Keep SVG preview/editing available after PPT Master adoption and automatically
  open the first SVG during generation. Reuse shared Quiz/checkpoint playback
  views in the native PPT teaching surface; preserve portable and team playback.

- Ground saved narration in actual slide evidence and teaching requirements,
  using speaker notes as reference. Keep complete teaching moves together,
  report contradictory notes and missing required visuals before TTS, and retain
  source files. Clarify PPT Master assessment schemas without replacing classroom
  interactions with short-answer Quizzes; invalidate exports after animation
  configuration changes.

- Generate PPT Master Quiz/checkpoint drafts with the shared fixed assessment
  layouts. Models author only body SVGs; preserve editable questions, official
  quality/export gates, existing drafts and the common TTS/option-image workflow.

- Continue official PPT Master exports through the shared saved teaching workflow:
  detailed narration, object-bound effects, speech/question audio and real Quiz
  option images. Preserve logical page requirements and restart recovery; reject
  stale exports and keep PPTX-only requests free of extra media generation.

- Keep saved-teaching repairs local, preserve per-requirement retry budgets,
  reconcile lost repair receipts, and stop unknown assessment submissions without
  replacement orders. Align narration prompts and validation for independent
  assessments, existing music and bounded waits. Expose automatic continuation
  operations through normal tool progress and sanitized failure logs.

- Preserve successful speech generation when an optional focus repair fails;
  recheck saved acceptance and report remaining diagnostics. Keep speech-only
  requests from enabling whole-course continuation.

- Allow missing speech audio to be filled on verified native saves without
  rewriting narration. Validate fresh semantic evidence against current object
  IDs, accept empty cue lists, and preserve newer narration during unrelated
  canonical edits.

- Fix native interaction playback rejecting valid saved questions with an empty
  source-scene context after native page reconciliation.

- Add visible generate/regenerate audio controls below Quiz questions, classroom
  interactions and native narration. Invalidate edited audio and automatically
  apply confirmed TTS results while preserving paid-task retry safeguards.

- Reuse the native Teaching Flow header and icon controls on Quiz and interaction
  pages, with canonical undo/redo, autosave status and course preview.

- Limit generated and natively authored Quiz slides to one question and insert
  them among body slides. Simplify the native Quiz/checkpoint sidebar to the
  cloud-web editing fields, autosave changes, and enable course preview without
  unrelated native-timeline warnings on assessment pages.

- Preserve teaching-story confirmation when saving the body-page budget, so
  ordinary and scene generation can continue with the same approved story.

- Add optional teaching-story design and review before ordinary or scene
  courseware generation, with saved revisions and explicit confirmation.
  Keep direct generation as the default and preserve the PPT import path.

- Add readable native teaching playback controls with previous/next page, replay, progress seeking and five-second fast-forward.

- Reconcile archived native speech, music, video, pauses, animations and timed
  visual cues into standard MAIC actions. Retain an actionable pending reason
  for native actions that have no faithful MAIC equivalent.

- Disable timer throttling while the native Office view initializes offscreen.
  Optimize SHA-256 in development builds without skipping saved-source validation.

- Reuse verified unchanged PPT source digests on Linux teaching reads, while
  retaining workspace, file identity, external-edit and native-save fences.

- Hide the native Office surface behind New Task, search and courseware publishing
  dialogs, then restore the same document when dismissed.

- Add speech-triggered animations and compact native-animation linking. Preserve
  selected words, calibrate their position against real audio, retain stale intent
  after narration edits, and play animation tails before post-speech pauses.
  Portable/fixed playback retains references without duplicate native execution.

- Keep tools available for post-submit scene-plan status reads and finish on the
  existing final response instead of requesting a tool-less extra response.
  Route cover-only rendering corrections through image instructions, retaining
  plan approval; actual plan revisions still require human review.

- Keep scene-planning corrections available after reading draft/reference files.
  Detect plan mutations from Write/Edit target paths instead of shell commands
  or file contents; retain validation and human plan/style approval.

- Validate scene drafts before closing planning, stop completed courses at the
  tool-result boundary, and summarize final media status. Repair missing character
  focus without replacing saved speech/audio or purchasing new TTS.

- Preserve original music/video target bindings across verified PPT saves; begin
  only after queue admission, reconcile concurrent status reads and retain
  ambiguous legacy orders without replacement purchases. Bound image/video
  recovery, preserve healthy independent work and close terminal reporting once.
- Repair required teaching with action deltas that preserve saved speech/audio,
  compare the exact approved question contract, and retain required video through
  planning, compilation and Host acceptance. Add a fresh-Host workflow gate to CI.

- Validate music generation/export models before saving intents, allow corrections
  only for never-submitted requests, and keep paid/unknown order identities.
  Reject unapproved scene music and safely remove legacy unsubmitted slots.
  Stop stalled courseware with one blocked report and use saved completion counts.

- Check complete-course acceptance against retained page requirements, persist
  bounded repair progress in Host, and resume verified native saves without
  resetting budgets. Restore missing approved questions/music while retaining
  existing speech/audio/effects; retry only explicit transient original-job reads.

- Allow verified local teaching audio/video blobs in the production editor CSP.
  Preserve user-edited native animation presets, durations and click order during
  teaching playback; play multiple native steps per speech without duplicate effects.

- Raise independent TTS concurrency to ten and batch same-page generation,
  recovery, downloads, decoding and verified archives. Keep revision-checked
  adoption ordered, preserve successful audio on partial failure, and recover
  original pending jobs without duplicate paid submissions.

- Resume safe teaching recovery buffers after saved-source changes, retire buffers
  already saved, and expose page-scoped draft deletion for actual conflicts.

- Keep background courseware generation, narration and media bound to their
  owning turn when navigating between Chats or settings. Preserve Stop, source,
  account and revision checks, and foreground ownership for editor actions.

- Recover teaching after an older native animation save when the complete named
  page/object inventory still matches. Preserve narration, adopted audio and
  logical IDs, archive the previous teaching, and reject ambiguous changes.

- Make spotlight/highlight Add, Save and Cancel controls distinct, retain the
  foreground teaching owner during background prompts, and keep new narration
  sentence-based without rewriting previously saved audio or manual teaching.

- Remove per-page teaching confirmation and per-effect approval. Saved narration,
  media and mapped effects use automatic validation; only teaching-plan and
  first-page style approval gate the teaching workflow. Legacy review flags no
  longer block editing, readiness, snapshots or playback.

- Choose a scene art style or enter a custom description when creating a task.
  Preserve it in planning and across pages instead of forcing hand-painted
  picture-book styling.

- Review Chat-generated page rebuilds, fade transitions and style batches in the
  main Chat. Reuse the existing read-only preview, explicit object associations
  and adoption flow; preserve current-page narration drafts and reread uncertain
  results instead of repeating writes. Keep the editor lookup as a fallback.

- Review Chat-generated narration directly in the main Chat, compare the saved
  and proposed text, and explicitly adopt or reject without copying candidate
  IDs. Preserve manual drafts, reread uncertain decisions and refresh a clean
  teaching sidebar once after adoption.

- Reuse the effective Chat model for narration rewrites and reviewed page
  candidates when the task inherits application defaults. Reject changed model
  or thinking inputs before candidate persistence without rewriting task settings.

- Show the ordinary courseware's actual saved-project stage in Chat, including
  preview readiness, repair, changed pages and editable exports, instead of
  leaving completed decks at requirement collection.

- Refresh ordinary PPT inspection from the main Chat and offer in-place repair
  when quality checks block export. Reuse the workbench repair request and keep
  export disabled until the saved project passes inspection again.

- Resolve inherited Chat models for scene compilation and reject changed model
  inputs before adoption. Discover staged compiler resources in source launches,
  and show image submission, billing and failure status in the main Chat.

- Carry optional new-task requirements into the main Chat for review before
  sending. Preserve entered teaching details and attachments. Allow import
  requirements before file selection, and stop Chat submissions from
  automatically opening the generation workbench.
  Keep workflow actions above the composer and restore saved task state after
  restart without needing a new Chat turn.

- Advance courseware generation from the existing main Chat: review scene plans,
  confirm image costs and selections, continue compilation, import a PPTX, or open
  ordinary PPT preview/export. Save answered teaching requirements with stale
  update protection. Keep existing workbench and Office editing entrances.

- Review an online server save from the existing editor with explicit page and
  highlight/spotlight associations and original/saved page previews. Review keeps
  the live courseware unchanged and explicitly remains separate from publication.

- Review and explicitly share verified existing narration/music audio while
  preparing online teaching. Interrupted transfers query the same assets before
  adopting; local teaching and ordinary PPTX-only preparation are preserved.

- Add fixed per-editor native pause/status/resume transport for the online
  publication coordinator. Unsupported engines and unknown save outcomes stay
  explicit; complete multi-client publication is still being integrated.

- Preserve the complete original page/object mapping when preparing online
  teaching, and verify its immutable source-bound server copy on recovery.
  Changed mappings and earlier partial-mapping receipts require reconciliation.

- Discover and explicitly release an existing teaching-edit pause from the
  Owner's online narration sidebar after restart. Frozen teaching revisions
  and unsaved drafts remain visible; this does not pause native PPTX editing.

- Join an existing team's online editing session from Team Projects through
  an isolated Office view when the installation supplies a Docs deployment.
  Owner and Editor use the shared active document; read-only members cannot
  enter editing. Native sync status does not claim a saved or published source,
  and closing the view leaves the team's session running.

- Preview deleted-page narration from local courseware history and explicitly
  recover text, pauses and teacher-continue checkpoints into an empty current
  page's editable draft. Historical audio and object effects require new review;
  existing destination music is retained and saving remains explicit.

- Explicitly add an archived music export to the saved current page as an
  independent teaching clip. Review its target before adoption, reorder or
  remove it alongside narration, and play verified music in fixed previews.

- Preserve the same Chat's editor ownership when its media canvas is visible,
  so explicit music adoption can use the retained hidden editor. Source, page,
  revision, unsaved-change, permission and adoption conflict checks remain in
  force; native Chat tools and TTS still require the active editor.

- Explicitly retrieve an archived canvas image from its original task when the
  local file is missing or corrupt, preserving its exact version without a new
  generation request.

- Reuse archived canvas PNG/JPEG images as references for new image variants.
  Preview the original reference and confirm a fresh quote before generation;
  keep earlier candidates and their saved prompts.

## 0.17.6 — 2026-10-12

- Preview TXT documents and plain-text attachments directly in the local
  text viewer, preserving their content without WiseOffice conversion.

- Open supported Office formats in the built-in editor. Workspace
  documents keep revision history; legacy formats save OOXML copies, while
  PDFs and attachments open read-only.

- Confirm PPTX editor readiness before opening the document, show loading
  feedback, and recover failed startup with a fresh session through Retry.

- Preview PDF attachments inside DeckWise up to 256 MiB, with a system-default
  application action for oversized PDFs and other binary attachments.

- Configure the built-in AI context window in Settings → Models, using presets
  or a custom token count. The setting persists locally and applies to future
  requests without changing custom providers or platform credentials.

### MAIC assessment sidebar

- Edit the selected Quiz or classroom checkpoint beside its native PPT page.
- Synchronize Quiz options and images to a fixed learner-facing PPT layout.
- Preserve current page selection after atomic classroom/PPT saves.
- Keep teaching readable after ordinary PPT saves while the canonical canvas
  awaits reconciliation; retain existing narration and assessment bindings.
- Reuse verified native course state when switching assessment pages, and load
  only images used by the selected Quiz.
