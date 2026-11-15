export type KindergartenEnglishCommandCategory =
  | 'classroom_routine'
  | 'repeat_practice'
  | 'game_interaction'
  | 'simple_questions'
  | 'praise_closing'
  | 'instant_praise'
  | 'effort_progress'
  | 'ability_praise'
  | 'warm_reassurance';

export interface KindergartenEnglishCommand {
  category: KindergartenEnglishCommandCategory;
  english: string;
  chinese: string;
}

export const KINDERGARTEN_ENGLISH_COMMANDS: readonly KindergartenEnglishCommand[] = [
  { category: 'classroom_routine', english: 'Stand up, please.', chinese: '请站起来。' },
  { category: 'classroom_routine', english: 'Sit down, please.', chinese: '请坐下。' },
  { category: 'classroom_routine', english: 'Look at me.', chinese: '看着我。' },
  { category: 'classroom_routine', english: 'Listen carefully.', chinese: '仔细听。' },
  { category: 'classroom_routine', english: 'Hands up.', chinese: '举手。' },
  { category: 'classroom_routine', english: 'Hands down.', chinese: '放下手。' },
  { category: 'classroom_routine', english: 'Be quiet.', chinese: '请安静。' },
  {
    category: 'classroom_routine',
    english: 'Put your hands on your knees.',
    chinese: '小手放膝盖。',
  },
  { category: 'classroom_routine', english: 'Sit straight.', chinese: '坐端正。' },
  { category: 'classroom_routine', english: 'No talking.', chinese: '不要说话。' },
  { category: 'repeat_practice', english: 'Follow me.', chinese: '跟我读。' },
  { category: 'repeat_practice', english: 'Read after me.', chinese: '跟我念。' },
  { category: 'repeat_practice', english: 'Say it together.', chinese: '一起说。' },
  { category: 'repeat_practice', english: 'Say it again.', chinese: '再说一遍。' },
  { category: 'repeat_practice', english: 'One more time.', chinese: '再来一次。' },
  { category: 'repeat_practice', english: 'Speak loudly.', chinese: '大声说。' },
  { category: 'repeat_practice', english: 'Open your mouth.', chinese: '张开嘴巴。' },
  { category: 'repeat_practice', english: "Let's chant.", chinese: '我们来说唱。' },
  { category: 'repeat_practice', english: 'Ready? Go!', chinese: '预备，开始！' },
  { category: 'repeat_practice', english: 'Slowly, please.', chinese: '请慢一点。' },
  { category: 'game_interaction', english: "Let's play a game.", chinese: '我们来玩游戏。' },
  { category: 'game_interaction', english: 'Are you ready?', chinese: '你准备好了吗？' },
  { category: 'game_interaction', english: 'Who wants to try?', chinese: '谁想试一试？' },
  { category: 'game_interaction', english: 'Come here, please.', chinese: '请到前面来。' },
  { category: 'game_interaction', english: 'Go back to your seat.', chinese: '回到座位上。' },
  { category: 'game_interaction', english: 'Take turns.', chinese: '轮流来。' },
  { category: 'game_interaction', english: 'Watch me.', chinese: '看我做。' },
  { category: 'game_interaction', english: "Let's count.", chinese: '我们来数数。' },
  { category: 'game_interaction', english: 'Hurry up.', chinese: '快点哦。' },
  { category: 'game_interaction', english: "What's missing?", chinese: '什么不见了？' },
  { category: 'simple_questions', english: "What's this?", chinese: '这是什么？' },
  { category: 'simple_questions', english: 'How are you?', chinese: '你好吗？' },
  { category: 'simple_questions', english: "What's your name?", chinese: '你叫什么名字？' },
  { category: 'simple_questions', english: 'How old are you?', chinese: '你几岁了？' },
  { category: 'simple_questions', english: 'What color is it?', chinese: '这是什么颜色？' },
  { category: 'simple_questions', english: 'How many?', chinese: '有多少个？' },
  { category: 'simple_questions', english: 'Where is it?', chinese: '它在哪里？' },
  { category: 'simple_questions', english: 'Do you like it?', chinese: '你喜欢它吗？' },
  { category: 'simple_questions', english: 'Can you do it?', chinese: '你能做到吗？' },
  { category: 'simple_questions', english: 'Guess.', chinese: '猜一猜。' },
  { category: 'praise_closing', english: 'Very good!', chinese: '非常棒！' },
  { category: 'praise_closing', english: 'Good job!', chinese: '做得好！' },
  { category: 'praise_closing', english: 'Wonderful!', chinese: '太棒啦！' },
  { category: 'praise_closing', english: 'Great!', chinese: '真厉害！' },
  { category: 'praise_closing', english: 'Well done!', chinese: '做得好！' },
  { category: 'praise_closing', english: 'You are clever.', chinese: '你真聪明。' },
  { category: 'praise_closing', english: 'Clap your hands.', chinese: '拍拍手。' },
  { category: 'praise_closing', english: 'Nice work!', chinese: '干得不错。' },
  { category: 'praise_closing', english: 'Class is over.', chinese: '下课啦。' },
  { category: 'praise_closing', english: 'See you tomorrow.', chinese: '明天见。' },
  { category: 'instant_praise', english: 'You did it!', chinese: '你做到啦！' },
  { category: 'instant_praise', english: 'Good!', chinese: '好！' },
  { category: 'instant_praise', english: 'Way to go!', chinese: '干得好！' },
  { category: 'instant_praise', english: 'Good for you!', chinese: '你真不错！' },
  { category: 'instant_praise', english: "That's right!", chinese: '完全正确！' },
  { category: 'effort_progress', english: 'You tried so hard.', chinese: '你特别努力。' },
  { category: 'effort_progress', english: 'Keep it up!', chinese: '继续保持！' },
  { category: 'effort_progress', english: "You're getting better.", chinese: '你越来越棒了。' },
  { category: 'effort_progress', english: 'Nice try!', chinese: '尝试得很棒！' },
  { category: 'effort_progress', english: 'Keep going!', chinese: '继续加油！' },
  { category: 'ability_praise', english: "You're so clever.", chinese: '你真聪明。' },
  { category: 'ability_praise', english: "You're amazing.", chinese: '你太厉害了。' },
  { category: 'ability_praise', english: 'You did a great job.', chinese: '你做得超棒。' },
  { category: 'ability_praise', english: 'That was perfect.', chinese: '太完美了。' },
  { category: 'ability_praise', english: "You're a little star.", chinese: '你是小明星。' },
  { category: 'warm_reassurance', english: "I'm proud of you.", chinese: '我为你骄傲。' },
  { category: 'warm_reassurance', english: "You're so lovely.", chinese: '你真可爱。' },
  { category: 'warm_reassurance', english: 'You make me smile.', chinese: '你让我很开心。' },
  { category: 'warm_reassurance', english: 'Great job, sweetie.', chinese: '宝贝做得真棒。' },
  { category: 'warm_reassurance', english: 'Keep up the good work.', chinese: '继续好好表现。' },
] as const;

export const KINDERGARTEN_ENGLISH_COMMAND_TEXTS = Object.freeze(
  Array.from(new Set(KINDERGARTEN_ENGLISH_COMMANDS.map((command) => command.english))),
);

function normalizeCommandText(value: string): string {
  return value
    .toLowerCase()
    .replace(/[’]/gu, "'")
    .replace(/[^a-z0-9']+/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
}

export function isKindergartenEnglishCommand(value: string): boolean {
  const normalized = normalizeCommandText(value);
  return KINDERGARTEN_ENGLISH_COMMAND_TEXTS.some(
    (command) => normalizeCommandText(command) === normalized,
  );
}

export function buildKindergartenEnglishCommandPolicy(): string {
  const grouped = new Map<KindergartenEnglishCommandCategory, string[]>();
  for (const command of KINDERGARTEN_ENGLISH_COMMANDS) {
    const phrases = grouped.get(command.category) ?? [];
    phrases.push(command.english);
    grouped.set(command.category, phrases);
  }

  const categoryLabels: Record<KindergartenEnglishCommandCategory, string> = {
    classroom_routine: 'Classroom routine',
    repeat_practice: 'Repeat and pronunciation',
    game_interaction: 'Game interaction',
    simple_questions: 'Simple questions',
    praise_closing: 'Praise and closing',
    instant_praise: 'Instant praise',
    effort_progress: 'Effort and progress',
    ability_praise: 'Ability praise',
    warm_reassurance: 'Warm reassurance',
  };

  return [
    'Kindergarten English classroom command policy:',
    '- This policy applies only to kindergarten English. Use 0-2 exact phrases per ordinary page and no more than one praise phrase per page.',
    '- Choose a phrase only when it matches the current visible teaching action. Do not translate every Chinese sentence and do not invent phrases outside this bank.',
    '- For Chinese-taught kindergarten English, keep surrounding explanation and action guidance in short Chinese. The approved English phrase may stand alone or be followed by a concise Chinese meaning.',
    '- Do not use closing phrases such as “Class is over.” or “See you tomorrow.” before the actual closing page.',
    ...Array.from(
      grouped,
      ([category, phrases]) => `- ${categoryLabels[category]}: ${phrases.join(' | ')}`,
    ),
  ].join('\n');
}
