# Native teaching parity audit and corrections

The user requested comparison against committed local Part A and corrections in
those existing worktrees. No branch, remote, original course or provider order is
changed by this audit.

## Compared revisions

| Repository | Original Part A | First native integration | Before generated-loop integration | Audited HEAD |
| --- | --- | --- | --- | --- |
| Desktop | `cb8b3e636` | `ea8fa4cb9` | `bc7d6aab611f0fa6b5915f0917ba8d54fd95a899` | `c2173081eda9cea4a5baef47b2f4bdfeeb76a541` |
| document | `daf16b67` | `a36c9c83ee03772fe09679eb489b64bd9d6564c4` | `a36c9c83ee03772fe09679eb489b64bd9d6564c4` | `724ae08b1a1f1466cfa32c3fe67b1354cc2cb308` |

The last integration was a fast-forward. The confirmed defects below are semantic
handoff omissions, not unresolved Git conflict markers. Merely checking that the
native format exists, or that a fixed player synthesizes a pulse, did not prove
that the original generation behavior and native PPT timing survived.

## Itemized comparison

| Behavior | Committed earlier behavior | Audited behavior | Result of this correction |
| --- | --- | --- | --- |
| PPT Master body narration | Adopt no speech; shared generator reads slide/notes and emits several teaching moves | Packer reads the entire notes text and marks one generated speech ready | New body pages start without speech; notes remain evidence; integrated native proposal test emits multiple blocks |
| Scene body narration | Seed sentences use provisional `narration-N` IDs; quality does not certify them as detailed narration | Whole planning narration becomes one ready generated speech | Planning narration stays in generation metadata and native evidence; structured body generation is required |
| Highlight and spotlight generation | Structured narration proposes object intents; TTS resolves intervals | Resolution exists, but false narration readiness can prevent intents from being generated | Restore generation entry; test both cue types against measured adopted audio and real live targets |
| Automatic native speech animation | Saved TTS calls `persistSavedSpeechAnimations` / `syncSpeechAnimations`; native playback requires a saved mirror | Native TTS resolves cue metadata but never writes SDK timing | Verified media adoption stages missing SDK effects and publishes timing/media/metadata in one native history action |
| Manual speech animation | Sidebar writes cues; native animation ownership remains separate | Native write also lacks materialization of newly added teaching effects | The same timing preparation now handles native page writes, including nonzero offsets and speech-end triggers |
| Native Undo/Redo | Native history owns slide timing | Registering detached timing incorrectly would make Redo lose the object | Build detached trees with SDK object registration retained; actual editor tests check timing and metadata through Undo/Redo |
| Fixed publication with persisted speech timing | Exact mirrors must have one playback owner; explicit native links detach from source timing | Exact generated matching requires one complete click group per speech; adding a later cue makes native timing conflict with the speech cue | Claim verified exact mirrors individually, respecting duration/preset/target and leaving unrelated native timing intact |
| Body/assessment separation | Saved batch passes `independentAssessmentPages` | Native single-page generator omits that flag | Pass the existing approved-page rule; body generation cannot insert independent assessment blocks |
| Rewrite on pages with explicit native animation nodes | Shared narration validator does not accept `native_animation`; this limitation also predates the latest integration | Native preservation loop runs too late, after validator rejection | Exclude native nodes from model input and restore the exact original nodes in the output; keep revision validation |
| Music prompt mismatch | Native service checks prompt again during adoption | A changed prompt can incur generation/export before eventual rejection | Reject mismatched approved-slot prompts before preparing/submitting a provider task; keep adoption check |
| Adopted music/video through narration rewrites | Existing media should not be repurchased or deleted | Native preservation exists | Retained; tests cover exact clip IDs, durations and satisfied repair without replacement model/media work |
| TTS/audio packaging | Native media is immutable and independently stored with hashes | Packaging exists | Retained; real editor reopens and decodes all four audio assets, video remains playable, Host verifies imported assets |
| Quiz/practice response and question reading | Answer indices/options and teacher continuation are authoritative | New format carries them; empty optional explanation is accepted by current player | No new failure found in exercised paths: actual editor and fixed player check answer B and practice; not a claim of full assessment editing parity |
| Object identity and empty-page navigation | Native identities survive rename/reorder/copy; empty teaching pages should not block | Previously repaired native paths retain these protections | Run the existing copied six-page Part A fixture, including empty third page, against the changed editor |
| Official PPT Master `animations.json` | Official customization/export path owns separately requested native effects | Exported source is retained by packaging; new speech animation was a separate missing step | No source change to official customization/export; official-skill integration test is skipped when that skill is absent |

## Remaining differences at the original audit checkpoint

The following four gaps were still open at the original audit checkpoint.
They are addressed by the continuation recorded below; this list is historical.

1. **Visual semantic grounding.** The old saved batch renders slide/embedded
   images, invokes `completeVision`, validates observed object aliases and target
   eligibility, rejects missing required visuals and excludes contradictory
   notes. The native router supplies live text, names, bounds and UUIDs, while the
   native candidate uses text completion. Generic image names cannot safely
   substitute for observed character/object identities. Image-only layers may
   therefore still lack automatic focus or receive weaker narration evidence.
2. **Whole-course teaching planning.** The old saved batch creates a validated
   ordered course outline with per-page bridges, focus and delivery contracts.
   Native tools currently propose pages sequentially through the single-page
   coordinator. Supplying current page requirements does not restore that shared
   arc, peer-page context, bounded batch repair or cache.
3. **Assessment editing surface.** Native question playback and text/answer
   editing are exercised, but the old canonical classroom image/reference/TTS
   editor routes are not implemented by `routeNativeTeaching`. They cannot be
   called equivalent to the former assessment image editor. Editing slide
   artwork directly remains possible and is a different operation.
4. **Media sidebar parity.** Native `media:list` lists embedded media; private
   pending provider jobs are exposed through native Chat media context instead.
   The old sidebar's unembedded music adoption fallback still references the
   legacy coordinator. That dormant fallback is not exercised by successful
   Chat music adoption tests, so those tests cannot certify the entire media UI.

The next parity work should bring the existing evidence/whole-course planning
and assessment/media editing capabilities behind native document commands, using
live UUIDs and the document save contract. It must not reintroduce mutable Host
teaching as a second authority or infer aliases from an approved plan alone.

## Regression evidence and validation

The notes, missing native animation, scene seed, explicit-node rewrite and music
prompt regressions failed before their respective fixes. Adding actual native
Undo/Redo uncovered the SDK registration requirement. Exporting the edited PPTX
and building it through the actual Host/converter uncovered
`NATIVE_ANIMATION_CUE_CONFLICT`, which a canvas-only test had missed.

The corrected fixture goes through real Host generation/parser, native route
writes with deterministic model output, local PCM/MP4 media adoption, actual SDK
timing, manual animation editing, Undo/Redo, playback, PPTX save/reopen, native
snapshot import and fixed Chromium playback. No live model or paid provider is
used. Existing user files are not automatically regenerated.

Validation results on Linux:

- Desktop native narration/generation/music/presentation: 50 passed, one skipped
  official PPT Master skill case. The presentation subset passed again after the
  shared body-seed correction. Actual Host/parser/restart was enabled.
- Document native teaching/sidebar/identity/preview/animation/history: 142 passed.
- Runtime native animation, timeline, fixed build and fixed loader: 89 passed.
- Desktop/document/runtime TypeScript checks and production builds passed.
- Generated real editor E2E: actual pulse/teeter timing, Undo/Redo, highlight and
  spotlight, slideshow, all audio decoding, Quiz and save/reopen passed.
- Copied six-page real Part A fixture E2E passed (2.5 minutes), including the empty
  third page and its existing teaching/audio/native animations.
- Actual Host snapshot import, all embedded assets, fixed build and restart passed.
  Chromium fixed playback passed speech/music/video/animation/highlight/spotlight,
  Quiz answer and practice with no runtime errors. Build ID:
  `1fc5ce5ca0b64e66e0f2ce74f6840fd8c3f0f50f4caf96a68ff01e9ab7f96026`.

Evidence is retained under
`/home/jhz/deckwise-validation/native-teaching-parity-audit-20261110`.
The original files remain unmodified. The fixed report still says visual fidelity
`NOT_VERIFIED` and notes-master preservation requires review. Live provider
quality, release installation and general external PowerPoint/WPS round trips
were not tested. No source changes are committed by this audit.


## Four-capability continuation, 2026-11-10

The native path now feeds live text, notes, logical object UUIDs and rendered PNG
bytes into the existing saved narration batch. This reuses its visual semantic
validation, whole-course plan, peer-page bridges and bounded repair. Validated
object roles/aliases and speech write to the PPTX carrier with revision checks.
Office generation changes invalidate the batch even when text/bounds did not
change. Existing adopted music/video and explicit native animations are retained.
The native path intentionally does not share a persistent legacy snapshot cache.

The existing assessment editor now reads a transient classroom projection from
native teaching. Uploads, option-image generation, reference generation and
question TTS keep their existing quote, principal, receipt and byte checks, but
write into the current document. Rich Quiz data and self-contained images live in
`assessments[pageId]`; strict checkpoint actions retain grading/reference fields.
Discussion prompt/label details live separately in `checkpointDetails[pageId]`.
Native Undo/Redo and save/reopen apply to these changes. Copies remap identities
and retain image/reference metadata. This projection is not a second Host-owned
editable classroom. Discussion question wording continues to use the native PPT
text workflow; the reference/context fields can be edited independently.

Fixed publication reads assessments from the verified snapshot PPTX, archives
image bytes under content hashes and restores Quiz content/images in the fixed
player. It does not depend on mutable classroom files.

The media sidebar combines embedded document media with original pending
music/video jobs from Host journals. Listing submits no order. Explicit adoption
uses the original job slot and the native verified-media service; unfinished jobs
remain unadopted. Embedded narration audio is excluded from reusable music.

Continuation validation (separate from the earlier audit counts):

- Desktop targeted narration, assessment, media, package, fixed-build and Chat
  regressions: 114 passed; two fixture-gated cases were enabled separately and
  passed with the actual worker/Host (3 package/snapshot tests in that run). Native batch tests cover image-only pages, one course plan,
  semantic UUID writes and stale Office generation rejection.
- Runtime fixed builder/loader and classroom schema: 77 tests passed, including
  embedded Quiz image archiving and blob URL recovery.
- Document native-teaching and preview regressions: 50 tests passed, including
  assessment CAS, reference details, slide copies and locks.
- Real ONLYOFFICE browser test renders live PNG, edits an image question and
  answer/reference, exercises native Undo/Redo, then saves and reopens a copied
  PPTX and compares the complete question.
- Desktop/document TypeScript and production resource builds passed. The matching
  editor is staged in the existing Part A Desktop worktree; previous resources
  are retained outside the worktree for rollback.

Logs: `/home/jhz/deckwise-validation/native-parity-20261110`. Tests use local fake
model/media replies. Live provider quality, paid submissions, release installers
and external PowerPoint/WPS round trips remain unqualified. The changes are local
and uncommitted. Existing user courses were not regenerated or overwritten.


## Final follow-up corrections, 2026-11-10

The final comparison found seven additional regressions. These are now corrected
in the existing Part A Desktop and document worktrees:

| Regression | Correction and evidence |
| --- | --- |
| Read-only Chat could submit paid TTS before adoption was rejected | Project native read-only state into service views and reject TTS, music, video and assessment writes before dispatch; cover initial and late read-only transitions. |
| Undo of the first edit on a newly copied slide recovered the edited fallback | Keep an immutable copy seed independent of the mutable projection cache; replay the pre-write carrier and verify the original copied narration returns. |
| Native automatic assessment images incorrectly reported completion | Wire native Chat to the existing assessment-media coordinator; enumerate missing option images and retain existing quote, submission and adoption handling. |
| Quiz edits changed metadata while leaving the visible PPT unchanged | Reuse one native Quiz projection for both legacy and carrier-owned editors; preload PNGs and commit visible text/images with teaching metadata in one native Undo action. |
| Practice/PBL checkpoints produced an invalid Quiz projection | Preserve practice, PBL and discussion as interaction actions on slide scenes. |
| Freshly generated Quiz details were absent from fixed export until edited | Package the complete validated Quiz into assessments at generation; normalize older generation metadata when reading without changing the original PPTX. Explicit edited assessments take precedence. |
| Discussion question editing had no native text binding | Bind a unique matching native question object to the existing editor, write only that object, and preserve paragraph/run formatting. Ambiguous bindings fail rather than editing an arbitrary object. |

The real Office regression now checks visible question text, inserted image count,
question metadata, original practice font size, one-step Quiz Undo/Redo and both
pages after save/reopen. The legacy live-Quiz regression also passes insertion,
replacement, stale/invalid image rejection, Undo/Redo and actual PPTX export.

Validation for this follow-up:

- Entire Desktop courseware suite: **1518 passed, 21 fixture-gated skips, zero failures**.
- Document native teaching, identity, sidebar, preview and animation regressions:
  **142 passed**. A five-second sidebar history test timed out under concurrent
  build load; the complete subset passed with a 15-second test timeout.
- Runtime packaging, fixed build/loader and native animation regressions:
  **85 passed**.
- Desktop and document TypeScript checks, Desktop production build, integrated
  editor production build, relocated authoring runtime verification and all
  155 staged worker file hashes passed.
- Native Office browser and legacy live-Quiz browser checks passed.
- Complete Host workflow gate passed: 567 Main/Host tests, 35 shared-contract
  tests, 483 Agent-runtime tests and 295 Rust courseware contract tests (two existing ignored cases); every mandatory case ran.

Matching editor and worker resources are staged in the existing Desktop worktree.
Their previous versions are retained under
`/home/jhz/deckwise-validation/native-parity-final-fixes` together with the new
fixture and verification logs. No original course is rewritten; no source commit,
remote publication, paid request or release installation is performed.

## Post-adoption media-context failure, 2026-11-10

The reported session successfully adopted the presentation, then failed its
automatic `courseware_media_context` call. The resumed assessment read identified
`Local teaching fields cannot enter MAIC actions` at scene index 11. A read-only
replay of the actual 12-page lesson reproduces the rejection when its discussion
checkpoint's native `response` enters the MAIC projection.

The native assessment router now projects the chapter checkpoint's MAIC fields
explicitly. Native response kind/options/answers remain in the original carrier
and survive reference-answer edits. The shared MAIC validator remains strict.

Automatic continuation also retains its failed operation and a bounded error code
inside the runtime until pi-agent-core emits its local failure message. The UI
receives a safe workflow error and operation rather than a generic provider
request-preparation failure. Original exception payloads remain local. Provider
retry, explicit transient read retry and cancellation rules are preserved.

Regression evidence includes the practice/PBL/discussion write round trip, the
actual router-to-MAIC-validator browser seam, and the runtime adoption-to-failed-
media-read sequence with no additional model request. The actual user PPTX replay
passes and verifies that the source bytes remain unchanged. Validation artifacts
and the previous editor bundle are retained in
`/home/jhz/deckwise-validation/assessment-projection-fix-20261110`.

Final validation: 34 document tests, 195 runtime/error/retry tests, and the real
Office browser regression passed. Document typecheck, runtime build/bundle,
integrated editor build/staging and Desktop production build passed. The full
workflow gate passed 567 Main/Host, 35 shared, 484 Agent-runtime and 295 Rust
contract tests (two existing ignored cases). The current application was not
restarted; a reload/restart is required to load the new editor/runtime resources.
No paid provider request, source commit or publication was performed.


## Native narration recovery and page-8 repetition

Read-only inspection of session `4816c5ec-1880-4185-882e-09560839c4d2`
identified six unsuccessful standalone page-8 proposals: four document-state
conflicts, one invalid visual observation, and one missing required-content
failure. None saved page 8. The adopted plan requires two questions and a
thinking/reference card on page 8 and vocabulary cards on page 9; the open PPT's
page 8 contains the vocabulary cards. Editing an upstream SVG without exporting
and adopting it cannot repair that live document. The content check remains
strict; this change does not reinterpret or silently approve the lesson plan.

Three shared points now address the repeated attempts:

- Native narration compares current content when Office generation changes.
  Selection/navigation alone retain valid output; changed text, geometry,
  requirements, or requested-page pixels trigger at most two fresh snapshots
  and regenerate only unfinished pages. Acknowledged pages survive later-page
  conflicts. Ownership, page-order, read-only, and manual teaching edits remain
  blocking. An optional atomic editor-generation check closes the final write
  race. Lost acknowledgements are read back before any replay.
- Missing required visual content produces a non-retriable content-mismatch
  result. Identical live content/requirements/model/session reuse that failure
  without another model request, even when instruction wording changes. A real
  content/requirement change permits a fresh attempt. Partial persistence no
  longer reports the whole narration batch as saved.
- Native single-page generation grounds only requested pages visually. Peer
  text, notes and teaching requirements still inform the full-course outline;
  existing legacy grounding behavior is preserved. Only requested slides need
  local preview rendering as well.

Provider-free regressions cover harmless navigation, text and pixel edits,
continuous edits, successful-peer retention, final-write selection races, lost
replies, manual edits, mismatch deduplication and single-page vision scope. The
isolated Office browser regression uses a copy of a generated PPT and simulated
model output; it never edits the user's running session.

Validation completed: 45 targeted narration/native-tool tests, 34 narration
source tests, 110 document embed/native-teaching tests, and the real Office
browser navigation/content-edit/atomic-write regression passed. The broader
Desktop courseware run passed 1,530 tests with 21 environment-dependent skips.
The full workflow gate ran its mandatory scenarios without skips: 567 Main/Host,
35 shared, 484 Agent-runtime and 295 Rust contracts (two existing ignored cases).
Desktop/document typechecks, runtime build/bundle, integrated editor build and
staging, and Desktop production build passed. Build warnings concern existing
chunk sizes/browser externalization. Evidence and the previous editor resources
are retained in `/home/jhz/deckwise-validation/native-narration-recovery-20261110`.

The running application/session and the original lesson/transcript were not
modified or restarted. Load the rebuilt Desktop/editor resources by restarting
the local development instance after saving its current work. The actual lesson
still needs its page-8/page-9 content aligned with its approved plan; the fix
reports and stops unchanged mismatches instead of silently rewriting pedagogy.
No paid model request, commit or publication was performed.


## Repeated invalid tool arguments after compaction

The 18:09 screenshot corresponds to 43 rejected narration calls between
09:52:15 and 09:54:59 UTC. All failed the `sourceSha256` pattern; tool-call markup
followed the same valid 64-character hash. Thirty-eight calls carried exactly
the same suffix. These calls took 0–2 ms and never entered narration generation.
The final assistant attribution to page-content mismatch does not describe
these failures. Provider output versus adapter parsing remains unproven from
this transcript; no hash truncation or schema relaxation is introduced.

In the installed pi-agent-core, argument validation precedes `beforeToolCall`,
and immediate validation failures also bypass `afterToolCall`. Runtime recovery
therefore observes completed batches in `finishTurn`, before courseware automatic
continuation. The first validation rejection returns concise field requirements
without the echoed malformed payload; a second rejection of the same tool ends
the current run with `TOOL_ARGUMENT_RETRY_EXHAUSTED`. Wording changes, different
invalid fields and unrelated reads do not reset its budget. A successful call to
that tool resets its count; a new user run resets all counts. Other execution
and service failures retain their existing recovery behavior.

A real provider-free agent loop reproduces the original failure using the
actual courseware schema and confirms zero narration Host dispatches and no
model request after the second rejection. Tests also cover successful correction,
independent tool budgets and new-run recovery. The focused runtime/workflow/error
suite passed 486 tests; runtime TypeScript build and bundle passed. This validation
does not use a paid provider or restart the running app. Evidence is retained in
`/home/jhz/deckwise-validation/tool-validation-loop-fix-20261110`.
