// Which tool each item belongs to (Claude Code or Codex) and texts that change with it. Pure (no DOM): tested in
// ui/provider.test.ts. In the protocol, missing `provider` means Claude Code (shared/types.ts);
// everything defaults to that here.
//
// Visual identity for Codex (no proprietary logos): the account chip is "outlined" (dark background, border and
// letter in account color, stepped corners) and, where space permits, a text badge "Codex" next to the name.
import type { AccountInfo, OfficeSnapshot, Provider } from '../../../shared/types';
import { shortcutHint } from './model';
import { tr } from '../../../shared/i18n';

/** Name of each tool as displayed in UI text. */
export const PROVIDER_NAME: Record<Provider, string> = { claude: 'Claude Code', codex: 'Codex', agy: 'Antigravity' };

/** Tool of an agent, account, session, or request (absent = Claude Code). */
export function providerOf(x: { provider?: Provider } | null | undefined): Provider {
  return x?.provider ?? 'claude';
}

export function isCodex(x: { provider?: Provider } | null | undefined): boolean {
  return x?.provider === 'codex';
}

/**
 * Does the account id look like a Codex folder (".codex", ".codex-trabalho", ".codex~2", "demo:.codex")?
 * Only for when the account is no longer in the snapshot (e.g. history, "My Day"): with the account available,
 * its `provider` takes precedence.
 */
export function looksLikeCodexId(id: string): boolean {
  return /(?:^|[:/\\])\.?codex(?:[-_.~]|$)/i.test(id);
}

/** Account tool: from snapshot; without it, caller hint or inferred from id format. */
export function accountProvider(account: Pick<AccountInfo, 'provider'> | undefined, fallbackId = '', hint?: Provider): Provider {
  if (account) return providerOf(account);
  return hint ?? (looksLikeCodexId(fallbackId) ? 'codex' : 'claude');
}

/**
 * Letter for a chip of an account not in the snapshot: first letter after the folder prefix
 * (".claude-conta2" -> "C", ".codex-trabalho" -> "T"). The default Codex folder (".codex") becomes "X"; Claude Code's,
 * "?" (as before). Never returns "." or empty.
 */
export function fallbackShort(id: string, provider: Provider = accountProvider(undefined, id)): string {
  const rest = id
    .replace(/^.*:/, '')
    .replace(/~\d+$/, '')
    .replace(/^\.?(?:claude|codex)(?=[-_.]|$)[-_.]?/i, '');
  const letter = /[\p{L}\p{N}]/u.exec(rest)?.[0];
  if (letter) return letter.toUpperCase();
  return provider === 'codex' ? 'X' : '?';
}

/** Tool badge next to account name (Codex and Antigravity only; omitted when name already mentions it). */
export function showsProviderTag(provider: Provider, accountName = ''): boolean {
  if (provider === 'claude') return false;
  const name = accountName.toLowerCase();
  // Antigravity workers are named "alice (Agy)": the name already says it.
  if (provider === 'agy' && name.includes('(agy)')) return false;
  return !name.includes(PROVIDER_NAME[provider].toLowerCase());
}

/** Account chip label (tooltip and screen readers): "Account C (dev@x.com)", "Codex · Team plan". */
export function accountChipLabel(account: Pick<AccountInfo, 'name' | 'email' | 'plan' | 'provider'> | undefined, fallbackId: string, provider: Provider): string {
  if (!account) return fallbackId ? `${fallbackId}${provider === 'codex' ? ' · Codex' : ''}` : tr('Unknown account');
  if (provider !== 'codex') return `${account.name}${account.email ? ` (${account.email})` : ''}`;
  const tag = showsProviderTag(provider, account.name) ? ' · Codex' : '';
  return `${account.name}${tag}${account.plan ? tr(' · {0} plan', [account.plan]) : ''}`;
}

/**
 * Empty office text. Shortcuts ("shortcuts c or d") belong only to Claude Code accounts, derived from shell
 * aliases (a Codex account letter is not a shortcut); Codex is mentioned only when an account for it exists.
 */
export function emptyOfficeHint(accounts: readonly Pick<AccountInfo, 'short' | 'provider'>[]): string {
  const keys = shortcutHint(accounts.filter((a) => !isCodex(a)));
  if (!accounts.some(isCodex)) return tr('Open Claude Code in any project{0} and watch your agent arrive.', [keys ? ` (${keys})` : '']);
  return tr('Open Claude Code{0} or Codex in any project and watch your agent arrive.', [keys ? ` (${keys})` : '']);
}

/** Any Codex permission request waiting: deadline is short and card counts seconds (1 s ticker). */
export function hasCodexPermission(snap: Pick<OfficeSnapshot, 'agents'> | null): boolean {
  return !!snap?.agents.some((a) => a.permission && isCodex(a.permission) && a.status !== 'offline' && a.status !== 'done');
}

/** How to view Codex live and approve from the office (Codex agent drawer and help). */
export const CODEX_LIVE_HINT = tr('To see Codex live and approve from the office: `npm run codex:install`, then approve the hooks in `/hooks` in Codex.');

/** Codex approval policies (`approval_policy`), when server sends them instead of permission mode. */
const CODEX_APPROVALS: Record<string, string> = {
  untrusted: tr('Asks before almost everything'),
  'on-request': tr('Asks when needed'),
  'on-failure': tr('Asks when a command fails'),
  never: tr('Never asks'),
};

/** Codex agent approval label (unknown value passes through as-is). */
export function codexApprovalLabel(policy: string | undefined): string {
  if (!policy) return '—';
  return CODEX_APPROVALS[policy] ?? policy;
}
