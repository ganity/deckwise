# Generation concurrency and blocker review (2026-10-30)

Worktree: `deckwise-desktop-worktrees/courseware-par-A`.
Branch: `feat/courseware-par-A`. No additional worktree was created.

## Changes in this pass

Generation now has independent per-principal, per-type FIFO limits in Main:
TTS 8, image 5, image layers 5, music collection 2, music export 2, video 2.
`COURSEWARE_GENERATION_LIMITS` is the single source for these defaults. These
values protect the client; supplier quota information has not been established.
An accepted asynchronous task retains its slot until a terminal status is read.
Read-only catalog, quote, status and asset operations do not acquire slots.

The mixed-media regression failed with the old shared queue: TTS occupied all
five slots and every other type submitted zero jobs. It now verifies all six
types reach their own limits, retain pending slots and resume queued work.

A second reproduced defect affected local relay recovery. Replaying the same
unknown music receipt allocated another slot; with two slots, a later replay
failed with `COURSEWARE_MEDIA_GENERATION_STATUS_UNKNOWN` before reaching its
saved request validation. Local receipts are now checked before joining the
generation queue. Key/hash, kind, project, account, cancellation and coordinator
checks remain enforced. Concurrent first submissions retain the Host journal's
revision claim. Replaying an uncertain receipt never repeats its paid POST.

## Historical blockers and disposition

Existing fixes listed below were already present in this worktree; this pass
does not claim them as new edits. Original recovery evidence is recorded in
`2026-10-29-greetings-task-recovery.md`.

| Blocker | Classification | Current disposition |
| --- | --- | --- |
| Shared five-slot limit lets slow image/music work hold up TTS | Client scheduling defect | Changed to independent limits in this pass. |
| Replaying one local receipt consumes extra generation capacity | Client recovery defect | Reproduced and fixed in this pass; no duplicate paid submission. |
| Aggregate selected-asset and 32 MiB scene compiler ceilings reject otherwise valid decks | Product limit/implementation mismatch | Earlier source changes removed the aggregate ceilings; the compiler regression exceeding 32 MiB passes. Per-file integrity and applicable archive bounds remain. |
| Runtime executes an old staged compiler despite fixed source | Build/deployment mismatch | Earlier recovery rebuilt and staged the worker. Current staged bundle integrity verifies 155 files; integrity alone does not prove freshness against every source edit. |
| Metadata reads fetch the full, image-heavy conversation | Programmatic performance defect | Existing Main/auth/saved-narration paths use `messageLimit: 1`; explicit conversation-context requests still retain their history. |
| Main narration adapter omits the canonical output schema; subset retries narrow the full outline | Programmatic adapter/retry defect | Existing schema forwarding and whole-deck/missing-page retry handling remain; covered by Desktop narration regressions. |
| Focus splitting leaves punctuation-only speech actions | Programmatic text segmentation defect | Existing splitter appends trailing punctuation to the preceding speech; narration regressions pass. Historical saved actions needed revision-checked cleanup. |
| Automatic continuation ends on an assistant prefix or tool parameters have a non-object root | Provider protocol integration defect | Existing continuation user anchor and object-root schema projections remain; transcript payload regressions pass. |
| One generic message conflates changed Chat, replaced Host and ended turn | Diagnostic defect plus valid ownership protection | Existing diagnostics distinguish the guards. A new authorized turn in the owning Chat may continue; scope checks must not be bypassed. |

## External outcomes and remaining boundaries

- Transport timeout or `46016` does not establish whether a paid supplier job
  started. Preserve the original key/receipt and use read-only reconciliation;
  creating a new paid job is not a safe automatic recovery. A lost local receipt
  may require server/supplier reconciliation that Desktop cannot invent.
- `46001` on a video catalog is a model/configuration issue, not evidence of a
  concurrency defect. The historical video slot was not required by the user or
  approved plan and was removed with revision checks, without purchasing video.
- Network/provider outages, balances and account permissions are not repaired
  by changing client concurrency. No supplier quota or outage cause is inferred
  from the client logs alone.
- Limits apply within one Desktop process and authentication lifetime. Other
  instances, restarts and internal supplier fan-out require server scheduling
  for a fleet-wide guarantee. Unknown jobs retain capacity only in their type.
- This pass changes code and fixtures only. It does not regenerate a course,
  make paid supplier calls, restart the running Desktop or replace its bundle.

## Validation

Results: 1,224 Desktop courseware tests passed, 10 skipped; 51 targeted agent
runtime tests and 62 authoring tests passed. Desktop TypeScript passed. The
staged worker integrity check verified 155 files. No test failed.

Commands run in this worktree:

- `node --test apps/desktop/test/courseware-*.test.mjs`
- `pnpm -C apps/desktop typecheck`
- `pnpm -C packages/agent-runtime exec vitest run src/courseware/narration-write.test.ts src/courseware-turn-continuation.test.ts src/courseware-workflow-tools.test.ts src/courseware-quality-continuation.test.ts`
- `pnpm -C packages/agent-runtime exec vitest run src/transcript-payload.test.ts`
- `pnpm -C packages/courseware-runtime exec vitest run src/authoring/tests/kindergarten/scene-to-pptx.test.ts src/authoring/tests/kindergarten/scenes-to-pptx.test.ts`
- `pnpm -C apps/desktop check:pptx-worker`

These are local regression, type and artifact checks. Skipped Electron/provider
checks and full paid generation remain outside this validation claim.
