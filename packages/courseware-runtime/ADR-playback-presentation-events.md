# Fixed playback presentation observers

Status: accepted for the independent D module, 2026-10-19.

The existing public player exposes mode and page events but keeps the core's
narration and teacher-checkpoint events inside its UI. The planned classroom
consumer needs those events to present a speaking/waiting role. Its legacy global
player starts parsing and TTS managers, so importing it would create a second
execution authority.

Expose five existing optional core callbacks through the fixed player and its
existing mount props. Reuse core callback types and the existing callback ref;
copy mutable payloads before observation. Keep the core, audio clock, scheduler,
package schema, controls and authorization resolver unchanged. Existing callers
need no changes. A second classroom engine or polling clock is rejected.

Observers are synchronous and must not throw or block. Null progress and existing
mode/page events reset presentation after cancellation; normal speech end and
checkpoint completion retain core semantics. This adds observation only, not a
control, persistence, adoption or authorization API. Real classroom mounting and
platform-authorized retrieval remain separate integration gates.
