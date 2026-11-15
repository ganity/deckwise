# Native playback animation degradation — 2026-11-11

User request: unsupported native animations should not prevent the whole lesson
from playing; prefer fade, otherwise skip. Implemented on `feat/courseware-par-A`.

## Behavior

- Preserve supported finite effects, their click/automatic triggers and offsets.
- For an unbound effect that cannot project, use a 500 ms fade on a unique, safe
  whole-object target. Skip unresolved/media/paragraph targets and parser branches
  that could not be recovered. Retain warning diagnostics in the build report.
- Accept those specific degradation warnings through conversion policy. Unrelated
  review warnings, invalid XML/resource budgets, stale source identity, explicit
  native teaching bindings and competing motion owners retain their guards.
- A Master group containing exactly one visible mapped object resolves speech
  motion to that child. This removes the separate `EFFECT_BINDING_MISMATCH` exposed
  after the original animation blocker was removed. Ambiguous groups still reject.
- Conversion changes playback metadata only; source PPTX and saved teaching bytes
  are unchanged. Complex effects are approximations, not original visual fidelity.

## Validation

Runtime regression tests: 44 passed across native fallback, native click animations,
native timelines and fixed build/load. Runtime typecheck and build passed.

The exact Master PPTX from the preceding live run was reused read-only:
`/home/jhz/deckwise-validation/shared-teaching-live-20261111/master-run/final.pptx`.
Its SHA-256 remains `126d21cbe3c4ed7e080f490b9498289e8ca3d33e26fb6dc3f9fd702cec2e7b3d`.
Real Host parsing, immutable snapshot, fixed build and Host restart/reopen passed.
The original unsupported behavior/structure warnings remain visible in the report;
those parser-skipped branches were not falsely counted as fades.

New fixed build ID:
`46ede1aa61d264844cd57201c0163b240aecc32620a19ffa2100f63c65cbc09c`.

Actual Chromium playback visited all three pages, naturally ended all five real
speech segments, checked the correct Quiz answer and continued the oral activity.
It also continued one retained native click. Fade, spotlight and highlight were
observed; browser errors: zero. The spotlight screenshot was visually inspected.
No new LLM/media generation, audio skipping or manual effect injection was used.

Evidence: `/home/jhz/deckwise-validation/native-animation-fallback-20261111/`,
including `master-fixed.log`, `master-playback.log`, `playback-master/report.json`,
screenshots, unit/typecheck/build logs and `validation.json`.

This verifies the built local runtime and real saved-file/player path. A fresh
Desktop installer and PowerPoint/WPS interoperability were not qualified. The
separate import automatic-effect and full-English template gaps remain unchanged.
