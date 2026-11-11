# Three-path regeneration and live validation — 2026-11-11

Follow-up: the Master playback blocker below was subsequently resolved by the
user-requested animation degradation policy. See
[animation fallback validation](2026-11-11-native-animation-fallback.md).
This report retains the original run and its failures; the import effect gap remains.

This is a fresh rerun of the three workflows on Part A. New tasks, workspaces,
generated images, official Master exports, imported source files and real audio
requests were used. The previous run's lesson outputs were not reused. The fixed
application/editor candidate from that run was reused; no product source was
changed during this rerun.

Evidence root: `/home/jhz/deckwise-validation/shared-teaching-live-20261111`.

## Candidate and method

- Desktop branch: `feat/courseware-par-A`, HEAD
  `e2a3aaeb02f7fd52125a662a9c5cb330452a8d1f`, including existing uncommitted work.
- Paired editor HEAD: `3954c941c650bff02cd524e815428d25bfb7ca1c`, including the
  existing native teaching persistence changes.
- Managed LLM: `deepseek-v4-1-flash`; configured real image/decomposition services
  and `doubao-tts` with the English teaching voice.
- Three isolated Electron profiles, actual Main IPC and paired Office editor,
  followed by saved-file parsing, immutable Host snapshots and Chromium playback.
- `candidate.json` records source/build fingerprints and the reused editor bundle.
  Host was copied to a stable test path before launching all three applications.
- Kindergarten English shapes; one body page for Scene/Master, two original pages
  for import. Each requested one independent Quiz and one oral interaction, English
  speech, red-circle fadeIn/spotlight and Circle-title highlight. Music, video and
  Quiz option images were explicitly excluded.
- The operator confirmed the planning/visual gates and supplied correction and
  continuation prompts. This does not qualify unattended first-attempt reliability.
  No handwritten teaching/effect payload was injected to make a result pass.

## Scene

Session: `ddd1e01b-214f-45ef-abff-b6717258a793`.

The real workflow produced a new plan, cover, clean plate and foreground layers,
then compiled a native teaching PPTX. The first automatic continuation stopped with
`Courseware media status check failed. Teaching completion is unfinished.` An
operator continuation completed narration, effect targeting and real audio;
effect generation needed retries. The final file has three pages and eight speech
segments, all with audio, plus the Quiz and oral checkpoint.

Saved carrier and reopened revision both equal
`01d5de9e-b95e-464d-8b9e-de6ef8852363`. Playback visited all three pages, naturally
ended all eight speech segments, checked one correct Quiz answer and continued one
oral activity. Highlight, spotlight and intermediate fade opacity were observed;
browser errors: zero. Spotlight and title-highlight screenshots were visually checked.

Evidence: `scene-run/final.pptx`, `scene-run/teaching.json`, `scene-reopened.json`,
`scene-fixed.log`, `playback-scene/report.json` and screenshots.

## PPT Master

Session: `dcb85009-dbfc-4a14-9734-4074da5c3f21`.

The model created a new official project, plan, SVG and speaker notes, corrected an
overlap, passed the final visual gate and produced an editable native export. The
operator reviewed the actual SVG before authorizing export.

Initial adoption failed twice because `animations.json` was newer than the final
quality report. The model then tried to adopt a generated wrapper and misreported
`Generated source already contains native teaching` as a successful task binding.
Actual task readback had no generated path. The operator required final validation
after all inputs and a fresh official export; adoption then returned `generated:true`
and the task recorded its generated path. No carrier was manually removed or rewritten.

During subsequent teaching, the model initially omitted `lessonPlan.text`, causing
mapping validation failures. A preview with source text succeeded. An inactive
editor binding then interrupted adoption: the automation helper for opening a file
was a no-op outside capture mode, leaving the SVG tab selected. The operator closed
the SVG tab and opened the real courseware workspace before continuing. This setup
issue and the correction are included in the saved transcript.

Both activity pages were then inserted successfully. Narration failed twice with
`Attention targets do not match this speech` for the red shape: speech containing
the word Circle was associated with the title text instead. A further operator
prompt separated shape observation ("Look at this red shape. It is round."), word
reading and sentence reading. The model's normal narration tool then saved three
body speech segments and actual fadeIn/spotlight/title-highlight cues. This was a
prompt-assisted recovery; the validation code was not weakened and no effect payload
was manually injected. Five real speech audio segments were generated/adopted;
stale source hashes during sequential adoption required rereads and retries.

Saved carrier and reopened revision both equal
`0b374e73-981e-45a4-89de-f531e229f26a`; all five speech audio references and four
cues were retained. The separate Host snapshot/restart test passed.

**Fixed playback is blocked.** Building the saved file failed with
`NATIVE_ANIMATION_UNSUPPORTED`, including `PPTX_TIMING_UNSUPPORTED_BEHAVIOR` and
`PPTX_TIMING_UNSUPPORTED_STRUCTURE` on page 1. The model had authored native emphasis
behaviors in `animations.json` during export, as an approximation of teaching effects.
Those OOXML animations remain in the saved PPTX. Although the later teaching cues
and audio were saved successfully, the fixed player cannot build this combined
file. No native animation was stripped and no build guard was relaxed to obtain a
pass. Master browser playback was therefore not run; its five saved audio segments
are not counted as naturally played audio.

Evidence: `master-run/final.pptx`, `master-run/teaching.json`,
`master-reopened.json`, `master-snapshot-only.log`, `master-fixed.log` and
`playback-master/blocked.json`.

## PPT import

Session: `2c11c24b-4516-4003-a9f2-6381a305f6d9`.

A fresh external two-slide PPTX was created without generation context or a native
teaching carrier. It was imported through the real file-token/import flow with a
lesson-plan attachment and a final-script attachment. Only OS file-picker selection
was automated. An initial editor-open setup issue needed a continuation.

The final four pages are Circle, Quiz, Square and oral interaction. All four speech
segments have real audio. Both original paragraphs were retained exactly, including
after the Square page moved from page 2 to page 3:

```text
Look at the red circle. A circle is round. Say circle.
Look at the blue square. A square has four equal sides. Say square.
```

Saved carrier and reopened revision both equal
`f5377fb6-1090-4e55-bf3b-6826750fad7b`. Host snapshot/export succeeded. Natural
playback visited all four pages, ended all four speech segments, checked the Quiz
and continued the oral interaction, with zero browser errors.

**Automatic effect generation failed again.** Retained-script repair returned a
saved result but left zero visual cues. Browser observation also found no requested
fade, spotlight or highlight. The playback test deliberately exits with a failed
all-effects assertion; its report is saved before that assertion. No manual effect
write was used in this run. This path is a partial result, not an overall pass.

Evidence: `import-run/final.pptx`, `import-run/teaching.json`, `import-fixed.log`,
`import-playback.log` and `playback-import/report.json`.

## Other observed gaps and scope limits

- Scene's body title/sentence are image layers, not editable native text. Assessment
  pages have editable text. Teaching cues target the correct image-layer objects.
- The assessment templates still contain Chinese helper text despite the full
  English setting. English lesson content and speech passed, but a fully English
  deck is not qualified.
- Generic completion still lists excluded Quiz option images as required and can
  report not-ready even when all requested speech is ready. Its flag alone is not
  the acceptance result. The Scene model also reported an unsaved editor; actual
  disk/reopen verification confirmed that the teaching revision was saved.
- Fade/highlight/spotlight are validated in the DeckWise fixed teaching player.
  This is not certification of native PowerPoint animation interoperability.
- Fixed conversion reports limited visual capability, `visualFidelity: NOT_VERIFIED`
  and the notes-master warning. Arbitrary PPTX fidelity is not qualified.
- PowerPoint/WPS, other OSes, large lessons, billing totals, music/video, option
  images and release packaging were not tested in this rerun.

## Checks and cleanup

| Path | Saved / reopened | Real audio saved | Host snapshot / restart | Fixed build | Natural browser playback |
| --- | --- | --- | --- | --- | --- |
| Scene | 3 pages, matching revision | 8 / 8 | Pass | Pass | 8 ended; Quiz + oral; all 3 effects observed; 0 errors |
| Master | 3 pages, matching revision | 5 / 5 | Pass | **Fail: unsupported native animation** | **Blocked**, no playback pass claimed |
| Import | 4 pages, matching revision | 4 / 4 | Pass | Pass | 4 ended; Quiz + oral; 0 errors; **all 3 effects missing** |

All files were regenerated this run. Scene passed the core teaching/player checks
after guidance. Master and import did not pass end-to-end acceptance. The full
English/template and excluded-image readiness gaps also remain open.

Successful fixed build IDs:

- Scene: `003bd6cb2b74b12aea4b2ab36e28e983b16945a497f99503cfa137170a9d917e`.
- Import: `820af94f5c35c80c864d570305d9b9f081883b837c93ed206d85f17e8e4e3737`.

Targeted Desktop workflow/native tests: 57 passed (`targeted-tests.log`). Paired
editor native teaching tests: 27 passed (`editor-tests.log`). Both worktrees passed
`git diff --check`. Original dirty product changes were retained.

Three real Host snapshot/restart checks passed, including the separate Master
snapshot-only check after its fixed-build failure. Two fixed builds succeeded and
one failed. Scene's natural playback check passed; import's deliberately failed
the requested-effects assertion; Master's was blocked before browser launch.

`artifacts.json` records final file paths, SHA-256 values, revisions, counts and
actual build/playback results. `cleanup.json` confirms that all three isolated
Electron processes stopped, 15 copied login/provider credential files were removed
from the test profiles, and refreshed login state was preserved for the original
local login without displaying credentials. No commit, push or deployment was made.
