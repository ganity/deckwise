import type { QuestionResponse } from '../../../question-response';
import type { Edition, EducationContext } from '../types/generation';

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
  response?: QuestionResponse;
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

export interface TeacherContinueInteractionCheckpointPayload {
  checkpointId: string;
  checkpointKind: 'teacher_continue';
}

export type InteractionCheckpointPayload =
  | ChapterSummaryInteractionCheckpointPayload
  | MediaPlaybackInteractionCheckpointPayload
  | TeacherContinueInteractionCheckpointPayload;

export interface InteractionSceneMetadata {
  kind: 'chapter_summary';
  chapterId: string;
  chapterTitle: string;
  sourceSceneIds: string[];
}

export interface ChapterInteractionSource {
  chapterId: string;
  chapterTitle: string;
  sourceSceneIds: string[];
  sourceOutlineIds?: string[];
  keyTerms?: string[];
  edition?: Edition;
  educationContext?: EducationContext;
  workflowProfile?: string;
  interactionProfile?: string;
}
