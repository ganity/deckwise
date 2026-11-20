# Three-route real generation acceptance — 2026-11-16

The three requested routes were exercised with different education topics and
no more than five physical pages per lesson. All provider calls were real.
This run found material failures; it does **not** close P7.

| Route and topic | Pages | Embedded real TTS | Result |
| --- | ---: | ---: | --- |
| PPT Master: Grade 4 Science, states of water | 5 | 2 | Failed: three body pages lack narration and effects. |
| Scene: Grade 7 Math, number lines and opposite numbers | 4 | 17 | Playback passed; completion scope and requested narration duration failed. |
| Import: Grade 8 Chinese, exposition order | 4 | 4 | Playback and source preservation passed; second original title highlight omitted. |

## Candidate and method

- Desktop base: `5cbd7cb44de14d6cb5f1e478ff9f57b63bd7d05d`, v0.20.5,
  with the existing uncommitted development. This is not clean-commit or
  installer qualification. Frozen Main/Host/Agent Runtime hashes are in
  [candidate-fingerprint.json](candidate-fingerprint.json).
- The real native editor was built and staged from the clean pinned Document
  revision `6f5c90f4860f45650422c581a2f96e2f20b55b6e`; its source was unchanged.
  Electron 43.6.0 ran an isolated profile. Managed LLM:
  `deepseek-v4-1-flash`; TTS: `doubao-tts`; Scene: `scene-master` and
  `scene-layers`. No LLM, image, layer, audio, or editor responses were mocked.
- Existing IPC/UI entry points created tasks, selected routes, approved plans
  and first-image style, imported a genuine external two-page PPTX, and
  opened/saved/reopened the real native editor. The native file dialog was
  automated only to select that fixture. No business validation was disabled.
- A local test controller called existing renderer IPC and automated UI
  navigation. PPT Master needed operator layout feedback and explicit native
  editor opening; Scene also needed an operator editor opening. These are
  assisted runs, not unattended first-pass successes.
- Fresh fixed builds used the current worker and player. The playback probe
  observed real HTML audio `ended` events, visible effects, wrong and correct
  quiz responses, and teacher continuation. It neither sought audio nor
  simulated completion. The initial older quiz probe did not handle the latest
  Quiz UI; it was stopped and adapted to the current instant/assessment cards.
- All three teaching projects survived close/reopen unchanged. Final PPTX
  bytes match the tested snapshot source hashes. Embedded audio bytes were
  decoded and SHA-256 checked. See [summary.json](summary.json).

Detailed private transcripts, receipts, fixture sources, frozen executable,
build packages, PPTX files, native screenshots and test probes remain at
`/home/jhz/deckwise-validation/three-path-live-20261116`.
The isolated refresh-token copies were removed after conditional preservation
of the refreshed login. The test application and its preview server were stopped.

## PPT Master findings

The official Skill produced five native slides, the fixed Quiz and oral page,
and a valid export after operator visual feedback. Early SVG edits produced
overlap, invalid XML and stale line edits; parameter validation rejected an
oversized option list and malformed Write/Edit calls. The model recovered
through the existing tools. Export normalization invalidated a prior quality
fingerprint; revalidation allowed adoption without bypassing that gate.

Body narration first failed with `ERR_NETWORK_CHANGED`. Subsequent candidates
failed `COURSEWARE_NARRATION_OUTPUT_INVALID`: proposed attention targets and
speech were rejected as inconsistent, including graphical objects without
textual aliases. The same-turn repair budget then correctly returned
`COURSEWARE_NARRATION_RETRY_EXHAUSTED`. The test did not reset that budget to
force completion. Only the two assessment speech clips were saved.

The fixed converter nevertheless accepted a build with three body pages having
no teaching actions. [Automatic playback](master-automatic-playback.json)
reported completion on page 1, reaching one of five pages and ending zero of
two stored audio clips. See [the captured screen](master-stopped-first-page.png).
This is an acceptance/automatic-navigation gap, not proof of a complete lesson.

A separate diagnostic clicked Next page for each of the three static pages.
It reached all five pages, naturally ended both assessment clips, tested a
wrong and correct answer, and continued the oral activity. Its final assertion
**failed** because all requested effects were absent. See
[manual playback observations](master-manual-playback.json). It is not counted
as an automatic playback pass.

The model also initially searched outside its intended workspace, including
test files and a read-only test-database query. The operator constrained it to
the workspace and formal tools. Workspace/shell location guidance remains a
stability and isolation concern.

## Scene findings

The approved four-page plan placed the Quiz between the two related body
pages. Initial invalid placement was rejected and repaired. Two real masters
and two real decomposition jobs produced the background/layer assets; derived
layer records must not be counted as separate paid image submissions.

The requested junior-high visual style worked: restrained textbook diagrams,
correct minus signs, A at -2, B at 2, and the zero/opposites statements. However,
the source pixels do not maintain equal tick spacing. Approximate consecutive
intervals in the first master are 178, 169.5, 165, 156.5, 165 and 145 pixels.
See [number line](scene-number-line.png), [opposites](scene-opposites.png) and
[measurement method](scene-tick-spacing.json). The user subsequently clarified that these small spacing imperfections are
acceptable for this raster demonstration. They are retained as observations,
not release blockers. Wrong labels, signs or target bindings remain distinct
errors. No code redrew the raster diagram.

Audio adoption initially reported failed/missing results for some original
jobs. The existing recovery path eventually saved all 17 clips. Natural
[playback passed](scene-playback.json): four pages, 17 ended clips, visible
fade/highlight/spotlight, wrong-answer recovery and oral teacher continuation.

Two independent failures remain:

- The latest media context reports `audioReady: true`, quality checked and
  `playbackPreflight.ready: true`, but `completion.ready: false` and
  `teachingReady: false`. Its issues list is empty and it exposes object-binding
  advisories. The model incorrectly claimed all pages ready. Follow-up diagnosis identified missing multiple-choice option images as the
  readiness blocker: the code required them despite the explicit no-picture
  user scope. The model's ready claim was incorrect; object-binding advisories
  were not the cause. The original run remains a failure against that scope.
- Saved body narration totals 63.984s and 73.224s, exceeding the explicitly
  requested 45s per body page. Tool completion does not prove prompt constraints
  were satisfied.

## Import findings

The model previewed/adopted a lesson plan, preserved the two original scripts,
and inserted the requested independent Quiz and short-answer activity. Exact
evidence, protected-script and stale-source checks initially rejected invalid
calls; the normal retry/repair paths recovered without weakening them.

The two originals remain at final pages 1 and 3. All 14 original shapes retain
their text and geometry (maximum coordinate rounding delta: 1 EMU); both
scripts remain exact substrings of the supplied final-script attachment.
See [preservation audit](import-preservation.json).

All four clips are embedded and verified. Natural
[playback passed](import-playback.json): four pages, four ended clips, correct
and incorrect quiz handling, oral continuation, highlight, fade and spotlight.
The **second original slide title** did not receive the requested highlight;
only the first title and its time-order block have saved cues. Therefore this
run is partial against the full request despite successful playback.

## Follow-up priorities without changing business rules

1. Diagnose the narration/attention grounding failures using actual rejected
   candidates and graphical object metadata. Preserve real mismatch checks and
   the existing repair budget; do not loosen them merely to obtain green tests.
2. Unify completion reporting with the authoritative saved result. A model
   must not claim ready when `completion.ready` is false. Explain which saved
   condition caused failure, including the advisory-only contradiction above.
3. Make acceptance detect omitted requested teaching/effects and narration
   duration constraints. Distinguish a convertible static deck from the user's
   requested narrated lesson, and repair automatic traversal of empty pages
   without marking unvisited pages played.
4. Keep rendered-pixel review for mathematics. Style approval is not evidence
   of equal spacing, exact coordinates or numerical accuracy. Preserve whole
   raster diagrams and existing bounded image repair/human review.
5. Improve workspace guidance and revision-aware tool use; recover original
   media requests before issuing new purchases. Preserve the source/script,
   approval, evidence, revision, permission and validation contracts exercised
   here.

Only `PPTX_NOTES_MASTER_UNVERIFIED` was explicitly reviewed for conversion.
This permits the fixed-playback test; it does not certify note-master fidelity.
No product source was changed during this run. P1 historical incident
attribution remains open. No large-deck, installer/OS matrix, acoustic voice
quality, music/video, synchronization, publication or deployment is claimed.


## Scoped fixes after diagnosis

The working-tree implementation now distinguishes unique source components in
symbolic relation labels, stores explicit option-image exclusions through the
existing Quiz content/save, preserves required question audio, and suppresses
false course completion on a nonfinal static page. Native context also reports
per-page effect target UUIDs and decoded speech duration/budget feedback. The
shared teaching Skill checks original page IDs after activity insertion and
repairs only missing effects. These diagnostics and Skill steps do not create a
universal semantic judge or a new global duration rejection rule.

See [repair evidence](repair-verification.md) for replay and browser boundaries.
The historical PPTX files and failed generation receipts remain unchanged. These
fixes do not retroactively complete the three real courses or close P7.


The subsequent user-requested LLM review/repair/review closure is implemented and
verified separately in [semantic review verification](semantic-review-verification.md).
The report now includes 12 passed real-provider route/scenario probes, plus
retained earlier failures and latency evidence. Full UI/vision/media acceptance
remains outside that shared-loop probe.
