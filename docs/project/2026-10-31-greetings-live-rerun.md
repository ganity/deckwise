# Greetings live rerun — 2026-10-31

## Scope and identity

- Session: `7ab73086-97ce-4a48-b311-869dc86e019d`.
- Worktree/branch: `deckwise-desktop-worktrees/courseware-par-A`, `feat/courseware-par-A`.
- Same 24,214-byte DOCX as the preceding run, SHA-256 `de47e6aac08805b5ffc873184c39e7b15c076b12f12c8ba58b2af4426a0c8166`.
- Kindergarten senior class, English Greetings, Chinese-led bilingual instruction, warm bright cartoon visuals, at most ten pages.
- Ten editable layered slides, detailed teaching with questions/reference answers, real speech, opening/closing Hello Song. No video or publication.
- Independent generation limits: TTS 10, images 5, decomposition 5, music 2, music export 2, video 2.
- Evidence directory: `/tmp/deckwise-live-rerun-20261031`. Observations use saved project state, session tool results, credential-free network metadata, and independent file/media checks.

## Timeline

Times below are Asia/Shanghai on October 31. Wall times include orchestration, review, retries and operator intervention; they are not supplier compute benchmarks.

| Milestone | Time | Evidence |
| --- | --- | --- |
| Submitted | 01:01:28.576 | `task.json` |
| Ten-page plan approved | 01:04:12.921 | `workflow.json` |
| Cover approved | 01:06:13.599 | `workflow.json` |
| All ten masters selected | approximately 01:09:18 | saved workflow |
| All ten decompositions ready | 01:16:48.752 | saved workflow |
| PPTX compile started | 01:17:26.901 | completion time minus measured duration |
| PPTX compile completed | 01:20:01.435 | 154.534 seconds; one compile |
| All ten detailed teaching pages complete | 02:17:15.307 | 195 speech actions, 14 interaction checkpoints, two music slots |
| Decoder fix loaded; original task resumed | 02:28:47.554 | `interventions.jsonl` |
| Never-started TTS recovery fix loaded; task resumed | 02:39:36.490 | 118 targeted tests passed; original intents/keys retained |
| All 195 speech actions have adopted audio | 03:04:01.778 | saved project and tool result |
| Both songs exported and adopted | 03:08:10.953 | final music refresh |
| Final runtime check | 03:08:32.223 | quality checked, no issues, all readiness flags true, no pending jobs |
| Portable copy requested | 03:09:53.865 | export completed through the normal desktop API |
| Portable copy independently validated | 03:11:05.274 | all 197 media files and commit hashes verified |

Submission to completed generation took **2 hours 6 minutes 42.377 seconds**.
The first PPTX took 18 minutes 32.859 seconds from submission. Detailed teaching
then took 57 minutes 13.872 seconds, including retries and the first repair
pause. Detailed TTS ran from 02:19:54.031 to 03:04:01.778, a wall interval of
44 minutes 7.747 seconds including decoder, source and cancellation recovery.
After the last runtime fix resumed at 02:39:36.490, remaining speech finished in
24 minutes 25.288 seconds. Music submission through final adoption took
2 minutes 16.334 seconds. These intervals have gaps and overlap with inspection;
they must not be added as independent supplier compute times.

## Failures and recovery

The rerun did not pass unattended. Plan and cover approval are expected reviews, not failure recovery.

1. The agent tried TTS on the initial outline despite context reporting `narrationReady: false`. Ten paid TTS submissions preceded detailed narration; four were adopted then invalidated when the page was rewritten. The operator stopped this at 01:22:21 and redirected the task to detailed narration. Do not treat those submissions as final speech or claim their billing was refunded.
2. Detailed narration had 18 page-level validation failures: JSON syntax 8, attention anchors 2, unknown visual UUIDs 2, visual annotation format 2, praise enum 2, too many English phrases 1, phrase outside the command bank 1. These are failed page attempts, not 18 failed whole tasks. Automatic single-page retries saved some pages; repeated speech-only requests also dropped required interactions/music and needed operator correction.
3. Operator steering at 01:40:39 could not replace calls already planned in the current assistant step. The operator stopped that sequence at 01:44:36 and requested a bounded batch restoring required interactions/music.
4. Repeated visual-evidence failures caused a pause at 02:02:36 for a code fix, tests and desktop restart; execution resumed at 02:11:29. The repaired runtime saved page 2 and internally repaired one page-10 visual response. A subsequent page-10 command-bank failure succeeded on retry at 02:17:15, reusing cached visual evidence.
5. Real parallel TTS exposed a previously untested local decoder bottleneck: a global boolean rejected concurrent audio as `COURSEWARE_AUDIO_DECODE_BUSY`. Thirteen individual speech items failed in three completed batches; successful audio remained saved. The fourth operator pause at 02:24:30 preserved original paid-task journals. A ten-window decoder queue was validated with actual Chromium and loaded before resuming the same task at 02:28:47.
6. Other tool-level errors included two tool-discovery misses, one upstream content-filter response and operator cancellations. These must be distinguished from HTTP errors and supplier media-job failures.
7. The editor round-tripped the generated PPTX on reopening, changing its actual SHA-256 to `9a8dc2772e2c60d6b2d84d20f6522ef0403c6f0cb9d05a775751598377683186` while preserving all 195 speech actions and 19 already adopted audio receipts. The first context read correctly rejected a concurrent source change. Unadopted old-source TTS cannot pass Host's source guard; no guard was bypassed. The operator investigated this at 02:30:54 and resumed current-source work at 02:32:28. At the time of the live run this limitation required extra generation for otherwise unchanged teaching; the follow-up below fixes future verified saves.
8. Five new-source TTS intents were stopped between durable Host begin and local relay dispatch. Their relay journals were absent and no paid POST had occurred. The old implementation polled these intents indefinitely as unknown. The operator paused at 02:35:28 and fixed explicit preparation to resume the same intent/key only when the mandatory before-POST local relay journal is absent. Existing unknown relay journals and non-local requests remain query-only. A fresh quote and current source/text/account/turn checks still apply. Six operator stop/recovery sequences occurred overall; this was not an unattended pass.
9. One batch-refresh call omitted required `sourceSha256`. The union-schema error also mentioned `intentIds`; the agent incorrectly inferred that batching was unsupported and switched to single requests. The schema already supports batches. Operator guidance corrected the missing field and explained explicit preparation for never-started requests.
10. Music context was called once with unsupported `pageNumbers`; the model removed it automatically. It subsequently queried two export-intent IDs through the page's generation-intent refresh route. Both calls correctly rejected with `Music job belongs to another saved page`. The model switched back to the original generation IDs and finished without operator interruption or additional purchases. Returning both `job.intentId` and `media.intentId` for distinct operations remains confusing; clearer result guidance or guarded export-to-parent resolution would be a useful separate fix.

The completed transcript contains 140 tool calls and 14 tool-level errors:
six operator cancellations, two undiscovered tools, one upstream content filter,
one source-change guard, two invalid argument calls and two incorrect music
intent queries. The 18 narration page failures and 13 individual decoder
failures are separate business results inside tool calls; they are not another
31 tool-level errors. One additional visual format failure was repaired inside
its original call. See `aggregate.json` for the separate categories.

## Program fixes in this worktree

- `courseware-narration-batch.ts`: retain successful partial visual observations under the existing evidence key; perform one bounded format repair with the validation error and previous output. Transport failures are not replayed as format repairs; validators remain strict.
- `courseware-saved-narration.ts` / `courseware-saved-media.ts`: share the existing detailed-narration readiness rule and reject outline-only TTS before intent creation or paid submission, for both single and batch preparation.
- `courseware-audio-decode.ts`: replace the global busy rejection with ten concurrent isolated decoder windows and FIFO waiting. Audio/video retain separate ephemeral network policies; format, size, duration, dimensions, timeout, crash handling and window cleanup remain enforced. This local resource pool does not combine the independent supplier-generation quotas.
- `courseware-media.ts` / `courseware-tts.ts` / `courseware-saved-media.ts`: explicitly resume a TTS intent stopped before local relay dispatch with its original key. Only a missing mandatory relay journal proves dispatch did not start; an existing unknown receipt is never posted again. Status stays read-only. A local-media regression covers lost responses, remote fallback refusal and dispatch fencing; a saved-media regression covers intent/key reuse after cancellation.
- Tests, real Electron fixtures and runtime/e2e specifications cover these behaviors. No new dependency was added.

## Validation and limits

- Final targeted narration, saved media, queue, local relay and TTS coordinator tests: 118 passed, zero skipped.
- Real Chromium portable-media plus saved-media tests: 29 passed, zero skipped. Eleven simultaneous MP3 decodes yielded ten active windows and one waiter; all eleven finished and released their windows. Concurrent audio/video decoding also passed.
- Desktop TypeScript check passed; the changed runtime built successfully for the live desktop.
- Independent PPTX ZIP inspection passed: ten slides, multiple separately editable picture objects on every slide, 23,691,849 bytes, SHA-256 `553e52f3da1af55cbe6fbf33944f703fc4aa4da5e11da7b0e4997a2b1fa097a3`.
- The final editor-saved PPTX was independently rechecked: 23,582,697 bytes, SHA-256 `9a8dc2772e2c60d6b2d84d20f6522ef0403c6f0cb9d05a775751598377683186`. Its filename retains the initial compile hash; consumers must hash actual bytes. Picture-object counts in page order are 9, 9, 5, 9, 10, 7, 10, 9, 10, 9.
- All 195 speech files and both music files passed SHA-256, byte-length and independent `ffprobe` duration checks. Speech totals 427.416 seconds. Songs are 28.44 and 29.64 seconds by `ffprobe`; decoder measurements can differ slightly by codec padding. All 152 visual-cue intervals are positive and within their parent speech's measured duration. Every page has a question with reference summary/key points; four additional checkpoints are explicit teacher-continue waits and do not need question answers.
- TTS HTTP overlap reached ten in the live corrected runtime. Two music generations occupied distinct pending jobs, but music/export tool invocations were sequential; this run does not establish two simultaneous live submission calls for either. Per-type concurrency is additionally covered by queue/local-relay tests. Video was intentionally unused.
- HTTP overlap measures requests until response headers, not the lifetime of asynchronous supplier jobs. Generation-queue tests cover occupancy until terminal state, separate limits, cancellation and unknown submission responses. Do not infer supplier concurrency from a single HTTP request peak.
- Model output can still violate teaching schemas. The bounded visual repair does not guarantee every model-generated teaching page will validate on its first attempt.
- Full human listening and the separately gated complete Host/TTS integration suite have not been performed. Actual live media adoption and isolated Chromium decoding are separate evidence, not a claim that this full suite ran.
- The branch already contained substantial uncommitted changes. This run preserves them; its isolated patch and before-edit snapshots are in the evidence directory. No unrelated changes were staged or committed.

## Final result and artifacts

Completed: ten pages, ten detailed teaching pages, 195/195 speech audio actions,
ten questions with reference answers, four teacher-continue checkpoints, 152
timed visual cues, two adopted songs, zero pending media slots and zero pending
runtime jobs. Final `quality.status` is `checked`, `issues` is empty and
`narrationReady`, `audioReady`, `teachingReady` are all true. This is generation
and structural/media validation, not full human editorial approval.

- Final editable PPTX: `/home/jhz/code/train/deckwise-desktop/apps/.deckwise-ppt/generated/553e52f3da1af55cbe6fbf33944f703fc4aa4da5e11da7b0e4997a2b1fa097a3.pptx`.
- Portable project directory: `/home/jhz/code/train/deckwise-desktop/apps/courseware-copies/0fe4b0ad-25a1-44cb-876a-50ad03b92af5.deckwise`. This contains the PPTX, detailed teaching, logical scene metadata and all 197 media files. All media references have exact file coverage; source, teaching and commit hashes match. Plain PPTX alone does not carry this complete teaching project.
- Evidence: `final-context.json`, `final-validation.json`, `portable-validation.json`, `unstarted-live-validation.json`, `final-stats.json`, `aggregate.json`, `interventions.jsonl`, test/typecheck logs and the isolated `root-fix.patch` in the evidence directory.

Observed paid POST counts were images 10, decomposition 10, TTS 228, music 2 and
music export 2. Final speech uses 195 TTS tasks: **33 additional TTS submissions**
were incurred, comprising ten premature outline requests and 23 unadopted
old-source requests that could not survive the editor source change. All 228
TTS relay journals are terminal `ready`; their saved `actualPoints` sum to 228.
Music generation journals show two points each and export zero. These are local
receipt observations, not an independently reconciled account statement or a
currency cost estimate. Images/decomposition are excluded from this point sum.

Remaining program opportunities are narration schema reliability without
losing required interactions and reducing model/checklist overhead between
batched page operations. The two source/ID issues observed in this run are
addressed by the follow-up below; historical charges and run results stay as
recorded.


## Six operator stop/recovery sequences

All times below are Asia/Shanghai on 2026-10-31. Plan/style approvals and the
01:40:39/02:45:58 steering messages were not abort/recovery events.

| Stop | Trigger | Recovery |
| --- | --- | --- |
| 01:22:21 | Initial outline was synthesized despite `narrationReady:false` | Redirected to detailed teaching; original receipts retained |
| 01:44:36 | Single-page retries fell back to speech-only and lost interactions/music | Stopped page 6 and batch-regenerated missing requirements, preserving valid pages |
| 02:02:36 | Repeated visual UUID/format failures and whole-deck evidence rework | Fixed partial evidence cache, bounded format repair and outline TTS gate; resumed 02:11:30 |
| 02:24:30 | Parallel TTS hit the decoder's global `DECODE_BUSY` guard | Installed ten-worker decoder queue; resumed 02:28:56 with 19 adopted items retained |
| 02:30:54 | Native editor round-trip changed source; 23 unadopted old-source jobs could not be adopted | Investigated, kept source guard and resumed current-source generation at 02:32:28 |
| 02:35:28 | Five intents stopped after Host begin but before relay dispatch and polled forever | Added original-key recovery only with mandatory local-journal absence proof; resumed 02:39:36 |

## Follow-up: pending source bindings and music IDs

Native-save commit now preserves already-dispatched, unchanged-speech TTS
through a private verified source binding, including unknown, submitted and
archived-but-unadopted tasks. It leaves original paid requests and keys intact;
actual PPTX hashes still follow the bytes. This prevents the observed future
repurchase cause; it does not retroactively alter this run's 23 stranded tasks
or billing receipts. Text/page/source/lock/account/CAS guards remain enforced.

Music refresh now accepts its retained export ID as well as the generation ID,
resolves the original generation within the account/page/draft scope, and always
returns the canonical generation job ID. Agent tool guidance explains both IDs.
No replacement generation/export is purchased during recovery.

Validation completed in the existing dirty task worktree:

- Desktop/coordinator/real-Host SDK-fixture tests: **67 passed**, no skips or
  failures, including actual parser/file replacement/archive/adoption.
- Agent workflow-tool contract tests: **8 passed**; runtime TypeScript build passed.
- Host courseware-project regressions: **236 passed, 2 fixture-gated tests
  ignored** (locked-image and portable-copy fixtures). After the final terminal
  rejection-binding adjustment, all five native-save tests passed again,
  including team refusal after rebinding; the SDK test used a freshly rebuilt Host.
- Desktop typecheck, scoped Rust formatting and changed-file whitespace checks
  passed. Host debug build passed with two existing unused-code warnings.
- The first real-Host attempt lacked the worker environment and failed before
  parsing. Supplying the installed worker and Node paths allowed the same test
  to pass; this was test setup, not a new product failure.
- Final PPTX and portable teaching SHA-256 values still match the completed
  run. These isolated tests performed no paid generation and did not change
  that lesson. No full installer/UI acceptance or supplier rerun was performed.

Evidence: `/tmp/deckwise-source-music-fix-20261031`, including an incremental
patch against the pre-follow-up working tree and a hashed file manifest. Existing
unrelated work is preserved; nothing was staged or committed. The currently
running Desktop process was not restarted and will load the fixes on restart.
