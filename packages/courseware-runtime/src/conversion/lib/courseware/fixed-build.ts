import { maicQuizSchema } from "../../../maic-classroom";
import { projectNativeGroups } from './native-groups';
import { projectNativeTimeline } from './native-timeline';
import type { NativeTimeline } from '../../../native-timeline';
import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { mapSlideIrToScenes } from '../import/mappers/import-ir-to-classroom';
import type { SlideIR, ImportWarning } from '../import/types';
import { fixedBuildInputSchema, type FixedBuildInput } from './fixed-build-input';
import { hasGeneratedNativeMotions, projectNativeClicks, detachLinkedSpeechAnimations } from './native-click-animations';
import { validSpeechAnimationSequence } from '../../../speech-animation-sequence';
import { validateNativeAnimationBindings } from '../../../native-animation-node';
import type { NativeClickAnimations } from '../../../native-click-animations';

export const sha256 = (bytes: string | Uint8Array) =>
  createHash('sha256').update(bytes).digest('hex');
export function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, item) =>
    item && typeof item === 'object' && !Array.isArray(item)
      ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b)))
      : item,
  );
}

export class FixedBuildError extends Error {
  constructor(
    public readonly code: string,
    public readonly diagnostics: ImportWarning[] = [],
  ) {
    super(code);
  }
}
function requireBuild(condition: unknown, code: string): asserts condition {
  if (!condition) throw new FixedBuildError(code);
}
function unique(values: string[], code: string) {
  requireBuild(new Set(values).size === values.length, code);
}
function checkCancelled(signal?: AbortSignal) {
  if (signal?.aborted) throw new FixedBuildError('BUILD_CANCELLED');
}
async function checkedFile(file: { path: string; sha256: string }, maxBytes: number, signal?: AbortSignal) {
  checkCancelled(signal);
  requireBuild(path.isAbsolute(file.path), 'ABSOLUTE_FILE_REQUIRED');
  const info = await stat(file.path).catch(() => undefined);
  checkCancelled(signal);
  requireBuild(info?.isFile() && info.size <= maxBytes, 'ASSET_MISSING_OR_OVERSIZED');
  const bytes = await readFile(file.path);
  checkCancelled(signal);
  requireBuild(bytes.length <= maxBytes, 'ASSET_MISSING_OR_OVERSIZED');
  requireBuild(sha256(bytes) === file.sha256, 'HASH_MISMATCH');
  return bytes;
}
function safeRelative(value: string) {
  requireBuild(
    !path.isAbsolute(value) && !value.split(/[\\/]/).some((p) => p === '..') && value !== '',
    'UNSAFE_PACKAGE_PATH',
  );
  return value;
}

/** Verifies a pinned, dedicated worker before executing any code from it. */
async function verifyWorker(workerDirectory: string, expected: string, signal?: AbortSignal) {
  checkCancelled(signal);
  const bytes = await readFile(path.join(workerDirectory, 'manifest.json'));
  checkCancelled(signal);
  requireBuild(sha256(bytes) === expected, 'CONVERTER_HASH_MISMATCH');
  const manifest = JSON.parse(bytes.toString());
  requireBuild(
    Array.isArray(manifest.files) && manifest.files.length > 0,
    'CONVERTER_MANIFEST_INVALID',
  );
  for (const file of manifest.files) {
    await checkedFile(
      { path: path.join(workerDirectory, safeRelative(file.path)), sha256: file.sha256 },
      128 * 1024 * 1024,
      signal,
    );
  }
  requireBuild(
    manifest.files.some((file: { path: string }) => file.path === 'pptx-worker.mjs'),
    'CONVERTER_MANIFEST_INVALID',
  );
}

export function validateFixedMapping(input: FixedBuildInput, ir: SlideIR) {
  unique(
    ir.pages.map((p) => p.id),
    'DUPLICATE_IMPORT_PAGE',
  );
  unique(
    input.mapping.pages.map((p) => p.pageId),
    'DUPLICATE_PAGE_ID',
  );
  unique(
    input.mapping.pages.map((p) => p.importPageId),
    'DUPLICATE_IMPORT_PAGE',
  );
  unique(
    input.mapping.pages.flatMap((p) => [...p.objects, ...(p.groups ?? [])].map((o) => o.objectId)),
    'DUPLICATE_OBJECT_ID',
  );
  unique(
    input.teaching.pages.map((p) => p.pageId),
    'DUPLICATE_TEACHING_PAGE',
  );
  requireBuild(
    input.mapping.pages.length === ir.pages.length &&
      input.teaching.pages.length === ir.pages.length,
    'PAGE_MAPPING_MISMATCH',
  );
  for (const mapping of input.mapping.pages) {
    const page = ir.pages.find((p) => p.id === mapping.importPageId);
    requireBuild(page, 'PAGE_MAPPING_MISMATCH');
    unique(
      mapping.objects.map((o) => o.importElementId),
      'DUPLICATE_OBJECT_BINDING',
    );
    requireBuild(
      mapping.objects.length === page.elements.length &&
        mapping.objects.every((o) => page.elements.some((e) => e.id === o.importElementId)),
      'OBJECT_BINDING_MISMATCH',
    );
    try { projectNativeGroups(page, mapping.groups ?? []); }
    catch { throw new FixedBuildError('GROUP_BINDING_MISMATCH'); }
    requireBuild(
      input.teaching.pages.some((p) => p.pageId === mapping.pageId),
      'TEACHING_BINDING_MISMATCH',
    );
  }
  unique(
    input.teaching.pages.flatMap((p) => p.actions.map((a) => a.id)),
    'DUPLICATE_ACTION_ID',
  );
  unique(
    input.assets.map((a) => a.id),
    'DUPLICATE_ASSET_ID',
  );
  unique(
    input.teaching.pages.flatMap((p) =>
      p.actions.flatMap((a) => (a.type === 'interaction_checkpoint' ? [a.checkpointId] : [])),
    ),
    'DUPLICATE_CHECKPOINT_ID',
  );
  for (const teaching of input.teaching.pages) {
    const mapping = input.mapping.pages.find((p) => p.pageId === teaching.pageId)!;
    requireBuild(validSpeechAnimationSequence(teaching.actions), 'ANIMATION_TARGET_CONFLICT');
    for (const action of teaching.actions) {
      if (action.type !== 'speech') continue;
      requireBuild((action.visualCues ?? []).every(cue => !cue.trigger || cue.trigger.kind !== 'text' ||
        (!cue.trigger.stale && cue.trigger.audioAssetId === action.audioAssetId && action.text.slice(cue.trigger.start, cue.trigger.end) === cue.trigger.text)), 'SPEECH_TIMING_RECALIBRATION_REQUIRED');
      unique(
        (action.visualCues ?? []).map((cue) => cue.id),
        'DUPLICATE_VISUAL_CUE_ID',
      );
      for (const cue of action.visualCues ?? []) {
        const effect = cue.effect;
        const targets =
          effect.type === 'highlight'
            ? effect.elementIds
            : effect.type === 'spotlight'
              ? [effect.elementId, ...(effect.elementIds ?? [])]
              : [effect.elementId];
        requireBuild(
          targets.every((id) => mapping.objects.some((o) => o.objectId === id) ||
            effect.type !== 'element_animation' && mapping.groups?.some(group => group.objectId === id)),
          'EFFECT_BINDING_MISMATCH',
        );
        const page = ir.pages.find((p) => p.id === mapping.importPageId)!;
        for (const id of targets) {
          if (mapping.groups?.some(group => group.objectId === id)) continue;
          const element = page.elements.find(
            (e) => e.id === mapping.objects.find((o) => o.objectId === id)!.importElementId,
          )!;
          if (effect.type === 'element_animation')
            requireBuild(
              element.type !== 'audio' && element.type !== 'video',
              'ANIMATION_TARGET_UNSUPPORTED',
            );
          requireBuild(
            element.type !== 'line' && element.width > 0 && element.height > 0,
            'EFFECT_TARGET_UNSUPPORTED',
          );
        }
      }
    }
  }
  for (const action of input.teaching.pages.flatMap((p) => p.actions)) {
    if (action.type === 'video_clip') requireBuild(input.assets.some(asset => asset.id === action.videoAssetId && asset.mimeType === 'video/mp4'), 'VIDEO_ASSET_MISSING');
    if (action.type === 'interaction_checkpoint' && action.checkpointKind === 'chapter_summary')
      requireBuild(
        action.context.sourceSceneIds.every((id) =>
          input.mapping.pages.some((p) => p.pageId === id),
        ),
        'WAIT_BINDING_MISMATCH',
      );
    if (action.type === 'speech' || action.type === 'audio_clip')
      requireBuild(
        input.assets.some((a) => a.id === action.audioAssetId && a.mimeType.startsWith('audio/')),
        'AUDIO_ASSET_MISSING',
      );
  }
}

/** Builds only caller-owned fixed bytes. Never changes a source file or a previous valid build. */
export async function buildFixedCourseware(
  raw: unknown,
  options: { workerDirectory: string; outputDirectory: string; signal?: AbortSignal; nativeAssessments?: Record<string, unknown> },
) {
  checkCancelled(options.signal);
  const parsed = fixedBuildInputSchema.safeParse(raw);
  if (!parsed.success) throw new FixedBuildError('SNAPSHOT_SCHEMA_INVALID');
  const input = parsed.data;
  requireBuild(
    input.teaching.sourceSha256 === input.source.sha256 &&
      input.mapping.sourceSha256 === input.source.sha256,
    'STALE_INPUT_REVISION',
  );
  await verifyWorker(options.workerDirectory, input.converter.manifestSha256, options.signal);
  await mkdir(options.outputDirectory, { recursive: true });
  const staging = path.join(options.outputDirectory, `.building-${randomUUID()}`);
  await mkdir(staging);
  try {
    checkCancelled(options.signal);
    await writeFile(
      path.join(staging, 'source.pptx'),
      await checkedFile(input.source, 50 * 1024 * 1024, options.signal),
    );
    const assets: Array<{ id: string; path: string; sha256: string; mimeType: string }> = [];
    await mkdir(path.join(staging, 'assets'));
    let totalAssetBytes = 0;
    for (const asset of input.assets) {
      const bytes = await checkedFile(asset, 128 * 1024 * 1024, options.signal);
      totalAssetBytes += bytes.length;
      requireBuild(totalAssetBytes <= 256 * 1024 * 1024, 'ASSET_BUDGET_EXCEEDED');
      const extension: Record<string, string> = {
        'audio/wav': 'wav',
        'audio/mpeg': 'mp3',
        'video/mp4': 'mp4',
        'video/webm': 'webm',
        'image/png': 'png',
        'image/jpeg': 'jpg',
      };
      const destination = `assets/${asset.sha256}.${extension[asset.mimeType] ?? 'bin'}`;
      await writeFile(path.join(staging, destination), bytes);
      assets.push({
        id: asset.id,
        path: destination,
        sha256: asset.sha256,
        mimeType: asset.mimeType,
      });
    }
    checkCancelled(options.signal);
    const execution = promisify(execFile)(
      process.execPath,
      [
        '--max-old-space-size=768',
        path.join(options.workerDirectory, 'pptx-worker.mjs'),
        path.join(staging, 'source.pptx'),
        path.join(staging, 'conversion'),
      ],
      {
        timeout: 90_000,
        maxBuffer: 1024 * 1024,
        killSignal: 'SIGKILL',
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      },
    );
    // execFile's native AbortSignal path does not forward killSignal to spawn.
    const cancel = () => { execution.child.kill('SIGKILL'); };
    const closed = new Promise<void>(resolve => execution.child.once('close', () => resolve()));
    options.signal?.addEventListener('abort', cancel, { once: true });
    if (options.signal?.aborted) cancel();
    try {
      await execution;
    } catch (error) {
      checkCancelled(options.signal);
      throw error;
    } finally {
      options.signal?.removeEventListener('abort', cancel);
      await closed;
    }
    checkCancelled(options.signal);
    const result = JSON.parse(await readFile(path.join(staging, 'conversion/result.json'), 'utf8'));
    requireBuild(result.sourceSha256 === input.source.sha256, 'WORKER_SOURCE_MISMATCH');
    const ir: SlideIR = JSON.parse(
      await readFile(path.join(staging, 'conversion/slide-ir.json'), 'utf8'),
    );
    const diagnostics = ir.warnings ?? [];
    if (diagnostics.some(warning => warning.code.startsWith('PPTX_TIMING_')))
      throw new FixedBuildError('NATIVE_ANIMATION_UNSUPPORTED', diagnostics);
    if (diagnostics.some((w) => w.severity === 'error'))
      throw new FixedBuildError('CONTENT_ERROR', diagnostics);
    if (
      diagnostics.some(
        (w) =>
          (w.severity ?? 'warning') === 'warning' && !input.reviewedWarningCodes.includes(w.code),
      )
    )
      throw new FixedBuildError('CONTENT_REVIEW_REQUIRED', diagnostics);
    validateFixedMapping(input, ir);
    const importedAssets = path.join(staging, 'conversion/assets');
    for (const file of await readdir(importedAssets).catch(() => [] as string[])) {
      checkCancelled(options.signal);
      if (file.endsWith('.json')) continue;
      const bytes = await readFile(path.join(importedAssets, safeRelative(file)));
      totalAssetBytes += bytes.length;
      requireBuild(totalAssetBytes <= 256 * 1024 * 1024, 'ASSET_BUDGET_EXCEEDED');
      const metadata = JSON.parse(
        await readFile(
          path.join(importedAssets, `${file.slice(0, file.lastIndexOf('.'))}.json`),
          'utf8',
        ),
      );
      const id = `import-asset:local:${file.slice(0, file.lastIndexOf('.'))}`;
      const digest = sha256(bytes);
      const destination = `assets/${digest}${path.extname(file)}`;
      await writeFile(path.join(staging, destination), bytes);
      assets.push({ id, path: destination, sha256: digest, mimeType: metadata.mimeType });
    }
    unique(
      assets.map((a) => a.id),
      'DUPLICATE_ASSET_ID',
    );
    const scenes = mapSlideIrToScenes('fixed-build', ir);
    const quizImages: Array<{ id: string; path: string; sha256: string; mimeType: string; bytes: Buffer }> = [];
    const pages = ir.pages.map((page, index) => {
      const mapping = input.mapping.pages.find((p) => p.importPageId === page.id)!;
      const scene = scenes[index];
      requireBuild(scene.content.type === 'slide', 'INVALID_SLIDE');
      const canvas = scene.content.canvas;
      const groups = projectNativeGroups(page, mapping.groups ?? []);
      canvas.elements.push(...groups.map(group => group.element));
      const actions = input.teaching.pages.find((p) => p.pageId === mapping.pageId)!.actions;
      let nativeAnimations: NativeClickAnimations | undefined;
      let nativeTimeline: NativeTimeline | undefined;
      try {
        const remaining = detachLinkedSpeechAnimations(page, actions, mapping.objects);
        if (!hasGeneratedNativeMotions(remaining, actions, mapping.objects)) {
          try { nativeAnimations = projectNativeClicks(remaining); }
          catch (error) {
            if (actions.some(action => action.type === 'native_animation')) throw error;
            nativeTimeline = projectNativeTimeline(remaining, mapping.groups ?? []);
          }
        }
      }
      catch { throw new FixedBuildError('NATIVE_ANIMATION_UNSUPPORTED', [...diagnostics, {
        code: 'NATIVE_ANIMATION_UNSUPPORTED', severity: 'error', pageIndex: index,
        message: 'Fixed playback requires verified finite whole-object presets and unchanged animation bindings.',
      }]); }
      if (actions.some(action => action.type === 'native_animation')) {
        requireBuild(validateNativeAnimationBindings(actions, input.source.sha256, nativeAnimations?.steps.length ?? 0),
          'NATIVE_ANIMATION_BINDING_MISMATCH');
        nativeAnimations = { ...nativeAnimations!, version: 2 as const, sequence: 'teaching-timeline' as const };
        const revealed = new Set<string>();
        for (const action of actions) {
          if (action.type === 'native_animation') revealed.add(nativeAnimations.steps[action.stepIndex].elementId);
          if (action.type === 'speech') for (const cue of action.visualCues ?? []) {
            const effect = cue.effect;
            const ids = effect.type === 'highlight' ? effect.elementIds
              : [effect.elementId, ...(effect.type === 'spotlight' ? effect.elementIds ?? [] : [])];
            requireBuild(ids.every(id => {
              const imported = mapping.objects.find(object => object.objectId === id)?.importElementId;
              return !nativeAnimations!.steps.some(step => step.elementId === imported) || revealed.has(imported!);
            }), 'NATIVE_ANIMATION_TARGET_NOT_REVEALED');
          }
        }
      }
      if (nativeTimeline?.groups) {
        const extraGroups = nativeTimeline.groups.filter(group => !canvas.elements.some(element => element.id === group.elementId));
        for (const group of extraGroups) {
          const sourceShapeId = group.elementId.slice('native_group_source_'.length);
          const [derived] = projectNativeGroups(page, [{ objectId: `source_${sourceShapeId}`, sourceShapeId }]);
          canvas.elements.push(derived.element);
          groups.push(derived);
        }
      }
      if (nativeAnimations || nativeTimeline) {
        const nativeTargets = new Set([...(nativeAnimations?.steps.map(step => step.elementId) ?? []),
          ...(nativeTimeline?.steps.flatMap(step => step.items.map(item => item.elementId)) ?? [])]);
        for (const action of actions) if (action.type === 'speech') for (const cue of action.visualCues ?? []) {
          const effect = cue.effect;
          // Attention overlays preserve the native object animation owner.
          if (effect.type === 'element_animation') requireBuild(
            !nativeTargets.has(mapping.objects.find(object => object.objectId === effect.elementId)?.importElementId ?? ''),
            'NATIVE_ANIMATION_CUE_CONFLICT');
        }
      }
      const quiz = options.nativeAssessments?.[mapping.pageId] ? maicQuizSchema.parse(options.nativeAssessments[mapping.pageId]) : undefined;
      if (quiz) {
        for (const q of quiz.questions) for (const image of [q.image, ...(q.options ?? []).map(o => o.image)]) if (image) {
          const match = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/]+={0,2})$/.exec(image.src);
          requireBuild(match && match[2].length <= 7 * 1024 * 1024, 'INVALID_QUIZ_IMAGE');
          const bytes = Buffer.from(match[2], 'base64');
          requireBuild(bytes.length > 0 && bytes.toString('base64') === match[2], 'INVALID_QUIZ_IMAGE');
          const digest = sha256(bytes), id = `quiz-${digest}`, destination = `assets/${digest}.${match[1].slice(6)}`;
          quizImages.push({ id, path: destination, sha256: digest, mimeType: match[1], bytes }); image.src = id;
        }
      }
      return {
        ...(quiz ? { quiz } : {}),
        pageId: mapping.pageId,
        title: scene.title,
        slide: canvas,
        objects: [...mapping.objects, ...groups.map(group => ({ objectId: group.objectId, importElementId: group.element.id }))],
        actions,
        ...(nativeAnimations ? { nativeAnimations } : {}),
        ...(nativeTimeline ? { nativeTimeline } : {}),
      };
    });
    for (const image of new Map(quizImages.map(i => [i.id, i])).values()) {
      totalAssetBytes += image.bytes.length; requireBuild(totalAssetBytes <= 256 * 1024 * 1024, 'ASSET_BUDGET_EXCEEDED');
      await writeFile(path.join(staging, image.path), image.bytes);
      const { bytes: _bytes, ...asset } = image; assets.push(asset);
    }
    // Every runtime resource must be archived; arbitrary URLs/placeholders never reach playback.
    const refs = new Set(assets.map((a) => a.id));
    function validateResources(value: unknown): void {
      if (!value || typeof value !== 'object') return;
      for (const [key, child] of Object.entries(value)) {
        if (['src', 'poster'].includes(key) && typeof child === 'string' && child)
          requireBuild(refs.has(child), 'UNARCHIVED_RESOURCE');
        else validateResources(child);
      }
    }
    validateResources(pages);
    const visualCues = input.teaching.pages.flatMap((p) =>
      p.actions.flatMap((a) => (a.type === 'speech' ? (a.visualCues ?? []) : [])),
    );
    const hasAnimations = visualCues.some((cue) => cue.effect.type === 'element_animation');
    const report = {
      ready: true,
      reviewedWarningCodes: input.reviewedWarningCodes,
      visualFidelity: 'NOT_VERIFIED',
      diagnostics,
      capabilities: {
        staticSlides: 'limited',
        fixedNarration: true,
        teacherWait: true,
        ...(pages.some(page => page.actions.some(action => action.type === 'audio_clip')) ? { teachingAudioClips: 'sequential/1' } : {}),
        transitions: false,
        objectAnimations: false,
        ...(pages.some(page => page.nativeTimeline || page.nativeAnimations) ? { nativeObjectAnimations:
          pages.some(page => page.nativeTimeline) ? 'finite-presets/1' : pages.some(page => page.nativeAnimations?.version === 2) ? 'click-appear-fade/2' : 'click-appear-fade/1' } : {}),
        spotlight: visualCues.some((cue) => cue.effect.type === 'spotlight'),
        ...(visualCues.length
          ? { speechVisualCues: hasAnimations ? 'fixed-audio/2' : 'fixed-audio/1' }
          : {}),
        ...(hasAnimations ? { playerObjectAnimations: visualCues.some(cue => cue.effect.type === 'element_animation' && !['fadeIn', 'fadeOut', 'pulse'].includes(cue.effect.effect)) ? 'speech-motion/2' : 'fade-pulse/1' } : {}),
      },
      sourceSha256: input.source.sha256,
      sourceRevision: input.source.revision,
      teachingRevision: input.teaching.revision,
      mappingRevision: input.mapping.revision,
      converter: input.converter,
    };
    const payload = { schemaVersion: 'deckwise-playback/1', report, pages, assets };
    const packageJson = canonicalJson(payload);
    const packageHash = sha256(packageJson);
    // Absolute paths and worker run timings do not contribute to content identity.
    const buildId = packageHash;
    await writeFile(path.join(staging, 'package.json'), packageJson);
    await writeFile(path.join(staging, 'report.json'), canonicalJson(report));
    await rm(path.join(staging, 'conversion'), { recursive: true });
    const files = [
      'source.pptx',
      'package.json',
      'report.json',
      ...new Set(assets.map((a) => a.path)),
    ];
    const manifest = {
      schemaVersion: 'deckwise-build-manifest/1',
      buildId,
      packageHash,
      files: await Promise.all(
        files.map(async (file) => ({
          path: file,
          sha256: sha256(await readFile(path.join(staging, file))),
        })),
      ),
    };
    await writeFile(path.join(staging, 'manifest.json'), canonicalJson(manifest));
    const directory = path.join(options.outputDirectory, buildId);
    // Publication begins here; Host must still fence adoption against a later session cancellation.
    checkCancelled(options.signal);
    try {
      await rename(staging, directory);
    } catch (error) {
      if (!['EEXIST', 'ENOTEMPTY'].includes((error as NodeJS.ErrnoException).code ?? ''))
        throw error;
      requireBuild(
        (await readFile(path.join(directory, 'manifest.json'), 'utf8')) === canonicalJson(manifest),
        'EXISTING_BUILD_MISMATCH',
      );
      for (const file of manifest.files)
        requireBuild(
          sha256(await readFile(path.join(directory, file.path))) === file.sha256,
          'EXISTING_BUILD_MISMATCH',
        );
    }
    return { buildId, packageHash, directory, report };
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}
