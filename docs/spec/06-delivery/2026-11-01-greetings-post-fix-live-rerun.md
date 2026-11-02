# Greetings courseware: live rerun after restart (2026-11-01)

## Outcome

The restarted desktop app produced a ten-slide course, ten saved questions, 225
saved speech audios, and three Hello Songs on slides 1, 9, and 10. Host completion
returned ready with no missing requirements at 08:56:10 UTC. The exported project
copy passed independent PPTX, teaching, media-reference, hash, and ffprobe checks,
including after an ordinary native PPT save.

This was **not an unattended workflow pass**. Two accepted Chat interventions were
needed during planning, and the operator stopped a repeated final-report loop
6 minutes 21 seconds after Host became ready. Plan approval and cover approval
were the two normal review steps. The remaining quality advisory and editability
limit below should not be presented as full pedagogical or text-editing acceptance.

## Run and evidence

- Existing worktree: deckwise-desktop-worktrees/courseware-par-A, branch
  feat/courseware-par-A, HEAD 1ff749805a93702fac7e7e24b7a0dffc43adcb6f.
  The worktree had 232 pre-existing dirty entries; no business code was changed
  for this rerun. The running Electron app, Host, and Runtime were not restarted.
- New Chat session: 637a0627-6889-4c7d-8e4c-7c485a8c5351. Submitted at
  07:29:26.771 UTC using the original DOCX, whose imported 24,214 bytes matched
  SHA-256 de47e6aac08805b5ffc873184c39e7b15c076b12f12c8ba58b2af4426a0c8166.
  Model: doubao-seed-2-1-turbo-260628, Agent mode, thinking off.
- Requirements retained: kindergarten senior class, bilingual English lesson,
  ten pages, 20-minute planned duration, all five named characters, visible
  questions and choices, Hello Song only on pages 1/9/10, no video or publishing.
  Approved plan independently checked as 10 pages and 1,200 planned seconds.
- Final portable copy:
  /home/jhz/code/train/deckwise-desktop/apps/courseware-copies/576577b1-302d-46dd-81de-8909462dc3b9.deckwise
  (lesson.pptx, lesson.teaching.json, media/). Earlier, pre-native-save copy:
  /home/jhz/code/train/deckwise-desktop/apps/courseware-copies/e300f811-7b2d-4c24-9aad-7bfe8579c29a.deckwise.
- Instrumentation and assertions: /tmp/deckwise-live-rerun-20261101-post-fix/
  (events.json, network.jsonl, progress.jsonl, session-transcript.json,
  final-ui.png, plan-before-approval.json, portable-validation.json). The
  temporary network observer recorded paths, timings and sanitized receipts,
  never authorization headers or request bodies. No fabricated media receipt,
  fault injection, direct database write, replacement order, commit or push.

## What passed

| Check | Observed result |
| --- | --- |
| Structural plan | 10 pages, 1,200 planned seconds, visible question and every choice on every page, Hello Song slots on 1/9/10. |
| Visual workflow | 10 masters and 10 decompositions adopted; 103 picture objects in the compiled ten-slide PPTX. Transient unknown supplier states reconciled to their original jobs without duplicate paid submissions. |
| Narration recovery | First batch saved nine pages; page 7 failed its kindergarten English-command validator. An automatic page-7-only retry saved it; all ten questions and 225 generated speeches then existed. |
| Media | Exactly 225 TTS generation POSTs, 3 music generation POSTs and 3 music export POSTs; all 228 adopted assets have nonzero decodable duration and matching file hashes. There were 10 image and 10 layer generation POSTs. The observer saw no HTTP error or duplicate POST ID. |
| Host acceptance | ready true; audioMissing 0, audioReady 225, musicClips 3, musicPending 0, questions 10, pages 10; no blocking completion issue. |
| Portable copy and native save | Both copies have 10 slides, the same 103 picture counts by slide, all approved question and answer data, exact original speech IDs/text, 232 valid focus cues, all 228 media references and files. Native PPT save returned ok and the second copy revalidated. PPT SHA changed as expected from 8f17cd77… to dbbeba6a… while logical teaching and assets stayed intact. |

The total media playback duration is 710.184 seconds. The 1,200 seconds is the
approved **lesson plan**, including teacher-led games, questions and pauses;
it is not a claim that the audio itself is twenty minutes long.

## Problems observed

1. **Plan repair stops before a real correction.** The initial plan omitted
   visible questions/choices across all ten slides; page 9 also exceeded the
   six-string visible-text limit. Product validation correctly rejected it.
   Automatic validation after a file write counted once, explicit submit counted
   again, and an Edit parse error counted a third time, exhausting the two-repair
   allowance without a successful correction. The report-only turn then attempted
   a disabled Edit tool and ended without a useful final handoff. In
   packages/agent-runtime/src/courseware-turn-continuation.ts, planRepairs is
   incremented for failed validation calls, not for completed corrective edits.
   One normal Chat recovery at 07:33:40 UTC was required.
2. **Structural plan validation missed a semantic substitution.** The repaired
   ten-page plan passed product validation but made page 10 a Goodbye Song,
   contrary to the explicit Hello Song request. A second accepted normal Chat
   correction at 07:36:00 UTC changed that page to a Hello Song while preserving
   pages 1–9; normal plan approval followed at 07:37:14 UTC. Do not treat
   structural acceptance alone as evidence of all natural-language constraints.
3. **Model/tool argument friction delayed media.** Two music prepares selected
   an unavailable music model. The first TTS batch returned ten per-action
   COURSEWARE_MEDIA_PLATFORM_46003 failures inside a tool-level success; the
   model changed models and later saved those ten. Four more TTS prepare calls
   mixed action IDs from different pages and were rejected as Invalid saved TTS
   batch. One music refresh passed a batch intentIds argument although music
   refresh requires a single intentId. All were recovered without extra paid
   POSTs, but the contract was learned through errors rather than correctly
   followed from the available model catalog and tool schema.
4. **The completed Chat still did not close.** The final successful
   courseware_media_context ended at 08:56:10 UTC with completion.ready true.
   No more tools or compactions ran, yet the app appended **14 near-duplicate
   assistant completion reports**, remained running, and required the ordinary
   UI stop at 09:02:31 UTC. This is a narrower but still real terminal-loop
   failure than the prior rerun's repeated status reads. Source has a report-only
   stop path, but the observed runtime did not reach a natural agent_end here;
   the exact runtime branch responsible remains to be traced.
5. **Teaching quality advisory remains.** Host quality status needs-review
   contains one repairable, non-blocking FOCUS_MISSING on page 7,
   speech-fdc1d327-9d05-4bd0-92bf-1fc694daa5e5-40. The completion gate
   is ready, but synchronized focus on that speech is unverified. No automatic
   focus-repair tool call followed the final ready result in this run.
6. **PPT lettering is rasterized.** The final PPTX contains 103 individually
   editable picture objects but **zero native text shapes and zero text runs**.
   Picture layers can be moved or replaced; words baked into pictures cannot be
   edited as PPT text. This is a material limit of the requested editable PPT.

There were 11 tool-level errors: workflow discovery 1, plan submission 1,
Edit 2, media prepare 6, media refresh 1. Page-7 narration and the ten initial
TTS per-action failures were separate business failures inside successful outer
tool calls. Four compactions completed before final acceptance; none followed
the final ready context. The final model-visible media-context JSON was 40,264
characters, reduced from the old run's large full-deck payload but still not
trivial. A rejected local test helper at 07:32:21 UTC omitted required
fileReferences and was **not** an accepted user/Chat intervention or product
failure.

## Timing and limits

All timestamps are UTC on 2026-11-01 (add eight hours for Asia/Shanghai).
The real run included normal reviews, interventions, external generation and
network time; it is not a supplier-only benchmark.

| Milestone | Time |
| --- | --- |
| Submitted | 07:29:26.771 |
| Plan/cover approved | 07:37:14.275 / 07:39:33.586 |
| All masters / layers observed adopted | 07:42:39.671 / 07:53:31.036 |
| Compile start / end | 07:53:35.185 / 07:56:50.241 |
| First narration batch / page-7 retry completed | 08:02:29.179 / 08:05:14.445 |
| First / last TTS POST | 08:13:12.898 / 08:55:37.744 |
| First Host ready | 08:56:10.369 |
| Operator stopped repeated final reports | 09:02:31.204 |
| Final post-save portable validation | 09:07:49.202 |

From submission to Host-ready was about **86 min 44 sec**; the repeated-report
tail added about **6 min 21 sec** before operator stop. No end-to-end playback
or human listening, full OCR/proofreading of bitmap text, or pedagogical review
was performed. The non-blocking focus issue and raster text limit remain.
