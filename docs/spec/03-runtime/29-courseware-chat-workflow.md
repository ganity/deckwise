# Main Chat courseware generation

Status: implemented locally. Targeted renderer, Agent, Main and Host tests run
against fixtures. Live provider-to-WiseOffice acceptance remains pending.

## Ownership

The existing main Chat owns requirements and generation progression. The work
panel remains an inspection/editing entrance. Task types remain `plain`, `scene`
and `import`; school stage is guidance, not routing. No second assistant, model
loop in the renderer, database owner or generation engine is introduced.

The main-window-only `deckwise/courseware/workflow/get` IPC accepts exactly
`{sessionId}`. Main validates the active viewing Chat, stable Host and workspace.
Generic Chats without a saved task show no card. Failed reads remain actionable.

## Finite Agent operations

These sequential Agent-mode tools use existing `tools.execute` permission,
admission, audit and cancellation. Only reading is low risk; the rest are high.

| Tool | Responsibility |
| --- | --- |
| `courseware_workflow_get` | Read saved requirements, plan/approval, image requests, advertised models and exact asset blockers. |
| `courseware_requirements_update` | Persist confirmed education settings with CAS before approval or attachment. |
| `courseware_scene_image_prepare` | Prepare an image intent through the existing service, without payment/submission/adoption. |
| `courseware_scene_image_refresh` | Query the original task and archive verified ready/settled bytes for human review. |
| `courseware_scene_compile` | Revalidate approved plan and selected assets, then use existing compilation/staging. |

Session and turn are Host-bound, not model-controlled. Stop, conversation switch
and Host replacement fence late work. Compiler dispatch requests 16 minutes to
outlast its existing 15-minute internal timeout; global timeouts are unchanged.
The existing generation service checks captured scope and aborts when it expires.
Uncertain outcomes require reading saved state, never automatic replay.

The scene skill and route distinguish unapproved planning from approved
progression. Natural-language continuation reads readiness instead of rewriting
the plan. Existing `asktool` collects essential missing answers. Latest saved
settings override the initial prompt snapshot; changed settings require revising
an unapproved plan. This remains model-directed finite orchestration, not a
deterministic language parser or unlimited autonomous loop.

## Saved requirements

Host RPC `courseware.task.updateEducation` accepts exactly
`{sessionId, expectedEducationContext, educationContext}`. It uses the existing
strict schema, 500 UTF-16 units per string and 4096-byte task bound. The complete
new context replaces the old; unspecified existing fields must be preserved.
Host serializes updates and rejects stale context, any previous scene approval,
or imported/generated source attachment. Task identity and unrelated fields are
unchanged. Later teaching changes use existing reviewed revisions. No migration.

## Routes and human decisions

- **Ordinary PPT:** keep PPT Master and SVG/notes/final-quality gates. Main Chat
  opens page preview/editing, requests checked final export and opens saved PPTX.
  Card and workbench share project inspection; quality rules are not duplicated.
- **Scene:** show actual draft text, visual intent and narration. Trusted UI pins
  approval to the reviewed hash, verifies its receipt, then prompts the same Chat
  to advance. Readiness names missing reference, clean background and foreground
  objects per page, duplicates, identical images, archive gaps and size overflow.
  Compilation still validates bytes. References precede dependent assets.
- **Images:** show exact prompt, real quotation and any private reference. An
  unchecked fee/egress consent and valid quote are required for submission.
  Unknown outcomes query the original request. Human preview/selection uses
  existing selected-intent CAS and then continues Chat. Preparing never pays;
  readiness never selects. Revised prompts may create new intents; exact dedup
  and recovery remain service-owned.
- **Import:** use the existing authorized picker/token import, then open saved
  PPTX. Cancellation preserves the same task for retry. The model cannot choose
  arbitrary file paths. Existing notes, narration and effects use editor APIs.

Preview/Office may open their artifact work panel; no workbench form is needed
for generation. Existing narration/effect review and publication controls are
not relocated. Collaboration, animation coverage and media canvas are unchanged.
Images retain individual confirmation/selection; no bulk spend or paid retry.
Status refresh is explicit or Chat-driven, not indefinite polling. Whole-plan
approval/asset invalidation remains unchanged; narration-only draft changes do
not gain automatic reuse of paid assets.

Tests: `courseware-chat-workflow-ui.test.mjs`,
`courseware-chat-workflow.test.mjs`, `courseware-workflow-tools.test.ts`,
`courseware-workflow.test.ts`, Host `chat_requirements_*`, and scene/PPT Master
regressions. Fixtures do not certify actual provider behavior or real Office
integration. See the corresponding delivery E2E scenario.
