// Agent row (avatar, name, account, role, status, and activity), used in sidebar and drawer.
import type { AccountInfo, AgentInfo } from '../../../shared/types';
import { createAvatar, updateAvatar, type AvatarSize } from './avatar';
import { h, setAttr, setHidden, setStyleVar, setText, setTitle, setVariant } from './dom';
import { formatDuration } from './format';
import { activityFallback, shellLine, shellWaitIn, statusLabel } from './model';
import {
  createAccountChip,
  createActivityLine,
  createRoleBadge,
  createStatusDot,
  updateAccountChip,
  updateActivityLine,
  updateRoleBadge,
  updateShellActivityLine,
  updateStatusDot,
} from './widgets';
import { tr } from '../../../shared/i18n';

interface RowRefs {
  avatar: HTMLElement;
  name: HTMLElement;
  chip: HTMLElement;
  role: HTMLElement;
  dot: HTMLElement;
  activity: HTMLElement;
  /** Session title (what it is about), as in character hover tooltip. */
  task: HTMLElement;
  /** How long it has been idle (replaces "Main"). */
  since: HTMLElement;
  /** Where it works (sidebar by role: setAgentRowPlace). */
  place: HTMLElement;
  size: AvatarSize;
}

const refs = new WeakMap<HTMLElement, RowRefs>();

export function createAgentRow(agent: AgentInfo, onPick: (id: string) => void, size: AvatarSize = 'md'): HTMLButtonElement {
  const avatar = createAvatar(agent, size);
  const name = h('span', { class: 'ui-agent__name' });
  const chip = createAccountChip('sm');
  const role = createRoleBadge();
  const dot = createStatusDot();
  const activity = createActivityLine();
  const task = h('span', { class: 'ui-agent__task', hidden: true });
  const since = h('span', { class: 'ui-agent__since', hidden: true });
  const place = h('span', { class: 'ui-agent__place', hidden: true });
  const row = h(
    'button',
    { class: 'ui-agent', type: 'button' },
    avatar,
    h('span', { class: 'ui-agent__main' }, h('span', { class: 'ui-agent__top' }, name, chip, since, role), place, task, activity),
    dot,
  );
  row.dataset.id = agent.id;
  row.addEventListener('click', () => onPick(row.dataset.id!));
  refs.set(row, { avatar, name, chip, role, dot, activity, task, since, place, size });
  return row;
}

/** Where the agent works ("📁 Habblaud", full path on hover); empty hides it. */
export function setAgentRowPlace(row: HTMLElement, text: string, path?: string): void {
  const r = refs.get(row);
  if (!r) return;
  setText(r.place, text);
  setTitle(r.place, path ?? '');
  setHidden(r.place, !text);
}

/**
 * `now` = server clock (shell stopwatch and foreground long-command threshold);
 * `agents` = office agents (background shells left running by a subagent count toward the main agent).
 */
export function updateAgentRow(
  row: HTMLElement,
  agent: AgentInfo,
  account: AccountInfo | undefined,
  selected: boolean,
  now: number,
  agents: readonly AgentInfo[] = [],
): void {
  const r = refs.get(row);
  if (!r) return;
  row.dataset.id = agent.id;
  updateAvatar(r.avatar, agent, r.size);
  setStyleVar(row, '--acc', account?.color ?? '#8b98b3');
  setText(r.name, agent.name);
  updateAccountChip(r.chip, account, agent.account, agent.provider);
  updateRoleBadge(r.role, agent);
  const title = agent.title?.trim() ?? '';
  setText(r.task, title);
  setTitle(r.task, title);
  setHidden(r.task, !title);
  // Main agent idle for 1 min or more: time appears in place of "Main".
  const idleFor = agent.kind === 'main' && agent.status === 'idle' && agent.statusSince ? now - agent.statusSince : 0;
  const showIdle = idleFor >= 60_000;
  setText(r.since, showIdle ? tr('idle {0}', [formatDuration(idleFor)]) : '');
  setTitle(r.since, showIdle ? tr('Idle for {0}', [formatDuration(idleFor)]) : '');
  setHidden(r.since, !showIdle);
  setHidden(r.role, showIdle);
  // Waiting for shell (or paused on long command): hourglass on dot and stopwatch on activity line.
  const wait = shellWaitIn(agent, agents, now);
  const status = wait ? 'shell' : agent.status;
  updateStatusDot(r.dot, status);
  if (wait) updateShellActivityLine(r.activity, wait, now);
  else updateActivityLine(r.activity, agent.activity, activityFallback(agent));
  setVariant(row, 'is-', status);
  row.classList.toggle('is-selected', selected);
  setAttr(row, 'aria-current', selected ? 'true' : null);
  // For screen readers, time in minutes (stopwatch would change the label every second).
  const doing = wait ? tr('{0}, for {1}', [shellLine(wait, now).label, formatDuration(now - wait.since)]) : agent.activity?.text;
  setAttr(
    row,
    'aria-label',
    `${agent.name}, ${agent.kind === 'main' ? tr('main agent') : tr('subagent {0}', [agent.role])}, ${account?.name ?? agent.account}${agent.provider === 'codex' ? ' (Codex)' : ''}, ${statusLabel(status)}${doing ? `: ${doing}` : ''}`,
  );
}
