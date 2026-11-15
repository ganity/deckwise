# Six courseware defects: repair and local validation

## Scope

This extends the interruption repair using the two preserved real four-page
lessons from `two-paths-fresh-20261115-1032`. Source changes are in the existing
isolated Desktop and paired Document worktrees. Both contain earlier uncommitted
work; no commit, reset, deployment, new media order or billing retry was made.

## Repairs

1. SDK v9 rejected group-child timing targets on import because its validity check
   recognized only direct slide children. Install a scoped, idempotent guard
   before binary import. Accept only children attached through valid group trees;
   detached/cyclic targets retain the original SDK rejection. Save readback checks
   exact target, preset, subtype and duration rather than effect count alone.
   The slideshow searches child and ancestor effects. Fixed-player preflight checks
   saved mirrors before group projection consumes them and rejects missing mirrors.
2. Courseware continuation detects three identical Browser screenshots. It requests
   real navigation, source repair or export from the same project. After five
   unchanged screenshots even navigation cannot renew reads until the source is
   edited. It never submits a replacement project or media order.
3. The pseudo-tool response detector recognizes both single and doubled fullwidth
   DSML delimiters, while retaining fenced examples as ordinary text. Recovery
   remains bounded and retains successful tool results.
4. An explicit `speechCount` reaches both native and saved narration. Generation
   checks the exact speech-block count and 4000-character block limit, and avoids
   automatic focus/sentence/colon splitting that would invalidate that count.
   Requests without a count retain their previous behavior. Source-preserving
   repair cannot also request a narration rewrite/count change.
5. Quiz image prompts depict neutral option identities, without making every
   distractor satisfy the whole question. Main checks downloaded bytes and requests
   a bounded visual verdict before adoption. Invalid, uncertain or malformed
   verdicts do not write the picture or purchase another image. Current and legacy
   prompt keys are reconciled before submission/refresh, preserving existing orders.
   Foreground, hidden-editor and saved-file paths share the review boundary.
6. New scene drafts require `textMode:"native"` before submission/approval. The
   image prompt reserves clear space and prohibits raster copy; both assembly
   paths forward the mode and require every approved display string exactly once
   as a native text frame. Supplier image geometry stays authoritative. Already
   approved legacy drafts, images and hashes remain valid and are not migrated.

## Evidence

Local evidence directory: `/home/jhz/deckwise-validation/all-fixes-20261115`.

- Desktop focused suites: 216 passing tests. Additional scene entry/approval/
  assembly suites: 94 passing tests. Saved-classroom real Host integration: 3
  passing tests. Overlapping suites are not an additive total.
- Runtime/narration suites: 440 passing tests; the final stricter preview bound is
  additionally covered by all 21 stalled-continuation tests.
- The final provider-free workflow gate passes: Main/Host integration 639,
  shared contracts 44, agent runtime 540 and Rust courseware contracts 302.
  Rust reports 2 ignored tests; no mandatory Main/Host, shared or agent-runtime
  test is skipped. These overlap the focused suites above, not an additive total.
  The opt-in locked-image identity and portable local-audio parser tests require
  their dedicated fixtures and were not executed in this gate.
  The report and its logs are preserved under `workflow-gate/` in the evidence
  directory. This gate makes no model or paid-media provider calls; its native
  editor is checked separately by the real E2E below.
- Paired Document guard/native teaching/schedule suites: 41 passing tests.
- Playback preflight: 5 passing tests, including the group-projection ordering
  regression. Rust scene prompt tests: 2 passing tests.
- A real Document E2E replaces the saved speech motion, checks undo/redo, preserves
  media, saves and reopens successfully (Chromium, 1 passing test).
- Preserved Master original fails preflight on both body pages for missing speech
  mirrors. The repaired file passes with no blocking issues.
- Real repaired files save/reopen with identical teaching and media. Master pages
  1/2 and scene pages 1/3 play to natural completion without page or SDK errors.
  Sidebar action IDs follow 1/other body/1 navigation.
- The local client uses the rebuilt paired Document integration. Its original
  Master file was repaired via the existing native write/upload/save boundaries.
  A neutral wood cutout from the original image replaces the incorrect magnetic
  wood illustration. Reopen verifies that picture, all actions and 8 original
  Master speech audio bindings. No image or TTS generation was submitted.
- After the final Main build, the client was restarted and the original Master
  reopened again. Readback confirms the same saved file hash, all 8 speech audio
  bindings and the neutral Quiz image. Both preserved generation sessions are
  idle with zero pending tool confirmations. Evidence is recorded in
  `master/final-restart-verification.json` and `master/final-restart.png`.

## Limits

No new paid three-path generation was run. New model-produced textless art and
semantic image-review accuracy are covered at their boundaries, not certified
across production providers. The preserved Master still has its old 4/2 body
speech-block distribution: this repair deliberately retains its existing paid
speech/audio; the exact-count fix applies to subsequent narration generation.
Existing scene raster lettering is also retained; turning it into native text
requires a new textless-art generation. Full lesson progression through Quiz and
interactive checkpoints was not repeated; the natural-play evidence is for the
four body pages listed above. Nonblocking notes-master/unsupported unbound timing
diagnostics remain reported rather than being relabeled as verified fidelity.
