import { SaxesParser } from 'saxes';
import type { PptAnimationItemIR, PptAnimationPageIR } from '../../types';

const MAX_TIMING_XML_BYTES = 10 * 1024 * 1024;
const MAX_TIMING_DEPTH = 32;
const MAX_TIMING_NODES = 5000;
const MAX_ANIMATION_ITEMS = 200;
const MAX_STEP_WINDOW_MS = 60_000;
const MAX_PARAGRAPH_TARGETS = 100;
const PRESENTATIONML_NAMESPACES = new Set([
  'http://schemas.openxmlformats.org/presentationml/2006/main',
  'http://purl.oclc.org/ooxml/presentationml/main',
]);
const DRAWINGML_NAMESPACES = new Set([
  'http://schemas.openxmlformats.org/drawingml/2006/main',
  'http://purl.oclc.org/ooxml/drawingml/main',
]);

export type PptxTimingParseResult =
  | { accepted: true; animation: PptAnimationPageIR; warnings?: string[] }
  | { accepted: false; warning: string };

type TimingNode = {
  local: string;
  uri: string;
  attrs: Record<string, string>;
  children: TimingNode[];
  text?: string;
};
type StartDependency = { timingId: string; event: 'onBegin' | 'onEnd'; delayMs: number };
type StartCondition = StartDependency | { delayMs: number };
type AnimationComposite = {
  primaryNode: TimingNode;
  nodes: TimingNode[];
  targetNode: TimingNode;
  effect: string;
  durationMs: number;
  referenceIds: string[];
};
type ParsedPropertyAnimation = {
  name: string;
  from: string;
  to: string;
  durationMs: number;
};
type ParsedMotionAnimation = {
  targetNode: TimingNode;
  durationMs: number;
  animationType: 'in' | 'attention';
  motion: NonNullable<PptAnimationItemIR['motion']>;
};
type ParsedRotationAnimation = {
  targetNode: TimingNode;
  durationMs: number;
  rotation: NonNullable<PptAnimationItemIR['rotation']>;
};
type RawAnimationItem = {
  encounter: number;
  timingId: string;
  referenceIds: string[];
  groupKey: string;
  trigger: 'auto' | 'click';
  delayMs: number;
  dependency?: StartDependency;
  item: Omit<PptAnimationItemIR, 'id' | 'startAtMs'>;
};
type MainSequenceEffectState = {
  effectNode: TimingNode;
  groupKey: string;
  trigger: RawAnimationItem['trigger'];
  items: RawAnimationItem[];
  implicitDependency?: StartDependency;
};

export function parsePptxTiming(slideXml: string): PptxTimingParseResult {
  if (Buffer.byteLength(slideXml) > MAX_TIMING_XML_BYTES) return rejected('PPTX_TIMING_TOO_LARGE');
  if (/<!DOCTYPE/i.test(slideXml)) return rejected('PPTX_TIMING_DOCTYPE_REJECTED');

  const roots: TimingNode[] = [];
  const stack: TimingNode[] = [];
  let timingDepth = 0;
  let timingNodes = 0;
  let failure: string | undefined;
  const parser = new SaxesParser({ xmlns: true });

  parser.on('opentag', (tag) => {
    const local = tag.local;
    if (local === 'timing') {
      if (!PRESENTATIONML_NAMESPACES.has(tag.uri)) {
        failure = 'PPTX_TIMING_NAMESPACE_UNSUPPORTED';
        return;
      }
      timingDepth = 1;
    } else if (timingDepth > 0) timingDepth += 1;
    if (timingDepth <= 0) return;
    timingNodes += 1;
    if (timingDepth > MAX_TIMING_DEPTH) failure = 'PPTX_TIMING_DEPTH_EXCEEDED';
    if (timingNodes > MAX_TIMING_NODES) failure = 'PPTX_TIMING_NODE_LIMIT_EXCEEDED';
    const attrs = Object.fromEntries(
      Object.entries(tag.attributes).map(([name, value]) => [name, value.value]),
    );
    const node: TimingNode = { local, uri: tag.uri, attrs, children: [] };
    const parent = stack.at(-1);
    if (parent) parent.children.push(node);
    else roots.push(node);
    stack.push(node);
  });
  parser.on('text', (value) => {
    if (timingDepth <= 0) return;
    const node = stack.at(-1);
    if (node) node.text = `${node.text ?? ''}${value}`;
  });
  parser.on('closetag', (tag) => {
    if (timingDepth <= 0) return;
    stack.pop();
    timingDepth -= 1;
    if (tag.local === 'timing') timingDepth = 0;
  });
  parser.on('error', () => {
    failure = 'PPTX_TIMING_XML_INVALID';
  });
  parser.write(slideXml).close();
  if (failure) return rejected(failure);

  const timing = roots.find((node) => node.local === 'timing');
  if (!timing) return { accepted: true, animation: { steps: [] } };
  const animationComposites = collectSupportedAnimationComposites(timing);
  const skipped = collectUnsupportedBranches(timing, animationComposites);
  return collectSteps(timing, animationComposites, skipped.nodes, skipped.warnings);
}

function collectSteps(
  root: TimingNode,
  animationComposites: Map<TimingNode, AnimationComposite>,
  skippedNodes: Set<TimingNode>,
  warnings: Set<string>,
): PptxTimingParseResult {
  const rawItems: RawAnimationItem[] = [];
  const buildParagraphShapeIds = new Set<string>();
  const mainSequenceState = new Map<TimingNode, MainSequenceEffectState>();
  let failure: string | undefined;
  let encounter = 0;

  walk(
    root,
    (node, ancestors) => {
      if (node.local === 'bldP' && node.attrs.spid) buildParagraphShapeIds.add(node.attrs.spid);
      const animationComposite = animationComposites.get(node);
      const motionAnimation =
        node.local === 'animMotion' ? parseSimpleMotionAnimation(node) : undefined;
      const rotationAnimation =
        node.local === 'anim' ? parseHeldRotationAnimation(node) : undefined;
      if (
        failure ||
        (animationComposite && animationComposite.primaryNode !== node) ||
        (!animationComposite &&
          !motionAnimation &&
          !rotationAnimation &&
          !['animEffect', 'set', 'video', 'audio'].includes(node.local))
      ) {
        return;
      }
      const timingNode = findDescendant(node, 'cTn');
      const targetNode =
        animationComposite?.targetNode ??
        motionAnimation?.targetNode ??
        rotationAnimation?.targetNode ??
        findDescendant(node, 'spTgt');
      const isMedia = node.local === 'video' || node.local === 'audio';
      // Plain manual media is already handled by the importer's page-media controls.
      if (isMedia && isStandaloneManualMedia(node, ancestors)) return;
      const setVisibility =
        node.local === 'set' ? findDescendant(node, 'strVal')?.attrs.val?.toLowerCase() : undefined;
      const durationMs =
        animationComposite?.durationMs ??
        motionAnimation?.durationMs ??
        rotationAnimation?.durationMs ??
        parseTimingDuration(timingNode) ??
        (node.local === 'audio' && isLoopingRepeat(timingNode?.attrs.repeatCount) ? 0 : undefined);
      if (!timingNode || !targetNode?.attrs.spid || durationMs == null) {
        warnings.add('PPTX_TIMING_TARGET_OR_DURATION_UNSUPPORTED');
        return;
      }
      if (node.local === 'set' && setVisibility !== 'visible' && setVisibility !== 'hidden') {
        warnings.add('PPTX_TIMING_UNSUPPORTED_BEHAVIOR');
        return;
      }
      const timingId = timingNode.attrs.id || `anonymous_${encounter + 1}`;

      const target = parseTarget(targetNode);
      if (!target) {
        warnings.add('PPTX_TIMING_PARAGRAPH_TARGET_UNSUPPORTED');
        return;
      }

      const schedulingNodes = [
        ...ancestors.filter((ancestor) => ancestor.local === 'cTn'),
        timingNode,
      ];
      const activation = [...schedulingNodes]
        .reverse()
        .find((candidate) => hasClickCondition(candidate));
      const mainSequence = [...schedulingNodes]
        .reverse()
        .find((candidate) => candidate.attrs.nodeType === 'mainSeq');
      const effectNode = [...schedulingNodes]
        .reverse()
        .find((candidate) =>
          ['clickEffect', 'withEffect', 'afterEffect'].includes(candidate.attrs.nodeType),
        );
      const effectNodeIndex = effectNode ? schedulingNodes.indexOf(effectNode) : -1;
      const hasExplicitGroupOffset =
        effectNodeIndex > 0 &&
        schedulingNodes
          .slice(0, effectNodeIndex)
          .some((candidate) =>
            startConditions(candidate).some(
              (condition) => !isStartDependency(condition) && condition.delayMs > 0,
            ),
          );
      const conditions = schedulingNodes.flatMap(startConditions);
      const schedulingTimingIds = new Set(
        schedulingNodes
          .map((candidate) => candidate.attrs.id)
          .filter((candidate): candidate is string => Boolean(candidate)),
      );
      const parentStartAnchors = conditions.filter(
        (condition): condition is StartDependency =>
          isStartDependency(condition) &&
          condition.event === 'onBegin' &&
          schedulingTimingIds.has(condition.timingId),
      );
      const dependencyConditions = conditions.filter(
        (condition): condition is StartDependency =>
          isStartDependency(condition) && !parentStartAnchors.includes(condition),
      );
      if (
        dependencyConditions.length > 1 ||
        (dependencyConditions.length === 1 &&
          !activation &&
          dependencyConditions[0].timingId === timingId)
      ) {
        warnings.add('PPTX_TIMING_DEPENDENCY_UNSUPPORTED');
        return;
      }

      const delayMs =
        conditions
          .filter((condition): condition is { delayMs: number } => !isStartDependency(condition))
          .reduce((total, condition) => total + condition.delayMs, 0) +
        parentStartAnchors.reduce((total, condition) => total + condition.delayMs, 0);
      const animationType = rotationAnimation
        ? 'attention'
        : motionAnimation
          ? motionAnimation.animationType
          : isMedia
            ? 'media'
            : setVisibility === 'hidden'
              ? 'out'
              : node.attrs.transition === 'out'
                ? 'out'
                : isAttentionEffect(node.attrs.filter)
                  ? 'attention'
                  : 'in';
      if (rawItems.length >= MAX_ANIMATION_ITEMS) {
        failure = 'PPTX_TIMING_ITEM_LIMIT_EXCEEDED';
        return;
      }
      let groupKey = activation?.attrs.id ? `click:${activation.attrs.id}` : 'auto';
      let trigger: RawAnimationItem['trigger'] = activation ? 'click' : 'auto';
      let dependency: StartDependency | undefined = dependencyConditions[0];
      let effectState: MainSequenceEffectState | undefined;
      if (effectNode) {
        if (!mainSequence) {
          warnings.add('PPTX_TIMING_DEPENDENCY_UNSUPPORTED');
          return;
        }
        const current = mainSequenceState.get(mainSequence);
        if (current?.effectNode === effectNode) {
          effectState = current;
        } else {
          const isClickEffect = effectNode.attrs.nodeType === 'clickEffect';
          const event = effectNode.attrs.nodeType === 'withEffect' ? 'onBegin' : 'onEnd';
          const anchor = current ? selectDependencyAnchor(current.items, event) : undefined;
          effectState = {
            effectNode,
            groupKey: isClickEffect
              ? `click:${effectNode.attrs.id || timingId}`
              : current?.groupKey || 'auto',
            trigger: isClickEffect ? 'click' : current?.trigger || 'auto',
            items: [],
            ...(anchor
              ? { implicitDependency: { timingId: anchor.timingId, event, delayMs: 0 } }
              : {}),
          };
          mainSequenceState.set(mainSequence, effectState);
        }
        groupKey = effectState.groupKey;
        trigger = effectState.trigger;
        dependency =
          effectNode.attrs.nodeType === 'clickEffect'
            ? undefined
            : dependency || (hasExplicitGroupOffset ? undefined : effectState.implicitDependency);
      }

      const rawItem: RawAnimationItem = {
        encounter: encounter++,
        timingId,
        referenceIds: [
          ...schedulingNodes
            .map((candidate) => candidate.attrs.id)
            .filter((candidate): candidate is string => Boolean(candidate)),
          ...(animationComposite?.referenceIds ?? []),
        ],
        groupKey,
        trigger,
        delayMs,
        ...(dependency ? { dependency } : {}),
        item: {
          target,
          ...(effectNode && /^\d+$/.test(effectNode.attrs.presetID ?? '') && effectNode.attrs.presetClass
            ? { nativePreset: { version: 1 as const, class: effectNode.attrs.presetClass, id: Number(effectNode.attrs.presetID) } }
            : {}),
          effect: rotationAnimation
            ? 'rotation'
            : motionAnimation
              ? 'motion'
              : animationComposite?.effect ||
                node.attrs.filter ||
                (node.local === 'set'
                  ? setVisibility === 'hidden'
                    ? 'disappear'
                    : 'appear'
                  : undefined),
          animationType,
          durationMs,
          ...(motionAnimation ? { motion: motionAnimation.motion } : {}),
          ...(rotationAnimation ? { rotation: rotationAnimation.rotation } : {}),
        },
      };
      rawItems.push(rawItem);
      effectState?.items.push(rawItem);
    },
    [],
    skippedNodes,
  );
  if (failure) return rejected(failure);

  const rawByTimingId = new Map<string, RawAnimationItem | null>();
  for (const item of rawItems) {
    for (const referenceId of item.referenceIds) {
      const existing = rawByTimingId.get(referenceId);
      rawByTimingId.set(referenceId, existing && existing !== item ? null : item);
    }
  }
  const startTimes = new Map<string, number>();
  const resolving = new Set<string>();
  const resolveStartAtMs = (item: RawAnimationItem): number | undefined => {
    const cached = startTimes.get(item.timingId);
    if (cached != null) return cached;
    if (resolving.has(item.timingId)) return undefined;
    resolving.add(item.timingId);
    let startAtMs = item.delayMs;
    if (item.dependency) {
      const dependency = rawByTimingId.get(item.dependency.timingId);
      if (!dependency || dependency.groupKey !== item.groupKey) {
        resolving.delete(item.timingId);
        return undefined;
      }
      const dependencyStart = resolveStartAtMs(dependency);
      if (dependencyStart == null) {
        resolving.delete(item.timingId);
        return undefined;
      }
      startAtMs += dependencyStart + item.dependency.delayMs;
      if (item.dependency.event === 'onEnd') startAtMs += dependency.item.durationMs;
    }
    resolving.delete(item.timingId);
    if (startAtMs > MAX_STEP_WINDOW_MS || startAtMs + item.item.durationMs > MAX_STEP_WINDOW_MS) {
      return undefined;
    }
    startTimes.set(item.timingId, startAtMs);
    return startAtMs;
  };

  const groups = new Map<string, { trigger: 'auto' | 'click'; items: RawAnimationItem[] }>();
  const executableItems: RawAnimationItem[] = [];
  for (const item of rawItems) {
    const startAtMs = resolveStartAtMs(item);
    if (startAtMs == null) {
      warnings.add('PPTX_TIMING_DEPENDENCY_UNSUPPORTED');
      continue;
    }
    executableItems.push(item);
    const group = groups.get(item.groupKey) ?? { trigger: item.trigger, items: [] };
    group.items.push(item);
    groups.set(item.groupKey, group);
  }

  for (const shapeId of buildParagraphShapeIds) {
    const revealTimes = new Set(
      executableItems
        .filter(
          (item) =>
            item.item.animationType === 'in' &&
            item.item.target?.shapeId === shapeId &&
            !item.item.target.paragraphIndexes?.length &&
            !item.item.target.characterRange,
        )
        .map((item) => `${item.groupKey}:${startTimes.get(item.timingId) ?? 0}`),
    );
    if (revealTimes.size > 1) {
      // Some WPS-authored decks mark an ordinary one-paragraph text shape as
      // build-by-paragraph while also applying more than one whole-shape
      // entrance. The paragraph indexes cannot be reconstructed from that
      // metadata alone, but rejecting the complete slide discards unrelated
      // animations too. Preserve the executable whole-shape timeline and
      // report the loss of paragraph-level precision instead.
      warnings.add('PPTX_TIMING_PARAGRAPH_TARGET_UNSUPPORTED');
    }
  }

  return {
    accepted: true,
    ...(warnings.size > 0 ? { warnings: [...warnings] } : {}),
    animation: {
      steps: [...groups.values()].map((group, index) => ({
        id: `pptx_step_${index + 1}`,
        trigger: group.trigger,
        items: [...group.items]
          .sort(
            (left, right) =>
              (startTimes.get(left.timingId) ?? 0) - (startTimes.get(right.timingId) ?? 0) ||
              left.encounter - right.encounter,
          )
          .map((raw, itemIndex) => ({
            id: `pptx_item_${itemIndex + 1}`,
            ...raw.item,
            startAtMs: startTimes.get(raw.timingId) ?? 0,
          })),
      })),
    },
  };
}

function selectDependencyAnchor(
  items: RawAnimationItem[],
  event: StartDependency['event'],
): RawAnimationItem | undefined {
  return items.reduce<RawAnimationItem | undefined>((selected, item) => {
    if (!selected) return item;
    const selectedTime = selected.delayMs + (event === 'onEnd' ? selected.item.durationMs : 0);
    const itemTime = item.delayMs + (event === 'onEnd' ? item.item.durationMs : 0);
    return itemTime > selectedTime ? item : selected;
  }, undefined);
}

function isAttentionEffect(effect: string | undefined): boolean {
  return effect?.trim().toLowerCase() === 'pulse';
}

function parseTarget(targetNode: TimingNode): PptAnimationItemIR['target'] | undefined {
  const paragraphRange = findDescendant(targetNode, 'pRg');
  const characterRange = findDescendant(targetNode, 'charRg');
  if (!paragraphRange && !characterRange) return { shapeId: targetNode.attrs.spid };
  if (paragraphRange && characterRange) return undefined;
  if (characterRange) {
    const start = Number(characterRange.attrs.st);
    const end = Number(characterRange.attrs.end);
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start) {
      return undefined;
    }
    return { shapeId: targetNode.attrs.spid, characterRange: [start, end] };
  }
  if (!paragraphRange) return undefined;
  const start = Number(paragraphRange.attrs.st);
  const end = Number(paragraphRange.attrs.end);
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(end) ||
    start < 0 ||
    end < start ||
    end - start + 1 > MAX_PARAGRAPH_TARGETS
  ) {
    return undefined;
  }
  return {
    shapeId: targetNode.attrs.spid,
    paragraphIndexes: Array.from({ length: end - start + 1 }, (_, index) => start + index),
  };
}

function startConditions(node: TimingNode): StartCondition[] {
  const list = node.children.find((child) => child.local === 'stCondLst');
  if (!list) return [];
  const conditions: StartCondition[] = [];
  for (const condition of list.children.filter((child) => child.local === 'cond')) {
    const delayMs = parseDelay(condition.attrs.delay);
    if (delayMs == null) continue;
    if (condition.attrs.evt === 'onBegin' || condition.attrs.evt === 'onEnd') {
      const timingId = getConditionTimingId(condition);
      if (!timingId) continue;
      conditions.push({ timingId, event: condition.attrs.evt, delayMs });
    } else if (!condition.attrs.evt) {
      conditions.push({ delayMs });
    }
  }
  return conditions;
}

function isStandaloneManualMedia(node: TimingNode, ancestors: TimingNode[]): boolean {
  if (ancestors.map(ancestor => ancestor.local).join('/') !== 'timing/tnLst/par/cTn/childTnLst' ||
      ancestors[3].attrs.nodeType !== 'tmRoot' || ancestors[3].children.length !== 1 ||
      Object.keys(ancestors[3].attrs).some(key => !['id', 'dur', 'restart', 'nodeType'].includes(key)) ||
      ancestors[3].attrs.dur !== 'indefinite' || ancestors[3].attrs.restart !== 'never') return false;
  const media = node.children[0];
  if (node.children.length !== 1 || media.local !== 'cMediaNode' || media.children.length !== 2) return false;
  const timing = media.children.find(child => child.local === 'cTn');
  const target = media.children.find(child => child.local === 'tgtEl');
  const list = timing?.children[0], condition = list?.children[0], shape = target?.children[0];
  return !!timing && Object.keys(timing.attrs).every(key => ['id', 'fill', 'display'].includes(key)) &&
    (!timing.attrs.fill || timing.attrs.fill === 'hold') && timing.children.length === 1 &&
    list?.local === 'stCondLst' && list.children.length === 1 && condition?.local === 'cond' &&
    condition.children.length === 0 && Object.keys(condition.attrs).join(',') === 'delay' &&
    condition.attrs.delay === 'indefinite' && target?.children.length === 1 && shape?.local === 'spTgt' &&
    shape.children.length === 0 && Object.keys(shape.attrs).join(',') === 'spid' && !!shape.attrs.spid;
}

function isStartDependency(condition: StartCondition): condition is StartDependency {
  return 'event' in condition;
}

function hasClickCondition(node: TimingNode): boolean {
  const list = node.children.find((child) => child.local === 'stCondLst');
  return Boolean(
    list?.children.some(
      (child) =>
        child.local === 'cond' &&
        (child.attrs.evt === 'onClick' || child.attrs.delay === 'indefinite'),
    ),
  );
}

function collectUnsupportedBranches(
  root: TimingNode,
  animationComposites: Map<TimingNode, AnimationComposite>,
): { nodes: Set<TimingNode>; warnings: Set<string> } {
  const nodes = new Set<TimingNode>();
  const warnings = new Set<string>();
  const skip = (node: TimingNode, warning: string) => {
    warnings.add(warning);
    const composite = animationComposites.get(node);
    if (composite) composite.nodes.forEach((candidate) => nodes.add(candidate));
    else nodes.add(node);
  };

  walk(root, (node, ancestors) => {
    if (ancestors.some((ancestor) => nodes.has(ancestor))) return;
    const isInsideAudio =
      node.local === 'audio' || ancestors.some((ancestor) => ancestor.local === 'audio');
    if (
      (!PRESENTATIONML_NAMESPACES.has(node.uri) && !DRAWINGML_NAMESPACES.has(node.uri)) ||
      (node.local === 'anim' &&
        !animationComposites.has(node) &&
        !parseHeldRotationAnimation(node)) ||
      (node.local === 'animMotion' && !parseSimpleMotionAnimation(node)) ||
      ['animClr', 'animRot', 'animScale', 'bldChart', 'bldDgm', 'interactiveSeq'].includes(
        node.local,
      ) ||
      node.attrs.nodeType === 'interactiveSeq'
    ) {
      skip(node, 'PPTX_TIMING_UNSUPPORTED_STRUCTURE');
    } else if (node.local === 'cmd' && /togglePause/iu.test(node.attrs.cmd ?? '')) {
      skip(node, 'PPTX_TIMING_UNSUPPORTED_STRUCTURE');
    } else if (node.local === 'cTn' && hasShapeTargetedClickCondition(node)) {
      skip(node, 'PPTX_TIMING_UNSUPPORTED_STRUCTURE');
    } else if (
      node.attrs.fill === 'remove' ||
      node.attrs.autoRev === '1' ||
      (node.attrs.speed && node.attrs.speed !== '1') ||
      (node.attrs.repeatCount && !(isInsideAudio && isLoopingRepeat(node.attrs.repeatCount)))
    ) {
      skip(findUnsupportedBranchRoot(node, ancestors), 'PPTX_TIMING_UNSUPPORTED_BEHAVIOR');
    } else if (
      node.local === 'cond' &&
      (node.attrs.evt === 'onBegin' || node.attrs.evt === 'onEnd') &&
      !getConditionTimingId(node)
    ) {
      skip(findUnsupportedBranchRoot(node, ancestors), 'PPTX_TIMING_DEPENDENCY_UNSUPPORTED');
    } else if (node.local === 'cond' && node.attrs.delay && parseDelay(node.attrs.delay) == null) {
      skip(findUnsupportedBranchRoot(node, ancestors), 'PPTX_TIMING_DELAY_UNSUPPORTED');
    }
  });
  return { nodes, warnings };
}

function findUnsupportedBranchRoot(node: TimingNode, ancestors: TimingNode[]): TimingNode {
  const path = [...ancestors, node];
  return (
    [...path]
      .reverse()
      .find((candidate) =>
        ['anim', 'animEffect', 'audio', 'cmd', 'set', 'video'].includes(candidate.local),
      ) ??
    [...path].reverse().find((candidate) => candidate.local === 'cTn') ??
    node
  );
}

function hasShapeTargetedClickCondition(node: TimingNode): boolean {
  const list = node.children.find((child) => child.local === 'stCondLst');
  return Boolean(
    list?.children.some(
      (condition) =>
        condition.local === 'cond' &&
        condition.attrs.evt === 'onClick' &&
        Boolean(findDescendant(condition, 'tgtEl') || findDescendant(condition, 'spTgt')),
    ),
  );
}

function collectSupportedAnimationComposites(
  root: TimingNode,
): Map<TimingNode, AnimationComposite> {
  const composites = new Map<TimingNode, AnimationComposite>();
  walk(root, (node) => {
    if (node.local !== 'cTn' || !isEffectNode(node)) return;
    const visualNodes = collectEffectVisualNodes(node);
    const nodesByTarget = new Map<string, TimingNode[]>();
    for (const visualNode of visualNodes) {
      const targetId = findDescendant(visualNode, 'spTgt')?.attrs.spid;
      if (!targetId) continue;
      const targetNodes = nodesByTarget.get(targetId) ?? [];
      targetNodes.push(visualNode);
      nodesByTarget.set(targetId, targetNodes);
    }

    for (const targetNodes of nodesByTarget.values()) {
      const animationNodes = targetNodes.filter((candidate) => candidate.local === 'anim');
      const setNodes = targetNodes.filter((candidate) => candidate.local === 'set');
      const effectNodes = targetNodes.filter((candidate) => candidate.local === 'animEffect');

      let propertyComposite: AnimationComposite | undefined;
      const isEntrance = setNodes.length === 1 && isVisibilitySet(setNodes[0], 'visible');
      const isExit = setNodes.length === 1 && isVisibilitySet(setNodes[0], 'hidden');
      if (
        animationNodes.length > 0 &&
        setNodes.length === 1 &&
        effectNodes.length <= 1 &&
        (isEntrance || isExit)
      ) {
        const animations = animationNodes.map(parsePropertyAnimation);
        if (animations.every((animation): animation is ParsedPropertyAnimation => !!animation)) {
          const propertyByName = new Map(
            animations.map((animation) => [animation.name, animation] as const),
          );
          const x = propertyByName.get('ppt_x');
          const y = propertyByName.get('ppt_y');
          const width = propertyByName.get('ppt_w');
          const height = propertyByName.get('ppt_h');
          let effect: AnimationComposite['effect'] | undefined;
          let propertyDurationMs: number | undefined;
          if (
            isEntrance &&
            propertyByName.size === 2 &&
            x &&
            y &&
            x.from === '#ppt_x' &&
            x.to === '#ppt_x' &&
            y.from === '1+#ppt_h/2' &&
            y.to === '#ppt_y' &&
            x.durationMs === y.durationMs
          ) {
            effect = 'fly(bottom)';
            propertyDurationMs = x.durationMs;
          } else if (
            isEntrance &&
            propertyByName.size === 2 &&
            width &&
            height &&
            width.from === '0' &&
            width.to === 'ppt_w' &&
            height.from === '0' &&
            height.to === 'ppt_h' &&
            width.durationMs === height.durationMs
          ) {
            effect = 'zoom';
            propertyDurationMs = width.durationMs;
          } else if (
            isEntrance &&
            x &&
            x.to === '#ppt_x' &&
            (/^#ppt_x-#ppt_w\*1\.125(?:0*)?$/.test(x.from) || x.from === '0-#ppt_w/2') &&
            (!y || (y.from === '#ppt_y' && y.to === '#ppt_y' && y.durationMs === x.durationMs))
          ) {
            effect = 'fly(left)';
            propertyDurationMs = x.durationMs;
          } else if (
            isExit &&
            y &&
            y.from === '#ppt_y' &&
            /^#ppt_y\+#ppt_h\*1\.125(?:0*)?$/.test(y.to) &&
            (!x || (x.from === '#ppt_x' && x.to === '#ppt_x' && x.durationMs === y.durationMs))
          ) {
            effect = 'fly(bottom)';
            propertyDurationMs = y.durationMs;
          }
          const pairedEffectDurationMs = effectNodes[0]
            ? parsePairedEffectDuration(effectNodes[0], isExit ? 'out' : 'in')
            : 0;
          if (effect && propertyDurationMs != null && pairedEffectDurationMs != null) {
            const nodes = [setNodes[0], ...animationNodes, ...effectNodes];
            propertyComposite = {
              primaryNode: setNodes[0],
              nodes,
              targetNode: findDescendant(setNodes[0], 'spTgt')!,
              effect,
              durationMs: Math.max(propertyDurationMs, pairedEffectDurationMs),
              referenceIds: nodes
                .map((candidate) => findDescendant(candidate, 'cTn')?.attrs.id)
                .filter((candidate): candidate is string => Boolean(candidate)),
            };
          }
        }
      }
      if (propertyComposite) {
        propertyComposite.nodes.forEach((candidate) =>
          composites.set(candidate, propertyComposite),
        );
        continue;
      }

      if (
        setNodes.length === 1 &&
        effectNodes.length === 1 &&
        ((isVisibilitySet(setNodes[0], 'visible') && effectNodes[0].attrs.transition === 'in') ||
          (isVisibilitySet(setNodes[0], 'hidden') && effectNodes[0].attrs.transition === 'out'))
      ) {
        const effect = effectNodes[0].attrs.filter;
        const durationMs = parseTimingDuration(findDescendant(effectNodes[0], 'cTn'));
        if (!effect || durationMs == null) continue;
        const nodes = [setNodes[0], effectNodes[0]];
        const composite: AnimationComposite = {
          primaryNode: effectNodes[0],
          nodes,
          targetNode: findDescendant(effectNodes[0], 'spTgt')!,
          effect,
          durationMs,
          referenceIds: nodes
            .map((candidate) => findDescendant(candidate, 'cTn')?.attrs.id)
            .filter((candidate): candidate is string => Boolean(candidate)),
        };
        nodes.forEach((candidate) => composites.set(candidate, composite));
      }
    }
  });
  return composites;
}

function collectEffectVisualNodes(effectNode: TimingNode): TimingNode[] {
  const visualNodes: TimingNode[] = [];
  const visit = (node: TimingNode): void => {
    if (node.local === 'cTn' && isEffectNode(node)) return;
    if (['set', 'anim', 'animEffect'].includes(node.local)) {
      visualNodes.push(node);
      return;
    }
    node.children.forEach(visit);
  };
  effectNode.children.forEach(visit);
  return visualNodes;
}

function isEffectNode(node: TimingNode): boolean {
  return ['clickEffect', 'withEffect', 'afterEffect'].includes(node.attrs.nodeType);
}

function isVisibilitySet(node: TimingNode, value: 'hidden' | 'visible'): boolean {
  return (
    findDescendant(node, 'attrName')?.text?.trim() === 'style.visibility' &&
    findDescendant(node, 'strVal')?.attrs.val?.toLowerCase() === value
  );
}

function parsePropertyAnimation(node: TimingNode): ParsedPropertyAnimation | undefined {
  if (node.attrs.calcmode !== 'lin' || node.attrs.valueType !== 'num') return undefined;
  const behavior = findDescendant(node, 'cBhvr');
  const timing = findDescendant(node, 'cTn');
  const durationMs = parseTimingDuration(timing);
  if (
    !behavior ||
    (behavior.attrs.additive && behavior.attrs.additive !== 'base') ||
    !timing ||
    (timing.attrs.fill && timing.attrs.fill !== 'hold') ||
    durationMs == null
  ) {
    return undefined;
  }
  const name = findDescendant(node, 'attrName')?.text?.trim();
  const values = findDescendants(node, 'tav');
  if (!name || values.length !== 2) return undefined;
  const valueByTime = new Map<string, string>();
  for (const value of values) {
    const parsedValue =
      findDescendant(value, 'fltVal')?.attrs.val ??
      findDescendant(value, 'strVal')?.attrs.val ??
      findDescendant(value, 'intVal')?.attrs.val;
    if (!value.attrs.tm || parsedValue == null || valueByTime.has(value.attrs.tm)) return undefined;
    valueByTime.set(value.attrs.tm, normalizeFormula(parsedValue));
  }
  const from = valueByTime.get('0');
  const to = valueByTime.get('100000');
  if (from == null || to == null) return undefined;
  return { name: name.toLowerCase(), from, to, durationMs };
}

function parseSimpleMotionAnimation(node: TimingNode): ParsedMotionAnimation | undefined {
  if (
    node.local !== 'animMotion' ||
    node.attrs.origin !== 'layout' ||
    node.attrs.pathEditMode !== 'relative'
  ) {
    return undefined;
  }
  const number = '[+-]?(?:\\d+(?:\\.\\d*)?|\\.\\d+)(?:[eE][+-]?\\d+)?';
  const path = node.attrs.path;
  if (!path) return undefined;
  const pointPattern = new RegExp(`([ML])\\s*(${number})[\\s,]+(${number})`, 'gi');
  const points: Array<{ command: string; x: number; y: number }> = [];
  let cursor = 0;
  for (const match of path.matchAll(pointPattern)) {
    if (path.slice(cursor, match.index).trim()) return undefined;
    points.push({ command: match[1].toUpperCase(), x: Number(match[2]), y: Number(match[3]) });
    cursor = (match.index ?? 0) + match[0].length;
  }
  if (
    path.slice(cursor).trim() ||
    points.length < 2 ||
    points.length > 200 ||
    points[0]?.command !== 'M' ||
    points.slice(1).some((point) => point.command !== 'L') ||
    points.some((point) => !Number.isFinite(point.x) || !Number.isFinite(point.y))
  ) {
    return undefined;
  }
  const { x: fromX, y: fromY } = points[0];
  const { x: toX, y: toY } = points.at(-1)!;
  const startsInside = fromX >= 0 && fromX <= 1 && fromY >= 0 && fromY <= 1;
  const endsInside = toX >= 0 && toX <= 1 && toY >= 0 && toY <= 1;
  const startsAtLayout = Math.abs(fromX) <= 0.05 && Math.abs(fromY) <= 0.05;
  if (fromX === toX && fromY === toY) return undefined;

  const behavior = findDescendant(node, 'cBhvr');
  const timing = findDescendant(node, 'cTn');
  const targetNode = findDescendant(node, 'spTgt');
  const durationMs = parseTimingDuration(timing);
  const attributeNames = new Set(
    findDescendants(node, 'attrName').map((candidate) => candidate.text?.trim().toLowerCase()),
  );
  if (
    !behavior ||
    (behavior.attrs.additive && behavior.attrs.additive !== 'base') ||
    !timing ||
    timing.attrs.fill !== 'hold' ||
    !targetNode?.attrs.spid ||
    durationMs == null ||
    attributeNames.size !== 2 ||
    !attributeNames.has('ppt_x') ||
    !attributeNames.has('ppt_y')
  ) {
    return undefined;
  }
  return {
    targetNode,
    durationMs,
    animationType: !startsAtLayout && !startsInside && endsInside ? 'in' : 'attention',
    motion: {
      fromX,
      fromY,
      toX,
      toY,
      ...(points.length > 2 ? { path: points.map(({ x, y }) => ({ x, y })) } : {}),
    },
  };
}

function parseHeldRotationAnimation(node: TimingNode): ParsedRotationAnimation | undefined {
  const animation = parsePropertyAnimation(node);
  const timing = findDescendant(node, 'cTn');
  const targetNode = findDescendant(node, 'spTgt');
  if (
    animation?.name !== 'style.rotation' ||
    timing?.attrs.fill !== 'hold' ||
    timing.attrs.decel !== '50000' ||
    timing.attrs.accel ||
    !targetNode?.attrs.spid ||
    findDescendant(targetNode, 'pRg') ||
    findDescendant(targetNode, 'charRg')
  ) {
    return undefined;
  }
  const fromDeg = Number(animation.from);
  const toDeg = Number(animation.to);
  if (
    ![fromDeg, toDeg].every(Number.isFinite) ||
    Math.abs(fromDeg) > 10_000 ||
    Math.abs(toDeg) > 10_000 ||
    fromDeg === toDeg
  ) {
    return undefined;
  }
  return {
    targetNode,
    durationMs: animation.durationMs,
    rotation: { fromDeg, toDeg },
  };
}

function parsePairedEffectDuration(node: TimingNode, transition: 'in' | 'out'): number | undefined {
  if (!node.attrs.filter || node.attrs.transition !== transition) return undefined;
  return parseTimingDuration(findDescendant(node, 'cTn'));
}

function normalizeFormula(value: string): string {
  return value.replace(/\s+/g, '').toLowerCase();
}

function getConditionTimingId(condition: TimingNode): string | undefined {
  return condition.attrs.tn || findDescendant(condition, 'tn')?.attrs.val;
}

function walk(
  node: TimingNode,
  visit: (node: TimingNode, ancestors: TimingNode[]) => void,
  ancestors: TimingNode[] = [],
  skippedNodes?: ReadonlySet<TimingNode>,
): void {
  if (skippedNodes?.has(node)) return;
  visit(node, ancestors);
  node.children.forEach((child) => walk(child, visit, [...ancestors, node], skippedNodes));
}

function findDescendant(node: TimingNode, local: string): TimingNode | undefined {
  if (node.local === local) return node;
  for (const child of node.children) {
    const found = findDescendant(child, local);
    if (found) return found;
  }
  return undefined;
}

function findDescendants(node: TimingNode, local: string): TimingNode[] {
  const matches = node.local === local ? [node] : [];
  return matches.concat(node.children.flatMap((child) => findDescendants(child, local)));
}

function parseDuration(value: string | undefined): number | undefined {
  if (!value || value === 'indefinite') return undefined;
  const duration = Number(value);
  return Number.isFinite(duration) && duration >= 0 && duration <= 30_000 ? duration : undefined;
}

function isLoopingRepeat(value: string | undefined): boolean {
  return value === 'indefinite' || value === 'untilEnd';
}

function parseTimingDuration(node: TimingNode | undefined): number | undefined {
  const duration = parseDuration(node?.attrs.dur);
  if (duration != null || !node) return duration;
  const conditions = node.children
    .find((child) => child.local === 'endCondLst')
    ?.children.filter((child) => child.local === 'cond');
  if (conditions?.length !== 1 || conditions[0].attrs.evt || getConditionTimingId(conditions[0])) {
    return undefined;
  }
  return parseDuration(conditions[0].attrs.delay);
}

function parseDelay(value: string | undefined): number | undefined {
  if (!value || value === 'indefinite') return 0;
  const delay = Number(value);
  return Number.isFinite(delay) && delay >= 0 && delay <= 30_000 ? delay : undefined;
}

function rejected(warning: string): PptxTimingParseResult {
  return { accepted: false, warning };
}
