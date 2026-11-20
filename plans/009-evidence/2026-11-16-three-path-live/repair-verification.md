# Scoped stability repair verification — 2026-11-16

This verifies the local source repair, not a new paid three-route generation or
installer. Base: `5cbd7cb44de14d6cb5f1e478ff9f57b63bd7d05d`; source and player
hashes are in [repair-fingerprint.json](repair-fingerprint.json). Existing task
changes were retained. No original real-generation artifacts were modified.

## Checks and evidence

| Check | Result | Boundary |
| --- | --- | --- |
| Observed melt/evaporation narration replay | Fixed candidate accepts; HEAD rejects | [Differential](repair-narration-replay.json); same literal and own-alias controls pass, wrong gas target still fails |
| Narration write, workflow-tool and continuation tests | 138 passed | Includes all three route types, wrong solidification target and shared-result ambiguity; supplier output is a fixture |
| MAIC schema/export and PlaybackCore tests | 34 passed | Explicit image policy survives export/reparse; invalid policies reject |
| Desktop classroom, images/TTS, assessment scope, native tools, Chat workflow, batch and Skill suites | 248 passed | Missing required images/audio still block; excluded image prepare rejects before quote; native save route rereads policy and preserves questions/actions without graphic projection |
| Agent runtime build | Passed | TypeScript output updated locally |
| Courseware runtime build | Passed | Node/player/worker bundles and declaration emit |
| Agent runtime, courseware runtime and Desktop typechecks | Passed | Three package TypeScript checks |
| Static-page browser regression | Red on old branch, green with fix | [Chrome result](repair-static-playback.json); actual five-page PPT Master package with fixture actions emptied; first-page completion absent, final-page completion present, back navigation clears it |
| Real Scene artifact with current player | Passed | [Playback](repair-scene-playback.json): 4 pages, 17 naturally ended real clips, wrong/correct Quiz and oral continuation, all three effects, no page errors |
| Real Import artifact with current player | Passed | [Playback](repair-import-playback.json): 4 pages, 4 naturally ended real clips, wrong/correct Quiz and oral continuation, all three effects, exact preserved script check, no page errors |
| `git diff --check` | Passed | Scoped whitespace check; no automatic reformat |

The desktop command was `node --test` with
`courseware-classroom`, `courseware-classroom-native`, `courseware-classroom-tts`,
`courseware-classroom-images`, `courseware-assessment-media`,
`courseware-native-tools`, `courseware-chat-workflow`, `courseware-narration-batch`
and `ppt-master-skill` test files. The package tests used `pnpm exec vitest run`
with the named source test files. `pnpm test -- file` was found to run the whole
Agent Runtime suite; the deliberate pre-fix run had only the three new narration
regressions failing, with 1832 existing tests passing. Scoped post-fix runs are
reported above rather than claiming a repeated full-suite pass.

The static red run reverted only the compiled static-page completion branch;
its browser trace caught the exact early-completion symptom. Vite was restarted
after restoring the fixed bundle because its transform cache retained the
red bundle. The final green evidence uses a fresh server and browser. Natural
Scene/Import playback bundled the current player independently and reused only
the original SHA-verified build artifacts; there were no new provider calls,
seek-to-end shortcuts, authentication changes or image reconstruction.

## Deliberate limits

- Text binding is bounded source-backed matching, not a general semantic proof.
  Visual evidence remains the existing current-page rendering/grounding path.
- Effect coverage exposes targets for every page and strengthens the common
  Skill's final comparison. It is not a new persisted free-text requirements
  engine, and completion flags alone do not prove every inline request.
- Duration feedback uses saved decoded speech; unknown timing stays null. Draft
  pacing guidance cannot guarantee an exact provider duration. Overruns are
  warnings, preserving the existing activity-budget business rule and user
  scripts. An explicit speech ceiling still needs actual post-TTS review.
- The original PPT Master body narration, Import's omitted second title effect,
  and Scene's long narration are not retroactively repaired in the historical
  files. Native-editor real save/reopen of the new image policy and a new full
  paid-generation matrix remain qualification work; P7 and historical P1
  attribution remain open.
- Scoped Biome lint was attempted but the repository configuration excludes all
  seven supplied implementation paths, so it processed zero files and is not
  reported as passing. Typechecks, executable regressions and diff validation
  provide the checks above. Unchanged Rust/Host and platform publication were
  not rerun. No commit, push or deployment was performed.
