# Three-route real generation acceptance — 2026-11-17

This continuation uses new education topics with a strict maximum of six
physical pages per lesson. Each requested lesson has two body pages, one
independent single-choice Quiz and one independent oral activity. The runs use
real managed LLM, Scene image/decomposition and TTS services, not mocked
provider responses. They are assisted acceptance runs, not unattended success
or installer qualification.

| Route | New topic | Target physical pages | Current acceptance |
| --- | --- | ---: | --- |
| PPT Master | Grade 3 Math: rectangle area | 4 | Native visual/semantic review, six real speech clips, fixed build and complete natural playback passed. |
| Scene | Grade 7 Biology: food chains and energy transfer | 4 | Real images/decomposition, native visual/semantic review, nine real speech clips, fixed build and complete natural playback passed. |
| Import | Grade 1 Chinese: Quiet Night Thought | 4 | Real visual review, source/script/audio preservation, fixed build and natural playback passed. |

## Candidate and boundaries

- Dirty request worktree `feat/courseware-stage-aware-scene`, based on
  `5cbd7cb44de14d6cb5f1e478ff9f57b63bd7d05d`, Desktop v0.20.5.
  Main, Agent Runtime and Host were rebuilt. Native Office resources remain
  pinned to Document revision `6f5c90f4860f45650422c581a2f96e2f20b55b6e`.
- The isolated candidate, real task receipts, private transcripts, native
  documents, provider assets and test controllers are retained at
  `/home/jhz/deckwise-validation/three-path-live-20261117`.
  Credentials and private transcripts are not copied into this report.
- Task creation, plan/style approval, source attachment, teaching writes,
  warning review and fixed builds use existing Desktop IPC and agent tools.
  The operator reviewed generated images and Master previews and supplied
  layout feedback. Existing schema, source CAS, script/audio protection,
  provider intent identity and retry budgets remain enabled.
- Playback uses the current production player against the actual fixed-build
  package. It observes natural audio `ended` events without seeking, visible
  effects, incorrect/correct Quiz feedback and teacher continuation. The
  import source is a real, locally authored two-page editable PPTX fixture;
  it is not claimed as model-generated content.
- Neither platform publication nor external synchronization is performed.

## Shared visual-review wiring repair

Real validation exposed a missing caller connection:
`createCoursewareDocumentRuntime` constructed `CoursewareCandidateCoordinator`
without its redo interface. Narration then derived its optional vision callback
only from that absent interface. Both foreground and background document-tool
runtimes could therefore fall back to text/object review despite having an
authorized vision completion callback at the IPC owner.

The coordinator now accepts that existing callback independently of redo;
document-runtime creation passes `input.completeScene` through to narration.
The existing redo caller retains its fallback. No new model client, provider,
workflow state or approval gate was introduced. The shared semantic reviewer
still preserves saved words/audio and blocks invalid or uncertain responses.

A regression test exercises the real runtime/coordinator seam for foreground
and background documents. It failed before the wiring change and passes after
it. Targeted narration/batch/inspection tests: **129 passed**, zero skipped;
Desktop typecheck and build passed. Two older narration fixtures were updated
to answer the semantic-review request and to test a genuinely invalid object
target rather than a now-permitted leading wait.

Earlier gates on the current task changes also passed: **214** Desktop
narration/native/delivery/online teaching tests and **36** Host Scene image
tests. These counts overlap the targeted suite and must not be summed as
distinct test cases.

## Import acceptance

The source's original two pages remain at physical positions 1 and 3. A
separate package audit confirms all six original text shapes preserve text,
formatting and geometry, normalizing only Office-added default `bwMode=auto`
and empty run/end-paragraph property nodes. The approved `preserve` script is
unchanged, and all four audio asset IDs match those saved before the visual
recheck. No successful audio was regenerated for that recheck.

Both body pages passed model review using actual native page PNG evidence.
Their effects target the title/poem text, not empty background shapes. Fixed
build `4eeac1ce540751848695aea80a5b9d14464d3dc058fc850a70be566bc9e59f38`
has four pages and four real speech clips (10.032, 6.456, 9.648 and 2.664
seconds). Playback reached all pages, naturally ended all four clips, observed
highlight/spotlight/fade effects, checked one incorrect and one correct answer,
and continued the oral activity. No browser errors were observed.

The sole converter warning, `PPTX_NOTES_MASTER_UNVERIFIED`, was explicitly
reviewed through the existing warning-approval IPC. Notes-master layout
fidelity is not claimed. The generated Quiz title is wordy; its question and
answer behavior passed.

## Observed interruptions and recovery

- The initial managed model returned 503/no upstream and 429 frequency errors;
  an existing configured model alias was selected through session settings.
  Later 502/timeouts remain recorded rather than relabeled as code success.
- Scene narration rejected unknown object targets. A layer's name/alias is
  not its saved `object-...` UUID. Invalid semantic JSON and timed-out model
  calls left drafts unsaved. Existing repair limits were retained; subsequent
  explicit continuation resumes saved work without repeating image jobs.
- The test launcher initially pointed at development worker output whose
  manifest no longer matched after rebuilding. Formal `stage-worker.mjs`
  produced a consistent worker/authoring/dependency/manifest directory, and
  the isolated app was restarted with that directory. No hash check was
  disabled or manually patched. Import fixed build then passed.
- Native capture/build requests are serialized under their selected session
  and workspace. A capture without opening the visible document and a build
  canceled by a simultaneous session change are retained as test-controller
  mistakes, not product acceptance results.
- Qwen's Master attempt added an unrequested `speechCount:1`, which conflicted
  with separate focus targets, and returned invalid/Markdown-wrapped JSON.
  Existing limits stopped the unchanged pages. Its assessment calls also used
  invalid parameters. The operator selected existing GPT configuration and
  corrected that extra constraint; this is assisted recovery, not evidence of
  an automatic model failover feature. These failed outputs remain retained.

## PPT Master acceptance

The official Skill generated two editable body pages and two structured
activity pages. Operator preview feedback corrected covered text, the first
page's accidental extra grid column, and the missing area unit before export.
The official validation/export/adoption gates passed; export/adoption were not
repeated after successful binding.

GPT, selected from the existing configured models after DeepSeek service
failures and Qwen schema failures, generated and saved both body pages with
real native PNG observation and semantic review. Each page uses two short
speech blocks so grid focus/entrance and conclusion/formula highlight can
retain separate real targets. The user did not impose an exact speech count.
All six speech clips are real and their archived bytes match declared SHA-256.
Measured body speech is 19.344 and 24.528 seconds: the second exceeds the
approximate 20-second plan target, but both meet the explicit 35-second
ceiling. Activity readings are 11.256 and 3.864 seconds.

A subsequent content audit found an inaccurate distractor explanation:
the generated answer analysis described 8 square centimetres as omitting the
width. The operator corrected only that sentence to explain addition instead
of multiplication through the existing classroom-write IPC with current
source/revision checks. All speech/audio IDs and other pages were verified
unchanged; no paid media was regenerated. The final package contains the
corrected analysis.

Final build `549448563029e4fcb1fb8d8cea52f9fff6fdbd0d934aeabf16f415be4f034c98`
reached all four pages and naturally ended all six speech clips. Highlight,
spotlight and animation visibly ran; wrong/correct Quiz feedback and oral
teacher continuation passed without browser errors. The notes-master warning
was explicitly reviewed as on Import. Unbound descriptive aliases for grid
details remain advisory; real page geometry and essential teaching content
were reviewed without requiring every square/formula phrase to have its own
independent object.

## Scene acceptance

The two actual visual masters use a restrained junior-high biology illustration
style. The first shows grass → grasshopper → frog → snake; the second shows
grass → rabbit → eagle with producer/consumer labels. Names, arrows and all
body lettering were generated inside the raster images. Plan approval and
first-image style approval used the existing explicit gates, followed by
official generation/decomposition and native compilation. Successful image
jobs were not resubmitted during narration recovery.

Both body pages passed real native PNG observation and semantic review using
GPT. The approved narration is preserved character for character after
sentence splitting. A separate package audit confirms the compiled document's
17 archived PNGs remain byte-identical through teaching/media saves. The two
body slides contain eight and six picture elements respectively and **zero
native text runs**; editable question pages remain separate. This checks the
raster-first boundary, not exact visual equivalence between a master and every
decomposition result.

All nine real speech clips are archived and SHA-256 verified. Speech durations
by page are 14.712, 8.040, 12.168 and 2.664 seconds. Both body pages contain
animation, spotlight and highlight cues with valid current object IDs. The
actual playback screenshots show the arrows after their entrance, focus on
the explained snake, and highlighted arrow/label carriers. Entrance targets
are intentionally hidden in the idle preview before playback.

Final build `7da9d8ff5c0daeb3abc582e4b7fc78b7815d673e98665bcfa70d191bb75419b4`
reached all four pages, naturally ended all nine clips, observed all requested
effect categories, checked wrong/correct Quiz feedback and continued the oral
activity, without browser errors. Existing Desktop playback IPC also opened
the actual player window and rendered the first page. Its empty alert region
is not an error; a preliminary probe incorrectly counted that empty region,
then was corrected to inspect actual alert text. The notes-master warning was
explicitly reviewed through the existing approval endpoint.

## Persistence, artifacts and evidence

After all three routes finished, the isolated application was fully stopped
and restarted. Each real native PPTX was reopened. Projects, actions,
enrichment, requirements and source SHA-256 values match their pre-restart
captures exactly: six, nine and four audio bindings survived for Master,
Scene and Import. No generation or repair was invoked during this check.

The final three PPTX copies are under
`/home/jhz/deckwise-validation/three-path-live-20261117/deliverables`.
Their hashes match the tested immutable snapshots. The test app was stopped
after validation, the primary login was conditionally preserved, and isolated
refresh-token copies were removed.

- [Summary and artifact paths](summary.json)
- [Source/binary fingerprint](candidate-fingerprint.json)
- [Real semantic-review receipts, including pre-fix versus PNG evidence](semantic-review-results.json)
- Playback: [Master](master-playback.json), [Scene](scene-playback.json), [Import](import-playback.json)
- Source/media audit: [Master](master-package-audit.json), [Scene](scene-package-audit.json), [Import](import-package-audit.json)
- Restart/reopen: [Master](master-reopen.json), [Scene](scene-reopen.json), [Import](import-reopen.json)
- Preservation: [Scene image/script bytes](scene-preservation.json), [Import original text/script/audio](import-preservation.json)
- [Scoped answer-analysis correction](master-analysis-correction.json)

Completion receipts are source-bound. Master's `master-completion.json`
precedes the isolated answer-analysis correction; the final source is qualified
by its subsequent fixed build, package audit and playback. The correction's
separate audit confirms speech/audio and peer pages were unchanged.

## Remaining qualification

This closes the requested new three-route, at-most-six-page acceptance, with
the assisted recovery described above. It does not establish unattended
first-pass reliability: upstream 502/503/429, timeouts and invalid model output
remain observed failure modes. Actual provider billing was not audited; some
operation usage includes estimates, which are not invoices.

P1's eight redacted historical incidents remain unattributed; current
reproducible failures do not identify those historical causes. The broader P7
matrix still includes multi-stage visual accuracy and arbitrary large-deck
provider interruptions. New installer qualification, platform publication and
deployment are also outside this small-lesson run.


## Subsequent generation-recovery changes

The [follow-up repair record](generation-recovery-fixes.md) documents the bounded
review recovery, exact object references, accepted-unit evidence and final saved
content review added after these three live lessons. Its automated checks are
separate; the real lesson results above do not qualify the new final reviewer.
