# Courseware completion-report loop repair — 2026-11-01

## Scope and outcome

Recovered Codex session `01a195ce-9f67-7d12-aa17-6777d00aef3f` and continued
its latest request: diagnose and fix completion closure after the Greetings
rerun. Continued in its existing `feat/courseware-par-A` worktree at
`1ff749805a93702fac7e7e24b7a0dffc43adcb6f`, preserving the previous uncommitted
work. No commit, remote write, paid request or running-application restart.

The fix permits the existing workflow checkpoint RPCs through Main and makes
continuation-hook failures terminal local errors. Successful completion writes
its Host checkpoint, permits one final report, and ends the run. It does not
change saved lesson content, supplier submission policy or completion criteria.

## Confirmed cause

The [live rerun](2026-11-01-greetings-post-fix-live-rerun.md) reached Host-ready
at 08:56:10 UTC, then emitted fourteen completion reports before manual Stop.
Read-only inspection of the retained runtime confirmed that the updated
`finishTurn` and ready-result handling were loaded. Its continuation remained
active with no repair attempts or final-report fence, and no completed checkpoint.

Calling the existing checkpoint read through that runtime's Host facade returned
`-32601: host method not allowed from sidecar: courseware.workflow.get`.
Main's exact `HOST_PROXY_ALLOWED` list omitted both `courseware.workflow.get`
and `courseware.workflow.checkpoint`, although Runtime called them and Rust
already implemented and validated them.

That unmarked local RPC error escaped the continuation hook. Pi converted the
failed hook into an assistant failure; Runtime classified it as a retryable
provider error. Recovery removed the trailing assistant context and requested
another answer. Each successful answer reset the provider retry counter before
the hook failed again, so the nominal retry limit never bounded this loop.
This also prevented the existing advisory-repair and checkpoint paths from
running. The model's repeated reports were a consequence of repeated requests.

The real Runtime regression reproduced twelve model requests in ten simulated
seconds before the fix. With the same checkpoint denial, the fixed Runtime
stops after discovery and the first media-context request, emits one terminal
local error, and makes no recovery request.

## Changes

- `apps/desktop/electron/main/agent-sidecar.ts`: allow only the two missing
  workflow RPCs. Session/project/turn/source/revision validation remains in Host;
  other courseware methods and secret/configuration access stay denied.
- `packages/agent-runtime/src/runtime.ts`: mark continuation-hook failures as
  local request preparation failures, retaining existing explicit local errors
  and cancellation. They cannot enter provider retry recovery.
- Runtime regressions cover completed checkpoint persistence, exactly one final
  report, checkpoint-read/write failures, cancellation and idle settlement.
- Main proxy regression verifies unchanged forwarded parameters, Host denials
  and rejection of unlisted methods. The existing workflow integration now
  routes checkpoint RPCs through the actual Main dispatcher into a temporary
  real Rust Host, rather than calling Host directly. It asserts three model
  requests (discovery, media context, final report), one terminal event, no
  errors and a durable completed checkpoint.
- The provider-free workflow gate includes the proxy regression. The workflow
  spec and E2E scenarios document this boundary.

## Validation

Runtime and Desktop builds and typechecks passed. The seven targeted
Runtime suites passed 493 tests before the final two cancellation cases were
added; the final continuation suite passed all 28 tests, including those cases.
The Main proxy regression passed, and changed tracked files pass whitespace
checking. Biome's repository include list excludes these files; no Biome pass
is claimed.

`node scripts/check-courseware-workflow.mjs` passed with zero provider calls:

| Boundary | Passed | Skipped/ignored |
| --- | ---: | ---: |
| Main/Host workflow, including the proxy and joined completion regression | 415 | 0 |
| Shared contracts | 27 | 0 |
| Runtime workflow and lifecycle | 426 | 0 |
| Host project DB/RPC | 251 | 2 existing opt-in cases |

The ignored Host cases require the existing real locked-image and portable-parser
fixtures; they are not new exclusions. The mandatory joined completion case ran
successfully. Current Host build also passed. Evidence and per-stage logs:
`/tmp/deckwise-workflow-gate-v5qevn/report.json`. The gate retained concurrency
peaks TTS 10, image 5, layers 5, music 2, video 2 and export 2.

Desktop's production build reported its existing mixed DOMPurify import and
large-chunk warnings and exited successfully. No unrelated bundling changes.

## Limits

This is local task-worktree validation against existing uncommitted code, not a
fresh remote-main integration candidate, packaged release or new paid live run.
The running application still holds the old Main allowlist and Runtime closure;
it must load matching rebuilt components on restart. No hot patch was applied.
The historical lesson's focus advisory, bitmap lettering and other planning
findings were not changed by this completion-closure repair.
