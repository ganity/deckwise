# Courseware completion and recovery guarantees — 2026-10-31

## Scope

Implemented in the existing `courseware-par-A` worktree on
`feat/courseware-par-A`. This is an application/Host repair, not a new skill or
workflow framework. Original media journals, quotes, principal/source checks,
archives and compare-and-swap adoption remain authoritative.

Independent limits remain TTS 10, image 5, image layers 5, music generation 2,
music export 2 and video 2. No new paid course was submitted, and the running
Desktop was not restarted. Existing dirty work was preserved; nothing was staged
or committed.

## Behavior and ownership

| Problem | Enforcement | Evidence |
| --- | --- | --- |
| Playable speech could hide omitted approved questions/music | Host derives acceptance from retained logical-page requirements; checks questions and exact response/answer contracts, missing pages/count, detailed speech, missing audio and pending slots/focus | Host workflow tests; runtime acceptance regression |
| One generated speech could hide unfinished outline speech | All speech blocks must contain detailed non-empty narration before narration readiness | Main regression; Host acceptance test |
| A model could declare an incomplete course finished | A `completed` checkpoint requires recomputed Host acceptance plus adopted audio provenance | Host DB/RPC tests; runtime reads current acceptance |
| Restart reset finite repair budgets | Session/project/source-scoped Host checkpoints retain monotonic counts with revision CAS | Runtime replacement and DB restart tests |
| PPT round-trip changed source bindings | Only verified native-save commit atomically rebinds checkpoints; counters survive and completion must be checked again | Native-save DB and actual SDK/Main/Host process tests |
| Rebuilding narration to restore an activity discarded TTS | Protected repair inserts missing approved question/music actions at exact speech anchors; retains all original actions, speech/audio/effects and order; rejects changed/omitted/reordered speech | Main flag/prompt contract, Host saved repair and action preservation tests |
| A tool failure discarded the complete-course goal | Reconcile actual saved state before deciding the next step | Runtime recovery test |
| Temporary status failures interrupted progress | Retry only explicitly classified original-job reads, twice with 1s/2s waits | Controlled-clock fault tests |
| Lost repair save receipt could lead to duplicate work | Re-read acceptance before another bounded repair; saved content finishes without another proposal, actual failure blocks after two attempts | Runtime missing-receipt fault tests |
| Unknown paid outcome, Stop or invalid input could cause blind retries | Unknown submissions remain query-only; unclassified/validation/cancellation failures do not enter the read retry policy; stopped/foreign/stale turns cannot write checkpoints | Runtime fault tests and Host RPC/process tests |

The runtime dispatches protected activity repair directly when detailed narration
exists and only approved question/music actions are missing. Other missing
stages continue through the existing tools, using saved-state instructions.
Unrepairable/locked pages or exhausted required repairs report unfinished work.
Advisory teaching diagnostics remain advisory and must be disclosed honestly.

## Changed surfaces

- Host: new DB/RPC workflow modules; project context acceptance; native-save
  checkpoint rebinding; protected narration save path.
- Runtime: checkpoint read/write wiring, retained authorization goal, bounded
  diagnostic budgets, error classification, original-job reconciliation and
  protected repair dispatch.
- Main/tool contracts: additive `repairRequiredTeaching` flag; exact original
  speech instructions; complete narration readiness; acceptance guidance.
- Specs/ADR/E2E scenarios and focused regression tests accompany these changes.
  Packaged `SKILL.md` files were not edited by this repair.

## Validation

| Check | Result |
| --- | --- |
| Host `cargo test -p host-core --locked courseware --no-fail-fast` | 342 passed, 2 fixture-gated ignored; broader regression before final RPC/count checks |
| Final Host `cargo test -p host-core --locked workflow --no-fail-fast` | 7 passed, including DB restart, monotonic budgets, required repair, native-save rebinding and actual RPC routing |
| Host action-anchor repair regression | Passed |
| Runtime continuation/quality/recovery/tool contracts and actual runtime HTTP/SSE fixtures | 5 files, 88 passed |
| Main saved narration/media, generation queue, local media and chat workflow | 85 passed |
| Main native-save suite with real SDK files/parser/Host process | 5 passed, none skipped; includes checkpoint rebinding, Host restart, old-turn refusal and authorized new-turn write |
| Desktop dependency/application production build | Passed |
| Runtime and Desktop typechecks | Passed |
| Repository lint | Passed |
| Host debug build and all-target clippy | Passed; existing warnings remain |
| New Rust modules formatting; incremental patch whitespace/applicability | Passed |
| Whole-workspace `pnpm build:js` | Failed on seven existing VitePress dead links; application code build passed separately |
| Whole-workspace `cargo fmt --check` | Failed on existing formatting in the dirty worktree; pre-edit candidate snapshot also fails formatting |
| Whole-workspace `git diff --check` | Existing extra EOF blank line in untouched `courseware-video-placement.ts`; incremental repair patch passes |

The two ignored Host cases require the locked-image and portable-parser fixtures.
The separate real native-save test supplied its existing SDK fixture and installed
worker/Node paths and ran without skips. These counts overlap; do not add them as
distinct test totals.

Task candidate: local dirty tree based on
`1ff749805a93702fac7e7e24b7a0dffc43adcb6f`.
Recorded local `origin/main`: `58a9c4f57203c93da3f590e426b42ebba1072fb6`.
No fetch/rebase was performed over the existing unfinished work. The process
tests validate this local executable state; they are not PR integration or
packaged installer acceptance.

Evidence: `/tmp/deckwise-workflow-guarantees-20261031`, including test/build
logs, pre-edit snapshots, a separate-index baseline, `incremental.patch` and
`manifest.json`. The normal Git index is unchanged. The incremental patch covers
this repair rather than the branch's earlier unrelated modifications.

## Remaining limits

- Resume still requires a current authorized complete-course turn. Application
  startup and status reads do not automatically resume generation.
- No fresh paid supplier run, packaged Desktop acceptance or full human review
  of slide appearance/audio was performed. The previously completed ten-page
  Greetings lesson was not modified by these isolated tests.
- Host acceptance proves structured completion/provenance, not subjective
  teaching quality, song meaning or visual correctness. Legacy plans without
  structured requirements cannot certify omitted free-text intentions; video
  slots still block completion but free-text requests are not inferred as slots.
- This patch does not rebuild per-type active supplier occupancy across process
  restarts or introduce a global durable scheduler. Existing original-job
  journals and unknown-outcome protections remain in use.
- Model/schema and provider errors can still occur. The repair makes failures
  bounded, recoverable where supported, and visible; it does not promise that
  every future request will finish unattended.
