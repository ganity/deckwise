# Part A native lesson planning and audio recovery — 2026-11-11

## Delivery

The previous integration checkpoint was Desktop `7706042fe` and Document
`b5a0a626`. This follow-up stays on their existing `feat/courseware-par-A`
worktrees. It adapts the useful lesson extraction/mapping and original-order
recovery behavior to Part A. It does not copy the legacy Host teaching writes,
supplemental playback activities, reference authority or media payment protocol.

The three preparation entries retain their own generation/import stages. Their
native teaching stage now exposes the same source-grounded lesson planning and
full-deck audio recovery tools. Existing scene/PPT-master requirements remain
inputs; supplied final scripts and valid audio remain authoritative.

## Implemented behavior

- `courseware_narration_plan`: resolves an immutable Host source ID (or exact inline
  user text), reads live native page text/notes and current teaching requirements,
  uses the selected narration model, validates exact source/page quotations and
  stable page IDs, and reports unmatched units. Preview is read-only. Apply uses
  existing material enrichment/history/save. An existing accepted plan is returned
  without another model call; a different source requires explicit replacement.
- Existing lesson consumers remain responsible for detailed narration and native
  activities. A unique exact existing question retains its ID. Missing units use
  `courseware_activity_insert` and the existing Quiz/checkpoint projection, evidence
  validation and media generation. No arbitrary quiz quota or invented answer is
  introduced. Chat instructions and deferred-tool activation include this path.
- `courseware_media_refresh(kind:tts,recover:true,sourceSha256)`: recovers the whole
  deck or selected page numbers, with optional model/voice filters. Stable IDs
  survive page reordering. Each action uses a fresh native revision; valid attached
  audio stays untouched. Only original task status/download/adoption runs. Unknown,
  failed, prepared, missing, locked and ambiguous targets remain explicit. Successful
  adoption saves even when another page fails. Native adoption followed by a lost
  journal acknowledgment is reread and its provable output saved with the error.
- Automatic native `media_prepare` requests original-intent reuse by exact stable
  page/action/text/model/voice before a quote. Submitted/unknown orders are returned
  for refresh, never quoted or submitted again. Sidebar explicit regeneration keeps
  its existing behavior. Native context excludes already voiced actions and exposes
  competing originals instead of automatically overwriting with another voice.
- Existing single-page refresh results now expose per-intent recovery states and
  preserve acknowledged partial success through the common save wrapper.

## Main files

- Desktop `courseware-native-audio-recovery.ts`, `courseware-native-audio.ts` and
  `courseware-native-tools.ts`: recovery, reuse, routing and durable save results.
- Desktop `courseware-candidates.ts` and runtime
  `courseware/native-lesson-planning.ts`: guarded native evidence capture and pure
  model-output validation using the existing completion/model resolver.
- Workflow schemas, shared tool list, runtime activation, Main Chat instructions and
  Host dispatch/risk declarations expose the new tool through the established turn
  and permission boundaries. No new IPC or persisted enrichment schema is needed.
- Document adds only `test/e2e/deckwise-native-enrichment-recovery.spec.ts`; its
  existing production bridge already supports the required adoption/history/save.

## Verification

Current-source workflow gate: `/tmp/deckwise-workflow-gate-Annpkj/report.json`.
Real external provider calls: **0**. The gate reports its native editor as not run;
the separate Chromium test below supplies that evidence.

- host-build: build passed.
- main-host: 602 passed.
- shared: 43 passed.
- agent-runtime: 496 passed.
- host-contracts: 297 passed, 2 ignored.

Shared and runtime TypeScript builds, Desktop typecheck and the Electron production
build passed. The two ignored Rust checks require dedicated real-worker fixtures
(`DECKWISE_LOCKED_IMAGES_FIXTURE` and the portable-parser fixture); the scoped gate
leaves these existing fixture-dependent checks ignored. The isolated
Chromium test passed with the current Main integration bundle and a copied real
native PPT fixture. It runs real Main lesson planning orchestration, script/plan
adoption, native Quiz insertion, persisted original TTS identities, coordinator
restart, pending-to-ready recovery, native audio adoption, source save and reopen.
The remote model/media service and Host journal transport are simulated. Exactly
2 original test orders and 2 quotes remain after repeated recovery, with no new
orders. The final PPT keeps its script, accepted plan, inserted activity and audio.

The gate covers all three task types (`plain`, `scene`, `import`) for source
adoption/reuse and recovery; the browser exercises their shared native stage.
This is not three fresh paid course-generation runs.

Reproduce the paired browser check after building current Desktop dependencies:

```sh
# Desktop Part A worktree
node scripts/build-native-enrichment-test-harness.mjs /tmp/native-enrichment-recovery.mjs
# Document Part A worktree
E2E_PORT=4389 \
DECKWISE_NATIVE_GENERATED_FIXTURE=/tmp/part-a-import-generated-fixture \
DECKWISE_ENRICHMENT_RECOVERY_URL=file:///tmp/native-enrichment-recovery.mjs \
pnpm exec playwright test test/e2e/deckwise-native-enrichment-recovery.spec.ts --workers=1
```

Fixture prerequisite: copy `native.pptx` from a real Desktop native generation
fixture. Successful output for this run:
`test-results-4389/deckwise-native-enrichment-cac9a-nd-reopen-a-real-native-PPT-chromium/recovered-native.pptx`.

## Limits

- Automatic mapping uses actual native text/notes, not new OCR or image recognition.
  Image-only or semantically unclear pages can remain unmatched. Exact quotations
  and real IDs establish provenance; semantic mapping quality still depends on the
  selected model. No live paid model quality evaluation was run in this change.
- Automatic inference rejects source text over 100000 characters or serialized
  evidence over 300000 characters instead of truncating it. Existing manual material
  adoption limits and workflows remain available.
- Recovery queries/downloads the original service result; `tts:archive` is not a new
  persistent local download cache. An expired remote asset can still require reporting
  the original download failure. No failed/unknown purchase is replaced implicitly.
- No installer packaging, release, push or deployment is performed by this follow-up.
- Validation applies to the current uncommitted Part A candidate above. Known
  Desktop `origin/main` is `58a9c4f57` and is an ancestor; checking its latest remote
  head timed out after 20 seconds. Document `origin/main` is `d1c9b032`, verified
  against the remote and already an ancestor. No branch history or main checkout
  was changed to prepare these checks.
