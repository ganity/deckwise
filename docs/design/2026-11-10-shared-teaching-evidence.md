# Shared teaching enrichment: implementation and qualification evidence

Follow-up: [three-path live validation](2026-11-10-three-path-live-validation.md)
records real providers, saved/reopened lessons, playback, integration fixes and the
remaining import automatic effect gap. The provider-free results below remain the
record of the earlier qualification run.

Date: 2026-11-10. Status: implementation delivered in Part A; local qualification passed.
Full external/corpus qualification remains open in repository Plan 008 (`plans/008-shared-teaching-enrichment.md`, outside the documentation site).

## 1. Delivered behavior

Scene, PPT Master and import retain their own preparation and converge on existing
native teaching. Optional script/lesson-plan attachments enter through Chat. Exact
text is retained privately in immutable, task/workspace-scoped Host records. Native
PPT carries only bounded accepted source text, policy, original-page anchors and
plan/activity bindings. No new database, mutable teaching mirror, parser dependency
or scheduler was introduced. MAIC remains a read-only behavior reference.

Final scripts are adopted without a speech-generation call. Existing identical
speech retains its ID, audio and cues; unrelated media/assessments/native animation
remain in order. Preserve, authorized revision and generate-missing are distinct.
Silent pages cannot acquire generated speech through Chat or sidebar selection.
Missing/unmatched sources, manual divergence and copied/deleted anchors are reported
instead of filled or overwritten. Successful partial writes are saved and resumed.

Evidence-backed plan units enter whole-course/page context. Missing authorized Quiz
and teacher-led checkpoints use the existing assessment compiler and native slide
history. Visible objects, answer/reference data and source mapping share one Undo
transaction. Stable identities survive retries. Confirmed existing activities are
reused; matching visible question text without executable metadata is returned for
explicit conversion. New question readings use the existing public speech protocol.

The existing media services retain provider orders, verified assets, timing and
native effects. Repair-only focus/media can preserve supplied words and audio even
without scene-generation metadata. Coverage participates in completion; pending
original orders can be reconciled, while unresolved sources block new automatic
content generation. Current native-motion and converter limits are preserved.

## 2. Exact candidate and artifact location

All changes remain uncommitted in the user-selected worktrees. No push, deployment,
app restart or editing of the user's actual lesson was performed. The prior transcript
and pre-existing resource backup directories were left intact.

| Checkout | HEAD | Fetched target main, already an ancestor |
| --- | --- | --- |
| Desktop `deckwise-desktop-worktrees/courseware-par-A` | `e2a3aaeb02f7fd52125a662a9c5cb330452a8d1f` | `origin/main`: `58a9c4f57203c93da3f590e426b42ebba1072fb6` |
| Paired document `document-worktrees/courseware-par-A-playback` | `3954c941c650bff02cd524e815428d25bfb7ca1c` | `fork/main`: `d20f6d9a6f8908e5a461e066bcc65f7d92e4715b` |
| MAIC, read-only | `bd335c7e0369e06e416ac83bb7a47bec86b36bc0` | No modification |

Both implementation checkouts use `feat/courseware-par-A`. The design's older commit
table is historical, not the executable implementation baseline. Tracked product
changes in this delivery were made after inspecting the current workspaces; the
preparation documents and generated resource backups already existed.

Artifacts are under `/home/jhz/deckwise-validation/shared-teaching-20261110/`:

- `source-state.json`: each changed source/test file and SHA-256; excludes docs,
  plans, changelog and pre-existing resource backups to avoid recursive fingerprints.
  Desktop source fingerprint: `203afe22a9ed1bf88ba99ffbc3aed32a165e959ea46f334b1a853f38d1f2244a`.
  Document source fingerprint: `8e8c9079ac5866994aa24be47087939927364999a9fb503cd2f177620844af2a`.
  The mirrored shared/document wire validator was compared byte-for-byte after its origin comment.
- `artifact-state.json`: hashes of installed baseline editor/worker manifests, compiled
  runtimes/Host, isolated Desktop build, candidate editor manifest, saved fixture PPTs
  and fixed packages. Individual files are identified, not inferred from a dirty commit.
- `desktop-build/{main,preload,renderer}`: isolated production Desktop build.
- `editor-bundle-delivery`: paired production MAIC editor resource bundle, 2,858 files,
  from current document HEAD plus the recorded dirty source. Its manifest inventories
  every resource and includes the shared teaching preview runtime.
- `fixture-{script,plan,both,generation}`: copied saved native fixtures and carrier data.
- `fixed-{script,plan,both,generation}`: immutable Host-derived playback packages.
- `playback-{script,plan,both-final,generation}`: real browser reports and screenshots.
- `workflow-gate/report.json` and `logs/`: final gate and scoped command logs.

The candidate editor bundle is prepared separately. Existing installed resources were
not replaced. New Main refuses material writes with an editor lacking capability 1;
shipping/running the feature requires the paired new editor bundle. No release binary
installation or PR merge candidate was requested or performed.

## 3. Executed checks

Provider calls: **0**. Office tests used separate Chromium instances/ports and copied
presentations. Deterministic local PCM/video stood in for provider output at the media
adoption boundary. This qualifies adoption/playback, not real model/TTS quality.

| Check | Actual result | Evidence |
| --- | --- | --- |
| Baseline narration/native/presentation/scene staging | 48 passed, 5 fixture-dependent skips | `logs/shared-teaching-baseline.log` |
| Final mandatory workflow gate | PASS: Main/Host 586, shared 42, Agent runtime 491, Host contracts 296; 2 existing ignored Host tests | `workflow-gate/report.json`; `providerCalls:0` |
| Exact parsing, schema, mapping, silence, authorized revision | 7 passed | `logs/shared-teaching-contracts-final.log` |
| Full shared suite, earlier implementation iteration | 1,452 passed | `logs/shared-teaching-contracts.log`; final contract changes separately retested |
| Final native tool + sidebar/coordinator regression | 53 passed, no skips | `logs/shared-teaching-native-final.log`; covered by final gate too |
| Native saved-package, narration-batch and attachment regressions | 54 passed, 1 real-fixture skip | `logs/shared-teaching-desktop-tests-final.log`; real snapshot test provisioned separately below |
| Narration write, workflow tools, bounded continuation | 76 passed | `logs/shared-teaching-runtime-tests.log`; final workflow gate also exercises this surface |
| Source record isolation, immutability and DB reopen | Passed; included in final Host contracts | `logs/shared-teaching-host.log`, `workflow-gate/host-contracts.log` |
| Paired editor native carrier/history/compatibility | 26 passed | `logs/shared-teaching-document.log` |
| Final real Office materials/adoption/recovery | 5 passed, no skips | `logs/shared-teaching-office-delivery.log` |
| Real Office generated lesson/media/native motion/save/reopen/playback | 1 passed | `logs/shared-teaching-office-generation-final.log` |
| Real Office Quiz pictures/reference/visible edit/Undo/Redo/reopen | 1 passed | `logs/shared-teaching-office-parity-final.log` |
| Real Host parse/snapshot/restart/fixed build | 4 fixture runs passed, no skips | `logs/shared-teaching-fixed-{script,plan,both,generation}.log` |
| Real browser playback | 4 runs passed, zero browser errors | `playback-*/report.json` |
| Desktop + paired document TypeScript | Passed | `logs/shared-teaching-types.log`, `logs/shared-teaching-document-types.log` |
| Shared/Agent runtime builds and typechecks | Passed | corresponding `logs/shared-teaching-*-build.log` / `*-types.log` |
| i18n catalog/placeholder checks | 29 passed; eight locales updated | `logs/shared-teaching-i18n.log` |
| Desktop production and paired editor resource build/stage | Passed; chunk-size warnings retained | `logs/shared-teaching-desktop-build.log`, `*-editor-build-delivery.log`, `*-editor-stage-delivery.log` |
| Repository configured Biome scope | Passed, 79 files | `logs/shared-teaching-lint.log`; new files outside its include list are not claimed linted |
| New Rust module rustfmt; changed-file whitespace; playback script syntax | Passed | `logs/shared-teaching-new-rust-format.log`; `git diff --check` both trees; `node --check` |

The full workflow gate explicitly says `nativeEditor:not-run`. The separate seven
executed Office tests supply that evidence; it must not be inferred from the gate.
Counts overlap between scoped suites and the gate and should not be added together.
Two ignored Host tests are existing suite exclusions, not successful executions.

The three material combinations run the actual Main adoption/activity services against
the live native router, then adopt media, save and reopen. The separate compound-history
case verifies physical slide count/text and source/answer bindings through one Undo/Redo.
Recovery verifies navigation versus real page edits. Existing scene/PPT Master paths
are additionally characterized by the mandatory scene/presentation/export tests.

The enriched browser checks confirm original source-page words, audio clock progress,
both original/new Quiz keys, teacher-led activities and media cleanup after unmount.
The generated fixture also proves native/speech animation, highlight, spotlight,
music/video playback and answer feedback through the fixed player.

## 4. Reproduction entry points

Run from the Desktop Part A checkout:

```sh
pnpm --filter @pi-desktop/shared build
pnpm --filter @pi-desktop/agent-runtime build
pnpm --filter @pi-desktop/desktop typecheck
pnpm test:courseware-workflow
node --test apps/desktop/test/courseware-narration.test.mjs apps/desktop/test/courseware-native-tools.test.mjs
pnpm --filter @pi-desktop/shared exec vitest run src/courseware-enrichment.test.ts
pnpm --filter @pi-desktop/i18n test
```

The evidence directory's `build-materials-harness.mjs` / `build-harness.mjs` bundle
current Main service entry points for direct Office boundary tests, keeping only real
external module/host URL resolution outside the bundle. They do not fake the native
editor or history. Set `DECKWISE_MATERIALS_URL` / `DECKWISE_NATIVE_NARRATION_URL` to
these generated file URLs. Set `DECKWISE_AUTHORING_URL` to the current workspace
`packages/courseware-runtime/dist/authoring.mjs`.

From the paired document checkout, with these variables:

```sh
DECKWISE_NATIVE_GENERATED_FIXTURE=/home/jhz/deckwise-validation/native-generation-loop-20261110 E2E_PORT=4291 pnpm exec playwright test test/e2e/deckwise-native-materials.spec.ts test/e2e/deckwise-native-materials-adoption.spec.ts test/e2e/deckwise-native-narration-recovery.spec.ts --workers=1
pnpm exec vitest run test/unit/deckwise-native-teaching.test.ts
pnpm run tsc
```

The generation regression uses `fixture-generation` and
`DECKWISE_TEACHING_PREVIEW_FILE=.../editor-bundle-delivery/.deckwise/teaching-preview.mjs`
on port 4293. The Quiz picture parity regression uses the distinct
`/home/jhz/deckwise-validation/native-parity-final-fixes` two-page fixture on port 4292.
They are intentionally different fixtures; do not substitute the three-page lesson.

Host snapshot/build tests use `DECKWISE_PPTX_NODE` set to the Node executable,
`DECKWISE_PPTX_WORKER` set to the installed verified worker's `pptx-worker.mjs`,
`DECKWISE_NATIVE_REAL_FIXTURE` set to one of the copied media-complete fixtures and
`DECKWISE_NATIVE_BUILD_DIRECTORY` set to a new isolated output. For the generation
fixture also set `DECKWISE_NATIVE_EXPORTED_PPTX` to its `edited.pptx`. Execute
`node --test apps/desktop/test/courseware-native-snapshot.test.mjs`.

`node scripts/native-teaching/verify-enriched-playback.mjs <absolute fixed build directory> <new evidence directory> <absolute teaching.json>`
validates the enriched fixtures. The existing `verify-generated-playback.mjs` validates
the richer body/Quiz/practice fixture. These runners reject external network requests.

Production builds actually executed:

```sh
pnpm --filter @pi-desktop/desktop exec electron-vite build --outDir /home/jhz/deckwise-validation/shared-teaching-20261110/desktop-build
node scripts/build-wiseoffice-maic.mjs /home/jhz/code/train/document-worktrees/courseware-par-A-playback /home/jhz/deckwise-validation/shared-teaching-20261110/editor-build-delivery
node scripts/stage-wiseoffice.mjs /home/jhz/deckwise-validation/shared-teaching-20261110/editor-build-delivery /home/jhz/deckwise-validation/shared-teaching-20261110/editor-bundle-delivery
```

Build/stage destinations must be new. Existing generated evidence must not be silently
replaced to simulate a successful rerun.

## 5. Acceptance matrix and qualification boundaries

| Acceptance | Executed local evidence | Remaining scope |
| --- | --- | --- |
| A01 scene retention | Scene compiler/staging, existing native generated lesson, media/history/player tests | New live image/model production run |
| A02 correct PPT Master | Official exporter/presentation adoption tests, retained requirements, common native path | Fresh live full lesson generation |
| A03 plan/page mismatch | Native narration/batch mismatch rejection and unchanged-retry regressions | Original user lesson not repaired or reclassified |
| A04 PPT alone | Existing import/notes/narration and generated-native regressions | More imported document corpus |
| A05 plan | Actual Main plan-only adoption, independent Quiz, save/reopen, fixed browser | Full pedagogical quality of arbitrary plans |
| A06 numbered script | Exact parser, actual Main adoption, native anchors, fixed source-word assertions | Real TTS pronunciation |
| A07 mixed/unnumbered script | Deterministic mapping/ambiguity/ordering tests | Arbitrary semantic alignment quality |
| A08 plan + script | Actual Main both-source adoption, independent activity, fixed browser | Live source extraction and contradictory-plan model judgment |
| A09 target granularity | Existing native/object/image grounding tests and real native focus | Complete real image-layer/raster corpus |
| A10 native timing | Real Office motion Undo/Redo/save/reopen and generated fixed effects playback | Arbitrary unsupported native motion and external app fidelity |
| A11 recovery | Actual Office navigation/content-edit recovery, partial-save/retry, Host reopen and original-order regressions | Live provider/network failure qualification |
| A12 structure/history | Real assessment insertion Undo/Redo/reopen; pure reorder/delete/copy diagnostics and existing document identity tests | Expanded real document structure corpus |
| A13 old carrier | Current old-shape writer retention, no-metadata compatibility, saved package validation | Arbitrary old binaries or stripped custom XML |
| A14 optional/required effects | Runtime repair/focus tests and required completion regressions | Live vision quality |
| A15 ownership | Existing locks/read-only/cancellation/session/source CAS tests; new source-scope and wrong-view rejection | Other OS/process environments |
| A16 extraction/coverage | Exact source IDs, parsing limits/failures, immutable records, coverage/blocked continuation | Real Word/PDF document-service deployments and scans |

Semantic preflight is performed by the agent using actual text/objects and existing
visual evidence. Deterministic validators establish IDs/order/coverage and exact
preserved words; they are not a general semantic correctness classifier. Uncertain
mapping is an unresolved result. Plan evidence must be exact; objective answer labels
must occur in it. A valid schema alone does not certify good teaching or factual truth.

## 6. Failures found, corrections and non-passing repository checks

The first new native-test loader did not resolve the dynamic authoring file URL. Its
loader was corrected and the native service tests passed. Earlier Office acceptance
used the wrong fixture for two older suites, omitted the preview runtime and failed to
reset the demo readiness marker before replacing its iframe. The corrected harness
uses each intended fixture, supplies the real shared preview runtime and waits for the
new frame. Its Host metadata read allowlist includes the existing `media:list` call;
no provider submission was relaxed. The successful reruns are listed above.

The fixed-package path caught a real integration defect: newly inserted question speech
used `source:assessment`, outside the existing public speech union. It now uses the
supported generated provenance; the plan binding separately owns the activity. A public
`isTeachingWrite` assertion, real Host fixed builds and browser answer checks cover the
fix. Strict paired-editor type checking also caught optional-action narrowing in the
mirrored validator; both sources now use the same safe optional access and typecheck.

Whole-repository `cargo fmt --check` **does not pass**: the baseline already contains
formatting differences in existing courseware Rust files. The new materials module
passes rustfmt, and unrelated formatting was not rewritten. Whole-repository
`node scripts/check-architecture.mjs` also **does not pass**: seven existing files exceed
its limits. `architecture-baseline.json` records their HEAD line counts; all seven
already exceeded their limits before this delivery. The existing RPC dispatch file was
1,012 lines and gained only the material module/route; new logic lives in a small module.
No allowlist entries were added to conceal these baseline findings. The configured
Biome check passes; an initial attempt to lint new files directly processed zero files
because they lie outside its configured include list and is not counted as a lint pass.

All four fixed builds report `PPTX_NOTES_MASTER_UNVERIFIED`; the fixtures explicitly
review that warning. They retain `visualFidelity:NOT_VERIFIED` and limited static
conversion. Successful ready/playback checks do not certify notes-master layout,
perfect pixel fidelity or arbitrary animation support.

No live model/TTS/Word/PDF service requests, external PowerPoint/WPS round trips,
macOS/Windows qualification, user-instance `verify:ui:*` or PR integration/installation
were run. These are explicit qualification gaps; they are not failed implementations
or successful tests. T01/T36–T38 remain open for that wider matrix.
