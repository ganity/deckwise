# MAIC visual-master alignment

New scene images use the MAIC prompt-only visual-master planner (ported from
`ba13c780`, including its image2-pptist skill, subject separation and developed
background constraints). Approved page text is mandatory; narration is never
sent as image text. Page-required subjects, the reviewed visual bible and any
cover-only correction enter the art-direction request. One correction is allowed
for invalid planner JSON/text; provider or validation failures retain the
prepared deterministic page prompt, as in MAIC's planning fallback.

The existing 4,000 UTF-16-unit media contract remains authoritative. The planner
has an explicit budget after reserving space for extraction/reference constraints;
oversized output falls back rather than truncating teaching text or instructions.
The planner disables thinking and caps output at 3,000 tokens, as in MAIC. The
Chat-selected LLM and its existing authentication and token accounting remain
in use. MAIC's server-specific model configuration and visual-library assets are
not copied into the desktop application.

The Host persists the source prompt and final prompt under one intent. Repeated
prepare calls and explicit retries reuse that plan. A planning-required intent
cannot begin a paid submission until its prompt is finalized. Interrupted
planning resumes through prepared-image generation using the saved correction
instructions. Approval, account and selected-reference fences are checked again
after planning. Started/submitted legacy image requests remain immutable.
New journal fields are additive; legacy journals still load in the new Host.

DeckWise persists `quality: high` and `image_size: 1280x800` in each new image
intent, matching MAIC's MXAPI request. The gateway forwards these caller-owned
parameters; it supplies no size, quality, resolution or aspect-ratio defaults.
The scene compiler already uses a 1280x800 canvas, so its geometry is preserved.
Seedream decomposition retains MAIC's own `size: 2K`, original-resolution JPEG
quality 95 input and unchanged canonical layer prompt. Electron prepares the
JPEG without resizing, and Host archives its exact bytes before the request is
quoted or begun. The intent separately pins the reviewed source image and the
normalized wire image; source selection fences still apply. The gateway never
normalizes image bytes. This change concerns
visual-master generation, and does not add another paid decomposition fallback.

## Verification

- Desktop planner and image workflow tests: exact text and cast, narration
  exclusion, reference context, one correction, size rejection, fallback,
  durable prompt reuse and stale approval rejection.
- Host RPC tests: prompt/source binding, mandatory text validation, planning
  submission fence, persisted reuse and submitted-request immutability.
- Gateway HTTP tests: arbitrary caller sizes and quality are forwarded unchanged;
  absent parameters stay absent, reserved keys are refused, and reference bytes
  are never re-encoded. Changed parameters cannot replay an old request key.
- Desktop/Host/gateway share a parameter-bound canonical hash fixture; legacy
  parameterless hashes and submitted requests remain unchanged.
- Desktop TypeScript check; targeted Host and gateway tests.
- Paid generation and installed Electron visual acceptance are not part of the
  offline checks. Supplier moderation can still reject an output.

### Local check result

The targeted Desktop suite passed 124 tests; Host scene-image and media-canvas
suites passed 30 and 39 tests; gateway native-media/gateway suites passed 24
tests. Desktop TypeScript checking passed. These checks use local fake-provider
HTTP endpoints and codec test edges, without a paid upstream request or installed
Electron visual acceptance. Production deployment remains outstanding.
The ownership correction is integrated in both `feat/courseware-par-A` worktrees
(Desktop base `f61631e11`, gateway base `422272e`), preserving existing local work.
Deploy both contract updates together so the caller-owned parameters are accepted.
