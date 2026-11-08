# Planning recovery fixes and independent live task

## Fixes

- Count cover, opening, activity setup and review within the saved body budget
  in the shared story and scene-planning policies. Keep strict page validation.
- Count two rewritten correction opportunities independently of repeated
  submissions. Identical writes/submissions have a separate bounded failure
  guard; failed writes do not become validated draft versions.
- Preserve bounded typed planning validation errors in automatic tool events,
  matching explicit submission. Other unexpected error messages remain sanitized.
- Keep provider-compatible historical tool schemas with `tool_choice: none` and
  the execution fence. A blocked noncompliant final tool call receives one
  reporting correction retaining the actual saved snapshot. It cannot execute
  new work or renew the correction budget.

## Verification before the live task

- The runtime planning integration regression failed before the fix: only two
  writes executed before the correction budget was exhausted; three were needed.
- Agent runtime: 116 test files, 1,741 tests passed after the final changes.
- Desktop story/planning/workflow: 67 tests passed, including real Main/Host
  story persistence and both production planning entrances.
- Runtime TypeScript build, Desktop typecheck and production build passed.
- Existing provider replay tests caught the attempted schema-removal approach;
  that approach was reverted before the live task. Final code retains schemas.
- No commit, push or merge was performed.

## Independent live task

- Session: `2a1e57b6-4cc9-4dbd-a1de-5e313faa8c02`.
- Title: 家庭成员英语课件·修复后6页复验 20261108.
- Started: 2026-11-08 11:22:10 China Standard Time.
- Same requested parameters as the failed baseline: scene/story first,
  kindergarten senior-class bilingual family English, warm watercolor,
  deepseek-v4-1-flash reasoning off, scene-master/scene-layers,
  doubao-tts / zh_female_yingyujiaoxue_uranus_bigtts, four body pages plus one
  four-option image Quiz and one interaction checkpoint, total at most six.
- Running application code/builds remain fixed from task submission onward.
- Runtime continuation build SHA-256:
  `a985272d7f1b4811c62830650c442165718ff424d6429ce0fc0f2a7f947daefb`.
- Runtime entry build SHA-256:
  `7aec029fe3207861050385cb3ef775ad1e8514c41dc06efa7b8058035991b000`.
- Main build SHA-256:
  `065fbee4401d615f0400378233c2889009197ec4076c2b14bc5d739a7785a942`.
- Monitoring evidence directory: `/tmp/deckwise-fixed-retry-YZPsvd`.

## Observed progression

1. Story revision 1 saved and approved normally. Hash:
   `12a996c6de16fe406a915fcae63462216f62e3d3bfd67273181de4492ef26ba2`.
2. Planning first placed the Quiz after all body pages; validation rejected it.
   The first rewrite fixed order but put seven visible strings on one body page.
   The second rewrite fixed that error and passed. Automatic and explicit
   validation both exposed the exact errors. Duplicate submissions did not
   consume the two rewrite opportunities. No operator correction/resume was sent.
3. The reviewed plan has six physical pages: body, Quiz, body, body, body with
   music, interaction. Approved plan hash:
   `a48aac178fc6f39edb067e9435b9d40235aa86855492dc2e435be1a375766749`.
4. Normal plan approval started the first-page visual-master stage.

5. The application generated and saved four visual masters and their editable
   decompositions, then compiled exactly six pages. Initial source SHA-256:
   `50cdfe8ddc1a81228b698ed9a2b316d1f2a008594f704a64fd20d2ad614b0a81`.
6. Narration generation repaired invalid English-phrase limits and visual
   bindings. One failed body page was retried by the model without operator
   input. All four body pages then passed detailed-narration acceptance.
7. The model generated 107 body speech clips, two question clips, four Quiz
   images and one music clip. Stale classroom/source revisions caused eight
   protected media-operation rejections; rereading context and refreshing the
   original requests resolved them. No operator recovery prompt was sent.
8. Automatic focus-only repair preserved existing speech and audio. Four
   non-blocking focus diagnostics remain after the bounded advisory attempts.
9. The turn ended at 11:59:29 CST without a fatal provider or INTERNAL error.
   The saved workflow is `completed`, completion is ready, and assessment media
   is ready with no missing targets. This was not an error-free tool trace:
   it also contains four planning rejections, three missing-file probes, the
   eight media rejections above and one blocked final-report tool call.

## Saved acceptance and playback

- Session: `2a1e57b6-4cc9-4dbd-a1de-5e313faa8c02`.
- Project: `office-50cdfe8ddc1a81228b698ed9a2b316d1f2a00859-9c98aee624da`.
- Final source SHA-256:
  `a3f08820dd6bd75726b474af7d35d75cd916e267809f567d8bfd5136a17e5186`.
- Teaching revision: `4f2e185f-d977-4a2b-82cc-172c3472eb42`.
- Canonical revision: `2cc17268-a233-4e8a-b518-01a997a9600e`.
- Read-only saved audit passed: six pages, all 107 speech clips bound, both
  question clips bound, four option images, one music clip, and 170 nonempty
  local manifest entries checked by SHA-256.
- Actual Desktop player passed: body audio clock advances; Quiz question audio
  plays for 29.304 seconds before enabling answers; all four 1536-pixel images
  decode; a wrong answer permits retry; a correct answer advances automatically;
  interaction question audio plays for 11.448 seconds and waits for teacher
  continuation. No player JavaScript errors or displayed error were observed.
- Evidence: `saved-acceptance.json`, `player-evidence.json`, `quiz-player.png`,
  and `interaction-player.png` in the monitoring evidence directory.
- Built-in WiseOffice also passed on interaction page six: one slideshow click
  displayed the loading message, native question audio advanced, and the sidebar
  then waited for teacher continuation. The first test could not reach the
  button because the narrow editor collapsed its sidebar; widening the normal
  editor bounds exposed the same button. Evidence: `office-evidence.json` and
  `office-interaction.png`. No content or playback implementation was replaced.
- Fault-recovery prompts: zero. Normal story, plan and cover approvals: three.

## Final-report inconsistency found after completion

The model's final prose incorrectly claimed that question audio was unfinished,
although the latest saved acceptance, read-only audit and real playback all
confirmed both clips. Its extra context call had been correctly blocked during
final reporting, but the generic block message said a new user request was
required. This wording encouraged confusing a reporting fence with unfinished
media generation.

After the live turn ended, the block response was changed to include the latest
saved workflow acceptance and explicitly state that blocking a tool does not
undo saved assets. The one reporting correction now distinguishes authoritative
completion/assessment readiness from non-blocking quality advice. No application
source or build changed during live generation. This additional fix was checked
by 107 focused runtime tests across three files (including completed-acceptance
and provider-wire regressions) and the runtime TypeScript build. It has not been
reverified with another paid full generation.

Final regression after this additional fix: all 116 runtime test files and 1,742
tests passed. The 67 Desktop story/planning/workflow tests and Desktop build
checks above cover the unchanged planning-side fixes.

Status: saved completion, canonical playback and built-in WiseOffice playback PASS. Non-blocking focus advice
and recoverable stale-revision rejections remain visible; full teaching quality
is not claimed.
