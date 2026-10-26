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
