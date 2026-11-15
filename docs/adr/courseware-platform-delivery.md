# ADR: Separate complete courseware synchronization from platform publication

- Status: implemented locally, 2026-11-10; database migrations and live deployment remain separate.
- Scope: new desktop complete MAIC deliveries. Legacy PPT/PDF import and legacy publication retain their existing behavior.

## Context

Local authoring, cloud draft synchronization and publication have different revision boundaries. Combining them could replace online content during authoring or create duplicate courses and releases after a lost response.

## Decision: authority and version boundaries

Rust Host owns a local delivery journal, scoped by workspace, authenticated principal (platform origin, tenant and user), and portable document ID. Main verifies saved source bytes, exports the complete MAIC/PPTist archive with existing audio/media, uploads it, and calls the authenticated platform API. Renderer supplies an action and session, never a source path, ZIP payload, signing key, tenant or arbitrary remote endpoint.

A native snapshot uses the same verified conversion worker as fixed playback and the existing native-to-MAIC timeline conversion. Conversion warnings require approval tied to the exact document fingerprint; unsupported teaching steps and missing narration audio stop synchronization. Objective questions retain their PPTist page and narration, followed by a standard MAIC Quiz preserving options, answers and reference grading. Discussion checkpoints remain discussion checkpoints. No LLM, OCR or TTS generation runs in the synchronization importer.

Platform allocates one course for `(tenant, documentId)` and a deterministic cloud classroom ID before the remote import. MAIC commits an immutable revision and the operation receipt together under a database lock, with an expected draft revision. Retrying the same operation recovers its original result. Reusing its ID with another payload fails. Resources are verified by hash/MIME and uploaded under content-addressed keys. Complete imports require PostgreSQL.

Synchronization moves only the cloud draft pointer and the platform synchronized-revision pointer. It preserves online status, released revision, signed ZIP URL, title, duration and content version. Revision metadata is snapshotted as well as slides/actions/manifests, so later authoring metadata cannot rewrite an older package.

Publication pins the synchronized revision and expected online version/release sequence. MAIC prepares a signed ZIP under an immutable revision-specific key before platform changes online fields. Platform commits the new URL, released revision and content version together, then projects publication status to MAIC. The local package URL is the authoritative download; a failed MAIC projection is recovered by retrying the same operation or reading delivery status. Monotonic release sequence prevents delayed projection from regressing a newer publication or unpublication. Repeating an already completed publication does not create another content version.

## Authoring and conflicts

Both desktop UI and Main block publication of never-synced documents, changed saved source bytes, unknown/pending synchronization, or a cloud draft different from the synchronized revision. They prompt synchronization first and never synchronize implicitly during a new publication. A pending publication is recovered as the original request, even if local authoring has since continued; that recovery does not publish the later edits.

Cloud draft edits use expected-revision compare-and-swap and preserve the online revision. Desktop will not silently overwrite a changed cloud draft. An explicit replacement action names the displayed cloud revision; a later cloud edit invalidates that approval. Replacement affects only the draft. This is a one-way local-to-platform workflow; downloading and merging cloud edits into native PPTX is outside this change.

For managed courses, platform metadata callbacks cannot update the online package or unpublish a course. Generic MAIC publication is blocked. The management API explicitly requests drafts; ordinary managed classroom reads select the released revision. Online downloads remain the released package while authoring continues.

## Failure and retention

The local pending intent is saved before submitting sync/publication. Transport timeouts and process restarts retain the exact operation ID and pinned upload/revision. Definitive validation/conflict responses clear that intent and require a fresh action. A response lost after MAIC commit is recoverable through its receipt even if the platform transaction rolled back. During a failed first import a platform draft placeholder may exist, but retries reuse it.

This implementation uses bounded synchronous platform/MAIC calls with progress shown as working. Network errors can leave the outcome unknown until retry/status recovery. It does not claim a distributed transaction across MySQL, PostgreSQL and OSS. Immutable revisions/packages and receipts are retained; object garbage collection is not added here.

## Deployment and validation

1. Apply `evo-trainwise-platform/src/main/resources/db/migration_20261110_courseware_delivery.sql` to the platform MySQL database before deploying code that reads the new course fields. New database bootstrap schema includes these additions.
2. Run MAIC's registered Drizzle migrations, including `0007_courseware_delivery.sql`, before deploying the versioned endpoints. Existing unregistered checkpoint migration behavior is unchanged.
3. Configure matching platform `trainwise.openmaic.internal-api-token` and MAIC `TRAINWISE_INTERNAL_API_TOKEN`. MAIC needs PostgreSQL, OSS upload configuration and `CLASSROOM_PACKAGE_SIGNING_KEY` (existing signer). The desktop upload/public OSS origin must match MAIC's configured public OSS origin.
4. Deploy MAIC, platform, management web and desktop together. An older desktop continues to use its legacy PPT import path; only courses with `courseware_document_id` use these new publication semantics.

Automated checks cover complete archive validation, real PostgreSQL concurrent import receipts/CAS, signing and immutable package keys, old published pointer preservation, tenant isolation, Main publication guards, restarted sync/publication recovery, explicit cloud overwrite, warning approval, native canvas/audio/Quiz projection, platform prepared-publication sequencing, and existing import/save/publish regressions. Live authenticated desktop-to-platform-to-MAIC publication still requires a configured deployment.
