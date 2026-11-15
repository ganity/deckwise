/** Verified OOXML presets also used by WiseOffice's built-in animation menu. */
const presets = {
  fadeIn: { presetClass: 1, presetId: 10, subtype: 0, ooxmlClass: 'entr' },
  fadeOut: { presetClass: 2, presetId: 10, subtype: 0, ooxmlClass: 'exit' },
  pulse: { presetClass: 0, presetId: 26, subtype: 0, ooxmlClass: 'emph' },
  zoomIn: { presetClass: 1, presetId: 53, subtype: 16, ooxmlClass: 'entr' },
  slideInLeft: { presetClass: 1, presetId: 2, subtype: 8, ooxmlClass: 'entr' },
  slideInRight: { presetClass: 1, presetId: 2, subtype: 2, ooxmlClass: 'entr' },
  gentleRotate: { presetClass: 0, presetId: 32, subtype: 0, ooxmlClass: 'emph' },
} as const;
export function nativeMotionPreset(effect: string) {
  return Object.hasOwn(presets, effect) ? presets[effect as keyof typeof presets] : undefined;
}
