# Explicit failed-media retries and MAIC layer parity

Date: 2026-11-01. Desktop worktree: `courseware-par-A`.
Gateway worktree: `llm-ha-worktrees/courseware-image-gateway`.

## Behavior

An explicit user request to retry specific failed pages or media now has a real
new-attempt path. It is sufficient authorization for those targets after an
earlier user stop. Plan approval and first-page visual-master approval remain
human decisions. Status-only requests and automatic continuation remain read-only
recovery of submitted jobs.

`courseware_scene_image_refresh` and single-intent `courseware_media_refresh`
accept `retryFailed:true`. Main verifies an authenticated terminal failure
(`failed`, `cancelled`, or `archive_failed`) and finalized accounting. Released
orders require zero actual points; settled orders require a nonnegative integer.
Running, unknown, successful, and financially unresolved jobs cannot be retried
through this flag. Current source/plan, selected reference, account, page lock,
and dispatch checks continue to apply.

The existing Host journals retain the original request and receipt. A successor
ID is derived from its original intent ID, with a fresh submission key. Repeated
delivery of the same retry therefore reuses that successor, including after a
restart. A later explicitly requested attempt can follow a failed successor.
Active workflow reads exclude superseded attempts while preserving history.
Music export retry retains the successful generation and candidate.

Continuation reconciles the requested retry jobs without starting unrelated
missing media or compilation. Input arriving during terminal reporting is left
for a new turn, where the terminal tool guard resets. The tool descriptions and
scene-authoring skill distinguish this explicit path from automatic recovery.

## Layer prompt and parameters

The reference is MAIC commit `367d22bc`, specifically
`lib/media/adapters/seedream-layer-adapter.ts` and
`lib/generation/kindergarten/image2-pptist/runtime-tools.ts`.

The Desktop prompt is byte-for-byte equal to `SEEDREAM_LAYER_PROMPT`: separate
editable teaching subjects, props, text and whole text carriers; retain the
environment and decoration in the base plate. Decomposition no longer appends
agent-provided instructions. Retrying a legacy decomposition uses this canonical
prompt in the successor while retaining the legacy request and receipt.

The gateway sends the following provider parameters:

| Field | Value |
| --- | --- |
| model | Server-configured Seedream model; MAIC default is `doubao-seedream-5-0-pro-260628` |
| prompt | Canonical MAIC decomposition prompt |
| image | Original-resolution JPEG data URL, quality 95 |
| layer_decomposition | `true` |
| size | `2K` |
| output_format | `png` |
| response_format | `url` |
| watermark | `false` |

The gateway performs the JPEG conversion after validating the original reference
hash, preserving the financial request identity and original archived master.
It uses the `image` codec with only JPEG/PNG enabled and bounded decoder memory
and dimensions. Existing layer bytes and bounds remain intact. Supplier model
selection and credentials remain server-owned. This change does not add
automatic paid POST retries.

## Validation and limits

The initial regression reproduced the missing retry path. Separate red tests
also reproduced extra decomposition instructions and non-JPEG provider input.
All validation uses local fixtures rather than paid providers.

- Final focused Main workflow/image/media suite: 108 passed.
- Final focused Runtime/tool suite: 44 passed.
- Agent Host queue and steering suite: 65 passed.
- Desktop and Runtime TypeScript checks and Runtime build passed.
- Renderer workspace gate passed, including both human review steps.
- Gateway courseware suite: 14 passed, including the actual local HTTP provider
  payload, decoded input dimensions, layer output bounds, and existing billing.
- Host retry tests verify restart idempotence, original receipts, normal prepare
  reuse, and legacy layer prompt migration.
- The full provider-free courseware gate passed: Main/Host 427, shared 27,
  Runtime 433, and Host contracts 254 passed. Two pre-existing Host tests remain
  ignored because they require a real compiler locked-images fixture or the
  installed-worker portable-audio setup. The final focused Main suite above
  additionally includes two tests added after this full gate started.

Full gate evidence: `/tmp/deckwise-workflow-gate-sifY8o/report.json`;
`providerCalls` is zero. The focused suites overlap the full gate.

Detailed logs are under `/tmp/deckwise-explicit-retry-fix-20261101/`.

These are local source changes. Desktop/Main/Host must load the updated build and
the gateway must deploy its updated adapter for full parity. Existing submitted
requests are immutable. No real retry of pages 1/7/9 was purchased, and the
supplier's previous HTTP 400 cannot be declared resolved without a real attempt.
Matching request parameters does not guarantee identical model output.
