# Greetings live rerun (2026-10-30 evening)

## Scope and evidence

Worktree: `deckwise-desktop-worktrees/courseware-par-A`.
Chat: `c7f4d929-509c-46c3-852f-676b73617fdb`.
Prior ten-page Chat: `4836015b-8966-4fb8-909d-1651aea0b149`.
Evidence directory: `/tmp/deckwise-live-rerun-20261030-evening`.

Submitted at 20:21:01 China time, with the identical 24,214-byte Unit 1
Greetings DOCX, kindergarten senior class, English, bilingual teaching,
warm bright 3D cartoon style, and a ten-page maximum. Requested outputs are
layered editable PPTX, detailed teaching, real TTS and opening/closing music.
No extra worktree or publication was requested or performed.

The running Main bundle contains independent limits: TTS 8, image 5,
decomposition 5, music 2, music export 2 and video 2. Six-type queue and local
receipt regressions pass (16 tests). This verifies client scheduling behavior,
not supplier-wide quotas or eight-way end-to-end TTS throughput.

## Completed stages

- Ten-page plan reviewed and approved through the existing UI at 20:23:56.
- Cover reviewed and its style adopted through the existing UI at 20:26:15.
- All ten masters and all ten decomposition jobs completed without a failed
  supplier response or replacement submission.
- Compilation ran 20:36:48–20:39:09 (141.030 seconds).
- PPTX ZIP integrity and actual ten-slide count passed. Each slide has 5–13
  independently positioned picture objects; the slides are not single-image
  composites. Output size is 24,486,782 bytes, SHA-256
  `1ebf279c102b6566c9516ae9a66627cb8a80f5072d749868a8011184e5f6aba8`.
- Detailed narration ran 20:42:18–20:53:55. The first call saved five pages;
  seven automatic subset calls completed the remaining pages. All ten now
  contain generated teaching, totaling 215 speech actions. Pages 2 and 10
  contain music slots. No video slot was introduced.

Final media context at 22:19:28.847 China time reports `narrationReady`,
`audioReady`, `teachingReady` and `videoReady` all true, `jobs: []`, quality
`checked`, no blocking diagnostics and no issues. `videoReady` means no video
was required; no video was generated. All ten pages have reviewState ready.

| Stage | China time | Elapsed |
| --- | --- | --- |
| Submission to final media readiness | 20:21:01–22:19:28 | **1 h 58 min 27.622 s** |
| Submission to editable PPTX | 20:21:01–20:39:09 | 18 min 8.217 s |
| Image/decomposition requests through last selected bundle | 20:24:29–20:36:16 | 11 min 47.431 s; includes cover review |
| PPTX compilation | 20:36:48–20:39:09 | 2 min 21.030 s |
| Detailed teaching and automatic subset recovery | 20:42:18–20:53:55 | 11 min 36.294 s |
| Detailed TTS, including context recovery pauses | 20:56:47–22:15:04 | 1 h 18 min 16.810 s |
| Music generation submission through last adoption | 21:37:33–22:19:04 | About 41 min 31 s; overlapped TTS, most time was not polled |

Stage windows overlap and must not be added together. The two music generation
calls consumed 29.266 seconds; four refresh/export/adoption calls consumed
91.775 seconds. The wall window does not establish supplier processing latency.
225 TTS prepare calls consumed 3,322.072 seconds (55 min 22.072 s), including
invalid configuration, operator cancellation and saved-asset fast paths.

## Final artifacts and checks

- PPTX: `/home/jhz/code/train/deckwise-desktop/apps/.deckwise-ppt/generated/1ebf279c102b6566c9516ae9a66627cb8a80f5072d749868a8011184e5f6aba8.pptx`.
- Complete project copy, exported through the Desktop API after the Chat became
  idle: `/home/jhz/code/train/deckwise-desktop/apps/courseware-copies/b34d111d-31ee-4511-934c-7d2f0eeb0c08.deckwise`.
- All 215 adopted TTS files passed SHA-256, length, decoding and duration checks:
  3,736,395 bytes, total decoded duration 465.840 seconds. No pending attention
  annotations remain; 128 timed visual cues and 11 interaction checkpoints exist.
- Music on pages 2 and 10 passed hash, length and decoding checks: 24.048 and
  31.248 seconds. Both replaced their original slot at action index 13; no
  music slots remain. Two generation and two export intents were used.
- The project copy contains the unchanged ten-slide PPTX, teaching JSON and all
  217 referenced media files (5,065,149 media bytes). Every exported reference,
  media length/hash and the source PPTX hash passed verification.
- Readiness, audio, music, project-copy and PPTX evidence are saved as JSON in
  the evidence directory. No publication snapshot or PPTist build was performed.

## Findings and recovery

| Observation | Classification and outcome |
| --- | --- |
| Initial `courseware_workflow_get` was not active | Deferred-tool discovery friction. Agent activated tools through ToolSearch and continued without operator retry. |
| Initial planning-file read returned FILE_NOT_FOUND | Expected absence on a new Chat; planning creation recovered automatically. |
| Requirements update supplied new values as its expected baseline | Model argument error. The stale-write guard correctly refused it; original grade/subject/language remained intact. |
| Queued sixth decomposition temporarily had phase submission-unknown | Conservative journal state is written before the generation queue. The original call completed after about 50 seconds and acquired a real receipt. No submission failure or paid retry occurred. A list snapshot alone cannot establish remote concurrency or a terminal failure. |
| Split outline speech reported narrationReady=true | Confirmed programmatic readiness defect; fixed below. Operator stopped the premature TTS sequence and requested detailed teaching first. |
| Agent guessed TTS model/voice and received 46003 | Invalid model/configuration request; corrected by reading the real TTS catalog. No supplier outage is inferred. |
| Detailed teaching had seven page failures across three responses | Three JSON syntax failures, two visual-object annotation failures, two nonunique attention anchors. Strict validation preserved existing pages; automatic subset retries completed all ten pages. |
| One outline TTS asset was adopted before sequence correction | Avoidable early synthesis caused by false readiness. Detailed replacement invalidated that speech attachment through the normal narration write; the archived receipt is retained. An operator-aborted media call is recorded separately from spontaneous failures. |
| Saved media executes serially | The per-type generation ceiling does not make the whole saved-parser/coordinator path parallel. Successful TTS calls take roughly 14–15 seconds each in this run. |
| Context recovery replayed a completed narration instruction | At 21:32 the agent proposed all ten pages again, although it had just confirmed generated narration and 104 adopted TTS segments. Operator aborted before any page adoption; all 215 speeches and 104 attachments survived. Pending `attention` was also incorrectly described as invalid, although TTS adoption resolves it normally. |
| Repeated full-deck context reads stalled media progress | A narration context added about 66,000 input tokens in this run. Repeated reads and context recovery caused several minutes without new audio. Operator steered the active turn to known missing IDs and per-page context reads. The remaining four page-5 audios then completed. Later repeated calls for those four returned existing saved audio without paid synthesis. |
| Another stale page-5 replay after TTS completion | The saved-audio fast path again returned existing assets. One further steering message restricted completion to the two original music jobs. |

Operator actions are recorded in `interventions.jsonl`: normal plan review,
normal cover review, one sequence correction, a stop of stale narration replay
and two steering messages (targeted reads, then music only). Narration subset retries are
agent recovery, not operator retries. No duplicate unknown paid submission was
authorized. This run has not reproduced the earlier foreground-session reload
failure.

There were seven tool-error records: five spontaneous errors (two deferred-tool
discovery errors, one nonexistent fresh planning file, stale requirements
arguments and an invalid TTS model), plus two deliberate operator cancellations
(premature media, then repeated narration). The seven narration page-validation
failures are business results, not those tool-error records. Image,
decomposition, compilation, corrected TTS and music had no terminal supplier
failure. Automatic narration recovery used seven subset calls; operators did
not manually retry image/decomposition/compile requests.

## Narrow fix and validation

`courseware-saved-narration.ts` previously excluded only `narration-0` from
detailed readiness. Host splits initial scene narration into `narration-N`
actions; sentence two therefore falsely established detailed readiness.
All numeric outline IDs are now excluded unless explicitly generated. Custom
manual IDs and explicitly generated speech retain their previous readiness.
No source document, teaching text, audio or journal data is rewritten by reads.

The new saved-context regression failed on the original code (`true !== false`)
and passes after the fix, including subsequent detailed generation, custom manual
speech and an explicitly generated numeric ID. Saved narration/media tests:
26 passed. Desktop TypeScript passed. Related spec and E2E scenario are updated.
This live task completed using explicit operator corrections; the new Main
source has not yet been loaded by restarting the running Desktop.

Tool descriptions now recommend per-page reads during TTS, preserving ready
narration after context recovery, and treating pending attention as valid.
This is model guidance, not an enforced ban on explicitly requested revisions
or a reduction of the full-deck context payload. Workflow tool contract tests:
8 passed; agent-runtime TypeScript passed. Main build and agent-runtime build
passed. Total targeted tests: 50 (16 queue/local receipt, 26 saved narration/media,
8 workflow tool contracts). Both Desktop and agent-runtime typechecks passed.
These new descriptions also require loading the rebuilt runtime and were not
the recovery mechanism of this live run.

## Remaining limits

The full teaching course and portable project are complete. Full-length human
listening, every-page animation playback and publication were not exercised.
No claim is made that generated wording or music performance received human
pedagogical approval. End-to-end TTS still executes serially; full context
payloads remain large. The readiness code fix and tool guidance are built and
regression-tested, but their effect on a new complete live run requires the next
Desktop restart and another generation run. There is no observed live network
peak measurement; the per-type ceilings are verified by code and queue tests.
