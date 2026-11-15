# Main Chat delivery checks and manual media repair — 2026-10-25

Status: **17/17 packaged main Chat groups pass; not a complete repository/release acceptance**.
All identities, model responses and media services in the Desktop scenarios are
loopback fixtures. No paid request, production write, deployment or git merge
is part of this increment. Earlier failed runs remain in this directory.

## Product repair

The fixed-courseware fixture retained a normal standalone manually played video.
Its native media marker has an indefinite start and no object-animation duration.
The timing parser reported it as `PPTX_TIMING_TARGET_OR_DURATION_UNSUPPORTED`,
which the newer fixed-builder guard correctly refused as an unresolved animation.
This made the original video-containing fixed-build tests fail before executing.

The parser now recognizes only the inert root/manual/whole-shape marker and
leaves playback to the existing page-media controls. It does not invent an
animation step. Automatic, delayed, finite-duration, looping, scheduled and
paragraph media still use the diagnostic/refusal path. Unsupported animation
warnings are not waived. The original video PPTX is preserved unchanged.

The converter bundle and staged worker were rebuilt together. The previous
generated worker remains at `packages/courseware-runtime/.worker-before-manual-media-20261025`.
Cancellation tests now use the current staged worker and captured baseline
package bytes; an old converter's hard-coded build ID is not an invariant.

Main's renderer event dispatch/status retention moved into
`runtime/renderer-events.ts` without changing the IPC contract. The entry stays
within its enforced line limit. Five focused cases cover missing/destroyed
windows, a disposed frame, event allowlisting and plugin-theme callbacks.
The late-login schema-error repair remains included in the new package.

## Exact new local trial

`apps/desktop/release/repository-gates-20261025/DeckWise-0.17.7.AppImage` is **340,986,890 bytes**, SHA-256
`eb6401b464f092b919b303ae7e33ccb802bcd65193b754adbc4f9e1775b6ad78`. [`acceptance.json`](acceptance.json) pins this
artifact, 1,181 unchanged inventoried source inputs and all package reports.

[`chat-e2e/report.json`](chat-e2e/report.json) passes **17/17** actual packaged
Desktop/Host/Agent/WiseOffice groups: three task entries, main Chat plan and asset
review, ordinary PPT Master generation, same-Chat native object save, per-page
narration review/adoption, candidate review exit, fade preview/adoption and restart.
The new package also passes four late-login/reload/schema-notice checks and the
actual AppImage launcher/payload smoke. The packaged Host hash is identical to
the predecessor's migration/SIGKILL evidence; those drills were not rerun.
The historical single trial entry, `docs/validation/courseware/parallel/A/current-trial.md`,
identified the newer [matched Chat-redo package](../chat-redo-package-20261025/README.md).
That trial entry is not included in this checkout.
This package and its evidence remain unchanged.

## Test and documentation repairs

- Team-asset/session fixtures now declare the dependencies introduced by existing
  courseware integration. The HTTP fixture is cleaned up even if auth loading
  fails; this fixes a test process that otherwise never exited.
- Three static Vite SSR tests disable file watching. Scanning old packaged icon
  trees during static rendering exhausted Linux's watcher quota.
- The native-theme source assertion follows the extracted callback wiring.
- The checkpoint-settle test uses a controlled clock and an explicit first-save
  completion. A busy machine could previously exceed its 30 ms interval during
  `sleep(0)` and write the supposed pending snapshot before settlement.
- Existing Chinese prose is retained. Missing source contract/table increments
  and mirror/NAV entries are present; untranslated additions explicitly retain
  the English source. This is not a claim of full Chinese translation.
- Existing ADR references and imported converter/player provenance are indexed;
  upstream historical decisions are not claims that this fork implements them.

## Completed checks

| Check | Result | Evidence |
| --- | --- | --- |
| Documentation | 11 passed | `docs-final.txt`; repeated in workspace run |
| Shared | 1,366 passed | `workspace-tests-repaired.txt` |
| Plugin SDK / i18n | 384 / 28 passed | `workspace-tests-repaired.txt` |
| Courseware runtime | 383 passed, 1 skipped | `workspace-tests-repaired.txt` |
| Plugin devkit / agent Host / agent runtime | 52 / 65 / 1,603 passed | `workspace-tests-repaired.txt` |
| Desktop final full suite | 3,334 passed, 8 skipped | `desktop-tests-final.txt` |
| Retained runtime-status regressions | 30 passed | `renderer-final.txt` |
| Workspace TypeScript | Pass | `types-final.txt` |
| Configured lint / architecture | Pass | `lint-final.txt`; `architecture-final.txt` |
| Host tests before test-module move | 1,211 passed, 2 ignored | `host-tests.txt` |
| Relocated shell tests | 14 passed | `shell-tests-after-move.txt` |
| Actual packaged main Chat / WiseOffice | 17 passed | `chat-e2e/report.json` |
| Actual packaged schema notice | 4 passed | `schema-notice/report.json` |
| AppImage launch / five runtime payload hashes | Pass | `appimage-smoke.json` |
| Packaged resource identity / credential scan | Pass | `package-check.json`; `package-credentials.json` |
| Separate WiseOffice files | 2,899 matched | `office-check.json` |

The eight unaffected packages passed in the retained recursive run. Its Desktop
failure was then fixed and the full Desktop suite rerun. These final per-package
runs total **7,226 passed and 9 skipped**; the earlier recursive command itself
remains a recorded failure. Skipped optional tests are not passing checks.

## Remaining gate and scope

`cargo fmt --all -- --check` still fails on **33 files byte-identical to HEAD**.
`rust-format-boundary.json` enumerates and verifies that boundary. The moved
shell test file itself passes rustfmt. No unrelated Rust reformat is performed.
Consequently the complete repository gate is not green.

The local fixture trial does not accept normal teacher login, intended Platform/
llm-ha/media deployment, real supplier output/representative lesson quality,
managed text atomic-budget policy, Windows/macOS or formal release. Prior Linux
migration/SIGKILL checks apply to the unchanged packaged Host, not a new physical
power-loss drill. Deferred collaboration and virtual-classroom work stays deferred.
