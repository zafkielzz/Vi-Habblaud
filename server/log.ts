// Short logs without conversation content (never log prompts, responses, or secrets).

type Level = 'info' | 'warn' | 'error';

let quiet = false;

/** Silences logs (used in tests). */
export function setQuiet(q: boolean): void {
  quiet = q;
}

function write(level: Level, msg: string): void {
  if (quiet) return;
  const line = `[habblaud] ${msg}`;
  if (level === 'info') console.log(line);
  else if (level === 'warn') console.warn(line);
  else console.error(line);
}

/** Short error message (no stack), safe for logs. */
export function errMsg(err: unknown): string {
  if (err && typeof err === 'object') {
    const e = err as { code?: unknown; message?: unknown };
    if (typeof e.code === 'string') return e.code;
    if (typeof e.message === 'string') return e.message.slice(0, 160);
  }
  return String(err).slice(0, 160);
}

const once = new Set<string>();

export const log = {
  info: (msg: string) => write('info', msg),
  warn: (msg: string) => write('warn', msg),
  error: (msg: string) => write('error', msg),
  /** Logs only the first occurrence of `key` (prevents log flooding during polling). */
  warnOnce: (key: string, msg: string) => {
    if (once.has(key)) return;
    once.add(key);
    write('warn', msg);
  },
  /** Allows `key` to be logged again (e.g. the issue was resolved). */
  clearOnce: (key: string) => void once.delete(key),
};
