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
  nextNativeAnimation?: string;
  playbackComplete: string;
}
export const englishPlayerLabels: FixedPlayerLabels = {
  player: 'Courseware player', controls: 'Playback controls', seekNarration: 'Seek narration', audioClip: 'Music / audio clip', seekAudioClip: 'Seek audio clip',
  previousPage: 'Previous page', nextPage: 'Next page', pause: 'Pause', resume: 'Resume',
  teacherContinue: 'Teacher continue', playAgain: 'Play again', play: 'Play', replayPage: 'Replay page',
  narration: 'Narration', waitingForTeacher: 'Waiting for the teacher', continueWhenReady: 'Continue when ready.', referenceAnswer: 'Show reference answer',
  retryPage: 'Retry page', skipFailedNarration: 'Skip failed narration', playbackComplete: 'Playback complete',
  nativeAnimationRule: 'Trigger each saved native animation before this page’s narration. Narration is not automatically aligned to these clicks.',
  nextNativeAnimation: 'Next native animation',
  videoClip: 'Teaching video',
};
export const chinesePlayerLabels: FixedPlayerLabels = {
  player: '课件播放器', controls: '播放控制', seekNarration: '调整旁白进度', audioClip: '音乐 / 音频片段', seekAudioClip: '调整音频片段进度',
  previousPage: '上一页', nextPage: '下一页', pause: '暂停', resume: '继续', teacherContinue: '教师继续',
  playAgain: '重新播放', play: '播放', replayPage: '重播本页', narration: '旁白', waitingForTeacher: '等待教师继续',
  continueWhenReady: '准备好后继续。', referenceAnswer: '查看参考答案', retryPage: '重试本页', skipFailedNarration: '跳过失败的配音', playbackComplete: '播放完成',
  nativeAnimationRule: '先逐步触发本页已保存的原生动画，再播放讲解；讲解不会与这些点击自动对齐。',
  nextNativeAnimation: '下一步原生动画',
  videoClip: '教学视频',
};
