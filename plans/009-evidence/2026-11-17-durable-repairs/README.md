# Durable native repair fix and state-transition review

## Outcome

The native repair failure that disappeared after runtime recreation is fixed in the production document runtime. Required repairs write a pending record before model work, using the existing Host SQLite KV database and revision CAS. Normal document switching/restart loads that record. A passing broad LLM review cannot clear it. Clearing requires successful non-retained full narration/effect work and a successful document save; object-alias-only updates do not qualify. Failed writes, reads and stale CAS fail closed.

No existing business approval, page budget, original media identity, required validator or retry threshold was relaxed. This adds a narrowly scoped persistence record, not a new workflow engine. All routes use the same document runtime adapter. Native state is not stored in the canonical-project workflow mirror, because that mirror is not authoritative for native documents.

## State transitions reviewed

| Transition | Finding and behavior | Evidence / limitation |
|---|---|---|
| Required repair starts → model call | Previously only semantic failure was remembered after the call; a crash could lose it. Pending is now persisted first. | Storage-unavailable test proves no model call occurs. |
| Required repair fails → runtime recreated → final review passes | Previously falsely ready; fixed through durable page-specific record. | Three-route fixture recreates tools; Host test closes/reopens SQLite. Not a full Electron crash test. |
| Repair succeeds → native save → guard cleared | Clear follows successful save. If saving or clearing fails, completion remains blocked. | Save/clear failure injection passes. A crash after save but before clear may conservatively retain a pending issue; it cannot falsely pass. |
| Peer save / page reorder → completion | Source SHA or page number alone cannot erase or misassign the failure. | Stable-page-ID assertions pass. |
| Delete page → Undo | Removed pages do not block present content; restoring the page restores its unresolved issue. | Explicit deletion/Undo fixture passes. Records are not silently garbage-collected. |
| Alias-only repair → semantic completion | Alias evidence is insufficient to clear failed narration/effect repair. | Covered by three-route fixtures. |
| Paid task submitted → unknown/running/ready → adopted → saved | Remote “ready” is not local completion. Existing original-order queries and adoption are retained; refresh never replaces an unknown order. | Existing audio/assessment/recovery suites pass. No new real paid task in this round. |
| Save reply lost → reconcile | Existing readback preserves acknowledged writes and does not blindly repeat mutation. | Native narration tests pass. Uncertain saves still block document handoff. |
| Cancel/owner change → queued or in-flight work | Queued work cannot open/mutate another document; running native work is serialized against handoff. Partial writes are flushed. Stale activity cannot revive a stopped turn. | Existing document-router and lifecycle tests pass. Persistent pending state survives an interrupted repair. |
| Structural ready → semantic review → actual playback → publish | These remain distinct. A successful LLM review does not prove audio playback or authorize publication. | The prior 12-page/28-clip real run is historical artifact acceptance, not evidence for this new binary. |
| Candidate retry budget → runtime recreation | **Remaining risk:** `CoursewareCandidateCoordinator.nativeNarrationRetries` and content-failure maps are instance-local. The candidate map resets on explicit new turns as designed, but recreation within one turn can also discard it. Native continuation bypasses the canonical checkpoint branch. | Source-confirmed lifecycle gap; current fix prevents failed-required-repair auto-completion, but does not persist every generation retry counter. This round does not demonstrate duplicate charges from it. |
| Long-running Agent → ten-minute no-progress stop | The stop remains truthful and bounded, but saved-state progress can lag successful remote tasks. | Earlier fresh Scene needed explicit continuation; the precise live scheduling/adoption delay remains unqualified. Do not increase timeouts to hide it. |

## Remaining priorities

1. Characterize same-turn document A→B→A recreation against exhausted native candidate budgets, then retain budget identity through the existing durable recovery mechanism if confirmed at the executable boundary. Explicit new-user-turn authorization must retain its existing semantics. Do not claim the canonical checkpoint tests cover native budgets.
2. Add an installed Electron crash/restart journey with a pending required repair, followed by an actual successful repair. This round independently verifies Host durability and native-tool behavior; it does not run the combined visible app crash journey.
3. Reproduce the Scene adoption delay with task/turn timing and original receipts before changing scheduling or no-progress rules. Model latency, queue waiting and missing adoption must not all be relabeled provider failure.

## Boundaries

Keys include workspace, session, canonical source path and native project identity. Peer autosaves cannot clear state. A replacement with a different path/project does not inherit it; replacement with the same identities conservatively retains the guard. This favors avoiding false completion over automatically assuming a manual replacement fixed the issue. Only current page IDs contribute completion errors. The Host validates bounded entries, source ownership and CAS; it never infers completion from stored state alone.

Failures already lost by the **old** runtime cannot be reconstructed by this change. Existing artifacts still need current saved-content review. A retained pending issue after a crash between successful document save and record clearance requires explicit repair/reconciliation; the implementation does not invent a successful receipt.

Desktop and Host must be rebuilt/delivered together for the new `courseware.nativeRepairs.read/write` RPCs. An older Host rejects the call rather than returning ready. The companion editor source is unchanged by this repair. No commit, merge, deployment, paid model call or release qualification is claimed.

## Validation

- Desktop targeted suite: 221 passed, zero failed/skipped. Includes the three route-specific durable-state regressions and two storage-adapter tests.
- Host: native repair persistence test passes after closing/reopening SQLite, with CAS conflict, read purity, project isolation and path rejection checks.
- Desktop typecheck and production build pass; Host release build and Rust formatting pass. Build logs/fingerprints are attached in this directory after final verification.
- The earlier 1,842 Runtime tests remain prior evidence; Runtime source was not changed in this repair and that count is not advertised as a new run.
- No live provider calls or manual lesson-content edits occurred in this fix. The new candidate needs Desktop + Host together; earlier live-course results do not certify this candidate's installed-app crash behavior.
