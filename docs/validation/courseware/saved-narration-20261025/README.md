# Saved-page narration acceptance

Date: 2026-10-25
Worktree: `courseware-par-A` (`feat/courseware-par-A`)

The restored task now passes the actual Electron Main / Host / staged-parser
saved-source gate. The retained 56-page PPTX is identified by the SHA-256 in
[result.json](result.json); source bytes and paths are not included here.

- All 56 pages used full-page PNG rasterization; none required embedded-image
  fallback. Every page entered the ordered plan and produced a pending candidate.
- The deterministic callbacks verified nonempty image bytes, adjacent-page plan
  context and saved object attention. There were 113 simulated model calls and
  zero paid calls. Generation took 166,608 ms; this is not provider latency.
- Consecutive candidate adoption preserved peer candidates. A pending candidate
  survived Host restart. The source PPTX hash stayed unchanged, and no editor or
  selection RPC was called.
- Host audio adoption regression verifies attention becomes a visual cue covering
  the decoded audio interval, then revoice preserves existing cues and requires
  fresh review. Existing fixed-build/player tests cover logical target binding.

## Validation

- Desktop saved narration, teaching, effects, entry and tab tests: 87 passed.
- Agent runtime narration writer, preview-copy sanitizer and workflow tools:
  13 passed.
- Host courseware project tests: 132 passed, 1 existing fixture-dependent test
  ignored. Narration text/notes parser tests: 3 passed.
- Fixed-build and fixed-player tests: 45 passed.
- Agent-runtime build, Desktop typecheck/build/style-token lint, scoped Rust
  formatting, documentation checks and `git diff --check`: passed.
- Biome's repository configuration excludes these Main/runtime files, so the
  targeted Biome invocation processed none and is not claimed as a lint pass.

## Limits

Real-provider visual accuracy, teaching quality, paid TTS and packaged
cross-platform acceptance were not run. Full-page rasterization requires local
LibreOffice and Poppler; missing tools produce the embedded-image diagnostic
fallback. The deterministic E2E validates flow and persistence, not model quality.
No commit, merge, push or release was performed.
