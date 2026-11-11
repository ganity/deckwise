# Shared teaching enrichment: implementation approach

Status: implemented in the Part A candidate; [execution evidence](2026-11-10-shared-teaching-evidence.md) records qualification. Behavior is defined in the [design](2026-11-10-shared-teaching-design.md); implementation tasks and gates are in the [execution plan](../../plans/008-shared-teaching-enrichment.md).

## 1. Chosen approach

Extend current native teaching and continuation, retaining the three entry-specific preparation paths. Add only the missing source-material, alignment and narration-policy behavior. Reuse the existing assessment, narration, media and save modules.

Do not route scene lessons through generic PPT re-import. Do not make local authoring invoke the MAIC server runner. Do not add an independent scheduler or mutable teaching mirror.

The seam is the existing native document context: a caller supplies current document evidence, accepted teaching requirements, script policy and existing outcomes. Common enrichment decides which authorized work remains. Entry adapters provide richer evidence when available; missing data is explicit.

## 2. Ownership

| Owner | Responsibility | Existing starting points |
| --- | --- | --- |
| Renderer | Material selection/role, script treatment, conflict display, page-level progress | Courseware task, Chat workflow and teaching components under `apps/desktop/src/components/` |
| Main | Bounded extraction orchestration, current-owner checks, service wiring | `courseware-import-file.ts`, `courseware-candidates.ts`, `courseware-teaching.ts` |
| Host | Private material records, immutable extraction inputs, provider orders, authorization, verified source publication | `crates/host-core/src/rpc/courseware_projects/` and existing task/material services |
| Agent runtime | Model calls and finite continuation; request only missing authorized work | `courseware-workflow-tools.ts`, `courseware-turn-continuation.ts`, existing narration modules |
| Shared | Validated cross-process contract additions | `packages/shared/src/courseware-editor.ts` and relevant courseware schemas |
| Courseware runtime | Pure alignment/validation helpers, package read/write and immutable export | `packages/courseware-runtime/src/authoring/` and conversion/player modules |
| document checkout | Live objects, native carrier, atomic history, timing and save | `lib/deckwise-native-teaching.ts`, `lib/deckwise-native-teaching-router.ts`, `lib/embed-api.ts` |

Pure source parsing and alignment validation belong outside Main. Model orchestration follows the existing Agent dependency direction. Reuse actual extraction services found in P2; do not implement Word/PDF parsing inside a UI component.

## 3. Existing integration map

Paths in this table are relative to Desktop unless stated otherwise.

| Surface | Files | Intended change |
| --- | --- | --- |
| Scene preparation | `apps/desktop/electron/main/courseware-scene-plan.ts`, `courseware-scene-generation.ts`, `courseware-scene-deck.ts`, `courseware-scene-staging.ts` | Retain compiler/object evidence and existing teaching; supply it to shared context |
| PPT Master handoff | `apps/desktop/electron/main/courseware-presentation.ts`, `courseware-native-generation.ts`; Host `courseware_projects/presentation.rs`, `native_generation.rs` | Validate first plan-to-export association before enrichment |
| Import | `apps/desktop/electron/main/courseware-import-file.ts`, `courseware-teaching.ts`; document initialization | Add optional native-local material preparation and explicit script treatment |
| Cloud import boundary | `apps/desktop/electron/main/auth-session.ts`, `ipc/auth-ipc.ts`; `CoursewareImportDialog.tsx` | Preserve existing cloud behavior; share UI wording only where semantics match |
| Narration | `apps/desktop/electron/main/courseware-native-narration.ts`, `courseware-narration-batch.ts`, `courseware-candidates.ts` | Add preserve/match and authorized-revise behavior alongside generate-missing |
| Requirements/object views | `apps/desktop/electron/main/courseware-scene-object-view.ts`; document router | Expose validated origin, policy, bindings and coverage without losing scene semantics |
| Assessments | `apps/desktop/electron/main/courseware-classroom.ts`, `courseware-assessment-media.ts`; document assessment writers | Reuse independent Quiz/checkpoint editing, images and TTS; add idempotent activity reconciliation |
| Media/effects | `apps/desktop/electron/main/courseware-native-audio.ts`, `courseware-native-music.ts`, `courseware-native-video.ts`; document motion bindings | Reuse adopted media and actual native timing |
| Continuation | `packages/agent-runtime/src/courseware-turn-continuation.ts`, `courseware-workflow-recovery.ts`, `courseware-workflow-tools.ts` | Policy-aware missing-work selection and precise partial/blocked outcomes |
| Persistence/export | `apps/desktop/electron/main/courseware-native-save.ts`, `courseware-native-snapshot.ts`, `courseware-fixed-build.ts`; runtime native PPT packer | Versioned portable bindings and immutable snapshot parity |

These are change candidates, not an instruction to edit every file. Before each phase, inspect callers and tests and choose the narrowest shared implementation point.

## 4. Contract sketch

Use one bounded enrichment extension of existing native metadata, with shared validators at process boundaries. Keep current action types as the executable teaching representation.

Logical extension fields:

| Field group | Required contents |
| --- | --- |
| Version | Extension version and required capability identifiers |
| Source descriptors | Material ID, role, content hash, extraction version; public provenance excludes private paths |
| Script policy | Per-scope preserve/revise/generate-missing; accepted text revision and intentional-silence decisions |
| Plan bindings | Activity/stage IDs, current page UUIDs, source references, confirmation state, unresolved IDs |
| Script bindings | Stable paragraph ID, source position, original page anchor, current page UUID, accepted speech IDs |
| Evidence validity | Relevant object/page/intent fingerprints and binding method |

Exact schema is P1's deliverable. Prefer additive fields if old readers/writers demonstrably retain them. Otherwise select an explicit version/capability gate and migration path. Existing documents with absent metadata remain valid. Do not fabricate provenance for historical actions.

Every source material is immutable by hash. Replacing an attachment creates a new source revision; it does not mutate old paragraph identities in place. Reconcile unchanged paragraphs only through a verified match. Ambiguous duplicate text requires explicit alignment rather than hash-only identity.

Bound attachment count, extracted text, retained quotes, page/paragraph counts and serialized carrier size using the installed parser/model/package limits. P1/P2 must choose and test concrete limits before exposing the feature. Oversized input receives a clear diagnostic; silent truncation cannot claim complete coverage.

## 5. Main algorithms

### 5.1 Prepare context

1. Capture document, task, session, read-only and page-lock context.
2. Read the three-entry evidence plus current saved teaching.
3. Resolve source roles and narration policy from existing user choices.
4. Parse supporting materials through bounded services; retain provenance.
5. Map accepted intent and script paragraphs to stable source/native pages.
6. Validate the mapping against actual page content and report conflicts.
7. Publish accepted metadata through native history/save; retain private extraction records in Host.

Only resolved scopes proceed. Optional unresolved focus does not block unrelated speech. Missing mandatory plan coverage or ambiguous script placement blocks dependent work without discarding successful independent pages.

### 5.2 Reconcile assessments

Inventory current structural questions, activity IDs and question-like visible content. Compare with authorized plan activities. Return actions to retain, convert, insert or resolve. Apply approved changes with existing native page/history operations.

Insertion is keyed to activity ID and source-page anchor, not current ordinal or question count. A restart repeats the inventory and recognizes already-created pages. Quiz data, visible question content and editable bindings are committed together. Conversion with uncertain answers stays unresolved.

### 5.3 Resolve narration

Select policy before any speech generation call. Preserve mode parses/anchors supplied text, validates full paragraph coverage, and sends only unresolved placements to a model. Focus planning receives accepted words and real objects; it cannot return replacement speech.

Revise mode targets only the authorized scope and preserves all other speech IDs and media. Generate-missing mode invokes the existing shared deck planner and page generator. Existing accepted script and planned inserted activities form context, not replacement targets.

Materialize accepted speech through the current native write/save route. Question-reading speech remains owned by the assessment path. A retry reads saved actions before regenerating them.

### 5.4 Effects and audio

Prepare existing native animation visibility and effect ownership. Resolve spoken references to valid objects; retain no-target reasons for organizational speech. Generate only authorized missing attention/effect intents. Adopt or reuse audio through the existing services, then materialize measured cue timing and native effects atomically.

If local timing export fails after TTS succeeds, retry local export against verified audio. Do not submit another TTS order. Reject stale text or ambiguous targets before adopting the result.

### 5.5 Completion and recovery

The continuation reads native state and computes the pending set. It does not infer completion from file existence, speech count, a successful tool envelope, or a planned Quiz count.

Mandatory predicate: resolved authorized requirements + complete approved script coverage/intentional silence + valid required targets + verified required media + persisted required timing + durable save.

Each failure identifies the stage, page UUID/display number, stable code, retryability and corrective action. Error classes: extraction, alignment, content mismatch, stale evidence, owner/lock, provider pending/unknown, unsupported effect, save/export failure. Use existing error transport and sanitization.

## 6. Persistence and concurrency

Retain current native compare-and-swap checks and Office history. Capture relevant content fingerprints before expensive work, re-read immediately before writing, and include required revisions in the atomic command. Reading twice alone is not atomic validation.

Navigation can advance Office generation without changing content. Revalidate relevant content rather than discarding valid output solely because the counter changes. If the editor cannot prove unchanged content, stop or perform bounded refresh; do not weaken the write fence.

Concurrent manual teaching changes are authoritative. Do not overwrite them during automatic recovery. Independent successful pages remain saved; a subsequent page failure returns partial completion. For course-wide dependency changes, invalidate affected unsaved work and flag accepted work needing review rather than rewriting it automatically.

Resume saved teaching from the PPT. Resume uncertain media orders from original Host journals. A cache or in-memory failure map may improve efficiency but cannot be the only correctness guard after restart.

## 7. Migration and rollout

1. Characterize current scene, PPT Master and import behavior with fixtures.
2. Add validated metadata and compatibility handling without changing which generation path runs.
3. Deliver native-local material preparation and script preservation as a vertical slice.
4. Add blueprint alignment and assessment reconciliation.
5. Adapt scene/PPT Master context while preserving their entry-specific generators.
6. Make shared completion/effects/recovery consume the new state.
7. Qualify cross-entry editor/save/reopen/playback and remove replaced duplicate code.

Existing legacy/server routes remain supported until deliberately migrated. Temporary old/new implementations of the same native operation must have a removal task in the same phase. Avoid a permanent flag per entry; select work by policy, evidence and existing outcomes.

Before enabling writes, publish the carrier extension ADR and compatibility matrix. Rollback may disable new enrichment while retaining readable content. Reverting a binary that cannot preserve new metadata is not a safe editing rollback. Preserve verified saved revisions and use the existing explicit recovery mechanism.

## 8. Validation strategy

Characterization: prove existing scene lessons retain physical slides, semantic associations, question/answer data, media bytes, native timing and playback.

Pure/contract: anchor parsing, paragraph conservation, blueprint mapping, idempotent activity reconciliation, dependency fingerprints, schema limits and version gates.

Integration: native context to proposal to atomic write to save; real internal collaborators with fake model/media boundaries. Assert persisted output, not only called mocks.

Real Office: source-page anchors after inserted assessments, Undo/Redo, save/reopen, selection vs actual edits, lost replies, original notes and manual edits preserved. Use isolated copied fixtures and paired editor resources.

Fixed player: exact accepted speech and correct answers; ordered native/speech effects without duplication; media clocks and cleanup. The fixed package must come from the verified saved PPT snapshot.

Provider quality: separate, explicitly authorized qualification. Provider-free green tests establish control flow and persistence, not fresh semantic quality or billing acceptance.

## 9. Risks and resolution points

| Risk | Required treatment before dependent work |
| --- | --- |
| Carrier extension lost by old writers | P1 round-trip tests and version/capability gate |
| Local Word/PDF extraction not available or differs from cloud | P2 capability inventory, supported-format tests and explicit unsupported outcome |
| Scene semantic roles lost in native handoff | P0 characterization and P5 binding retention checks |
| Plan mapping silently loses stages | Track actual deliveries and unmatched coverage; no silent fallback success |
| Fixed script lacks speech on some pages | Record intentional silence or unresolved scope; never auto-fill by count |
| Structural insertion changes paragraph targets | Anchor original source identities before insertion |
| Full-page raster cannot support object-level cues | Report unsupported target granularity; do not invent objects |
| Exact speech conflicts with teaching intent or artwork | Preserve both inputs and resolve explicitly |
| Existing concurrent Part A edits | Re-read files/status at each phase; record actual tested tree; preserve unrelated work |

## 10. Documentation and publication

As behavior ships, synchronize the existing courseware runtime/chat/media specs and E2E scenarios. Update the native authority ADR only for the accepted extension decision, not to declare unimplemented behavior.

This document is a plan on the user-selected Part A branch. It does not authorize deployment, provider purchases, commits, pushes or main integration. Older delivery documents contain conflicting automatic-commit/local-main rules; root `AGENTS.md` and the user's explicit Part A scope govern this task. Record that documentation drift rather than following the stale instructions.

## 11. Concrete implementation

| Concern | Delivered seam |
| --- | --- |
| Portable contract, exact paragraph parsing, coverage | `packages/shared/src/courseware-enrichment.ts`; mirrored wire validator in document `lib/deckwise-teaching-enrichment.ts` |
| Private restart-safe source text | Host `rpc/courseware_projects/materials.rs`, existing SQLite KV namespace `coursewareMaterials.v1` |
| Attachment extraction and source IDs | Existing `ipc/agent-ipc.ts` attachment processing; immutable source IDs supplied to agent tools |
| Script/plan acceptance | `courseware-native-materials.ts` via `courseware_narration_import`; preview, mapping validation, policy and native writes |
| Independent activities | `courseware-native-activities.ts` via `courseware_activity_insert`; existing authoring projection, evidence-backed answers, stable identities |
| Real physical slide/history | document `slide-assessment-insertion.ts`, native carrier/router and existing edit-generation fence |
| Three entry convergence | Existing native context retains scene/PPT Master generation requirements; optional enrichment enters the same narration batch |
| Preserved speech effects | Runtime narration repair accepts absent generated requirements, retains exact speech/audio and binds only safe real targets |
| Completion/recovery | Existing NativeTools and continuation; source coverage is mandatory and successful partial pages are saved |
| UI | Existing teaching panel displays localized source policy and unresolved item count; Chat reports source/mapping results |
| Qualification | Real Office material adoption/Undo/Redo/reopen, Host snapshot/restart/build, and browser playback verification |

No new database migration, dependency, workflow scheduler, generic import pipeline or
cloud runner was introduced. No user app instance or actual lesson was modified.
PPT-only and older native documents omit enrichment and retain their current path.
Current paired editor resources are required for applying this extension.

Source limits: local TXT/Markdown <= 2 MiB UTF-8; immutable records <= 2 MiB per text,
16 sources and 8 MiB aggregate per task; scripts/plan text <= 500,000 characters;
portable extension <= 2 MiB, <= 100 original pages/plan units and <= 1,000 script
segments of <= 4,000 characters. Word/PDF retain service-specific input limits and
are not promised for scanned or unreadable files. Structured-format live extraction
and production model/TTS quality are external qualifications, not fixture results.

The source extension is separately versioned and bounded. New Main requires editor
capability version 1; current old-shape page writers preserve the optional extension.
Unknown versions fail before writes. External applications that strip custom XML
are outside this compatibility guarantee. See the [ADR](../adr/shared-teaching-enrichment.md).
