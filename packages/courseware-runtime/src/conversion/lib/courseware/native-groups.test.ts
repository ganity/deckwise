import { expect, it } from 'vitest';
import { projectNativeGroups } from './native-groups';
import type { SlideIR } from '../import/types';
const page: SlideIR['pages'][number] = { id: 'page', width: 960, height: 540, elements: [
  { id: 'a', type: 'shape', sourceShapeId: '4', sourceGroupShapeIds: ['2', '3'], left: 10, top: 20, width: 100, height: 30 },
  { id: 'b', type: 'shape', sourceShapeId: '5', sourceGroupShapeIds: ['2'], left: 140, top: 60, width: 40, height: 20, rotate: 90 },
] };
it('derives one invisible whole-group attention anchor from all nested, rotated descendants', () => {
  const [result] = projectNativeGroups(page, [{ objectId: 'uuid', sourceShapeId: '2' }]);
  expect(result.objectId).toBe('uuid');
  expect(result.element).toMatchObject({ left: 10, top: 20, width: 160, height: 70, opacity: 0, fill: 'transparent' });
  expect(page.elements).toHaveLength(2);
});
it('rejects missing, duplicate or leaf aliases rather than guessing an association', () => {
  for (const sourceShapeId of ['unknown', '4']) expect(() => projectNativeGroups(page, [{ objectId: 'uuid', sourceShapeId }])).toThrow();
  expect(() => projectNativeGroups(page, [{ objectId: 'one', sourceShapeId: '2' }, { objectId: 'two', sourceShapeId: '2' }])).toThrow();
});
