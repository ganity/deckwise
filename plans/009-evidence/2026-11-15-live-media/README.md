# Plan 009 live media acceptance, 2026-11-15

The user explicitly authorized real image generation and TTS. Validation used
the existing packaged Linux candidate, bundled Host and WiseOffice in isolated
test data. No product code or validation rule was changed for these runs.

## Results

| Check | Observed result |
| --- | --- |
| First Visual Master request | Supplier terminal failure; final Desktop receipt released the reservation and recorded 0 points. |
| Second Visual Master request | Generated and archived a 1280x800 primary-grade Math image; settled at 2 points. |
| Real decomposition | Archived a background and three foregrounds; settled at 6 points. |
| Diagram preservation | Axis, six ticks, numbers, arrow and red point remain together in one foreground. Title and note have separate layers. |
| Native compilation | Compiled the actual supplier assets into a PPTX with three foreground image objects and an image background; no reconstructed native text or shapes. |
| Separate native TTS fixture | One real request, settled at 1 point; 12,288 ms decoded audio. |
| Restart and playback of native TTS fixture | Exact speech and audio retained after Electron/Host/Office restart. The player reached completion and emitted a natural `ended` event at 12.288 seconds with no media error. |
| Generated Scene TTS recovery | A response interrupted by editor readiness was recovered through the original intent, settled at 1 point, archived and adopted. Recovery submitted no replacement task. |
| Real layered Scene playback and restart | All three layers, exact speech and audio survived a subsequent Electron/Host/Office restart. Both player runs naturally ended the 8,040 ms audio without errors or new media submissions. |

Final recorded media receipts total **10 points**: failed image 0, successful
image 2, decomposition 6, native fixture TTS 1 and Scene TTS 1. Both recovery and
the subsequent Scene restart made zero new media submissions.

## Visual review

The generated image contains the correct 0–5 sequence, a point at 3, a rightward
arrow and readable Chinese title/note. It uses a simple school diagram without
preschool characters. Decomposition and reconstruction retain those contents.

Tick centers sampled from the generated PNG are approximately
`97, 312, 518, 727, 934, 1144` pixels. Their intervals are
`215, 206, 209, 207, 210` pixels: the model produces approximate spacing,
not metrically exact geometry. This sample does not establish accuracy for
arbitrary formulas, charts, grades or subjects. Existing content review still
applies; no tolerance or business gate was relaxed for this test.

## Evidence and boundaries

- [Verification and final receipts](verification.json) include intent IDs,
  supplier failure identifiers, settled points and package fingerprints.
- [Generated Visual Master](primary-number-line.png),
  [reconstructed layers](layers-reconstructed.png), and
  [native fixture playback](native-playback-complete.png) preserve the sample.
- [Scene playback after restart](scene-reopen-playback-complete.png) and
  [the actual Scene narration](scene-narration.mp3) preserve the complete sample.
- The candidate is a dirty request worktree at the recorded HEAD, not a merged
  or deployed release. Package hashes identify the actual tested artifact.
- The Scene plan and speech are explicit test fixtures. Production IPC performs
  plan validation, adoption, compilation, native writes, media calls and player
  construction. This does not test autonomous Chat planning, detailed narration
  generation, human plan/style review, or a complete multi-page teaching course.
- Authentication uses a cached real Education access token through a loopback
  adapter. Identity and media calls go to production. The adapter origin must
  remain stable across restarts because media ownership includes the backend
  origin; changing its port cannot be counted as a product recovery failure.
- Direct test IPC calls require the normal editor save/ready boundary. An
  unsaved fixture speech was restored with the identical action ID/text before
  original-task recovery. This is not evidence of saved-data loss or of a
  full Chat-turn failure. Native generation intentionally retains the outline
  as planning evidence rather than installing it as completed detailed speech.
  The final Scene recovery and restart verify the explicitly saved fixture,
  not autonomous generation of a detailed teaching script.
- An earlier test invoked the legacy classroom player for a native document.
  The passing playback check uses the current native snapshot/fixed-build flow.
- Conversion warnings retain their existing explicit review gate; the native
  fixture reported `PPTX_NOTES_MASTER_UNVERIFIED`. No error was waived, and
  structural readiness does not imply unrestricted PowerPoint animation parity.
- Point totals concern the recorded media receipts only. Text-model planning
  calls and account-wide billing were not audited.
- No platform synchronization/publication, deployment, commit or merge occurred.
  Live animation, spotlight, music, video and multi-page recovery remain untested.
  The eight historical request-preparation failures remain unattributed.

## Test authentication side effect

The initial real authentication test rotated the production refresh token, but
the isolated harness did not retain the latest token before replacing its test
session. The original Desktop session file was not overwritten. The user has
since signed in again, restoring the normal session. This was a test-operation
error, not a courseware change. Existing courseware data was not modified.
Later tests use the cached access token and do not refresh production login
credentials.
