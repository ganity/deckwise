# PPT Master narration analysis and regression evidence

## Decision

Use MAIC's import approach to ground narration in the actual exported slide, and
its generation approach to supply a coherent, audience-appropriate teaching flow.
Speaker notes are useful source material, but do not own either slide facts or
the final teaching script. No MAIC service dependency or second narration engine
is added; these rules use DeckWise's existing shared saved-narration workflow.

| Path | Useful behavior | Application here |
| --- | --- | --- |
| MAIC new course | Objective, delivery contract, complete teaching moves, exact spoken words, audience/language policy, cross-page continuity | Plan how to teach, model an expression and give a learner a turn; avoid title-reading, filler and repeated greetings |
| MAIC PPT import | Actual page evidence, notes as reference, visible facts, prior/next-page context and authoritative animation ordering | Constrain claims to the exported page; distinguish labels from pictures and align focus with real object identities |
| DeckWise PPT Master | Official SVG/PPTX export followed by shared body narration and assessment/media preparation | Reuse the common workflow; adapt notes rather than send them directly to TTS or trust planned pictures as existing |

MAIC sources inspected in the sibling `evo-trainwise-maic-server` checkout:

- `lib/generation/prompts/snippets/slide-actions-system-core.md`
- `lib/generation/narration-brief-planner.ts`
- `lib/import/narration/plan-import-narration.ts`
- `lib/import/narration/build-import-action-prompts.ts`
- `lib/import/narration/generate-import-scene-actions.ts`
- `lib/import/narration/clean-import-page-evidence.ts`
- `lib/import/narration/build-import-deck-voice-arc.ts`
- `lib/generation/prompts/templates/import-scene-actions/system.md`

This ports relevant rules, not every MAIC validator or fallback. MAIC's native
animation timeline remains a useful reference; existing DeckWise motion ownership
and unsupported-motion guards remain in effect.

## Reproduced problems

The earlier real task is recorded at
`<validation-dir>/ppt-master-retry-20261109-kFKqiV/README.md`.
Its six pages played through, but acceptance was incomplete:

1. Four body pages produced 15 / 23 / 21 / 13 speech actions: 72 body audio tasks.
   The prompt required one sentence per block and normalization also split sentences.
2. Page 4 described six people in a family photo, although the actual page contained
   labels and a caption without that portrait. Notes/plans were allowed to supply
   unsupported visual facts; readiness did not check this semantic mismatch.
3. Page 6 became a short-answer Quiz after rejected plan submissions. There were
   zero interaction checkpoints. Loose tool shapes and opaque errors encouraged
   retries with a different accepted representation.
4. Custom Animations was enabled, but there was no animation sidecar and no native
   timing in the exported PPTX. The 54 speech-linked animation actions were a
   different capability and could not establish native-animation acceptance.

Checkpoint response data was also examined: the local response contract belongs
in `metadata.teachingRequirements.question.response`. MAIC checkpoint actions
deliberately exclude that field. Adding it to the action would violate the MAIC
wire contract; omission there is not a lost-response defect.

## Implemented correction

- Generate exact teacher speech as complete moves on one focus, separating focus
  changes and learner turns. Remove mechanical sentence splitting for bounded
  blocks; preserve the existing long-text limit and content. Prefer 2-4 concise
  kindergarten moves without imposing a truncation rule or inventing repetition.
- Give teaching requirements pedagogical authority and actual visible evidence
  factual authority. Notes and existing speech are references. Include assessment
  context in deck planning so body narration leads into remaining activities.
- Apply structured visual grounding to the common plain/import/scene batch.
  Missing required visuals fail the page before narration saving/TTS. Conflicting
  notes are removed only from in-memory model evidence and reported. Unavailable
  vision is an explicit diagnostic, not a claim of verified visual completeness.
- Describe body, Quiz and interactive/PBL plans as distinct tool shapes. Return
  field-specific validation errors, retain legitimate short-answer Quizzes, and
  tell the generator to repair fields without changing requested assessment kinds.
  Actual adoption tests assert checkpoint and response metadata, including restart.
- Direct native-motion requests through the existing official customization stage
  and correct reference paths. Include optional `animations.json` in both renderer
  and Host export freshness checks. Test official configuration validation and
  actual PPTX native timing, independently of speech-linked effects.

No source PPTX, notes or paid-task artifacts from the earlier run were rewritten.
Generated speech is saved by the existing revision-checked path; TTS remains a
subsequent operation and is not purchased by these regressions.

## Verification

Provider-free checks on `feat/courseware-par-A`:

| Check | Result |
| --- | --- |
| Shared presentation and teaching-quality Vitest | 14 passed |
| Agent narration-write and workflow tools Vitest | 49 passed |
| Desktop narration batch, PPT quality and teaching coordinator | 106 passed |
| Real Host + official PPT Master export/adoption/restart | 4 passed |
| Runtime native-click projection and fixed-build | 34 passed |
| Desktop TypeScript | Passed |
| Shared/agent builds and Host debug build | Passed |
| Rust format check for the changed presentation RPC | Passed |

Execution state: the existing `courseware-par-A` worktree at HEAD
`c87a0e8a166bc7d46361cbb2c27f9c8d63e7ddc6`, including its pre-existing and task
changes. Cached `origin/main` is `58a9c4f57203c93da3f590e426b42ebba1072fb6`.
The user's ongoing dirty worktree was preserved; no rebase or main integration
was performed. These are local regression results, not PR integration acceptance.

The official export fixture has real entrance-fade timing on its body slide;
its fixed Quiz and interaction slides have no timing. Updating the animation
sidecar after export rejects adoption until validation/export is fresh again.

These checks establish control flow, schemas, persistence and export behavior.
They do not establish the quality of a fresh paid model-generated lesson. Semantic
visual checks depend on the vision model and may miss a mismatch or flag one
incorrectly. Native WiseOffice sidebar playback, standalone PowerPoint, arbitrary
native presets and automatic execution of unbound motion in a new generated
course were not rechecked in this change. The earlier lesson is evidence of the
defects, not a newly repaired acceptance result.
