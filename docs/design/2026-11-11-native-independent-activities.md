# Native body narration and independent activities

## Failure and cause

The imported 56-page fixture retained ten speech actions and a short-answer
checkpoint on original page 48. No activity insertion had occurred. Native body
narration enabled independent-assessment validation only when optional teaching
metadata existed. The editor then inferred Quiz from a short-answer checkpoint,
hiding the body editor while preserving the lecture in the carrier.

PPT Master without requirements shared this gap. Scene planning normally provided
the guard, but the native editor projected every origin as plain and could lose
that protection when optional metadata was absent.

## Implementation

- Enable the existing independent-assessment validation for every native body
  narration request, including the single-page selected-source entrance.
- Reject required-action repairs that would add a question to body narration.
  Existing non-native assessment repair behavior remains supported.
- Identify assessment pages from saved Quiz content, generated page requirements
  or a bound accepted activity unit. Original/planned body pages retain their
  lecture editor even when historical actions contain questions. Legacy standalone
  activities may retain their editor when only checkpoint/question-reading actions
  are present. Short-answer checkpoints follow their accepted activity purpose.
- Use that editor classification for body-generation exclusion rather than treating
  any checkpoint as proof of a dedicated assessment page.
- Insert accepted activities through the existing physical-page/Undo route. Visible
  practice text on an original page does not force conversion. Duplicate checks
  target bound independent activities; acknowledged insertions reuse their IDs.
- Synchronize the shared teaching skill, tool instructions and narration spec.

No persistence schema, provider integration or additional dependency is introduced.
Original page order, IDs, narration and media are preserved during insertion.

## Validation

- The original deterministic reproduction failed for plain/import and now passes
  for plain/import/scene: model-generated assessment blocks never save to a body.
- Desktop narration, batch, native-tool and scene-plan suites: 163 tests passed.
- Runtime narration-writer and workflow-tool suites: 71 tests passed.
- Native document teaching suite: 35 tests passed, including actual physical-slide
  insertion, retained original speech/audio, historical mixed-page routing and
  accepted short-answer activity purpose.
- Desktop/document TypeScript checks, runtime build and isolated editor-module
  production build passed. The editor build retained its existing chunk-size warning.
- Read-only replay of the actual saved fixture selected the body editor for page
  48, retaining 56 pages, ten speech actions and its historical checkpoint.

## Delivery limits

The running desktop installation was not replaced or restarted. No live model/TTS
requests or full interactive generation runs were performed. Historical questions
were not silently extracted, deleted or expanded into new slides; the requested
activity plan must govern any later migration of that saved content.
