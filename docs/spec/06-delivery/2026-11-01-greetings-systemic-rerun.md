# Greetings scene workflow live rerun — 2026-11-01

## Result

The requested ten-page course was generated, saved and independently validated.
Host acceptance returned `completion.ready: true`, zero missing requirements,
215 saved speech audios, ten questions and three saved songs. This is **not an
unattended workflow pass**: one operator correction repaired the draft plan, and
one operator stop ended a repeated final-state read/compaction loop after all
requested media had been adopted. Plan and cover approvals were two additional,
normal product review steps, not recovery interventions.

This live run qualifies the earlier
[local repair delivery](2026-11-01-scene-workflow-repairs.md): the generated
artifact and native-save preservation passed, but the claimed bounded terminal
behavior did not cover the actual model/tool/compaction sequence below.

## Environment and unchanged inputs

- Existing worktree: `deckwise-desktop-worktrees/courseware-par-A`.
- Branch: `feat/courseware-par-A`; HEAD: `1ff749805a93702fac7e7e24b7a0dffc43adcb6f`
  plus its existing uncommitted changes. No business code was edited in this run.
- Actual Electron development app, current Main, Runtime and Host processes;
  ordinary product APIs, original paid providers and native PPT save were used.
- Chat: `e27c64e2-0b06-4400-80b8-40b9c1832141`.
- Project: `office-d991aac85775328f25b069c38c9b276ff56cda8f-0f26264cffe8`.
- Model: `doubao-seed-2-1-turbo-260628`, thinking off, Agent mode.
- Original DOCX: `幼儿园英语教案示范课1_Unit1_Greetings_IP角色认识与问候.docx`;
  24,214 bytes, SHA-256
  `de47e6aac08805b5ffc873184c39e7b15c076b12f12c8ba58b2af4426a0c8166`.
  The imported copy matched the original hash.
- Kindergarten senior class, English, bilingual teaching, twenty-minute lesson,
  maximum ten pages, the original five characters and greeting activities.
- Hello Song was requested on pages 1, 9 and 10. No video or publication was
  requested. Independent configured caps remained TTS 10, images 5, layer
  decomposition 5, music generation 2, music export 2 and video 2.

No SQLite access, fabricated receipts, replacement purchases for uncertain
originals, fault injection, application restart, commit or push was performed.

## Timing

All times below are Asia/Shanghai on **2026-11-01**. The evidence records UTC.
The total includes normal human review and the plan correction; it is not a
supplier-only benchmark. Asset milestones are the first observed snapshots and
can lag completion by approximately one polling interval.

| Milestone | Local time |
| --- | --- |
| New task accepted | 01:15:25.756 |
| Operator plan correction submitted | 01:20:11.513 |
| Repaired plan approved | 01:27:59.621 |
| Cover ready for review | 01:29:30.680 |
| Cover style approved | 01:31:48.933 |
| All ten masters observed adopted | 01:35:14.989 |
| All ten decompositions observed adopted | 01:44:36.776 |
| PPTX compile started / ended | 01:45:26.794 / 01:48:00.019 |
| Detailed narration repair finished | 01:57:29.444 |
| First TTS POST / last TTS POST | 02:05:15.891 / 02:37:46.806 |
| First Host acceptance with all required media saved | 02:38:42.261 |
| Operator stopped repeated completion reads | 02:44:23.252 |
| Final copy validated after ordinary PPT save | 02:50:06.926 |

- Submission to first Host-ready result: **83 min 16.5 sec**.
- Submission to stopping the redundant tail: **88 min 57.5 sec**.
- Submission to final saved-copy validation: **94 min 41.2 sec**.
- Already-complete but still-running tail: **5 min 41 sec**.
- Compilation itself: **2 min 33.2 sec**.

Music and TTS overlapped; their durations must not be added as serial phases.

## Observed failures and recoveries

| Finding | Actual behavior | Intervention / remaining action |
| --- | --- | --- |
| Invalid initial plan claimed complete | Questions on pages 1, 3, 6, 7 and 10 were absent from visible text. Page 10 substituted Goodbye Song for the requested Hello Song. Generic file/JSON checks did not establish product validity, and the review UI could not approve this draft. | **Operator correction 1.** A normal Chat instruction required actual workflow validation and the original song placement. The model then repaired the draft, including recovering its own JSON syntax/schema errors. Add a validated plan-submit transition; a generic file write or JSON parse must not count as a successful plan. |
| Deferred tools / invalid requirements and TodoWrite arguments | Initial workflow and TodoWrite calls were unavailable before discovery; one requirements update used stale expected settings; TodoWrite also used `items` instead of `todos`. | Model recovered without an additional operator prompt. Tool discovery and argument construction remain avoidable overhead. |
| Narration batch partially failed | Nine pages saved. Page 8 failed with `Attention anchor must occur exactly once in its speech`. | Automatic retry saved only page 8. Other successful pages were preserved. This was a per-page business failure, not a tool-level `isError`. |
| Music model mismatch | Two calls returned `COURSEWARE_CANVAS_MUSIC_MODEL_UNAVAILABLE`. | Rejected before a paid generation POST. The model read the music catalog and selected the configured model. Three generation and three export POSTs subsequently succeeded. |
| Invalid TTS batches | Two calls returned `Invalid saved TTS batch` when the requested IDs did not satisfy the page batch contract. | Rejected before purchasing those invalid batches; the model corrected its requests. Exactly 215 actual TTS POSTs corresponded to 215 saved speeches. |
| Completion read/compaction loop | Host was ready at 02:38:42. Nine successful ready-context results were observed through 02:43:52, without new media work. Each serialized tool message was approximately 338,000 characters. Five more compactions completed after the first ready result. | **Operator intervention 2:** normal product stop at 02:44:23. All saved content remained intact. The loop did not end itself. |
| Non-blocking teaching diagnostics | Host quality retained sixteen `FOCUS_MISSING` diagnostics on page 6, with `blocking: false` and `status: needs-review`. | Reported as unresolved quality, not waived or called full pedagogical acceptance. Existing audio was preserved. |

There were **11 tool-level errors**: workflow read 2, requirements update 1,
TodoWrite 2, Bash 2 and media preparation 4. These include tool discovery,
validation and authoring failures; they are not eleven failed media orders.
The separate page-8 narration failure must not be lost because its outer tool
call succeeded. There were eleven completed compactions across the run.

### Why the terminal guard did not close this run

The observed sequence was repeated `courseware_workflow_get` plus full-deck
`courseware_media_context`, followed by compaction and another status check.
The source has two relevant properties:

1. [Workflow tools](../../../packages/agent-runtime/src/courseware-workflow-tools.ts)
   serialize the complete returned media context into model-visible text.
   Selecting a model catalog kind still returns the deck's teaching actions.
   Final status checks therefore repeatedly reintroduced a large payload.
2. [CoursewareTurnContinuation.finish](../../../packages/agent-runtime/src/courseware-turn-continuation.ts)
   observes tool results but returns before saved completion handling whenever
   the assistant message contains tool calls. The bounded reporting state is
   reached later through `finishSaved`, after a model turn without tool calls.
   The repeated tool/compaction path never reached that reporting transition.
   [Runtime](../../../packages/agent-runtime/src/runtime.ts) only enforces the
   no-more-tools reporting fence after that state has been set.

This supports a concrete remaining design gap rather than a supplier outage:
terminal completion must be recognized at the tool-result boundary, and final
status should use bounded summaries with page-scoped details on demand. The
regression needs real-sized saved actions, deferred tool discovery, automatic
compaction and a model that continues status calls after Host readiness. It
must prove a bounded final report without requiring the model to first choose
to stop calling tools. A new prompt alone would not establish that guarantee.

These are follow-up findings, not additional fixes claimed by this report.

## Media submissions and concurrency

| Kind | Actual generation/export POSTs | Maximum observed HTTP overlap |
| --- | ---: | ---: |
| Images | 10 | 1 |
| Layer decomposition | 10 | 1 |
| TTS | 215 | 10 |
| Music generation | 3 | 1 |
| Music export | 3 | 1 |
| Video | 0 | Not exercised |

The monitor recorded 1,753 courseware HTTP responses, all HTTP 200, and no
transport exceptions. HTTP success does not erase the tool/business failures
above. Observed HTTP overlap ends at response headers, so it is **not** a
measurement of asynchronous supplier-job occupancy. This run exercised the
TTS cap of ten; lower observed overlaps do not prove the other configured caps
under saturation. A saved layer-queue snapshot also showed five submitted
requests and a sixth still prepared, before queue admission.

No extra media POSTs were observed during the final completion loop. No
manual paid retry, application restart or replacement order was needed.

## Artifact and native-save validation

Final portable project directory:

```text
/home/jhz/code/train/deckwise-desktop/apps/courseware-copies/c2a0fa7f-633b-4152-8d34-465d37589f39.deckwise
```

It contains `lesson.pptx`, `lesson.teaching.json` and `media/`. Playback needs
the complete directory; the PPTX alone does not contain the separate teaching
timeline and all its media.

Independent checks passed before and after one ordinary native PPT save:

- Valid PPTX ZIP, ten slides and 96 picture objects across slides; each slide
  contains multiple editable picture objects. This does not claim editable
  native text for text rendered inside illustrations.
- Exact saved education settings, approved teaching mapping, questions and
  answer structures; songs only at the requested pages 1, 9 and 10.
- All 215 detailed speech IDs and texts preserved through media generation.
- All speech audio saved, three playable music clips, no unresolved slots.
- All 218 referenced media present, with matching file length and SHA-256;
  each has a positive finite duration from `ffprobe`.
- 252 visual cues have valid bounds within their saved speech-audio duration.
- Native save changed PPTX SHA-256 from
  `d991aac85775328f25b069c38c9b276ff56cda8f43b5eddaaa9cb033e0e51456`
  to `0dbf49db8fe11b6bfe01d76587f0965a222a2fb122f8f14f58bcfe24e3be8b74`.
  The logical project ID, complete saved pages/actions, education settings and
  complete media manifest remained identical. The portable identity and source
  hashes matched the new PPTX bytes.

This native-save check covers **already adopted** media. It does not establish
live pending-order rebinding, which was covered only by the earlier local
regressions.

## Evidence and limits

Local evidence directory: `/tmp/deckwise-live-rerun-20261101-systemic`.
Key files are `task.json`, `approvals.jsonl`, `interventions.jsonl`,
`events.json`, `network.jsonl`, `run-summary.json`, `last-host-context.json`,
`native-save-validation.json`, `portable-validation.json` and `final-ui.png`.
Evidence contains full generated teaching data and local paths; temporary
evidence is not durable CI storage. The validated portable directory is the
deliverable. The app was left running on this task; the temporary observer,
network wrapper, polling process and loopback Node inspector were removed.

No business-code change was made, so previous unit/build results were not
relabelled as checks executed in this run. Validation here was the real paid
user path, exported-file assertions, `ffprobe`, ZIP/XML checks, before/after
native-save equality and evidence/links checks for this report.

Not exercised: video generation, publication, provider outage/unknown-order
recovery, pending media during native save, saturation of every independent
queue, packaged-app portability, full interactive player playback or listening
to every audio clip. The earlier supplier-side TTS HTTP-500 problem did not
recur; this run does not prove that outage path is fixed. Visual previews were
reviewed, but there was no complete human pedagogical/audio sign-off. The
sixteen focus diagnostics remain outstanding.
