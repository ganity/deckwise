import type { MaicClassroom } from './maic-classroom';
import type { SpeechAction } from './maic-types/action';

/** All authoring routes share the same spoken question and audio invalidation rule. */
export function prepareMaicAssessmentSpeech(document: MaicClassroom, createMissing = true): MaicClassroom {
  const next = structuredClone(document);
  for (const scene of next.scenes) {
    const actions = scene.actions ?? [];
    const targets = scene.content.type === 'quiz'
      ? [{ key: scene.id, text: scene.content.questions.map(q => [q.question, ...(q.options ?? []).map(o => `${o.value}. ${o.label}`)].join('\n')).join('\n\n'), before: 0 }]
      : actions.flatMap((action, index) => action.type === 'interaction_checkpoint' && action.checkpointKind === 'chapter_summary'
        ? [{ key: action.id, text: action.question, before: index }] : []);
    const savedBindings = scene.metadata?.assessmentSpeechIds;
    const bindings: Record<string, string> = savedBindings && typeof savedBindings === 'object' && !Array.isArray(savedBindings)
      ? Object.fromEntries(Object.entries(savedBindings).filter((entry): entry is [string, string] => typeof entry[1] === 'string')) : {};
    for (const [key, speechId] of Object.entries(bindings)) {
      if (targets.some(target => target.key === key)) continue;
      const index = actions.findIndex(action => action.type === 'speech' && action.id === speechId);
      if (index >= 0) actions.splice(index, 1);
      next.audioManifest = next.audioManifest?.filter(entry => entry.sceneId !== scene.id || entry.actionId !== speechId);
      delete bindings[key];
    }
    for (const target of targets.reverse()) {
      let speech = actions.find((action): action is SpeechAction => action.type === 'speech' && (action.id === bindings[target.key] || action.id === `${target.key}-question-tts`));
      if (!target.text.trim()) {
        if (speech) {
          const speechId = speech.id;
          actions.splice(actions.indexOf(speech), 1);
          next.audioManifest = next.audioManifest?.filter(entry => entry.sceneId !== scene.id || entry.actionId !== speechId);
        }
        delete bindings[target.key];
        continue;
      }
      if (!speech && !createMissing) continue;
      if (!speech) {
        const candidates = scene.content.type === 'quiz' ? actions : actions.slice(0, actions.findIndex(action => action.id === target.key)).slice(-1);
        speech = candidates.find((action): action is SpeechAction => action.type === 'speech' && action.text === target.text && !Object.values(bindings).includes(action.id));
      }
      if (!speech) {
        const id = `${target.key}-question-tts`;
        if (actions.some(action => action.id === id)) throw new Error('Assessment speech identity collision');
        speech = { id, type: 'speech', text: target.text };
        actions.splice(target.before, 0, speech);
      }
      bindings[target.key] = speech.id;
      {
        const checkpointIndex = scene.content.type === 'quiz' ? 0 : actions.findIndex(action => action.id === target.key);
        const speechIndex = actions.indexOf(speech);
        if (speechIndex > checkpointIndex) { actions.splice(speechIndex, 1); actions.splice(checkpointIndex, 0, speech); }
      }
      if (speech.text !== target.text) {
        speech.text = target.text;
        delete speech.audioId; delete speech.audioUrl;
        next.audioManifest = next.audioManifest?.filter(entry => entry.sceneId !== scene.id || entry.actionId !== speech.id);
      }
    }
    if (Object.keys(bindings).length || savedBindings) scene.metadata = { ...scene.metadata, assessmentSpeechIds: bindings };
    if (actions.length || scene.actions) scene.actions = actions;
  }
  return next;
}
