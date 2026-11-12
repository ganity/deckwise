import { decodeHtmlEntities as decodeHTML } from '../import/narration/text-normalizer';
import type { Scene } from '../../../maic-types/stage';
import type { Action } from '../../../maic-types/action';

type Checkpoint = Extract<Action, { checkpointKind: 'chapter_summary' }>;

export function interactionText(element: unknown): string {
  const content = (element as { content?: unknown } | undefined)?.content;
  return typeof content === 'string'
    ? decodeHTML(content.replace(/<[^>]*>/g, ' '))
        .replace(/\s+/g, ' ')
        .trim()
    : '';
}

// Duplicated legacy pages have random IDs. Only use the known template layout
// when the page explicitly declares itself to be a chapter interaction.
export function interactionElements(scene: Scene) {
  if (scene.content.type !== 'slide') return {};
  const texts = scene.content.canvas.elements.filter((e) => e.type === 'text');
  const marked =
    (scene.metadata?.interaction as { kind?: string } | undefined)?.kind === 'chapter_summary';
  const label = texts.findIndex((e) => ['课堂互动问答', 'Classroom discussion'].includes(interactionText(e)));
  const hint = texts.findIndex(
    (e) => ['请思考后回答，课堂互动结束后将继续播放。', 'Think and answer. Your teacher will continue.'].includes(interactionText(e)),
  );
  const hasCheckpoint = scene.actions?.some(
    (a) => a.type === 'interaction_checkpoint' && a.checkpointKind === 'chapter_summary',
  );
  const title =
    texts.find((e) => e.id === scene.id + '_chapter_title') ??
    (marked && label === 1 ? texts[0] : undefined);
  const sectionLabel = texts.find((e) => e.id === scene.id + '_section_label') ?? texts[label];
  const instruction = texts.find((e) => e.id === scene.id + '_hint') ?? texts[hint];
  // Cutting/pasting a question gives it a random ID and appends it after the
  // hint in canvas order. Layer order is not the template's semantic order.
  // Infer only a unique remaining text on an explicitly identified interaction.
  const candidates =
    (marked || hasCheckpoint) && sectionLabel && instruction
      ? texts.filter(
          (element) => element !== title && element !== sectionLabel && element !== instruction,
        )
      : [];
  return {
    question:
      texts.find((e) => e.id === scene.id + '_question') ??
      (candidates.length === 1 ? candidates[0] : undefined) ??
      (hasCheckpoint && texts.length === 1 ? texts[0] : undefined),
    title,
  };
}

/** Match the generated interaction contract without rewriting user narration/audio. */
export function ensureInteractionCheckpoint(scene: Scene, scenes: Scene[] = []): Scene {
  if (scene.type !== 'slide' || scene.content.type !== 'slide') return scene;
  const existing = scene.actions?.find(
    (a): a is Checkpoint =>
      a.type === 'interaction_checkpoint' && a.checkpointKind === 'chapter_summary',
  );
  const interaction = scene.metadata?.interaction as
    | {
        kind?: string;
        chapterId?: string;
        chapterTitle?: string;
        sourceSceneIds?: string[];
      }
    | undefined;
  const { question: questionElement, title: titleElement } = interactionElements(scene);
  const hasTemplate =
    questionElement &&
    titleElement &&
    scene.content.canvas.elements.some((e) => e.id === scene.id + '_hint' && e.type === 'text');
  if (!existing && interaction?.kind !== 'chapter_summary' && !hasTemplate) return scene;
  const question = interactionText(questionElement) || existing?.question;
  if (!question?.trim()) return scene;
  const index = scenes.findIndex((s) => s.id === scene.id);
  const explicitIds = existing?.context?.sourceSceneIds?.length
    ? existing.context.sourceSceneIds
    : (interaction?.sourceSceneIds ?? []);
  const sources = explicitIds.length
    ? scenes.filter((s) => explicitIds.includes(s.id))
    : index >= 0
      ? scenes
          .slice(0, index)
          .filter(
            (s) =>
              s.type === 'slide' &&
              !(s.metadata?.interaction as { kind?: string })?.kind &&
              !s.actions?.some(
                (a) =>
                  a.type === 'interaction_checkpoint' && a.checkpointKind === 'chapter_summary',
              ),
          )
          .slice(-8)
      : [];
  const currentTitle =
    interactionText(titleElement) || existing?.chapterTitle || interaction?.chapterTitle;
  const chapterTitle =
    currentTitle && currentTitle !== '修改标题'
      ? currentTitle
      : sources.at(-1)?.title || currentTitle || scene.title;
  // Use the actual lesson as context, never invent a model answer.
  const summary = sources
    .map(
      (s) =>
        (s.actions ?? [])
          .filter((a) => a.type === 'speech')
          .map((a) => (a.type === 'speech' ? a.text : ''))
          .join(' ') ||
        (s.content.type === 'slide'
          ? s.content.canvas.elements
              .filter((e) => e.type === 'text')
              .map(interactionText)
              .join(' ')
          : s.title),
    )
    .filter(Boolean)
    .join('\n')
    .slice(-6000)
    .trim();
  const previousSummary = existing?.context?.chapterSummary?.trim();
  const metadata = {
    ...scene.metadata,
    interaction: {
      ...interaction,
      kind: 'chapter_summary' as const,
      chapterId: existing?.chapterId || interaction?.chapterId || 'chapter_' + scene.id,
      chapterTitle,
      sourceSceneIds: explicitIds.length ? explicitIds : sources.map((s) => s.id),
    },
  };
  const checkpoint: Checkpoint = {
    ...existing,
    id: existing?.id || scene.id + '_interaction',
    type: 'interaction_checkpoint',
    checkpointId: existing?.checkpointId || 'checkpoint_' + scene.id,
    checkpointKind: 'chapter_summary',
    chapterId: existing?.chapterId || interaction?.chapterId || 'chapter_' + scene.id,
    chapterTitle,
    question,
    referenceAnswer: existing?.referenceAnswer ?? {
      summary: '请结合本章内容回答。',
      keyPoints: [],
    },
    context: {
      ...existing?.context,
      chapterSummary:
        (previousSummary !== existing?.question ? previousSummary : summary) || summary || question,
      sourceSceneIds: explicitIds.length ? explicitIds : sources.map((s) => s.id),
    },
  };
  const narrationNeedsSource = scene.actions?.some((a) => a.type === 'speech' && !a.source);
  if (
    existing &&
    !narrationNeedsSource &&
    JSON.stringify(existing) === JSON.stringify(checkpoint) &&
    JSON.stringify(scene.metadata) === JSON.stringify(metadata)
  )
    return scene;
  return {
    ...scene,
    metadata,
    actions: (existing
      ? scene.actions!.map((a) => (a === existing ? checkpoint : a))
      : [...(scene.actions ?? []), checkpoint]
    ).map((a) => (a.type === 'speech' && !a.source ? { ...a, source: 'generated' as const } : a)),
  };
}
