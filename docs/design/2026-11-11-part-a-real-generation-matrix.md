# Part A: real generation matrix, 2026-11-11

## Result

All three routes were exercised with new courseware and real services. The import route was split into four attachment conditions, giving six cases. All six produced saved native PPTX teaching carriers and complete narration audio. Five could build and play; one was blocked before playback. This is **not an all-green acceptance result**.

Correction during follow-up: the original visible-language auditor omitted grouped text. Master also contains Chinese helper copy, so its original all-green machine audit was incomplete. Original evidence files are preserved. PPT Master passed the original limited functional audit after operator guidance, but does not satisfy full-English acceptance. Scene and import cases exposed missing effects, an unresolved attention intent, activity type/reference-answer drift, and English-mode template copy gaps. No product source was changed to make these tests pass.

Evidence root:

```text
/home/jhz/deckwise-validation/part-a-real-matrix-20261111
```

The authoritative consolidated evidence is `results.json`; each case has `artifact-audit.json`, `saved.json`, `carrier.json`, `final.pptx`, `transcript.json`, `operator.ndjson`, and `restart-check.json`. A model's completion message is not used as proof of success.

## Candidate and environment

| Item | Tested state |
| --- | --- |
| Desktop worktree | `deckwise-desktop-worktrees/courseware-par-A` |
| Branch / HEAD | `feat/courseware-par-A` / `7706042fe0f919b2a0642a3bb37ce7bfcffc5703` |
| Candidate tree | Includes the existing uncommitted Part A changes; not a clean-commit result |
| Document worktree | `document-worktrees/courseware-par-A-playback` |
| Document HEAD | `b5a0a626` |
| Main-process bundle SHA-256 | `ff66c66fed918838d20eb6f7ba2cd21a42862fde3f9ec0f85c05ba62d4cacdb3` |
| Host executable SHA-256 | `93b4561b01e7f14ecdc143c970ee7a3f28ce31fd5b837ecc12ade31052605034` |
| Runtime sidecar SHA-256 | `e5d2ba10afbb49110f00165c3eb73d3054b487840a1aeed4ee7e1fc4f820a49d` |
| Editor manifest SHA-256 | `8a82412fb64fb10cae17bbcc8d948d31c98d01298d6ab4802f6d90c6f04d385a` |
| LLM | Managed `deepseek-v4-1-flash` |
| Scene images | Real scene-master / scene-layers services |
| TTS | Real `doubao-tts`, voice `zh_female_yingyujiaoxue_uranus_bigtts` |
| Native editor | Current staged WiseOffice build; no LibreOffice or Poppler |

The runtime bundle, Host executable, and WiseOffice resources were freshly built/staged. The executable candidate was frozen separately from build outputs. `build-fingerprint.json` records these hashes. Local `origin/main` was an ancestor at candidate preparation; remote queries did not complete. This report validates the recorded local candidate, not a refreshed remote integration candidate or a release.

Tests used an isolated Electron profile, Host data directory, workspaces, and sessions. The actual OS file-picker result was automated to select each source file. The existing artifact-opening capture hook was used for navigation only. LLM output, media tasks, native editor state, teaching writes, saved PPTX, and playback were real and were not seeded or mocked.

## Fixture and checks

The teaching topic was kindergarten English shapes, with brief English narration. Scene and Master generated one Circle body page plus a standalone Quiz and oral activity. Imports started from a new two-page Circle/Square PPTX and added a Quiz after Circle and an oral activity after Square, giving four pages.

Requested effects were a red-circle `fadeIn`, a spotlight on the red circle, and a highlight on the Circle title. Each import explicitly requested `short_answer` for the oral activity. Master requested a Quiz and oral interaction without fixing their exact wording or response kind; its four-choice Quiz and discussion are therefore valid for that case. Scene requested an oral activity without fixing a response kind; its `practice` kind is not the import type failure.

Import attachment matrix:

| Case | Lesson plan | Final script | Object naming |
| --- | --- | --- | --- |
| `import-both` | Yes | Yes | PowerPoint defaults |
| `import-plan` | Yes | No | PowerPoint defaults |
| `import-script` | No | Yes | PowerPoint defaults |
| `import-none` | No | No | Semantic names, e.g. `red-circle` and `Circle-title` |

The two final-script original-page segments were checked verbatim, including their original-page mapping after insertion:

```text
Page 1
Look at the red circle. A circle is round. Say circle.

Page 2
Look at the blue square. A square has four equal sides. Say square.
```

The external plan specified the two activities and their evidence. For imports without a plan, the explicit test request supplied the desired activities; this is not a test of automatically inventing an assessment quota.

Verification included native readback; the actual saved ZIP teaching carrier; embedded media hashes and byte lengths; original page identity, text and geometry; script preservation; source-grounded plan evidence; full-course and page-1 original-audio recovery; editor close/reopen; complete application restart; immutable Host snapshot/build; and real browser playback. Playback allowed every audio clip to end naturally, answered the Quiz correctly, continued the teacher-led activity, and observed rendered effect overlays and changing animation opacity.

## Case results

“Effects” below means fade-in, spotlight, and highlight all exist and visibly run. A playable result can still fail the requested teaching requirements.

| Case | Pages | Saved speech/audio | Effects | Fixed build / actual playback | Requirements remaining |
| --- | ---: | ---: | --- | --- | --- |
| Scene | 3 | 8 / 8 | Missing all three | Build passed; 8 clips, Quiz and oral activity played | Attention target matching failed; Chinese activity helper text |
| PPT Master | 3 | 7 / 7 | Passed | Build passed; 7 clips, Quiz and discussion played | No machine-checked functional failure; guidance and visual limitations below |
| PPT + plan + final script | 4 | 4 / 4 | Missing all three; one pending attention intent | Build blocked; playback not run | Pending intent not resolved with existing audio; Chinese helper text |
| PPT + plan only | 4 | 12 / 12 | Passed | Build passed; 12 clips, Quiz and oral activity played | Requested `short_answer` changed to `practice`; Chinese helper text |
| PPT + final script only | 4 | 4 / 4 | Missing all three | Build passed; 4 clips, Quiz and oral activity played | Missing effects; oral reference answer omits `a ball`; Chinese helper text |
| PPT only | 4 | 15 / 15 | Passed | Build passed; 15 clips, Quiz and oral activity played | Oral reference answer omits `a ball`; Chinese helper text |

Totals: 22 saved pages, 50 saved speech clips with valid embedded audio, and 46 clips naturally completed in the five playable cases. The blocked case's four audio assets passed saved-media validation but were not counted as played. All five playback reports had zero runtime page errors, one checked Quiz, and one teacher activity.

### Preservation and recovery

- All four imports retained both original page IDs and their order around the inserted activities. Original shape types, text, and positions/sizes were preserved within the audit's 10,000 EMU tolerance.
- Both final-script cases retained the exact script on the correct original pages. No UUID or machine shape identifier appeared in spoken text in any final case.
- Both lesson-plan cases retained source hashes and verbatim evidence, and their activity IDs resolved to the saved actions.
- Full-course and page-1 `recover:true` checks retained valid original audio without replacing it. Pages/actions were identical before recovery and after editor reopen in all six cases.
- All six passed a complete Electron restart using the same isolated data/profile: pages/actions, teaching revision, and source descriptor were identical. See `restart.log` and each `restart-check.json`.
- These recovery checks establish retention/idempotence for existing valid audio. They do not establish recovery from every failed, cancelled, unknown-submission, or unfinished-order state.

### Fixed builds

| Case | Build ID or failure |
| --- | --- |
| Scene | `3a06efee21ac66b0356b90f010f1f769f9c0c8a2784b7ebcee5839382a90fb64` |
| Master | `e583dd50a9829a37e954b338ecc817b829429ac71176e6cc110a4ae4d71007c5` |
| Import both | `COURSEWARE_CONFLICT: adopt decoded speech audio to resolve automatic attention before snapshot capture` |
| Import plan | `3dd3be45ba39fbf8404001ea6f3b4b14cddf3e28255086cc91f78da2e57f5d44` |
| Import script | `903f5e094800225872f6aeccb150c0a9763a077bc42eb246af32341e1d9c7fcb` |
| Import none | `4201b49c6bacc225e185600fa8b2047c151b40110e966d4055a1d17b8a11d7d8` |

Build tests used the existing `apps/desktop/test/courseware-native-snapshot.test.mjs` with the real saved deck, real PPTX worker and frozen Host executable. The five builds each passed that test. Their build reports explicitly retain `visualFidelity: NOT_VERIFIED` and limited static-slide capability; successful builds are not general PPT fidelity certification. Notes-master warnings were recorded/reviewed for these simple fixtures.

## Findings and reproduction evidence

### 1. Pending attention can remain after preserving existing audio

In `import-both`, `repairRequiredTeaching:true` preserved final script and four existing audio assets, but saved an unresolved `attention` intent on one speech action. There were no resolved fade/spotlight/highlight cues. Full and scoped audio recovery retained the already-valid assets and did not resolve that intent. The immutable snapshot correctly refused the unresolved state.

The recovery helper currently returns `retained` immediately when `audioAssetId` exists (`courseware-native-audio-recovery.ts`), while the native snapshot gate rejects an action with `attention` (`db/courseware_projects/snapshots.rs`). The real test demonstrates the gap between these operations. It does not justify dropping the intent or buying replacement audio. Evidence: `import-both/carrier.json`, `teaching-before-recovery.json`, `transcript.json`, `fixed.log`.

### 2. Requested effects are not reliably completed across routes

Scene repeatedly returned `Attention targets do not match this speech`. Its layer objects had generic names and empty aliases. Generation eventually completed with narration/TTS but no cues. Machine IDs were deliberately not inserted into children's spoken text. `import-script` likewise completed without the requested effects. Master, plan-only import and semantic-name PPT-only import did produce and visibly play all three effects.

Object naming is a useful diagnostic variable, but these cases also differ in script-preservation policy and model output. This is not a controlled experiment proving names alone cause failure. Evidence: corresponding `tool-failures.json`, `carrier.json`, `playback/report.json` and screenshots.

### 3. Activity type and reference answer can drift despite successful playback

The plan-only case encountered activity evidence validation and then changed the requested `short_answer` to `practice`. The activity remains playable, but that is a requirement failure, not an equivalent accepted replacement.

The script-only and PPT-only cases saved the oral activity's reference answer as `A circle is round.` rather than an example of a round object such as `a ball`. Script-only also includes the example in its question text; that does not repair the saved reference answer. The audit checks the carrier rather than accepting the agent's claim that the expected answer is correct.

### 4. English teaching mode still contains Chinese template copy

Scene and all four import decks contain Chinese activity helper text such as `请选择最合适的答案`. Their English narration does not make the complete teaching material English. The original audit reported no Chinese text for Master because it omitted grouped shapes. A later recursive OOXML check found Chinese Quiz and interaction helper text in Master too. The consolidated audit records this as a failed visible-language requirement for the other five cases.

### 5. Initial automation needed guided continuations

These are real, operator-guided completion results, not six uninterrupted one-prompt successes:

- Master initially used the legacy native edit change-plan route and received `COURSEWARE_CHAT_RECEIPT_FAILED`; it was redirected to the shared Part A teaching tools. Its initial font/layout preview also required correction before export approval.
- Scene's Quiz option values passed planning but failed later compilation until changed to the accepted option identifiers. Reapproving that change invalidated/regenerated visual assets despite unchanged body imagery. Real extra image generation occurred.
- Several import calls reused a stale source SHA after native saves. Guidance required rereading current context rather than repeating the rejected request.
- Script-only's first model turn stalled for roughly three minutes without performing tools. Only that isolated turn was aborted, and the same brief/attachments were retried. `stalled-turn.json` records it.
- Plan-only generation was exercised while actually navigating page 1 → 2 → 1. `editGeneration` changed 6 → 7 → 8; content was not edited, and final generation/save/restart checks passed. See `navigation-during-generation.json`.

The tests did not edit native teaching JSON directly or remove failed actions to make a build pass.

### 6. Context completion flags disagree

Some `courseware_media_context` reads report `audioReady/teachingReady: false` in association with missing optional Quiz option images, while all speech audio exists and narration-context completion can be true. Option images were explicitly excluded from these test requests. Saved audio counts, actual media bytes, and real playback are used as evidence; inconsistent flags are retained in the transcripts rather than treated as audio failures.

### Visual inspection limit

Actual playback screenshots were captured and inspected. In the Master spotlight screenshot, the rectangular reveal does not fully cover the bottom of the circle. Functional overlay detection therefore does not establish precise visual targeting. Native font/rendering fidelity also remains outside the build's verified capabilities. Keep this as a visual follow-up, not an all-clear based solely on cue presence.

## Environment interruptions and cleanup

The host disk reached zero free space during the both-attachments case and crashed the isolated test app's log writer. The already-saved four pages and four audio assets survived restart. Space was recovered by removing only this run's duplicate rebuildable editor-build directory and inactive Host incremental compilation caches. No source, workspaces, final decks, evidence, or preexisting resource backups were removed. Checks after space recovery are the reported results; the disk failure is not classified as a teaching-generation defect. See `environment-recovery.json`.

Harness issues were kept separate: a metadata file named `candidate.json` shadowed the Electron directory entry on one restart, and an initial snapshot invocation omitted the PPTX Node path. Both were corrected before the reported successful tests. The metadata is now `build-fingerprint.json`.

The isolated application and its PPT Master preview server were stopped. Copied authentication/provider secret files and the private environment backup were removed. The original login token was updated from the normal test refresh only after its original hash still matched the pre-test value, preserving any concurrent newer login. Normal managed-image authentication refresh was retained; stale credentials were not restored. See `cleanup.json`. No credential values are included in this report.

## Reproduction and untested scope

The evidence directory retains the operator scripts, fixtures, transcripts and standalone validation scripts. Credentials must be supplied through normal application authentication to run generation again; they are intentionally not retained in the test directory.

```bash
python3 /home/jhz/deckwise-validation/part-a-real-matrix-20261111/audit-artifacts.py
```

The auditor rereads saved PPTX/media and existing playback/restart evidence without paid calls. Generation helpers (`run-import.mjs`, `finalize-case.mjs`, `runner.mjs`) enter the real application paths. `live-playback.mjs` plays a generated immutable build without seeking through narration. For cases missing effects it deliberately exits nonzero after writing a playback report; the failed effect assertion must not be hidden.

This matrix does not cover music, video, generated option images, unsupported original PPT animation fallback, large/complex decks, every external attachment format, arbitrary object manipulation during generation, or all unfinished media-order recovery states. Existing unit suites were not rerun as a substitute for these live tests. Source commits were not changed, committed, pushed, merged or deployed in this validation task.
