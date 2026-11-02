# Plan 006: Gate the repaired workflow with cross-layer contract tests

> Implemented and locally verified on 2026-11-01. See the [delivery evidence](../docs/spec/06-delivery/2026-11-01-scene-workflow-repairs.md) and [gate report](validation-report.json).
> Native editor/player and live-provider acceptance are separate, unperformed checks.
> Work only in /home/jhz/code/train/deckwise-desktop-worktrees/courseware-par-A,
> branch feat/courseware-par-A. Preserve existing edits; do not create another
> worktree, commit, publish, or call paid services without an execution instruction.

## Baseline and drift

Planned against HEAD `1ff749805` on 2026-10-31 **including the existing dirty
working tree** (204 status entries before plan creation). HEAD alone is not the
implementation baseline. `plans/baseline.json` contains the SHA-256 of each
existing scoped file and records proposed new files as absent.

Before implementation, run `git status --short` and compare the scoped files with
that manifest. Changes made by declared predecessor plans are expected; review
their diff and carry their invariants forward. Stop on unexplained drift instead
of overwriting it. Follow applicable AGENTS.md. Code, tests and repository docs
remain English. Update this plan's status in `plans/README.md` only with evidence.

All commands below run from the worktree root. No dependency installation or
database cleanup is required. Build outputs may go only to ordinary ignored
build directories. Real Host tests must use temporary profiles/workspaces and
the freshly built Host, never the user's Desktop profile.


## Status

- Implementation: DONE; verification and remaining coverage are recorded in the delivery evidence.

- Priority: P1 release gate; Effort: M-L; fix risk: LOW-MED
- Depends on: 001-004 for bug repair acceptance; include 005 for required-video coverage
- Category: tests / delivery
- Result: passing isolated unit tests cannot hide incompatible Main/Runtime/Host
  state transitions in the repaired paths.

## Why this is necessary

The preceding audit ran 54 existing targeted tests successfully while isolated
reproductions still found image polling, concurrent status writes, immutable
speech repair and question-acceptance gaps. Main narration tests replace Host
save with direct action assignment. Several real Host tests are env-gated and
skip by default. The existing scene-completion Electron script tests transport/
compiler operations, not the entire required teaching and recovery contract.

Keep useful unit tests. Add the missing adjacent real boundaries and make the
release gate explicitly execute them with fresh binaries.

## Existing patterns and scope

Reuse:
- `scripts/e2e/host.mjs`: temporary-profile Host process/RPC.
- `apps/desktop/test/fixtures/courseware-media-loader.mjs`: actual media clients.
- `apps/desktop/test/courseware-media-scope-integration.test.mjs`: Main + Host +
  loopback HTTP, strict submission counts and restart.
- `apps/desktop/test/courseware-canvas-music-host.test.mjs`: generation/export
  lifecycle with separate original identities.
- `apps/desktop/test/courseware-native-save.test.mjs`: verified native-save
  lineage and scope of the optional real WiseOffice fixture.
- `packages/agent-runtime/src/courseware-turn-continuation.test.ts`: real
  DesktopAgentRuntime with scripted external model results.

Permitted additions:
- `apps/desktop/test/courseware-workflow-contract.test.mjs`.
- Small fixtures/helpers under
  `apps/desktop/test/fixtures/courseware-workflow/`, only when reused or needed
  to cross a real boundary.
- `scripts/check-courseware-workflow.mjs`: one scoped gate runner.
- `package.json`: one `test:courseware-workflow` command.
- `.github/workflows/ci.yml`: invoke the scoped gate after required builds, with
  fresh Host availability; preserve unrelated jobs.
- Relevant preceding-plan tests, delivery E2E plan, changelog and plan statuses.

Do not add a separate test framework, call live providers, attach to the running
Desktop, rely on user files or use the user's database. Do not turn a critical
missing fixture into a passing skipped test.

## Test levels

1. Pure contract fixtures: TS/Rust requirement equality, status normalization,
   repair deltas and legal/illegal binding changes.
2. Real adjacent boundaries: canonical writer -> Main save -> actual Host
   validation; Main coordinator -> actual queue/client -> loopback provider ->
   actual Host journal; native save -> current-media context -> original recovery.
3. Runtime closure: scripted model uses the public tool adapters, attempts to
   finish early or rearm after a terminal report, while Host acceptance supplies
   actual completion state. Mock the model and supplier only.
4. Native editor/player checks remain a distinct isolated acceptance layer.
   Do not claim they were validated by a headless contract test.

## Contract fixture requirements

Use a small two-page lesson with stable logical IDs, a typed question, a song,
and (after 005) a required video. Include real tiny valid media fixtures for
archive/decode checks. Use public Host setup/import/prepare interfaces and the
existing generated source/identity fixtures; do not mutate SQLite from Node or
add production test-only RPC endpoints.

The fixture must retain all generated input/output artifacts in a temporary
workspace during the run and dispose them afterward. Every external request is
loopback or an injected transport stub; unexpected hosts fail immediately.
Coordinate asynchronous cases with barriers/fake clocks, not long sleeps.

If the parser/native-export toolchain is necessary for a particular boundary,
require its isolated fixture explicitly and report that coverage separately.
The minimal Headless gate must still run actual Host persistence/validation.
Do not fake Host acceptance just to avoid setup.

## Required scenarios

| Scenario | Required observable result |
|---|---|
| Approved plan, cover not confirmed | No later-page/layer paid submission |
| Queue saturated, quote expires | prepared, zero new POSTs, later authorized fresh-quote recovery |
| Request sent, response lost | Same original identity across restart; query only |
| Two status readers plus queue poll | No unreconciled stale-write conflict; no mass waiting failure |
| Pending music/video then valid save/reorder | Same order/slot binding, no replacement purchase |
| Saved video then valid save/export | Video bytes and references retained in portable output |
| One unknown image plus healthy image | Healthy job archives/adopts; blocked original retained |
| Unchanged image for ten simulated minutes | Blocked + one final report; no endless polling |
| Unknown video result | Same normalized blocked semantics as music/image |
| Initial speech with trailing spaces, then required repair | Speech/audio/effects byte-for-byte unchanged |
| Different question with identical response | Host completion remains false until corrected |
| Required video omitted by model | VIDEO_MISSING, bounded repair, then original adoption |
| Lost save reply | Read saved state; do not add duplicate actions |
| Completed with advisories, model tries another tool | Tool denied for that run; one agent_end |
| New user continuation | New authorized run can resume, preserving old orders and budgets |
| Status-only or PPTX-only request | No unintended teaching/media generation |
| Mixed-media load | Independent peaks <= TTS10/image5/layers5/music2/export2/video2 |

Test fresh, prepared, begun/unknown, submitted, archived and adopted stages where
they affect the specific scenario. Do not build a full Cartesian test explosion.

## Gate implementation and commands

Create a runner that resolves the freshly built local Host (never an installed
fallback), sets env vars for existing Host tests, runs the new contract test
and emits a JSON summary under an ignored output directory or a caller-selected
temporary directory. Required cases must show executed/pass counts, not skips.
The summary records mock POST counts, recovered originals, adoption counts,
maximum concurrency and terminal event counts. Never log tokens or signed
receipts.

```bash
pnpm --filter @pi-desktop/shared build
pnpm --filter @pi-desktop/agent-runtime build
cargo build -p host-core --locked
pnpm test:courseware-workflow
pnpm --filter @pi-desktop/desktop typecheck
cargo test -p host-core --locked db::courseware_projects::
cargo clippy -p host-core --all-targets --locked
```

The new command is added by this plan. It should use these existing env names:
`DECKWISE_E2E_MEDIA_SCOPE_HOST`, `DECKWISE_E2E_LOCAL_MEDIA_HOST`,
`DECKWISE_E2E_MUSIC_HOST`. The new test may share a clearly named
`DECKWISE_E2E_WORKFLOW_HOST`. Fail explicitly when the gate requests a mandatory
Host test but the selected binary is missing.

## Steps and verification

1. Establish current baseline and list each predecessor's new regression by
   name. Build shared/runtime/Host in that order.
   **Verify:** builds exit 0; existing scoped tests run. Record unrelated baseline
   failures separately without silently correcting or suppressing them.
2. Add real boundary tests and the strict gate runner. Start with dispatch,
   refresh and immutable narration; then add lineage and runtime closure cases.
   **Verify:** retain the pre-fix failing-test output captured by each preceding
   plan and show the same named case now passes. If red evidence is missing,
   report that gap and use a read-only baseline comparison; do not revert,
   reset or stash the user's worktree to manufacture it.
3. Add the CI invocation and ensure the command runs without user-specific paths,
   credentials or application state. Reuse the current JS job and existing Rust
   toolchain/cache setup patterns to build Host in the same checkout before the
   gate; a binary built in the separate Rust job is not automatically available.
   **Verify:** `pnpm test:courseware-workflow` exits 0, every mandatory case runs,
   mock POST counts and concurrency bounds meet the table.
4. Run the scoped broad checks once after integration. Update delivery evidence
   and mark only genuinely completed plans DONE.
   **Verify:** all listed commands pass or retain an explicit release blocker.
   The previous audit reported unrelated docs-link build failures and existing
   whole-tree Rust formatting differences; recheck their current status before
   release, do not describe narrower tests as a full clean build.

## Later live acceptance

After local fixes and gates pass, an explicitly authorized live rerun may reuse
the original source/grade/settings and ten-page limit. It must report real
elapsed time, original vs new submissions, automatic recoveries, manual
interventions, per-type peak concurrency and remaining Host requirements.
Start with one bounded run, not repeated paid experiments.

Server-side original TTS recovery HTTP 500 is a separate unresolved dependency.
Record the original intent/error and diagnose that service independently;
client fixes do not prove supplier availability or reconstruct missing audio.

## Done criteria and STOP conditions

- The single gate runs the required real Host cases without silent skips.
- Cross-boundary failure cases prove invariants, not just prompt wording.
- No live credentials, user profile or paid services are required.
- CI and local command use the same implementation tree and current Host build.
- Delivery distinguishes source/unit/contract/native-player/live-provider evidence.

Stop if a necessary native fixture is unavailable, if a test requires actual paid
generation, or if setup would write into a user's database. Report the missing
coverage instead of replacing authority checks with mocks.

## Maintenance

New media types and new required teaching fields must add one producer-consumer
contract case and relevant interruption/binding cases. A new status-only reader
must also be safe to run concurrently with existing queue polling.
