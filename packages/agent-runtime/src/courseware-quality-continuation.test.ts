import { expect, it, vi } from 'vitest';
import type { AgentTurnContext } from '@earendil-works/pi-agent-core';
import { CoursewareTurnContinuation } from './courseware-turn-continuation.js';

it('enters final reporting from a ready tool result without waiting for the model to stop tools', async () => {
  const continuation = new CoursewareTurnContinuation();
  const snapshot = { projectId: 'project', sourceSha256: 'a'.repeat(64), teachingRevision: 't1', jobs: [],
    narrationReady: true, audioReady: true, teachingReady: true, completion: { ready: true },
    pages: [{ actions: [{ text: 'x'.repeat(338000) }] }] };
  const turn: AgentTurnContext = { context: { messages: [] }, newMessages: [], message: { role: 'assistant',
    api: 'openai-completions', provider: 'fixture', model: 'fixture', timestamp: 0, stopReason: 'toolUse',
    content: [{ type: 'toolCall', id: 'status', name: 'courseware_media_context', arguments: { continueTeaching: true } }],
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } },
    toolResults: [{ role: 'toolResult', toolCallId: 'status', toolName: 'courseware_media_context', content: [], isError: false, timestamp: 0, details: snapshot }] };
  const execute = vi.fn(async () => ({ content: [], details: snapshot }));
  const instruction = await continuation.finish(turn, { execute, canWait: () => true });
  expect(continuation.reportOnly).toBe(true);
  expect(instruction).toContain('completed');
  expect(instruction!.length).toBeLessThan(10000);
});

it('allows exactly two unchanged advisory repairs and then finishes without blocking playback', async () => {
  const continuation = new CoursewareTurnContinuation();
  const empty: AgentTurnContext = { context: { messages: [] }, newMessages: [], toolResults: [], message: { role: 'assistant',
    api: 'openai-completions', provider: 'fixture', model: 'fixture', timestamp: 0, content: [{ type: 'text', text: 'Done' }], stopReason: 'stop',
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } } };
  const activation: AgentTurnContext = { ...empty, message: { ...empty.message, content: [{ type: 'toolCall', id: 'activate', name: 'courseware_media_context', arguments: { continueTeaching: true } }], stopReason: 'toolUse' },
    toolResults: [{ role: 'toolResult', toolCallId: 'activate', toolName: 'courseware_media_context', content: [], isError: false, timestamp: 0, details: { sourceSha256: 'a'.repeat(64) } }] };
  const snapshot = { sourceSha256: 'a'.repeat(64), jobs: [], narrationReady: true, audioReady: true, teachingReady: true,
    quality: { blocking: false, issues: [{ pageId: 'page', code: 'FOCUS_MISSING', repair: 'narration', repairable: true }] } };
  const execute = vi.fn(async () => ({ content: [], details: snapshot }));
  const controls = { execute, canWait: () => true };
  expect(await continuation.finish(activation, controls)).toBeUndefined();
  for (let attempt = 0; attempt < 2; attempt++) expect(await continuation.finish(empty, controls)).toContain('non-blocking teaching diagnostics');
  expect(await continuation.finish(empty, controls)).toContain('unresolved teaching diagnostics');
  expect(continuation.reportOnly).toBe(true);
  await continuation.finish(activation, controls);
  expect(await continuation.finish(empty, controls)).toBeUndefined();
  expect(execute).toHaveBeenCalledTimes(3);
});

it('keeps a batch TTS result active until its original pending jobs finish', async () => {
  const continuation = new CoursewareTurnContinuation();
  const sourceSha256 = 'a'.repeat(64);
  const jobs = Array.from({ length: 101 }, (_, i) => ({ kind: 'tts', intentId: `original-${i}`, pageNumber: 1, sourceSha256 }));
  jobs.push({ kind: 'tts', intentId: 'other-page', pageNumber: 2, sourceSha256 });
  jobs.push({ kind: 'music', intentId: 'original-music', pageNumber: 1, sourceSha256 });
  const message: AgentTurnContext['message'] = { role: 'assistant', api: 'openai-completions', provider: 'fixture',
    model: 'fixture', timestamp: 0, content: [{ type: 'text', text: 'Still processing' }], stopReason: 'stop',
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
  const turn: AgentTurnContext = { context: { messages: [] }, newMessages: [], message: { ...message, stopReason: 'toolUse',
    content: [{ type: 'toolCall', id: 'batch', name: 'courseware_media_prepare', arguments: { kind: 'tts', actionIds: ['one', 'two'] } }] },
    toolResults: [{ role: 'toolResult', toolCallId: 'batch', toolName: 'courseware_media_prepare', content: [],
      isError: false, timestamp: 0, details: { sourceSha256, saved: false, jobs, failures: [] } }] };
  let complete = false;
  const execute = vi.fn(async (name: string) => {
    if (name === 'courseware_media_refresh') { complete = true; return { content: [], details: { saved: true } }; }
    return { content: [], details: { sourceSha256, jobs: complete ? [] : jobs } };
  });
  const controls = { execute, canWait: () => true };
  await continuation.finish(turn, controls);
  await continuation.finish({ ...turn, message, toolResults: [] }, controls);
  const refreshes = execute.mock.calls.filter(([name]) => name === 'courseware_media_refresh');
  expect(refreshes).toHaveLength(4);
  expect(execute).toHaveBeenCalledWith('courseware_media_refresh', { kind: 'tts', sourceSha256, pageNumber: 1,
    intentIds: jobs.slice(0, 100).map(job => job.intentId) }, undefined);
  for (const job of jobs.slice(100)) expect(execute).toHaveBeenCalledWith('courseware_media_refresh', job, undefined);
  expect(complete).toBe(true);
});


it('does not complete when required teaching is missing despite playable speech', async () => {
  const continuation = new CoursewareTurnContinuation();
  const message: AgentTurnContext['message'] = { role: 'assistant', api: 'openai-completions', provider: 'fixture', model: 'fixture', timestamp: 0,
    content: [{ type: 'text', text: 'Done' }], stopReason: 'stop',
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
  const closing: AgentTurnContext = { context: { messages: [] }, newMessages: [], toolResults: [], message };
  await continuation.finish({ ...closing, message: { ...message, stopReason: 'toolUse', content: [{ type: 'toolCall', id: 'activate', name: 'courseware_media_context', arguments: { continueTeaching: true } }] },
    toolResults: [{ role: 'toolResult', toolCallId: 'activate', toolName: 'courseware_media_context', timestamp: 0, content: [], isError: false, details: { sourceSha256: 'a'.repeat(64) } }] },
    { execute: async () => ({ content: [], details: {} }), canWait: () => true });
  const snapshot = { sourceSha256: 'a'.repeat(64), jobs: [], narrationReady: true, audioReady: true, teachingReady: true,
    completion: { ready: false, issues: [{ pageId: 'page', code: 'QUESTION_MISSING', repair: 'narration', repairable: true }] } };
  const instruction = await continuation.finish(closing, { execute: async () => ({ content: [], details: snapshot }), canWait: () => true });
  expect(instruction).toContain('QUESTION_MISSING');
  expect(instruction).toContain('unfinished');
});

it('repairs missing focus through the preserving delta path before final reporting', async () => {
  const continuation = new CoursewareTurnContinuation();
  let repaired = false;
  const snapshot = () => ({ sourceSha256: 'a'.repeat(64), jobs: [], narrationReady: true, audioReady: true, teachingReady: true,
    completion: { ready: true }, quality: { issues: repaired ? [] : [{ pageNumber: 6, pageId: 'page', code: 'FOCUS_MISSING', repair: 'narration', repairable: true }] } });
  const message: AgentTurnContext['message'] = { role: 'assistant', api: 'openai-completions', provider: 'fixture', model: 'fixture', timestamp: 0,
    content: [{ type: 'toolCall', id: 'activate', name: 'courseware_media_context', arguments: { continueTeaching: true } }], stopReason: 'toolUse',
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
  const execute = vi.fn(async (name: string) => {
    if (name === 'courseware_narration_propose') { repaired = true; return { content: [], details: { saved: true } }; }
    return { content: [], details: snapshot() };
  });
  const result = await continuation.finish({ context: { messages: [] }, newMessages: [], message,
    toolResults: [{ role: 'toolResult', toolCallId: 'activate', toolName: 'courseware_media_context', content: [], isError: false, timestamp: 0, details: snapshot() }] },
    { execute, canWait: () => true });
  expect(result).toContain('completed');
  expect(execute).toHaveBeenCalledWith('courseware_narration_propose', expect.objectContaining({ pageNumbers: [6], repairRequiredTeaching: true }), undefined);
  expect(execute.mock.calls.some(([name]) => name.includes('media_prepare'))).toBe(false);
});

it('validates a scene plan write before allowing the model to finish and bounds invalid repairs', async () => {
  const continuation = new CoursewareTurnContinuation();
  const turn: AgentTurnContext = { context: { messages: [] }, newMessages: [], message: { role: 'assistant',
    api: 'openai-completions', provider: 'fixture', model: 'fixture', timestamp: 0, stopReason: 'toolUse',
    content: [{ type: 'toolCall', id: 'write', name: 'Write', arguments: { file_path: '.deckwise-ppt/scenes/chat/plan.json' } }],
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } },
    toolResults: [{ role: 'toolResult', toolCallId: 'write', toolName: 'Write', content: [], isError: false, timestamp: 0 }] };
  const execute = vi.fn(async () => { throw new Error('Question and choices must be visible on scene page 6'); });
  const controls = { execute, canWait: () => true };
  for (let i = 0; i < 2; i++) {
    expect(await continuation.finish(turn, controls)).toContain('not ready for review');
    expect(continuation.reportOnly).toBe(false);
  }
  expect(await continuation.finish(turn, controls)).toContain('planning is unfinished');
  expect(continuation.reportOnly).toBe(true);
  expect(execute.mock.calls).toHaveLength(3);
  continuation.reset();
  await continuation.finish(turn, { canWait: () => true, execute: async () => ({ content: [], details: { validated: true } }) });
  expect(await continuation.finish({ ...turn, message: { ...turn.message, content: [{ type: 'text', text: 'The draft is ready' }], stopReason: 'stop' }, toolResults: [] }, { canWait: () => true, execute: async () => ({ content: [], details: { validated: true, awaitingPlanApproval: true } }) })).toBeUndefined();
  expect(continuation.reportOnly).toBe(true);
});

it('does not revalidate after a failed edit and accepts a corrected plan', async () => {
  const continuation = new CoursewareTurnContinuation();
  const makeTurn = (name: string, args: Record<string, string>, isError = false): AgentTurnContext => ({
    context: { messages: [] }, newMessages: [],
    message: { role: 'assistant', api: 'openai-completions', provider: 'fixture', model: 'fixture', timestamp: 0,
      stopReason: 'toolUse', content: [{ type: 'toolCall', id: 'call', name, arguments: args }],
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } },
    toolResults: [{ role: 'toolResult', toolCallId: 'call', toolName: name, content: [], isError, timestamp: 0 }],
  });
  const execute = vi.fn(async () => ({ content: [{ type: 'text' as const, text: 'Question must be visible on page 1' }], details: {}, isError: true }));
  const controls = { execute, canWait: () => true };
  await continuation.finish(makeTurn('Write', { file_path: '.deckwise-ppt/scenes/chat/plan.json', content: '{}' }), controls);
  await continuation.finish(makeTurn('courseware_scene_plan_submit', {}, true), controls);
  await continuation.finish(makeTurn('Edit', { file_path: '.deckwise-ppt/scenes/chat/plan.json', old_string: 'bad', new_string: 'good' }, true), controls);
  expect(execute).toHaveBeenCalledTimes(1);
  expect(continuation.reportOnly).toBe(false);
  const write = makeTurn('Write', { file_path: '.deckwise-ppt/scenes/chat/plan.json', content: '{"pages":[]}' });
  await continuation.finish(write, { canWait: () => true, execute: async () => ({ content: [], details: { validated: true, awaitingPlanApproval: true } }) });
  const final = await continuation.finish({ ...write, message: { ...write.message, stopReason: 'stop', content: [{ type: 'text', text: 'Draft ready' }] }, toolResults: [] },
    { canWait: () => true, execute: async () => ({ content: [], details: { validated: true, awaitingPlanApproval: true } }) });
  expect(final).toBeUndefined();
  expect(continuation.reportOnly).toBe(true);
});

it.each(['path', 'file_path'])('preserves both corrections when shell reads precede the first invalid scene draft using %s', async pathKey => {
  const continuation = new CoursewareTurnContinuation();
  const makeTurn = (name: string, args: Record<string, string>): AgentTurnContext => ({
    context: { messages: [] }, newMessages: [],
    message: { role: 'assistant', api: 'openai-completions', provider: 'fixture', model: 'fixture', timestamp: 0,
      stopReason: 'toolUse', content: [{ type: 'toolCall', id: 'call', name, arguments: args }],
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } },
    toolResults: [{ role: 'toolResult', toolCallId: 'call', toolName: name, content: [], isError: false, timestamp: 0 }],
  });
  const execute = vi.fn(async () => { throw new Error('Question and choices must be visible on scene page 1'); });
  const controls = { execute, canWait: () => true };
  await continuation.finish(makeTurn('Write', { path: 'notes.md', content: '.deckwise-ppt/scenes/chat/plan.json' }), controls);
  await continuation.finish(makeTurn('Write', { path: '.deckwise-ppt/scenes/chat/plan.json.backup', content: '{}' }), controls);
  await continuation.finish(makeTurn('Bash', { command: 'cat .deckwise-ppt/scenes/chat/plan.json 2>/dev/null | head -50' }), controls);
  await continuation.finish(makeTurn('Bash', { command: 'cat .deckwise-ppt/scenes/reference/plan.json | head -60' }), controls);
  const write = makeTurn('Write', { [pathKey]: '.deckwise-ppt/scenes/chat/plan.json', content: '{}' });
  expect(await continuation.finish(write, controls)).toContain('not ready for review');
  expect(continuation.reportOnly).toBe(false);
  expect(execute).toHaveBeenCalledTimes(1);
  await continuation.finish(makeTurn('Bash', { command: 'cat .deckwise-ppt/scenes/chat/plan.json' }), controls);
  expect(execute).toHaveBeenCalledTimes(1);
  expect(await continuation.finish(write, controls)).toContain('not ready for review');
  expect(continuation.reportOnly).toBe(false);
  const valid = { canWait: () => true, execute: async () => ({ content: [], details: { validated: true, awaitingPlanApproval: true } }) };
  await continuation.finish(write, valid);
  const closing = { ...write, message: { ...write.message, stopReason: 'stop' as const, content: [{ type: 'text' as const, text: 'Draft ready' }] }, toolResults: [] };
  expect(await continuation.finish(closing, valid)).toBeUndefined();
  expect(continuation.reportOnly).toBe(true);
});

it('keeps an unchanged approved plan available for image work after validation', async () => {
  const continuation = new CoursewareTurnContinuation();
  const turn: AgentTurnContext = { context: { messages: [] }, newMessages: [], message: { role: 'assistant',
    api: 'openai-completions', provider: 'fixture', model: 'fixture', timestamp: 0, stopReason: 'toolUse',
    content: [{ type: 'toolCall', id: 'write', name: 'Write', arguments: { path: '.deckwise-ppt/scenes/chat/plan.json' } }],
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } },
    toolResults: [{ role: 'toolResult', toolCallId: 'write', toolName: 'Write', content: [], isError: false, timestamp: 0 }] };
  const execute = vi.fn(async () => ({ content: [], details: { validated: true, awaitingPlanApproval: false } }));
  const controls = { execute, canWait: () => true };
  expect(await continuation.finish(turn, controls)).toBeUndefined();
  expect(await continuation.finish({ ...turn, toolResults: [], message: { ...turn.message,
    stopReason: 'stop', content: [{ type: 'text', text: 'The approved plan is unchanged.' }] } }, controls)).toBeUndefined();
  expect(continuation.reportOnly).toBe(false);
  expect(execute).toHaveBeenCalledTimes(1);
});

it('keeps validation failure active even when a plan write was not observed', async () => {
  const continuation = new CoursewareTurnContinuation();
  const turn: AgentTurnContext = { context: { messages: [] }, newMessages: [], message: { role: 'assistant',
    api: 'openai-completions', provider: 'fixture', model: 'fixture', timestamp: 0, stopReason: 'toolUse',
    content: [{ type: 'toolCall', id: 'submit', name: 'courseware_scene_plan_submit', arguments: {} }],
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } },
    toolResults: [{ role: 'toolResult', toolCallId: 'submit', toolName: 'courseware_scene_plan_submit',
      content: [{ type: 'text', text: 'Question must be visible on page 6' }], isError: true, timestamp: 0 }] };
  const instruction = await continuation.finish(turn, { canWait: () => true,
    execute: async () => { throw new Error('duplicate submit'); } });
  expect(instruction).toContain('Question must be visible on page 6');
  expect(instruction).toContain('not ready for review');
  expect(continuation.reportOnly).toBe(false);
});

it('bounds repeated invalid scene submissions after shell-authored corrections', async () => {
  const continuation = new CoursewareTurnContinuation();
  const turn: AgentTurnContext = { context: { messages: [] }, newMessages: [], message: { role: 'assistant',
    api: 'openai-completions', provider: 'fixture', model: 'fixture', timestamp: 0, stopReason: 'toolUse',
    content: [{ type: 'toolCall', id: 'submit', name: 'courseware_scene_plan_submit', arguments: {} }],
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } },
    toolResults: [{ role: 'toolResult', toolCallId: 'submit', toolName: 'courseware_scene_plan_submit',
      content: [{ type: 'text', text: 'Invalid scene course page 4 teaching.pageType' }], isError: true, timestamp: 0 }] };
  const execute = vi.fn(async () => { throw new Error('duplicate submit'); });
  const controls = { canWait: () => true, execute };
  for (let attempt = 0; attempt < 2; attempt++) {
    const instruction = await continuation.finish(turn, controls);
    expect(instruction).toContain('not ready for review');
    expect(instruction).toContain('Invalid scene course page 4 teaching.pageType');
    await continuation.finish({ ...turn, message: { ...turn.message, content: [{ type: 'toolCall', id: 'shell', name: 'Bash', arguments: { command: 'rewrite plan.json' } }] },
      toolResults: [{ role: 'toolResult', toolCallId: 'shell', toolName: 'Bash', content: [], isError: false, timestamp: 0 }] }, controls);
  }
  expect(await continuation.finish(turn, controls)).toContain('planning is unfinished');
  expect(continuation.reportOnly).toBe(true);
  expect(execute).not.toHaveBeenCalled();
});

it('stops automatic generation for unmatched fixed scripts or lesson-plan activities', async () => {
  const continuation = new CoursewareTurnContinuation();
  const snapshot = { projectId: 'native', nativeTeaching: true, sourceSha256: 'a'.repeat(64), teachingRevision: 'saved', jobs: [],
    narrationReady: false, audioReady: false, teachingReady: false, completion: { ready: false,
      issues: [{ code: 'SCRIPT_UNMATCHED', pageNumber: 0, repair: 'materials', repairable: false }] } };
  const turn: AgentTurnContext = { context: { messages: [] }, newMessages: [], message: { role: 'assistant',
    api: 'openai-completions', provider: 'fixture', model: 'fixture', timestamp: 0, stopReason: 'toolUse',
    content: [{ type: 'toolCall', id: 'status', name: 'courseware_media_context', arguments: { continueTeaching: true } }],
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } },
    toolResults: [{ role: 'toolResult', toolCallId: 'status', toolName: 'courseware_media_context', content: [], isError: false, timestamp: 0, details: snapshot }] };
  const execute = vi.fn(async () => ({ content: [], details: snapshot }));
  await continuation.finish(turn, { execute, canWait: () => true });
  const report = await continuation.finish({ ...turn, message: { ...turn.message, stopReason: 'stop', content: [] }, toolResults: [] }, { execute, canWait: () => true });
  expect(report).toContain('cannot be repaired automatically');
  expect(report).toContain('SCRIPT_UNMATCHED');
  expect(execute).toHaveBeenCalledTimes(1);
});
