# Generation recovery fixes after the three-route run

Scope excludes model quota/accounting anomalies. Source changes remain in the
existing `feat/courseware-stage-aware-scene` request worktree; previous real-run
artifacts remain unchanged and are not relabeled as a test of this new candidate.

## Implemented

- Narration-verdict format failures now request a corrected verdict against the
  same draft/images. They share the original two repair opportunities with
  content/binding repair. Exhausted or uncertain page-local review failures are
  terminal for the unchanged page and allow independent native batches to run.
- Activity verdict formatting also receives at most two repairs. A real question
  rejection still requires an amended proposal, not repeated unchanged review.
- Model evidence provides short exact object references resolved to current UUIDs
  before schema/identity/semantic checks. Aliases and unknown references remain
  rejected. Activity evidence can be omitted and is read verbatim from the
  accepted unit; explicitly supplied paraphrases still fail exact-source checks.
- Skills and tool descriptions prohibit invented default speech counts. This is
  agent guidance, not a new language-specific parser of user intent. Explicit
  `speechCount` values retain strict enforcement.
- Full-course native continuation now requests an explicit saved-content review
  after media/technical readiness. The existing context tool's ordinary reads
  remain model-free. Review includes actual page PNGs, saved narration/effects,
  question/options/correct answer/reference and every sentence of Quiz analysis.
- Generated Quiz analysis corrections use the existing classroom CAS/save and
  must pass another review. Format and analysis repairs share two opportunities
  per page. Other fields, speech/audio and peer pages remain intact. Original
  imported pages (including unknown origin metadata), locks and read-only pages
  are protected. Source/model/turn changes invalidate results; cancellation
  aborts an in-flight model call. Cached unchanged results prevent repeated
  status reads from restarting failed repair budgets.

## Verification and limits

Desktop narration/native/content-review/inspection/Skill tests and Agent Runtime
narration/tool/recovery/continuation suites cover malformed review recovery,
shared budgets, independent peers, bad distractor analysis, exact correction
scope, protected imports/audio, source/model changes and cancellation. Build and
typecheck results are recorded below after final checks.

- Desktop: 207 targeted tests passed, zero skipped.
- Agent Runtime: 201 tests across seven files passed.
- Final candidate-module rerun: 68 passed (overlaps the Runtime suite).
- Final activity-evidence boundary rerun: six passed (overlaps Desktop).
- Agent Runtime build, Desktop typecheck and Desktop build passed.
- `git diff --check` passed. No installer or live provider run was performed.

These are automated seam tests using synthetic model responses. The three
previous real lessons cover the earlier candidate; the new final reviewer has
not yet been qualified with a fresh paid model/native lesson run. Do not infer
real-model detection accuracy from these tests. Extra page review adds latency
and selected-model cost. Generic source illustration/layout errors are detected
and reported for the existing authoring workflow; they are not repaired through
unsupported native edits or blanket image/audio regeneration. Accepted small
raster spacing imperfections remain allowed. Historical P1 and broad P7 remain
open; no installer, deployment, publication or billing behavior was changed.
