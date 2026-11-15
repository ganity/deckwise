# Courseware workflow: three local fixes

Date: 2026-11-01. Worktree: `courseware-par-A`.

The user confirmed that plan approval and first-page visual-master approval are
intentional human decisions. Both remain required. This change addresses the
three execution defects found in the [live-run report](2026-11-01-greetings-terminal-fix-metrics.md).

## 1. Planning repair budget

The continuation counted every failed automatic validation as another correction.
An initial invalid write, an unchanged explicit submit and a failed partial edit
could exhaust the budget before the model successfully corrected the draft.

The budget now advances after a successful detected draft modification following
validation failure. Repeated submit and failed edit do not consume it. Validation
feedback asks the model to preserve required fields and explicit requirements,
and to reread/rewrite after a failed partial edit. Two completed corrections that
still fail validation retain the existing bounded unfinished-report behavior.
Passing validation still leads to human review, never automatic approval.

## 2. Stop and Send now

Agent Host already delivers promoted input through steering. The renderer then
sent an obsolete graceful Stop, stopping the very turn that should answer that
input. Separately, tools left in the current assistant batch could still dispatch
after steering or Stop had arrived.

Send now now only prioritizes through Agent Host. Runtime fences remaining
old-batch calls while steering is pending, so the model receives the corrective
input before executing further calls from that reply. Existing delegates stay
alive and TaskWait retains its interruption semantics. Refused steering stays
queued for the next turn boundary.

Explicit Stop immediately fences Main dispatch before awaiting the sidecar.
Runtime also blocks subsequent tools. Graceful settlement remains completion,
with no abort claim, and the fence is scoped to the stopped turn and released on
teardown. Submitted jobs and their results are preserved. Requests already
dispatched to a supplier cannot be retracted by this fence.

## 3. Terminal image polling

Image list reads return saved journal rows without their transient task receipts.
The image panel replaced a failed receipt with a journal-only submitted row, then
queried the supplier again on every timer tick. The parent workflow also polled
aggregate status while Chat was idle.

The panel retains ready/failed/cancelled/archive-failed receipts across list
refreshes and skips supplier queries for them. Authentication changes clear the
receipt cache; stale responses cannot repopulate it. Pending jobs still refresh
after Chat completes, and local list reads still discover new jobs. The aggregate
workflow timer now runs only during an active Chat; messages and explicit refresh
still trigger reads. Explicit image-panel refresh may reread the original terminal
jobs once without restarting periodic supplier queries. No refresh submits generation.

## Verification

The new regression tests first reproduced premature planning exhaustion,
continued old-batch generation after Stop/steering, repeated terminal supplier
queries and idle aggregate polling against the previous implementation.

- Runtime and continuation regression: 381 passed.
- Agent Host promotion/steering/queue regression: 44 passed.
- Desktop UI, queue, session and settlement regression: 125 passed, none skipped.
- Runtime and Desktop TypeScript checks passed; Runtime build passed.
- Real renderer workspace gate passed all ten checks, including plan approval,
  cover adoption, pending assets, compiler state and editor handoff.
- Full provider-free courseware workflow gate passed: Main/Host 415, shared 27,
  Runtime 429 and Host contracts 251 tests passed. Host build passed. Two existing
  Rust tests remained ignored: one requires the real compiler's locked-images
  fixture, and one requires the installed-worker portable-audio setup. These were
  not counted as passes. Runtime's 381-test regression above overlaps this gate.

Full gate evidence: `/tmp/deckwise-workflow-gate-39JcXG/report.json`.

Evidence: `/tmp/deckwise-three-workflow-fixes-20261101/`. Tests use local fixtures;
no new paid model, image, layer, audio or music requests were submitted. This is
local source validation, not a packaged release or a new live-provider acceptance
run. It does not establish the cause or resolution of the supplier HTTP 400 layer
failures in the earlier run.
