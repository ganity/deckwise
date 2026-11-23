# Local main integration — 2026-11-16

Base: `5cbd7cb44de14d6cb5f1e478ff9f57b63bd7d05d` (v0.20.5).
Request branch: `feat/courseware-stage-aware-scene`.
The tested candidate includes the preserved, uncommitted development on this base.

- [Workflow report](workflow-report.json): 644 Main/Host, 44 shared, 541 Runtime
  and 303 Rust checks passed; two pre-existing Rust cases are ignored.
  `real_worker_locked_image_identity_adopts_and_reopens` requires the real
  compiler's locked-image fixture; `real_parser_copy_preserves_adopted_local_audio_without_original_profile`
  requires its installed-worker fixture. This run did not enable those cases.
- [Electron Scene report](electron-scene-report.json): 17 checks passed with a
  local provider stand-in and the bundled Scene compiler.
- Supplemental runs: 95 Main/release checks, 60 Python/Quiz/image checks,
  8 native preflight/inherited-artwork checks and 3 route checks passed.
- Dependency/Desktop builds, all three affected package typechecks,
  `cargo fmt --check` and `git diff --check` passed.

Commands: `node scripts/check-courseware-workflow.mjs`,
`DECKWISE_E2E_OUTPUT=<empty-path> node scripts/e2e-courseware-scene-completion.mjs`,
targeted Node/Vitest files, and package build/typecheck scripts.
Detailed logs and the pre-integration archive remain under
`/tmp/deckwise-integration-20261116-1suxzlfk`; workflow logs remain under
`/tmp/deckwise-workflow-gate-lZfdid`.

This run made no paid provider calls, qualified no new installer, and did not
exercise native-editor effects or full multi-page live generation. P1 historical
attribution and P7 broader acceptance remain open. No remote push or deployment.
