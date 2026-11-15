# 008: Shared teaching enrichment execution plan

Status: implementation delivered in Part A; local and three-path live evidence recorded. Import automatic effect repair remains an acceptance gap. External PowerPoint/WPS and cross-platform qualification remain unperformed.
Branch: `feat/courseware-par-A` in `/home/jhz/code/train/deckwise-desktop-worktrees/courseware-par-A`.

- [Detailed design and requirements](../docs/design/2026-11-10-shared-teaching-design.md)
- [Implementation ownership and algorithms](../docs/design/2026-11-10-shared-teaching-implementation.md)
- [Execution evidence and remaining qualifications](../docs/design/2026-11-10-shared-teaching-evidence.md)
- [Three-path live validation and automatic effect gap](../docs/design/2026-11-10-three-path-live-validation.md)

## 1. Execution contract

Continue in the user-selected Part A worktree, preserving existing dirty changes. The paired document checkout is `/home/jhz/code/train/document-worktrees/courseware-par-A-playback`; inspect its rules and branch before future edits. MAIC is a read-only behavior reference unless a later task explicitly expands scope.

For every phase: read current code/callers/tests, record the actual baseline, add a failing regression or characterization, implement the smallest complete change, run the phase gate, and review the diff. Keep stages sequential where they share files. This plan does not request parallel agents.

Commit only when requested. Do not stage unrelated existing changes. No paid requests, deployment, app restart or modification of the user's actual lesson is part of preparing these documents. Later qualified tests use copies and isolated editor instances. Follow root `AGENTS.md` over contradictory older delivery instructions.

## 2. Dependency order

```mermaid
flowchart LR
  P0[P0 Baseline] --> P1[P1 Contracts and compatibility]
  P1 --> P2[P2 Materials and policy]
  P2 --> P3[P3 Preserve and match scripts]
  P3 --> P4[P4 Plans and activities]
  P4 --> P5[P5 Three entry adapters]
  P5 --> P6[P6 Effects and audio]
  P6 --> P7[P7 Recovery and completion]
  P7 --> P8[P8 Cross-entry acceptance]
```

Implementation is deliberately staged. The first usable increment is P3: import an existing PPT and a finished script, preserve its words, save and reopen correctly. The implementation now reaches P8 local qualification; external acceptance is tracked separately and is not counted as passed.

| Phase | Priority | Relative size | Deliverable | Status |
| --- | --- | --- | --- | --- |
| P0 | P0 | S | Reproducible scene/native baseline and current gap inventory | Implemented / locally verified |
| P1 | P0 | L | Validated contracts, carrier compatibility decision and ADR | Implemented / locally verified |
| P2 | P0 | M | Optional local materials and explicit narration policy | Implemented / locally verified |
| P3 | P0 | L | Finished script preserved and bound to source/native pages | Implemented / locally verified |
| P4 | P1 | L | Lesson-plan coverage and idempotent assessment completion | Implemented / locally verified |
| P5 | P1 | M | Scene and PPT Master feed shared context without losing information | Implemented / locally verified |
| P6 | P1 | L | Correct object/effect/audio binding for every policy | Implemented / locally verified |
| P7 | P0 | L | Dependency-aware continuation, recovery and honest completion | Implemented / locally verified |
| P8 | P0 | L | Integrated editor/export/player acceptance evidence | Local matrix verified; external matrix pending |

S/M/L express relative engineering scope, not elapsed-time commitments. Parser availability and old-writer compatibility are the largest uncertainties. P0/P1 resolve them before estimating delivery dates.

## 3. P0 — Establish the actual baseline

Requirements: R01, R09, R12. Acceptance: A01, A03, A11.

- [x] T00 Record Desktop/document commits, dirty-file fingerprints, runtime/editor resource hashes and installed official PPT Master availability.
- [ ] T01 Create or reuse copied fixtures: complete scene lesson; PPT Master body/Quiz/checkpoint lesson; native text PPT; image-layer PPT; full-slide raster PPT; PPT with native timing; older native PPT.
- [x] T02 Record expected pages, activity IDs, exact accepted speech, media hashes and timing for the scene benchmark.
- [x] T03 Reproduce a plan/actual-page mismatch before narration. Confirm existing bounded recovery and real Office evidence against current files; do not assume an old failure or a newer pass proves this exact tree.
- [x] T04 Inventory remaining local attachment, script-policy, insertion and provenance gaps; distinguish them from already working cloud features.

Starting points: native narration/tools tests, scene staging/presentation tests, document native generation/parity/recovery tests, the current parity audit.

Gate: the tested baseline is reproducible and each fixture has an explicit expected result. Existing failures are recorded with scope and reason; dependent phases do not hide them in new work.

## 4. P1 — Contracts, source identity and compatibility

Requirements: R03, R04, R10. Acceptance: A12, A13, A15, A16.

- [x] T05 Define bounded source descriptors, script policy, plan/script bindings, original-page identity and coverage using existing shared schemas.
- [x] T06 Trace every producer/consumer: Host, Main, runtime, native router, PPT packer/reader, save/reopen and fixed snapshot. Decide which fields are public portable teaching and which remain private material records.
- [x] T07 Test old files without metadata, new files through current readers/writers, unknown versions, size limits, missing attachments, restart and copy/reorder/delete.
- [x] T08 Finalize and record the additive extension or explicit version gate in an ADR. Specify unsupported-writer behavior and safe rollback before enabling writes.

Starting points: shared courseware contracts, native generation/package/snapshot modules, runtime `native-teaching-pptx.ts`, document carrier/router, Host native generation/save.

Gate: validated round trips retain accepted script and mapping, private paths/credentials are excluded, old data is preserved, and unknown capabilities fail explicitly. No new mutable teaching authority is introduced.

## 5. P2 — Local supporting materials and policy selection

Requirements: R02, R03, R06, R11. Acceptance: A04–A08, A15, A16.

- [x] T09 Trace current local file selection and extraction services. Publish the exact supported text/Markdown/Word/PDF format matrix with parser, limits and unsupported cases. Reuse installed capabilities; report any true missing dependency before choosing one.
- [x] T10 Add optional lesson-plan/script roles to the native-local import flow, preserving the existing server import flow. Reuse task-owned attachments and immutable extraction records.
- [x] T11 Resolve narration treatment from the user's instruction and selected materials. A final supplied script selects preservation; ambiguous draft/notes usage requires a concise choice, not an automatic rewrite.
- [x] T12 Display extraction/role/coverage outcomes in existing UI and Chat surfaces with localized labels. Persist selected policy through close/reopen and continuation.

Gate: all four input combinations work with fixtures; corrupt/empty/oversized/unreadable sources and session switches are handled; accepting a file is distinguishable from understanding its contents. No paid generation occurs merely on file selection.

## 6. P3 — Preserve and align existing narration

Requirements: R04, R05, R06, R09. Acceptance: A06–A09, A11, A12, A16.

- [x] T13 Adapt MAIC's deterministic page-label/paragraph parsing and bounded mapping validation into an existing suitable pure/runtime module. Retain source positions and exact spoken content; preserve decimal numbers, greetings and video references.
- [x] T14 Anchor explicit page sections to original source pages. Match only unlabelled paragraphs within neighbouring bounds. Check completeness, uniqueness, order and semantic contradictions separately.
- [x] T15 Add a preserve path to native narration that calls alignment/focus without calling speech generation. Persist accepted words and stable bindings through current atomic write/save.
- [x] T16 Handle intentional silence, unresolved missing pages, copied/deleted source pages and source-script revisions. No automatic filler in preserve mode.
- [x] T17 Verify native save/reopen and assessment insertion leave source-page anchors unchanged. Verify late model output and uncertain writes cannot overwrite manual teaching.

Reference tests: MAIC `uploaded-narration.test.ts`; extend Desktop narration/native-tool suites and document native tests. Add real-boundary coverage for the complete import-plus-script user sequence.

Gate: every accepted paragraph appears exactly once in its intended page and order after save/reopen; no generated replacement speech; malformed mappings return specific failures; insertion/reorder does not shift script pages.

Milestone M1: a teacher can import PPT + final script and obtain a durable editable lesson with the original words. Required synchronization effects are completed in P6, not claimed here.

## 7. P4 — Lesson-plan mapping and activity reconciliation

Requirements: R03–R07, R11. Acceptance: A05, A08, A12, A16.

- [x] T18 Adapt blueprint extraction/guidance: objectives, knowledge, stages, activities, examples and source evidence. Expose extraction failure and actual coverage; do not silently treat a supplied plan as absent.
- [x] T19 Map stages/moves/activities to source/native page IDs. Keep many-to-many relationships and unmatched items. Verify plan guidance against page purpose, including warmup/recitation versus new instruction.
- [x] T20 Inventory existing Quiz/checkpoint objects and visible question candidates. Reconcile by stable activity identity; reuse approved scene/PPT Master assessments and distinguish inferred duplicates from confirmed identity.
- [x] T21 Insert or convert only authorized missing assessments through existing native page/history operations. Commit visible question, answer/reference data and bindings together. Reject guessed answers and keep one question per Quiz slide.
- [x] T22 Settle new course order and update affected transition context. Preserve supplied script; newly inserted prompts have separate assessment-owned speech. Re-run reconciliation after lost acknowledgement/restart to prove idempotency.

Starting points: current assessment compiler and classroom editor/services, document assessment write and slide insertion commands, MAIC blueprint/page-mapping and Quiz/interaction injectors as references.

Gate: the expected activities occur once in the correct places, unmatched requirements remain visible, answers/reference guidance survive Undo/Redo/reopen, and original paragraphs retain their anchors. Plan intent does not override a fixed script silently.

Milestone M2: PPT + plan + script uses the plan for activities and the script for spoken words, with accurate coverage reporting.

## 8. P5 — Preserve scene evidence and verify PPT Master handoff

Requirements: R01, R03–R05, R07. Acceptance: A01–A03, A09.

- [x] T23 Trace scene compiler mapping into the native carrier/context. Retain verified layer identity, roles, asset hashes and accepted teaching without replacing the scene visual generator.
- [x] T24 Add actual-export semantic checks at PPT Master adoption/enrichment entry. Verify planned page purpose/content, physical page identity and exported object associations. Do not rely on array order alone.
- [x] T25 Feed both generated entries through the same policy-aware enrichment context as import, preserving their richer evidence and existing assessment arrangements.
- [x] T26 Characterize unchanged scene outputs and test a deliberate mismatch. Content repair and plan-mapping correction are distinct actions with scoped review; neither is silently chosen by narration retry.

Starting points: scene deck/staging, presentation adoption, native generation, scene object view, Host native-generation validation.

Gate: complete scene fixtures retain existing behavior; correct generated PPTs enrich normally; page mismatch stops dependent generation and produces actionable evidence; unchanged retries do not spend more model calls.

Milestone M3: all three entries share enrichment while preserving entry-specific information and production methods.

## 9. P6 — Shared effects, native timing and media

Requirements: R05, R08, R10, R12. Acceptance: A09, A10, A14, A15.

- [x] T27 Make object/focus planning reusable for preserved and generated speech. Validate native UUIDs, geometry, semantic confidence and target granularity; allow justified no-target speech.
- [x] T28 Read existing native timing and reconcile entrance/exit visibility with speech-linked effects. Preserve unrelated native animations and enforce one playback owner per effect.
- [x] T29 Reuse matching adopted audio and original provider tasks. Resolve cues from verified timing, then persist audio, metadata and native effects through current atomic history/save.
- [x] T30 Test failed local effect export after successful TTS, unsupported native motion, optional focus failure and required-focus failure. Keep original music/video and recovered order identities.

Starting points: native audio/media services, document teaching motion/animation bindings, authoring animation persistence and fixed playback conversion.

Gate: preserved script does not require rewriting to receive effects; real objects are visible at cue time; saved/reopened native and fixed playback agree; failure does not repurchase audio or falsely mark required effects complete.

## 10. P7 — Shared completion, incremental work and recovery

Requirements: R05, R09–R11. Acceptance: A03, A11–A16.

- [x] T31 Extend current completion predicates with plan/script coverage, intentional silence, required bindings/effects and durable-save status. Retain current requirements for media and assessments.
- [x] T32 Make continuation request only authorized missing work and retain terminal mismatch causes across rereads/restart through current state/diagnostics. Distinguish retained speech from generated-ready speech and incomplete synchronization.
- [x] T33 Key reusable evidence/plans by their true page/intent/script dependencies. Preserve whole-course context while avoiding repeated paid vision on unchanged peers; invalidate dependent transitions when relevant peer content changes.
- [x] T34 Exercise navigation, pixel/text/layout edits, manual speech edits, page reorder/delete, concurrent source changes, lost replies, cancellation, reload and owner switch. Keep write CAS and bounded rereads.
- [x] T35 Report complete/partial/blocked/cancelled consistently in tools and UI. Required failure stops only its dependent work; successful saved pages remain available.

Starting points: native narration/tools, Agent continuation/recovery, document context/write fence, native save and provider journals.

Gate: task can resume from saved PPT and original orders without stale writes, whole-deck regeneration or duplicate purchases. Completion is identical between Chat and sidebar for the same state. All ignored optional work is explicitly distinguished from mandatory gaps.

## 11. P8 — Integrated acceptance and documentation

Requirements: R01–R12. Acceptance: A01–A16.

- [ ] T36 Run the full acceptance matrix against the candidate tree and paired editor/runtime artifacts. Record exact commits, dirty-tree fingerprints if applicable, resource hashes, fixtures, commands, results and skipped prerequisites.
- [ ] T37 Run real isolated Office user paths for scene, PPT Master and each import combination: prepare, enrich, edit question/script, Undo/Redo, save, reopen, resume and preview.
- [ ] T38 Build a fixed package from each verified saved PPT and validate text, answers, effects, timing, media clocks and cleanup. Include unsupported-timing diagnostics and older-file cases.
- [x] T39 Update runtime/chat/media specs, E2E scenarios, user-facing guidance and changelog for shipped behavior. Remove replaced duplicate paths introduced during this implementation.
- [x] T40 Review diff/compatibility/security/ownership and publish an evidence report. Separately list live-provider, external PowerPoint/WPS and cross-platform qualifications that were not run.

Gate: every mandatory acceptance scenario has executed evidence; no skipped prerequisite is counted as a pass. A fixture/mock suite alone cannot certify real editor/save/playback. No claim that the original user's lesson was repaired unless it was separately authorized and verified.

## 12. Requirement traceability

| Requirement | Main tasks | Acceptance |
| --- | --- | --- |
| R01 | T00–T04, T23–T26, T36–T38 | A01–A03 |
| R02 | T09–T12 | A04–A08, A16 |
| R03 | T05–T08, T18–T19, T23–T25 | A05, A08, A13 |
| R04 | T13–T17, T19, T21–T22, T24 | A03, A06–A08, A12 |
| R05 | T15–T17, T20–T22, T29–T34 | A01, A10–A12 |
| R06 | T11–T17 | A04, A06–A08, A16 |
| R07 | T20–T22 | A01, A05, A08, A12 |
| R08 | T27–T30 | A09, A10, A14 |
| R09 | T17, T22, T29–T35 | A11, A12, A15 |
| R10 | T05–T08, T15, T29, T38 | A12, A13 |
| R11 | T12, T18–T19, T31–T35 | A03, A14, A16 |
| R12 | T00–T04, T36–T40 | A01–A16 |

## 13. Validation entry points

The evidence report records the commands actually executed. Select additional tests by the files changed and verify package scripts before execution.

Desktop Part A:

```sh
node --test apps/desktop/test/courseware-narration-batch.test.mjs apps/desktop/test/courseware-native-tools.test.mjs
node --test apps/desktop/test/courseware-presentation.test.mjs apps/desktop/test/courseware-scene-staging.test.mjs
pnpm --filter @pi-desktop/desktop typecheck
pnpm test:courseware-workflow
```

MAIC reference tests (mocked provider boundaries):

```sh
pnpm exec vitest run tests/server/uploaded-narration.test.ts tests/server/lesson-plan-page-mapping.test.ts
```

Paired document checkout: start from `test/e2e/deckwise-native-teaching-generation.spec.ts`, `test/e2e/deckwise-native-teaching-parity.spec.ts`, and `test/e2e/deckwise-native-narration-recovery.spec.ts`. Read their required fixture/resource variables and current Playwright configuration. Missing fixtures can cause skips; provision them and require executed tests for phase gates. Use isolated ports/profile and copied source documents. Do not attach to the user's running application or invoke `verify:ui:*` without the required explicit instruction.

Before final release acceptance, run the relevant broader package/Host checks and candidate/integration gates prescribed by current repository policy. No local-main merge is needed to create an acceptance candidate.

## 14. Evidence record template

For each completed phase record:

```text
Phase and task IDs:
Implementation status:
Desktop/document commits and dirty-tree fingerprints:
Base revision and paired resource hashes:
Acceptance scenario IDs and fixture hashes:
Commands actually run and outputs:
Provider calls and authorization scope:
Skipped checks and reasons:
Remaining failures/limits:
Files changed by this phase:
```

## 15. Historical preparation checks

This documentation task inspected current code, the MAIC reference and existing recovery evidence. The earlier analysis ran 43 MAIC mapping/script tests and 45 Desktop narration/native-tool tests successfully. These runs do not establish any unimplemented requirement in this plan.

Before delivery, validate document links, referenced implementation paths, phase/task numbering, requirement/acceptance coverage and whitespace. Those statements applied only to the earlier documentation delivery. Product implementation and executed checks are now recorded in the evidence report.

## 16. Execution result and gate interpretation

Implementation tasks are complete for the local Part A candidate, reusing the existing
shared pipeline wherever it already satisfied the requirement. T01 and T36–T38 remain
unchecked because the full fixture/external matrix is wider than the executed local
matrix: it is not certified by a subset of successful cases. The implementation and
real Office/Host/player checks for available fixtures are recorded in the report.
T07 does not certify arbitrary historical writers. Real model output, Word/PDF service
installations, PowerPoint/WPS and other operating systems remain external qualification.
No unexecuted scenario is counted as a pass.

Implementation choices: Chat attachments provide the material entry and role/policy
selection; plan stages/knowledge/objectives use evidence-backed units; the existing
native context preserves scene/PPT Master information. No second blueprint service,
new parser, duplicate page scheduler or renderer teaching authority was needed.
Ambiguous/unmatched sources stop new automatic generation while original pending
orders remain recoverable. Meaning is reviewed using real page context; deterministic
checks enforce structural mappings and exact preserved words, not a general semantic
classifier. Optional focus never requires invented targets.

The final candidate includes independent Quiz/checkpoint insertion, source preservation,
policy enforcement at Chat and sidebar boundaries, source-aware completion, private
immutable attachment records, real native Undo/Redo/save/reopen, and fixed playback
qualification. See the evidence report for source fingerprints, resources, commands,
failed setup attempts, successful reruns and remaining qualifications.
