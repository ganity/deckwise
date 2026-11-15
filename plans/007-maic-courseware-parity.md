# Plan 007: Make DeckWise authoring and published courseware conform to MAIC

Date: 2026-11-04
Status: LOCAL ACCEPTANCE PASSED — authenticated online publication remains open; legacy migration excluded by user on 2026-11-04
Priority: P1; effort: L across several independently testable changes; content/storage change risk: HIGH.
Dependencies: retain the invariants delivered by plans 001–006. This plan supersedes their explicit exclusion of MAIC quiz/interaction parity for the scope below.

## Execution checkpoint — 2026-11-04

Implementation is isolated in `/home/jhz/code/train/deckwise-desktop-worktrees/maic-courseware-parity`, branch `feat/maic-courseware-parity`, based on `845295e9505bf55003542f2886f738e29779e0e0`. The original working tree and reference applications remain unchanged apart from these plan files. The implementation is not yet accepted as complete.

Independent checks so far (the commands run in the isolated implementation tree):

- Main/editor/native-sync/TTS/build/preview: 46 tests passed. This includes stable option/image ownership, revision-bound draft recovery, atomic question/canvas edits, image attachment failures, native-save conflicts, scoped TTS adoption and canonical default build/preview routing.
- Generator/planning/staging/workflow: 71 tests passed, including mixed and all-Quiz generation without fake native pages. The two earlier planning assertions have been reconciled with independent Quiz semantics.
- Shared workflow: 13 tests passed. Runtime MAIC export/loading and playback: 31 tests passed, including failed browser narration retry/skip.
- Desktop and runtime TypeScript checks passed; working diff whitespace check passed. With the current linked dependencies, use `pnpm_config_verify_deps_before_run=false` for pnpm commands to avoid its automatic dependency-install preflight.
- Earlier full Host courseware-project regression: 268 passed, 2 ignored. The subsequent empty chapter/reference summary regression also passed. This fixes a real Main/Host autosave rejection found during actual Electron acceptance; required fields remain required and must be strings.
- MAIC action/stage/interaction/slide source hashes match the pinned current authority. MAIC and cloud-web working trees remain clean.

Final actual Electron/Main/Host acceptance passed all ten journeys, including image uploads, autosave, undo/redo, independent interaction authoring, all four assessment question types, both playback modes, failure recovery, restart equality and blank drafts. The strict actual MAIC package projection and cloud-web consumer checks passed. The subsequent host-style reference gate also passed for assessment cards and instant controls, including OS theme, explicit `.dark` and disabled states. See [the acceptance record](007-maic-courseware-parity-acceptance.md) and its preserved reports/artifacts for exact scope, source fingerprints and limitations.

Known release boundaries: local MAIC ZIP export is unsigned; trusted package signing remains on MAIC server. The old team fixed-build publishing endpoint does not accept canonical MAIC packages, and this implementation explicitly rejects that path rather than uploading a different format. Offline short answers remain explicitly ungraded. These are not evidence of authenticated online publication or online AI grading.

## Objective and decisions

The user requires final PPTist/classroom data to follow MAIC exactly, Quiz and interaction_checkpoint to be distinct, and the editor to support both fully. All three are release requirements, not optional follow-ups.

“PPTist format” means MAIC's actual Classroom/Stage/Scene/Action and resource contracts: slide scenes contain PPTist canvases, quiz scenes contain questions. Do not force quizzes into PPTist Slide objects. Do not introduce a new scene type named interaction_checkpoint. Do not change MAIC to accept DeckWise-specific payloads as a shortcut.

The target is the inspected MAIC revision below, including its supported optional fields, rather than an unversioned claim about all future MAIC releases. Revalidate the reference revision when implementation begins. MAIC is the data authority; cloud-web is the editing and presentation reference. Existing differences between their types must be resolved against MAIC and real fixtures before code generation or schema freezing.

Keep Host ownership of persistence; Renderer -> Preload -> Main -> Host remains the process boundary. Use existing source/revision checks, asset ownership, TTS/media task queues and cancellation. No provider migration, unrelated editor rewrite, or duplicate payment flow.

## Inspected baselines and drift

| Role | Absolute source root | HEAD at planning |
|---|---|---|
| DeckWise implementation | /home/jhz/code/train/deckwise-desktop-worktrees/courseware-par-A | 722cb123af4b9273ba6dad322d5959246e4a725d |
| MAIC contract/publisher authority | /home/jhz/code/train/evo-trainwise-maic-server | d8cde962d01d6722b710b32c11b161c54732c6e0 |
| cloud-web editor/player authority | /home/jhz/code/train/cloud-web-trainwise | 9cea9d86a0fc8286a6fbe548eab580d6e3352ac2 |
| Embedded WiseOffice | /home/jhz/code/train/document-worktrees/wiseoffice-native-teaching | 38afd920d1451945b3b4dd6a60f79430cda56c41 |

DeckWise and WiseOffice have substantial pre-existing uncommitted work. HEAD alone does not identify the inspected implementation. See `007-maic-courseware-parity-baseline.json` for selected working-file hashes. The older MAIC worktree `maic-server-worktrees/courseware-par-C` is NOT the contract baseline; it lacks some current fields such as constraintPrompt.

Before execution, run `git status --short` and `git diff --stat <baseline-SHA> -- <owned-paths>` in each repository and compare baseline hashes. Read applicable AGENTS.md and package instructions. Establish an isolated implementation branch/worktree using the active repository workflow; explicitly reconcile required current changes instead of losing them by starting blindly from an older branch. Do not discard or silently copy unrelated dirty changes. Do not merge, publish, deploy or restart the user's editor as part of preparing this plan.

## Verified current behavior

1. `apps/desktop/electron/main/courseware-scene-plan.ts:51,75,129` encodes questions as `teaching.question={text,response}` and requires question/options in PPT visibleText.
2. `courseware-scene-deck.ts:88-92` compiles all pages to PPTX and attaches teaching metadata to page mappings.
3. `packages/shared/src/courseware-question.ts` only accepts `{kind,options:string[],answerIndices:number[]}`.
4. `packages/shared/src/courseware-editor.ts:124` rejects checkpoint fields outside its exact list, including MAIC constraintPrompt and reference/context extensions.
5. `packages/courseware-runtime/src/conversion/lib/courseware/fixed-build.ts:413` writes `{schemaVersion:'deckwise-playback/1',report,pages,assets}`. `src/player/lib/courseware/load-fixed-build.ts:530` constructs every scene as `type:'slide'`.
6. `src/player/components/courseware/FixedCoursewarePlayer.tsx:323` renders question checkpoints in a teacher-wait panel. `TeachingQuestionResponse.tsx` renders text choices, local set equality, and ungraded text responses.
7. WiseOffice `lib/deckwise-teaching-sidebar.ts:2117-2239` already edits question/reference answer/key points and text choices/correct indices. Those controls exist in the staged Desktop JS. It does not implement Quiz scene authoring or option-image bindings. Its existing focused edit test passed during analysis.
8. `crates/host-core/src/db/courseware_projects/workflow.rs:81` compares saved question actions against separately retained plan metadata. Updating the question alone can diverge from the retained requirement.
9. Nine local `apps/courseware-copies/*/lesson.teaching.json` samples use DeckWise sidecars. The inspected single/multiple questions are chapter_summary checkpoints with response, not MAIC Quiz content. These are evidence, not files to mutate or delete.
10. MAIC `lib/types/stage.ts` defines QuizContent/QuizQuestion/QuizOption. `lib/interaction/types.ts` defines question, constraintPrompt, referenceAnswer and context. `lib/contracts/classroom.ts` defines classroom, mediaManifest and audioManifest.
11. cloud-web `components/scene-renderers/quiz-view.tsx` implements dedicated editing, stable option values, images, answer selection and narration updates. `components/canvas/editor-panels/interaction-constraint-prompt.tsx` implements prompt/reference/key point edits. `lib/classroom/save-classroom-draft.ts:263` waits for pending uploads/TTS, synchronizes interaction content and persists scenes/manifests.
12. MAIC `lib/server/classroom-package-export.ts:733` creates meta.json, optional playback/kindergarten-v1.json, and signed META-INF entries. Its publisher retains separate question/option image bindings.

## Target architecture

Maintain a Host-owned versioned local project envelope with two separated parts:

- MAIC content: canonical classroom/stage/scenes/actions/manifests, using MAIC field names and semantics verbatim.
- Local state: native PPT bindings, source digests, revision/CAS values, drafts, original plans, provider job receipts, immutable build records and file locations.

The local envelope may have a new internal schema version. Do not inject that version or local fields into MAIC scene/actions. The final MAIC content is produced from one immutable saved revision, never read piecemeal from live editor state. Scene metadata permitted by MAIC is preserved, but arbitrary metadata is not a place to hide executable DeckWise-only semantics.

Store authored structured Quiz and interaction data durably; do not reconstruct it from PPT text, OCR, option positions or regenerated LLM output. For PPT-backed slides, use the verified saved PPT conversion as the canvas source. Keep a derived canonical canvas tied to its source hash; refresh it through the existing save/rebind path. Quiz content has no native PPT source requirement. One scene has one authoritative content owner; no competing writable question copies.

A course-level ordered scene list is authoritative. Native slide mapping is a partial mapping from logical sceneId to saved native page identity, not scene index to slide index. Quiz scenes can be between native slides without adding fake quiz slides. Native source reorder updates mapped slides deterministically while preserving explicit quiz placement; ambiguous reorder/deletion must produce a resolvable conflict, not silently relocate questions. Editor navigation, thumbnails, counters, source save, recovery and playback must use this list. Mixed courses and all-Quiz courses must work without requiring a fictitious PPT source for every scene.

Final flow:

`generation/import -> Host canonical content + local bindings -> saved revision -> MAIC classroom snapshot -> editor preview / standalone preview / publisher`

All course previews consume this snapshot's content and common presentation/state logic. Native slide rendering may remain an alternate canvas surface, with shared scene scheduling. Ordinary PPT-only slideshow remains explicitly a PPT utility; it cannot represent a mixed MAIC course and must not be the default course-preview command.

## Separate domain contracts

### Quiz

Use `Scene.type='quiz'` and `Scene.content.type='quiz'` with `questions`, `interactionMode` and `playbackConfig`. Follow MAIC fields for each question: id, type (single/multiple/judge/short_answer), question, optional image, structured options, answer values, analysis, commentPrompt, referenceAnswer, keyPoints, hasAnswer, points, plus any optional fields present in the pinned source.

Options use stable `value` keys with `label` and optional `{src,assetId,mimeType}` images. Answer arrays refer to values, never indices. Reordering must preserve answers/image references. Deleting an option removes its answer reference and owned manifest binding atomically; shared asset bytes remain until reference-aware cleanup. An incomplete question can exist as a draft; publication requires MAIC-consistent validation, never an invented default correct answer.

Quiz evaluation and progression belong to the Quiz state machine. Never manufacture chapter_summary checkpoints to implement Quiz answering. Preserve valid MAIC ancillary actions; do not blindly forbid unrelated legitimate media actions in Quiz scenes.

### Interaction checkpoint

Use a MAIC slide scene with editable PPTist content and an `actions[]` entry of `type='interaction_checkpoint', checkpointKind='chapter_summary'`. Retain chapterId/chapterTitle/question/constraintPrompt/referenceAnswer/context and valid MAIC optional action fields. Use metadata.interaction and the MAIC interaction template conventions where applicable.

This is a question/task handoff with reference guidance, not an objective Quiz. Do not write the legacy response/options/answerIndices extension to this action. Do not reinterpret checkpointKind=media_playback as a classroom question. `Scene.type='interactive'` is MAIC's HTML/URL activity scene and is NOT a synonym for interaction_checkpoint.

Changing a question updates its authoritative text and its bound visible question element in one revision. Preserve unrelated slide art. A reference-answer edit must not overwrite chapterSummary: the former is grading guidance, the latter is lesson context. Preview hides reference guidance from the learner unless the MAIC mode explicitly exposes it.

### Every action and resource, not only questions

Create an exhaustive action compatibility inventory at P0; the target MAIC Action union does not declare several current DeckWise action names. Release must not silently omit them:

| Existing local concept | Required target treatment |
|---|---|
| speech + audioAssetId | MAIC SpeechAction fields and matching audioManifest; preserve text/source and supported timing |
| audio_clip/video_clip | MAIC audio/video canvas elements, manifest entries and play_audio/play_video or media_playback semantics where behavior is equivalent |
| speech visual cues/native_animation | MAIC element_animation/spotlight and supported native/PPT timeline representation; validate targets, timing, once-only execution |
| teacher_continue/delay | Prove mapping against actual MAIC pause/click timing semantics; no fabricated empty question or incorrect media checkpoint |
| music_slot/video_slot | Unfinished local jobs; resolve or explicitly remove by author decision before publication; never export pending markers as MAIC actions |

If an existing local action cannot be represented equivalently in the pinned MAIC contract, retain the original project and report a specific unsupported item. Do not call its publication compatible. New compatible generation must restrict itself to supported MAIC behavior. This is a mandatory P0 decision gate, not a late export cleanup.

## Editor specification (mandatory)

Add a course-level scene navigator integrated into the current editor shell. Offer distinct “Add Quiz” and “Add interaction” commands. Selecting Quiz opens its structured editor in the central content surface; selecting an interaction opens its native slide and interaction settings. Keep speech, media and animation tools available where valid. Preserve draft, autosave, undo/redo, read-only and revision-conflict behavior.

Quiz editor:

- Add/remove/select questions subject to MAIC interaction-mode policy; support all four question types and both playback modes.
- Edit question text, options, correct answer, analysis, scoring/reference guidance, points and playback settings.
- Add/remove/reorder options with stable values, image bindings and correct single/multiple/judge validation.
- Upload/replace/remove question and option images using existing Main/Host asset staging; optional existing generation actions reuse the authorized job pipeline.
- Show actual image option cards matching cloud-web, including image-only labeled choices. Use shared presentation tokens/components rather than another handwritten approximate layout.
- Snapshot/undo groups include question JSON, resource bindings and answer changes. A pending upload must block “saved/publish” completion until resolved; cancelled or late uploads cannot attach to another question.
- Content edits invalidate the appropriate speech/audio revision and trigger the existing authorized regeneration flow. Image-only edits do not unnecessarily regenerate speech. Failed TTS must not restore old question text or silently play stale narration.

Interaction editor:

- Edit visible question, reference summary, add/remove/reorder key points, constraintPrompt and existing chapter/context fields with MAIC-compatible limits.
- Reuse cloud-web's “update reference from current question” behavior through the existing authorized service path, including stale-response protection.
- Keep chapter context distinct from reference answer. Support optional/empty fields exactly as MAIC allows, rather than the current blanket nonempty requirements.
- Insert/remove/move the checkpoint at an explicit teaching-flow position while preserving before/after narration and media.
- Editing the bound canvas question and editing its structured form must converge on the same saved question. Ambiguous canvas bindings require explicit selection, not text guessing.
- A separate interaction module must not expose Quiz option/image/answer-index fields.

Reuse cloud-web editor/player pure components and helpers by extracting transport/store dependencies into explicit props and callbacks. Keep a pinned source inventory and differential fixtures so shared behavior does not drift. Prefer the existing runtime package to a new generic UI platform. Do not import Next routing, cloud-web stores, server secrets or direct filesystem access into the embedded editor. Route asset/model requests through Main and authoritative writes through Host.

## Implementation phases and ownership

Each phase includes implementation, tests and review. Phases are not independently sufficient for claiming complete delivery.

### P0 — Freeze the contract and acceptance corpus (M)

Scope: MAIC types/contracts/interaction/publisher as read-only authority; Desktop runtime/shared fixtures; docs/adr and relevant domain specs during implementation.

1. Record source hashes for transitive Scene/Slide/Action/Classroom/manifest contracts and required package projections, not just stage.ts.
2. Produce valid MAIC fixtures for image choice, multiple, judge, short answer, both Quiz modes, chapter interaction with all optional fields, media checkpoints, 16:9 and 16:10, and mixed courses.
3. Add an executable contract checker and reference adapter tests; distinguish allowed asset URL rewrites and server-managed metadata from content changes. Never normalize away unknown field loss, scene order, answer values or action order.
4. Inventory every generated local action and settle the translation table above. Audit the MAIC import/persist/export consumer paths rather than relying only on TypeScript assertions.
5. Record an ADR for canonical MAIC content, local-only state and the mixed scene/native-slide mapping. Update the old parity spec's narrowed goals.

Proposed new gate: `node scripts/check-maic-courseware-contract.mjs` from DeckWise. It must fail on the current checkpoint-as-Quiz representation and pass only after correct fixture handling. New command, to be implemented, not an existing green check.

### P1 — Canonical content, Host persistence and mixed scene identity (L)

Scope: `packages/shared/src/courseware-contract.ts`, `courseware-editor.ts`, scene/question contracts; `crates/host-core/src/db/courseware_projects.rs` and its portable/snapshots/identities/scene_objects/scene_teaching/workflow/candidates/native_save modules; related RPC/Main/preload contracts.

1. Introduce versioned local storage for canonical MAIC scene content, separating local identities/tasks from content. Use explicit version boundaries and downgrade refusal for new data; do not implement legacy content migration.
2. Replace the assumption that project pages and PPT mapping pages have identical cardinality. Add explicit content revision and partial native bindings with stable IDs.
3. Introduce schema-validated typed writes for Quiz content and interaction edits using the existing authority/CAS mechanism; do not create arbitrary unchecked JSON patch RPCs.
4. Atomically persist question/answers/resource references and revision; extend snapshots, portable copy/reopen, locks, history and source-change recovery.
5. Make author-approved current content the requirement source. Retain original plan as provenance; do not flag every deliberate question edit as a failed generated requirement.

Verify shared contract fixtures and real SQLite persistence tests, including mixed reorder/deletion, concurrent save, stale native edit, all-Quiz content, source replacement and rollback. Run `cargo test -p host-core courseware_projects` plus shared targeted Vitest cases.

### P2 — Generate native MAIC Quiz and interaction content (L)

Scope: `apps/desktop/electron/main/courseware-scene-plan.ts`, scene-deck/generation/staging/generator and saved-narration/narration-batch/object-view; runtime authoring/conversion contracts; relevant agent tool schemas/prompts.

1. Generate canonical Quiz questions directly, including stable choices, image references, interactionMode and playbackConfig. Do not render a Quiz into an ordinary PPT then reconstruct it.
2. Generate interaction slide content with deterministic bound question element and a separate MAIC checkpoint. Keep answers/prompts off the learner-facing canvas.
3. Only PPT-backed slides go through native visual decomposition/compile. Maintain overall scene order and partial mapping across compilation.
4. Scope narration/TTS/images to canonical scene/question/option IDs and revisions. Correctly regenerate only changed derived content.
5. Add phase-aware Quiz intro/review narration using cloud-web/MAIC behavior. Teacher-led interactions must not invent an observed student result.

Verify mocked generation for mixed and all-Quiz courses, image assets, save/reopen and each response type; no paid generation is required for this gate. Run targeted Main tests plus shared/runtime checks.

### P3 — Ship full Quiz and interaction editing (L)

Scope: Desktop workpanel/editor navigation and native-sidebar bridge; WiseOffice `lib/deckwise-teaching-sidebar.ts`, editor bridge/module integration; shared runtime UI; cloud-web quiz-view/quiz-option-editing and interaction editor helpers as extraction sources.

Implement all editor requirements above. Quiz must be a selectable scene with a real editor, not hidden JSON or a text-only teaching node. Move existing useful native checkpoint edits into the dedicated interaction surface. Asset APIs must accept explicit scene/question/option target and expected revision. Update actual bundled module packaging and native editor integration tests, not just unused Desktop React components.

Verify edit-save-close-reopen, undo/redo, image replacement/deletion, stale uploads, invalid answers, locks and two competing edits. Browser tests must interact with the real embedded module and confirm persisted Host content. Add named tests `test/e2e/deckwise-maic-authoring.spec.ts` in WiseOffice and corresponding Desktop bridge tests.

### P4 — Unified preview and Quiz behavior (L)

Scope: runtime `FixedCoursewarePlayer`, loader/playback core, native teaching preview/slideshow bridge; extracted cloud-web scene and Quiz presentation/state helpers.

1. Replace the all-slide reconstruction with canonical scene dispatch. A classroom Quiz uses its own renderer/state; interaction pauses are emitted only by the appropriate action.
2. Match both Quiz modes, intro-only-on-entry, retries, success/failure cues, review/advance behavior and answer-image cards to the pinned cloud-web implementation.
3. Preserve interaction pause/resume and reference/constraint semantics. Wire any MAIC-required online evaluation through existing authorized APIs; offline inability must be explicit, with no fabricated assessment or silent fallback. Local objective scoring remains available.
4. Use the same saved content and state logic in embedded course preview and exported preview. Native canvas can render slides, but cannot skip virtual Quiz scenes.
5. Verify pause/seek/replay/scene-change clears stale callbacks and selected answers according to reference behavior; narration, animation and video never execute twice.

Verify state transition tests plus deterministic screenshot comparisons at the screenshot reference layouts and smaller laptop sizes. Compare behavior events, not only pixels. Existing native timing and media regressions remain mandatory.

### P5 — Emit and consume actual MAIC artifacts (L)

Scope: runtime `adapt-canonical-snapshot.ts`, fixed-build/input and load-fixed-build; Desktop fixed-build/build-files and Host snapshots/share; MAIC publisher/compiler as authority.

1. Serialize the saved MAIC classroom structure (stage/scenes/actions/metadata/mediaManifest/audioManifest). Exclude local absolute paths, job receipts and editor-only state.
2. Bind and archive question/option images exactly through MAIC manifest conventions. Preserve answer values, optional fields, timing references and media hashes.
3. Reuse the MAIC packaging projection: meta.json, resources, and the conditional kindergarten playback bundle with required metadata. Keep any DeckWise build report outside the MAIC content contract.
4. For trusted published ZIPs, use the existing MAIC server signing/publishing path. Never embed server HMAC secrets into Desktop, fabricate production signatures, or weaken server verification. Local canonical preview/export can be generated without pretending to be a trusted published package.
5. Load the artifact using the reference MAIC/cloud-web paths. Keep a separate legacy DeckWise package reader for existing archives; all new canonical production uses MAIC format.
6. Prevent successful export if a required asset, reference, action conversion or metadata requirement is missing. Do not silently drop or rasterize Quiz semantics.

Verify package contents, MAIC consumer acceptance, resource-byte equality, both viewport presets and authenticated publication in a test environment with test signing material. Production publication is outside plan preparation.

### P6 — Excluded by user

Legacy-project migration is out of scope. The user confirmed all existing courses are development/test data. Do not implement migration adapters, conversion wizards, backfills or migration acceptance. Do not delete the existing test files or project data. New-format writes and explicit unsupported-format errors are sufficient where necessary.

### P7 — Cross-application release acceptance (M–L)

Create `scripts/check-maic-courseware-parity.mjs` to run the fixture/contract/package matrix and write a machine-readable report with tested revisions. New command, implementation required. Add real browser acceptance in Desktop/WiseOffice and cloud-web.

Required journeys:

1. MAIC fixture -> DeckWise open -> edit Quiz/interaction -> save/reopen -> MAIC export -> cloud-web open/edit/play.
2. DeckWise generation with mocked providers -> structured author edits -> native/fixed preview -> MAIC consumer.
3. Fresh mixed and all-Quiz projects -> author edits -> restart -> same canonical output; legacy migration is excluded.
4. Image-only option cards matching the user's first screenshot; editable interaction prompt/answer matching the second screenshot's scene semantics.
5. Missing assets, stale revision, deleted/reordered options, orphan answer, repeated imports, cancellation, offline service failure, native slide save/reorder and crash recovery.

Do not mark DONE from a green schema test, skipped browser fixture, UI-only screenshot or successful PPTX import. The final report must distinguish data compatibility, behavior parity, visual parity and unsupported input cases.

## Dependency order and sizing

| Phase | Depends on | Status |
|---|---|---|
| P0 contract and fixtures | none | Local contract/provenance and actual-consumer gates passed |
| P1 canonical Host/storage | P0 | Implemented; persistence, fences and real restart checked |
| P2 generation | P1 | Implemented; mixed/all-Quiz generation checked |
| P3 editor | P1 | Implemented in Desktop course editor; real Main/Host authoring checked |
| P4 player | P1, P0 reference UI extraction | Local playback and reference UI gates passed; online grading excluded from acceptance |
| P5 export/import | P1, P0 action mapping | Local MAIC export and actual consumers passed; authenticated signed publication remains open |
| P6 legacy migration | Excluded by user | OUT OF SCOPE |
| P7 integrated acceptance | P2–P5 | Ten local desktop journeys and actual-consumer checks passed; online/native visible round-trip boundaries recorded |

P2–P5 can be assigned independently only after P1 contracts are frozen and file ownership is agreed; overlapping shared/schema/persistence edits must remain sequential. This plan does not dispatch implementation agents. Relative size is multiple work packages across Rust, TypeScript and three application surfaces, not a CSS patch; do not commit to a delivery date before P0 establishes action-conversion scope.

## Verification commands

Existing commands verified from package scripts or previously executed:

- DeckWise: `pnpm -C apps/desktop typecheck`; `pnpm -C apps/desktop build`.
- Shared: `pnpm --filter @pi-desktop/shared exec vitest run` (narrow filenames during a phase).
- Runtime: `pnpm -C packages/courseware-runtime test`; `pnpm -C packages/courseware-runtime typecheck`; `pnpm -C packages/courseware-runtime build`.
- Main: `node --test apps/desktop/test/courseware-*.test.mjs` (narrow files per phase).
- Host: `cargo test -p host-core courseware_projects`; `cargo build -p host-core`.
- WiseOffice: `pnpm exec vitest run test/unit/deckwise-teaching-sidebar.test.ts`; `pnpm run build:module`; `pnpm exec playwright test test/e2e/deckwise-maic-authoring.spec.ts` once the new test is implemented.
- cloud-web: `npm run typecheck`; `npm run test -- lib/classroom/quiz-option-editing.test.ts components/canvas/editor-panels/interaction-constraint-prompt.test.tsx`; `npm run test:editor -- tests/editor/maic-courseware-parity.spec.ts` once added.
- MAIC: `pnpm exec tsc --noEmit --skipLibCheck`; `pnpm exec vitest run tests/server/classroom-package-export.test.ts tests/generation/kindergarten/publish-compiler.test.ts`, plus new contract-consumer cases.
- New P0/P7 scripts above must exit 0 and report every mandatory fixture executed; an empty or all-skipped run fails.
- Every modified repo: `git diff --check`; inspect scoped git status for unrelated changes.

Run tests in isolated fixtures with mock services. Real cloud/API generation, production publication and paid TTS/image tasks need existing session authorization or a separate concrete acceptance step. Existing unrelated failures are recorded against the baseline, not silently fixed or hidden. Match existing Vitest, node:test and real SQLite patterns. Maintain meaningful regression cases; do not add tests that merely restate constants.

## Release checklist

- Final new output uses the pinned MAIC Scene/Slide/Action/Classroom/manifest contract and actual consumers accept it.
- Quiz is not represented as chapter_summary+response, and checkpoint editing has no Quiz options/indices fields.
- Both dedicated authoring surfaces support required edits; data survives restart, undo/redo and export.
- Question/option images remain attached by stable IDs, answers remain correct after reorder/deletion, and stale callbacks cannot mutate another scene.
- Mixed and all-Quiz scene ordering works without 1:1 PPT page assumptions.
- Previews and published player use the same saved semantic content; reference visual and behavior checks pass.
- Local-only actions are faithfully converted or explicitly block compatible publication; none are silently erased.
- Existing development/test project files are not deleted; legacy migration is excluded.
- No production signing secrets or local paths enter artifacts; required package assets and conditional kindergarten metadata are complete.
- All build artifacts used by the acceptance app are from the tested source revision; fresh test process loads matching Host/runtime/WiseOffice bundles.

## Rejected shortcuts and maintenance

Rejected: add CSS to the existing wait card; rename a field to quiz; keep quizzes as native PPT slides with answers only in a sidecar; add image URLs to string options; accept arbitrary JSON and claim compatibility; fix only the outer Desktop panel; generate fake reference answers during migration; alter MAIC's schema to hide DeckWise mismatch.

Future MAIC contract updates must change the pinned provenance, fixtures, validators and differential consumer checks together. Keep imported optional fields and unknown future fields distinguishable: preserve future data where safe, but reject unsupported editing/publication explicitly instead of stripping it. Do not claim future-version compatibility merely because parsing succeeds.

## Stop and report conditions

Pause the affected implementation phase if the referenced production contract differs materially, an action has no faithful MAIC equivalent, server signing cannot be accessed through an authorized existing path, or required source changes belong to another unmerged task. Continue independent authorized work while resolving the specific issue. Do not widen scope or weaken validation to make a test green.

## Planning validation and limits

The original planning analysis inspected generation/storage/editor/player/export code, nine saved sidecars, staged WiseOffice assets, and ran actual checkpoint rejection probes plus a native-sidebar edit regression. That planning evidence is historical. Subsequent implementation and executed local gates are recorded in [the acceptance record](007-maic-courseware-parity-acceptance.md); commands originally proposed above do not become claimed executed checks unless listed in that record. In particular, no authenticated online publication or full visible WiseOffice/cloud-web application round trip is claimed.

Execution baseline: cloud-web selected editor helper/settings tests 17/17 passed; MAIC selected package-export/publish-compiler tests 23/23 passed on 2026-11-04. These are reference checks, not evidence that DeckWise parity is implemented.
