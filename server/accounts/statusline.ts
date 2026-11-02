// 'statusline' usage source: <usageDir>/<account>.json files written by scripts/statusline-tap.mjs
// from the JSON that Claude Code itself sends to the statusline command (rate_limits field), or
// by the Claude Code mod (mod/habblaud, from `$.session.usage()`), in the same format.
// Does not read credentials or call any API: only small files, re-read every ~5 s.
//
// Format (the tap writes ONLY this; the mod adds "source": "mod", which becomes AccountUsage.via):
//   {"accountId": ".claude-conta2", "configDir": "/Users/x/.claude-conta2", "fetchedAt": 1790000000000,
//    "five_hour": {"utilization": 42, "resets_at": 1790003600}, "seven_day": {"utilization": 15, "resets_at": 1790500000}}
// `resets_at` comes in seconds (as Claude Code sends); `fetchedAt` in ms.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { AccountUsage } from '../../shared/types';
import { toEpochMs, usageFromWindows } from './usage';

/** Files larger than this are not from the tap (tap writes ~250 bytes): ignored. */
const MAX_FILE_BYTES = 64 * 1024;

export interface StatuslineUsage {
  /** Source file (for diagnosis). */
  file: string;
  accountId?: string;
  configDir?: string;
  usage: AccountUsage;
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() ? v.trim() : undefined;
}

/**
 * Parses tap file content. `mtimeMs` is used when `fetchedAt` is missing;
 * future dates (clock drift) are clamped to `now`.
 */
export function parseStatuslineFile(raw: string, file: string, now: number, mtimeMs?: number): StatuslineUsage | undefined {
  let j: unknown;
  try {
    j = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (!j || typeof j !== 'object' || Array.isArray(j)) return undefined;
  const r = j as Record<string, unknown>;
  const fetched = toEpochMs(r.fetchedAt) ?? (mtimeMs !== undefined ? Math.round(mtimeMs) : undefined);
  if (fetched === undefined) return undefined;
  const usage = usageFromWindows({ five_hour: r.five_hour, seven_day: r.seven_day }, 'statusline', Math.min(now, fetched));
  if (!usage) return undefined;
  usage.via = r.source === 'mod' ? 'mod' : 'tap';
  const out: StatuslineUsage = { file, usage };
  const accountId = str(r.accountId);
  const configDir = str(r.configDir);
  if (accountId) out.accountId = accountId;
  if (configDir) out.configDir = configDir;
  return out;
}

/** Reads <dir>/*.json with per-file cache (only reparses what changed in size or timestamp). */
export class StatuslineUsageReader {
  private cache = new Map<string, { size: number; mtimeMs: number; parsed?: StatuslineUsage }>();

  constructor(readonly dir: string) {}

  read(now: number): StatuslineUsage[] {
    let names: string[];
    try {
      names = readdirSync(this.dir);
    } catch {
      // Directory does not exist yet (tap not installed or no sessions since installation).
      this.cache.clear();
      return [];
    }
    const seen = new Set<string>();
    const out: StatuslineUsage[] = [];
    for (const name of names) {
      if (!name.endsWith('.json')) continue;
      const path = join(this.dir, name);
      let size: number;
      let mtimeMs: number;
      try {
        const st = statSync(path);
        if (!st.isFile()) continue;
        size = st.size;
        mtimeMs = st.mtimeMs;
      } catch {
        continue;
      }
      seen.add(path);
      const cached = this.cache.get(path);
      if (cached && cached.size === size && cached.mtimeMs === mtimeMs) {
        if (cached.parsed) out.push(cached.parsed);
        continue;
      }
      if (size > MAX_FILE_BYTES) {
        this.cache.set(path, { size, mtimeMs }); // too large: not from tap or mod
        continue;
      }
      let parsed: StatuslineUsage | undefined;
      try {
        parsed = parseStatuslineFile(readFileSync(path, 'utf8'), path, now, mtimeMs);
      } catch {
        parsed = undefined; // disappeared between stat and read
      }
      if (parsed) {
        this.cache.set(path, { size, mtimeMs, parsed });
        out.push(parsed);
        continue;
      }
      // Empty, partial JSON, or unreadable: the mod writes with $.fs.write, which is NOT atomic (tap uses tmp +
      // rename), so the file can be caught mid-write. Keep the last good record of this file,
      // and do not cache the new signature: the file is re-read on the next cycle (only a few bytes).
      if (cached?.parsed) out.push(cached.parsed);
    }
    for (const path of [...this.cache.keys()]) if (!seen.has(path)) this.cache.delete(path);
    return out;
  }
}
