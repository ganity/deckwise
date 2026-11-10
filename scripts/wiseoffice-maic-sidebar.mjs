import assert from "node:assert/strict";

/** Apply Desktop's content-editor ownership when building the upstream native sidebar. */
export function maicSidebarSource(source) {
  return maicNativePanelSource(maicCheckpointSource(source));
}

export function maicCheckpointSource(source) {
  const startMarker = "      if (action.type === 'interaction_checkpoint' && action.checkpointKind === 'chapter_summary') {";
  const endMarker = "      if (action.type === 'audio_clip' || action.type === 'video_clip') {";
  const start = source.indexOf(startMarker), end = source.indexOf(endMarker, start);
  assert(start >= 0 && end > start, "WiseOffice checkpoint rendering changed; review the MAIC integration");
  const previous = source.slice(start, end);
  assert(previous.includes("'题型'") && previous.includes("action.referenceAnswer.keyPoints"), "Missing legacy checkpoint form");
  // Keep the timeline node, ordering and playback. Canonical content has one editor.
  return source.slice(0, start) + `      if (hasNativeTeaching()) {
${previous}
      } else {
${startMarker}
        card.append(element('p', action.question),
          element('p', 'MAIC 课堂互动：请在右侧题目编辑面板中修改问题、参考答案和提示词。'));
      }
      }
` + source.slice(end);
}

export function maicTeachingFlowSource(source) {
  const before = "return t(step.checkpointKind === 'chapter_summary' ? 'teachingExistingQuestion' : 'teachingTeacherPause');";
  assert(source.includes(before), "WiseOffice checkpoint title changed; review the MAIC integration");
  return source.replace(before, "return step.checkpointKind === 'chapter_summary' ? 'MAIC 课堂互动' : t('teachingTeacherPause');");
}

/** Restore selection after an atomic classroom/PPT save reopens the native document. */
export function maicEmbedSource(source) {
  const allowed = "!['theme', 'teachingOpen'].includes(key)";
  const marker = "        moduleUi = { ...moduleUi, ...payload };";
  assert(source.includes(allowed) && source.includes(marker), "WiseOffice UI configuration changed");
  return "import { applyQuizPage } from 'deckwise-quiz-live';\nimport { getEditorApi as maicEditorApi } from './agent-plugin/editor-bridge';\n" + source
    .replace("      case 'document:get-context':", `      case 'document:apply-quiz-page': {
        if (!isDeckWiseMode() || hasPendingEmbeddedSaveRequest() || pendingHostSave || saveOutcomeUncertain)
          throw new Error('Finish or recover the current save before editing Quiz');
        reply('document:command-result', await applyQuizPage(payload, deckwiseEditorBridge), message.id);
        break;
      }
      case 'document:get-context':`)
    .replace(allowed, "!['theme', 'teachingOpen', 'page'].includes(key)")
    .replace(marker, `        if (payload.page !== undefined) {
          const api = maicEditorApi() as any;
          if (!Number.isSafeInteger(payload.page) || payload.page < 1 || payload.page > (api?.WordControl?.m_oLogicDocument?.Slides?.length ?? 0))
            throw new Error('Invalid editor page');
          api.goToPage(payload.page - 1);
        }
        const { page: _page, ...settings } = payload;
        moduleUi = { ...moduleUi, ...settings };`);
}


/** Reuse the canonical React form inside the native teaching panel. */
function maicNativePanelSource(source) {
  const replace = (before, after) => {
    assert(source.includes(before), `WiseOffice teaching integration changed: ${before.slice(0, 70)}`);
    source = source.replace(before, after);
  };
  replace('  let startingSlideshow = false;', '  let startingSlideshow = false;\n  let previewPreparing = false;');
  replace('      running = false;', '      running = false;\n      if (!teachingSlideshow && !timeline) previewPreparing = false;');
  replace('  function renderControls() {', `  function renderControls() {
    panel?.setAttribute('aria-busy', String(previewPreparing));
    let loading = panel?.querySelector<HTMLProgressElement>('[data-preview-loading]');
    if (previewPreparing && panel && !loading) {
      loading = element('progress');
      loading.dataset.previewLoading = '';
      loading.setAttribute('aria-label', nativeSpeechLabels.previewPreparing);
      loading.style.cssText = 'width:36px;height:4px;flex:none;accent-color:var(--teaching-accent,#267c72);';
      panel.querySelector('.teaching-statusbar')?.append(loading);
    }
    if (loading) loading.hidden = !previewPreparing;`);
  replace('      const requestId = previewRequest;\n      if (changed()) await saveCurrent();', `      previewPreparing = true;
      notice(nativeSpeechLabels.previewPreparing);
      renderControls();
      const requestId = previewRequest;
      if (changed()) await saveCurrent();`);
  replace("      notice('正在读取本页已有讲解与媒体…');", `      previewPreparing = true;
      notice(nativeSpeechLabels.previewReadingMedia);
      renderControls();`);
  replace('        if (inSlideshow) {', '        if (inSlideshow) {\n          notice(nativeSpeechLabels.previewStarting);');
  const quoteStart = source.indexOf('    voice.append(\n      modelSelect,\n      voiceSelect,');
  const quoteEnd = source.indexOf('    card.append(attentionControls(action, index), voice);', quoteStart);
  assert(quoteStart >= 0 && quoteEnd > quoteStart, 'WiseOffice narration generation changed');
  const quoteSection = source.slice(quoteStart, quoteEnd);
  assert(quoteSection.includes("request('tts:submit'"), 'WiseOffice narration submission changed');
  replace(quoteSection, `    const generate = async () => {
      const owner = epoch;
      try {
        await saveCurrent();
        if (disposed || owner !== epoch) return;
        if (changed()) throw new Error('请先保存讲解，再生成语音');
        if (!models.length) models = await request('tts:models', scope());
        if (disposed || owner !== epoch) return;
        const selected = models.find(model => model.model === modelSelect.value) ?? models[0];
        const selectedVoice = voiceSelect.value || (selected?.providerDefaultVoice ? null : selected?.voices[0]);
        if (!selected || (!selectedVoice && !selected.providerDefaultVoice)) throw new Error(nativeSpeechLabels.ttsNoModels);
        const target = scope();
        const current = () => !disposed && owner === epoch && !changed() && target.viewId === view?.viewId &&
          target.expectedTeachingRevision === view.project.teachingRevision;
        const prepared = await request('tts:prepare', { ...target, actionId: action.id, model: selected.model, voice: selectedVoice || null });
        if (!current()) return;
        const quote = await request('tts:quote', { ...target, intentId: prepared.intentId });
        if (!current()) return;
        let task = await request('tts:submit', { ...target, intentId: prepared.intentId, quoteId: quote.quoteId });
        if (!current()) return;
        tasks = [...tasks.filter(entry => entry.intentId !== task.intentId), task];
        notice(nativeSpeechLabels.ttsBusy);
        for (let attempt = 0; attempt < 100 && current(); attempt++) {
          if (task.task?.state === 'ready' && task.current) {
            await request('tts:archive', { ...target, intentId: task.intentId });
            if (!current()) return;
            await applyView(await request('tts:adopt', { ...target, intentId: task.intentId }));
            notice(nativeSpeechLabels.speechReady);
            return;
          }
          if (['failed', 'cancelled'].includes(task.task?.state)) {
            throw new Error(task.task?.errorCode || nativeSpeechLabels.ttsFailed);
          }
          if (task.task?.state === 'submission_unknown' || task.phase === 'submission-unknown') break;
          if (attempt) await new Promise(resolve => setTimeout(resolve, 3000));
          if (!current()) return;
          task = await request('tts:status', { ...target, intentId: task.intentId });
          if (!current()) return;
          tasks = tasks.map(entry => entry.intentId === task.intentId ? task : entry);
        }
        if (current()) notice(nativeSpeechLabels.ttsUnknown, true);
      } catch (error) {
        if (!disposed && owner === epoch) notice(speechGenerationError(error, nativeSpeechLabels.ttsInsufficientPoints), true);
      }
    };
    voice.append(modelSelect, voiceSelect);
    const generateSpeech = button(action.audioAssetId ? nativeSpeechLabels.speechRegenerate : nativeSpeechLabels.speechGenerate,
      () => void run(generate), !editable());
    generateSpeech.dataset.ttsGenerate = '';
    voiceStatus.append(generateSpeech);
`);
  replace('  const speechSelections = new Map<string, { start: number; end: number }>();', `  const speechSelections = new Map<string, { start: number; end: number }>();
  const speechVoices = new Map<string, { model: string; voice: string }>();`);
  replace('    const populateVoices = () => {', `    modelSelect.value = speechVoices.get(action.id)?.model ?? models[0]?.model ?? '';
    const populateVoices = () => {`);
  replace("    modelSelect.addEventListener('change', populateVoices);\n    populateVoices();", `    const rememberVoice = () => speechVoices.set(action.id, { model: modelSelect.value, voice: voiceSelect.value });
    const selectDefaultVoice = () => {
      populateVoices();
      const selected = models.find(model => model.model === modelSelect.value);
      voiceSelect.value = selected?.providerDefaultVoice ? '' : selected?.voices[0] ?? '';
    };
    modelSelect.addEventListener('change', () => { selectDefaultVoice(); rememberVoice(); });
    voiceSelect.addEventListener('change', rememberVoice);
    selectDefaultVoice();
    if (speechVoices.get(action.id)?.model === modelSelect.value) voiceSelect.value = speechVoices.get(action.id)!.voice;`);
  replace("      speechSelections.delete(action.id);", "      generateSpeech.textContent = nativeSpeechLabels.speechRegenerate;\n      speechSelections.delete(action.id);");
  replace('type View = {', 'type View = { assessment?: any; embeddedAssessment?: any; nativeDraft?: any;');
  replace('  let panelLayout:', '  let assessmentPanel: HTMLElement | null = null;\n  let assessmentEditor: ReturnType<typeof mountNativeAssessment> | null = null;\n  let panelLayout:');
  replace("    const recovered = await request('draft:get', { viewId: view.viewId });", "    if (next.assessment) { draftRevision = null; draftError = ''; draftInstruction = ''; render(preserveLesson); return; }\n    const recovered = next.nativeDraft ?? await request('draft:get', { viewId: view.viewId });");
  replace("      if (changed() && !draftError) scheduleSave();", "      if (changed() && !draftError) scheduleSave();\n      if (data.assessment) return;");
  replace('    panel.append(flow);', `    if (view?.assessment) {
      const saveButton = button('保存本页教学', () => assessmentEditor?.toolbar?.save(), true);
      saveButton.dataset.save = '';
      decorateTeachingButton(saveButton, 'save', true);
      history.append(saveButton);
      if (!assessmentPanel) {
        assessmentPanel = element('div');
        assessmentPanel.style.cssText = 'flex:1;min-height:0;overflow:hidden;border-top:1px solid var(--teaching-line);';
        assessmentEditor = mountNativeAssessment(assessmentPanel, request, renderControls);
      }
      assessmentPanel.style.cssText = 'flex:1;min-height:0;overflow:hidden;border-top:1px solid var(--teaching-line);';
      panel.append(assessmentPanel);
      assessmentEditor!.update(view.assessment, view.pageNumber);
      renderControls();
      return;
    }
    if (view?.embeddedAssessment) {
      const save = button('保存本页教学', () => assessmentEditor?.toolbar?.save());
      save.dataset.assessmentSave = '';
      panel.append(save);
      if (!assessmentPanel) {
        assessmentPanel = element('div');
        assessmentEditor = mountNativeAssessment(assessmentPanel, request, renderControls);
      }
      assessmentPanel.style.cssText = 'height:560px;min-height:280px;flex-shrink:0;overflow:hidden;';
      panel.append(assessmentPanel);
      assessmentEditor!.update(view.embeddedAssessment, view.pageNumber);
    }
    panel.append(flow);`);
  replace('    renderPreviewControls();\n    panel?.querySelectorAll', `    if (view?.assessment) {
      renderPreviewControls();
      const toolbar = assessmentEditor?.toolbar;
      const status = panel?.querySelector<HTMLElement>('[data-status]');
      if (status && !previewPreparing && !timeline && !teachingSlideshow && !statusError) {
        const scene = view.assessment.classroom?.scenes[view.pageNumber - 1];
        status.textContent = (scene?.type === 'quiz' ? 'Quiz' : '课堂互动') + ' · ' + (toolbar?.status || '正在读取…');
        status.title = status.textContent;
        status.setAttribute('role', 'status');
      }
      panel?.querySelectorAll<HTMLButtonElement>('[data-teaching-history]').forEach(node => {
        node.disabled = !(node.dataset.teachingHistory === 'undo' ? toolbar?.canUndo : toolbar?.canRedo);
      });
      panel?.querySelectorAll<HTMLButtonElement>('[data-save]').forEach(node => { node.disabled = !toolbar?.canSave; });
      panel?.querySelectorAll<HTMLButtonElement>('[data-preview-command]').forEach(node => {
        if (['play', 'show', 'lesson'].includes(node.dataset.previewCommand ?? ''))
          node.disabled = !toolbar?.canPlay || busy || running || previewPreparing || !!timeline || !!teachingSlideshow || nativeSlideshow || !!lesson;
      });
      const refreshButton = panel?.querySelector<HTMLButtonElement>('header button');
      if (refreshButton) refreshButton.disabled = !toolbar?.canRefresh;
      return;
    }
    panel?.querySelectorAll<HTMLButtonElement>('[data-assessment-save]').forEach(node => { node.disabled = !assessmentEditor?.toolbar?.canSave; });
    renderPreviewControls();
    panel?.querySelectorAll`);
  replace('            await saveCurrent();\n            refresh();', `            if (view?.assessment) { assessmentEditor?.toolbar?.refresh(); return; }
            await saveCurrent();
            refresh();`);
  replace("const control = button(label, () => changeHistory(undo));", "const control = button(label, () => view?.assessment ? (undo ? assessmentEditor?.toolbar?.undo() : assessmentEditor?.toolbar?.redo()) : changeHistory(undo));");
  replace('const content = structuredClone(actions),\n        token = epoch;', `if (view?.assessment || view?.embeddedAssessment) {
        notice(nativeSpeechLabels.previewReadingContent);
        const owner = epoch;
        const saved = await request('classroom:open');
        if (!view || owner !== epoch || requestId !== previewRequest || nativeSlideshow || disposed) return;
        if (view.assessment) view.assessment = saved; else view.embeddedAssessment = saved;
      }
      const assessmentView = view?.assessment ?? view?.embeddedAssessment;
      const assessmentScene = assessmentView?.classroom?.scenes?.[view.pageNumber - 1];
      const quizScene = assessmentScene?.content?.type === 'quiz' ? assessmentScene : null;
      const quiz = quizScene?.content ?? null;
      const content = quizScene ? [] : structuredClone(actions);
      if (assessmentView) {
        for (const action of assessmentScene?.actions ?? []) {
          if (action.type === 'speech' && Object.values(assessmentScene?.metadata?.assessmentSpeechIds ?? {}).includes(action.id)) {
            const speech = { id: action.id, type: 'speech', text: action.text, audioAssetId: action.audioId, assessmentSpeech: true };
            const nextCheckpoint = assessmentScene.actions.slice(assessmentScene.actions.indexOf(action) + 1).find(item => item.type === 'interaction_checkpoint');
            const index = nextCheckpoint ? content.findIndex(item => item.type === 'interaction_checkpoint' && item.checkpointId === nextCheckpoint.checkpointId) : -1;
            const existing = content.findIndex(item => item.id === action.id);
            if (existing >= 0) content[existing] = speech;
            else content.splice(index >= 0 ? index : content.length, 0, speech);
          }
          if (action.type === 'interaction_checkpoint') {
            const index = content.findIndex(item => item.type === 'interaction_checkpoint' && item.checkpointId === action.checkpointId);
            const checkpoint = { ...(index >= 0 ? content[index] : {}), id: action.id, type: action.type, checkpointId: action.checkpointId,
              checkpointKind: action.checkpointKind, response: action.response, chapterId: action.chapterId,
              chapterTitle: action.chapterTitle, question: action.question, referenceAnswer: action.referenceAnswer,
              context: action.context };
            if (index >= 0) content[index] = checkpoint; else content.push(checkpoint);
          }
        }
      }
      const token = epoch;`);
  replace("const audio = await request(action.type === 'speech' ? 'tts:preview' : 'media:preview', {", `const audio = await request(action.assessmentSpeech ? 'classroom:audio:preview' : action.type === 'speech' ? 'tts:preview' : 'media:preview', {
            ...(action.assessmentSpeech ? { projectId: assessmentView.projectId, expectedRevision: assessmentView.revision,
              expectedSourceRevision: assessmentView.sourceRevision, sceneId: assessmentScene.id } : {}),`);
  replace('            ...scope(),\n            actionId: action.id,', '            ...(action.assessmentSpeech ? {} : scope()),\n            actionId: action.id,');
  replace('        async function startTeaching() {', `        async function startTeaching() {
          if (!isCurrent()) return;
          previewPreparing = false;
          renderControls();
          if (quiz) {
            const showQuiz = () => {
            if (!isCurrent()) return;
            const parent = teachingSlideshow?.surface ?? panel!;
            parent.querySelector('[data-teaching-quiz]')?.remove();
            const card = element('section');
            card.dataset.teachingQuiz = quizScene.id;
            card.setAttribute('aria-label', '课堂测验');
            card.style.cssText = 'position:absolute;z-index:45;right:16px;top:16px;max-width:min(560px,calc(100% - 32px));max-height:calc(100% - 144px);overflow:auto;box-sizing:border-box;padding:20px;background:#fff;color:#172033;border:1px solid #cbd5e1;border-radius:8px;box-shadow:0 8px 28px #0003;';
            const title = element('h2', '课堂测验');
            title.style.cssText = 'margin:0 0 12px;font-size:20px;';
            card.append(title);
            const questions = quiz.questions ?? [];
            for (const question of questions) {
              const fieldset = element('fieldset');
              fieldset.style.cssText = 'margin:0 0 16px;padding:0;border:0;';
              const legend = element('legend', question.question);
              legend.style.cssText = 'font-weight:700;margin-bottom:10px;';
              fieldset.append(legend);
              const imageFor = value => typeof value === 'string' && /^(data:|blob:)/u.test(value) ? value : view.assessment.resourceUrls?.[value] ?? '';
              if (question.image?.src) {
                const image = element('img'); image.src = imageFor(question.image.src); image.alt = '题目图片';
                image.style.cssText = 'display:block;max-width:100%;max-height:180px;object-fit:contain;margin:8px 0;'; fieldset.append(image);
              }
              const selected = new Set();
              const answerField = question.type === 'short_answer' ? element('textarea') : null;
              if (answerField) {
                answerField.maxLength = 4000;
                answerField.setAttribute('aria-label', '课堂回应');
                answerField.style.cssText = 'box-sizing:border-box;width:100%;min-height:84px;padding:8px;';
                fieldset.append(answerField);
              }
              for (const option of question.options ?? []) {
                const label = element('label'), input = element('input');
                input.type = question.type === 'multiple' ? 'checkbox' : 'radio';
                input.name = 'quiz-' + quizScene.id + '-' + question.id;
                input.addEventListener('change', () => {
                  if (question.type !== 'multiple') selected.clear();
                  if (input.checked) selected.add(option.value); else selected.delete(option.value);
                });
                label.style.cssText = 'display:flex;align-items:center;gap:8px;margin:8px 0;cursor:pointer;';
                label.append(input, element('span', option.value + '. ' + option.label));
                if (option.image?.src) {
                  const image = element('img'); image.src = imageFor(option.image.src); image.alt = option.label;
                  image.style.cssText = 'max-width:100px;max-height:72px;object-fit:contain;'; label.append(image);
                }
                fieldset.append(label);
              }
              const status = element('p'); status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
              const check = button('检查答案', () => {
                if (answerField) {
                  status.textContent = answerField.value.trim() ? '本题由教师评价。' : '请先填写回答';
                  if (answerField.value.trim()) continueButton.hidden = false;
                  return;
                }
                if (!selected.size) { status.textContent = '请先选择答案'; return; }
                const expected = question.answer ?? [];
                const correct = expected.length > 0 && selected.size === expected.length && [...selected].every(value => expected.includes(value));
                status.textContent = expected.length ? correct ? (question.analysis || '回答正确！') : '再想一想，可以重新选择。' : '本题由教师评价。';
                if (!expected.length || correct) continueButton.hidden = false;
              });
              const continueButton = button('继续教学', () => {
                card.remove(); stopAudio(preserveLesson); notice('Quiz 已完成'); preserveLesson?.finishPage?.();
              });
              continueButton.hidden = true;
              fieldset.append(check, status, continueButton);
              card.append(fieldset);
            }
            if (!questions.length) card.append(element('p', '本页尚未添加题目。'));
            parent.append(card);
            previewMode = 'waiting_interaction';
            renderPreviewControls();
            };
            if (!nodes.length) { showQuiz(); return; }
            timeline = shared.createTeachingTimelinePreview({ pageId: view!.pageId, nodes,
              onMode(mode) { if (isCurrent()) { previewMode = mode; renderPreviewControls(); } },
              onProgress() {}, onNode() {},
              onError(error) { if (isCurrent()) notice(error.message, true); },
              onComplete: showQuiz,
            });
            timeline.start();
            return;
          }`);
  replace('      disposed = true;', '      assessmentEditor?.dispose();\n      disposed = true;');
  replace('  const stopAudio = (preserveLesson?: LessonRun) => {', `  const stopAudio = (preserveLesson?: LessonRun) => {
    previewPreparing = false;
    panel?.querySelector('[data-teaching-quiz]')?.remove();
    teachingSlideshow?.surface.querySelector('[data-teaching-quiz]')?.remove();`);
  return "import { mountNativeAssessment, nativeSpeechLabels, speechGenerationError } from 'deckwise-native-assessment';\n" + source;
}
