# Native retry lifecycle and trusted field diagnostics

## Outcome

Fixed the three reproduced local defects while preserving existing validation,
source/owner guards, retry ceilings and paid media identity:

1. Native narration's three-attempt budget survives coordinator/editor
   reconstruction in the same turn through the existing Host repair KV store.
   Attempt reservation precedes narration dispatch. Stable content keys exclude
   transient editor IDs; ownership checks still require the current editor.
2. A malformed visual observation remains a visual-stage failure on subsequent
   calls, instead of being reported as narration exhaustion with zero narration
   calls. Planning and content failures also retain their specific stage/code.
3. Local schema-owned field hints survive continuation wrapping. Raw provider or
   Host messages and forged hint properties cannot become trusted diagnostics.

The Host's additive `narration` field shares revision CAS with required repair
failures. Guard-only writes preserve the budget. After generation, the native
caller rereads the record and verifies unchanged semantic failures before
clearing a saved repair. This avoids rejecting a successful repair solely
because its own attempt reservation advanced the shared revision.

## Reproduction and verification

Before repair, the audit reproduced narration calls increasing from 3 to 6
within the same turn after coordinator reconstruction, a two-observation format
failure followed by false narration exhaustion at zero attempts, and loss of
`/instruction is required` from automatic correction guidance. Added regressions
also went red for the visual code and wrapped field diagnostic before fixing.

| Check | Result |
| --- | --- |
| Runtime tool/recovery/error/continuation/finishTurn suites | 538 passed |
| Final focused Runtime rerun after story-diagnostic completion | 118 passed (subset) |
| Desktop narration/native repair/router/content review/save suites | 261 passed, 2 optional fixture tests skipped |
| Rust Host repair-state database reopen/CAS/isolation regression | 1 passed |
| Release Host RPC with actual process restart | Passed |
| Runtime TypeScript build and sidecar bundle | Passed |
| Desktop TypeScript and production build | Passed |
| Host release build | Passed |
| Changed Rust formatting and final diff whitespace check | Passed |

The three-route fixtures assert that the same turn cannot renew exhausted calls
even with a new editor instance ID, while a new explicit turn gets a fresh
bounded budget. They assert reservations before model work, preserved required
failure records, and no extra narration during repeat calls. Additional checks
cover storage failure, cancellation during reservation, semantic repair/save
failure, successful peer preservation and actual-content changes.

The real Host RPC harness copies an existing PPTX into an isolated task's import
directory, writes visual-stage and exhausted narration records, stops/starts the
release Host, verifies exact readback, rejects stale CAS and clears a semantic
guard without deleting budgets. It does not open the PPTX in the native editor.
An initial ad hoc harness used the wrong import directory and was rejected;
correcting the fixture to `.deckwise-ppt/imports` produced the recorded pass.
No product path guard was relaxed to make this test pass.

Run from the repository root:

```sh
node plans/009-evidence/2026-11-18-retry-lifecycle/host-rpc.mjs /absolute/path/to/existing.pptx
```

The harness cleans up its own temporary profile/process. It neither uses login
credentials nor invokes a paid provider. The two skipped native-save tests need
`DECKWISE_NATIVE_SAVE_FIXTURE` (SDK lineage/original/first/second files) and
`DECKWISE_NATIVE_REAL_FIXTURE` (original/native pair). Those dedicated fixture
sets were not supplied; an arbitrary generated PPTX cannot substitute for them.

## Delivery and limits

Desktop, Runtime and Host are built locally and must ship together. Existing
records without narration budgets remain readable; old Hosts cannot accept new
budget writes and must not be paired with the new Desktop. Vite retains its
existing large-chunk warning. HEAD and locally recorded origin/main remain
`5cbd7cb44de14d6cb5f1e478ff9f57b63bd7d05d`; the workspace includes earlier changes.
Source/binary hashes identify this local candidate, not a new commit or release.
No remote refresh, commit, push, merge, publication or user-app restart occurred.

No fresh paid three-route lesson, real-model region selection, or full Electron
crash/reopen journey was performed. Existing failed paid runs remain unchanged.
The visual/planning format loops keep their existing local bounds; terminal
failures are durable, but an interruption before recording a visual terminal
result is not a durably counted vision request. Narration reserves before each
call, so an interruption between reservation and dispatch can conservatively
consume an unused attempt. Agent input-correction counters are separate and
remain runtime-local. P1/P7 broader qualification remains open.
