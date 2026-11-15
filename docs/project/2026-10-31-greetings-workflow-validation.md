# Greetings workflow validation — 2026-10-31

## Run and scope

Fresh paid Desktop session: `18db21dd-8852-4f6e-b917-f6b83f6b61fa`, submitted
2026-10-31 15:41:41 Asia/Shanghai. Same DOCX bytes as the preceding lesson,
SHA-256 `de47e6aac08805b5ffc873184c39e7b15c076b12f12c8ba58b2af4426a0c8166`.
Kindergarten senior class, English, Chinese-led bilingual teaching, maximum ten
pages, five named animal characters, editable layered PPTX, detailed narration,
questions/reference answers, real TTS, and opening/closing Hello Song. No video
or publication. Independent caps: TTS 10, images 5, image layers 5, music 2,
music export 2, video 2.

Changes stay in the existing `feat/courseware-par-A` worktree. Preexisting dirty
changes are preserved. No new worktree, commit, push, or publication.

## Outcome

The fresh run did **not** pass full-course acceptance. Ten layered slides,
all ten detailed narration pages, ten questions/reference answers, 190 of 191
real speech clips, and all three saved music positions are present. The only
blocking Host acceptance issue is page 4 `AUDIO_MISSING`, corresponding to the
original unknown TTS below. No silent substitute or generated-status forgery
was used. Three music positions (pages 1, 9 and 10) were retained: opening,
whole-class song practice, and closing.

The ten-slide PPTX is 24,006,860 bytes with SHA-256
`c01a3e992a09f3cacd989f3190f005b9be86a5e00058f77abe033e77e5c7cffa`.
Its foreground picture counts are `[7,7,5,12,10,12,9,15,10,8]`, totaling 95
independently movable foreground picture objects, plus slide backgrounds.
Raster text carriers can move independently; this does not make their letters
native editable text.

Saved outputs:

- PPTX: `/home/jhz/code/train/deckwise-desktop/apps/.deckwise-ppt/generated/c01a3e992a09f3cacd989f3190f005b9be86a5e00058f77abe033e77e5c7cffa.pptx`
- Portable project directory: `/home/jhz/code/train/deckwise-desktop/apps/courseware-copies/82803e3d-e147-41ba-9949-19eaa92b2ebe.deckwise`

The portable directory contains `lesson.pptx`, `lesson.teaching.json` and 193
media files. Its project equals the saved project, its PPTX hash matches the
source, and every copied media hash/length matches its manifest. The missing
speech remains missing; portability verification is not completion acceptance.

## Findings

| Stage | Actual finding | Recovery |
| --- | --- | --- |
| Tool discovery | Two initially unavailable tools required ToolSearch | Model recovered; no paid submission |
| Requirement update | Two compare-and-swap rejections from incorrect expected education fields | Model reread and corrected; no lost task |
| Planning | First plan omitted structured teaching requirements and closing music; revision then used invalid teaching field shapes/enums | Manual review/schema guidance; repaired packaged skill example and tested it with the actual parser; corrected ten-page plan approved |
| Image generation | Ten visual masters generated/adopted | Supplier nonterminal overlap observed up to five |
| Layer generation | Original ten supplier tasks succeeded; pages 6/8 failed local aggregate archive limit | Two replacement tasks were already purchased by the model before manual pause; originals later recovered without another purchase |
| Archive | Original page 6 contains 13 images totaling 49,814,850 bytes; page 8 contains 16 totaling 53,880,541 bytes. Each image is within 8 MiB, but each group exceeds 44 MiB | Per-image transfer plus atomic metadata-manifest commit; actual original tasks archived after application restart |
| Resume ordering | Model tried compile before adopting archived pages 6/8; completeness guard refused | Model refreshed original intents, which adopted their complete groups, then retried compile |
| Detailed narration | 32 page attempts across ten tool calls: ten saved, 22 rejected (15 ambiguous/missing anchors, three JSON errors, three English-command count violations, one invalid command) | Successful pages retained. After repeated model retries, one manual steer corrected the invented quotation/visible-text anchor rule and explained the optional anchor field; final failed-page batch saved all three remaining pages |
| Music model selection | Model guessed `musicgen`; platform returned `46003` before an order was submitted | Model read the configured catalog and used `mxapi-music` |
| Music refresh parameters | Model omitted required `sourceSha256` once and later attempted unsupported plural `intentIds` for music | Tool schema rejected both calls before execution; these rejected calls created no orders |
| Duplicate music | Model changed page-1 music metadata and submitted another request while its original music/export already existed | Four generation orders and four export submissions were observed for three required positions; the original page-1 music was ultimately mounted. One additional manual steer directed original-job recovery |
| TTS original-result recovery | One page-4 synthesis returned `46016` (`UPSTREAM_OUTCOME_UNKNOWN`); local relay still reports `submission_unknown` | Remaining independent synthesis continues; refreshing this original intent has not produced audio and must not be counted as success |
| Final continuation | After all independent music was mounted, the running turn repeated successful music refreshes without resolving the unknown TTS | Manually stopped at 17:55:19; no automatic completion claim or unbounded observation was treated as recovery |

The earlier page-6 download probe saw only the first twelve images before the
old aggregate limit stopped it. Its 46,958,460-byte partial sum is not the final
group size. The live archive metadata above records the complete group.

## Archive and skill repair

Main validates the supplier's complete layer layout, downloads and validates one
image at a time, stages it through the existing private Host RPC, and sends a
small final manifest. Host checks task provenance, dimensions, hash, target and
bounds, then publishes the complete intent group in one journal save. Partial
staging survives restart as immutable private files without publishing a ready
asset. Missing or changed files fail validation; repeated final commit remains
idempotent. Original bytes and placement/z-order are retained. Existing single
image 8 MiB, inline bundle 44 MiB, layout count, and Host RPC frame limits remain.

The packaged scene skill now supplies a parser-valid teaching example and exact
field/enum contracts, and requires a workflow read before plan approval. This
improves guidance; Host acceptance remains the authority. It cannot guarantee
that every future model output will be valid without recovery.

It also records the actual optional-anchor and candidate-block contracts, so a
future retry need not invent quotation markers or confuse classroom command
blocks with the lesson's English vocabulary. This is guidance, not a new
programmatic guarantee of valid model output. The live narration needed manual
steering and therefore does not prove unattended robustness.

## TTS recovery gap

The affected page-4 speech is `粉色小猫会喵喵喵地叫。`, action
`speech-c6283004-a59f-47b6-b13c-43a78deed08a-16`, intent
`e2aa1ed6-05e4-4e01-b09b-529e1b6f7bf1`. The original idempotency key is
`678bac46-6c9f-40d3-bd32-1ed4b1a6f8fe`. After a refresh, Host has a local task
reference, but the relay task remains `submission_unknown`; this is not a
recovered supplier result.

Read-only inspection of the corresponding Platform/MAIC worktrees found that
the synchronous TTS chain returns audio directly, without a durable result
record or a lookup by the original idempotency key. Platform reserves points
before forwarding; an exception leaves the reservation and marks the upstream
outcome unknown. Repeating the forwarded key is rejected rather than replaying
a saved result. The existing receipt-based query does not recover a TTS request
whose response receipt never arrived.

This is a service recovery/transaction gap, not a skill-format issue. A complete
future repair needs durable original-request/result storage, idempotent result
lookup/replay, and a reconciled terminal billing outcome before any authorized
replacement. No server deployment, billing change, database edit or replacement
purchase for this unknown TTS was performed in this validation run.

Other programmatic gaps remain: changed cosmetic music parameters can evade
request-level deduplication for the same teaching slot; narration retries still
depend on model correction; continuation does not reliably distinguish an
unrecoverable unknown request from productive pending work. Slot-level reuse,
bounded typed repair, and a visible no-progress/unknown terminal handoff are
needed in addition to the service recovery repair. These were observed, not
claimed fixed by the archive/skill changes.

## Milestones and intervention accounting

Times below use Asia/Shanghai. They include review, diagnostics and code repair,
not just supplier processing; overlapping phases must not be added together.

| Milestone | Time |
| --- | --- |
| Submitted | 15:41:41 |
| Corrected ten-page plan approved | 15:52:34 |
| Cover style adopted | 15:54:47 |
| Manually paused to stop replacement purchases and repair archive transport | 16:09:10 |
| Same task resumed after build/restart and original-result recovery | 16:43:16 |
| Editable PPTX compiled | 16:48:30 (successful compile call: 196.238 seconds) |
| Manual narration contract steer, without pausing | 17:04:07 |
| All detailed narration saved | 17:06:02 |
| Manual existing-music recovery steer, without pausing | 17:48:40 |
| All three required music clips mounted | 17:51:42 or earlier, observed in saved state |
| Final Host acceptance read | 17:51:57, `ready:false`, only page-4 audio blocking |
| Stopped repeated execution with unresolved original TTS | 17:55:19 |
| Portable project saved | 17:56:40 |

One explicit pause/resume pair took approximately 34 minutes 5 seconds. Three
planning review/schema steering messages, one narration steering message and
one music recovery steering message are
additional manual interventions, not autonomous recovery. Normal plan and cover
approvals are separate review actions. The two replacement decomposition orders
were purchased before the pause; neither was necessary for final selection.
Manual archive diagnostics/recovery queried original tasks and incurred no new
generation purchase. There was also one final manual stop without a resume to
end repeated execution after independent work finished. It is not a second
pause/resume pair. Total: one pause/resume pair, five corrective steering
messages, and one final stop; the normal review approvals are additional.

Submission to final stop took 8,018.152 seconds (2h 13m 38s). The explicit repair
pause was 2,045.269 seconds (34m 5s); excluding only that pause leaves 5,972.883
seconds (1h 39m 33s), still including model planning, review, retries and checks.
These are wall times, not pure supplier processing times. Portable export and
final report checks occurred after the stopped generation interval.

Credential-free HTTP observations recorded 10 image, 12 layer, 191 TTS, four
music and four music-export POSTs. All TTS actions had exactly one submission,
including the single unknown outcome. The observed nonterminal image/layer
task peaks were five each; TTS HTTP overlap peaked at nine under the configured
ten limit. HTTP overlap ends at response headers and is not a complete remote
occupancy measurement. Music/video limits were not load-tested by this run.
TTS POST latency median was 1,301 ms; the unknown request took 180,175 ms. Many
ten-action TTS calls took about 70 seconds including parsing, checks, archive and
adoption. This exposes end-to-end overhead; its detailed cause needs profiling.

## Validation

- Desktop scene images and scene plan: 54 tests passed, including the new
  over-44-MiB streaming regression and executable skill example.
- Host scene images: 25 tests passed, including legacy inline archives, streamed
  partial staging/restart, failed manifest, and idempotent commit.
- Generation queue: five tests passed for retained asynchronous slots, FIFO,
  cancellation/ownership, and unknown-result handling. These exercise queue
  behavior, not a full live load test of every configured media category.
- Desktop typecheck, lint, production build and Host debug build passed.
- Normal Host clippy completed with existing warnings. Strict `-D warnings`
  failed on 13 existing warnings in other modules; no unrelated cleanup made.
- Incremental patch applies in reverse to the current tree; unrelated branch
  modifications are excluded from its recorded baseline.
- Live Desktop successfully archived both original large layer groups after
  restart and compiled the ten-slide PPTX.
- All 193 adopted media files passed SHA-256 and ffprobe decoding/duration
  checks; all 172 saved visual cue intervals fit their adopted speech audio.
  Each of the ten pages retains its question and reference answer.
- Strict full-course validation failed on the missing page-4 TTS, consistent
  with Host `completion.ready:false`; that failure was retained as evidence.
- Host also reports 11 non-blocking `FOCUS_MISSING` issues on pages 4/5.
  No full motion/audio playthrough or automatic answer-grading claim is made.

Evidence: `/tmp/deckwise-live-rerun-20261031-guarantees`, including task/source
validation, transcript-derived status, credential-free network observations,
manual interventions, red/green tests, pre-edit snapshots, and incremental patch.
