// Plan usage for Antigravity accounts: agy's `/usage` (`agy-as accN -p /usage --output-format text`), a local slash
// command that does not call the model. Output, one window per line separated by TAB:
//   Gemini Models	Weekly Limit Remaining	99%	2026-10-31T09:52:49Z
//   Gemini Models	Five Hour Limit Remaining	100%	2026-10-26T08:25:58Z
// agy reports REMAINING; Habblaud shows amount used (100 - remaining). "disabled" = weekly quota exhausted.
// Only "Gemini Models" lines count (workers use Gemini); "Claude and GPT models" are excluded.
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import type { AccountUsage, UsageWindow } from '../../../shared/types';

/** Parses `/usage` output; no Gemini window -> undefined. */
export function parseAgyUsage(text: string, fetchedAt: number): AccountUsage | undefined {
  const usage: AccountUsage = { source: 'agy', fetchedAt };
  for (const line of text.split('\n')) {
    const [group, label, value, resets] = line.split('\t').map((s) => s.trim());
    if (group !== 'Gemini Models' || !label || value === undefined) continue;
    const left = /^(\d+(?:\.\d+)?)%$/.exec(value);
    const remaining = left ? Number(left[1]) : value.toLowerCase() === 'disabled' ? 0 : undefined;
    if (remaining === undefined) continue;
    const w: UsageWindow = { utilization: Math.min(100, Math.max(0, 100 - remaining)) };
    const t = resets ? Date.parse(resets) : NaN;
    if (!Number.isNaN(t)) w.resetsAt = t;
    if (/^weekly/i.test(label)) usage.sevenDay = w;
    else if (/^five hour/i.test(label)) usage.fiveHour = w;
  }
  // Without Pro the account only has the weekly limit: no "Five Hour" line at all.
  if (usage.sevenDay && !usage.fiveHour) usage.noFiveHour = true;
  return usage.sevenDay || usage.fiveHour ? usage : undefined;
}

/** Maximum duration of a `/usage` run (agy sometimes prints and hangs). */
export const USAGE_TIMEOUT_MS = 60_000;

/**
 * Runs `/usage` for an account and returns the output. Process runs in its own group and is killed (the whole group)
 * as soon as both windows appear, on exit or on timeout: avoids leaving a hung agy process behind.
 */
export function runAgyUsage(agyAs: string, acc: string, env: NodeJS.ProcessEnv, timeoutMs = USAGE_TIMEOUT_MS): Promise<string> {
  return new Promise((resolveText) => {
    let out = '';
    let done = false;
    const child = spawn(agyAs, [acc, '-p', '/usage', '--output-format', 'text'], {
      cwd: tmpdir(),
      env,
      detached: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try {
        if (child.pid) process.kill(-child.pid, 'SIGKILL');
      } catch {
        // already exited
      }
      resolveText(out);
    };
    const timer = setTimeout(finish, timeoutMs);
    child.stdout?.on('data', (b: Buffer) => {
      out += b.toString('utf8');
      // The Gemini lines come first: both windows, or the "Claude and GPT" lines after them (account without Pro).
      if (/Gemini Models\tWeekly/.test(out) && /Gemini Models\tFive Hour|Claude and GPT models\t/.test(out)) finish();
    });
    child.on('error', finish);
    child.on('close', finish);
  });
}

