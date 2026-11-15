import { expect, it } from 'vitest';
import { resolveCoursewareRequiredObjects } from './courseware-required-objects.js';
const target = (objectId: string, aliases: string[]) => ({ objectId, name: objectId, aliases, status: 'mapped' as const, effectTargetEligible: true });
it('requires every member of a compound, never a compound alias on one member', () => {
  const objects = [target('ice', ['冰块', '冰块与固态标签'])];
  expect(resolveCoursewareRequiredObjects(['冰块与固态标签'], objects)[0].resolved).toBe(false);
  objects.push(target('label', ['固态标签']));
  expect(resolveCoursewareRequiredObjects(['冰块与固态标签'], objects)[0]).toMatchObject({ resolved: true, objectIds: ['ice', 'label'] });
});
it('requires the exact number of distinct verified members for counted requirements', () => {
  const objects = [target('a', ['状态列']), target('b', ['状态列'])];
  expect(resolveCoursewareRequiredObjects(['三个状态列'], objects)[0].resolved).toBe(false);
  objects.push(target('c', ['状态列']));
  expect(resolveCoursewareRequiredObjects(['三个状态列'], objects)[0]).toMatchObject({ resolved: true, objectIds: ['a', 'b', 'c'] });
  objects.push(target('d', ['状态列']));
  expect(resolveCoursewareRequiredObjects(['三个状态列'], objects)[0].resolved).toBe(false);
});
it('supports a shared label suffix and ignores missing or decorative targets', () => {
  const objects = [target('hot', ['受热标签']), { ...target('cold', ['遇冷标签']), effectTargetEligible: false }];
  expect(resolveCoursewareRequiredObjects(['受热与遇冷标签'], objects)[0].resolved).toBe(false);
  objects[1].effectTargetEligible = true;
  expect(resolveCoursewareRequiredObjects(['受热与遇冷标签'], objects)[0].resolved).toBe(true);
});
it('preserves unique whole-word English matching and quoted conjunctions', () => {
  const objects = [{ ...target('title', ['冰与火']), role: 'Title text carrier containing Circle' }];
  expect(resolveCoursewareRequiredObjects(['Circle title text carrier', '标题：“冰与火”'], objects).every(r => r.resolved)).toBe(true);
  objects.push({ ...objects[0], objectId: 'duplicate' });
  expect(resolveCoursewareRequiredObjects(['Circle title text carrier'], objects)[0].resolved).toBe(false);
});

it('binds quoted label text without requiring a synthetic suffix and accepts repeated real labels', () => {
  const objects = [target('ice', ['冰块']), target('solid-label', ['固态·冰']),
    target('heat-1', ['受热标签']), target('heat-2', ['受热标签']), target('cold', ['遇冷标签'])];
  expect(resolveCoursewareRequiredObjects(['冰块与“固态·冰”标签', '受热与遇冷标签'], objects).every(r => r.resolved)).toBe(true);
});
it('does not use a collective role as proof of its separate members', () => {
  const objects = [{ ...target('ice', ['ice']), role: 'ice and solid label' }];
  expect(resolveCoursewareRequiredObjects(['ice and solid label'], objects)[0].resolved).toBe(false);
});
