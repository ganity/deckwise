// Pinned from evo-trainwise-maic-server; see provenance.json.

export interface InteractionReferenceAnswer {
  summary: string;
  keyPoints: string[];
  label?: string;
}

export interface InteractionContext {
  chapterSummary: string;
  sourceSceneIds: string[];
  sourceOutlineIds?: string[];
  keyTerms?: string[];
}

export interface ChapterSummaryInteractionCheckpointPayload {
  checkpointId: string;
  checkpointKind: 'chapter_summary';
  chapterId: string;
  chapterTitle: string;
  question: string;
  constraintPrompt?: string;
  referenceAnswer: InteractionReferenceAnswer;
  context: InteractionContext;
}

export interface MediaPlaybackInteractionCheckpointPayload {
  checkpointId: string;
  checkpointKind: 'media_playback';
  elementId: string;
  mediaType: 'video' | 'audio';
  startMode: 'teacher_triggered';
  waitForCompletion: boolean;
}

export type InteractionCheckpointPayload =
  | ChapterSummaryInteractionCheckpointPayload
  | MediaPlaybackInteractionCheckpointPayload;

export interface InteractionSceneMetadata {
  kind: 'chapter_summary';
  chapterId: string;
  chapterTitle: string;
  sourceSceneIds: string[];
}

