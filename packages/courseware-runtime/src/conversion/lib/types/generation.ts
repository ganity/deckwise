export type Edition = 'ENTERPRISE' | 'EDUCATION';

export interface EducationContext {
  schoolStage?: string;
  grade?: string;
  subject?: string;
  customSubjectName?: string;
  textbookVersion?: string;
  chapter?: string;
  lessonType?: string;
  fullEnglishTeaching?: boolean;
}

