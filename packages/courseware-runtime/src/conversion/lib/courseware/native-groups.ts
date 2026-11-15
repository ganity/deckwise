import type { SlideIR } from '../import/types';
import type { PPTShapeElement } from '../types/slides';

/** Derived invisible attention anchors. Group membership comes only from the pinned PPTX IR. */
export function projectNativeGroups(page: SlideIR['pages'][number], groups: readonly { objectId: string; sourceShapeId: string }[]) {
  const seen = new Set<string>();
  return groups.map(group => {
    if (seen.has(group.sourceShapeId) || page.elements.some(element => element.sourceShapeId === group.sourceShapeId))
      throw new Error('GROUP_BINDING_MISMATCH');
    seen.add(group.sourceShapeId);
    const children = page.elements.filter(element => element.sourceGroupShapeIds?.includes(group.sourceShapeId));
    if (!children.length) throw new Error('GROUP_BINDING_MISMATCH');
    const bounds = children.map(element => {
      const angle = (element.rotate ?? 0) * Math.PI / 180;
      const width = Math.abs(element.width * Math.cos(angle)) + Math.abs(element.height * Math.sin(angle));
      const height = Math.abs(element.width * Math.sin(angle)) + Math.abs(element.height * Math.cos(angle));
      const left = element.left + (element.width - width) / 2;
      const top = element.top + (element.height - height) / 2;
      return { left, top, right: left + width, bottom: top + height };
    });
    const left = Math.min(...bounds.map(b => b.left)), top = Math.min(...bounds.map(b => b.top));
    const width = Math.max(...bounds.map(b => b.right)) - left, height = Math.max(...bounds.map(b => b.bottom)) - top;
    if (![left, top, width, height].every(Number.isFinite) || width <= 0 || height <= 0)
      throw new Error('GROUP_BINDING_MISMATCH');
    const element: PPTShapeElement = { id: `native_group_${group.objectId}`, type: 'shape', left, top, width, height,
      rotate: 0, viewBox: [1, 1], path: 'M0 0 L1 0 L1 1 L0 1 Z', fixedRatio: false, fill: 'transparent', opacity: 0 };
    if (page.elements.some(existing => existing.id === element.id)) throw new Error('GROUP_BINDING_MISMATCH');
    return { objectId: group.objectId, element };
  });
}
