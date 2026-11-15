# Plan 009: Education Courseware Routes and Stage-Aware Scene Visual Masters

**Status:** TODO; remaining plan work only. **Created:** 2026-11-11. **Revised:** 2026-11-13.
**Scope:** PI Desktop courseware generation, Skills, Scene image prompts, and shared teaching workflow

## Outcome

Make the Desktop's three courseware entry paths consistently education-first, Skill-directed, and honest about their different production capabilities:

1. **New deck (ordinary generation / PPT Master authoring):** create a complete course presentation using the selected authoring Skill and capabilities available to that route.
2. **Scene:** generate each complete body page as one raster Visual Master. The image model renders body-page text, formulas, charts, number lines, tick marks, labels, diagrams, and illustrations together. The app then separates suitable visual regions and adds narration, animation, highlights, and spotlights. It does not recreate body-image contents as editable native slide objects. Independent Quiz and interaction pages retain their existing structured content, editable question presentation, and question-reading flow.
3. **Import:** preserve the teacher's original pages and source mapping, then add or repair supported teaching layers and missing independent activity pages through the existing import/native tools. Do not silently replace the source deck or convert an original body page into an assessment.

The shared downstream workflow may add narration, audio, questions, and other supported teaching actions. It must not make the three authoring paths pretend to have identical editing or generation capabilities.

## Revision Baseline and Work Status

This revision incorporates the 2026-11-13 review of `feat/courseware-par-A`, reference HEAD `ee3202bd6`, and its uncommitted source changes. The original 2026-11-11 description is historical context, not an implementation baseline. Before code work, capture the then-current commit and fingerprints of affected dirty files; separate committed behavior, worktree changes, and accepted business requirements. An observed uncommitted implementation is not proof of deployment, approval, or release qualification.

| Area | Current source status | Remaining plan work |
|---|---|---|
| Narration batching, bounded page retries, lesson mapping, original TTS recovery, independent activities | Implemented in the committed baseline, with further worktree refinements. | Reuse and verify; fix only demonstrated gaps. Do not rebuild these workflows. |
| Import teaching entry | Implemented in the committed baseline. | Preserve explicit Start, saved teaching readback, attachments, and handoff to the existing Chat flow. |
| Playback preflight and completion reporting | Implemented in the committed baseline, with worktree fixes for pending media and object diagnostics. | Verify ordering and separate saved readiness, structural preflight, and actual playback evidence. |
| Platform synchronization and publication | Implemented locally in the committed baseline. | Preserve separate explicit actions and recovery contracts; deployment remains outside this plan. |
| Visual tolerance, object-binding advisories, story-style approval comparison, image archive limits, video gateway | Present in uncommitted follow-up changes; acceptance and integration must be recorded separately. | Include in baseline verification without silently reverting or expanding their business rules. |
| Stage-aware Visual Master input, neutral Host fallback, route-aware Math guidance | Still outstanding in the inspected source. | Retain P3–P5 as implementation work, scoped to body-image guidance and approved user intent. |

Overall TODO does not mean every mechanism below is missing. P0/P1/P6 must first identify reusable implementation and existing tests; only uncovered work becomes a new implementation task.

## Product Decisions

- PI Desktop is for education. Remove enterprise training as a default audience, route, or example from Desktop courseware prompts and Skills. Do not change other products or server-side enterprise behavior outside Desktop.
- A Skill owns teaching strategy, subject intent, and route-specific authoring guidance. Code owns routing, permissions, schemas, validation, provider calls, durable state, retry boundaries, persistence, and claims about what the app completed.
- Scene body pages are image-first. A diagram that is part of a body page remains inside the generated image, including labels and exact display text. Later layers are for presentation and teaching actions, not reverse-engineering the image into editable diagrams. Keep the existing independent Quiz/checkpoint page contracts and editable questions.
- Correctness remains a quality requirement. Generated pixels cannot guarantee exact math or text, so review the rendered image and offer bounded repair or human review when content is wrong. Do not claim the image model guarantees exact values or lettering.
- An explicitly selected `visualStyle` or style in the user's brief takes precedence over the default age-stage profile. Stage guidance tunes readability, abstraction, information density, and age suitability; it must not silently replace the chosen medium or art direction.
- Keep the approved lesson plan and first representative Visual Master as review checkpoints. Preserve course-wide style continuity afterward unless the user requests a restyle.
- Preserve route-specific page counting: Scene's `bodyPageLimit` counts body pages, including ordinary cover/summary pages; independent assessments are additional physical pages. PPT Master retains its existing total-page budget and fixed assessment preparation. Do not unify these counters or introduce assessment quotas.
- Preserve story-first as an optional existing flow. Story approval, Scene-plan approval, and first-master style confirmation are distinct gates. A page-count or `visualStyle` change alone does not invalidate story approval; changed teaching requirements such as grade or subject require story revision and human review. This exception does not authorize changing an approved Scene plan or prepared image intent.
- Generation, platform synchronization, and publication remain separate scopes. Generation completion must never automatically synchronize or publish. Retain explicit cloud-conflict and conversion-warning review at the exact revision/fingerprint governed by the existing delivery module.
- Stability work must preserve the existing business flow and validation semantics. Keep current required steps, ordering, approval gates, permission checks, schemas, thresholds, acceptance criteria, and failure behavior intact; do not skip, weaken, bypass, downgrade, or make a required check optional to reduce interruptions. Stability changes may improve diagnostics, error propagation, bounded recovery, and user-facing status. Any business-logic or validation change requires separate explicit authorization.
- This plan does not authorize live paid media generation, external synchronization/publication, or changes to another repository.

The preservation rule applies to the P0 baseline agreed for implementation, including its existing distinctions between blocking errors and advisories. Preserve business validation outcomes while fixing erroneous execution or reporting; do not freeze obsolete wording from this document as a business rule. The previously requested Education defaults and Scene body-image guidance remain the explicitly scoped prompt improvements. Any additional business-rule change requires separate authorization.

## Current Evidence

These observations describe the inspected source in this worktree. Re-check them against the implementation baseline because the worktree contains unrelated uncommitted changes.

| Finding | Evidence | Effect |
|---|---|---|
| Scene plan generation has education context, but the Visual Master planner input does not explicitly carry it. | `apps/desktop/electron/main/courseware-scene-plan.ts`; `courseware-visual-master.ts` | The image planner can lose grade, subject, and stage after plan creation. |
| Scene planning contains broad page-composition and extraction rules. | `courseware-scene-plan.ts` | Character extraction rules can be imposed on connected math diagrams. |
| The Host deterministic Visual Master prompt falls back to kindergarten picture-book art when a plan lacks a Visual Bible. | `crates/host-core/src/rpc/courseware_projects/scene_images/prompts.rs` | Preschool aesthetics can leak into older grades and legacy plans. |
| The Host task snapshot has `educationContext`; Scene approval stores it with the approved plan. | `crates/host-core/src/rpc/courseware_projects/scene_plan.rs` | Prefer authoritative task context over model-authored context. |
| Main and Host image prompts have a 4,000-unit transport limit. | `courseware-visual-master.ts`; `scene_images.rs` | Stage guidance must fit in both primary and fallback prompts. |
| The Math profile requires native/SVG/LaTeX content and forbids raster AI charts; it is also loaded by page narration. | `packages/agent-runtime/src/courseware/generation-profile-registry.ts`; `page-narration-candidate.ts` | Scope authoring instructions by route and phase; narration must describe actual saved Scene pixels, not demand native reconstruction. |
| The task form supports kindergarten, primary, junior high, and senior high, plus free-form grade. | `apps/desktop/src/components/CoursewareTaskDialog.tsx` | Existing inputs can drive stage defaults without a new settings screen. |
| Current separation prompts require all text/subjects to be separate; several-object scenes can require small independent full-body silhouettes. | `courseware-visual-master-prompts.ts`; `scene_images/prompts.rs` | This can damage number lines, charts, formulas, and labeled diagrams. |
| Users can choose styles such as vector, watercolor, and realistic, or enter a custom style. | `CoursewareTaskDialog.tsx` | Preserve the control and make defaults subordinate to explicit choices. |

## Reliability Lessons from PPT Master

PPT Master appears more dependable because its Skill is backed by a complete delivery package and deterministic gates. The Skill loader requires the entry file and referenced workflow/design files; if the official package is incomplete, Desktop does not expose that Skill. Its workflow names concrete artifacts, runs project-schema validation and final SVG quality validation, repeats the relevant check after repairs, and distinguishes a saved preview from an authorized PPTX export. The in-app preview is opened and checked before preview success is reported. Tests exercise package integrity, injected Host rules, stale validation reports, and export readiness.

This is evidence for a combined system, not proof that Skill prose alone prevents interruption. The official scripts, Host-injected policy, saved project files, validators, phase boundaries, and tests all contribute. The same principle should guide the three Desktop routes: Skills describe teaching and authoring intent; typed tool contracts, Host state, deterministic checks, and recovery code enforce execution and completion.

| Reliability mechanism | Present in PPT Master path | Application to courseware routes |
|---|---|---|
| Skill/package integrity | Required official references are loaded together; missing required files hide the Skill. | Check every route Skill and referenced resource as one versioned package; report unavailable with the missing resource instead of starting a partial workflow. |
| Explicit phase outputs | Planning files, page files, validation report, live preview, and final export have distinct meanings. | Name the durable output and success condition for each generation, image, layer, import, and teaching step. Do not treat tool-call prose or an intermediate deck as final completion. |
| Deterministic gates | Planning schema and final SVG quality checks must pass; edits invalidate stale quality evidence. | Run route-specific schema, asset-binding, and readiness gates at the owning boundary. A check must be tied to the exact input revision it validated. |
| Repair feedback | Validation identifies failed requirements; repair is followed by revalidation. | Return structured field paths, error codes, and actionable constraints. Retry only the failed step and recheck its gate. Never change the lesson request to make invalid input pass. |
| Completion boundary | Preview-ready and explicitly authorized PPTX export are separate milestones. | Report existing stage states and saved outputs accurately; distinguish saved readiness, structural preflight, actual playback, synchronization and publication. |
| Regression coverage | Tests verify Skill loading, Host policy injection, stale-report rejection, and export blocking. | Add failure-injection tests at tool, Runtime, Main, and Host boundaries, including restart/recovery and no duplicate paid submissions. |

The current flow already has useful protections: explicit transient read retries are bounded; unknown paid submissions query the original intent rather than creating a replacement; independent work can continue after a classified page-local failure; plan/teaching repair budgets and no-progress continuation are bounded. Native teaching uses the verified native document/teaching view and current saved-source acceptance; Host retains its existing persistence, archive, and receipt ownership. An older Host teaching mirror or closing prose must not override newer native edits. Preserve these protections and diagnose remaining failures before replacing recovery logic.

Narration generation accepts at most five pages per tool call. Calls are sequential: await save, reread the current source SHA, and submit only unfinished pages. Read-only context and original-order TTS recovery retain their broader scope. Current page-generation/delta attempts are bounded to three per unchanged page/content/model/repair mode within the active user turn; changed instruction wording, batch size, autosave-only SHA changes, or peer saves cannot renew that budget. Preserve each stage's own repair limits rather than adding one generic retry count. Ownership changes, cancellation, transport errors, and uncertain saves retain their existing stop semantics.

Reuse `courseware_narration_plan` for source-grounded lesson mapping, `courseware_activity_insert` for missing accepted independent activities, and `courseware_media_refresh(kind:tts,recover:true)` for original audio recovery. Preserve final scripts verbatim, successful audio and stable page/action IDs. Activity insertion position is not its factual source: evidence comes from the accepted unit's mapped original pages, saved narration, and exact source quotes. A validation error cannot justify changing the requested activity kind or inventing an answer.

The first stability task is to classify real failures by route, phase, operation, and stable error code: Skill unavailable or incomplete; tool not found; malformed arguments or schema mismatch; Host rejection; provider/configuration failure; timeout/cancellation; submission outcome unknown; output validation failure; persistence/adoption failure; and completion/reporting mismatch. Attach a task/step identifier and the input/schema revision where available. Logs must omit credentials, full prompts, and private source content. User-facing errors should say which step stopped, what was saved, whether the same operation can resume safely, and what action is needed. A generic “interrupted” message is not sufficient diagnosis.

Do not respond to parameter errors with broad prompt additions or unbounded retries. Tool boundaries should return a machine-readable code and field-level correction details. Runtime may make a bounded correction only within the existing stage budget while preserving user content and operation identity; exhausted or terminal failures stop at that gate. Unknown paid outcomes remain query-only against the original request identity; they never authorize another submission.

## Visual Validation and Completion Boundaries

These are current business distinctions to retain, not proposed validation relaxations:

- `visual_variation` records harmless appearance differences when the actual picture still teaches the same objective. A diamond kite may support a flying-a-kite lesson despite a swallow-shaped illustration plan. Shape, color, count, position, or exact text remain strict when taught, tested, or explicitly required by the user. Narration must describe observed pixels and never invent aliases to conceal a mismatch.
- Classroom props used by the teacher are not automatically required software controls on a slide. A genuinely missing essential picture or contradictory teaching content still blocks the affected page. A planned effect not yet generated is not evidence that its static picture is missing.
- An unresolved planned object description is an `OBJECT_BINDING_ADVISORY`; it does not prove absent content or trigger replacement image generation. Actual missing/ineligible effect targets and invalid animation bindings remain blocking. New `requiredObjects` use atomic target names; legacy compound/count descriptions are diagnosed through the existing resolver, never pasted onto one object as a fabricated collective alias.
- Explicit objects-only repair uses `repairObjectsOnly:true` with `repairRequiredTeaching:true`, at most five pages, and preserves saved speech, actions, durations and adopted audio. Keep its existing target eligibility rules and bounded repair. Do not turn advisory descriptions into mandatory repair loops.
- Saved content/media readiness, structural playback preflight, and actual playback acceptance are separate facts. Run the existing whole-deck preflight only after teaching/media prerequisites are ready and no original job remains; unsubmitted video/music slots or unresolved attention also defer it. Model catalogs and status reads must remain available while those prerequisites are missing. Cache only for the exact verified saved source.
- A `completion.ready` or `playbackPreflight.ready` result does not prove every page was visited or every audio clip ended naturally. Report those claims only with actual player evidence. Likewise, local readiness does not imply platform synchronization or publication.

## Media and Delivery Contracts to Preserve

| Boundary | Current contract |
|---|---|
| Scene image archive | Up to 32 MiB per image, at most 4096×4096 pixels; verify download, Main, Host and compiler compatibility. Preserve supplier PNG bytes. |
| Scene reference input | Separate provider input limit of 8 MiB; a valid larger archived master is not automatically a valid reference upload. |
| Layer delivery / Host frame | Group limits of 44 MiB raw and 60 MiB JSON retain the 64 MiB Host frame. URL bundles stage one image per frame; do not increase the frame limit. |
| Video | Use the user-authenticated llm-ha gateway with the original quote/key/hash, then fetch ready CDN output without cookies or authorization and with redirects refused. Keep the 40 MiB archive bound. Refresh the original task for delivery recovery; do not resubmit generation. |
| Video options | Do not require five-second clips in lesson planning. Preserve optional explicit durations and caller/provider options under current validation and hashing. The current quote/confirmation flow still uses a five-second fallback when no duration is supplied; this is not permission to change billing defaults or old intent identity. |
| Platform delivery | Reuse the existing synchronization/publication journal, original operation IDs, cloud expected revisions, source fingerprints, and warning approvals. Recover pending operations as their originals. Preserve released revisions while synchronizing drafts; never overwrite a changed cloud draft implicitly. |

See the [video gateway ADR](../docs/adr/courseware-video-user-gateway.md) and [platform delivery ADR](../docs/adr/courseware-platform-delivery.md). These contracts have different owners and acceptance status; this plan does not introduce a new gateway, billing service, publication workflow, or external deployment.

## Target Ownership

| Concern | Skill / profile guidance | Application code |
|---|---|---|
| Audience-appropriate explanation, examples, lesson progression | Shared Education teaching guidance, specialized by subject and stage | Persist selected settings and pass them to the active route |
| Plain/PPT Master authoring | Selected authoring Skill defines output and editability | Load Skill; validate tools and output contract |
| Scene body-image composition and educational style | Scene guidance plus stage and subject profile | Build prompts, submit image jobs, preserve approvals, extract supported layers, compile; keep independent assessment contracts |
| Import behavior | Import Skill defines enrichment and source-preservation policy | Verify source binding, preserve original content, save and validate additions |
| Exact math/text in Scene pixels | Subject profile tells the model what to render; review guides quality | Do not rebuild native objects; verify with available review/repair and report uncertainty |
| Retry and completion | Skill follows existing budgets and reports evidence | Use current route-specific saved/native state, Host receipts and readiness checks; distinguish preflight from actual playback |

## Stage Profiles for Scene Visual Masters

Resolve a default from `schoolStage`, then refine Primary from a recognizable `grade`. Use grades 1-2 as lower, 3-4 as middle, and 5-6 as upper primary only where the configured curriculum uses that convention. Unknown grades use the general profile for the selected stage. Do not create one profile per grade without evidence of a real visual difference. Subject Skills specify content; stage guidance adjusts density, abstraction, and readability.

| Stage | Default Visual Master direction |
|---|---|
| Kindergarten | Concrete, warm, expressive, story-like scenes may remain the default. Use large focal objects, very short text, clear actions, and simple relationships. Picture-book, watercolor, or 3D is not mandatory; follow the teacher's style. |
| Primary, lower grades | Concrete everyday situations, few visual steps, large labels, short text, obvious target objects. Keep decoration subordinate. |
| Primary, middle grades | Clear regions and title hierarchy; combine concrete situations with organized textbook diagrams. Allow readable number lines, ticks, coordinates, tables, simple charts, fraction models, geometry guides, and labels as part of the image. |
| Primary, upper grades | Concise, denser diagrams, comparisons, formulas, experiment steps, and timelines. Reduce preschool-like characters and decorative settings. Keep symbols and units readable when projected. |
| Junior high | Structured, restrained classroom/textbook or infographic treatment. Allow abstraction. Emphasize definitions, variables, conditions, reasoning, evidence, and cause/effect. Use characters only when they teach the concept. |
| Senior high | Mature, subject-led visualizations with disciplined hierarchy and high but readable information density. Favor data, models, formula relationships, experiment evidence, and reasoning. Do not default to cute mascots, children's-book art, or irrelevant classroom scenery. |
| Unknown/general school stage | Clear, neutral educational illustration or infographic. Do not default to enterprise training or kindergarten picture-book styling. |

Precedence:

1. Explicit user brief and selected visual style.
2. Approved course Visual Bible and accepted representative image.
3. Subject-specific teaching and image requirements.
4. Stage and grade readability profile.
5. Neutral education default.

If a later request conflicts with the approved Visual Bible, use the existing plan/image review and re-approval flow before changing course-wide style. Normal new pages must not drift from the accepted reference.

## Scene Image and Layer Contract

### Image generation

For body pages, ask the model for one complete teaching image, including all authoritative display text and visual content. This includes (when required) axes, ticks, point positions, data plots, legends, formulas, units, labels, body text, and illustrations. Do not add a native-object authoring pass for these image contents. Independent Quiz and checkpoint pages keep the existing structured templates, editable question content and separate question reading; do not rasterize or redraw them through this body-image workflow.

Subject guidance still specifies source-grounded values, labels, units, formulae, and relationships. Ask the model to preserve them exactly, then review the rendered artifact. If current tooling cannot reliably inspect or repair a mismatch, surface that limit and retain the user review checkpoint instead of silently changing the diagram's meaning.

### Post-processing

- Keep the full Visual Master as the visual source of truth.
- Extract image layers only for objects that benefit from independent appearance, movement, highlight, or spotlight.
- Let intrinsic diagram parts remain connected: axes with ticks, plotted marks, labels, formula symbols, flow arrows, and callouts can be one coherent image region. Do not force gutters between semantically connected parts.
- Do not split a complete chart or number line merely to make every mark independently movable. A whole diagram may be highlighted or spotlighted as one image object.
- Preserve stable layer-to-teaching-action mapping. Narration and timing remain separate from pixels.
- One coherent diagram region may have one atomic teaching target; atomic `requiredObjects` does not require extracting each tick, symbol or label. Preserve the compiler's existing clean-plate/foreground requirements and effect-target checks.
- Do not claim raster text, labels, or charts are editable native PowerPoint objects. Scene editing is limited to supported image-layer operations and separate teaching/action data.

## Implementation Phases

### P0 — Pin routes and context contracts

1. Refresh the 2026-11-13 review baseline at implementation time: record HEAD and affected dirty-file fingerprints, distinguish committed and worktree changes, and confirm the accepted business requirements without reverting unrelated work. Re-read nearest `AGENTS.md` files and route tests.
2. Trace task creation through saved `educationContext`, plan generation and approval, Visual Master planning, Host image intent, layer extraction, deck compilation, and readiness. Record where stage, grade, subject, and `visualStyle` are available at every boundary.
3. Record story-first, Scene-plan, representative-image and reference-continuity gates separately. Preserve the story requirement comparison's page-count/style exclusions; determine how restyle requests affect later approvals and already prepared immutable image intents.
4. Inventory prompts and Skills reachable from the three paths. Classify each rule as shared Education guidance, route-specific authoring, Host invariant, or legacy/conflicting guidance.
5. Record the existing business-flow sequence and all required validation/approval gates for each route, including their owning layer, inputs, thresholds, and failure outcomes. Use these as behavior-preservation baselines for any stability work.
6. Record prompt limits, route-specific body/total-page budgets, image/reference/frame/video bounds, serialized formats, request idempotency keys, approval hashes and per-stage retry behavior. Map native saved-state readiness, playback preflight, actual player acceptance and explicit platform delivery separately. Do not change these contracts in this phase.
7. Mark existing batching, lesson mapping, activity insertion, TTS recovery, import entry, preflight and delivery tasks as reuse/verification. Keep outstanding stage-aware image work separate; overall TODO is not an instruction to reimplement existing modules.

**Gate:** a route diagram and context table identify the authoritative source for each prompt field and every primary/fallback builder. No prompt infers stage from plan prose.

### P1 — Verify existing recovery and close diagnostic gaps

1. Gather representative interruption records from all three paths and map each to the failure classes above. Separate model/tool-call errors from provider, Host, persistence, cancellation, and user-decision stops.
2. Trace where each error is created, translated, persisted, and rendered. Identify cases where a specific code becomes a generic interrupted state or disappears after Runtime replacement/restart.
3. Add or reuse diagnostic metadata for operation/step ID, stable reason code, safe field diagnostics, and the revision or request identity it applies to. This is observability around existing results, not a replacement for business states, schemas, or route contracts; do not introduce a parallel workflow engine.
4. Make schema/parameter failures actionable at the tool boundary. Keep validation close to the schema owner, include invalid field paths and allowed bounds/enums, and ensure fixes cannot silently change route, page count, assessment type, teaching content, or paid request identity.
5. Verify five-page sequential narration calls, acknowledged saves and fresh source SHA between batches. Preserve per-page/content retry budgets across instruction changes, regrouping, autosave-only changes and peer saves. Reuse existing lesson mapping, physical activity insertion and original-order audio recovery. Preserve partial successes, terminal page classifications, fatal owner/cancellation/transport/uncertain-save stops, and unknown paid query-only behavior. Recovery must pass existing required validation; do not add a new state store or workflow engine.
6. Add user-facing stop summaries from authoritative state: stopped phase, reason, saved outputs, safe resume behavior, and any required user action. Distinguish a decision gate, cancellation, blocked failure, uncertain provider outcome, and actual completion.
7. Run existing failure-injection tests first and add only uncovered cases for incomplete Skills, malformed arguments, validation rejection, transient reads, editor opening/saving, unknown paid outcomes, cancellation, invalid output, save/adoption failure, Runtime recreation and successful siblings. Include duplicate calls after exhausted page budgets and loss of an acknowledged save reply. Verify the native route against its current saved document/teaching view, not a legacy Host teaching mirror.

**Gate:** the team can trace a sampled user-visible interruption to a stable failure class and owning boundary; each tested failure has a bounded, truthful outcome and preserves prior successful work. Existing route sequences, schemas, required checks, thresholds, approvals, and acceptance outcomes match the P0 baseline. No broad retry is added to make the test pass.

### P2 — Set the route-aware Education Skill boundary

1. Define compact, progressive-disclosure shared Education guidance for audience, language, source fidelity, lesson progression, and visible text versus teacher narration.
2. Keep route Skills distinct: ordinary/PPT Master authoring, Scene raster-first authoring, and Import enrichment each state their own output contract and limits.
3. Ensure Scene Skill specifies whole-body-page raster composition and subsequent image-layer teaching operations. Remove native reconstruction requirements only for body-image contents; retain independently editable Quiz/checkpoint questions, their page types, source evidence and question speech. Preserve the current import Start handoff and explicit scope.
4. Keep existing Skill loading, schema validation, and permission checks. A Skill can guide a request but cannot grant tools or permissions.
5. Remove generic enterprise-training defaults/examples from Desktop prompts and built-in Education Skills. Preserve user-supplied literal content and out-of-scope products.
6. Remove contradictory copied rules. Load shared guidance once; route Skills add only their differences.

**Gate:** each route loads the intended Skill and makes no claim about another route's capabilities; user Skills retain current permission/tool validation.

### P3 — Resolve stage and subject visual guidance

1. Reuse current stage/subject normalization and profile functions where they fit. Add only the small body-image/Primary-grade refinement needed at the verified prompt boundary; do not create a second profile registry.
2. Encode the stage defaults and precedence above.
3. Scope subject guidance by route and phase. Scene body-image planning requests source-grounded raster Math and review; later narration explains the actual saved diagram without demanding reconstruction. Editable authoring retains its native/SVG requirements. Inspect `page-narration-candidate.ts` as well as image-planning callers so authoring rules do not leak into narration.
4. Review similar raster/native conflicts for other subjects without weakening source fidelity or factual review.
5. Missing stage resolves to general Education, never enterprise or kindergarten.

**Gate:** table-driven tests cover every current stage, absent/unknown stage, Primary grade bands, explicit style override, and subject override. Tests prove Scene and editable authoring receive different Math production instructions.

### P4 — Apply context to Scene planning and Main image prompts

1. Carry verified task Education context into Visual Master planning. Host task/approval context is authoritative; model-authored plan fields are not authority for stage, subject, or style.
2. Pass resolved stage profile, subject guidance, explicit style, approved Visual Bible, page intent, and exact visible text into Main planning.
3. Save age-appropriate art direction in the course Visual Bible and page intent; do not ask the image planner to infer age from the lesson title.
4. Replace global “all text and subjects must be separate” with a narrower extraction rule: separate objects intended for independent motion/focus; connected diagram parts may remain together.
5. Remove the fixed small-full-body constraint for groups of three or more unless the page needs independent full-body characters. Preserve required object counts.
6. Keep exact text, cancellation, and validation behavior. If stage guidance approaches the prompt budget, shorten generic scaffolding first, never approved content.
7. Preserve current atomic object planning and visual tolerance. A complete chart region may be one target; do not add a target for every internal mark or label. Appearance variations remain advisory unless they violate the objective, an explicit user constraint or required factual content. Genuine missing content and invalid effects retain their blocking checks.

**Gate:** Main tests assert stage, grade band, subject, explicit style, approved Bible, exact text, and connected-diagram policy. Output stays within 4,000 UTF-16 units and current validation.

### P5 — Make Host fallback Education-aware and continuity-safe

1. Trace how Host resolves the approved Scene plan and authoritative task snapshot when creating image intents. Use saved Education context when stage-specific guidance is needed.
2. Remove the kindergarten picture-book fallback. With a Visual Bible, follow its approved art direction and page intent. For a legacy plan without one, use neutral, readable Education styling.
3. Preserve user style, exact visible text, required objects, accepted image reference, and 4,000 UTF-16 limit in full and compact prompts.
4. Apply layer separation only to independently animated/highlighted elements; keep connected chart internals intact.
5. Avoid persisting duplicate stage/profile fields if the approved task snapshot already supplies them. If context is unavailable at the prompt boundary, add the smallest compatible argument/field and specify old-plan behavior.
6. Never rewrite an approved plan or mutate a prepared immutable image intent on retry. Explicit restyle follows the current later-stage review/re-approval and successor rules; retaining story approval for a style-only change does not waive those gates.

**Gate:** Host tests cover current/legacy plans, stage fallbacks, explicit style, exact text, reference use, full/compact output, and limits. Unchanged retries retain prompt and idempotency identity.

### P6 — Verify shared native teaching without changing route behavior

1. **Plain/PPT Master:** select the authoring Skill and contract; report accurately which output is editable. Do not import Scene-only layer rules.
2. **Scene:** retain optional story-first, approved Scene plan, representative body master and style selection, then process supported layers and teaching overlays. Independent assessments retain their templates and editable questions; never reconstruct body-image text/diagrams as native objects.
3. **Import:** retain explicit Start, original slides, source mapping, accepted scripts and media. Reuse accepted lesson mapping and add only missing independent activities through the existing insertion/Undo/save route. Verify factual evidence against mapped source pages, not the preceding insertion anchor.
4. Reuse the current shared narration/audio/assessment/effect tools. Preserve five-page generation calls, original TTS recovery, optional assessment artwork policy, and objects-only repair. Never silently rewrite a final script, duplicate an activity, or re-purchase an uncertain original.
5. Verify saved acceptance using the active route's current authoritative document/project state and Host receipts. Keep whole-deck structural preflight after all media/attention prerequisites; incomplete slots must not block catalog/status reads. Separate its result from actual player evidence and from native PowerPoint animation capability.
6. Reuse the existing explicit platform sync/publish actions and journal. Generation must not invoke them. Preserve cloud-revision conflicts, warning approval, source fingerprints and pending-operation recovery; do not redesign or deploy platform delivery here.
7. Treat natural-language operation-button routing as a separate follow-up unless tests show an actual misroute. Do not introduce a generic command framework without evidence.

**Gate:** each route has a separate user-path test; shared teaching preserves source content, activity identity and accepted audio. Saved readiness and preflight use current state without claiming actual playback. No generation path dispatches platform synchronization/publication.

### P7 — Cross-route acceptance

1. Add a fixture per route using the same stage/subject settings and assert its route-specific output contract.
2. Add Scene prompt fixtures for kindergarten, Primary lower/middle/upper, junior high, senior high, and unknown/general stage. Cover Math and one text-heavy subject.
3. Where rendered fixtures exist, verify chart labels, axis direction, tick sequence, point placement, units, and formulas. Structural tests prove only prompt propagation, not visual accuracy.
4. Verify first-image approval, course-reference continuity, restyle approval, retry identity, legacy-plan loading, and prepared-intent immutability.
5. Verify body versus assessment page counting, story approval exclusions, final-script preservation, independent activity evidence, original TTS recovery, terminal page budgets, appearance advisories versus missing-content/effect blockers, and preflight deferral for unsubmitted media. Include a provider-free large-deck batching case; small three-page fixtures do not qualify large-deck interruption recovery.
6. Verify image archive/reference/frame boundaries across Main/Host/compiler and video request-hash/duration/quote compatibility, original-task refresh and credential-free download. Run existing delivery conflict/recovery tests to guard the boundary without sending external sync/publish requests.
7. Run targeted Desktop/Runtime tests, typechecks, Host Rust tests, and cross-layer courseware checks required by delivery policy for code changes. Native behavior changes require matching editor/worker/player builds; source-only or Desktop-only checks do not certify the running installation.
8. Record fresh-generation, resumed-repair, structural-preflight and actual-playback evidence separately. Actual playback requires all pages reached and audio naturally ended. Report paid/provider-dependent generation and platform deployment separately; never infer them from local tests or historical small-course repairs.

**Gate:** required local tests pass without skips; none of the three Desktop paths defaults to enterprise; no Scene primary/fallback prompt defaults to kindergarten; Scene visual content remains raster-first; old project and intent recovery remain valid. Stability changes preserve the P0 business-flow and validation baselines, verified by route-level regression tests; no required check is skipped, weakened, or moved behind a different approval gate.

## Regression Matrix

| Reliability case | Expected result |
|---|---|
| Required PPT Master Skill resource is missing | The incomplete Skill is not offered; diagnostics identify the missing package resource. |
| A tool call omits a required field or uses an invalid enum/bound | The owning boundary returns a stable error and field-level correction; route and requested teaching content remain unchanged. |
| A stage reaches its existing terminal classification or repair budget | Stop at that gate with a clear incomplete result; do not renew the budget by changing instructions or downgrade the requested operation. |
| A provider read fails transiently | Retry only the eligible read within its fixed budget; preserve the original operation identity. |
| A paid submission outcome is unknown | Query the original intent; never create a replacement submission automatically. |
| One page/job fails while independent authorized work remains | Preserve successful work and continue eligible siblings; report the failed item separately. |
| Runtime is recreated during a saved workflow | Reconcile current native/project state and Host receipts under existing checkpoint semantics; do not duplicate saved work or reset budgets without authorization. |
| A preview/artifact exists but its latest required validation is absent or stale | Keep the task incomplete until the artifact is revalidated; never use a report for an older revision. |
| Stability handling encounters an existing business or validation gate | Preserve the same required operation, gate, threshold, and pass/fail meaning; diagnostics or recovery cannot bypass it. |
| Cancellation, approval wait, unknown provider outcome, or hard failure stops work | Report the actual state and saved outputs, and state whether a safe resume or user action is required. |
| User-facing interruption is sampled for diagnosis | It can be mapped to a route, phase, operation, stable reason code, and owning boundary without exposing secrets or source content. |
| Kindergarten, no selected style | Warm, concrete, low-text style is allowed; watercolor/3D is not mandatory. |
| Senior high, no style | Mature subject-led hierarchy; no preschool characters or picture-book setting by default. |
| Primary grade 2 / 4 / 6 | Lower/middle/upper profile respectively where that grade convention applies; unknown grade stays general-primary. |
| Senior-high Math Scene | Formula, chart, axes, ticks, labels, and values are requested as raster content; no native/SVG reconstruction instruction. |
| Same Math in editable new-deck route | Selected authoring Skill's native-editability requirements remain available. |
| Watercolor selected for senior high | Watercolor is retained; hierarchy and abstraction still suit senior high. |
| Flat vector selected for kindergarten | Vector is retained; stage adjusts scale, text amount, and concreteness only. |
| Connected number line/chart | Diagram remains coherent; independently animated people/objects may be separate layers. |
| Main planner failure, Host fallback | Approved Visual Bible wins; legacy missing Bible uses neutral Education style. |
| First representative image approved | Later pages preserve style/identity without copying page-specific text/layout. |
| Prepared image retry | Original prompt, request identity, and approved source remain unchanged. |
| Import | Original content and source bindings remain authoritative; no Scene rewrite is implied. |
| Scene requests 8 body pages and 2 independent assessments | Preserve 8 body pages and 10 physical pages; retain the distinct PPT Master total-page budget contract. |
| Scene Quiz/checkpoint | Keep independent structured pages and editable question content; the body-image policy does not rasterize their questions. |
| Page-count/style-only story setting change | Preserve story approval; later plan/master approvals and immutable intents still follow their own rules. Grade/subject changes require story revision and review. |
| Six-page narration generation call / full-deck context read | Reject oversized generation before dispatch; keep the existing broader read/recovery scope. |
| Retry an exhausted page with different wording, grouping or an autosave-only SHA | Make no new paid generation call for unchanged content in the same user turn. |
| Recover existing speech after interruption | Adopt only original matching results, preserve valid audio and successful peers, and expose ambiguous/unknown originals without replacement purchases. |
| Insert an activity after a Quiz | Use the accepted unit's mapped original pages/narration as evidence, retain question kind and reuse any acknowledged activity ID. |
| Harmless appearance variation / missing essential content | Keep the first advisory; block the affected page for the second. Explicitly taught/tested/user-required shape, color, count and position stay strict. |
| Planned alias unresolved / actual effect UUID invalid | Report `OBJECT_BINDING_ADVISORY` for the first; retain the existing blocking target check for the second. Never fabricate aliases. |
| Objects-only repair with adopted audio | Preserve actions, speech, durations and audio exactly; verify only the eligible selected objects within the existing page/repair bounds. |
| All TTS ready but a music/video slot or attention remains | Defer whole-deck preflight; keep model catalogs and status reads available to finish authorized prerequisites. |
| Saved readiness and structural preflight pass | Report those checks only; actual playback completion requires separate page/audio evidence. |
| Scene PNG is larger than 8 MiB but within 32 MiB | Preserve validated archive bytes; continue to enforce the separate 8 MiB reference-input limit and layer/frame bounds. |
| Video result delivery fails | Refresh/download the original gateway task within current bounds; preserve quote/key/hash and duration compatibility without resubmitting generation. |
| Generation completes / cloud draft changes / delivery reply is lost | Do not auto-sync/publish; preserve existing explicit conflict review and same-operation receipt recovery. |

## Candidate Files to Re-check

This is a starting map, not an instruction to edit every file. Re-check callers, tests, local guidance, and ownership first.

- `apps/desktop/electron/main/courseware-scene-plan.ts`
- `apps/desktop/electron/main/courseware-visual-master.ts`
- `apps/desktop/electron/main/courseware-visual-master-prompts.ts`
- `apps/desktop/electron/main/courseware-scene-images.ts`
- `apps/desktop/electron/main/courseware-scene-deck.ts`
- `apps/desktop/electron/main/courseware-chat-workflow.ts`
- `apps/desktop/electron/main/ipc/agent-ipc.ts`
- `apps/desktop/electron/main/builtin-skills.ts`
- `apps/desktop/electron/main/courseware-native-tools.ts`
- `apps/desktop/electron/main/courseware-native-narration.ts`
- `apps/desktop/electron/main/courseware-narration-batch.ts`
- `apps/desktop/electron/main/courseware-native-audio-recovery.ts`
- `apps/desktop/electron/main/courseware-native-activities.ts`
- `apps/desktop/electron/main/courseware-native-preflight.ts`
- `apps/desktop/electron/main/courseware-scene-image-assets.ts`
- `apps/desktop/electron/main/courseware-video-media.ts`
- `apps/desktop/electron/main/courseware-saved-video.ts`
- `apps/desktop/electron/main/courseware-delivery.ts` and `courseware-delivery-export.ts`
- `apps/desktop/src/components/courseware/CoursewareImportStart.tsx`
- `apps/desktop/test/ppt-master-skill.test.mjs`
- `apps/desktop/test/ppt-master-quality.test.mjs`
- `apps/desktop/test/ppt-master-flow.test.mjs`
- `apps/desktop/resources/skills/scene-courseware/SKILL.md`
- Built-in and route Skills for plain generation, PPT Master, and import
- `packages/agent-runtime/src/courseware-workflow-recovery.ts`
- `packages/agent-runtime/src/courseware-turn-continuation.ts`
- `packages/agent-runtime/src/courseware-workflow-recovery.test.ts`
- `packages/agent-runtime/src/courseware-turn-continuation.test.ts`
- `packages/agent-runtime/src/courseware-stalled-continuation.test.ts`
- `packages/agent-runtime/src/courseware/generation-profile-registry.ts`
- `packages/agent-runtime/src/courseware/page-narration-candidate.ts`
- `packages/shared/src/courseware-story.ts` and `courseware-required-objects.ts`
- `crates/host-core/src/rpc/courseware_projects/story.rs`
- `crates/host-core/src/rpc/courseware_projects/scene_plan.rs`
- `crates/host-core/src/rpc/courseware_projects/scene_images.rs`
- `crates/host-core/src/rpc/courseware_projects/scene_images/prompts.rs`
- Related tests under `apps/desktop/test`, `packages/agent-runtime/src`, and `crates/host-core`
- [Native batching and retry evidence](../docs/design/2026-11-11-native-narration-small-batches.md), [lesson mapping and audio recovery](../docs/design/2026-11-11-part-a-lesson-planning-audio-recovery.md), and [independent activity rules](../docs/design/2026-11-11-native-independent-activities.md)
- [Import teaching entry](../docs/design/2026-11-12-import-teaching-entry.md), [playback preflight](../docs/design/2026-11-12-playback-animation-preflight.md), and [three-path repair evidence and limits](../docs/design/2026-11-12-part-a-three-path-real-fixes.md)
- `docs/spec/03-runtime/29-courseware-chat-workflow.md` and `docs/spec/03-runtime/27-courseware-authorized-media.md` for current business and media gates
- `docs/spec/04-ux/09-interaction-patterns.md` and `docs/spec/06-delivery/04-e2e-test-plan.md` for behavior changes

## Non-Goals and Deferred Work

- Rebuilding Scene pixels as editable native text, formulae, chart objects, or shapes.
- Claiming exact image-model text/math rendering without output review.
- Replacing Skills/plugin permissions or adding a generic workflow engine.
- Making import, plain generation, PPT Master, and Scene identical internally or in editability.
- Adding grade fields before evidence shows the existing free-form grade is insufficient.
- Reworking the PPT Master downloader. Improve its `fetch failed` diagnostics separately after route and Skill contracts are settled.
- Reimplementing the existing import Start, lesson mapping, activity insertion, narration batching, TTS recovery, preflight, or platform delivery modules.
- Treating all appearance differences or unresolved descriptions as blockers, or suppressing actual missing-content/effect errors to increase completion rates.
- Changing billing-duration fallbacks, media/frame limits, business page budgets, or existing validation thresholds as part of prompt/stability work.
- Live generation, publishing, committing, or integrating code.

## Implementation Order and Delivery Notes

Execute P0 through P7 in order: refresh the current business/validation baseline, verify existing recovery and address demonstrated gaps, then implement remaining stage/subject image guidance and route regressions. Existing mechanisms are verification/reuse tasks, not a new implementation backlog. Characterize Main/Host/native boundaries before prompt changes and edit shared files sequentially. Before code work, follow current branch/worktree policy and preserve dirty files.

This revision changes the plan and index only. The preceding read-only review ran 11 selected Desktop suites, four Runtime suites (75 tests), and two Shared suites (9 tests) successfully; that result applies to the reviewed local state, not later concurrent edits or a release build. Documentation validation checks references, phase consistency and whitespace. No fresh provider generation, actual player run, platform sync/publication or installer acceptance is claimed by this revision. Prompt snapshots/typechecks do not prove image accuracy, and structural preflight does not prove natural audio completion.
