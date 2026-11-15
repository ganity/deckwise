# Fixed-version six-page courseware reverification

Result: FAIL — the new independent task stopped during planning. No complete
courseware was produced. This is not an unattended-generation pass.

## Task and environment

- Session: `771113b1-f168-490c-ac9e-c49a7a39fc98`.
- Title: 家庭成员英语课件·6页固定版本复验 20261108.
- Created: 2026-11-08 10:51:17 China Standard Time.
- Runtime: the existing Desktop instance from `feat/courseware-par-A`; no source
  edits, builds, application restarts or database writes by the test operator
  during this run. Normal product IPC remained the write owner.
- Provider/model: deckwise-managed / deepseek-v4-1-flash, reasoning off.
- Scene path, story first, kindergarten senior class, bilingual English.
- Warm watercolor children's storybook; scene-master / scene-layers.
- Body/question TTS: doubao-tts / zh_female_yingyujiaoxue_uranus_bigtts.
- Quiz option model: scene-master.
- Four body pages, one four-option picture Quiz, one interaction checkpoint;
  hard total maximum six, with no additional cover or summary page.
- Family vocabulary: father, mother, grandfather, grandmother, brother, sister;
  album introduction using “This is my family!”. Required body music, detailed
  narration/audio, question audio, four option images, object focus and animation.
- Independent new story and assets; no previous task/order reuse.

## Actions and evidence

1. Initial story turn `fd80dd8d-74dd-4d5a-a0fb-cb8df4fc6095` saved revision 1
   successfully. The story explicitly described four body pages plus two
   assessment pages and said opening/review beats must not add physical pages.
2. The operator reviewed and approved that story through the normal product IPC
   at 10:52:41. Approved story SHA-256:
   `48b9932972640ce7edb876580bd304062773e5ab40ad7d0dfaee77fe59d03b1e`.
   This was an expected review gate, not fault recovery.
3. The normal story-approval continuation started planning turn
   `368cdc3d-425c-4550-a0ec-faf59a80cfcd`. No operator correction or resume prompt
   was sent after that turn began.
4. At 10:53:19, the first draft had seven physical pages: opening, father,
   mother, grandparents, siblings, Quiz, interaction. It added an opening page
   despite the explicit total/body limits. Its interaction page also contained
   lecture, visible text and required illustration objects, which the assessment
   contract forbids. Automatic submission exposed only
   `COURSEWARE_WORKFLOW_FAILED`; a subsequent explicit submission exposed the
   concrete assessment-page validation error.
5. The agent rewrote the plan once. It separated the interaction lecture into a
   body page and appended a clean interaction checkpoint, yielding eight pages:
   six body pages, one Quiz and one checkpoint. At 10:53:53, automatic validation
   rejected the new draft because `6 > 4` body pages.
6. At 10:53:58, the next submission was rejected by the final-reporting guard.
   `agentGetStatus` subsequently confirmed `isRunning: false`, no pending tool
   confirmations. The session ended on the rejected tool call without a useful
   final assistant report.

## Findings

1. **Planning does not reliably preserve the approved physical page budget.**
   The approved story contained eight narrative beats, explicitly mapped to six
   pages, but the planner added opening/interaction-lecture body pages. The
   validator correctly refused the invalid output; weakening it is not a fix.
2. **Planning error detail differs across execution paths.** Automatic
   validation returned the generic workflow error while explicit submission
   exposed the assessment constraint; workflow UI reads later exposed the body
   page limit. The agent was not consistently given the exact actionable error.
3. **Recovery/final reporting did not complete correctly.** In
   `CoursewareTurnContinuation.finish`, failure budget increments on failed
   validations, including repeated submission of unchanged bytes. The observed
   three failed validations included only one rewritten draft. The final
   reporting guard then rejected another model tool call and the turn ended
   without the requested plain-language failure report.

The third finding explains why merely increasing retry counts is insufficient:
retries must operate on the saved draft and exact validation error, preserve all
user constraints, and end with a truthful visible report when bounded recovery
is exhausted.

## Verification limits

- Expected approvals: one story approval. Fault-recovery prompts: zero.
- Fatal provider/INTERNAL assistant error cards in this session: zero; tool
  validation failures and abnormal final reporting still blocked the task.
- No image/decomposition, narration, audio, option-image or music generation
  tools were reached. Text-model calls did occur. Do not describe this as a
  zero-cost run.
- The prior HTTP400 schema and assessment-audio refresh fixes were not exercised
  end to end because this run stopped before those stages.
- Raw session evidence:
  `/home/jhz/.deckwise/sessions/771113b1-f168-490c-ac9e-c49a7a39fc98.jsonl`.
- Saved invalid draft:
  `/home/jhz/code/train/deckwise-desktop/apps/.deckwise-ppt/scenes/771113b1-f168-490c-ac9e-c49a7a39fc98/plan.json`.
- Operator monitoring scripts: `/tmp/deckwise-repeat-verify-v2cHvF`.

No corrective source changes or manual continuation were applied to turn this
failed baseline into an apparent clean pass.
