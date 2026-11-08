# Courseware failure audit, 2026-11-07

## Evidence and scope

The reported first-page speech request successfully archived all eight speech
assets. Its 2026-11-07 14:19 UTC saved acceptance reported 108 speech actions,
108 audio assets, no missing speech audio, and completion.ready:true. Automatic
focus repair then continued after the requested work and eventually raised the
generic Local request preparation failed error. This was a post-success repair
failure, not evidence that the synthesized speech had disappeared.

The review followed Main narration generation, runtime continuation, assessment
media dispatch, saved Host acceptance and desktop tool-event logging. Regression
tests use actual internal implementations with synthetic model/supplier edges;
Host integration tests use temporary workspaces and databases. Existing user
courseware and paid orders are preserved.

## Confirmed failure paths and corrections

| Failure path | Consequence | Correction |
| --- | --- | --- |
| A local saved-teaching repair invoked whole-deck planning and unrelated evidence reads | An unrelated page or model planning failure prevented a small repair | Skip planning and read only selected body-page evidence for repair |
| Body-slide restrictions were appended to required-action repair prompts | A required question could be simultaneously requested and prohibited | Apply independent-body restrictions only to normal narration generation |
| Retry counters hashed the whole diagnostic list | Fixing one page renewed the remaining page's attempts | Persist counters per page, diagnostic and repair kind; preserve old counters and Host capacity |
| Required repair exceptions bypassed saved-state reconciliation | A lost save reply produced INTERNAL or risked replaying an already saved mutation | Re-read acceptance; finish saved success or stop with the actual missing requirements |
| Optional focus repair failure rejected the successful teaching turn | Available narration/audio appeared to have failed | Preserve playable acceptance, report remaining focus diagnostics and stop advisory retries |
| Repair exception recovery swallowed cancellation | A cancelled operation could be reported as completed or as ordinary repair failure | Propagate recognized cancellation through recovery |
| Unknown assessment submissions remained in automatic polling | A Chat could wait until timeout without a usable outcome | Refresh the original order, report uncertainty and stop without replacement |
| Assessment tool schemas advertised incomplete or mixed target shapes | The model could submit accepted-looking arguments that failed only deeper in Main | Validate context, TTS and image cases before dispatch |
| Narration prompts/schema disagreed with music and wait write constraints | Retained music could be rejected; model-valid waits over 30 seconds failed saving | Retain existing music, still reject unapproved additions, and align waits at 30000 ms |
| Runtime-owned continuation bypassed normal tool events | Automatic work had little visible progress or useful tool logging | Emit existing tool start/end events with sanitized failures |

## Constraints deliberately retained

Required questions/media, exact source and teaching revisions, logical-page and
object identities, manual locks, audio verification, accounting settlement and
unknown paid-order safeguards remain enforced. Advisory focus diagnostics do not
waive missing required teaching. Successful speech, object effects and paid
media cannot be regenerated as a blanket repair. A wait is not a question, and
an empty or stale object binding is not silently accepted as valid evidence.

Speech-only/page-range authorization is stated in the existing agent workflow;
natural-language intent interpretation still depends on the agent. This audit
does not claim a new hard per-turn page authorization subsystem.

## Verification and remaining limits

Targeted regressions reproduce planning failure, contradictory repair prompts,
changed diagnostic sets, legacy/exhausted retry counters, lost save replies,
cancelled repairs, unknown assessment submission, invalid assessment parameters,
retained music, wait bounds and hidden automatic tool execution. Runtime and
desktop checks also cover provider recovery, request deduplication, progress,
transcript compatibility, narration and question media.

Verification passed: 584 runtime tests across 16 test files, 137 related
Desktop checks, and three real Host integration checks. The Host run preserved
four original speech actions, used one model repair delta and one video adoption,
and made zero provider calls. Runtime/Desktop type checks and builds passed.
The integration fixture follows the current independent-assessment contract;
its body-media repair no longer embeds an obsolete inline question. The separate
assessment integration verifies real Quiz/checkpoint compilation and persistence.

No new live paid generation or native Office playback is used as verification.
Provider outages, insufficient balance, unavailable files, actual revision
conflicts and genuine model-output errors can still fail. Those failures must
retain successful assets and original task identities; passing local tests does
not establish that every provider or every existing course is error-free.
