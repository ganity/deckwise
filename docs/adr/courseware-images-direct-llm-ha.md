# Direct llm-ha transport for courseware images

- Status: Accepted
- Date: 2026-10-26

## Decision

Desktop submits courseware image and decomposition tasks directly to llm-ha using
its existing managed gateway and user token. llm-ha owns supplier model configuration,
credentials, native protocols, durable task receipts and original assets. Platform
retains account authentication and billing only: signed quotes, points reservation
and idempotent actual-count settlement. It does not proxy image generation.

Image methods use a dedicated gateway base in the existing Main transport; TTS,
music and project APIs preserve their current routing. New image receipts have a
`gw-` prefix. Older Platform receipts remain readable by their existing routes;
by-key recovery can try Platform GET only after explicit gateway not-found. No paid
submission has a Platform fallback. Renderer and Chat never receive supplier keys.

## Consequences

The catalog comes entirely from llm-ha. Missing pricing rejects before generation.
Seedream decomposes one reviewed master into one base plus at most 16 foregrounds;
billing reserves 17 outputs and settles the actual count at the frozen quote rate.
The native path does not also emit a Redis IMAGE charge. Lost paid replies remain
unknown for reconciliation rather than causing another supplier request.

The matching Platform migration/code, llm-ha and Desktop must ship together.
Gateway SQLite now owns image receipts and bytes and requires persistent storage;
independent replicas cannot safely serve the same task from separate databases.
Team permissions remain checked for submissions and downloads. Existing Host asset
archive, reference review and compiler boundaries remain authoritative.

See [the media contract](../spec/03-runtime/27-courseware-authorized-media.md).

## Layer delivery amendment (2026-10-27)

For Seedream decomposition, llm-ha archives the supplier JSON receipt with URLs and metadata, rather than fetching image bytes. Desktop downloads the public HTTPS layers without credentials, validates them and stores the existing Host-owned private assets. This avoids coupling supplier CDN origins to the gateway API origin. URL expiry can prevent delayed downloads; delivery errors must not resubmit paid generation. Inline historical receipts remain compatible.

## TTS and music routing correction (2026-10-28)

Platform never forwards media generation to llm-ha. TTS and music retain their
Desktop task API but Platform calls MAIC directly: the internal Doubao TTS route
uses MAIC's native speech adapter, and the mxapi music route uses its existing
music adapter. The Platform llm-ha media proxy is removed. MAIC owns supplier
credentials; Platform owns task admission, quotes and charging. Images and layer
decomposition continue to go directly from Desktop to the gateway as above.
