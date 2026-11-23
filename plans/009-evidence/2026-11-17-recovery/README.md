# Three-route recovery after the paid rerun

This run repairs existing four-page paid courses. It is not fresh autonomous generation and is not a matched par-A success-rate comparison. No image regeneration was requested. Successful media and original imported scripts remain protected.

## Changes

- Authoritative native non-image text replaces conflicting OCR text and aliases without an extra observation request.
- Generation, binding repair, saved attention and the embedded editor's audio adoption now accept the existing player bound of 200 distinct verified targets. The native editor initially retained a separate eight-target guard; the real recovery reproduced that additional consumer failure, which is now fixed and covered by audio-adoption tests. Native animation count/timing and target eligibility checks remain.
- Generated activity titles use the learner question; plan titles remain metadata. Short-answer and multiple-choice instructions follow the actual question type. Default objective reference answers use selected options rather than plan evidence.
- Saved-content review can correct generated Quiz titles, objective reference answers and analyses, then refresh evidence and re-review. Original imported, locked and read-only pages remain protected.
- Real recovery exposed two missing title-write steps: Desktop ignored title-only changes when building changedPageIds; the embedded editor failed to retain the new title in checkpoint.chapterTitle. Both are fixed with regression tests at their actual writer/reader boundaries.
- Reviewer format repair has its own bounded counter. Exhausted non-retriable review errors no longer fall through to outer draft regeneration.

## Real evidence so far

Master passed final content review and full fixed-player playback: four pages, fourteen naturally ended audio segments, all required effect types, wrong/correct choice paths and teacher continuation. Its original eight audio assets and three already successful page-action lists are unchanged. Six new first-page audio assets were adopted; first-page speech is 15.936 seconds. Second-page speech remains 22.632 seconds under the explicit 35-second ceiling.

Scene re-adopted the original generated first-page audio task without a replacement submission. All twelve saved audio assets decode and the actual player naturally ends all twelve across four pages. Highlight, spotlight, entrance effects, wrong/correct choice paths and teacher continuation pass. The original eight audio hashes are unchanged. This is **not full Scene effect acceptance**: page 3's two lower connecting arrows are baked into its background (`ppt/media/image16.png`), not any of its eight foreground pictures. Existing target-based effects cannot animate these background arrows independently. The stricter repair rejected that gap; final content review subsequently returning ready does not erase it. See `scene-effect-gap.json` and `scene-page3-background.png`.

Import recovery exposed further native persistence problems: response object key order incorrectly invalidated adopted audio, omitted legacy canonical keyPoints cleared the checkpoint's existing reference points, and upgraded previous/next templates concealed stale actual on-slide hints. The writer, projection, legacy analysis repair and regression tests now cover these cases. The lost original reference point was restored from the pre-run backup through the formal revision-checked classroom API; this intervention is explicitly operator-assisted. Final real saved-content review passes with no issues and no additional changes. The reopened source, verified physical titles/hint/reference/analysis and actual player build have the same source hash. All four original audio assets are unchanged and naturally finish; all required effect types and wrong/correct choice paths run. The short-answer path displays the ungraded teacher-review state and completes; no automatic short-answer grading is claimed. Original body-page text, geometry, style and speech actions are preserved (exporter-generated numeric shape IDs are excluded from XML comparison).

## Authentication and candidate checks

User sign-in restored authentication and real review resumed. The runner now snapshots the primary token on each launch and never overwrites the isolated token during restarts. Graceful shutdown preserves rotated credentials only if the user's primary token is unchanged. The earlier login block was a test-harness failure, not a courseware-generation or quota diagnosis.

Final Desktop typecheck and production build passed. The editor production build passed; its 44 targeted native/projection tests passed. The latest Desktop recovery suite passed 95 tests; the final 24 content-review tests passed after fixing stale checkpoint snapshots. Review now refreshes saved checkpoint actions after a correction and checks assessments before adjacent body pages, preventing a repaired answer from remaining in the review context. This failure was reproduced before the fix. Desktop typecheck/build were rerun successfully afterward. Earlier baseline checks remain separately recorded in `local-checks.json`; overlapping counts must not be added. Candidate source and bundle hashes are in `candidate-final.json`.

## Delivery scope

Desktop worktree: `courseware-stage-aware-scene`. Required editor source changes are in `/home/jhz/code/train/document-worktrees/courseware-par-A-playback/lib/deckwise-native-teaching.ts`, and `lib/agent-plugin/slide-quiz-projection.ts`, with native carrier/projection tests and documentation in the same worktree. The updated editor was built and staged into Desktop resources; its previous development bundle is retained under the validation directory. Both source changes must accompany a release; this is not installer/release qualification.

Original artifacts and full run evidence: `/home/jhz/deckwise-validation/three-path-recovery-20261117`. No changes were committed, published or deployed.

## Remaining qualification gaps

- Scene page 3 background-arrow effects remain unfinished; do not present these three recovered lessons as three fully accepted fresh generations. The next repair belongs at decomposition/target coverage: retain required arrows as targetable layers or support a verified image region through the existing effect contract. Do not fabricate object identities or rebuild the scene as editable text/charts.
- Final LLM review can still disagree with a stricter earlier effect review. The Agent reported the known gap explicitly; a ready flag alone is insufficient acceptance evidence.
- This run is operator-assisted recovery, including restoration of one original reference key point, not a measured autonomous success rate or proof of superiority over par-A.
- Editor and Desktop source changes must land together. No installer, platform publication or new origin/main integration qualification was run.
