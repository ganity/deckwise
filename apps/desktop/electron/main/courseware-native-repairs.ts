export type NativeNarrationAttempt = { attempts: number; error?: string; code?: string };
export type NativeNarrationBudget = { turnId: string; pages: Record<string, NativeNarrationAttempt> };
export type NativeRepairState = { revision: number; failures: Record<string, string>; narration?: NativeNarrationBudget };
export type NativeRepairStore = {
  read(sessionId: string, projectId: string): Promise<NativeRepairState>;
  write(sessionId: string, projectId: string, previous: NativeRepairState, failures: Record<string, string>): Promise<NativeRepairState>;
  writeNarration(sessionId: string, projectId: string, previous: NativeRepairState, narration: NativeNarrationBudget): Promise<NativeRepairState>;
};

export function nativeRepairStore(host: { call<T>(method: string, args: unknown): Promise<T> }, sourcePath: string,
  assertCurrent: () => Promise<void>): NativeRepairStore {
  async function call(method: string, args: Record<string, unknown>): Promise<NativeRepairState> {
    await assertCurrent();
    const value = await host.call<NativeRepairState>(method, { ...args, sourcePath });
    await assertCurrent();
    if (!value || !Number.isSafeInteger(value.revision) || value.revision < 0 || !value.failures ||
        typeof value.failures !== 'object' || Array.isArray(value.failures) || Object.keys(value.failures).length > 1000 || Object.entries(value.failures).some(([id, message]) =>
          !id || id.length > 200 || typeof message !== 'string' || !message || message.length > 2000) ||
        value.narration !== undefined && (!value.narration || typeof value.narration.turnId !== 'string' ||
          !value.narration.turnId || value.narration.turnId.length > 200 || !value.narration.pages ||
          typeof value.narration.pages !== 'object' || Array.isArray(value.narration.pages) || Object.keys(value.narration.pages).length > 1000 ||
          Object.entries(value.narration.pages).some(([key, state]) => !/^[a-f0-9]{64}$/u.test(key) || !state ||
            !Number.isSafeInteger(state.attempts) || state.attempts < 0 || state.attempts > 3 ||
            state.error !== undefined && (typeof state.error !== 'string' || !state.error || state.error.length > 2000) ||
            state.code !== undefined && (typeof state.code !== 'string' || !/^[A-Z][A-Z0-9_]{0,99}$/u.test(state.code)))))
      throw new Error('Invalid saved native repair state');
    return value;
  }
  return {
    read: (sessionId, projectId) => call('courseware.nativeRepairs.read', { sessionId, projectId }),
    write: (sessionId, projectId, previous, failures) => call('courseware.nativeRepairs.write', {
      sessionId, projectId, expectedRevision: previous.revision, failures,
    }),
    writeNarration: (sessionId, projectId, previous, narration) => call('courseware.nativeRepairs.write', {
      sessionId, projectId, expectedRevision: previous.revision, failures: previous.failures, narration,
    }),
  };
}
