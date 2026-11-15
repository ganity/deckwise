# Greetings courseware: measured rerun after the terminal fix

## Outcome

This run did **not** produce a complete course. The approved ten-page plan and
all ten original visual masters survived, but only seven pages have adopted
decompositions. Pages 1, 7 and 9 repeatedly failed with `UPSTREAM_HTTP_400`.
Compilation correctly rejected the incomplete assets with
`COURSEWARE_SCENE_GENERATION_ASSETS_REQUIRED: scene-001`. Detailed narration,
TTS, music, portable export and native-save validation were not reached.

The Agent ended at 11:56:11.394 UTC after **26 min 7.364 sec** from submission.
Its last response was a progress message about regenerating visual masters,
not the requested final blocker report. No completed-course report loop was
observed, but the successful Host-ready terminal path was not exercised.

## Identity and evidence

- Task session: `7a982847-f046-449a-b766-a829c54a65aa`.
- Source Codex session: `01a196a3-ab8f-78f2-9550-24485b3a9653`.
- Existing request worktree: `deckwise-desktop-worktrees/courseware-par-A`,
  branch `feat/courseware-par-A`, HEAD
  `1ff749805a93702fac7e7e24b7a0dffc43adcb6f`. This is a dirty-worktree live
  observation, not acceptance of a clean commit or integration candidate.
- Model: `doubao-seed-2-1-turbo-260628`, Agent mode, thinking off.
- Original DOCX SHA-256:
  `de47e6aac08805b5ffc873184c39e7b15c076b12f12c8ba58b2af4426a0c8166`.
  The imported source was rehashed and still matches.
- Approved plan SHA-256:
  `383ecd9db73d1bb17a76e18482a1952caea013a5b3d77dbab89535342609dabf`.
- Evidence directory:
  `/tmp/deckwise-live-rerun-20261101-terminal-fix-metrics/`.
  Main files: `task.json`, `events.json`, `session-transcript.json`,
  `network.jsonl`, `network-metrics.json`, `final-metrics.json`, `latest.json`,
  `interventions.jsonl`, `approvals.jsonl`, `capture-closed.json`,
  `final-ui.png`, the approved plan and ten original image previews.
  Raw evidence is temporary local data and is not committed.
- Requirements retained: kindergarten senior class, bilingual English,
  at most ten pages, 1,200 planned seconds, all five named characters,
  visible questions and choices, Hello Song only on pages 1/9/10, no video
  or course publication.

All times below are UTC on November 1, 2026; add eight hours for Shanghai.
The run was submitted at **19:30:04.030 Shanghai time** and the Agent ended
at **19:56:11.394**. Evidence capture closed at **20:08:29.089**.

## Stage timings

| Stage | Measured result | Duration / latency |
| --- | --- | --- |
| Full observed Agent run | Submission to final `agent_end`, including reviews and corrections | 1,567.364 sec / 26 min 7.364 sec |
| Planning | Submitted 11:30:04.030; corrected plan accepted 11:35:45.141; approved 11:36:26.223 | 341.111 sec to acceptance; 382.193 sec to approval |
| Chat LLM | 46 completed responses with SDK `responseDurationMs` | 683.493 sec cumulative; mean 14.859 sec; p50 11.078 sec; p95 24.234 sec; max 75.206 sec |
| Context compaction | One request, 11:48:48.930–11:49:19.045 | 30.115 sec wall time, separate from the 46 response durations |
| Original master images | 10/10 ready, 11:36:48.629–11:39:53.317 | 184.688 sec batch span; mean 37.784 sec; p50 36.587 sec; p95 45.471 sec |
| All master image requests | 13/13 ready, including three replacement images | Mean 36.353 sec; 472.585 sec cumulative job latency |
| Successful decompositions | 7 ready | Mean 107.601 sec; p50 110.335 sec; p95 127.866 sec; range 82.223–127.866 sec |
| Failed decompositions | 7 failed attempts on pages 1/7/9 | Mean 119.035 sec; range 99.622–144.719 sec |
| Entire decomposition attempt window | First POST 11:40:57.052; last failure 11:54:54.074 | 837.022 sec / 13 min 57.022 sec, including retry gaps |
| Compile | One call, 11:55:03.382–11:55:05.552 | 2.170 sec; rejected before producing a deck |
| Detailed narration / TTS / songs | No generation calls | Not run; no latency claim |

Image/layer job latency is client-observed POST start to the first observed
terminal receipt. It includes gateway, supplier, polling and transport delay;
it is not supplier execution time. The batch spans overlap other work and
must not be added to LLM cumulative durations as an end-to-end total.
Observed outstanding async-job peaks were five images and five decompositions.
The observer's separate HTTP-overlap counter ends at response headers and is
not a measurement of async generation concurrency.

The runtime also emitted 427.802 seconds of aggregate `providerWaitMs` and
309.683 seconds of `modelStreamDurationMs`. These use different runtime anchors
from SDK `responseDurationMs`; they do not reconcile as a partition of the SDK
total and are not added to it.

## LLM token accounting

Physical `operationId` deduplication across usage events, assistant messages
and nested aggregates gives **47 operations**: 46 Chat responses and one
compaction. Cache reads are a separate input category, counted once.

| Category | Tokens |
| --- | ---: |
| Uncached input | 687,495 |
| Cache-read input | 2,879,080 |
| Output | 22,989 |
| Cache writes / reasoning | 0 / 0 |
| Total, including cache | **3,589,564** |

The compaction is included in those totals: 76,394 input and 1,342 output,
77,736 total. The separate Main one-shot title request took 1.838 seconds
and used 502 input + 6 output = 508 tokens. Including that ancillary title
request gives **48 observed operations and 3,590,072 tokens**. The Main observer
is not a second capture of the sidecar Chat requests. Monetary values in Chat
usage are estimates, not an audited provider bill, so no currency total is
claimed.

## Media requests and retry cost exposure

| Kind | Unique generation POSTs | Terminal receipts | Adopted result |
| --- | ---: | --- | --- |
| Master images | 13 | 13 ready, fees settled | Original ten adopted; three replacement images left unadopted |
| Image decomposition | 14 | 7 ready/settled, 7 failed/released | Pages 2/3/4/5/6/8/10 adopted |
| TTS / music / video | 0 / 0 / 0 | None | None |

The fourteen decomposition calls comprise the original ten plus four new
attempts: page 1 twice more, and pages 7/9 once more each. Ordinary repeated
prepare calls with unchanged parameters reused the original failed intent;
they did not make a new paid request. Changing instructions created new
requests, which failed again. These are explicit new attempts, not evidence
that a single request was charged twice.

| Page | Attempt | Gateway task | Failure latency |
| --- | --- | --- | ---: |
| 1 | Original | `gw-2dd1a220-cf44-40b6-9eda-e1d404bf6a04` | 122.181 sec |
| 7 | Original | `gw-381773e9-3272-4464-94aa-bd61fb64f810` | 144.719 sec |
| 9 | Original | `gw-136580af-96ad-4e33-a7d1-f8c87dda4b35` | 99.622 sec |
| 1 | Retry | `gw-cb397744-053b-4c74-94d9-86459d58d5e1` | 110.084 sec |
| 7 | Retry | `gw-fbc5b462-d96b-4862-b909-cdf7a16a8d82` | 120.187 sec |
| 9 | Retry | `gw-bb56a1e8-086c-4a72-98b0-5cb26c7e15a6` | 127.132 sec |
| 1 | Second retry | `gw-0afffd90-d54b-4cd1-ad3d-58bdd993b87e` | 109.323 sec |

Every failed task ended with `UPSTREAM_HTTP_400` and `feeState: released`;
the model-visible refresh receipts report `actualPoints: 0`. The three
replacement master image requests all ended ready with settled fees. A
separate account-balance reconciliation was not performed.

## Problems observed

1. **Planning did not recover unattended.** The initial plan omitted visible
   question text and substituted farewell content on page 10. Its Edit repair
   removed a required `visualIntent`, and the subsequent submit tool was
   unavailable. The first Agent run ended after 153.320 seconds. One normal
   Chat correction at 11:33:31.374 restored a full plan. Independent checks
   pass for ten pages, 1,200 seconds, verbatim visible questions/options and
   Hello Song slots only on 1/9/10. This is plan validation, not proof of
   generated audio or full visual fidelity.
2. **Failed-job recovery wasted calls and new attempts.** Unchanged prepare
   reused failed intents, then altered instructions produced four new
   decomposition jobs. All four also failed. Seven independent successful
   page decompositions were retained. Captured receipts have no upstream
   error body explaining the 400, so the supplier-side cause is unresolved.
   Changing a prompt or regenerating a master is not an established fix.
3. **The stop instruction did not fence new paid work.** A second corrective
   instruction was queued at 11:53:51.971 and delivered through Send now at
   11:55:48.286. Page 1's replacement image POST had already started at
   11:55:37.258, but page 7 and page 9 replacement POSTs started afterwards,
   at 11:56:03.740 and 11:56:09.049. Thus two new settled requests followed
   delivery of an explicit instruction to stop creating requests. The last
   Agent response is progress narration, not a final blocked handoff.
4. **Incomplete compilation was attempted and correctly rejected.** This
   preserved the asset-completeness requirement but added an avoidable tool
   failure; no complete editable PPTX was generated.
5. **Idle UI continues polling terminal tasks.** Between `agent_end` and
   12:08:27.616, the observer recorded 2,439 GETs over 736.222 seconds,
   repeatedly including failed/released decompositions and ready replacement
   images. This is UI/background status traffic, not repeated LLM completion
   reports. It remained an observed product issue; capture cleanup restores
   temporary observers, not application polling behavior.
6. **Tool discovery and arguments still have friction.** There were 92 tool
   calls and six tool-level errors: unavailable workflow tool 1, missing plan
   file read 1, stale requirements update 1, rejected/unavailable plan submit
   2, and incomplete compile 1. Seven supplier decomposition failures were
   business failures inside otherwise successful outer tool calls. Media
   gateway HTTP responses had no observed status >=400; `UPSTREAM_HTTP_400`
   was in the task receipts. Two later idle GETs had transport exceptions
   at 12:01:00.580 and 12:01:03.353; later reads still showed terminal tasks.

Normal plan and cover approvals are excluded from the corrective-intervention
count. There were two corrective Chat interventions. The first recovered
planning; the second bounded further work imperfectly and did not yield the
requested blocker report.

## Validation and cleanup

Executed against the captured live run, without dispatching new generation:

```bash
python /tmp/deckwise-live-rerun-20261101-terminal-fix-metrics/check-plan.py
python /tmp/deckwise-live-rerun-20261101-terminal-fix-metrics/summarize.py
python /tmp/deckwise-live-rerun-20261101-terminal-fix-metrics/network-summary.py
python /tmp/deckwise-live-rerun-20261101-terminal-fix-metrics/final-metrics.py
```

The approved-plan check passes. Final assertions verify event/transcript usage
agreement, unique physical operation accounting, exact cache-inclusive token
totals, original-source hash, all 27 terminal task receipts, released failed
reservations, ten selected masters, seven selected decompositions, failed
compilation, and an idle Agent. The final UI screenshot was visually inspected
and shows the failed compilation and preserved plan/images.
The new report passes its scoped whitespace and metric-consistency checks.
A worktree-wide `git diff --check` still flags a pre-existing blank line at
EOF in `apps/desktop/electron/main/courseware-video-placement.ts`; that unrelated
modified file was not changed in this reporting phase.

Temporary Electron `net.fetch`/Main `fetch` wrappers and the renderer capture
subscription were removed in reverse installation order. `capture-closed.json`
records no in-flight observed media HTTP requests at closure. No new paid
generation, source-code fix, direct database edit, restart, commit or push was
performed during the resumed reporting phase. Only this report was added to
the repository.

Full build/unit/integration suites were not rerun for this report-only change.
No successful-course terminal acceptance, narration, TTS, songs, playback,
portable export or native-save validation is claimed. Upstream decomposition
failures and the retry/stop/polling defects remain open; the application holds
an incomplete course, not a deliverable lesson.
