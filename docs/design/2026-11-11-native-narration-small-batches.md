# Bounded native narration generation

## Problem and evidence

The 56-page Shadow lesson invoked native narration at 15:31:39 on 2026-11-11.
At 15:45:40 it returned `Chat turn cancelled` after 840 seconds, with zero saved
speech actions. The agent then repeated the same full-deck request. Native
processing prepared every selected page before planning or writing any speech;
its deadline was also included in the owner/cancellation predicate.

The same session independently encountered `Cannot find package
'electron-updater'` while loading a lazily imported model transport. Local
inspection confirmed the declared package's workspace link was absent, alongside
TypeScript links and workspace build outputs. The package was already declared
in desktop dependencies and present in the pnpm store: this was an incomplete
local development tree, not evidence that the installer omits the dependency.
`pnpm install --offline --frozen-lockfile --ignore-scripts` restored links without
changing manifests or lockfiles; desktop dependency builds restored JS/type output.
This does not prove that every packaged installer is correct.

## Follow-up: bound the outer tool call too

The first repair bounded only internal relay work. The public tool still accepted
100 pages, and both PPT skills explicitly instructed one full-deck call. A later
screenshot correctly showed 56 pages in the visible tool input. That implementation
did not meet the requested visible batching behavior.

The corrected tool schema now caps `pageNumbers` at five. Native and legacy Main
handlers independently reject oversized generation calls. Skills and Chat guidance
require sequential calls, waiting for save and rereading current source SHA before
the next unfinished batch. Automatic required/focus repair caps each call as well;
repair budgets count only the current batch, preserving later requirements.
Full-deck status reads and existing audio recovery retain their previous scope.
Regression tests first reproduced acceptance of oversized input, then verify
rejection before generation/Host dispatch and five-page automatic repair calls.

## Follow-up: five-page limit and observed retries

The user subsequently raised the batch limit from three to five pages. The tool
schema, native and saved-source guards, internal native batch size, automatic
repair scopes and agent instructions now agree on five. Model concurrency stays
at three; the batch limit does not mean a single model response generates every
page. A contiguous five-page batch carries at most nine outline entries including
two neighbors on either side. Five pages are accepted; six and 56 are rejected.

Read-only inspection of the live session identified the screenshot's failed
30–32 batch: it took 42.1 seconds and saved no pages because `mustMention` failed
plan validation after the bounded repair. The agent then requested page 30 alone
(28.3 seconds, saved) and page 31 alone (29.9 seconds, same validation failure).
Other receipts include attention-target and wait-duration repairs and native
revision refreshes. These receipts establish repeated work, but do not expose the
raw invalid plan or a per-stage latency breakdown. Raising the batch size does
not fix those independent failures or prove a throughput improvement.

## Implementation

- Native generation splits requested pages into consecutive groups of at most
  five. Sparse selections start separate batches.
- The relay receives at most five current pages plus two neighboring page
  summaries on either side. Neighbor text, notes, objectives and existing speech
  summaries are each capped at 400 characters. Only current pages need imagery.
- Each batch grounds visuals, plans local teaching/bridges, writes individual
  pages and waits for the native save acknowledgment before the next batch.
- Source SHA/revision is reread between batches. Original document identity and
  page order remain pinned, and existing read-only/lock/script policies remain.
- A failed batch returns successful peers and explicit failed/not-started pages.
  Page-local validation failures allow independent later groups to continue;
  cancellation, ownership, transport and uncertain-save failures stop later groups.
  Successful previous batches are not automatically replayed. A rejected save is never reported as persisted. An explicitly requested
  rewrite remains supported; recovery should request only unfinished pages.
- The native deadline remains a per-batch safety budget, separate from turn
  cancellation. Native errors after acknowledged writes preserve that progress.
- Legacy Host-project generation retains its existing full-outline behavior.

## Validation and rollout

Provider-free regression tests exercise 56 pages (12 batches), payload bounds,
prior-speech context, sparse selections, changed source hashes after save, later
failure, rejected persistence, document switching and per-batch deadlines. The
existing narration/effect/retained-audio and editor-save suites are also run.
A stale fixture returning speech blocks to an effect-only request was corrected
to supply the actual `focuses` delta and assert that speech is not regenerated.

The five-page follow-up passes 163 desktop regression tests and 90 agent-runtime tests.
Desktop TypeScript, the production desktop build, the agent-runtime TypeScript
build and sidecar bundle all pass. The earlier three-page repair rebuilt the
worktree's normal `apps/desktop/out`. This five-page repair validates desktop
output separately at `/tmp/part-a-five-page-build-20261111` while preserving the
running client's Main chunks, and rebuilds `packages/agent-runtime/dist` and
`dist-bundle`. The next normal development startup rebuilds desktop output and
loads the new limit. A smoke check imports the built tool and verifies
that 6/56 pages are rejected before Host dispatch while five pages are accepted.
Both separately built Main handlers contain the independent five-page guard. No client
was started or restarted by this change. Existing loaded code still requires a
normal client restart to load new Main/sidecar code.

No actual paid relay/TTS run of the user's 56-page lesson was started, stopped or
reported as completed by this change. Real relay throughput, teaching quality and
visible editor acceptance still need a separate live run. No new dependency,
installer contract, database, commit, push or deployment is introduced.

Logs: `/tmp/part-a-small-batches-final-tests.log`,
`/tmp/part-a-small-batches-typecheck.log`,
`/tmp/part-a-small-batches-build.log`, `/tmp/part-a-batch-install.log`,
`/tmp/part-a-tool-limit-main-tests.log`,
`/tmp/part-a-tool-limit-agent-tests.log`,
`/tmp/part-a-tool-limit-desktop-typecheck.log`,
`/tmp/part-a-tool-limit-desktop-build.log`,
`/tmp/part-a-tool-limit-runtime-build.log`,
`/tmp/part-a-tool-limit-agent-bundle.log`.

Five-page validation logs: `/tmp/part-a-five-page-main-tests.log`,
`/tmp/part-a-five-page-agent-tests.log`, `/tmp/part-a-five-page-typecheck.log`,
`/tmp/part-a-five-page-desktop-build.log`,
`/tmp/part-a-five-page-runtime-build.log`,
`/tmp/part-a-five-page-runtime-bundle.log`.


## Root-cause repairs after repeated single-page fallbacks

The five-page limit bounds request size; it cannot correct invalid output, a false
rejection or an incorrectly renewed retry budget. Deterministic probes reproduced
these additional causes before source changes:

| Cause | Corrected behavior | Regression evidence |
| --- | --- | --- |
| Full-string matching skipped one-character Chinese text and retained layout line breaks | Normalize CJK layout spacing, accept a single Han character, and recognize literal paragraph clauses of at least four letters/digits. Keep Latin word boundaries, ambiguous-picture checks and backplate rejection. | Plain/import/scene accept the same paragraph with/without layout breaks and a separate 前 label; an unrelated 后 target still fails. |
| Idle autosave changed only the package SHA | Compare the rest of the native project, captured text/layout/requirements/source policy and selected pixels. Update the live save binding only after verification, without replacing valid model output. | A two-page SHA-only transition stays at two vision calls, one plan and two speech calls; a simultaneous real pixel edit still causes a refresh, even without a generation bump. |
| One malformed page brief rejected the whole plan | Preserve validated peer briefs and the original goal; request one repair for only invalid pages. Return terminal per-page planning failures if repair fails, and save the independently valid pages. | Requested [1,2,3], malformed page 2: plan scopes become [1,2,3] then [2]; pages 1 and 3 save. A successful correction saves all three. |
| Retry counts restarted on another tool call or a peer save | Share at most three page-generation/delta calls per page/content/model/repair-mode within the active durable user turn. A changed instruction, batch grouping, autosave SHA or peer teaching revision cannot reset it. A new explicit user turn or changed local content has a fresh budget. | Re-entering an exhausted page makes no additional paid vision, planning or speech call; coordinator tests verify a fresh user turn permits another bounded attempt. Saving page 2 does not renew failed page 1. |
| One failed contiguous segment stopped unrelated sparse selections | Continue other segments only for classified page-local terminal errors. Keep fatal transport, owner, cancellation and uncertain-save stops. | Selection [1,3] saves page 3 after page 1 exhausts output repair; existing fatal-stop tests still pass. |
| An invalid effect binding discarded valid speech | When the structured narration is valid and only object binding fails, request a strict object-ID delta against existing speech-block indices. Preserve every word, wait and media block; pass the result through the normal candidate and write validators. | Backplate repairs work in all three task types. A model response attempting to replace speech is rejected; the next valid binding delta retains exact speech and its 4000 ms learner wait. |

Output failure codes include `COURSEWARE_NARRATION_PLAN_INVALID`,
`COURSEWARE_NARRATION_OUTPUT_INVALID` and
`COURSEWARE_NARRATION_RETRY_EXHAUSTED`, each with `retriable:false` after its
bounded repair is exhausted. The public tool and both PPT skills prohibit
automatic single-page/instruction-shortening retries of these unchanged pages.
The existing missing-live-content failure remains terminal until the actual page
or approved requirement changes. No fabricated plan or narration bypass is used.

The budget counts only dispatched page-generation/delta calls, after current-state
validation. Visual-observation JSON retains its one format repair; planning retains
one repair of failed briefs. Terminal page failures are checked before additional
paid observations/planning. Source reads and PNG comparisons are local operations.
Accepted-script policies, external teaching edits, locks and native media retention
remain protected. The native adapter owns live SHA verification; legacy Host saves
still require the original source SHA.

The root-cause validation runs use deterministic provider stubs and real generation,
validation and native-adapter code. They establish callback ordering and request
counts, not live model quality or elapsed-time speedup. Raw historical rejected
plan/speech JSON was not retained, so the exact cause of every historical receipt
cannot be reconstructed.

This repair passes 172 desktop tests and 139 agent-runtime tests (311 total),
desktop TypeScript, agent-runtime TypeScript/bundle and the isolated production
desktop build. `git diff --check` also passes. Core source changes are in
`page-narration-candidate.ts`, `courseware-narration-batch.ts`,
`courseware-native-narration.ts`, `courseware-candidates.ts` and the native IPC
registration, with matching tool/skill guidance and regression coverage.

Validation logs for this repair: `/tmp/part-a-root-fix-main-tests.log`,
`/tmp/part-a-root-fix-agent-tests.log`, `/tmp/part-a-root-fix-typecheck.log`,
`/tmp/part-a-root-fix-runtime-build.log`, `/tmp/part-a-root-fix-runtime-bundle.log`
and `/tmp/part-a-root-fix-desktop-build.log`. Desktop output is isolated under
`/tmp/part-a-root-fix-build-20261111`, preserving the running client's Main chunks.
No live client/provider session is restarted or changed. A normal development
startup must rebuild/load the new desktop code before live acceptance.
