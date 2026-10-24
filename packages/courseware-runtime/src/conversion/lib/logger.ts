const LOG_LEVELS = { debug: 0, info: 1, warn: 2, error: 3 } as const;
type LogLevel = keyof typeof LOG_LEVELS;
const BEIJING_TIME_ZONE = 'Asia/Shanghai';
const BEIJING_OFFSET = '+08:00';

type StructuredLogData = Record<string, unknown>;

function isPlainObject(value: unknown): value is StructuredLogData {
  if (!value || typeof value !== 'object') return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function omitUndefined<T extends StructuredLogData>(value: T): T {
  return Object.fromEntries(
    Object.entries(value).filter(([, entryValue]) => entryValue !== undefined),
  ) as T;
}

function extractStructuredLogData(args: unknown[]): {
  messageArgs: unknown[];
  data?: StructuredLogData;
} {
  if (args.length === 0) {
    return { messageArgs: [] };
  }

  const lastArg = args.at(-1);
  if (!isPlainObject(lastArg)) {
    return { messageArgs: args };
  }

  return {
    messageArgs: args.slice(0, -1),
    data: omitUndefined(lastArg),
  };
}

function readBusinessContextData(): StructuredLogData | undefined {
  const globalScope = globalThis as Record<string, unknown>;
  const maybeStore = globalScope.__businessContext as { getStore?: () => unknown } | undefined;
  if (!maybeStore || typeof maybeStore.getStore !== 'function') {
    return undefined;
  }

  const store = maybeStore.getStore();
  if (!isPlainObject(store)) {
    return undefined;
  }

  const context = omitUndefined({
    traceId: store.traceId,
    tenantId: store.tenantId,
    userId: store.userId,
    bizDomain: store.bizDomain,
    bizId: store.bizId,
    bizPhase: store.bizPhase,
    parentEventId: store.parentEventId,
    rootJobId: store.rootJobId,
  });

  return Object.keys(context).length > 0 ? context : undefined;
}

function getMinLevel(): LogLevel {
  const env = (process.env.LOG_LEVEL ?? 'info').toLowerCase();
  return env in LOG_LEVELS ? (env as LogLevel) : 'info';
}

function isJsonFormat(): boolean {
  return process.env.LOG_FORMAT === 'json';
}

function formatLogTimestamp(date: Date): string {
  const formatter = new Intl.DateTimeFormat('sv-SE', {
    timeZone: BEIJING_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  });
  const parts = formatter.formatToParts(date);
  const getPart = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((part) => part.type === type)?.value ?? '';
  const milliseconds = String(date.getUTCMilliseconds()).padStart(3, '0');

  return `${getPart('year')}-${getPart('month')}-${getPart('day')}T${getPart('hour')}:${getPart('minute')}:${getPart('second')}.${milliseconds}${BEIJING_OFFSET}`;
}

function formatLine(level: LogLevel, tag: string, args: unknown[]): string {
  const timestamp = formatLogTimestamp(new Date());
  const upperLevel = level.toUpperCase();
  const { messageArgs, data } = extractStructuredLogData(args);
  const message = messageArgs
    .map((a) =>
      a instanceof Error ? (a.stack ?? a.message) : typeof a === 'string' ? a : JSON.stringify(a),
    )
    .join(' ');

  if (isJsonFormat()) {
    const contextData = readBusinessContextData();
    const mergedData =
      contextData || data ? omitUndefined({ ...(contextData ?? {}), ...(data ?? {}) }) : undefined;
    return JSON.stringify({
      timestamp,
      level: upperLevel,
      tag,
      message,
      ...(mergedData ? { data: mergedData } : {}),
    });
  }
  const rawMessage = args
    .map((a) =>
      a instanceof Error ? (a.stack ?? a.message) : typeof a === 'string' ? a : JSON.stringify(a),
    )
    .join(' ');
  return `[${timestamp}] [${upperLevel}] [${tag}] ${rawMessage}`;
}

export function createLogger(tag: string) {
  const emit = (level: LogLevel, args: unknown[]) => {
    if (LOG_LEVELS[level] < LOG_LEVELS[getMinLevel()]) return;

    const line = formatLine(level, tag, args);

    // Console output
    const fn =
      level === 'debug'
        ? console.debug
        : level === 'warn'
          ? console.warn
          : level === 'error'
            ? console.error
            : console.log;
    fn(line);
  };

  return {
    debug: (...args: unknown[]) => emit('debug', args),
    info: (...args: unknown[]) => emit('info', args),
    warn: (...args: unknown[]) => emit('warn', args),
    error: (...args: unknown[]) => emit('error', args),
  };
}
