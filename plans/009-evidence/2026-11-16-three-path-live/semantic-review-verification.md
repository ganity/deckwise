# Narration LLM semantic review — local and real-provider verification

The three automatic generation routes now use the existing authorized narration
model as a separate reviewer before saving body narration and saved-audio effect
repairs. The reviewer receives actual page renders when the configured vision
path supports them, plus current textual/object evidence and logical page
requirements. It supplies concrete issues rather than modifying content itself.
The existing generator/delta repair performs scoped corrections and every
corrected draft is reviewed again before persistence/TTS.

Source identity: [fingerprint](semantic-review-fingerprint.json). This is a dirty
task-worktree source validation, not an installer acceptance. Real-provider evidence follows below.

## Validation

- Regression tests were added first; all four initial review cases failed on
  the previous code because there was no independent reviewer.
- Desktop public batch/native/Chat workflow and Skill tests: **183 passed**
  (`node --test` with `courseware-narration-batch`, `courseware-native-tools`,
  `courseware-chat-workflow` and `ppt-master-skill` test files).
- Agent Runtime narration, continuation and workflow-tool tests: **140 passed**
  (`pnpm exec vitest run` with those three source test files).
- Agent Runtime build and Desktop typecheck: passed. The build checks the
  callback contract and emits the runtime types consumed by Desktop.
- `git diff --check`: passed. The existing repository Biome exclusion for these
  paths remains unchanged; no lint pass is claimed.

Model completions are fixtures at the existing external completion boundary;
internal schema/candidate/batch/repair/current-source/save logic runs unchanged.
Existing test fixtures supply a passing reviewer by default; dedicated semantic
cases explicitly control and inspect every review and correction response.

The review-specific tests verify:

1. Plain, import and Scene: an actual current but wrong object is rejected by
   review, corrected by a binding-only delta, then reviewed again before save.
   The spoken paraphrase keeps its words; the arrow label need not be read
   verbatim. Lexical checking does not override the host semantic verdict.
2. Incorrect teacher content is repaired using review feedback; the reviewer
   receives actual image inputs and sees the corrected content before save.
3. Post-anchor block indices refer to the reviewed split blocks, so repair does
   not target the wrong original index or rewrite the spoken words.
4. Three unsuccessful candidates exhaust the existing generation/repair budget.
   Unknown UUIDs still fail before model review; invalid review JSON/schema,
   uncertain evidence and provider exceptions never save an unchecked draft.
5. A failed page does not discard a successful independent peer. A source change
   during review still rejects through the post-review baseline fence.
6. Saved-audio effect repair receives semantic review while retaining the exact
   accepted script and original audio reference.

## Boundaries retained

The existing owner/model/source/CAS/cancellation/deadline checks remain active.
The three content-generation attempts share the existing bounded repair budget;
semantic review adds at most one model call per structurally valid candidate
and does not reset or consume an extra content-generation attempt. Protected
scripts/audio and native save behavior are unchanged. Metadata-only object
repair and explicitly selected source imports retain their prior behavior.
No provider, database schema, job store or approval gate was added.

## Completed real-provider probes, 2026-11-17

Detailed responses, reviewed blocks, saves, timings and source identity are in
[live results](semantic-review-live-results.json). The earlier
[partial results](semantic-review-live-partial.json) remain historical evidence.
The runner and full append-only completion log are at
`/home/jhz/deckwise-validation/narration-semantic-live-20261116`.

All **12 route/scenario probes passed** after completing the interrupted run:

| Scenario | Plain / PPT Master | Import | Scene |
| --- | --- | --- | --- |
| Spoken paraphrase accepted | Pass | Pass | Pass |
| Wrong object rejected, binding corrected, words preserved, reviewed again | Pass | Pass | Pass |
| False heat claim rejected, draft corrected, reviewed again | Pass | Pass | Pass |
| Autonomous planning, drafting, review and captured save | Pass | Pass | Pass |

The model was the real managed `deepseek-v4-1-flash`, with education login and
existing runtime completion/auth resolution. The source text was extracted
read-only from slide 2 of the earlier real water-state PPTX, SHA-256
`169070422aff55ccbd4b0349d9138a570aadb1e93ee5e10897ad38499908b2d6`.
The production shared batch/candidate/repair modules ran unchanged with fresh
in-memory object mapping and a captured save boundary. This tests the shared
logic under all three task types; it is not twelve independently generated
courses or Desktop/native persistence acceptance. No actual images were sent.

The paraphrase controls supplied “冰化成水叫熔化，这时需要从周围获得热量。”
and the saved words stayed unchanged. Review accepted it against
“熔化 → 吸热”. Wrong-binding controls initially highlighted the real supplied
water-vapor object; all three models detected the mismatch and binding delta
repair selected the melting/heat label without changing those words. False
content controls initially said melting releases heat; all three reviewers
rejected that claim, the existing draft repair changed it to absorption, and
review passed before any captured save. The initial candidates in these nine
controls were deliberately seeded; the three autonomous controls used real
planning and drafting as well as review.

The final Plain/Import binding probes and Import paraphrase probe use a fixed
minimal test plan so that unrelated model-invented practice requirements do not
change the candidate under test. The earlier failing attempts are retained in
live results. Scene binding, the other paraphrases and all content/autonomous
probes used model-generated plans. A fixed plan is a test input, not a production
code change or a relaxed business gate.

## Findings and latency

- In the first Plain/Import binding attempts, the reviewer initially reported
  the wrong target, then reported missing follow-along practice from the generated
  plan after the binding was corrected. The shared loop regenerated the unsaved
  draft and eventually saved after review, but the strict words-preserved test
  failed. Isolating binding against a fixed plan established that binding-only
  repair itself preserves words. Real review may expose issues over successive
  rounds; one review does not guarantee an exhaustive issue list.
- Earlier Import paraphrase requests ended with `Error: terminated`. The first
  autonomous Import attempt rejected a learner task as contrary to the request,
  repaired it, then ended with `Response incomplete: length` on re-review. All
  these failed attempts made zero unchecked saves. Fresh bounded invocations
  completed after login. Their failures are retained, not relabeled as passes.
- The append-only log contains **57 completed real model calls**, including prior
  failed probes, and **26 completed reviews**. Review latency was **3.446–83.625 s**,
  with median **15.968 s**. Final successful case traces contain 38 real calls.
  Provider requests that failed before completion are additional and are not
  included in that count. Reported total usage across completed calls was
  213,859 tokens; monetary cost is unknown in the returned usage metadata.
- The 85-test shared narration batch suite was rerun after live probes: all pass.
  `git diff --check` also passes. No production code was changed for these probes.

## Remaining qualification

These results establish real-model text/object semantic review and bounded
repair on one science-page fixture across three task types. They do not close
P7: full UI/native persistence, protected saved-audio repair against a real
provider, actual image grounding, broad subjects/grades, and full image/TTS
course regeneration remain outside this run. Latency, output truncation and
transport failures remain material service reliability limits; review has no
zero-error guarantee. Existing business guards still stop uncertain, malformed
or failed review rather than save unchecked content. The earlier playback
reports establish playback only. Historical P1 attribution remains open.
No commit, push, publication or deployment was performed.
