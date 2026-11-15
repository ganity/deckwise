# Courseware interruption and native recovery repair

## Changes

- Full-deck audio recovery uses the guarded direct native router until the batch
  is saved. Coordinator reads previously flushed the batch's own pending writes,
  changed its source hash and rejected subsequent speech adoptions. Source,
  owner, revision, page, speech and lock checks remain in force.
- Successful executed tools replenish one silent-response continuation. Failed
  tools and consecutive unusable replies do not. Existing saved tool results
  remain in the conversation, and repeated failure is visibly retriable.
- The paired document module resolves nested PPT-master Quiz objects and handles
  template prefixes and wrapped questions. It rejects unowned group content and
  concurrent nested edits. The module was rebuilt/staged into the local client.

## Validation

Before the audio fix, the new implicit-save regression failed after the first
adoption with source-change errors. Before the runtime fix, the successful-tool
regression continued only once rather than twice. Both now pass. The tests also
cover a true external source change and a failed tool without a retry reset.

- Native tools: 50 passing tests, including retained/manual audio, original-order
  recovery, partial saves, ambiguity and fresh audio count/job status.
- Runtime, workflow tools and workflow recovery: 388 passing tests, including
  consecutive empty responses and retained real tool results.
- Classroom image and error UI checks: 8 passing tests. Continue uses the current
  conversation; it does not rewind successful tool work.
- Desktop and runtime type checks and production builds pass.
- Paired document projection/native teaching: 41 passing tests; scoped lint and
  type checks pass. A real grouped Quiz fixture passes native picture adoption,
  save and reopen with unchanged teaching actions.

The restarted local client also adopted the original completed Quiz A image
order, saved and reopened the four-page Master lesson. Its original order and
idempotency key were checked; no quote or submit was invoked. All teaching actions
remained equal. A query for option B returned `not_submitted` for that formal
selection; it remains missing. Earlier ad hoc image requests have unknown outcomes
and must be reconciled independently before any replacement purchase.

This is a recovery repair and fixture/client verification, not another three-path
paid generation run. Full native slideshow playback and invoice reconciliation
were not repeated. The earlier narration-count deviations remain recorded in the
generation report; this repair preserves the saved speech and audio.
