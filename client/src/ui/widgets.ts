// Visual pieces reused by panels: account chip (and "Codex" tag), status dot, role badge,
// progress bar.
import type { AccountInfo, Activity, AgentInfo, AgentStatus, Provider } from '../../../shared/types';
import { h, setAttr, setHidden, setStyleVar, setText, setTitle, setVariant } from './dom';
import { WORDMARK } from './icons';
import { shellDoneKind, shellLine, shellStage, statusLabel, type ShellWait } from './model';
import { accountChipLabel, accountProvider, fallbackShort, PROVIDER_NAME, showsProviderTag } from './provider';
import { tr } from '../../../shared/i18n';
import { modelSpec } from '../../../shared/model-spec';

/**
 * Square chip with account short letter ("C", "D") in account color. Codex account: chip is outlined (dark
 * background, border and letter in account color, stepped corners): `data-provider="codex"`.
 */
export function createAccountChip(size: 'sm' | 'md' | 'lg' = 'sm'): HTMLElement {
  return h('span', { class: `ui-acc-chip ui-acc-chip--${size}` });
}

/** `provider` = hint for when the account is not in the snapshot (e.g.: history session indicates tool). */
export function updateAccountChip(chip: HTMLElement, account: AccountInfo | undefined, fallbackId = '', provider?: Provider): void {
  const p = accountProvider(account, fallbackId, provider);
  setText(chip, account?.short ?? fallbackShort(fallbackId, p));
  setStyleVar(chip, '--acc', account?.color ?? '#8b98b3');
  setAttr(chip, 'data-provider', p === 'codex' ? 'codex' : null);
  const label = accountChipLabel(account, fallbackId, p);
  setTitle(chip, label);
  setAttr(chip, 'aria-label', label);
}

/** Text badge "Codex" beside account name (where space permits: drawer, terminal, usage card, tooltip). */
export function createProviderTag(extra = ''): HTMLElement {
  return h('span', { class: `ui-prov${extra ? ` ${extra}` : ''}`, text: 'Codex', hidden: true, title: tr('Codex agent (OpenAI)') });
}

/** Shows tag only for Codex (does not repeat if account name already contains "Codex"). */
export function updateProviderTag(tag: HTMLElement, provider: Provider, accountName = ''): void {
  setHidden(tag, !showsProviderTag(provider, accountName));
  if (provider === 'claude') return;
  setText(tag, PROVIDER_NAME[provider]);
  setTitle(tag, provider === 'agy' ? tr('Antigravity CLI worker (Google)') : tr('Codex agent (OpenAI)'));
}

/** Status square (pixel), pulsing when awaiting user input. */
export function createStatusDot(): HTMLElement {
  return h('span', { class: 'ui-status-dot', role: 'img' });
}

export function updateStatusDot(dot: HTMLElement, status: AgentStatus): void {
  setVariant(dot, 'is-', status);
  const label = statusLabel(status);
  setAttr(dot, 'aria-label', label);
  setTitle(dot, label);
}

export function createRoleBadge(): HTMLElement {
  return h('span', { class: 'ui-role' });
}

export function updateRoleBadge(badge: HTMLElement, agent: Pick<AgentInfo, 'kind' | 'role' | 'background' | 'boss' | 'model' | 'effort'>): void {
  setText(badge, agent.boss ? tr('👑 Boss') : agent.kind === 'main' ? tr('Main') : agent.role || tr('Subagent'));
  setVariant(badge, 'ui-role--', agent.kind);
  const spec = modelSpec(agent);
  setTitle(badge, (agent.kind === 'main' ? tr('Main agent') : tr('Subagent: {0}{1}', [agent.role, agent.background ? tr(' (in the background)') : ''])) + (spec ? ` · ${spec}` : ''));
}

/** Thin progress bar; `value` 0–1. */
export function createProgress(label: string): HTMLElement {
  const bar = h('span', { class: 'ui-progress', role: 'progressbar', attrs: { 'aria-label': label, 'aria-valuemin': 0, 'aria-valuemax': 100 } });
  bar.append(h('span', { class: 'ui-progress__fill' }));
  return bar;
}

export function updateProgress(bar: HTMLElement, done: number, total: number, partial = 0): void {
  const pct = total > 0 ? Math.round((done / total) * 100) : 0;
  const partialPct = total > 0 ? Math.round(((done + partial) / total) * 100) : 0;
  setStyleVar(bar, '--p', `${pct}%`);
  setStyleVar(bar, '--pp', `${partialPct}%`);
  setAttr(bar, 'aria-valuenow', String(pct));
  setAttr(bar, 'aria-valuetext', tr('{0} of {1}', [done, total]));
  bar.classList.toggle('is-complete', total > 0 && done === total);
}

/**
 * Activity "icon + text" line, with ellipsis. Also has a stopwatch and a "×N" counter
 * (hidden outside of waiting for shell), so that time is never truncated by the text ellipsis.
 */
export function createActivityLine(): HTMLElement {
  const el = h('span', { class: 'ui-activity' });
  el.append(
    h('span', { class: 'ui-activity__icon', attrs: { 'aria-hidden': 'true' } }),
    h('span', { class: 'ui-activity__text' }),
    h('span', { class: 'ui-activity__time', hidden: true }),
    h('span', { class: 'ui-activity__count', hidden: true }),
  );
  return el;
}

function activityParts(el: HTMLElement): [HTMLElement, HTMLElement, HTMLElement, HTMLElement] {
  return el.children as unknown as [HTMLElement, HTMLElement, HTMLElement, HTMLElement];
}

export function updateActivityLine(el: HTMLElement, activity: Activity | undefined, fallback = tr('No activity yet')): void {
  const [icon, text, time, count] = activityParts(el);
  setText(icon, activity?.icon ?? '·');
  setText(text, activity?.text ?? fallback);
  setHidden(time, true);
  setHidden(count, true);
  el.classList.remove('is-shell');
  el.classList.toggle('is-error', !!activity?.error);
  // End of a shell (✅/❌ from server): distinct highlight, so it doesn't get lost among other activities.
  const done = shellDoneKind(activity);
  el.classList.toggle('is-shell-ok', done === 'ok');
  el.classList.toggle('is-shell-fail', done === 'fail');
  setTitle(el, activity ? (activity.detail ? `${activity.text}\n${activity.detail}` : activity.text) : fallback);
}

/** Same line for whoever is waiting for a shell: "⏳ <label> · 12:31 ×2", with ticking time. */
export function updateShellActivityLine(el: HTMLElement, wait: ShellWait, now: number): void {
  const [icon, text, time, count] = activityParts(el);
  const line = shellLine(wait, now);
  setText(icon, '⏳');
  setText(text, line.label);
  setText(time, line.time);
  setHidden(time, false);
  setText(count, line.count);
  setHidden(count, !line.count);
  el.classList.add('is-shell');
  el.classList.remove('is-error', 'is-shell-ok', 'is-shell-fail');
  const stage = shellStage(now - wait.since);
  const main = wait.main;
  setTitle(
    el,
    [line.text, main?.command && main.command !== main.label ? main.command : '', `${stage.emoji} ${stage.text}`].filter(Boolean).join('\n'),
  );
}

/** Product name as pixel logo (the text is for screen readers). */
export function wordmark(cls = 'ui-brand__name'): HTMLElement {
  const el = h('span', { class: cls });
  el.innerHTML = WORDMARK;
  el.append(h('span', { class: 'ui-sr', text: 'Habblaud' }));
  return el;
}
