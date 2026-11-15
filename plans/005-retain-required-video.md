# Plan 005: Retain required video from approved plan through completion

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

- Priority: P2 capability completion; promote only when a task explicitly requires video
- Effort: M-L; fix risk: MED
- Confidence: HIGH documented gap, not a newly introduced regression
- Depends on: 001, 003, 004
- Category: feature / contract compatibility
- Result: a required video cannot silently disappear when narration omits its slot.

## Current state and constraints

- `packages/shared/src/courseware-scene-teaching.ts` permits question and
  music, with no video field. Rust `scene_teaching.rs::Teaching` mirrors it.
- Planner `courseware-scene-plan.ts:76` places video intent in free text.
- Skill step 8 promises completion of approved required video.
- Host workflow detects existing video_slot but cannot detect an omitted slot.
- `docs/spec/03-runtime/29-courseware-chat-workflow.md:435-436` explicitly
  documents that free-text video intent is not a structured requirement.
- Existing capability is one five-second silent clip per generated slot.
  Preserve that limit; this plan adds no provider, duration menu or renderer.

## Scope

- `packages/shared/src/courseware-scene-teaching.ts`, corresponding tests/
  cross-language fixtures from 004, and `courseware-teaching-quality.ts`.
- `apps/desktop/electron/main/courseware-scene-plan.ts`,
  `courseware-scene-deck.ts`, `courseware-saved-narration.ts`,
  `courseware-narration-batch.ts`.
- `packages/agent-runtime/src/courseware/page-narration-candidate.ts`,
  `courseware/narration-write.ts`, `courseware-turn-continuation.ts`.
- Host `db/courseware_projects/scene_teaching.rs`, `scene_objects.rs`,
  `candidates.rs`, `workflow.rs`;
  `rpc/courseware_projects/scene_plan.rs`.
- Existing scene-plan, saved-narration, saved-media, narration-write, workflow,
  quality and Host scene/portable tests.
- Scene skill, specs 24/27/29, E2E plan, changelog and an ADR for the contract
  extension under `docs/adr/`.

Out of scope: automatic publishing, extending video duration, automatic grading,
inferring old free-text promises, retroactively rewriting approved plan hashes,
or forbidding every legacy video when no new metadata exists.

## Proposed minimal requirement shape

```json
{
  "video": {
    "purpose": "Show the greeting gesture",
    "prompt": "A five-second silent demonstration of the approved character waving."
  }
}
```

This is an optional field on teaching, parallel to music. Presence means the
page requires one video; absence retains existing behavior. Suggested bounds
match nearby fields: nonempty purpose <=500 characters, prompt <=4000, strict
keys. Fixed five-second duration remains the existing generation contract.

No mandatory migration of legacy plans. New readers accept old records. Preserve
old canonical hash output when video is absent; adding/changing required video
changes the page/plan hash and requires the existing plan approval transition.
Explicitly document that an older strict parser may not read new video-bearing
metadata; do not silently drop it or promise transparent downgrade.

## Pipeline behavior

1. Planning writes structured video only when actually required.
2. TS and Rust validators accept the same shape and bounds.
3. Compilation retains teaching.video in the logical-page mapping.
4. Narration creates a video_slot; missing slots can be inserted through the
   bounded required-action repair from 004 without altering speech.
5. Completion emits VIDEO_MISSING if there is a retained requirement but no
   matching video action; VIDEO_PENDING remains for an existing unresolved slot.
6. Successful completion requires the adopted clip's original target/receipt to
   match the saved required action. Use the binding from 001, not the existence
   of any unrelated video_clip on the page.
7. Runtime recognizes the missing requirement, repairs at most twice, and uses
   existing configured video generation/recovery. A missing model is a blocker,
   never permission to silently omit the requirement.

## Commands

```bash
pnpm --filter @pi-desktop/shared exec vitest run src/courseware-scene-teaching.test.ts src/courseware-teaching-quality.test.ts
pnpm --filter @pi-desktop/shared build
pnpm --filter @pi-desktop/agent-runtime exec vitest run src/courseware/narration-write.test.ts src/courseware-workflow-recovery.test.ts src/courseware-quality-continuation.test.ts
pnpm --filter @pi-desktop/agent-runtime build
node --test apps/desktop/test/courseware-scene-plan.test.mjs apps/desktop/test/courseware-saved-narration.test.mjs apps/desktop/test/courseware-saved-media.test.mjs
cargo test -p host-core --locked db::courseware_projects::
cargo test -p host-core --locked rpc::courseware_projects::scene_plan::
pnpm --filter @pi-desktop/desktop typecheck
```

## Steps and verification

1. Add cross-language fixtures for absence, valid video, invalid keys/bounds,
   and legacy metadata. Capture unchanged legacy plan hash fixtures.
   **Verify:** new positive-video schema tests fail on the old code; existing
   legacy/hash fixtures pass.
2. Extend validators, canonical plan parsing/hashing and retained mapping. Update
   the planning prompt and the actual skill JSON example.
   **Verify:** shared/Host parser tests agree and the skill example passes the
   production Main parser; absent-video old hashes remain identical.
3. Extend missing-action repair and Host acceptance with the required video
   semantics. Add VIDEO_MISSING to the existing repair classification without
   treating adopted-but-unrelated video as satisfaction.
   **Verify:** omitted slot keeps ready false, repair preserves all speech and
   audio, original adopted clip makes the requirement satisfied.
4. Verify save/reorder/restart and portable copy using 001's bindings.
   **Verify:** all listed tests pass; the Plan 006 contract scenario includes a
   required video omitted once by the model, then successfully repaired.
5. Update ADR, capability statements and old documented limitation.
   **Verify:** cross-layer fixtures and the skill parser test pass; report the
   new format's upgrade/downgrade behavior.

## Done criteria and STOP conditions

Done only when a required video omitted from model output is detected, repaired
or explicitly blocked, never reported complete. Old plans remain readable and
retain their approval hashes. No paid media is regenerated to insert the slot.

Stop if the existing saved target cannot prove which adopted video satisfies the
requirement; finish 001 before proceeding. If a format version or additional
migration is needed, specify/test it explicitly. Do not infer required media by
searching arbitrary prose.

## Maintenance

Every new retained requirement must have matching schema, hash, mapping,
producer, repair, acceptance and compatibility tests. Keep the skill example
executable as a contract fixture.
