# Explicit recovery of unsubmitted courseware images

- Status: Accepted
- Date: 2026-10-26

## Context

A restored lesson can contain a prepared cover without a submitted task while
later pages already have archived images. Querying that intent cannot generate
its image. Treating this as style review leaves the teacher with no image to
confirm; silently making all refresh calls generate risks duplicate paid work.

## Decision

Extend the existing sequential image-refresh tool with optional
`generatePrepared:boolean`, default false. True dispatches the existing Main
generation service only for the same current, known prepared intent, with the
existing plan, account, session, turn and first-page-style guards. All other
phases remain query-only. Model rebinding stays owned by the generation service.

## Consequences

Existing callers preserve their query-only behavior. The Agent can resume a
known unsubmitted request explicitly without creating another intent. No Host
protocol, journal format, permissions or billing semantics change. No-asset
results explicitly report that human selection is unavailable; only verified
images may be offered for review. UI and skill use these actual states.

See [the media contract](../spec/03-runtime/27-courseware-authorized-media.md).
