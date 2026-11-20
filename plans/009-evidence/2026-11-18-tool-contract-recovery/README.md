# Tool-contract recovery — local verification

Scope: follow up on observed wrong-directory, contradictory-flag, stale-version
and non-Quiz scope failures. Preserve the current education workflow, approval,
media identity, saved-content validation and correction limits.

## Changes

- Workflow context returns absolute workspace/project/draft paths, including
  before a Scene plan exists. Runtime states the effective tool root separately
  from scratch storage. Scene and PPT skills consume these paths directly.
- Image-refresh schema rejects mutually exclusive true flags before dispatch,
  matching Main. All 16 combinations and explicit false flags are checked.
- First-master reference, stale PPTX source hash and invalid assessment scope
  now have specific error codes. Assessment context enumerates configurable
  Quiz IDs; the native text-only fallback returns no configurable IDs.
- Known automatic-continuation input failures return static correction guidance
  to the model, at most twice per operation per runtime turn. They do not trigger
  an automatic replay of the failed write or a provider/model-request retry.
  Paid originals, unknown outcomes, cancellation and report-only guards remain.
- Final failures retain safe explanations without private payloads. Duplicate
  workflow-related on-demand tool names are removed from activation results.

## Validation

The initial regression reproduced three runtime contract/recovery failures and
one missing first-draft path failure before implementation. Final local checks:

- 537 Runtime tests passed across tool schemas, recovery, continuation,
  error mapping and the actual runtime finishTurn bridge. The bridge uses a
  fixture Host, proves two correction opportunities followed by a terminal
  failure, and verifies that private failure payloads do not reach guidance.
- 167 Desktop tests passed across workflow paths/guards, assessment scope,
  Scene images, native tools, PPT Master skill and Python runtime contracts.
- Shared package build, Runtime TypeScript build/bundle, Desktop typecheck and
  Desktop production build passed. Vite retains its large-chunk warning.
- After the final guidance wording changes, 91 recovery/error tests and 10 skill
  contract tests passed again; these are subsets, not additional unique tests.
- Final `git diff --check` passed. No application was restarted.

Commands and final build evidence are recorded alongside this file. This
worktree already contains earlier task changes; the source hashes identify the
combined local candidate, not a new isolated commit. HEAD and locally recorded
origin/main are both `5cbd7cb44de14d6cb5f1e478ff9f57b63bd7d05d`;
no remote refresh, commit, push, merge or publication was performed here.

## Limits

No fresh paid LLM/image/TTS generation or desktop GUI run was performed in this
round. Fixture failures prove error routing and bounds, not that a real model
will choose correct repairs or that all three generation routes now succeed.
Earlier failed paid runs remain failed evidence. Large prompts, malformed model
observation output, Master drawing efficiency and broader autonomous quality
remain outside this narrow repair. P1/P7 are not closed by these checks.

The input correction counter is runtime-local and resets on a new turn/runtime;
it does not replace durable content-repair budgets or paid-job accounting.
