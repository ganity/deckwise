/** Host supplies translated strings; no management-frontend locale/store is imported. */
export interface FixedPlayerLabels {
  player: string;
  controls: string;
  seekNarration: string;
  audioClip?: string;
  seekAudioClip?: string;
  previousPage: string;
  nextPage: string;
  pause: string;
  resume: string;
  teacherContinue: string;
  playAgain: string;
  play: string;
  replayPage: string;
  narration: string;
  waitingForTeacher: string;
  continueWhenReady: string;
  referenceAnswer?: string;
  videoClip?: string;
  retryPage: string;
  skipFailedNarration?: string;
  nativeAnimationRule?: string;
  boundNativeAnimationRule?: string;
  nextNativeAnimation?: string;
  chooseAnswer?: string; activityResponse?: string; checkAnswer?: string; teacherAssessment?: string; answerCorrect?: string; answerTryAgain?: string;
  playbackComplete: string;
}
export const englishPlayerLabels: FixedPlayerLabels = {
  chooseAnswer: 'Choose an answer', activityResponse: 'Activity response', checkAnswer: 'Check answer', teacherAssessment: 'Discuss or complete the activity, then review with the teacher.', answerCorrect: 'Correct', answerTryAgain: 'Try again',
  player: 'Courseware player', controls: 'Playback controls', seekNarration: 'Seek narration', audioClip: 'Music / audio clip', seekAudioClip: 'Seek audio clip',
  previousPage: 'Previous page', nextPage: 'Next page', pause: 'Pause', resume: 'Resume',
  teacherContinue: 'Teacher continue', playAgain: 'Play again', play: 'Play', replayPage: 'Replay page',
  narration: 'Narration', waitingForTeacher: 'Waiting for the teacher', continueWhenReady: 'Continue when ready.', referenceAnswer: 'Show reference answer',
  retryPage: 'Retry page', skipFailedNarration: 'Skip failed narration', playbackComplete: 'Playback complete',
  nativeAnimationRule: 'Trigger each saved native animation before this page’s narration. Narration is not automatically aligned to these clicks.',
  boundNativeAnimationRule: 'Saved native animation steps play in the authored teaching order. Teacher waits remain manual.',
  nextNativeAnimation: 'Next native animation',
  videoClip: 'Teaching video',
};
export const chinesePlayerLabels: FixedPlayerLabels = {
  chooseAnswer: '选择答案', activityResponse: '课堂回应', checkAnswer: '检查答案', teacherAssessment: '讨论或完成活动后，由教师结合参考答案评价。', answerCorrect: '回答正确', answerTryAgain: '再想一想，可以重新选择',
  player: '课件播放器', controls: '播放控制', seekNarration: '调整旁白进度', audioClip: '音乐 / 音频片段', seekAudioClip: '调整音频片段进度',
  previousPage: '上一页', nextPage: '下一页', pause: '暂停', resume: '继续', teacherContinue: '教师继续',
  playAgain: '重新播放', play: '播放', replayPage: '重播本页', narration: '旁白', waitingForTeacher: '等待教师继续',
  continueWhenReady: '准备好后继续。', referenceAnswer: '查看参考答案', retryPage: '重试本页', skipFailedNarration: '跳过失败的配音', playbackComplete: '播放完成',
  nativeAnimationRule: '先逐步触发本页已保存的原生动画，再播放讲解；讲解不会与这些点击自动对齐。',
  boundNativeAnimationRule: 'PPT 原生动画按已保存的教学时间轴顺序播放；等待节点仍需教师继续。',
  nextNativeAnimation: '下一步原生动画',
  videoClip: '教学视频',
};
