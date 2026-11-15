# 在线课件源文件审核

> **原文镜像说明：** 本页保留完整英文规范，尚未提供全文中文译文。协议字段、约束和验收条件以 [英文源规格](/spec/04-ux/12-courseware-online-source-review) 为准。

`CoursewareOnlineSourceReview` is a leaf in the existing DeckWise work panel.
Its parent supplies a Main-owned opaque `viewId`, editor `ownerId`, the original
teaching project, and previous/target page and object descriptors. Parser jobs,
archive paths, callback credentials and signed URLs are not part of this view.

Every saved target page requires an explicit choice: carry one previous page,
or create a new page with empty teaching. No page is selected by default, and
neither page order nor object order establishes identity. A previous page can
be carried at most once. Every uncarried previous page requires its own deletion
confirmation; locked pages cannot be deleted. These choices prepare a separate
publication input. They do not mutate local teaching, call the legacy local
adoption workflow, invoke generation, charge a provider or publish.

The review displays the complete previous narration, pauses, retained audio
references, teacher checkpoints and speech-relative cue intervals. For each
carried speech cue, every target requires an explicit `keep`, `rebind` or
`remove` decision. `keep` preserves logical identity and must agree across all
cues, with a one-to-one association to a target object. `rebind` changes only
that cue's target and can differ between cues. Target objects must be eligible
text, shape or image objects on the explicitly associated target page; display
kind and index are review aids rather than automatic associations. Duplicate
resulting targets in a single cue are rejected.

Removing every target requires separate whole-cue deletion confirmation.
Removing a spotlight's primary target requires whole-cue deletion, and whole-cue
deletion requires every target to have been explicitly removed. Cues from a
removed page are not submitted as carried-cue decisions. Host remains the final
authority for the complete pinned decisions.

Each target page has an independent, initially unchecked readiness confirmation.
Changing cue associations invalidates that page's readiness. Changing page
associations clears the association-dependent cue/deletion decisions and all
page readiness confirmations. Confirming a fully associated input with unchecked
pages is allowed and preserves `review` state; this does not grant publication
readiness. Later publication still requires its existing readiness gate.

Optional parent-provided preview callbacks retrieve the actual original or saved
page on demand. The saved callback selects an import page ID; the original
callback selects a previous logical page ID. The parent maps each to that
source's saved page number. Only a PNG data URL is rendered; remote URLs and raw errors are hidden.
Results from a replaced owner/view or superseded request cannot populate the
current preview. Disabled or stale render callbacks cannot submit decisions or
modify the current draft. Replacing the owner/view clears all confirmations.

## Editor entry and Main orchestration

The existing online editor exposes saved-source review to the Owner in the
current Chat. It first checks the current registered-window barrier; Main then
independently requires a held teaching pause and held registered windows before
requesting a server save candidate. This is a review of that server candidate,
not a promise that every possible connection's unsent edits were included and
not a completed team publication.

Main downloads the exact original source revision and archived save bytes,
verifies the source tuples, and parses private read-only copies. It pins the
teaching revision from the held pause and retrieves that revision's complete
original mapping. Original and target parser jobs run sequentially because Host
owns a single parsing slot. The original native editor remains mounted and is
hidden while the review is shown; no reviewed file replaces its source.

The Main-frame-only channels `deckwise/courseware/online/source/{begin,resolve,
preview,capture,clear}` accept finite selectors. Begin takes `{ownerId,sessionId}`;
resolve takes `{viewId,decisions}`; preview takes `{viewId,side,page}`, where side
is `original` or `target` and page is its one-based saved-page number; clear takes
`{viewId}`. Archive URLs, storage paths, document keys, baseline/parser IDs and
authoritative resolved mappings remain private. Resolve returns only the owner
and view, `status:reviewed`, and ready/total page counts.

An active review prevents teaching/native resume until it is explicitly cleared.
Account/editor ownership changes abort work and dispose private review files.
Stale continuations cannot populate a replacement view. Host resolution remains
read-only, including when some pages remain unconfirmed; the UI labels the
result as reviewed and not published. The explicit capture action obtains a verified immutable Platform receipt and
imports its exact source, teaching and authenticated team audio into a Host
snapshot. Capture and build do not publish or resume editing. Real multi-client
and deployed-service acceptance remain separate gates.

## Fixed version, preview and publication entry

After association review, the existing `CoursewarePlaybackPanel` accepts the
opaque reviewed view, owner, current Chat and fixed team project, plus ready and
total page counts. It offers an explicit **Create fixed version** action only
when every page is ready. That action calls Main source capture with only the
view ID and then passes the returned immutable snapshot to the existing fixed
build API. No local native-editor snapshot capture or source adoption runs in
this path. Main still owns capture identity, any unknown-result recovery, audio
transfer and readiness authorization; the UI does not invent a replacement
capture request ID.

The existing conversion warning approvals and fixed player are reused. The
online target team is fixed to the current online project. Shared and formal
channels require a separate, initially unchecked publication confirmation;
changing the channel invalidates confirmation. Building and previewing never
publish or resume editing.

Before sharing, the panel reads the existing session-scoped publication recovery
record. An unknown record blocks any new publication POST. After a lost response,
only status and original-intent receipt queries are offered; no receipt or a
receipt for a different build/target/channel cannot unlock a second POST. These
controls use the existing Main/Host durable share mechanism rather than a new
renderer publication implementation.

Returning to editing first awaits cancellation of the fixed build/player, then
clears the Main source-review pin, and finally reveals the existing editor.
Neither teaching nor native pause is resumed automatically. A failed cancel or
clear leaves the review visible for retry. Subsequent editing requires a new
review and a new immutable version. Local-editor playback retains its existing
view-based input and snapshot-capture API.

## Capture identity and recovery

`coursewareOnlineSourceCapture({viewId})` accepts only a retained Main view. Main
requires a resolved input with every page ready. Its first capture requires the
held teaching/native barrier and the specific force-save originally requested
through that barrier. Platform rechecks fresh supported Docs connection coverage,
the archived callback and the held baseline before committing an independent
verified record. Main compares the complete source/epoch/callback/length/save and
baseline tuple, project and mapping; only the server's new teaching revision may
differ from the resolved input.

The capture UUID is fixed before POST. A lost response only allows GET of that
same verified UUID; a missing result remains uncertain. Decisions cannot change
after submission. A verified receipt or an already captured input can be imported
again after other clients resume R9; the captured R8 remains unchanged. Changed
account, Chat, Host or native epoch still refuses the continuation.

Each speech or music UUID is resolved through authenticated team metadata and
an exact-byte download. Main verifies project, ID, MIME, length and SHA-256 before
private audio staging and sequential saved-source parsing. The Host result must
match the captured immutable tuple. The renderer receives only
`{viewId,ownerId,snapshot}`. A lost Host import reply retains the same captured
input for an idempotent retry and retains its private audio directory because a
late reader may still be active. Other acknowledged staging paths clean their
owned files. This does not generate speech, charge a supplier or rewrite live
teaching.
