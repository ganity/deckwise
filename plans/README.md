# Scene Courseware Repair Plans

**Latest Plan 009 validation (2026-11-18):** [Three fresh four-page lessons](009-evidence/2026-11-17-model-validation/README.md)
used DeepSeek V4.1 Flash 1017 and assisted GPT continuation. Master/Import passed
content review; Scene retained a wrong-page hint and incomplete river/arrow
effect coverage. All 32 speech clips completed actual playback. Full restart
verification failed to reach a window and remains unverified. P1/P7 stay open;
historical successful samples below do not supersede this result.

**Local follow-up (2026-11-18):** [Hint and complete teaching-region repair](009-evidence/2026-11-18-background-region/README.md)
now supports the accepted river-region behavior. The repaired real four-page
artifact passed native save/reopen and all 16 retained audio segments played;
the new region visibly faded and received spotlight. This is assisted local
recovery, not a replacement three-route paid success claim.

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
| [009](009-education-scene-generation-and-skill-optimization.md) | Preserve current business/validation contracts, verify existing recovery, and add stage-aware Scene body-image guidance | P1 | L | Preserve 001–008 invariants; refresh baseline then execute P0–P7 | IN PROGRESS |

Plan 009 was revised on 2026-11-13 against reference HEAD `ee3202bd6` and the
observed worktree follow-ups. It retains the business/validation baseline,
separates raster Scene body pages from independent editable assessments, and
records current batching/recovery, visual tolerance, approval, media and
sync/publication boundaries. Existing capabilities are reuse/verification work.
The request worktree implements stage-aware Main/Host prompts, route-scoped
Math/Chinese guidance, the Scene Skill boundary and verified PPT Master package
resources. Provider-free workflow tests and the packaged six-entry Electron
route/restore/native-editor fixture pass. The subsequently authorized
[live media smoke](009-evidence/2026-11-15-live-media/README.md) verified one
primary-Math image, real decomposition, native compilation, two real TTS tasks,
original-intent recovery and natural playback after a full restart. Recorded
media receipts total 10 points. Tick spacing is approximate; broad visual
accuracy, autonomous multi-page generation, historical interruption attribution
and deployment remain unqualified, so the plan remains IN PROGRESS. The test
authentication rotation was repaired by the user's subsequent sign-in; existing
courseware data was untouched.

On 2026-11-16 the request branch integrated fork `origin/main` at `5cbd7cb44`
(v0.20.5), preserving the local stage-aware Scene and stability work. New Scene
plans retain raster lettering; existing approved native-text plans remain
recoverable. The integration checkpoint in Plan 009 records the combined-build
and regression evidence. P1 historical attribution and P7 broader live
acceptance remain open; no remote push, deployment or new installer is claimed.

On 2026-11-17, Plan 009's new three-route real small-lesson acceptance passed:
Grade 3 rectangle area (Master), Grade 7 food chains (Scene) and Grade 1
Quiet Night Thought (Import), four physical pages each under the six-page cap.
All 19 real speech clips naturally ended; Quiz feedback, oral continuation,
effects and full restart/native reopen passed. The run repaired the missing
native document vision callback and retains upstream/model failures and
operator recovery. See [the new evidence](009-evidence/2026-11-17-three-path-live/README.md).
Historical P1 attribution and the broader P7 visual/interruption matrix remain
open; this is source-build acceptance, not new installer or deployment approval.


Plan 009 follow-up fixes now cover malformed review recovery within existing
budgets, exact program-resolved object references, accepted-unit evidence and a
final native saved-content review before completion. Automated verification and
remaining real-model/native qualification are recorded in the
[recovery follow-up](009-evidence/2026-11-17-three-path-live/generation-recovery-fixes.md).
Historical P1 attribution and broad P7 remain IN PROGRESS.

A subsequent authorized [paid three-route rerun](009-evidence/2026-11-17-paid-rerun/README.md)
uses the final native content-review candidate. It has detected genuine Scene,
native observation and generated assessment issues and is not a three-route
pass. Three narrow recovery fixes have targeted validation; original approval,
source/audio preservation and validation budgets remain enforced. Keep this
rerun separate from the earlier passing evidence above.


The [2026-11-17 local closeout](009-evidence/2026-11-17-closeout/README.md) now
adds three **fresh** four-page lessons with final content review, 28 natural
speech completions, actual effects/interaction playback and full process
restart/native reopen. Scene connecting arrows are foreground targets and its
whole-diagram effect gap is closed for the fresh sample. Import originals and
final scripts remain intact. Scene needed one explicit continuation after the
unchanged no-progress stop; original audio results were adopted without
repurchase. Do not describe this as three uninterrupted autonomous successes.

P0/P2–P6 implementation is complete in scope; P1/P7 remain partially qualified
for historical attribution, failed-repair continuity across runtime recreation,
broader visual/stress coverage and a matched par-A comparison. The runtime-local
repair guard prevents a broad review from erasing known required failures while
that runtime remains alive. Deliver Desktop with the recorded companion editor
patch and bundle. This closes the requested local round, not the entire P1/P7
qualification or a release; no commit, merge, push or publication was performed.


[Follow-up stability verification](009-evidence/2026-11-17-stability/README.md)
passed 1,842 Runtime and 216 Desktop checks but reproduced one shared native
runtime-recreation defect across three route fixtures. Known failed required
repairs lose their blocking record when the runtime is rebuilt; a broad passing
review can then misreport readiness. This confirms the documented limitation,
including normal document handoff as a source-level trigger. No product change
or paid call was made. P1/P7 remain open pending durable failure continuity and
its lifecycle acceptance.


The [durable repair follow-up](009-evidence/2026-11-17-durable-repairs/README.md)
fixes the reproduced lost-required-repair state using the existing Host database
and CAS, without a canonical teaching mirror. It also records the state-transition
audit: remaining native candidate retry-counter lifecycle risk and the previously
observed Scene adoption delay are not declared fixed. P1/P7 remain partially
qualified. Desktop and Host must ship together.


The [tool-contract recovery follow-up](009-evidence/2026-11-18-tool-contract-recovery/README.md)
addresses reproduced directory guessing, contradictory refresh flags and
unactionable input failures. Host-owned paths, valid Quiz scopes and bounded
runtime input correction preserve the existing workflow and paid-job guards.
This is local regression evidence; it does not close outstanding real-model
three-route qualification or change earlier failed-run results.


The [native retry lifecycle follow-up](009-evidence/2026-11-18-retry-lifecycle/README.md)
closes the reproduced same-turn native narration budget reset, preserves visual
failure stages, and retains trusted field diagnostics through automatic recovery.
Desktop, Host and Runtime builds must be delivered together. Three-route fixture
coverage and Host database reopen are not fresh paid generation or installed-app
crash qualification; P1/P7 remain partially qualified.
