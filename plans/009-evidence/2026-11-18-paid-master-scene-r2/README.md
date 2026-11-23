# Fresh paid full-lesson rerun with exact DeepSeek Flash

Two independent new lessons used `deepseek-v4-1-flash`: grade-3 mathematics
(fractions) through PPT Master and grade-7 geography (water cycle) through Scene.
Each plan has two body pages plus independent choice and short-answer pages,
for four physical pages and a five-page ceiling. Real image/decomposition and
available TTS jobs were used. No application code, validation rule, or supplier
receipt was modified to obtain acceptance. This is not an Import-route rerun.

## Current result

Neither route achieved autonomous full-lesson acceptance. Scene has saved images,
layer metadata and activity audio, but no accepted body narration/effects. Master
initially stopped before adoption; two operator diagnostic continuations recovered
adoption, after which body narration still failed. These interventions are not
counted as autonomous success. Full process restart and native reopening passed for both incomplete lessons: source
hashes, page actions, saved audio bindings and assessment data were unchanged.
See [final results](summary.json).

## Confirmed progress from the preceding repair

- Scene generated two new Visual Masters, two decomposition jobs and 19 foreground
  layers. All 19 names/descriptions reached the actual narration context and the
  saved native PPT. Each persisted `deckwise-layer/1` hash matches the corresponding
  embedded PNG. The two activity speech files are present and decode to 9.888 and
  5.640 seconds. Neither body has saved narration or visual cues.
- Master exported real numeric OMML `1/4` and `3/4`. Native adoption succeeded after
  the validation-order recovery, and its narration context contains both fraction
  texts and mapped identities. The production byte worker and actual formula rendering component also passed for
  both fractions: [render](master/fractions.png), [checks](master/parser-result.json).
  Notes-master and two unsupported original animation-structure warnings remain.
  Full original animation fidelity is not claimed.

## Failures and recovery boundaries

### Master: directory, argument and validation order

The model first invoked a nonexistent requirements tool and recovered. It later
passed an export path relative to the project as though it were relative to the
workspace. Its attempted correction malformed nested `pages[].teaching` and
omitted required fields; the argument retry limit stopped the turn. One operator
continuation supplied the actual absolute path/hash and explained the nesting.
The model then had to restore exact agreement with the saved assessment plan.

The next barrier was reproducible: `animations.json` was newer than
`validation/svg_quality_report.json`, although older than the newly exported PPTX.
The Host checks both timestamps. Re-exporting without re-running the final SVG
quality check therefore cannot clear the gate. A second operator continuation
identified that exact stale report. The official checker ran with zero errors;
adoption then succeeded without changing application code or relaxing freshness.
The generic conflict message failed to identify the offending file/report.

### Shared narration: invalid targets and contradictory requirements

Scene's first proposal exhausted its initial attempt plus two repairs on both
body pages with `Unknown or duplicate attention target`. All 14 object IDs in
the parent proposal's instruction match current context IDs; the rejected child
responses are not exposed in the receipt. The evidence does not establish whether
the child invented an ID, repeated one, or mishandled a short reference. Later
unchanged-page calls were blocked by the shared retry ledger without buying a
replacement image or resetting the budget.

Master's parent proposal invented a stricter requirement: page 2 must bind
`spotlight-field`, although that page contains `spotlight-numerator`. The reviewer
repeated this nonexistent-target requirement as a user requirement. Other findings
include actual narration/target disagreements, incomplete initial object discovery,
and invalid semantic-review JSON after bounded format repair. Neither body draft
was saved. These are distinct from the repaired native-fraction parser.

### Final content review

Scene's final review returned `CONTENT_REVIEW_INVALID` (invalid `issues` /
current-question `analysisCorrections`) on body pages. An earlier review also
reported absent narration and effects. This is not evidence that the generated
water-cycle pixels are wrong. Completion remained false, as it should.

## Saved artifacts and playback boundaries

Both native documents reopen unchanged after a full Desktop process restart.
This proves persistence of the incomplete state, not completion. Master snapshot
capture correctly refused missing audio assets; no playback package was forced.
Scene could build a limited preview after reviewing only its notes-master warning.
Its first body page has no saved actions and stayed idle in the actual player;
the probe was stopped without claiming natural audio/effect/full-course playback.
The two saved Scene audio files were hash-checked and decoded with ffprobe.

## Next repair priorities

1. Report the exact invalid target and available short references in narration
   validation; preserve enough bounded, sanitized candidate evidence to distinguish
   unknown IDs from duplicates. Reproduce that specific failure before changing
   matching behavior.
2. Ground parent effect instructions in the current page's actual objects. Generated
   SVG names or parent-invented constraints must not become new user requirements;
   keep the requested fade, spotlight and highlight gates.
3. Give adoption a concrete offending-file/report diagnostic and keep the official
   final-check/export sequence explicit. Correct relative paths against their declared
   base; never weaken workspace confinement or source freshness.
4. Make structured-review failures actionable and bounded, including absent fields
   and stale question IDs. Preserve independent LLM review and all business gates.

## Candidate and limits

The paired Desktop, Host, runtime worker and Office editor builds were staged before
starting. See `candidate.json` for hashes. Refreshing remote main failed with
GnuTLS `-110`; the recorded local origin/main is the tested base. This does not
qualify a current remote integration candidate, a release, all grades/subjects,
a success-rate comparison with par-A, or a three-route pass. No platform publication,
commit, push or deployment was performed. Local raw logs and artifacts remain under
`/home/jhz/deckwise-validation/master-scene-paid-20261118-r2`.
