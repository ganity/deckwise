# Remaining Greetings workflow fixes — 2026-11-01

## Scope

Recovered Codex session `01a18828-58b2-7652-b9f6-84cc60334c72` and the
[last live-run findings](2026-11-01-greetings-systemic-rerun.md). Continued in
`feat/courseware-par-A` at `1ff749805`, retaining its pre-existing uncommitted
work. This delivery changes the source workflow; the original portable lesson
and running user application were not modified. No commit, push or paid
provider request was made.

## Fixes and evidence

| Remaining problem | Implemented behavior | Regression evidence |
| --- | --- | --- |
| Invalid plan reported ready | `courseware_scene_plan_submit` runs the existing product validator. Runtime validates detected scene-plan writes before accepting a closing report; invalid drafts get two corrections, then an honest unfinished report. Success remains a draft for the existing human review. The bundled scene skill and deferred discovery include this transition. | Invalid visible-question plans cannot become validated drafts; valid submission neither approves the plan nor generates media. |
| Ready course repeatedly read and compacted | An authorized complete-course run recognizes Host readiness at the media tool-result boundary, verifies its saved source/revision and acceptance, and enters final reporting immediately. Report turns advertise no tools and retain the execution fence. Model-visible media status omits full plans, actions and speech text; page-scoped narration reads retain details. | Real Runtime with deferred tools, a 338,000-character internal payload and a model that insists on more status reads: one media-context dispatch, three model requests, no tools on the final request, one terminal event. Full internal evidence remains available without entering the model-visible content. This tests prevention of the repeated large-payload path, not a new live automatic-compaction run. |
| Sixteen page-six focus omissions | Character pictures and their name labels no longer cause false ambiguity. Explicit matching targets survive; genuinely duplicated pictures remain ambiguous. The preserving repair path adds only missing safe focus and resolves timing from verified existing audio in Host. | All sixteen captured speech texts gain focus without text/audio changes. A real temporary Host DB adopts a 1,234 ms original audio, repairs its cue with that duration, preserves existing speech fields, and rejects stale writes or cue replacement. |

The first three narrow regressions failed before their fixes: oversized media
content, no terminal transition at a ready tool boundary, and a missing target
when a character shared its name with a label.

## Validation

Shared and Runtime builds passed. Shared, Runtime and Desktop typechecks passed.
The changed tracked files pass `git diff --check`.

`node scripts/check-courseware-workflow.mjs` passed with zero provider calls:

| Check | Result |
| --- | --- |
| Current Host build | Passed |
| Main/Host workflow boundary | 414 passed, zero skipped |
| Shared contracts | 27 passed, zero skipped |
| Runtime gate | 420 passed, zero skipped |
| Host project DB/RPC | 251 passed, 2 existing optional cases ignored |

The final Runtime build and the same seven Runtime suites were rerun after
adding the explicit failed-submit boundary case: **421 passed**. This also
covers validation failures where the Runtime did not observe the earlier file
write. The initial gate found two old recovery assertions expecting no final
report on completion; they now require the completed report and reporting fence.

Gate evidence: `/tmp/deckwise-workflow-gate-5Mr5CB/report.json` and adjacent
per-stage logs. The gate preserved concurrency peaks TTS 10, images 5,
layers 5, music 2, export 2 and video 2. The ignored Host cases require the
existing opt-in locked-image and portable-parser fixtures; the new focus repair
test executed successfully.

The repository's Biome include list excludes these Runtime files; no Biome pass
is claimed. Whole-tree whitespace checking still reports the pre-existing extra
EOF blank line in untouched `courseware-video-placement.ts`.

## Limits

Structural plan validation cannot establish arbitrary natural-language fidelity.
Exact requested song names and page placement must still be checked in the
normal human plan review; submission never bypasses that approval.

No fresh paid ten-page run, packaged application acceptance, full playback or
audio listening was performed. The existing portable lesson still contains its
historical focus omissions until repaired through the updated application.
Matching rebuilt Desktop/Runtime/Host components must be loaded to use the fix.
