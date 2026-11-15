# Scene Courseware Repair Plans

These plans answer the 2026-10-31 systemic audit. Plans 001–006 are now
**implemented and locally verified**. See the [delivery evidence](../docs/spec/06-delivery/2026-11-01-scene-workflow-repairs.md)
and [machine-readable gate report](validation-report.json). Native editor/player
and live-provider acceptance remain explicitly unperformed.

## Shared teaching enrichment implementation

[Plan 008](008-shared-teaching-enrichment.md) records the implemented shared teaching
flow for scene generation, PPT Master and imported PPTs with optional lesson plans
and narration scripts. It links the detailed design and implementation approach,
with nine phases, 41 tasks and explicit acceptance gates. Its implementation and local qualification are documented in the
[execution evidence](../docs/design/2026-11-10-shared-teaching-evidence.md). External
provider/application qualification remains separate from local test results.

## Baseline and execution policy

- Workspace: /home/jhz/code/train/deckwise-desktop-worktrees/courseware-par-A
- Branch: feat/courseware-par-A
- HEAD: 1ff749805
- Baseline includes 204 pre-existing working-tree status entries.
- [File fingerprints](baseline.json) identify the actual audited source.
- Continue in this worktree. Preserve unrelated edits. Do not create another
  worktree, commit, deploy, or run paid generation as part of plan preparation.
- Follow AGENTS.md, existing Host persistence ownership and code/test patterns.
- A source hash change, empty lookup or generic transport error is not permission
  to purchase a replacement for an uncertain original.

## Order and status

| Plan | Outcome | Priority | Effort | Dependency | Status |
|---|---|---|---|---|---|
| [001](001-preserve-media-targets.md) | Pending/adopted music/video survive verified source saves | P1 | L | None | DONE |
| [002](002-fix-media-dispatch-and-refresh.md) | Begin only at admitted dispatch; concurrent refresh reconciles | P1/P2 | M | None logically; execute after 001 | DONE |
| [003](003-unify-workflow-recovery.md) | Bounded progress, isolated failures, one terminal report | P1 | M | 001, 002 | DONE |
| [004](004-preserve-teaching-and-check-requirements.md) | Repair deltas preserve speech; approved questions truly match | P1 | M-L | 003 | DONE |
| [005](005-retain-required-video.md) | Explicit required video remains enforceable through acceptance | P2 capability | M-L | 001, 003, 004 | DONE |
| [006](006-cross-layer-acceptance.md) | Fresh-build real-boundary acceptance gate | P1 gate | M-L | 001-004; video checks after 005 | DONE |

Effort: S = hours, M = roughly a working day, L = multiple working days, including
tests. These are relative planning estimates, not a delivery commitment. The
source-binding and format-compatibility work has the largest uncertainty.
All fixes preserve the independent caps: TTS 10, image 5, layers 5, music 2,
music export 2, video 2.

Do not postpone characterization tests until plan 006. Each repair begins with
its own failing regression. Plan 006 joins actual neighboring components and
makes their mandatory execution repeatable. Plans share files; implement
sequentially in this worktree rather than editing the same files concurrently.

## Issue-to-plan map

| Audited issue | Repair |
|---|---|
| Normal PPT save hides pending music/video and invalidates adopted video | 001 |
| Host begin before queue admission creates never-dispatched unknowns | 002 |
| Same-order status readers race on journal CAS | 002 |
| Unknown image with null task is mistaken for pending | 003 |
| Image polling has no overall semantic-progress bound | 003 |
| One failed image ends recovery of healthy independent work | 003 |
| Top-level video unknown differs from Runtime's nested-state expectation | 003 |
| Completed-with-advisories can rearm the same run | 003 |
| Requirement repair trims/resplits supposedly immutable speech | 004 |
| Different question with equal response passes acceptance | 004 |
| Required video exists only in prose and can be omitted undetected | 005 |
| Isolated mocks/optional Host tests miss incompatible layers | 006 |

## System responsibilities

| Layer | Required responsibility |
|---|---|
| Skill | Teaching intent, content strategy, documented human gates, valid contract examples |
| Shared/tool contracts | Consistent requirements, job identity and recovery meanings |
| Runtime | Authorized next steps, independent work, bounded retries/progress and terminal handoff |
| Main | Queue admission, actual service calls, archive/decode/adoption orchestration |
| Host | Durable original requests, verified target bindings, atomic saves and completion authority |

Reuse existing journals, checkpoints and queues. No new generic workflow
platform, server scheduler, database bypass or plugin-based persistence owner is
proposed. Provider ready, local archive, saved adoption and requirement completion
remain distinct facts.

## Required invariants

1. A known unsubmitted request can remain prepared; a genuinely uncertain request
   retains the original intent/key and is never implicitly replaced.
2. Valid source saves/reorders update target bindings atomically; paid request
   identity and account scope remain immutable.
3. Concurrency is independent by type; reads do not require generation capacity.
4. A failed/unknown job does not suppress independent authorized work.
5. No meaningful progress for ten minutes yields an honest bounded handoff;
   unchanged diagnostic repair has at most two attempts.
6. Required-action repair never changes original speech/audio/effects.
7. Completion comes from saved Host requirements and adopted media, not prose.
8. Terminal reporting closes the current run; only a new user run can resume.
9. Old projects/journals remain readable; new persistent formats have explicit
   version, upgrade and downgrade behavior.

## Acceptance evidence

The mandatory gate passed: Main/Host 413, Shared 27, Runtime 413, Rust 250.
All selected JavaScript cases executed without skips; two pre-existing optional
Rust fixture cases remain ignored. The new mandatory Host regressions executed.
Application production builds, Desktop typecheck and all-target Host clippy pass.
Independent concurrency peaks remain 10/5/5/2/2/2; queued quote expiry dispatches
zero POSTs. Real paid provider calls: zero.

The delivery evidence records commands, captured red cases, source snapshots,
compatibility coverage, exact contract counts and remaining native/live checks.
Whole-workspace docs build and formatting still have the recorded pre-existing
release-baseline failures; these scoped checks are not a full release acceptance.

## Compatibility and rollout

1. Characterize pre-fix behavior on isolated fixtures.
2. Implement one bounded repair and run its scoped gates.
3. Verify existing journals/projects and predecessor-plan invariants.
4. Integrate all bug fixes and execute the cross-layer gate.
5. Include the video requirement extension only with its schema/hash/mapping/
   acceptance compatibility tests.
6. Rebuild the matching Desktop/runtime/Host components together for acceptance.
7. A separately authorized real ten-page run is the final operational check,
   not the discovery mechanism for every regression.

For new optional persisted fields, explicitly establish new-code/old-data
compatibility and old-code/new-data limitations. Never roll back by deleting
receipts, overwriting order IDs or stripping required teaching metadata.

## Out of scope and considered findings

- Process-only concurrency: already explicitly documented in
  courseware-media-transport.ts; server-wide enforcement is not silently added.
- Seven-day TTS result cache and query-only unknown submissions: documented
  boundaries, not defects to solve with retries or repurchase.
- Missing structured video: a documented capability gap, tracked separately as
  005 rather than represented as a newly introduced regression.
- Automatic grading/full arbitrary motion parity: not promised by these plans.
- Provider outages, missing models and the earlier original TTS recovery HTTP
  500: require separate service diagnosis. These client plans cannot guarantee
  recovery of audio the supplier/server never durably saved.
- Visual and pedagogical correctness: structural acceptance is necessary but
  cannot prove arbitrary model-generated content quality.

## Updating this index

Statuses: TODO, IN PROGRESS, DONE, BLOCKED (with reason), REJECTED (with rationale).
Record actual verification and remaining coverage when changing a status.
Do not mark DONE from edits alone or from a test that skipped its required case.

## MAIC compatibility and authoring follow-up (2026-11-04)

| Plan | Outcome | Priority | Effort | Dependency | Status |
|---|---|---|---|---|---|
| [007](007-maic-courseware-parity.md) | Canonical MAIC output, separate Quiz/interaction authoring and playback (legacy migration excluded) | P1 | L | Preserve 001–006 invariants; phases P0–P7 inside plan; P6 excluded | IN PROGRESS |

Plan 007 establishes a new compatibility target and supersedes the earlier
exclusion of MAIC Quiz/interaction parity within its explicit scope. It includes
the editor requirement, a pinned multi-repository baseline and phase-level gates.
Implementation is in the isolated `feat/maic-courseware-parity` worktree at
`/home/jhz/code/train/deckwise-desktop-worktrees/maic-courseware-parity`.
Local generation, canonical persistence, dedicated authoring, native sync,
preview and MAIC ZIP export are implemented. Ten real desktop journeys and the
strict actual MAIC/cloud-web consumer checks passed; the host-style visual gate
also passed. See [the acceptance record](007-maic-courseware-parity-acceptance.md)
for evidence and online publication boundaries. The overall index remains IN
PROGRESS for authenticated signed publication; no deployment or merge is claimed.

## Education generation and stage-aware Scene visuals (2026-11-11)

| Plan | Outcome | Priority | Effort | Dependency | Status |
|---|---|---|---|---|---|
| [009](009-education-scene-generation-and-skill-optimization.md) | Preserve current business/validation contracts, verify existing recovery, and add stage-aware Scene body-image guidance | P1 | L | Preserve 001–008 invariants; refresh baseline then execute P0–P7 | TODO |

Plan 009 was revised on 2026-11-13 against reference HEAD `ee3202bd6` and the
observed worktree follow-ups. It retains the business/validation baseline,
separates raster Scene body pages from independent editable assessments, and
records current batching/recovery, visual tolerance, approval, media and
sync/publication boundaries. Existing capabilities are reuse/verification work;
stage-aware Visual Master context and fallback remain outstanding. The plan
remains TODO for that remaining work; this document update does not establish
new implementation, rendered-image acceptance, release or live deployment.
