# 23. PPTX candidate tools
### Host-inspected current-slide native fade

`ppt_set_slide_fade` is an optional finite native tool with exactly
`{editGeneration}`. It requires fresh `set_slide_fade` capability and current page;
no caller-selected page, effect, duration, hash, bytes or script. The fixed result
is `{page, transition: "fade", durationMs: 750, verified: true, saved: false}`.
Exact request/session/generation/page and fixed-effect receipt checks apply. A
missing capability falls back to the existing guarded clean-copy candidate path;
there is no implicit fallback edit, retry or save. Existing peers stay compatible.

The capability is withheld until the trusted Host has inspected the actual latest
clean saved PPTX and privately bound its source/slide hashes and canonical mapping,
locks and native context. Office review uses `document:review-fade`; execution uses
only `document:execute-fade` with the same private authorization. An ordinary native
command cannot inject a grant. Save, dirty/readonly, context/session or authoritative
source changes invalidate it. The descriptor is compatibility evidence, never a
permission token. Main must keep existing high-risk permissions and Plan/Goal
restrictions. Public registration, source/canonical authority, IPC and installed
package mounting remain A-owned and are not enabled by this B module.

Scenario `E2E-PPT-inspected-native-fade`: inspect actual saved bytes, review exact
current page, invoke the finite Agent tool through new production Office embed
messages, verify one-action Undo/Redo and two acknowledged save/reopen rounds.
Reject dirty, stale page, readonly, replay and ordinary-channel bypass. Independently
verify only the target transition changes and existing object timings, peer slides,
notes, media, relationships and global loop remain. Module/native evidence is
distinct from existing Main Chat discovery/permission and product acceptance.
