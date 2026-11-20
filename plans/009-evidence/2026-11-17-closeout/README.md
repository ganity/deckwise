# Plan 009 local closeout — 2026-11-17

This closes the requested local repair and small-lesson verification round. It does **not** close every P1/P7 qualification item or establish unattended reliability. These are fresh lessons in new workspaces, separate from the earlier paid failure and assisted recovery records. Scene required one explicit continuation after a no-progress stop; that interruption remains part of this result.

## Result

| Route | Fresh topic | Physical pages | Real speech clips naturally ended | Final content review | Full process restart and native reopen |
|---|---|---:|---:|---|---|
| PPT Master | Grade 3 mathematics: rectangle area | 4 | 10 | Passed; no final repair applied | Passed |
| Scene | Grade 7 biology: food chains and energy transfer | 4 | 14 | Passed; no final repair applied | Passed |
| Import | Grade 1 Chinese: Quiet Night Thought, original two-page deck and final script | 4 | 4 | Passed; no final repair applied | Passed |

All three actual player runs visited every page, allowed every audio clip to end naturally, checked a wrong and correct choice, completed the teacher/short-answer activity, and observed fade animation, highlight and spotlight. There were no player errors. Short-answer completion is teacher/ungraded behavior, not proof of automatic grading. Every lesson is below the six-page cap, including independent activity pages. Body speech duration is below the requested 35 seconds.

The full Electron/Host process was stopped and restarted. Each lesson was reopened through the native teaching API; exact source SHA, saved actions, audio bindings, assessment data and enrichment matched the pre-restart baseline. Readiness reads waited for the editor to finish opening; no generation or paid review was repeated during this check.

## Narrow repairs included

1. **Scene arrows remain teachable foreground.** Host and local fallback decomposition prompts now preserve connecting arrows/flow lines, either with the diagram or as independent targets. Final content review checks full diagram coverage rather than accepting its title as a proxy. The fresh images contain five arrows, all extracted from the clean plate. Saved fade-in and spotlight cues cover all five, and combined whole-diagram cues cover 11 foreground targets on page 1 and eight on page 3. Actual whole-chain spotlight was also visually inspected. Text, labels and diagrams remain image-model pixels; no editable reconstruction was added.
2. **A failed required narration repair cannot disappear behind broad review.** Native tools retain semantic/required-content repair failures by session, project and page for the current runtime. A passing final review or a successful peer-page save cannot clear them. A successful replacement for the affected page clears its entry. A regression first failed before this change and passed afterward.
3. **Companion editor delivered as part of the candidate.** Earlier audio-adoption, title/reference persistence, key-point preservation and response-specific hint fixes are present in the staged editor bundle. [Delivery instructions](delivery.md), [candidate hashes](candidate.json), and the exact [five-file editor patch](editor-companion.patch) identify the matching source. Desktop alone with an older editor is not this tested candidate.

The repair-failure guard is **runtime-local**. It does not persist through runtime recreation or application restart. Reopening still requires current-source verification and final review; this round did not prove that a previously failed required repair remains blocked after recreation. That P1 continuity case remains open. No new state store, workflow engine, retry allowance or bypass was introduced.

## What happened during generation

- Master hit two SVG validation failures (missing module bounds, then overlapping bounds) and a stale browser element reference. The Agent corrected/retried them within the normal flow. Preview approval remained explicit.
- Scene first tried to read a plan that did not exist, then twice submitted a plan violating the existing rule that Quiz pages belong between related body pages. The Agent corrected the plan; the existing gate was retained. Plan and representative-image review/approval remained explicit, with image status/archive checks through supported APIs.
- During Scene teaching, 12 body TTS requests and the original choice-question request existed, but the Agent had not saved them back. After ten minutes without saved progress, the runtime stopped and reported incomplete work. One explicit continuation adopted those original results and generated only the previously unsubmitted short-answer reading. No successful image or original TTS request was repurchased. This is a fresh lesson with assisted continuation, **not** a zero-interruption generation pass. The stop protects against indefinite work; the sample does not establish a broader root cause or a fix for all such stalls.
- Import completed with no recorded tool-error result. Original six text shapes retained text, geometry and style; both supplied scripts remained verbatim and correctly mapped after activity insertion. Final learner-facing titles, references, analysis, short-answer key points and hint were verified.
- No operator rewrote lesson content, a source slide, a script or a reference answer in this fresh round. Operational approvals, the Scene continuation and playback input were supplied. The fixture's existing `PPTX_NOTES_MASTER_UNVERIFIED` warning was explicitly accepted; notes-master layout fidelity is not qualified. Full transcripts remain local rather than being copied into the repository.

## Evidence and reproducibility

- Each route directory contains `playback.json`, `persisted-audit.json`, `final-content-review.json` and `restart.json`. The persisted audit checks embedded media hashes and ffprobe durations; it is not itself an acceptance verdict.
- [Scene arrow coverage](scene/arrow-coverage.json), foreground contact sheets, clean plates and [actual spotlight](scene/whole-chain-spotlight.png) support the specific decomposition/effect closure.
- [Import preservation](import/preservation.json) lists serialization-only exclusions: exported numeric shape IDs, explicit default `bwMode=auto`, empty run properties and root identity transform. Shape text, geometry and style remain compared; final scripts are exact strings.
- The local isolated run and executable verification scripts remain at `/home/jhz/deckwise-validation/three-path-closeout-20261117`. `audit-persisted.py`, `verify-scene-arrows.py`, `verify-import.py`, `live-playback.mjs` and `reopen-check.js` provide independent persistence, effect, player and restart checks. Playback consumes the saved fixed build, without provider access.
- New targeted checks: Desktop native/review/layers **85/85**, Host Scene **36/36**, Desktop typecheck/production build, Host release build, Rust format and whitespace check passed. Logs are included here. The previously verified companion editor bundle inventory covers 2,858 files; its exact patch passes reverse-apply validation against the editor worktree. Earlier editor 44-test evidence is retained in the [recovery record](../2026-11-17-recovery/README.md); overlapping test counts are not added together.

## Remaining scope

P0 and P2–P6 implementation is complete for the documented scope. P1 remains partial for redacted historical incident attribution and failed-repair continuity across runtime recreation. P7 now includes three fresh small-lesson artifacts and restart/playback evidence, but broader stage/subject visual coverage, paid large-deck interruption/stress tests, and a matched comparison against par-A are not qualified. Three samples do not prove a success-rate improvement over par-A.

No commit, merge, push, installer release, external sync or platform publication is claimed. Existing full documentation-build dead links outside this task remain unqualified. The isolated runner is closed and its temporary auth copy is removed after preserving the latest valid primary credential; completion is recorded in `cleanup.json`.
