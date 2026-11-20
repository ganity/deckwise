# Layer identity and native fraction repair

## Outcome

This repairs the two application defects reproduced in the preceding
[exact-model rerun](../2026-11-18-layer-metadata-flash-rerun/README.md).
It does not reclassify that failed paid run as successful.

### Scene

Supplier `name` and `description` now survive download, Host archive/restart,
selected-asset views, scene compilation and native Office save/reopen. They are
optional bounded asset metadata (200/2000 UTF-16 units); older receipts still
load. The compiler writes `deckwise-layer/1` into the standard picture alternate
description with the SHA-256 of the exact embedded PNG.

The editor checks the current registered local PNG against that hash. Remote
URLs are never fetched for this check. Missing/invalid metadata, replaced/cropped,
rotated/flipped or grouped images fall back to observation. The image evidence
cache is bounded. Supplier descriptions are identity hints, not OCR, instructions
or proof of factual correctness.

Body narration uses those current identities directly. It does not pay for
another identity-discovery call when every picture is covered. If only some
pictures lack evidence, discovery returns identities only for the unresolved
objects; known neighbors are context and cannot be reassigned by that response.
Both independent narration review and final saved-course content review receive
isolated layer PNGs tied to current UUIDs in addition to the full page. Factual,
question/answer, effect-target, persistence, duration and completion gates remain.
A failed independent semantic review still prevents saving the draft.

No historic live lesson or receipt was silently rewritten. Old files without
these fields retain visual fallback; the new optimization applies to newly
compiled pictures with metadata. No automatic migration is claimed.

### PPT Master

The importer now recognizes standalone numeric OMML bar fractions, including
`mc:AlternateContent` inside groups. It retains shape identity, numerator,
denominator, bar, color and alignment. The existing fixed-player formula
component receives sanitized display HTML, so resolving identity does not merely
turn an empty carrier into an accepted but invisible object.

Unsupported OMML, including roots and other fraction layouts, retains
`PPTX_NATIVE_MATH_UNVERIFIED`. Host object identity verification is unchanged.
This is finite numeric-fraction support, not arbitrary Office equation fidelity.

## Verification

- Red reproductions: supplier metadata was absent after decoding; numeric
  fraction content was missing; the real four-page Master retained two anonymous
  blank formula objects even after the first simplified fixture passed.
- Runtime: 99 targeted tests passed across import identity, native packaging and
  scene compilation. The exact real Master is a permanent 28 KiB regression
  fixture under `packages/courseware-runtime/tests/fixtures/native-math/`.
- A newly staged production worker parsed the previously rejected packed Master:
  **4 pages, 40 objects, zero source-binding mismatches**, with `1/4` and `3/4`
  restored. Only the pre-existing notes-master review warning remains. See
  [worker summary](master-summary.json).
- Chromium rendered the actual fixed-player formula component from that worker's
  output. Both numerators, denominators, fraction bars and vertical order were
  asserted and visually inspected: [image](fractions.png),
  [assertions](math-render-result.json).
- Desktop: **259 tests passed**, covering metadata archive/restart, compilation placement, native
  narration, partial metadata fallback and unchanged final-content gates.
- Host's archive/restart regression passed with the additive metadata, invalid
  field/size checks and original atomicity assertions.
- Editor: **45 unit tests passed**, covering current-byte matching, replacement, cropping/rotation/
  flip invalidation, malformed/legacy metadata and refusing remote/unregistered
  images. Existing native teaching tests remain green.
- Real Chromium/Office roundtrip: the original paid Scene PNGs were compiled and
  packaged through the production authoring API with their actual supplier
  metadata, then opened, saved and reopened. All **4 foreground UUIDs, names,
  descriptions and isolated-image bindings** remained equal. The fixture is
  one page and makes no provider calls. See [compiler receipt](compiled-scene.json), [reopened page](layers-reopened.png).

- Shared/runtime builds, Desktop/editor TypeScript checks, Desktop build and the
  paired MAIC editor integration build passed. Staged worker (155 files) and
  editor (2,858 files) inventories verified. Candidate identities and results:
  [checks](checks.json).

## Boundaries

No new paid LLM, image or TTS generation was performed in this repair turn.
Consequently this does not certify fresh three-route success rates or close P7's
remaining real-model work. Native Office/browser checks and the actual parser
are stronger evidence than mocks, but do not claim an installed Desktop restart
or an end-to-end paid completion result. The paired Desktop and editor sources
must be built together; an older running executable cannot acquire these fixes
from source changes alone. No commit, push, deployment or release is claimed.
