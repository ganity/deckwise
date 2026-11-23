# Background teaching-region repair — 2026-11-18

## Outcome

The user accepts presenting a complete rectangular teaching area containing
some surrounding scenery. Scene saved-content review now has a supported
local repair for teaching content that remained inside an opaque background.
It can ask the native editor to extract one original-pixel region, reuse the
existing speech's fade-in and spotlight, save and review again. A failed or
uncertain re-review stays unfinished. Existing business validation is retained.

This complements the [checkpoint-hint correction](../2026-11-18-checkpoint-hint-repair/README.md).
The original paid run is unchanged; this is local assisted recovery, not a new
three-route success claim.

## Root cause and scope

The old safe repair surface could edit generated assessment fields and bind
effects to existing objects. A river inside a raster background had no eligible
foreground object. Rebinding the arrow could not animate the river, regardless
of the number of model retries.

- Desktop `courseware-content-review.ts` accepts the bounded region proposal,
  validates it, checks current Host Scene-task authorization, sends reviewed
  pixel SHA-256 and revision, saves and rechecks current evidence.
- The companion `slide-background-region.ts` partitions background pixels and
  prepares a normal native image. The existing native teaching writer commits
  background, crop, identity, cues and native timing in one Undo transaction.
- Preserve foreground order, questions, speech text, adopted audio, accepted
  scripts and requirements. No image/TTS purchase or new player format.
- Protect read-only/locked/original pages, stale image/revision/history,
  unsupported backgrounds and repeated extraction. Keep one region per page
  within existing bounded repair. Existing failed semantic-repair records are
  not cleared just because broad review passes.

The vacated rectangle is white until entrance. The crop then restores the
original background pixel samples. Rendering has a small subpixel resampling
difference at edges; it is not byte-identical PNG output or generative repaint.

## Validation

| Check | Result |
| --- | --- |
| Desktop saved-content/native-tools/classroom regression | 125 passed |
| Companion native-teaching/native-motion/pixel partition | 56 passed |
| Desktop and companion TypeScript | Passed |
| Companion changed-source lint | Passed, no warnings |
| Companion real OnlyOffice fixture E2E | Passed: stale-pixel rejection, Undo/Redo, save/reopen |
| Original image re-composition | Exact decoded source samples in pixel test |
| Native rendered before/after | Mean absolute channel difference 0.02272046875 on 0–255 scale |
| Strict converted native playback preflight | Ready, no issues |
| Fixed build | Ready; existing notes-master warning recorded |
| Actual fixed-player playback | 4 pages; all 16 original audio clips naturally ended |
| New river crop effects | Fade-in and spotlight both observed on the crop itself |
| Interactions | Wrong/correct objective answers and teacher continuation passed |
| Production Desktop and MAIC companion builds | Passed; chunk-size warnings only |
| Installed companion inventory | 2,858 files verified; old local bundle preserved |

Playback used the first successful save/reopen artifact. The final native E2E
also asserts stale visual SHA rejection and produces a second equivalent crop
with a new random object/revision identity. Both PPTX hashes are in
`fingerprints.json`; do not confuse the second artifact with the playback build.
The final cosmetic test change only renames an unused destructured variable.

- [Playback observations](playback.json)
- [Native save/reopen and pixel comparison](native-result.json)
- [Before image](native-before.png) / [after image](native-after.png)
- [Source and artifact fingerprints](fingerprints.json)
- [Desktop regression log](desktop-unit.log) / [editor regression log](editor-unit.log)
- [Native E2E log](editor-e2e.log)
- [Bundle inventory receipt](bundle-check.log)

## Reproduction and delivery state

Desktop worktree: `courseware-stage-aware-scene`; companion worktree:
`document-worktrees/courseware-par-A-playback`. Both include earlier uncommitted
work. `fingerprints.json` identifies the changed sources; this is not a clean
commit, latest-main integration, PR, release or deployment qualification.

```sh
node --test apps/desktop/test/courseware-content-review.test.mjs apps/desktop/test/courseware-native-tools.test.mjs apps/desktop/test/courseware-classroom.test.mjs
pnpm --filter @pi-desktop/desktop typecheck
# Companion worktree
pnpm exec vitest run test/unit/deckwise-native-teaching.test.ts test/unit/deckwise-teaching-native-motion.test.ts test/unit/slide-background-region.test.ts
pnpm exec tsc --noEmit
E2E_BASE_URL=http://127.0.0.1:4198 E2E_PORT=4198 DECKWISE_REGION_FIXTURE=/absolute/path/to/original-water-cycle.pptx pnpm exec playwright test test/e2e/deckwise-background-region.spec.ts --workers=1 --reporter=line
```

Local artifacts and build/player harnesses:
`/home/jhz/deckwise-validation/background-region-20261118`.
The playback input is `repaired.pptx`; `build.mjs` preserves/validates all original
speech and 16 audio hashes; `live-playback.mjs` checks the actual new crop effects.
The matching production editor is staged in this Desktop worktree's
`apps/desktop/resources/wiseoffice`, with previous resources preserved under
`wiseoffice-before-region-repair` in the artifact directory. Desktop was rebuilt.
No running user application was stopped or restarted.

## Remaining qualification

No real model was invoked for this follow-up. Model review branches use controlled
responses; native recovery uses chosen fixture coordinates. Therefore real-LLM
region selection, automatic correction of the original wrong-page hint, fresh
three-route generation and full Electron restart remain unverified by this run.
P1/P7 remain partially qualified. Existing paid evidence is not overwritten.
The implementation supports eligible ordinary opaque background images, not
arbitrary transformed/translucent backgrounds or repeated multi-region editing.
