# ADR: Courseware video uses the user gateway and direct CDN download

- Status: accepted
- Date: 2026-11-13

## Context

The existing Desktop video path depended on the retired Platform media-task API,
and the internal llm-ha relay did not provide the owner-scoped public workflow
needed by Desktop. Seedance returns asynchronous task IDs and short-lived signed
video URLs. Proxying the media bytes through either service is unnecessary and
creates an extra credential and bandwidth boundary.

## Decision

- Desktop submits video through the public llm-ha gateway using its current
  Platform user identity, quote, original idempotency key, and request hash.
- llm-ha validates the configured Seedance account/model binding, reserves and
  settles through the existing Platform courseware billing API, persists the
  owner-scoped receipt, and never repeats an uncertain provider submission.
- Video quotes use 720P and eight points per requested output second.
  Plans may select 4–30 seconds for each video; legacy slots without a duration
  retain a five-second default. Desktop carries the same duration from the
  saved intent into the quote and confirmation. The gateway enforces that
  duration and 720P in the provider request; conflicting native options fail
  before reservation. Ratio and audio options remain caller supplied.
- The quote signature binds the duration. Success settles the quoted target
  duration, failure releases the whole reservation, and retries retain the
  original intent and duration. Saved-video request hashes remain compatible
  with existing Host intents; optional native parameters remain hashed.
- llm-ha validates the provider task and returns its signed HTTPS URL without a
  CDN domain whitelist or persisted signed URL. Legacy CDN configuration edits
  do not invalidate submitted task receipts. A ready-task read retrieves a fresh provider
  status and returns the URL only after owner and, for team work, current
  membership checks.
- Electron Main fetches the returned URL directly with cookies and authorization
  omitted, redirects refused, and a bounded timeout/size. It accepts supplier CDN
  domains without a hardcoded domain list, while retaining HTTPS and response-origin
  consistency checks and rejecting embedded credentials. It verifies MP4
  content and container, hashes/decodes it, and sends bytes to Host for durable
  local archive and normal saved-page adoption. The 40 MiB archive limit keeps
  Base64 JSON-RPC below the existing 64 MiB line limit.

## Consequences

- No Platform video job queue or service-token exposure to Desktop is required.
- Platform deployment must provide the existing billing quote/reserve/settle
  contract for `kind=video`; this change does not add a new billing service.
- Apply Platform’s idempotent
  `migration-20261113-seedance-video-720p-price.sql` with the release. It adds
  the global Seedance 2.5 rule and preserves existing operator/tenant overrides.
- Provider URLs are temporary and may be download-count limited. Desktop must
  download promptly and never store or log the signed URL; callers may retry a
  failed download by refreshing the owner-scoped task, never by resubmitting.
- End-to-end billing, provider availability, playback, and packaged Desktop
  acceptance still require deployment/runtime verification.
