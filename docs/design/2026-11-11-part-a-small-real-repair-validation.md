# Part A real-courseware repair verification — 2026-11-11

The earlier small real matrix failed and is preserved in
[the original report](2026-11-11-part-a-small-real-validation.md).
The follow-up uses the existing Part A worktrees with real services, original
editable PPTX files and actual fixed-player playback.

Evidence and the detailed report are stored at
`/home/jhz/deckwise-validation/part-a-repair-real-20261111/REPORT.md`.
The report distinguishes recovered cases from fresh generation and records
operator corrections, failed attempts, source/build fingerprints and limitations.

Root fixes include initialization ordering for native opens/reads, exact focus
replacement with retained paid audio, reconciliation of obsolete native animation
mirrors, retained assessment question reading, source-grounded activity review,
Chinese paragraph paraphrase matching and precise visual-format repair feedback.

A further fresh scene run exposed loss of `teaching.requiredEffects` in the Main
scene-plan normalizer. Rust retained the approved field while Main omitted it
from both the page hash and compiler requirements. The attach boundary correctly
rejected the mismatched hash as `Generated scene object mapping changed`.
Main now retains the optional field in the same order as Rust. Cross-language
regressions assert the same SHA-256 page hash; a change to required effects changes
the hash. Existing approved asset files can be reused after this parser fix.


## Actual successful artifacts

| Path | Artifact case | Physical pages | Real speech completed |
| --- | --- | ---: | ---: |
| Scene | `scene-clean/final.pptx` | 3 | 8/8 |
| PPT Master | `master/final.pptx` | 3 | 12/12 |
| Real PPT import | `import-clean/final.pptx` | 4 | 15/15 |

These artifacts passed save/reopen equality, embedded audio hash/length checks,
independent activity-page checks and actual immutable-player construction and
playback. Playback naturally completed every speech segment, exercised wrong and
correct Quiz feedback and oral continuation, and visibly observed spotlight,
highlight and animation without page errors. The imported original two slides
retain text, image bytes and shape geometry (within 1 EMU); the Quiz and oral
activity occupy new physical slides rather than replacing either lecture.

The scene artifact is a fresh generation recovered by a normal continuation after
the parser fix, reusing approved paid images. Import initially omitted spotlight;
a normal Chat correction added it while preserving speech/audio. Master received
a Quiz title correction during normal preview review. All three are functional
small-case successes with disclosed interventions, not unattended first-pass or
56-page acceptance. Failed artifacts/transcripts remain in the evidence directory.
An additional recovered scene artifact verifies the native zoom-to-fade repair
preserves paid speech/audio, including real SDK Undo/Redo and native save/reopen.

## Validation

Relevant Desktop tests (185), runtime tests (105), visual-repair batch tests (67)
and native teaching unit tests (36) passed. Paired scene-plan parser/Rust regression
tests verify retained required effects and identical hashes. The real SDK native
motion replacement/removal regression passed with Undo/Redo, save/reopen and audio
preservation. Desktop/runtime/editor type checks and relevant builds passed.
The detailed evidence report records individual commands/logs and build hashes;
the counts above overlap where suites were rerun and must not be added together.

Remaining acceptance scope: larger decks, released Windows/macOS packages,
external Office round trips, broader pedagogical quality, music/video and the
full range of native animations. No release or clean-merge approval is implied.
