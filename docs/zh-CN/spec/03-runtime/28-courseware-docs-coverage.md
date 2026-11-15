# WiseOffice 能力覆盖

> **原文镜像说明：** 本页保留完整英文规范，尚未提供全文中文译文。协议字段、约束和验收条件以 [英文源规格](/spec/03-runtime/28-courseware-docs-coverage) 为准。

Main's authenticated `CoursewareOnlineEditingClient.verifyNativeBarrierCoverage`
accepts project, positive session epoch, barrier UUID and optional cancellation.
It makes one bodyless POST to the Platform native barrier's `verify-docs` route.
It does not retry an uncertain request or accept response data after cancellation
or a changed authenticated principal.

The exact Main-only response includes project/epoch/barrier, pause UUID, document
key, verification timestamp, unique finite Docs user IDs, coverage scope,
authoritative-coverage boolean, reasons and `consistentPublicationReady:false`.
Unknown fields, wrong requested scope, malformed IDs/timestamps, duplicate users,
contradictory reasons/coverage or claimed publication readiness reject. A positive
observation requires a nonempty distinct mount identity list and no failure
reasons. A negative response preserves unknown editing IDs for investigation.
The key remains private to Main; neither this DTO nor the method is exported
through Shared, preload, IPC or Renderer.

Platform checks Owner authority, pins an existing active epoch/key/pause and
editing roster in one transaction, calls the trusted signed Docs info command
outside SQL locks, then rechecks unchanged scope and fresh held native reports.
This lock separation permits the synchronous status callback caused by info.
Only a managed epoch whose expected editing mounts exactly equal the actual
Docs editing-user set can obtain positive coverage. Viewers cannot write and
Docs excludes them from this editing-user list.

The support scope is the single DeckWise issuance/mount workflow with a distinct
signed Docs user per mount. Docs deduplicates one original user ID; manually
copying one config into multiple connections is outside this support scope.
The point-in-time response is not a reusable publication authorization. The
existing registry-only barrier remains nonauthoritative. Verified capture uses
fresh server-side checks as described below; it never consumes an old Main DTO.
Live-engine acceptance and package publication are separate gates.

Validation scenario: check one frozen, held managed roster; obtain positive
coverage while publication readiness remains false. Remove/add actual editing
users, expire a native report, change scope during HTTP, fail the command,
cancel, or switch account: no positive evidence may survive. Main transport
contract tests use the real client and mocked external HTTP edge; Platform
database tests exercise the real registry, pause, callback and local HTTP server.

## Verified save and capture transport

Main adds three explicit methods with no Renderer/preload payload change:

- `requestBarrierForceSave(projectId,epoch,barrierId,requestId,documentKey,signal?)`
  sends exact `{requestId}` to the native barrier's `/force-saves` POST and
  validates the existing SaveRequest against epoch, request and native key.
  Polling uses the existing `getForceSave`; an uncertain POST is never retried.
- `captureVerifiedSourceReview(projectId,input,signal?)` accepts the original
  exact source-review input plus required barrier UUID and sends it to
  `/teaching/verified-source-reviews`. It snapshots the complete input before
  authentication and validates the full returned reviewed tuple.
- `getVerifiedSourceReview(projectId,snapshotId,signal?)` reads only that
  verified route. A missing/failed verified read never falls back to the ordinary
  source-review primitive. Recovery does not require the editing barrier to
  remain held after the immutable snapshot was successfully captured.

Platform uses the additive native-save binding table. Both mutating routes
require Owner, managed/all-registered-held state and fresh Docs info before the
final locked transaction. The save row and barrier/source/teaching/key binding
commit together before the forcesave network request; synchronous callbacks
cannot deadlock on that transaction. The matching authenticated archived
status6 callback also resolves an unknown command to success. Capture repeats
fresh coverage, verifies the binding/archive, then atomically creates the
ordinary immutable review and its verified origin. Existing ordinary snapshots
with the same ID cannot be promoted. One bound save admits one snapshot ID.

Verified recovery requires current membership and checks persisted origin,
baseline/epoch, force request and callback/hash/length. Resume and later live
teaching edits cannot change this R8 input. Neither transport nor service builds,
publishes, resumes editing or invokes paid generation.
