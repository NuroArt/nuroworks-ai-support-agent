type Level = 'info' | 'warn' | 'error';

function emit(level: Level, msg: string, meta?: Record<string, unknown>) {
  // Meta is spread first so the envelope always wins. A caller passing its own
  // `level` key would otherwise overwrite the severity and break log filtering.
  const line = { ...meta, ts: new Date().toISOString(), level, msg };
  const out = level === 'error' ? console.error : console.log;
  out(JSON.stringify(line));
}

export const log = {
  info:  (m: string, meta?: Record<string, unknown>) => emit('info', m, meta),
  warn:  (m: string, meta?: Record<string, unknown>) => emit('warn', m, meta),
  /** Never log the error object directly — stack traces can carry request bodies. */
  error: (m: string, e?: unknown, meta?: Record<string, unknown>) =>
    emit('error', m, { ...meta, reason: e instanceof Error ? e.message : String(e) }),
};
