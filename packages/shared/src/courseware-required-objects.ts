import type { CoursewareTeachingView } from './courseware-editor.js';

type Target = NonNullable<CoursewareTeachingView['teachingObjects']>[number];
const normalize = (value: string) => value.normalize('NFKC').toLocaleLowerCase().replace(/\s+/gu, '');
const tokens = (value: string) => value.normalize('NFKC').toLocaleLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
function parts(value: string): string[] {
  const quoted: string[] = [];
  const masked = value.replace(/[“「"]([^”」"]+)[”」"]/gu, match => `\u0001${quoted.push(match) - 1}\u0002`);
  return masked.split(/(?:与|和|及|、|\s+and\s+|\s*\+\s*)/iu)
    .map(part => part.replace(/\u0001(\d+)\u0002/gu, (_, index) => quoted[Number(index)]).trim()).filter(Boolean);
}
function names(value: string): string[] {
  const cleaned = value.replace(/^(?:标题|结论句|结论文字|独立结论文字)\s*[：:]?\s*/u, '').replace(/[“”「」"]/gu, '');
  const literalLabel = /^[“「"]([^”」"]+)[”」"]标签$/u.exec(value)?.[1];
  return [...new Set([normalize(value), normalize(cleaned), ...(literalLabel ? [normalize(literalLabel)] : [])])].filter(Boolean);
}
function matches(value: string, target: Target): boolean {
  const wanted = names(value);
  // A pasted collective alias is not evidence that a single target contains every member.
  const aliases = [target.name, ...target.aliases].filter(alias => parts(alias).length === 1 || /[“「"]/.test(value) && names(alias).some(name => wanted.includes(name)));
  if (aliases.some(alias => names(alias).some(name => wanted.includes(name)))) return true;
  const role = target.role && parts(target.role).length === 1 ? target.role : '';
  const required = tokens(value), observed = new Set(tokens([role, ...aliases].join(' ')));
  return required.length > 0 && required.every(word => observed.has(word));
}

/** Resolve collections to their actual members, retaining ambiguity and missing members. */
export function resolveCoursewareRequiredObjects(required: readonly string[], objects: readonly Target[]) {
  const eligible = objects.filter(object => object.status === 'mapped' && object.effectTargetEligible);
  return required.map(requirement => {
    const counted = /^(\d+|[一二两三四五六七八九十])(?:个|组|张|幅|条|列)\s*(.+)$/u.exec(requirement);
    if (counted) {
      const number = Number(counted[1]) || ({ 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 }[counted[1]] ?? 0);
      const ids = [...new Set(eligible.filter(target => matches(counted[2], target)).map(target => target.objectId))];
      return { requirement, resolved: number > 0 && ids.length === number, objectIds: ids, expectedCount: number };
    }
    const components = parts(requirement);
    const suffix = components.length > 1 ? /(?:标签|图形|文字)$/u.exec(components.at(-1)!)?.[0] : undefined;
    const bindings = components.map(component => {
      const variants = suffix && !component.endsWith(suffix) ? [component, component + suffix] : [component];
      const objectIds = [...new Set(eligible.filter(target => variants.some(value => matches(value, target))).map(target => target.objectId))];
      return { description: component, objectIds };
    });
    // A compound asks for presence of every member; repeated real labels are valid.
    // A standalone description still needs a unique match, and counted sets use exact cardinality.
    return { requirement, resolved: bindings.every(binding => components.length > 1 ? binding.objectIds.length > 0 : binding.objectIds.length === 1),
      objectIds: [...new Set(bindings.flatMap(binding => binding.objectIds))], components: bindings };
  });
}
