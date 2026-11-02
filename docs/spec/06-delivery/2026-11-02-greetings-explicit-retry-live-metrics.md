# Greetings live rerun after explicit retry and MAIC alignment

Status: planning validated; awaiting actual human plan approval. This is a partial measurement, not a completed courseware delivery.

## Run identity and scope

- Captured on 2026-11-02, with all timestamps in UTC.
- Session: `330064ad-19d0-480f-8729-30ee6a69a914`.
- Current user-selected model: `deckwise-managed / deepseek-v4-1-flash`, Agent mode, thinking off, automatic permissions. The previous full run used a different model; this is not a controlled model-to-model comparison.
- Original DOCX SHA-256: `de47e6aac08805b5ffc873184c39e7b15c076b12f12c8ba58b2af4426a0c8166`.
- Submitted: `2026-11-02T01:01:39.453Z`.
- First valid plan submission: `2026-11-02T01:09:23.456Z`.
- Validated plan SHA-256: `b18c72f2a7231a77cd31543dd1f764408d45d3f0c29be7d573fc29bc9deec097`.
- Evidence directory: `/tmp/deckwise-live-rerun-20261101-explicit-retry-maic/`.
- Running Desktop: task worktree `courseware-par-A`, HEAD `1ff749805a93702fac7e7e24b7a0dffc43adcb6f`, with existing local modifications. No application source was changed during this measurement.

The original task requests ten kindergarten senior-class bilingual English pages, 1200 seconds total, all five named IP characters, Hello/Hi/Good morning, Teddy Bear greeting, self-introductions, practice and games. It requires structured questions on every page, visible question/options, reference answers, Hello Song only on pages 1/9/10, layered editable PPTX, detailed narration, actual TTS/music, saving and adoption. Video and publication are excluded. Plan and first-page style approval remain human decisions.

## Measurements so far

| Item | Observed result |
| --- | --- |
| Submission to valid plan | 464.003 s (7 min 44.003 s) |
| Agent active time across three runs, including closing messages | 311.888 s |
| Idle gaps between those runs while Codex inspected and prepared interventions | 159.012 s |
| Agent first start to final planning answer end | 470.900 s |
| LLM client event windows, cumulative | 169.815 s over 58 responses |
| LLM window mean / p50 / p95 / maximum | 2.928 / 1.415 / 12.777 / 42.855 s |
| SDK responseDurationMs, cumulative | 157.777 s |
| Reported provider wait / model stream, cumulative | 68.270 / 102.605 s |
| Bash tools | 47 calls, 136.610 s cumulative; two 60-second timeouts |
| Write / Edit / Read tools | 2 / 2 / 2 calls |
| Explicit plan submissions | 2 calls, one rejected and one validated |
| Automatic correction/failure messages | 16 |
| Codex interventions | 3, all preserved with timestamps and exact messages |
| Image / decomposition / TTS / music generation requests | 0 / 0 / 0 / 0 |
| PPTX compilation, detailed narration, media adoption | Not reached |

LLM windows run from the captured `turn_start` to the corresponding assistant `message_end`. They include runtime/provider waiting and streaming, and exclude subsequent tool execution. This is client-visible elapsed time, not provider-internal compute. Windows are matched one-to-one with all 58 assistant responses. Durations from different categories must not be added to infer end-to-end latency. The valid-plan wall time includes investigation/intervention gaps and must not be presented as uninterrupted product execution.

The SDK duration fields disagree: one response has `providerWaitMs=12418` and `modelStreamDurationMs=364`, but `responseDurationMs=1705`; its observed event window is 12.777 seconds. The event window is the primary elapsed-time measurement. The wait and stream counters have their own anchors and should not be summed into an asserted exact response duration.

| Token category | Count |
| --- | ---: |
| Uncached input | 489,832 |
| Cached input read | 2,297,600 |
| Output | 18,833 |
| Cache write / reasoning | 0 / 0 |
| Total | 2,806,265 |

Usage is deduplicated by physical operationId across Agent events. Total equals uncached input + cached input + output + cache write; reasoning is not added again. These are reported tokens, not an audited currency bill. A separate Main title-generation request was aborted before a usage response and has no token count available; it is excluded. No automatic compaction was observed in this planning capture.

## Observed workflow issues

1. **Planning detection treats reads as edits.** In `packages/agent-runtime/src/courseware-turn-continuation.ts:75`, a successful `Bash` command mentioning a scene plan path sets planning state and may consume a pending repair budget regardless of whether it wrote anything. The initial run began by reading/searching a nonexistent new plan. Automatic submission then repeatedly rejected the missing plan, and later successful reads/searches counted toward the two-correction stop. This is a confirmed local logic defect. The previous repair-budget change did not fully cover shell read operations.
2. **The selected model repeatedly searched existing files instead of creating the requested new draft.** The first run ended without a plan after 79.465 active seconds. Explicitly loading the scene skill did not resolve the searches. Supplying the exact new plan path via a recorded steering message finally led to a draft. This required intervention and is not a successful unattended planning run. The Main source constructs the policy, skill and draft path in `deckWiseModelPrompt`; this capture does not prove which instruction the remote model attended to or that a relay dropped it.
3. **Draft correction changed the wrong lines and omitted visible questions/options.** Two Edit calls briefly broke JSON and left page 4/6/7/8/9/10 requirements unsatisfied. Page 10 also drifted into Goodbye teaching. The validator correctly blocked approval. A third intervention listed the missing items and requested one complete Write. The resulting draft passed both product validation and independent requirement checks. No invalid draft was approved.
4. **Plain-text DSML appeared at terminal/report boundaries.** In two failed planning responses, tool invocation markup appeared in assistant text after tools were removed. No tool execution was recorded for that text. The same behavior appeared in the older retry session. It must be reported as non-execution, not successful continuation; blindly executing model-emitted text would bypass tool/turn boundaries.
5. **Response-time telemetry is inconsistent.** See the concrete duration discrepancy above. SDK duration alone undercounts observed LLM waiting in this run.

Interventions are recorded as `intervention-1.json` (load scene skill and create the new draft), `intervention-2.json` (steer with authoritative path, stop repeated search, require honest document availability), and `intervention-3.json` (one complete correction for visible text and page-10 scope). This checkpoint records findings; it does not claim these newly observed defects were repaired in source.

## Separate recovery of the previous failed pages

The user had already requested retries for pages 1, 7 and 9 in session `7a982847-f046-449a-b766-a829c54a65aa` at `2026-11-01T14:30:38.054Z`. These observations are kept separate from the new run.

- All three explicit retry calls created durable successor requests. The earlier refusal to retry after a user stop did not recur.
- All successors used the canonical MAIC decomposition prompt with no appended instructions and the reported configured model `doubao-seedream-5-0-pro-260628`.
- All three ultimately failed with `UPSTREAM_HTTP_400`, `feeState=released`, `actualPoints=0`; 26 reserved points per request were released.
- Tool-start to first observed terminal receipt: page 1, 128.784 s; page 7, 123.773 s; page 9, 118.842 s. These are client recovery windows, not measured provider runtimes.
- Recovery produced 5 LLM responses, reported response durations totaling 14.828 s, and 719,734 reported tokens, including the final plain-text DSML response.
- No HTTP observer was installed at the start of those already-running retries. Actual provider start/completion time and diagnostic response body are unavailable.
- HTTP 400 alone does not establish an upstream outage or the exact request defect. Remote gateway deployment of the local JPEG quality-95 normalization/MAIC parameter change was not verified. Restarting Desktop is not evidence of remote gateway deployment. No additional paid recovery attempts were made during this measurement.

Persisted receipts and timing are in `recovery/session-transcript.json` and `recovery/summary.json`.

## Validation and continuation

`check-plan.py` passes: exactly 10 pages, sum 1200 seconds, music pages exactly 1/9/10, all required question/options visible, visible-text bounds respected, and page 10 no longer replaced by a farewell topic. All five IP English names and the requested greetings remain represented. The real `courseware_scene_plan_submit` returned `validated:true`. The plan remains unapproved; zero image intents exist at this checkpoint.

Assertions also verify token arithmetic, operation/message cardinality, matching LLM event windows, original source hash and independent session creation. This run changed no application source, so build/unit suites from the earlier fix were not repeated.

Actual human plan approval is required next. First-page generation and actual human style approval follow. Only then can the authorized remaining generation, decomposition, compilation, narration, TTS/music, saving and adoption be measured. No latency or success is claimed for stages not reached.
