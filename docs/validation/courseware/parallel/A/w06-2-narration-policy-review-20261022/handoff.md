# W06.2 narration policy sample review

Date: 2026-10-22. Status: **RULE_AND_COPY_REVIEWED; REAL_MODEL_QUALITY_PENDING**.

This review checks three representative page-narration shapes against the current
prompt policy, schema and canonical action mapping. The samples below are
reviewer-authored deterministic examples; they are not model output, a TTS
recording or evidence of real model quality.

## Samples

### Ordinary Chinese lesson

Context: general school, Chinese-taught. Page text: `春天来了，天气变暖，花儿开放。`

```json
{
  "blocks": [
    { "type": "speech", "text": "同学们，春天来了，天气渐渐变暖，花儿也开放了。观察图中的小树，说说你发现了什么。" },
    { "type": "wait", "mode": "teacher_continue" }
  ]
}
```

Review: accepted. It explains only the supplied facts, addresses the class
directly and invites observation. The wait is a structured checkpoint with no
spoken control marker. The normalizer produces speech plus the canonical
`interaction_checkpoint/teacher_continue` action.

### Kindergarten mathematics

Context: kindergarten, `MATH`. Page text: `3 apples` with a picture of three
apples.

```json
{
  "blocks": [
    { "type": "speech", "text": "小朋友，看看图里有几个苹果？我们一起数：一、二、三。" },
    { "type": "wait", "durationMs": 1500 }
  ]
}
```

Review: accepted. It uses short, concrete language and counts only the visible
quantity. No English command-bank phrase or praise block is present. The fixed
wait becomes a 1500 ms `pauseAfterMs` on the preceding speech.

### Kindergarten English, bilingual delivery

Context: kindergarten, `ENGLISH`, not full-English. Page text teaches the color
red.

```json
{
  "blocks": [
    { "type": "speech", "text": "小朋友，看一看这是什么颜色？这是红色。" },
    { "type": "english_phrase", "text": "Good!" },
    { "type": "wait", "mode": "teacher_continue" }
  ]
}
```

Review: accepted for the bilingual policy. It uses one approved short command
bank phrase as encouragement and one teacher checkpoint. It does not claim the
children answered correctly. A separate praise block remains optional and
should not imply an observed response the system does not have. Full-English
mode needs a separate English-only sample before that mode can be considered
quality-reviewed.

## Contract checks

- `narration-write.test.ts` verifies kindergarten English includes the command
  bank and the `Good!` example, while kindergarten mathematics and ordinary
  narration do not receive that policy.
- The same test verifies English-phrase and praise blocks are refused outside
  kindergarten English, invented English phrases outside the command bank are
  refused, and per-page caps are enforced.
- Fixed `wait` remains bounded silence after speech. `teacher_continue` remains
  an unspoken checkpoint and is carried through canonical teaching, Host,
  fixed-build and the player.

The test uses a deterministic callback, not a paid or live model. Promotion of
this gate to real-model quality review still needs a real output in both
bilingual and full-English kindergarten-English modes, plus reviewer sign-off.
