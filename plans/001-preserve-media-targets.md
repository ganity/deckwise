# Plan 001: Preserve original music and video across verified PPT saves

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

- Priority: P1
- Effort: L; fix risk: MED
- Confidence: HIGH, confirmed current code paths; no live-save reproduction claimed
- Depends on: none
- Category: bug / persistence compatibility
- Result: a verified save or page reorder preserves the original order and its
  association with the unchanged logical teaching action.

## Why this matters

Pending music uses source-hash/page-number draft names as identity. Video binds
directly to its original source. A normal PPT save can hide these orders from
recovery and allow preparation of another order for the same slot. Adopted video
can also become unavailable to portable export. The original supplier request
and the current editable target need distinct identities, as TTS already has.

## Current state and existing patterns

- `apps/desktop/electron/main/courseware-saved-media.ts:62`:
  `tracks.filter(t => t.draft.id.startsWith(musicPrefix(project.source.sha256, index + 1)))`.
  Lines 134-137 repeat that source/page prefix for prepare deduplication.
- `crates/host-core/src/db/courseware_projects/native_save.rs:342` commits:
  `rebind_courseware_review_audio(...)`, `rebind_native_save_tts(...)`,
  `rebind_native_workflow(...)`. Pending music/video are absent.
- `crates/host-core/src/db/courseware_projects/video.rs:189` requires original
  source revision/hash in `Intent::matches`; prepare creates a UUID when no
  matching intent remains.
- Exemplar: `tts.rs::rebind_native_save_tts` updates optional `bound_source`
  inside the native-save transaction, only for an unchanged logical speech.
- Music generation/export intents live in
  `rpc/courseware_projects/media_canvas/music.rs`; adopted music receipts live
  in `db/courseware_projects/music.rs`. These are different records.
- ADR `docs/adr/courseware-bounded-recovery.md` requires retaining uncertain
  original paid requests and prohibits silent replacement purchases.

## Scope

Existing implementation files:
- `apps/desktop/electron/main/courseware-saved-media.ts`
- `apps/desktop/electron/main/courseware-saved-video.ts`
- `apps/desktop/electron/main/courseware-canvas-music.ts`
- `packages/shared/src/courseware-canvas-music.ts`
- `crates/host-core/src/db/courseware_projects/music.rs`
- `crates/host-core/src/db/courseware_projects/video.rs`
- `crates/host-core/src/db/courseware_projects/native_save.rs`
- `crates/host-core/src/db/courseware_projects/portable.rs`
- `crates/host-core/src/rpc/courseware_projects/video.rs`
- `crates/host-core/src/rpc/courseware_projects/media_canvas/music.rs`
- `crates/host-core/src/rpc/courseware_projects/media_canvas/music/adoption.rs`

Tests: `apps/desktop/test/courseware-saved-media.test.mjs`,
`courseware-canvas-music.test.mjs`, `courseware-native-save.test.mjs`,
`courseware-canvas-music-host.test.mjs`;
Host `native_save/tests.rs`, `video/tests.rs` and
`rpc/courseware_projects/media_canvas/music/tests.rs`.

Docs: `docs/adr/courseware-bounded-recovery.md`,
`docs/spec/03-runtime/27-courseware-authorized-media.md`,
`docs/spec/03-runtime/29-courseware-chat-workflow.md`,
`docs/spec/06-delivery/04-e2e-test-plan.md`, `CHANGELOG.md`.
A new ADR for the persistent target binding is allowed under `docs/adr/`.

Out of scope: provider/accounting records, old request hashes, automatic
repurchases, generic project identity rewrites, UI redesign, global scheduling.

## Design and compatibility

1. Keep supplier identity immutable: intent ID, idempotency key, request hash,
   request body, parent export relation and original submission account.
2. Use logical project/page/action identity for saved music targets. Persist a
   Host-validated optional target binding on the generation intent; exports
   inherit or resolve it through their original generation intent. Target
   validation reads the actual saved slot, rather than trusting a caller's page
   number. Preserve the slot's baseline prompt separately from the supplier
   request, since those texts need not be identical.
3. Add optional current-source binding for video following the TTS pattern.
   Original source remains available for provenance. Use the effective current
   binding consistently in context, prepare dedup, refresh, adoption, asset
   reads and portable export.
4. Change bindings only in the verified native-save transaction. Match the
   logical page/action, original slot content or adopted asset, and the old
   effective source. Reordering does not change identity. Duplicating a page
   does not copy a pending paid order to the new logical action.
5. For legacy automatic music drafts, derive a binding only when the retained
   source/page/slot-hash metadata and verified lineage yield one exact target.
   Ambiguous matches remain explicitly blocked and queryable; they must not
   disappear or authorize a new order. Do not use substring-only matching as
   authority, and do not rename old drafts to simulate migration.
6. Define optional/default deserialization and persistence version behavior.
   New code must read existing journals. Determine whether the chosen durable
   representation needs a schema/version migration under repository policy;
   document and test it before writing production records. Do not assume old
   binaries can read newly extended deny-unknown-fields records. State any
   downgrade restriction explicitly; never delete fields/receipts to downgrade.

## Commands

```bash
pnpm --filter @pi-desktop/shared build
pnpm --filter @pi-desktop/agent-runtime build
pnpm --filter @pi-desktop/desktop typecheck
node --test apps/desktop/test/courseware-saved-media.test.mjs apps/desktop/test/courseware-canvas-music.test.mjs apps/desktop/test/courseware-native-save.test.mjs
cargo test -p host-core --locked db::courseware_projects::native_save::
cargo test -p host-core --locked db::courseware_projects::video::
cargo test -p host-core --locked rpc::courseware_projects::media_canvas::music::
```

Success: exit 0; new named regressions run and pass. An environment-gated skipped
test is not evidence of a passing integration path.

## Steps and verification

1. Add failing regressions for pending/unknown music, pending/unknown video and
   adopted video across a verified save and reorder. Assert original identities
   and export-parent identity before/after. Include a separate changed-slot case.
   **Verify:** run the scoped Node and Rust tests above; new regression failures
   must describe the lost binding or duplicate intent, not a fixture setup error.
2. Implement/validate the music target and video effective-source representation.
   Keep existing canvas-only music requests valid when no saved target is supplied.
   Make duplicate prepare resolve the original target even if its source hash
   or display page number changed. Reject stale/changed targets rather than
   silently attaching old media.
   **Verify:** shared build, Desktop typecheck and Host music/video tests pass.
3. Add atomic native-save rebinding and legacy resolution. Roll back on a failed
   transaction or invalid attempted binding update; do not partially commit.
   A deleted/changed slot or ambiguous legacy target keeps its original request
   explicitly blocked and queryable, without independently rejecting an otherwise
   valid save. Update saved-media context and all video consumers to use the
   same binding.
   **Verify:** native-save tests and saved-media tests pass; portable-copy tests
   inside the scoped Rust modules prove adopted video bytes remain referenced.
4. Verify restart and compatibility with real Host storage using the existing
   music Host fixture, extending it with saved-target cases where appropriate.
   **Verify:** `cargo build -p host-core --locked`, then
   `DECKWISE_E2E_MUSIC_HOST="$PWD/target/debug/pi-desktop-host-core" node --test apps/desktop/test/courseware-canvas-music-host.test.mjs`
   passes with zero skipped top-level integration cases. Update ADR/specs.

## Required regression assertions

- Same order/key/hash after two valid saves, a restart and page reorder.
- Context still exposes every unfinished original with its current action ID.
- Repeated prepare after the save makes zero additional mock supplier POSTs.
- Music export still references its original candidate/generation order.
- Adopted video can be read and included in a portable copy after save.
- Changed prompt, deleted action, foreign source and ambiguous legacy target do
  not acquire a binding or cause an automatic replacement order.
- Failed save rolls back all binding updates; existing TTS behavior is preserved.

## Done criteria and STOP conditions

Done only when the commands and assertions above pass, old fixtures still load,
and the persistent-format/downgrade behavior is documented. Report the exact
test counts, any skips and the task diff; preserve the original dirty baseline.

Stop and report if verified lineage cannot identify the old target uniquely,
if implementation requires weakening source/account checks, or if a required
storage migration lies outside this scope. A missing order is not proof of a
safe paid replay. Do not fix this by deleting the source checks.

## Maintenance

Every new media kind must define original-request identity separately from
editable target binding. Review native-save, restart, duplicate/reorder and
portable-export consumers together whenever that binding changes.
