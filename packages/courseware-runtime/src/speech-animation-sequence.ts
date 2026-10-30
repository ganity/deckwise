/** Speech clocks run in order: one motion per target per segment, with later emphasis allowed. */
export function validSpeechAnimationSequence(actions: readonly {
  type: string;
  visualCues?: readonly { effect: { type: string; elementId?: string; effect?: string } }[];
}[]): boolean {
  const previous = new Map<string, string>();
  for (const action of actions) {
    if (action.type !== 'speech') continue;
    const current = new Set<string>();
    for (const { effect } of action.visualCues ?? []) {
      if (effect.type !== 'element_animation') continue;
      const id = effect.elementId, motion = effect.effect;
      if (!id || !motion || !['fadeIn', 'fadeOut', 'pulse', 'zoomIn', 'slideInLeft', 'slideInRight', 'gentleRotate'].includes(motion)) return false;
      if (current.has(id) || (previous.has(id) && (!['pulse', 'gentleRotate', 'fadeOut'].includes(motion) || previous.get(id) === 'fadeOut'))) return false;
      current.add(id);
      previous.set(id, motion);
    }
  }
  return true;
}
