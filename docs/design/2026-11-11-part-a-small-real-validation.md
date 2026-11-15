# Part A small real-courseware validation — 2026-11-11

## Verdict

All three small real routes were exercised. Overall acceptance FAILED. Import preserves original pages and plays, but its Quiz is ambiguous/wrong. Scene saves/reopens with audio but fails the actual player build. PPT Master saves/reopens with only 9/10 speech audio assets and cannot build. No failed output was silently repaired to make this report green.

## Test method

- Fresh Electron Main/preload/renderer, agent-runtime sidecar, MAIC editor bundle, and complete PPTX worker staged from the current Part A worktrees. An existing Host binary was copied; it was not rebuilt. Build hashes are in `build-fingerprint.json`.
- One isolated app profile/data directory, separate workspace and conversation per route. Normal user documents were not used as write targets. Real managed DeepSeek generation, real scene image services, and real Doubao speech synthesis. No generated result or media response was mocked.
- Playwright drives the actual desktop app through its existing UI/IPC. The only file-picker stub selects the known real PPTX fixture; it does not stub import or editing. Planning/style/export confirmations are operator actions and are recorded.
- Save the actual PPTX, close and reopen it, compare teaching/page state, independently inspect embedded teaching/audio payload hashes, then build the real immutable player package and run browser playback. Successful playback requires natural completion of every speech, answering the Quiz, and continuing the oral activity. These playback assertions do not establish that the Quiz itself is correct.
- The final saved PPTX is preserved even on failure. Model tool failures, corrective turns, and operator actions remain in each route's transcript and operator.ndjson. Passing individual checks does not override a content or playback failure.

## Cases and current evidence

| Route | Small real input/output | Structural/audio/reopen checks | Actual player | Acceptance |
| --- | --- | --- | --- | --- |
| Import | Two original pages extracted from real `鲁雅迪《影子》.pptx`; two independent activity pages added, total 4 | 11/11 embedded audio payloads; original page IDs/order retained; no question checkpoints on the two originals; saved and reopened | 11 speeches ended naturally; Quiz answered; oral continuation; spotlight/highlight/animation observed; no player errors | FAIL: Quiz assumes shadow is behind the body without specifying light direction |
| Scene | One generated Circle body image/layers, Quiz, oral interaction; total 3 | 9/9 audio payloads; distinct activity pages; saved and reopened | Build FAIL: `ANIMATION_TARGET_CONFLICT`; playback was not reached | FAIL: completion ready does not imply buildable; old/new effect repair cues conflict |
| PPT Master | One native vector Circle body, Quiz, oral interaction; total 3 | 9/10 speech audio; distinct activity pages; saved and reopened | Snapshot import FAIL: speech requires a fixed audio asset; playback was not reached | FAIL: oral question audio missing; media-context error ends with no user explanation |

The import shape audit compares shape trees, text, image content hashes and geometry. Save changes shape numeric IDs and rounds one coordinate by 1 EMU. All other recorded content/geometry/image fields match. This is not a claim of pixel-identical rendering. See `import/original-page-comparison.json`.

## Findings requiring product work

1. **Wrong generated answer can pass source mapping and readiness.** The import Quiz asks which side a shadow commonly appears on in daylight and marks “behind” correct without specifying where the light is. Adjacent generated narration correctly says the direction depends on the sun. Exact evidence/mapping validation is not factual validation. The generated source plan itself included the unsupported answer. See `import/manual-findings.md`, `carrier.json`, `transcript.json`.
2. **Effect repair appends conflicting entrances and preserves an obsolete target.** In the scene output, the same red-circle object receives fadeIn in two speech actions. Repair preserves the old cues and adds new ones. Save/readiness accept them, while the immutable player enforces whole-page entrance/emphasis/exit sequencing. See `scene/manual-findings.md`, `fixed.log`, `carrier.json`. No source fix is claimed by this test report.
3. **Readiness is narrower than playability.** Scene completion.ready/teachingReady/audioReady were true, and all audio was present; the subsequent real build still failed. Acceptance must run the build boundary, not trust these flags alone.

4. **Assessment-only narration returns a misleading batch failure.** The Master run retried narration six times on existing assessment pages, receiving “Not started after an earlier batch failed” rather than a useful no-generation-needed result. The real result remained question-only speech, as intended; the repeated attempts and bundle-code investigation wasted time. See master/transcript.json.
5. **Partial completion can terminate without explanation.** Master saved 9/10 speech audio clips, then media context returned a generic workflow error and the turn ended with an empty assistant message. The missing clip is the oral question on page 3. The exact media-context exception cause remains unproven because the response omits it. See master/missing-audio.json, manual-findings.md and fixed.log.

## Actual native editor readback

Each final PPTX was opened in the real staged WiseOffice editor, teaching sidebar opened through its real control, and every page selected. Import showed lecture / Quiz / lecture / classroom interaction; Scene and Master showed lecture / Quiz / classroom interaction. Body pages retained lecture controls. Master page 3 displayed “尚未生成语音”; page 2 displayed ready audio. Screenshots and sidebar-readback.json are preserved per route. No claim that merely checking carrier JSON proved the UI.

## Observed durations

- Valid import turn: 12:40:34–12:43:31 UTC, about 3 minutes, before separate reopen/playback verification.
- Scene: 12:43:58–12:55:40 UTC, about 12 minutes INCLUDING test-operator session-switch interruptions/continuations; unsuitable as a clean performance benchmark.
- Final sequential Master: 12:57:15–13:09:54 UTC, about 13 minutes including preview work, review/confirmation wait, and six redundant assessment narration attempts. It still ended incomplete.

These timings do not include the earlier fixture/build/staging failures and must not be represented as clean model/service benchmarks.

## Test-harness failures and interventions

These are retained separately and must not be presented as product failures or silently excluded successful attempts:

- First shortened PPTX fixture was malformed by the test's XML rewrite. Replaced with a valid extraction preserving original XML namespaces and removing unselected slide parts. Original source PPTX was unchanged. See `fixture-correction.json`, `import/fixture-failure/`, and the preserved invalid test copy.
- The initially selected resource worker lacked Sharp. Staged the complete worker with repository staging/check scripts and started a fresh import session. The aborted model had tried to repair dependencies; that attempt is retained in `import/packaging-failure/`. The valid import run had no corrective operator prompts.
- The configured PPT Master distribution directory did not exist. The model could not load its skill and explored the filesystem. Staged the pinned official package using prepare-ppt-master.mjs, corrected the isolated app environment, and created a fresh clean session/workspace. See `master/missing-skill-fixture-failure/`.
- The harness tried parallel route preparation by changing the active conversation while scene generation was in flight. This changed editor ownership and contaminated the scene automation observation. The harness then aborted the parallel preparation, restored the scene editor, and sent natural-language continuations. No claim of uninterrupted scene success is made. A second interrupted Master attempt is retained in `master/operator-interrupted-run/` and its workspace. The final Master run is sequential.

## Scope limits

This is a bounded three-case real smoke test, not coverage of every imported deck, attached lesson-plan/script combination, native animation, manual-edit race, cancellation, theme, or page count. No claim that the 56-page user deck is fixed follows from these small cases. No application source was changed for this verification pass. Evidence and actual outputs are stored here so the failures can be reproduced without overwriting them.


## Cleanup

Isolated test app/Host/agent runtime and the two test preview servers were stopped. Copied test authentication token removed; the user authentication file hash remained unchanged. See cleanup.json. Original input PPTX and session transcript were not modified.

Evidence directory: /home/jhz/deckwise-validation/part-a-small-real-20261111
