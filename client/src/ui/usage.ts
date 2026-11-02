// Usage texts shared by the Accounts window, the drawer and help: origin of the numbers, card state, how to enable.
// Display rules:
// - stale numbers never pass as current: a window that already reset after reading shows "—" and "reset";
//   old numbers are dimmed with age ("6d ago") in the header or, on mobile, a badge on the chip;
// - reset comes with implicit verb in the ↻ icon and countdown when less than a day remains;
// - account without numbers says "no usage data" and offers "How to enable" (Habblaud mod, recommended).
// Codex account: numbers come from its session files, which only refresh while a session is running; therefore
// age ("12m ago") is always shown. Without quota or credits ("no quota") never becomes 0%. Nothing
// to install for usage: "How it works" opens help at the Codex section. No Opus/Sonnet or email (plan only).
import type { AccountInfo } from '../../../shared/types';
import { h } from './dom';
import { relativeTime } from './format';
import { isCodex, providerOf } from './provider';
import { tr } from '../../../shared/i18n';

export const SOURCE_LABEL: Record<NonNullable<AccountInfo['usage']>['source'], string> = {
  cache: tr('Claude Code /usage cache'),
  statusline: tr('live (Claude Code statusline)'),
  codex: tr('Codex files'),
  agy: tr('Antigravity /usage'),
};

/** Source to display: live file may have been written by Habblaud mod or tap. */
export function sourceLabel(u: NonNullable<AccountInfo['usage']>): string {
  if (u.source === 'statusline' && u.via === 'mod') return tr('live (Habblaud mod)');
  return SOURCE_LABEL[u.source] ?? u.source;
}

/**
 * How to enable usage for an account, in order of preference (card tooltip and help).
 * Backticked fragments become code (no line breaks in middle of command).
 */
export const USAGE_SETUP_STEPS: readonly [string, string][] = [
  [
    'npm run mod:install',
    tr('Recommended: installs the Habblaud mod in Claude Code (2.1.287 or newer), which streams 5 h and weekly usage live. Run it in the Habblaud folder, on the computer where Claude Code runs; in sessions already open, `/reload-plugins`.'),
  ],
  [
    'npm run usage:install',
    tr('On Claude Code older than 2.1.287: hooks a tap into the status line, which streams the same numbers live.'),
  ],
  ['/usage', tr('Without installing anything: run `/usage` in Claude Code on this account to refresh the cache (the numbers go stale until the next time).')],
];

/** Text with `like this` fragments as code. */
export function richText(text: string): Node[] {
  return text.split('`').map((part, i) => (i % 2 ? h('code', { class: 'ui-usage-setup__inline', text: part }) : document.createTextNode(part)));
}

/** Step by step to enable usage (card tooltip and help). */
export function createUsageSetup(): HTMLElement {
  return h(
    'ol',
    { class: 'ui-usage-setup' },
    ...USAGE_SETUP_STEPS.map(([cmd, text]) => h('li', {}, h('code', { class: 'ui-usage-setup__cmd', text: cmd }), h('span', {}, ...richText(text)))),
  );
}

/** ok/stale: recent/old numbers; empty: no numbers; noquota: Codex without quota or credits (never 0%). */
export type CardState = 'ok' | 'stale' | 'empty' | 'noquota';

function hasWindows(a: Pick<AccountInfo, 'usage'>): boolean {
  return !!a.usage && !!(a.usage.fiveHour || a.usage.sevenDay);
}

/** Effective card state. */
export function cardState(a: Pick<AccountInfo, 'usage' | 'usageStatus'>): CardState {
  // "noquota" comes first: reading has no windows, but is not "empty".
  if (a.usage?.noQuota) return 'noquota';
  // Reading without any windows (e.g.: /usage cache without numbers) counts as "empty".
  if (!hasWindows(a)) return 'empty';
  return a.usageStatus === 'ok' ? 'ok' : 'stale';
}

/** Is the age of numbers always shown? (Codex: only refreshes while a session runs.) */
export function showsUsageAge(a: Pick<AccountInfo, 'usage' | 'usageStatus' | 'provider'>): boolean {
  if (!a.usage) return false;
  const state = cardState(a);
  return state === 'stale' || (isCodex(a) && state !== 'empty');
}

/** Line below name: email; on Codex (no email), plan; on others, directory. */
export function usageSubtitle(a: Pick<AccountInfo, 'email' | 'plan' | 'configDir' | 'provider'>): string {
  if (a.email) return a.email;
  if (isCodex(a)) return a.plan ? tr('{0} plan', [a.plan]) : 'Codex';
  return a.configDir;
}

/** Message in place of bars (states without numbers): [long, short]. */
export function usageMessage(a: Pick<AccountInfo, 'usage' | 'usageStatus' | 'provider'>): [string, string] {
  const state = cardState(a);
  if (state === 'noquota') return [tr('no quota'), tr('no quota')];
  // Codex records usage only while a session runs; Antigravity's comes from its /usage, read every few minutes.
  if (isCodex(a) || providerOf(a) === 'agy') return [tr('no data yet'), tr('no data')];
  return [tr('no usage data'), tr('no data')];
}

/** Explanation for Codex account card (tooltip); '' on others. */
export function codexUsageNote(a: Pick<AccountInfo, 'usage' | 'usageStatus' | 'provider'>, now: number): string {
  if (!isCodex(a)) return '';
  const u = a.usage;
  const state = cardState(a);
  if (state === 'empty') return tr('Nothing to install: the numbers arrive with the next Codex session.');
  const age = u ? relativeTime(u.fetchedAt, now) : '';
  if (state === 'noquota')
    return tr("At the last reading ({0}), the account had no quota or credits left to use (e.g. the workspace credits ran out). It's not 0%: Codex didn't report the windows. The numbers come back with the next session.", [age]);
  return tr('Codex only records usage while a session is running: these numbers are from the last reading ({0}).', [age]);
}
