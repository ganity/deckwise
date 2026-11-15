# Six-page live courseware verification, 2026-11-08

Status: COMPLETED — saved acceptance and real Desktop/WiseOffice playback passed.
Nine non-blocking focus advisories remain; they are not playback errors or missing
audio. No claim is made of a full manual listen to all 91 body clips.

## Authorized task

- Session: `00d36793-b0e7-433a-a2ff-7ac7a4695c99`.
- Initial turn: `c6f4276c-2b58-4d6c-b22d-c25185c3a393`.
- Task path: scene, story first; kindergarten senior class, English, bilingual.
- Provider/model: deckwise-managed / deepseek-v4-1-flash, reasoning off.
- Visual style: warm watercolor children's storybook.
- Scene models: scene-master / scene-layers; Quiz option images: scene-master.
- Narration and question TTS: doubao-tts /
  zh_female_yingyujiaoxue_uranus_bigtts.
- Hard requested total: at most six pages including assessments. Saved body
  limit: four, reserving one Quiz and one interaction checkpoint.
- Objectives: father, mother, grandfather, grandmother, brother, sister; introduce
  the family using “This is my family!”.
- Create independent story/media/orders; preserve successful outputs; reconcile
  uncertain original orders rather than submitting replacements.

## Observations

1. No desktop process was running. Launching the current worktree initially
   failed because its Electron SUID helper is user-owned and unprivileged
   namespaces are restricted by AppArmor. The existing installed Chrome profile
   permits user namespaces. Launching within that profile using Chromium's
   namespace sandbox succeeded; renderer arguments contain enable-sandbox.
   No system permissions/profile configuration or source code was changed.
2. Task creation and initial prompt were accepted through the normal renderer
   IPC/Main/Host path. Existing user courseware was not replaced.
3. The first saved story passed its structural schema but proposed three
   questions inside one Quiz page and music inside an independent checkpoint.
   These contradict the current single-question/assessment-page contracts. The
   story was not approved. A revision request kept the exact six-page budget,
   reduced Quiz to one four-option picture question, and moved music to the
   fourth body page. No paid image/audio generation had started. The scene story
   prompt needs the same constraints as the downstream planner; record this as
   a shared prompt-alignment defect for regression coverage.
4. Corrected story revision 2 was reviewed and approved using its exact hash
   `e1257029139239de80364dde554eec0550fb46addc93d4be26183f7b768ba819`.
   The formal scene plan passed validation and was reviewed at six physical
   pages: body/body/body/Quiz/body/interaction. Body page five contains music;
   both assessment pages have empty narration/visible text and no body media.
   Approved plan hash:
   `57afcbe882ba5f832b0c089c36e387fdb99a60c29d71616ba9cd62565492f35d`.
   The initial read of a nonexistent new plan returned FILE_NOT_FOUND, then the
   agent created it and recovered without changing application code.
5. First-page visual-master generation was authorized for style inspection.
   The original `9f63d0b4-4ffb-4556-9129-13e9af397e56` returned a verified
   1280x800 PNG, SHA-256
   `3605d489eb00a4af5c68b4afdd26e843b034f66ba1fdcced9ed5ee037289bfa4`.
   Visual inspection confirmed the warm watercolor family scene and readable
   “A Family Album” / “family” lettering. It was adopted through normal Main IPC.
6. Full generation began under turn `379b2df3-9ccb-4b70-b6ee-fc1e0be205b7`,
   explicitly retaining the six-page plan, required narration/question TTS,
   four option images and approved music. Runtime continuation was requested
   through real saved acceptance. Running application artifacts remain unchanged
   during this generation; the story-prompt regression was reproduced separately.

## Verification scope

Completed story and plan review, cover inspection, media generation/decomposition,
compilation, detailed narration, speech/question TTS, option images, saved asset
audit and real playback verification. Evidence and limits are recorded below.

## Confirmed defects and recovery

1. Shared story prompt omitted the downstream one-question-per-Quiz and body-only
   music/video rules. Added the same rules before drafting and after approval.
   Real Main/Host handoff regression failed before the change and passed after it.
2. All four masters and three decompositions completed. Page three's original
   decomposition `bd415cde-0526-4803-bf6d-8bab90368dbe` stopped local archiving
   with `COURSEWARE_SCENE_IMAGE_LAYER_BUNDLE_TOO_LARGE`. Normal status IPC
   confirmed supplier state `ready`, fee state `settled`, actual points 16:
   this was a local download/archive problem, not a supplier failure. Retry was
   correctly refused, preventing replacement spending. Diagnostic archive replay
   identified z-index 0 exceeding eight MiB (first rejected chunk at 8,391,446
   bytes). Added bounded download and dimension-checked PNG normalization without
   resizing; the eight MiB archived-asset and Host frame limits remain unchanged.
   A nine MiB provenance-chunk regression reproduced the failure before the fix.
   Replaying archive on the same paid intent succeeded after the fix: background
   remains 2560x1600, 8,009,617 bytes, SHA-256
   `f86e36c7c8b9b5fc6e7e51cc09b6e78d0c1ead32a44daee47d4c0f8fa9ba490d`.
   No replacement order was created. Adopted its clean plate; foregrounds remain
   independently selectable. Resumed full generation under turn
   `c5c4694e-0492-407b-a6e6-e66ceb9c19da`.
   Targeted image/story/pipeline suite: 64 passed. Desktop typecheck and full
   production build passed; only existing bundle-size/dynamic-import warnings.
3. The resumed turn selected all page-three foregrounds, then ToolSearch exposed
   `courseware_media_assessments` and the real model provider returned HTTP 400:
   `tools.28.function.parameters must be a JSON Schema of type object`.
   That tool's new union lacked the root `type: object` already present on the
   other media unions. Added the same root annotation, preserving all strict
   per-target argument validation. A serialized-schema assertion over every
   courseware workflow tool failed on this tool before the fix. No additional
   paid media order was started by this failed model request.

## Generation progress after fixes

- Turn `92ac96e1-ec21-4f8e-82fa-4d37876cd1c3` compiled the approved six pages.
  PPTX source SHA-256:
  `6ca990783e148540c0216c9aedbd0ab75f7d1b7988b71bf008a6dcbb2eaeff85`.
- Generated and saved detailed narration on body pages 1, 2, 3 and 5, 91 short
  speech actions total. TTS batches preserve saved narration and use the requested
  Doubao voice. A first pass generated selected speech IDs; subsequent context
  correctly reported the remaining 28, which the agent is completing.
- Recoverable model/tool mistakes: called compile before ToolSearch activation;
  called body media context with unsupported kind=image; reused a stale assessment
  revision after legacy question-speech preparation. Existing checks rejected
  these calls and the agent corrected them by loading the tool, using assessment
  context, and rereading the latest revision. They caused no replacement order.
- Both question TTS targets and four option image targets have original orders;
  final adoption/readiness is still pending verification.

## Final-stage defects reproduced

4. Native Quiz image saves caused fallback PPTX imports to omit source object
   names. Unchanged body objects consequently received new identities and safe
   reconciliation cleared their old focus cues. The normal parser already copies
   these names; added the same behavior to the OOXML fallback. A forced-fallback
   round-trip test reproduced the missing names and now passes, alongside native
   classroom save tests (7 tests).
5. Focus-only repair added attention alongside an existing empty visualCues
   property. Host correctly rejects both representations on one action. Repair
   now removes the empty property when adding attention, retaining speech IDs,
   text, audio and nonempty cues. Both absent/empty cases are covered.
6. Automatic assessment refresh propagated a stale/lost adoption receipt as a
   generic local request-preparation failure. Added one bounded saved-state
   reconciliation per original assessment job; a persistent failure reports a
   blocked original without submitting a replacement. Regression covers both a
   successful lost receipt and a persistent failure. Narration/continuation suite:
   73 passed; runtime TypeScript build passed.

All 91 body speech audio clips, four Quiz option images and approved instrumental
music are saved. Fresh normal ClassroomOpen/TtsRefresh calls adopted both original
question TTS tasks without preparing replacements. Interaction original key:
`maic-1fbad231a02491e72c4bb6fe372c43a823176623d57c87e3aab3909d1b3f0b58`,
audio SHA-256 `86a035d688750ce9f2797114be5a763841ea18a41f7838a7976be37222015f3f`.
Focus repair and final saved acceptance/playback remain pending.

## Saved completion and player verification

- Final continuation turn: `b1e1cee8-add8-45b5-a23b-d518ba682be7`.
- Durable workflow checkpoint reached `completed`, revision 8. Saved acceptance
  reports six pages, all 91 speech audio assets ready, music adopted, no missing
  requirements; assessmentMedia reports ready with zero remaining targets.
- Focus-only repair saved all four body pages. Speech ID/text/audio fingerprint
  before and after is identical:
  `c61db143879609d739701291e79f969d200de2b0c4b3e572b0b10bb620436f5d`.
  Forty speech actions now have valid focus cues. Nine non-blocking focus
  advisories remain, including ambiguous multiple-character references and two
  pictured boys sharing brother aliases. Bounded automatic repair stops rather
  than selecting an unsupported identity or regenerating paid speech.
- Real Desktop player opens the canonical saved classroom. First-page stored
  speech decoded (readyState=4) and advanced. Quiz stored question audio decoded
  and played for 25.656 seconds, then enabled its four 1536px option images.
- This live answer check exposed another defect: after a correct Quiz answer,
  the optional feedback line depended on browser/system speech. Linux returned
  synthesis-failed and blocked progression despite ready question audio. Added
  visible accessible configured feedback and a reading interval when optional
  feedback speech is unavailable. Stored narration/question audio failures still
  pause for retry; no required speech is silently skipped. Both correct and wrong
  system-speech failure paths were reproduced before the fix and are covered.
- Full agent-runtime suite: 116 files, 1739 tests passed. Runtime and courseware
  builds, desktop full production build and desktop typecheck passed before this
  last playback fix. Final player rebuild and rerun are pending below.
- Final saved-asset audit verified all 137 local audio/media manifest entries
  exist and contain bytes, one canonical Quiz with four images, one chapter-summary
  checkpoint, both independent question TTS assets, and unchanged 91 body speeches.
  The canonical current source is
  `0aac5d932999d644f0acc220490a1d6f3f99c94fd88d68db08bf41fe75102bed`.
  Playback/fallback/native-save regression suite: 34 tests passed; courseware
  runtime build and final desktop production rebuild passed.
- Final real Desktop playback rerun: PASS. Stored body audio advances; Quiz
  question audio plays fully then enables all four decoded images; wrong answer
  shows configured feedback and allows retry; correct answer shows configured
  feedback and automatically advances even when Linux system speech fails.
  Interaction question audio plays for 15.648 seconds, then waits for the teacher;
  Teacher Continue completes the final page. No page exceptions or error UI.
  Final desktop typecheck passed. Evidence is in
  `/tmp/deckwise-live-verify-kAiQu8/player-evidence.json` with body/Quiz/interaction
  screenshots alongside it.
- Built-in WiseOffice page-six slideshow: PASS with one button click. It first
  displayed “正在读取本页题目…”, played the actual stored question audio
  (readyState=4, duration=15.648s), then enabled Teacher Continue and displayed the
  expected checkpoint question. No invalid binding, timeline or sourceSceneIds
  error. The loading indicator was present and hidden after preparation. Evidence:
  `/tmp/deckwise-live-verify-kAiQu8/office-evidence.json` and
  `office-interaction-player.png`. Closed the preview after verification, leaving
  the saved sixth page available in the editor.
- Staged the verified fixed worker/authoring bundle into this worktree's normal
  `apps/desktop/resources/pptx-worker` using the repository staging script, so a
  later normal launch uses the parser fix too. All 155 manifest entries verified.
  Previous generated resources are recoverably retained at
  `/tmp/deckwise-live-verify-kAiQu8/worker-original-resource`.

## Remaining limits

- The nine focus advisories were retained rather than applying an ungrounded
  identity: references can include several pictured objects or duplicate brother
  aliases. They do not block playback or saved completion.
- Linux system speech cannot render optional answer-feedback audio here. The
  configured feedback remains visible and progression/retry work; required saved
  question and narration audio are still played and fail explicitly if unavailable.
- Did not manually listen to every body speech clip or play the full music track.
  Their saved references and all local manifest bytes were verified. No successful
  paid media was regenerated to repair focus or playback.
