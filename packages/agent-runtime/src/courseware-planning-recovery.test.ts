import { expect, it } from "vitest";
import { createAssistantMessageEventStream, getCurrentTools, type AssistantMessage } from "@earendil-works/pi-ai";
import { fixture, sha256 } from "./courseware-turn-continuation.fixture.js";

it('preserves exact planning errors and two rewritten corrections despite repeated submission before human review', async () => {
  const f = fixture();
  let valid = false;
  const executed: string[] = [];
  const execute = f.runtime['host'].call.bind(f.runtime['host']);
  f.runtime['host'].call = async <T>(method: string, params: unknown): Promise<T> => {
    if (method === 'project.instructions.resolve') return undefined as T;
    if (method !== 'tools.execute') return execute<T>(method, params);
    const { toolName, args } = params as { toolName: string; args: Record<string, unknown> };
    executed.push(toolName);
    if (toolName === 'Bash') return { ok: true, content: 'Reference plan' } as T;
    if (toolName === 'Write') { valid = args.content === '{"corrected":true}'; return { ok: true, content: 'Written' } as T; }
    if (toolName === 'courseware_scene_plan_submit') return (valid
      ? { ok: true, content: { validated: true, awaitingPlanApproval: true, plan: { sha256, approvedSha256: 'b'.repeat(64) } } }
      : { ok: false, errorCode: 'COURSEWARE_WORKFLOW_REJECTED', content: { error: 'Scene course正文 pages exceed the requested limit: 6 > 4' } }) as T;
    if (toolName === 'courseware_workflow_get') return { ok: true,
      content: { task: { taskType: 'scene', generated: false }, plan: { sha256, approvedSha256: 'b'.repeat(64) } } } as T;
    return execute<T>(method, params);
  };
  const script: Array<{ name: string; arguments: Record<string, string> }> = [
    { name: 'ToolSearch', arguments: { query: 'courseware_workflow_get' } },
    { name: 'Bash', arguments: { command: 'cat .deckwise-ppt/scenes/chat/plan.json 2>/dev/null | head -50' } },
    { name: 'Bash', arguments: { command: 'cat .deckwise-ppt/scenes/reference/plan.json | head -60' } },
    { name: 'Write', arguments: { path: '.deckwise-ppt/scenes/chat/plan.json', content: '{}' } },
    { name: 'courseware_scene_plan_submit', arguments: {} },
    { name: 'Bash', arguments: { command: 'cat .deckwise-ppt/scenes/chat/plan.json' } },
    { name: 'Write', arguments: { path: '.deckwise-ppt/scenes/chat/plan.json', content: '{"partial":true}' } },
    { name: 'courseware_scene_plan_submit', arguments: {} },
    { name: 'Bash', arguments: { command: 'cat .deckwise-ppt/scenes/chat/plan.json' } },
    { name: 'Write', arguments: { path: '.deckwise-ppt/scenes/chat/plan.json', content: '{"corrected":true}' } },
    { name: 'courseware_scene_plan_submit', arguments: {} },
    { name: 'courseware_workflow_get', arguments: {} },
  ];
  let requests = 0;
  const declarations: string[][] = [];
  const contexts: string[] = [];
  f.agent.streamFunction = (_model, context) => {
    const call = script[requests++];
    if (requests > script.length + 1) void f.runtime.abort();
    declarations.push(getCurrentTools(context.messages).map(tool => tool.name));
    contexts.push(JSON.stringify(context.messages));
    const message: AssistantMessage = { role: 'assistant', api: 'openai-completions', provider: 'local', model: 'fixture',
      timestamp: Date.now(), stopReason: call ? 'toolUse' : 'stop',
      content: call ? [{ type: 'toolCall', id: `call-${requests}`, ...call }] : [{ type: 'text', text: 'Please review the draft.' }],
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
    const stream = createAssistantMessageEventStream();
    queueMicrotask(() => {
      stream.push({ type: 'start', partial: message });
      stream.push({ type: 'done', reason: call ? 'toolUse' : 'stop', message });
      stream.end(message);
    });
    return stream;
  };
  try {
    await f.runtime.prompt('Create the Greetings scene draft.', 'user', 'turn');
    expect(executed.filter(name => name === 'Write'), JSON.stringify(executed)).toHaveLength(3);
    expect(contexts[4]).toContain('Scene course正文 pages exceed the requested limit: 6 > 4');
    const failedValidation = f.events.find(e => e.event.type === 'tool_end' && e.event.isError);
    expect(JSON.stringify(failedValidation)).toContain('Scene course正文 pages exceed the requested limit: 6 > 4');
    expect(executed).toContain('courseware_workflow_get');
    expect(contexts.at(-1)).toContain('approvedSha256');
    expect(requests).toBe(script.length + 1);
    for (const [index, call] of script.entries()) expect(declarations[index]).toContain(call.name);
    expect(executed.every(name => ['Write', 'Bash', 'courseware_scene_plan_submit', 'courseware_workflow_get'].includes(name))).toBe(true);
    expect(f.events.filter(event => event.event.type === 'agent_end')).toHaveLength(1);
    expect(f.events.filter(event => event.event.type === 'error')).toEqual([]);
  } finally { await f.runtime.dispose(); }
});

it.each(["stop", "steer"] as const)("fences an old batch's remaining generation calls after %s", async action => {
  const f = fixture();
  const stream = f.agent.streamFunction!;
  let batchStarted = false;
  const execute = f.runtime['host'].call.bind(f.runtime['host']);
  f.runtime['host'].call = async (method, params) => {
    if (method === 'tools.execute' && (params as { toolName: string }).toolName === 'courseware_scene_image_prepare' && !batchStarted) {
      batchStarted = true;
      if (action === 'stop') expect(f.runtime.requestGracefulStop()).toEqual({ requested: true });
      else f.runtime.steer({ text: 'Stop creating requests and report the blocker.' }, 'turn', {
        id: 'correction', role: 'user', content: 'Stop creating requests and report the blocker.', createdAt: new Date().toISOString(),
      });
    }
    return execute(method, params);
  };
  f.agent.streamFunction = (model, context, options) => {
    if (f.requests() !== 1) return stream(model, context, options);
    const original = stream(model, context, options);
    const replacement = createAssistantMessageEventStream();
    void (async () => {
      const events = await original;
      for await (const _ of events) { /* Consume the fixture response. */ }
      const message = await events.result();
      const first = message.content.find(block => block.type === 'toolCall')!;
      if (first.type !== 'toolCall') throw new Error('Expected generation call');
      const batch: AssistantMessage = { ...message, content: [first, { ...first, id: 'second' }, { ...first, id: 'third' }] };
      replacement.push({ type: 'start', partial: batch });
      replacement.push({ type: 'done', reason: 'toolUse', message: batch }); replacement.end(batch);
    })();
    return replacement;
  };
  f.saved.failed = true;
  try {
    await f.runtime.prompt('Generate the lesson.', 'user', 'turn');
    expect(batchStarted).toBe(true);
    expect(f.calls.filter(call => call.name === 'courseware_scene_image_prepare')).toHaveLength(1);
    expect(f.events.filter(e => e.event.type === 'agent_end')).toHaveLength(1);
    if (action === 'steer') expect(f.contexts.some(messages => messages.some(m => m.role === 'user' &&
      typeof m.content === 'string' && m.content.includes('Stop creating requests')))).toBe(true);
  } finally { await f.runtime.dispose(); }
});

