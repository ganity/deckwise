# Plan 004: Repair missing requirements without regenerating saved speech

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

- Priority: P1; Effort: M-L; fix risk: MED
- Confidence: HIGH; normalization mismatch and wrong-question proposal reproduced
- Depends on: 003 for bounded repair/terminal behavior
- Category: bug / generated-content contract
- Result: required-question/music repairs preserve every existing speech and paid
  asset exactly; an unrelated question cannot satisfy an approved requirement.

## Current state

- `courseware-narration-batch.ts:196-207` sends repair mode through ordinary
  `generateNarrationWrite`, asking the model to repeat exact existing text.
- `page-narration-candidate.ts:9` uses `z.string().trim()`; line 89 applies
  focus segmentation; `narration-write.ts:81` segments speech again.
- A real normalizer round trip produces:
  initial `"Hello. Welcome!"` -> `["Hello. ", "Welcome!"]`;
  exact model echo during repair -> `["Hello.", "Welcome!"]`.
- Host `candidates.rs:141-143` correctly requires identical speech count,
  order and text. Its save lies outside Main's schema-correction loop.
- Host `workflow.rs:94-96` and `candidates.rs:144-172` compare question
  response but not question text. Shared quality inspection checks only kind.
- Existing test gap: `courseware-saved-narration.test.mjs` mocks Host save by
  replacing actions directly, so it cannot prove the real retention rule.
- Exemplar: `candidates.rs::repair_required_actions` preserves original actions
  byte-for-byte and inserts missing requirements at original speech anchors.
  Reuse that guarantee, not a weaker text comparison.

## Scope

- `apps/desktop/electron/main/courseware-narration-batch.ts`,
  `courseware-saved-narration.ts`.
- `packages/agent-runtime/src/courseware/narration-write.ts`,
  `courseware/page-narration-candidate.ts`, `index.ts` only if exports change.
- `packages/shared/src/courseware-scene-teaching.ts`,
  `courseware-teaching-quality.ts`, `index.ts` only if needed.
- `crates/host-core/src/db/courseware_projects/candidates.rs`,
  `scene_teaching.rs`, `workflow.rs`.
- Existing narration-write, saved-narration, shared teaching-quality and Host
  workflow tests. A new `packages/shared/src/courseware-scene-teaching.test.ts`
  and fixtures under `packages/shared/src/courseware-scene-teaching.fixtures/`
  may hold the cross-language requirement cases.
- Specs 24-courseware-narration-candidates, 29-courseware-chat-workflow;
  bounded-recovery ADR, delivery E2E plan, scene skill and changelog.

Out of scope: ordinary narration rewriting, TTS requests, auto grading,
changing existing audio text hashes, deleting teacher edits or paid media,
unbounded content repair, general-purpose editing frameworks.

## Design decisions

### Required repair is a delta

Use a small separate branch in the existing generation modules for
`repairRequiredTeaching`. Its model response contains only missing actions
and placement anchors, for example:
```json
{
  "insertions": [
    {
      "afterSpeechId": "existing-speech-id",
      "block": {
        "type": "interaction",
        "question": "Which greeting?",
        "response": { "kind": "single", "options": ["Hello", "Bye"], "answerIndices": [0] },
        "referenceAnswer": { "summary": "Hello is the greeting.", "keyPoints": ["Say Hello."] }
      }
    }
  ]
}
```

An anchor must identify a current saved speech. Bound the insertion count to the
actual missing approved requirements (currently at most one required question
and one song per page). No replacement speech, arbitrary deletion, new object
effects or provider IDs are accepted in this response.

Main constructs a normal TeachingWrite using original speech objects and the
validated insertions. Existing Host repair logic remains the final retention
authority. Do not send original speech through trim, sentence splitting,
focus generation or a model round trip. Leave the ordinary generation path
unchanged. If the page has no detailed speech, use normal narration generation
instead of this repair mode.

### Approved questions have an exact contract

Within each language, factor one shared comparison for the approved question
text plus full response (kind, ordered options, answer indices). Use the same
fixtures for TypeScript and Rust. Allow only explicitly documented boundary
whitespace normalization for question text; do not collapse meaningful internal
text, reorder options, accept synonyms or compare only response kind.

Generation validates deviations before Host save and feeds a precise diagnostic
into the existing maximum-two-corrections loop. Host independently checks normal
save, repair selection and completion. Shared quality uses the same comparison
rather than a third weaker rule. Model reference answers still require content
review; schema correctness does not certify their semantic truth.

For an existing wrong question, add the missing approved question without
silently deleting teacher-authored questions. Repeated repair recognizes the
matching approved question and does not add it again. Existing plans without
structured teaching keep legacy behavior.

## Commands

```bash
pnpm --filter @pi-desktop/shared exec vitest run src/courseware-teaching-quality.test.ts src/courseware-scene-teaching.test.ts
pnpm --filter @pi-desktop/shared build
pnpm --filter @pi-desktop/agent-runtime exec vitest run src/courseware/narration-write.test.ts src/courseware-quality-continuation.test.ts src/courseware-workflow-recovery.test.ts
pnpm --filter @pi-desktop/agent-runtime build
node --test apps/desktop/test/courseware-saved-narration.test.mjs apps/desktop/test/courseware-narration.test.mjs
cargo test -p host-core --locked db::courseware_projects::workflow::
cargo test -p host-core --locked db::courseware_projects::candidates::
pnpm --filter @pi-desktop/desktop typecheck
```

The new shared test path is created in step 1. Reuse existing build order because
Main tests import the built runtime/shared packages.

## Steps and verification

1. Capture canonical generation output with trailing whitespace, multiple
   sentences, existing audio and visual cues. Add the round-trip repair case.
   Add approved question A / generated question B with identical discussion
   response, plus MCQ response-order and answer-index changes.
   **Verify:** the named unit/Host regressions fail before implementation for
   the actual retention or acceptance mismatch.
2. Add the bounded delta response branch and assemble unchanged baseline
   speech with inserted required actions. Validate anchors before saving.
   Format errors may be corrected twice; stale source, cancelled turn and
   uncertain save must not trigger blind replay.
   **Verify:** narration-write/Main tests pass; compare full original speech
   objects, not only joined text.
3. Unify question comparison and use it at producer, Host repair/save/completion
   and advisory quality surfaces. Update diagnostic handling in tests to
   recognize a mismatched question as an unmet requirement.
   **Verify:** shared, canonical writer and Host tests agree on every contract
   fixture; wrong-question cases cannot return completion.ready true.
4. Verify replay after a lost save response by reading actual saved requirements.
   If the first save committed, the second repair is a no-op for that requirement.
   **Verify:** unchanged audio IDs, effects, order and mock TTS POST count;
   repeated valid repair does not add another approved question/song.
5. Update skill/spec language to describe missing-action repair, rather than
   asking the model to rewrite exact original speech.
   **Verify:** all commands pass, and Plan 006's real Host bridge covers the
   generator output and Host retention validator together.

## Required cases and done criteria

- Generated trailing spaces survive unchanged.
- A legal existing multi-sentence speech remains one unchanged saved action.
- Audio IDs, visual cues, pause values, original action IDs and teacher edits
  remain unchanged; no TTS purchase is caused by requirement repair.
- Invalid/foreign anchor, unwanted music, wrong question and locked page fail
  without any saved partial rewrite.
- Identical response with a different question is not accepted.
- Two corrections maximum; unrecoverable save errors hand off honestly.
- Initial ordinary narration still segments and binds effects as before.
- Real Host acceptance, not the mock's action replacement, validates the result.

## STOP conditions and maintenance

Stop if the proposed fix relaxes Host's exact paid-speech retention, would
silently rewrite teacher questions, or needs arbitrary edit operations in the
delta schema. Do not make trim-insensitive audio identity a workaround.

Any future required action (including structured video) must enter the bounded
delta schema and Host requirement comparison together. Keep free-form model
quality separate from machine-checkable approved requirements.
