# Plan 009: Education Courseware Routes and Stage-Aware Scene Visual Masters

**Status:** TODO; planning document only. **Date:** 2026-11-11.
**Scope:** PI Desktop courseware generation, Skills, Scene image prompts, and shared teaching workflow

## Outcome

Make the Desktop's three courseware entry paths consistently education-first, Skill-directed, and honest about their different production capabilities:

1. **New deck (ordinary generation / PPT Master authoring):** create a complete course presentation using the selected authoring Skill and capabilities available to that route.
2. **Scene:** generate each complete teaching page as one raster Visual Master. The image model renders page text, formulas, charts, number lines, tick marks, labels, diagrams, and illustrations together. The app then separates suitable visual regions and adds narration, animation, highlights, spotlights, and interaction overlays. It does not recreate image contents as editable native slide objects.
3. **Import:** preserve the teacher's existing presentation as the source of truth, then add or repair supported teaching layers without silently replacing the source deck.

The shared downstream workflow may add narration, audio, questions, and other supported teaching actions. It must not make the three authoring paths pretend to have identical editing or generation capabilities.

## Product Decisions

- PI Desktop is for education. Remove enterprise training as a default audience, route, or example from Desktop courseware prompts and Skills. Do not change other products or server-side enterprise behavior outside Desktop.
- A Skill owns teaching strategy, subject intent, and route-specific authoring guidance. Code owns routing, permissions, schemas, validation, provider calls, durable state, retry boundaries, persistence, and claims about what the app completed.
- Scene is image-first. A diagram that is part of a page remains inside the generated image, including labels and exact display text. Later layers are for presentation and teaching actions, not reverse-engineering the image into editable diagrams.
- Correctness remains a quality requirement. Generated pixels cannot guarantee exact math or text, so review the rendered image and offer bounded repair or human review when content is wrong. Do not claim the image model guarantees exact values or lettering.
- An explicitly selected `visualStyle` or style in the user's brief takes precedence over the default age-stage profile. Stage guidance tunes readability, abstraction, information density, and age suitability; it must not silently replace the chosen medium or art direction.
- Keep the approved lesson plan and first representative Visual Master as review checkpoints. Preserve course-wide style continuity afterward unless the user requests a restyle.
- Stability work must preserve the existing business flow and validation semantics. Keep current required steps, ordering, approval gates, permission checks, schemas, thresholds, acceptance criteria, and failure behavior intact; do not skip, weaken, bypass, downgrade, or make a required check optional to reduce interruptions. Stability changes may improve diagnostics, error propagation, bounded recovery, and user-facing status. Any business-logic or validation change requires separate explicit authorization.
- This plan does not authorize live paid image or audio generation, publication, or changes to another repository.

## Current Evidence

These observations describe the inspected source in this worktree. Re-check them against the implementation baseline because the worktree contains unrelated uncommitted changes.

| Finding | Evidence | Effect |
|---|---|---|
| Scene plan generation has education context, but the Visual Master planner input does not explicitly carry it. | `apps/desktop/electron/main/courseware-scene-plan.ts`; `courseware-visual-master.ts` | The image planner can lose grade, subject, and stage after plan creation. |
| Scene planning contains broad page-composition and extraction rules. | `courseware-scene-plan.ts` | Character extraction rules can be imposed on connected math diagrams. |
| The Host deterministic Visual Master prompt falls back to kindergarten picture-book art when a plan lacks a Visual Bible. | `crates/host-core/src/rpc/courseware_projects/scene_images/prompts.rs` | Preschool aesthetics can leak into older grades and legacy plans. |
| The Host task snapshot has `educationContext`; Scene approval stores it with the approved plan. | `crates/host-core/src/rpc/courseware_projects/scene_plan.rs` | Prefer authoritative task context over model-authored context. |
| Main and Host image prompts have a 4,000-unit transport limit. | `courseware-visual-master.ts`; `scene_images.rs` | Stage guidance must fit in both primary and fallback prompts. |
| The Math generation profile requires native/SVG/LaTeX content and forbids raster AI charts. | `packages/agent-runtime/src/courseware/generation-profile-registry.ts` | This conflicts with Scene's agreed whole-page image contract; scope it by route. |
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
| Completion boundary | Preview-ready and explicitly authorized PPTX export are separate milestones. | Model task state explicitly as ready, waiting for a decision, running, failed, or uncertain. Show what was saved and what remains before calling a workflow complete. |
| Regression coverage | Tests verify Skill loading, Host policy injection, stale-report rejection, and export blocking. | Add failure-injection tests at tool, Runtime, Main, and Host boundaries, including restart/recovery and no duplicate paid submissions. |

The Runtime already has useful protections: explicit transient read retries are bounded; unknown paid submissions query the original intent rather than creating a replacement; independent work can continue after one job fails; plan/teaching repair budgets and no-progress continuation are bounded; saved Host state, not closing prose, determines completion. Preserve these protections. Reports of frequent interruptions mean the current gap may be in failure classification, tool/schema feedback, persistence across particular interruption types, or user-visible reporting; collect evidence before replacing recovery logic.

The first stability task is to classify real failures by route, phase, operation, and stable error code: Skill unavailable or incomplete; tool not found; malformed arguments or schema mismatch; Host rejection; provider/configuration failure; timeout/cancellation; submission outcome unknown; output validation failure; persistence/adoption failure; and completion/reporting mismatch. Attach a task/step identifier and the input/schema revision where available. Logs must omit credentials, full prompts, and private source content. User-facing errors should say which step stopped, what was saved, whether the same operation can resume safely, and what action is needed. A generic “interrupted” message is not sufficient diagnosis.

Do not respond to parameter errors with broad prompt additions or unbounded retries. Tool boundaries should return a machine-readable code and field-level correction details. Runtime may make a small bounded correction only when it can preserve the user's requested content and operation identity. If the same validation failure repeats, stop at that gate and report it. Unknown paid outcomes remain query-only against the original request identity; they must never be treated as permission to submit again.

## Target Ownership

| Concern | Skill / profile guidance | Application code |
|---|---|---|
| Audience-appropriate explanation, examples, lesson progression | Shared Education teaching guidance, specialized by subject and stage | Persist selected settings and pass them to the active route |
| Plain/PPT Master authoring | Selected authoring Skill defines output and editability | Load Skill; validate tools and output contract |
| Scene image composition and educational style | Scene guidance plus stage and subject profile | Build prompts, submit image jobs, preserve approvals, extract supported layers, compile |
| Import behavior | Import Skill defines enrichment and source-preservation policy | Verify source binding, preserve original content, save and validate additions |
| Exact math/text in Scene pixels | Subject profile tells the model what to render; review guides quality | Do not rebuild native objects; verify with available review/repair and report uncertainty |
| Retry and completion | Skill may request an action but cannot declare durable completion | Existing Host state, task records, and readiness checks remain authoritative |

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

Ask the model for one complete teaching page, including all authoritative display text and visual content. This includes (when required) axes, ticks, point positions, data plots, legends, formulas, units, labels, body text, and illustrations. Do not add a native-object authoring pass for these image contents.

Subject guidance still specifies source-grounded values, labels, units, formulae, and relationships. Ask the model to preserve them exactly, then review the rendered artifact. If current tooling cannot reliably inspect or repair a mismatch, surface that limit and retain the user review checkpoint instead of silently changing the diagram's meaning.

### Post-processing

- Keep the full Visual Master as the visual source of truth.
- Extract image layers only for objects that benefit from independent appearance, movement, highlight, or spotlight.
- Let intrinsic diagram parts remain connected: axes with ticks, plotted marks, labels, formula symbols, flow arrows, and callouts can be one coherent image region. Do not force gutters between semantically connected parts.
- Do not split a complete chart or number line merely to make every mark independently movable. A whole diagram may be highlighted or spotlighted as one image object.
- Preserve stable layer-to-teaching-action mapping. Narration and timing remain separate from pixels.
- Do not claim raster text, labels, or charts are editable native PowerPoint objects. Scene editing is limited to supported image-layer operations and separate teaching/action data.

## Implementation Phases

### P0 — Pin routes and context contracts

1. Record the source baseline and dirty worktree state before implementation. Re-read nearest `AGENTS.md` files and route tests.
2. Trace task creation through saved `educationContext`, plan generation and approval, Visual Master planning, Host image intent, layer extraction, deck compilation, and readiness. Record where stage, grade, subject, and `visualStyle` are available at every boundary.
3. Confirm representative-image approval and reference continuity remain the course style gate. Determine how restyle requests interact with already prepared immutable image intents.
4. Inventory prompts and Skills reachable from the three paths. Classify each rule as shared Education guidance, route-specific authoring, Host invariant, or legacy/conflicting guidance.
5. Record the existing business-flow sequence and all required validation/approval gates for each route, including their owning layer, inputs, thresholds, and failure outcomes. Use these as behavior-preservation baselines for any stability work.
6. Record prompt limits, serialized formats, request idempotency keys, approval hashes, and retry behavior. Do not change them in this phase.

**Gate:** a route diagram and context table identify the authoritative source for each prompt field and every primary/fallback builder. No prompt infers stage from plan prose.

### P1 — Establish failure visibility and recovery gates

1. Gather representative interruption records from all three paths and map each to the failure classes above. Separate model/tool-call errors from provider, Host, persistence, cancellation, and user-decision stops.
2. Trace where each error is created, translated, persisted, and rendered. Identify cases where a specific code becomes a generic interrupted state or disappears after Runtime replacement/restart.
3. Add or reuse diagnostic metadata for operation/step ID, stable reason code, safe field diagnostics, and the revision or request identity it applies to. This is observability around existing results, not a replacement for business states, schemas, or route contracts; do not introduce a parallel workflow engine.
4. Make schema/parameter failures actionable at the tool boundary. Keep validation close to the schema owner, include invalid field paths and allowed bounds/enums, and ensure fixes cannot silently change route, page count, assessment type, teaching content, or paid request identity.
5. Preserve partial successes and resume only the failed eligible step at the existing authorized recovery boundary. Retain current no-resubmit behavior for unknown paid outcomes, finite read retries, bounded repairs, and no-progress handoff. Recovery must re-run every existing required validation before its current gate can pass. Confirm which state must survive app restart and persist only what is needed under Host ownership.
6. Add user-facing stop summaries from authoritative state: stopped phase, reason, saved outputs, safe resume behavior, and any required user action. Distinguish a decision gate, cancellation, blocked failure, uncertain provider outcome, and actual completion.
7. Add failure-injection coverage for incomplete Skill packages, missing/wrong tool arguments, Host validation rejection, transient read failures, provider timeout, unknown paid submission, cancellation, invalid output, save/adoption failure, Runtime recreation, and successful sibling work. Assert that no invalid task is silently downgraded, no unknown paid request is duplicated, no existing gate is skipped or weakened, and no intermediate output is reported as final.

**Gate:** the team can trace a sampled user-visible interruption to a stable failure class and owning boundary; each tested failure has a bounded, truthful outcome and preserves prior successful work. Existing route sequences, schemas, required checks, thresholds, approvals, and acceptance outcomes match the P0 baseline. No broad retry is added to make the test pass.

### P2 — Set the route-aware Education Skill boundary

1. Define compact, progressive-disclosure shared Education guidance for audience, language, source fidelity, lesson progression, and visible text versus teacher narration.
2. Keep route Skills distinct: ordinary/PPT Master authoring, Scene raster-first authoring, and Import enrichment each state their own output contract and limits.
3. Ensure Scene Skill specifies whole-page raster composition and subsequent image-layer teaching operations. Remove requirements to rebuild formulas, labels, charts, or slide text as native editable objects.
4. Keep existing Skill loading, schema validation, and permission checks. A Skill can guide a request but cannot grant tools or permissions.
5. Remove generic enterprise-training defaults/examples from Desktop prompts and built-in Education Skills. Preserve user-supplied literal content and out-of-scope products.
6. Remove contradictory copied rules. Load shared guidance once; route Skills add only their differences.

**Gate:** each route loads the intended Skill and makes no claim about another route's capabilities; user Skills retain current permission/tool validation.

### P3 — Resolve stage and subject visual guidance

1. Add a small typed resolver for existing stages and optional grade. Normalize case/whitespace once and keep resolution deterministic and bounded.
2. Encode the stage defaults and precedence above.
3. Scope subject guidance by route. For Scene Math, replace “must be native/SVG/LaTeX” with “render source-grounded math within the complete image; preserve exact values/labels; review rendered output.” Keep native/SVG requirements only on routes that support native authoring.
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

**Gate:** Main tests assert stage, grade band, subject, explicit style, approved Bible, exact text, and connected-diagram policy. Output stays within 4,000 UTF-16 units and current validation.

### P5 — Make Host fallback Education-aware and continuity-safe

1. Trace how Host resolves the approved Scene plan and authoritative task snapshot when creating image intents. Use saved Education context when stage-specific guidance is needed.
2. Remove the kindergarten picture-book fallback. With a Visual Bible, follow its approved art direction and page intent. For a legacy plan without one, use neutral, readable Education styling.
3. Preserve user style, exact visible text, required objects, accepted image reference, and 4,000 UTF-16 limit in full and compact prompts.
4. Apply layer separation only to independently animated/highlighted elements; keep connected chart internals intact.
5. Avoid persisting duplicate stage/profile fields if the approved task snapshot already supplies them. If context is unavailable at the prompt boundary, add the smallest compatible argument/field and specify old-plan behavior.
6. Never rewrite an approved plan or mutate a prepared immutable image intent on retry. An explicit restyle uses current review/re-approval and creates a successor intent.

**Gate:** Host tests cover current/legacy plans, stage fallbacks, explicit style, exact text, reference use, full/compact output, and limits. Unchanged retries retain prompt and idempotency identity.

### P6 — Align workflows without flattening route differences

1. **Plain/PPT Master:** select the authoring Skill and contract; report accurately which output is editable. Do not import Scene-only layer rules.
2. **Scene:** generate the approved plan and representative raster master, then process supported image layers and teaching overlays. Never invoke native text/diagram reconstruction.
3. **Import:** retain original slides, source mapping, and accepted media. Apply shared enrichment only to verified targets.
4. Share narration, audio, question, animation, spotlight, and completion logic only where existing contracts match. Keep route-specific capabilities explicit.
5. Change “teaching review” or “ready” language only when it overclaims what Host readiness checks establish. Host state remains completion authority.
6. Treat natural-language operation-button routing as a separate follow-up unless tests show an actual misroute. Do not introduce a generic command framework without evidence.

**Gate:** each route has a separate end-to-end test. Shared teaching operations preserve source content and do not claim unsupported editability.

### P7 — Cross-route acceptance

1. Add a fixture per route using the same stage/subject settings and assert its route-specific output contract.
2. Add Scene prompt fixtures for kindergarten, Primary lower/middle/upper, junior high, senior high, and unknown/general stage. Cover Math and one text-heavy subject.
3. Where rendered fixtures exist, verify chart labels, axis direction, tick sequence, point placement, units, and formulas. Structural tests prove only prompt propagation, not visual accuracy.
4. Verify first-image approval, course-reference continuity, restyle approval, retry identity, legacy-plan loading, and prepared-intent immutability.
5. Run targeted Desktop/Runtime tests, typechecks, Host Rust tests, and cross-layer courseware checks required by delivery policy for code changes.
6. Report paid/provider-dependent generation separately; do not claim it ran unless authorized and completed.

**Gate:** required local tests pass without skips; none of the three Desktop paths defaults to enterprise; no Scene primary/fallback prompt defaults to kindergarten; Scene visual content remains raster-first; old project and intent recovery remain valid. Stability changes preserve the P0 business-flow and validation baselines, verified by route-level regression tests; no required check is skipped, weakened, or moved behind a different approval gate.

## Regression Matrix

| Reliability case | Expected result |
|---|---|
| Required PPT Master Skill resource is missing | The incomplete Skill is not offered; diagnostics identify the missing package resource. |
| A tool call omits a required field or uses an invalid enum/bound | The owning boundary returns a stable error and field-level correction; route and requested teaching content remain unchanged. |
| The same validation failure occurs after a correction | Stop at that gate with a clear incomplete result; do not loop, downgrade the requested operation, or claim success. |
| A provider read fails transiently | Retry only the eligible read within its fixed budget; preserve the original operation identity. |
| A paid submission outcome is unknown | Query the original intent; never create a replacement submission automatically. |
| One page/job fails while independent authorized work remains | Preserve successful work and continue eligible siblings; report the failed item separately. |
| Runtime is recreated during a saved workflow | Resume from Host-authoritative state and existing checkpoint semantics without duplicating work. |
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
- `crates/host-core/src/rpc/courseware_projects/scene_plan.rs`
- `crates/host-core/src/rpc/courseware_projects/scene_images.rs`
- `crates/host-core/src/rpc/courseware_projects/scene_images/prompts.rs`
- Related tests under `apps/desktop/test`, `packages/agent-runtime/src`, and `crates/host-core`
- `docs/spec/04-ux/09-interaction-patterns.md` and `docs/spec/06-delivery/04-e2e-test-plan.md` for behavior changes

## Non-Goals and Deferred Work

- Rebuilding Scene pixels as editable native text, formulae, chart objects, or shapes.
- Claiming exact image-model text/math rendering without output review.
- Replacing Skills/plugin permissions or adding a generic workflow engine.
- Making import, plain generation, PPT Master, and Scene identical internally or in editability.
- Adding grade fields before evidence shows the existing free-form grade is insufficient.
- Reworking the PPT Master downloader. Improve its `fetch failed` diagnostics separately after route and Skill contracts are settled.
- Live generation, publishing, committing, or integrating code.

## Implementation Order and Delivery Notes

Execute P0 through P7 in order; diagnose observed interruption classes before changing prompts or recovery behavior, and characterize Main/Host boundaries before changing prompts. Change shared source files sequentially. Before code work, follow the repository's current branch/worktree policy and preserve dirty files. Prompt snapshots and typechecks do not establish visual accuracy. Report automated structural checks separately from human-reviewed rendered results.
