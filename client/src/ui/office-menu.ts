// The menu of an office tab (right click, long press, the ContextMenu key or Shift+F10 on a focused tab), like a
// browser tab's menu: a header with what the office is (folder, boss, workers, running jobs, to-do progress) and what
// can be done with it. The header and the items are pure (tested in office-menu.test.ts); OfficeMenu only draws them.
// More items: add a builder to OFFICE_MENU_ITEMS (each returns an item or null, in menu order).
import type { OfficeInfo, OfficeSnapshot } from '../../../shared/types';
import { bossPlan, officeItems } from './board-model';
import { h, setText } from './dom';
import { plural } from './format';
import { statusLabel } from './model';
import { folderOverlap, officeBoss, teamOffices } from './offices';
import { scopeLine } from './rules-model';
import { tr } from '../../../shared/i18n';

type SummarySnap = Pick<OfficeSnapshot, 'agents' | 'rooms' | 'accounts'> & Partial<Pick<OfficeSnapshot, 'team'>>;

export interface OfficeSummary {
  name: string;
  /** '' = no folder yet. */
  folder: string;
  /** Name and state; absent = no boss. */
  boss?: { name: string; state: string };
  /** Short names of the workers. */
  workers: string[];
  /** Jobs of this office running on the workers. */
  running: number;
  /** The to-do list (its folder's HANDOFF file); absent = no list yet. */
  todo?: { done: number; total: number; next?: string };
  /** Its rules' scope in one line (rules-model.ts scopeLine); absent = a server without rules. */
  scope?: string;
  /** Another office whose folder overlaps this one's (a team file from before that was refused). */
  overlap?: string;
}

/** "alice (Agy)" -> "alice". */
const bare = (name: string): string => name.replace(/\s*\([^)]*\)\s*$/, '');

/** A worker's short name: its account's name (Claude "claude:<id>", Antigravity "accN"), else the id. */
export function workerShortName(snap: Pick<SummarySnap, 'accounts' | 'team'> | null | undefined, worker: string): string {
  const account = worker.startsWith('claude:') ? worker.slice(7) : snap?.team?.agy.find((p) => p.acc === worker)?.account;
  const acc = account ? snap?.accounts.find((a) => a.id === account) : undefined;
  return acc ? bare(acc.name) || worker : worker;
}

export function officeSummary(snap: SummarySnap | null | undefined, office: OfficeInfo): OfficeSummary {
  const agent = officeBoss(snap, office);
  const boss = agent
    ? { name: agent.name, state: statusLabel(agent.status) }
    : office.waitingBoss
      ? { name: office.waitingBoss, state: tr('session closed') }
      : office.pendingBoss
        ? { name: tr('New boss'), state: tr('opening…') }
        : undefined;
  const items = bossPlan(snap, office)?.plan?.items ?? [];
  const running = officeItems((snap?.rooms ?? []).flatMap((r) => r.board?.items ?? []).filter((j) => j.status === 'working'), snap, office).length;
  const next = items.find((t) => !t.done)?.text;
  const overlap = folderOverlap(teamOffices(snap?.team), office);
  return {
    name: office.name,
    folder: office.folder,
    ...(boss ? { boss } : {}),
    workers: office.workers.map((w) => workerShortName(snap, w)),
    running,
    ...(items.length ? { todo: { done: items.filter((t) => t.done).length, total: items.length, ...(next ? { next } : {}) } } : {}),
    ...(office.rules ? { scope: scopeLine(office) } : {}),
    ...(overlap ? { overlap: overlap.name } : {}),
  };
}

export interface OfficeMenuItem {
  id: string;
  label: string;
  /** Why it cannot be picked now; '' or absent = it can. */
  disabled?: string;
  /** Red (a destructive action). */
  danger?: boolean;
  /** A line above it. */
  separator?: boolean;
  run: () => void;
}

/** What the item builders know and can do. The actions get the office id. */
export interface OfficeMenuEnv {
  snap: SummarySnap | null | undefined;
  /** The office shown. */
  shownId: string | undefined;
  /** Why offices cannot be changed here ('' = they can). */
  locked: string;
  /** Why ＋ Boss cannot be used at all ('' = it can: its dialog explains softer limits; absent = no ＋ Boss here). */
  bossBlocked?: string;
  /** Why ＋ Worker cannot be used ('' = it can; absent = no ＋ Worker here). */
  workerBlocked?: string;
  show(id: string): void;
  rename(id: string): void;
  changeFolder(id: string): void;
  copyFolder(id: string): void;
  openBoard?(id: string): void;
  openRules?(id: string): void;
  addBoss?(id: string): void;
  addWorker?(id: string): void;
  create(): void;
  remove(id: string): void;
}

export type OfficeMenuBuilder = (office: OfficeInfo, env: OfficeMenuEnv) => OfficeMenuItem | null;

/** The items, in menu order. */
export const OFFICE_MENU_ITEMS: OfficeMenuBuilder[] = [
  (o, env) => (env.shownId === o.id ? null : { id: 'show', label: tr('Show this office'), run: () => env.show(o.id) }),
  (o, env) => ({ id: 'rename', label: tr('Rename…'), disabled: env.locked, run: () => env.rename(o.id) }),
  (o, env) => ({ id: 'folder', label: o.folder ? tr('Change folder…') : tr('Choose its folder…'), disabled: env.locked, run: () => env.changeFolder(o.id) }),
  (o, env) => ({ id: 'copy', label: tr('Copy folder path'), disabled: o.folder ? '' : tr('No folder yet'), run: () => env.copyFolder(o.id) }),
  (o, env) => (env.openBoard ? { id: 'board', label: tr('📋 Open the Board on this office'), separator: true, run: () => env.openBoard!(o.id) } : null),
  (o, env) => (env.openRules ? { id: 'rules', label: tr('📜 Rules…'), disabled: o.rules ? '' : tr('This Habblaud server does not keep office rules yet'), run: () => env.openRules!(o.id) } : null),
  (o, env) => (env.addBoss && env.bossBlocked !== undefined ? { id: 'boss', label: tr('＋ Boss…'), disabled: env.locked || env.bossBlocked, run: () => env.addBoss!(o.id) } : null),
  (o, env) => (env.addWorker && env.workerBlocked !== undefined ? { id: 'worker', label: tr('＋ Worker…'), disabled: env.locked || env.workerBlocked, run: () => env.addWorker!(o.id) } : null),
  (_o, env) => ({ id: 'new', label: tr('＋ New office…'), separator: true, disabled: env.locked, run: () => env.create() }),
  (o, env) => ({
    id: 'delete',
    label: tr('Delete office…'),
    danger: true,
    separator: true,
    disabled: env.locked || (teamOffices(env.snap?.team).length <= 1 ? tr('The last office cannot be deleted') : ''),
    run: () => env.remove(o.id),
  }),
];

export function officeMenuItems(office: OfficeInfo, env: OfficeMenuEnv, builders: readonly OfficeMenuBuilder[] = OFFICE_MENU_ITEMS): OfficeMenuItem[] {
  return builders.map((b) => b(office, env)).filter((x): x is OfficeMenuItem => !!x);
}

/** The floating menu: header + items; arrows move, Enter picks, Esc / Tab / a click outside closes. */
export class OfficeMenu {
  readonly el: HTMLElement;
  private readonly head: HTMLElement;
  private readonly list: HTMLElement;
  private officeId = '';
  private opener: HTMLElement | null = null;
  private sig = '';
  /** When it last opened (a long press may also send a contextmenu event: one menu only). */
  openedAt = 0;
  private readonly onDocDown = (e: PointerEvent) => {
    if (!this.el.contains(e.target as Node)) this.close(false);
  };
  private readonly onResize = () => this.close(false);

  constructor(
    private readonly snapshot: () => SummarySnap | null | undefined,
    private readonly env: () => OfficeMenuEnv,
  ) {
    this.head = h('div', { class: 'ui-officemenu__head' });
    this.list = h('div', { class: 'ui-officemenu__items' });
    this.el = h('div', { class: 'ui-officemenu', role: 'menu', hidden: true }, this.head, this.list);
    this.el.addEventListener('keydown', (e) => this.keys(e));
    this.el.addEventListener('keyup', (e) => e.stopPropagation());
  }

  get openFor(): string {
    return this.el.hidden ? '' : this.officeId;
  }

  /** Opens on the office: at a point (window px), else under `opener`. */
  open(officeId: string, opener: HTMLElement, at?: { x: number; y: number }): void {
    if (!teamOffices(this.snapshot()?.team).some((o) => o.id === officeId)) return;
    this.officeId = officeId;
    this.opener = opener;
    this.openedAt = Date.now();
    this.sig = '';
    this.el.hidden = false;
    this.render();
    const r = opener.getBoundingClientRect();
    const p = at ?? { x: r.left, y: r.bottom + 2 };
    const w = this.el.offsetWidth || 280;
    const hgt = this.el.offsetHeight || 300;
    this.el.style.left = `${Math.max(8, Math.min(p.x, innerWidth - w - 8))}px`;
    this.el.style.top = `${Math.max(8, Math.min(p.y, innerHeight - hgt - 8))}px`;
    this.focusAt(0);
    document.addEventListener('pointerdown', this.onDocDown, true);
    window.addEventListener('resize', this.onResize);
  }

  close(refocus = true): void {
    if (this.el.hidden) return;
    this.el.hidden = true;
    document.removeEventListener('pointerdown', this.onDocDown, true);
    window.removeEventListener('resize', this.onResize);
    if (refocus && this.opener?.isConnected) this.opener.focus();
    this.opener = null;
  }

  /** Redraws when the office changed (called with the tabs' render). */
  render(): void {
    if (this.el.hidden) return;
    const office = teamOffices(this.snapshot()?.team).find((o) => o.id === this.officeId);
    if (!office) return this.close(false);
    const env = this.env();
    const s = officeSummary(this.snapshot(), office);
    const items = officeMenuItems(office, env);
    const sig = JSON.stringify([s, items.map((i) => [i.id, i.label, i.disabled])]);
    if (sig === this.sig) return;
    const focused = this.list.querySelector<HTMLElement>('.ui-officemenu__item:focus')?.dataset.id;
    this.sig = sig;
    this.drawHead(s);
    this.list.replaceChildren(
      ...items.flatMap((it) => {
        const b = h('button', {
          class: `ui-officemenu__item${it.danger ? ' is-danger' : ''}`,
          type: 'button',
          role: 'menuitem',
          text: it.label,
          attrs: { 'data-id': it.id, tabindex: '-1' },
          on: {
            click: () => {
              if (it.disabled) return;
              this.close(false);
              it.run();
            },
          },
        });
        if (it.disabled) {
          b.setAttribute('aria-disabled', 'true');
          b.title = it.disabled;
        }
        return it.separator ? [h('div', { class: 'ui-officemenu__sep', role: 'separator' }), b] : [b];
      }),
    );
    if (focused) this.list.querySelector<HTMLElement>(`[data-id="${CSS.escape(focused)}"]`)?.focus();
  }

  private drawHead(s: OfficeSummary): void {
    const line = (label: string, value: string, muted = false) =>
      h('div', { class: 'ui-officemenu__row' }, h('span', { class: 'ui-officemenu__label', text: label }), h('span', { class: `ui-officemenu__value${muted ? ' ui-muted' : ''}`, text: value }));
    const folder = h('div', { class: `ui-officemenu__folder${s.folder ? '' : ' ui-muted'}` });
    setText(folder, s.folder || tr('No folder yet'));
    if (s.folder) folder.title = s.folder;
    const todo = s.todo ? `${s.todo.done}/${s.todo.total}${s.todo.next ? ` · ${tr('next: {0}', [s.todo.next])}` : ` · ${tr('all done')}`}` : tr('no list yet');
    this.head.replaceChildren(
      h('div', { class: 'ui-officemenu__name', text: s.name }),
      folder,
      line(tr('Boss'), s.boss ? `👑 ${s.boss.name} · ${s.boss.state}` : tr('No boss'), !s.boss),
      line(tr('Workers'), s.workers.length ? `${s.workers.length} · ${s.workers.join(', ')}` : tr('none'), !s.workers.length),
      line(tr('Running'), s.running ? plural(s.running, tr('job'), tr('jobs')) : tr('no job'), !s.running),
      line(tr('To-do'), todo, !s.todo),
      ...(s.scope ? [line(tr('Scope'), s.scope)] : []),
      ...(s.overlap ? [h('p', { class: 'ui-officemenu__warn', text: tr('⚠ Its folder overlaps the folder of {0}: change one of them.', [s.overlap]) })] : []),
    );
    for (const v of this.head.querySelectorAll<HTMLElement>('.ui-officemenu__value')) v.title = v.textContent ?? '';
  }

  private items(): HTMLElement[] {
    return [...this.list.querySelectorAll<HTMLElement>('.ui-officemenu__item')];
  }

  private focusAt(i: number): void {
    const items = this.items();
    if (items.length) items[(i + items.length) % items.length].focus();
  }

  private keys(e: KeyboardEvent): void {
    // The office's own shortcuts stay quiet while the menu is open.
    e.stopPropagation();
    const items = this.items();
    const i = items.indexOf(document.activeElement as HTMLElement);
    if (e.key === 'ArrowDown') this.focusAt(i + 1);
    else if (e.key === 'ArrowUp') this.focusAt(i < 0 ? -1 : i - 1);
    else if (e.key === 'Home') this.focusAt(0);
    else if (e.key === 'End') this.focusAt(-1);
    else if (e.key === 'Escape') this.close();
    else if (e.key === 'Tab') this.close();
    else return;
    if (e.key !== 'Tab') e.preventDefault();
  }
}
