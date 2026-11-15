# MAIC assessment visibility investigation and repair

Worktree: `courseware-par-A`. Investigation used the current source and a read-only
SQLite connection. The running user application and generated lesson were not
restarted, migrated or regenerated.

## Persisted lesson evidence

The latest scene task was the six-page My Family lesson, based on a lesson-plan
attachment and a request for at most six pages. The saved approved plan, native
project and canonical classroom agree on the following content:

| Page | Approved content | Canonical MAIC result |
| --- | --- | --- |
| 1 | Opening | Slide |
| 2 | Song/listening practice | Slide + chapter-summary checkpoint |
| 3 | mum / dad | Slide |
| 4 | brother / sister | Slide |
| 5 | Identify brother, with four options and answer index 2 | Slide + checkpoint; **no Quiz** |
| 6 | Freeze / oral family practice | Slide + chapter-summary checkpoint |

There were zero Quiz scenes and three standard chapter-summary checkpoints. The
Quiz was absent in the approved plan already; it was not lost by PPTist export.
Page 5 used `teaching.question.response.kind=single` on an interactive page.
Compilation followed that request and emitted a checkpoint. The native sidebar
then displayed its separate legacy response editor, matching the user's image.

## Independent causes

1. Planning allowed objective questions to bypass independent `page.quiz` content
   through a checkpoint response. The new policy distinguishes objective tests
   from teacher-led oral/physical practice. Both Main parsing and Host approval
   now reject the bypass, even when the objective question is part of a game.
2. The standard content-editor button existed only before a generated PPT path
   was available. The generated-PPT toolbar now retains that entrance.
3. The packaged native sidebar still rendered its legacy checkpoint editor:
   question, reference, key points, response kind, options and answer indices.
   Desktop's build adapter removes the duplicate form and identifies the remaining
   timeline node as a MAIC classroom interaction. The standard editor owns content
   editing; the timeline and playback node remain present.
4. Opening the standard editor also reconciles the latest saved native source.
   The latest lesson has detailed narration, speech cues, music and teacher gates;
   the canonical classroom still has the initial planning narration. The previous
   synchronizer threw on untranslated native actions, blocking all content editing.

## Repair boundary and remaining compatibility limit

Reconciliation now permits canvas/question and independent content editing while
retaining the canonical narration, the original native project, and the unadopted
narration baseline. It marks untranslated teaching explicitly. The editor explains
this condition and disables whole-course play/export; the shared exporter rejects
it too, including build and publication callers. Question preview remains usable.
A supported speech-only timeline clears the pending state on later reconciliation.
Actual simultaneous supported narration edits and question conflicts still fail.

This repair does **not** establish a complete native-teaching-to-MAIC translator.
Music, teacher waits and speech cue semantics must be translated before full
native timeline delivery can be called MAIC compatible. Hiding that limitation or
silently exporting only the initial narration would misrepresent the artifact.
Canonical Quiz/checkpoint structure and field editing are separate from this
remaining timeline issue.

The existing six-page lesson is not automatically converted into a new Quiz. New
plans must use independent Quiz content for objective assessment; the standard
editor can add a Quiz manually. A lesson without objective assessment does not
receive a forced Quiz quota. No paid regeneration was performed.

## Reproducible resource delivery

```sh
node scripts/build-wiseoffice-maic.mjs <WiseOffice-source> <new-build-directory>
node scripts/stage-wiseoffice.mjs <build-directory> <new-staged-directory>
node apps/desktop/test/wiseoffice-maic-sidebar.browser.mjs <staged-directory>
```

Staging requires the MAIC integration marker and records source commit, dirty
state, entry and SHA-256 inventory. A plain upstream build is rejected. The build
adapter fails if the upstream checkpoint render markers drift. The local installed
bundle was verified with 2,857 listed files and `contentEditor:maic`. Previous
hashed assets were retained for the already-running editor; changed files were
backed up outside Desktop resources before promotion. No external WiseOffice
source edits were required.

## Verification

- Planning rejection was reproduced before the fix, including the four-choice
  family-word question. Main and Host regressions verify independent Quiz routing.
- Generated-PPT workflow regression reproduces the missing button, then verifies
  mounting the canonical content editor.
- Native sidebar source/staging tests and actual SDK browser test verify no legacy
  question/type/option form and zero teaching writes while viewing a checkpoint.
- Standard editor browser test covers autosave, failed image retry, checkpoint
  canvas synchronization, reference regeneration, four Quiz types and TTS flow.
  Its pending-teaching case verifies editing remains available while play/export
  are disabled and the pending marker survives autosave.
- Native synchronizer regressions cover retained Quiz/checkpoint data, resource
  validation, source/question conflicts and safe deferred native teaching.
- A read-only replay of the latest saved teaching, retaining the existing canvas,
  returns all six scenes and all three checkpoints unchanged, marks six native
  timelines pending and rejects incomplete export. This replay does not claim a
  full saved-PPTX parse or end-to-end live application open.

Final local checks:

- Desktop typecheck and production build passed (existing chunk-size warning).
- Targeted Main/editor/native integration suite: 113 passed.
- Runtime classroom/export suite: 8 passed; assessment component suite: 2 passed.
- Provider-free workflow gate: Main/Host 525, Shared 29, Agent Runtime 440 and
  Rust 270 passed; Rust also reported two ignored tests. Report:
  `/tmp/deckwise-workflow-gate-tUytw1/report.json`.
- Both standard-editor and installed-native-sidebar browser scenarios passed.
- An isolated Electron probe opened the actual six-page PPTX through
  `deckwise-editor://wiseoffice`, verified theme/shared preview/local speech and
  music, saved into its temporary profile and reopened six pages. It made zero
  remote requests and did not modify the source PPTX or the user's profile.
  The environment's SUID sandbox helper was unavailable; only this isolated,
  network-blocked verification process used `--no-sandbox` under Xvfb. Production
  sandbox settings were not changed.

The user's running Main/Host processes were not restarted. A manual application
restart is needed to load the new process code and packaged native editor entry.
