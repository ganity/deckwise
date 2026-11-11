# Three-path live validation — 2026-11-10

All three paths ran with the configured managed LLM, real media services, the paired
Office editor, saved/reopened PPTX files, real Host parsing/snapshots and the fixed
browser player. Scene and Master passed after repairs and operator guidance. Import
passed its materials/activity/audio workflow, but automatic effect repair did **not**
fulfil the request. Its effects passed only after an explicit editor teaching write.
Do not count this assisted check as passing automatic Chat effect generation.

## Candidate and scope

- Desktop: `deckwise-desktop-worktrees/courseware-par-A`, branch
  `feat/courseware-par-A`, base `e2a3aaeb02f7fd52125a662a9c5cb330452a8d1f`.
- Editor: `document-worktrees/courseware-par-A-playback`, base
  `3954c941c650bff02cd524e815428d25bfb7ca1c`; both have uncommitted work.
- Managed model: `deepseek-v4-1-flash`; media requests used real configured services.
- Evidence root: `/home/jhz/deckwise-validation/shared-teaching-live-20261110`.
- Fresh Desktop build and MAIC-integrated editor bundle `editor-bundle-fixed` were
  used in isolated profiles/workspaces. These are test resources, not a deployment.
- No existing user lesson, MAIC source or historical transcript was modified.
- Small kindergarten English shape lessons were used. The test operator reviewed
  visuals and supplied continuation/correction prompts; this was not an unattended
  one-prompt benchmark. No music, video or Quiz option images were requested.

## Actual workflows

| Path | Real preparation | Final file | Outcome |
| --- | --- | --- | --- |
| Scene | Planning, cover generation, clean plate and seven foreground layers | `scene/final.pptx`: one body page, Quiz, oral interaction; five speech segments | Saved/reopened and played; three effects observed |
| Master | Model authored project/SVG/notes/plan; official quality check and editable export | `ppt-master-run/final.pptx`: one native body page, Quiz, oral interaction; five speech segments | Saved/reopened and played; three effects observed |
| Import | External two-slide PPTX plus script and lesson-plan attachments | `import-run/final.pptx`: two original pages, Quiz, oral interaction; four speech segments | Original script preserved; automatic effects failed; assisted effects saved/reopened/played |

The imported source was created with python-pptx and initially had no generation
context or teaching carrier. Only the OS file picker selection was automated; the
file token, import and subsequent services were real. After Quiz insertion, the
original Square page became page 3 while retaining its original page ID/script.
Both original paragraphs were verified exactly after saving and reopening:

```text
Look at the red circle. A circle is round. Say circle.
Look at the blue square. A square has four equal sides. Say square.
```

`artifacts.json` records final files, SHA-256 values, carrier revisions and counts.

## Failures repaired during the run

1. Scene Host verification required completed speech before detailed narration was
   authored. Accept a planning-only body page while retaining rejection of conflicting
   existing speech/unplanned checkpoints. New test failed first, then 3 tests passed:
   `scene-regression-{red,green}.log`.
2. Main sent `courseware_activity_` to the ordinary editor dispatcher. Route it through
   the shared workflow. Dispatcher regression failed first, then passed:
   `routing-{red,green}.log`.
3. Native teaching writes could return saved without reaching disk: Custom XML did
   not reliably trigger the SDK modified event. The shared successful native commit
   now calls `markDocumentDirty()`. New dirty test failed first; all 27 editor tests
   passed afterward. Saved carrier revisions then matched reopened views:
   `dirty-{red,green}.log`, `document-final-tests.log` and final PPTX files.
4. Oral insertion lacked canonical canvas identity/viewport/theme and passed local
   `response` into MAIC actions. Supply canvas fields and omit that field only from
   the MAIC projection, retaining it in native teaching. Regression failed first,
   then passed; both Master/import subsequently inserted real oral pages:
   `checkpoint-{red,green}.log`.

The optional real snapshot test now filters referenced media exactly as production
`captureNativeTeachingSnapshot` does. Master retains older adopted audio after
revision; the previous test incorrectly exported all historical media and failed
with `unreferenced fixed audio asset`. Host validation was not relaxed and saved
media was not deleted. The tool schema also clarifies that pending activities must
omit `activityId`; that field identifies an existing checkpoint action.

## Browser playback evidence

| Path | Naturally ended speech | Correct Quiz checks | Oral continuations | Browser errors |
| --- | --- | --- | --- | --- |
| Scene | 5 | 1 | 1 | 0 |
| Master | 5 | 1 | 1 | 0 |
| Import, effects assisted | 4 | 1 | 1 | 0 |

No audio seeking/skipping was used. The player visited every page, answered the Quiz,
continued the oral activity, observed highlight/spotlight and intermediate fade
opacity, checked every speech ended naturally and checked unmount stopped audio.
Reports/screenshots are in `playback-scene-natural-3`,
`playback-master-target-review` and `playback-import`. Master spotlight and import
title-highlight screenshots were visually inspected.

Real saved-package parsing, immutable snapshots and Host restart/reopen passed:
`{scene,master,import}-fixed-build.log`. Build IDs:

- Scene: `37f6eadc906f69567d3e3beee78458ad4ab9149d123678450571c373f8e8f472`.
- Master: `a83f5752028ef302ddecc0604497e300939f882bc68a7943585bed32104c4d6d`.
- Import: `df9cfb9e19182bfa60d8d79d163c1c6bc7e5be9a565dd3ad4ac5c0605a6fdd48`.

All builds retain `PPTX_NOTES_MASTER_UNVERIFIED` and `visualFidelity: NOT_VERIFIED`.
These checks do not certify arbitrary PPTX fidelity or unrestricted native animation.

## Remaining findings and limits

- **Import automatic effects remain an acceptance gap.** With preserved script and
  no scene requirements, `repairRequiredTeaching:true` returned successfully but
  added none of the requested three effects. Completion called the lesson ready
  because those effects were not represented as requirements. The operator used
  `pptEditorTeachingWrite` with current verified object IDs to add explicit cues,
  keeping text/audio unchanged. This proves native storage/player capability only.
  Compare `import-run/before-assisted-effects.json`, `import-manual-effects.js` and
  `import-run/final-teaching.json`.
- Master initially misclassified operational instructions as script and passed
  relative paths where absolute canonical paths were required. Operator correction
  recovered it. Narration/effect targeting needed retries. First-attempt reliability
  is not qualified.
- Some immediate reads during save returned `No ready PPTX editor session, or a
  save is in progress`; later reads recovered. This remains a usability issue.
- Rebuilding debug Host while an older test instance ran invalidated its executable
  path and broke Bash spawning. This test setup issue recovered after isolated restart.
- Final lessons reference 14 audio segments; this is not a paid-request count.
  Revisions generated additional Master audio retained in its package. Billing totals
  were not audited.
- PowerPoint/WPS, other OSes, large/ambiguous corpora and release packaging were not
  qualified. The wider acceptance matrix remains open.

## Checks and cleanup

Host native generation: 3 passed and debug build passed. Final Desktop workflow/native
tools: 57 passed (`desktop-final-tests.log`). Paired native teaching: 27 passed
(`document-final-tests.log`). Desktop/agent-runtime typechecks and candidate builds
passed. Both worktrees passed `git diff --check`. Three real saved-package/Host/fixed
build tests and three natural browser playback checks passed with the scope above.

No commit, push, deployment or external message was performed. Isolated runners were
stopped after capture. Copied login/provider secret files were removed from test
profiles; refreshed login state was preserved for the original local login without
displaying credentials.
