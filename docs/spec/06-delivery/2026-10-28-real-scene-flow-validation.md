# 2026-10-28 latest saved scene task: real validation

## Latest result — 2026-10-28, after the finite-relay deployment

**The same five-page task now passes real audio generation, adoption, fixed-build creation and complete local teaching playback.** The sections below this result are historical diagnosis; their earlier catalog/missing-table blockers are superseded. This is continuation of the existing real visual/narration results, not a new full image-generation run. No production schema migration or publication was performed.

- Session: `8dacf595-520c-40c3-8a8f-cd9429352554` (unchanged).
- Generated and adopted **44/44 real Doubao TTS segments** (8, 11, 15, 6, 4 per page), using `doubao-tts` and `zh_female_yingyujiaoxue_uranus_bigtts`.
- Generated real **Hello Song** via `mxapi-music`; retained both supplier candidates and adopted one completed, free MP3 export. The workflow and audio bytes are journaled in Desktop Host SQLite. Platform relays finite requests and keeps existing authentication/billing records; it does not own the generation workflow or media-task/candidate tables.
- Independently decoded and checked SHA-256 for all **45 audio files**, totaling **361.296 seconds**. Production `MEDIA_RELAY` billing: 44 successful TTS requests / 44 points; 1 successful music request / 2 points; 1 successful export / 0 points. Total **46 points**. No additional supplier submissions occurred during playback.
- Preserved the six legacy unknown intents. Verified the old failure occurred at `MediaTaskService`'s initial missing-table lookup, before provider submission; completed those six speeches with separate explicit native-editor TTS attempts and normal quote, submit, archive and adopt APIs. No direct SQLite modification, fabricated result or replay of an ambiguous supplier POST.
- Preserved original PPTX SHA-256 `ee525a677067054be22aa306a3ee64a9fba5484c8e0180a44adac1307727953b`, 12,021,133 bytes, all five pages and narration text. Supplier text layers remain images.

Final actual `courseware_media_context` read confirms all five pages and the project have `narrationReady=true`, `audioReady=true`, `teachingReady=true`, with `jobs=[]`. The original session now contains the updated verification status; its agent is idle with no pending confirmations.

### Actual playback acceptance

Captured immutable snapshot `87077412-8fec-4acb-a605-ac6a16ceb265` at teaching revision `85fba36b-6933-4cb2-9695-d6bad4c82c1a`. Built package SHA-256 / build ID `91b0e22b6792abb717092d811027a1089e57d6b103c910283774ae7c27d1f27b`.

Opened the actual sandboxed Electron courseware player, clicked Play, and let the entire lesson run at normal speed, without seeking/skipping or replacing audio. All **5 pages advanced in order**; all **45 audio elements reached natural `ended`**, with actual current time reaching duration; all **3 teacher interaction checkpoints resumed**; the final page displayed **播放完成**. No renderer exception, media error or HTTP request was observed during the playback interval. Test automation clicked “教师继续” to simulate the teacher, without answering on behalf of a student.

Observed all **7 spotlight + 5 highlight** overlays in the DOM with nonzero bounds and mapped targets. Independently matched all **21 animated targets** against packaged cue/object mappings and observed changing real style values: **5 fadeIn + 16 pulse**. Visually reviewed player screenshots of first/middle/last pages and an active highlight. These are player teaching effects, not a claim that all PowerPoint-native animation/transition types are supported.

The build retains `visualFidelity: NOT_VERIFIED` and reports `PPTX_NOTES_MASTER_UNVERIFIED`. This warning concerns notes-master layout/style preservation; generated narration is stored in teaching data. Reviewed that exact warning for the local test preview; did not certify notes-master fidelity.

### Playback blocker fixed during validation

The real persisted project passed `packages/shared` validation but failed the player's vendored canonical validator because it lacked `educationContext.visualStyle`. Removing only that field made the old validator pass, confirming the root cause. Refreshed the canonical contract and fixtures from the shared source as one unit, updated source hashes, and extended the adapter regression test with the real `2D 卡通` style plus invalid type/length rejection. No field was stripped from the user's project.

The manual development launch also needed its existing `DECKWISE_PPTX_WORKER` environment variable pointed at the staged worker; this was a test-launch correction, not a production code change.

### Checks and reproducible evidence

- Targeted canonical adapter: **19 tests passed**.
- Courseware runtime TypeScript check, runtime build and Desktop production build: passed.
- Broader runtime test run: **364 passed, 28 failed, 1 skipped**. The 28 failures are confined to two fixture-dependent suites: 25 require an absent absolute-path historical team audio fixture; 3 fail pinned worker verification because `.worker-desktop-02` lacks files listed in its manifest. These fixtures were not reconstructed or silently substituted. Actual playback used the complete staged Desktop worker.
- Local report/evidence: `/tmp/courseware-relay-real-audio-evidence.json`, `/tmp/courseware-real-player-evidence.json`, `/tmp/courseware-real-player-check.log`, `/tmp/courseware-real-build-approved.json`, `/tmp/courseware-real-runtime-tests.log`.
- Player screenshots: `/tmp/courseware-real-player-page-{1..5}.png`, `/tmp/courseware-real-player-active.png`, `/tmp/courseware-real-player-complete.png`.
- Audio-complete SQLite backup: `/tmp/deckwise-real-relay-audio-complete.sqlite`.

Not covered: new image/decomposition submissions (existing real outputs reused), subjective pronunciation/music quality listening, unplanned video generation, publishing, and arbitrary Office animation fidelity.

## Historical runs (superseded where noted)

## Scope and verdict

Session `8dacf595-520c-40c3-8a8f-cd9429352554`, existing approved kindergarten English scene task, **5 pages**. Reused existing real provider results; did not regenerate or pay for duplicate visual masters or decompositions. This is a continuation test, not a new paid image-generation test. No publication performed.

**Partial pass; full teaching playback is blocked.** Do not describe this run as a completed end-to-end test.

## Actual results

- Archived and adopted 50 real assets: 5 visual masters and 45 decomposition outputs. Original selected assets total 184,862,323 bytes.
- Generated real editable PPTX: `ee525a677067054be22aa306a3ee64a9fba5484c8e0180a44adac1307727953b.pptx`, 12,021,133 bytes, 5 slides. Foreground picture counts: 8, 4, 11, 9, 8. Native text counts: 0 on every slide; supplier text layers remain images as requested.
- LibreOffice 24.2 opened and exported the PPTX as a five-page PDF. Visually inspected all five rendered slides: visible titles and English phrases, characters and backgrounds present. This does not validate teaching playback.
- Saved real LLM-generated narration: 44 speech actions across pages (8, 11, 15, 6, 4), plus 3 interaction checkpoints. Twelve speech actions carry attention instructions. No audio is attached. These instructions are saved intent, not verified running animations or approved target mappings.
- Actual media context returns empty TTS models, music generation models and music export models. Attempted TTS preparation returns `COURSEWARE_MEDIA_PLATFORM_46003`; platform `MediaQuoteService.provider()` maps 46003 to `MODEL_NOT_ALLOWED`. No usable speech quote or submission was obtained. Do not invent model aliases or bypass billing.
- `narrationReady=true`, `audioReady=false`, `teachingReady=false`. `videoReady=true` means this plan has no required video slots; no video was generated or tested.

## Fixes exercised by this run

- Rebuilt the actual Desktop runtime and restored its staged worker dependencies (155-file manifest verified).
- Kept high-resolution archive images intact; raised bounded selected-original aggregate to 256 MiB and scaled compiler copies to their placement sizes, retaining the normalized compiler limit of 32 MiB.
- Used complete provider layer coordinates directly rather than requesting redundant model-generated layer placement.
- Allowed saved scene continuation without an open Office tab; routed narration tools to saved-workflow execution and resolved the session's inherited default model.

## Relevant checks

- Desktop typecheck passed.
- 47 targeted Desktop tests passed (scene deck, scene planning, saved narration, Chat workflow).
- 39 scene-image tests and 3 shared workflow tests passed.
- 16 Electron scene completion checks passed. These checks use a local provider stand-in and are not evidence of real provider generation.
- Existing real image results, actual PPTX compilation/rendering and actual narration generation were checked separately as described above.

## Evidence and next dependency

Database backup: `/tmp/deckwise-real-flow-20261028-before.sqlite`. Rendered PDF and five-page contact sheet: `/tmp/deckwise-real-flow-render/`. Final targeted checks: `/tmp/deckwise-real-flow-final-regression.log`, `/tmp/deckwise-real-flow-final-typecheck.log`.

Real output lives under `/home/jhz/code/train/deckwise-desktop/apps/.deckwise-ppt/generated/`. Durable project: `office-ee525a677067054be22aa306a3ee64a9fba5484c-8414ac4e8f44`.

The next dependency is a configured, priced TTS model/voice and music provider exposed through the authenticated platform catalog. Production was inspected read-only; no server configuration was changed. Once available, resume this same saved project for audio generation/adoption, teaching action validation, fixed-build preview and actual playback. End-to-end completion remains unverified until then.

## Resume after Platform/MAIC deployment (2026-10-28)

Resumed the same session and project above. Before continuing, backed up the local
SQLite database to `/tmp/deckwise-real-audio-20261028-before.sqlite`. Rebuilt Desktop
to include free MP3 export quote/receipt validation and restarted the idle test
instance. Existing PPTX, five pages and 44 speech actions were preserved.

The authenticated real media context now exposes `doubao-tts` (including
`zh_female_yingyujiaoxue_uranus_bigtts`), `mxapi-music` and `mxapi-music-export`.
The previous empty-catalog blocker is resolved.

Actual `courseware_media_prepare` still fails with `COURSEWARE_MEDIA_HTTP_500`.
Production Platform logs identify `SQLSyntaxErrorException: Table
trainwise.courseware_media_task doesn't exist` at MediaTaskService's initial
idempotency lookup. The request does not reach provider submission. Stopped the
agent to avoid repeated failing requests; did not resubmit any unknown paid result.

Read-only schema inspection also found `courseware_music_candidate` absent.
`tenant_points_account.frozen_points`, `billing_points_txn` reference fields and
`async_task` are present. Prepared the six existing media/music migrations, in
order, at `/tmp/courseware-audio-required-schema-20261028.sql`. Executed that exact
bundle twice against a new disposable local MySQL schema: both executions passed,
producing the 34-column task table and 14-column candidate table. No production
schema changes have been executed; user approval was requested for those writes.

This run is still incomplete: no audio has been adopted, and no full-course
playback is certified. Once the missing tables are applied, continue this same
saved task without regenerating visuals or narration.


## Architecture correction: Desktop-owned media relay

The missing production media-task/candidate tables are no longer the proposed fix.
Do not apply `/tmp/courseware-audio-required-schema-20261028.sql`.
Use the new finite relay with the Host-owned local journal; see `2026-10-28-local-media-relay.md`.
Deploy the matching Platform and Desktop changes before resuming this same five-page task.
No new paid generation or production schema change was performed during this correction.

## Live local-relay continuation after deployment (13:18 CST)

Production Backend image `52f04ebcb9bc84121d5a97593ea05790e84579a1` contains
`MediaRelayController`/`MediaRelayService`; MAIC remains
`1ceb0cf16043815a04bcf55e13c8ff0cf4e16f54`. Restarted the idle test Desktop
and Host with the new local-relay build. Backed up SQLite first to
`/tmp/deckwise-real-relay-20261028-before.sqlite`.

First real new-relay submission used existing prepared intent
`4c9ad312-5189-45b9-9125-49b71fb5ba3c` for page 1 speech index 6.
It returned actual Doubao MP3, was decoded, archived and automatically adopted.
Audio: 73,965 bytes, 9.240 seconds, SHA-256
`c0d0d03e90536572d7c41944abdbc921e34e7834693a01770d208bd32c7f0f7c`.
Independent ffprobe and SHA verification pass. Production accounting event
`3fb269f0-fd4b-393a-8f28-956f405bc423` is successful, error NULL, cost 1 point.
The result/bytes are persisted in local `coursewareMediaRelay.v1`, not a Platform media-task table.

Six deployment-before legacy unknown intents are preserved and have not been
resubmitted. They failed at the old backend's initial missing-table lookup,
before supplier submission, as recorded above. Their old polling cannot prove
the new relay path; validation uses previously unsubmitted speech instead.
Remaining narration and music validation is in progress; this entry does not
certify full-course playback.
