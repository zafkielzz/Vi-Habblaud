// "My day": dialog showing where the day went — agent time by status, highlighting time
// waiting on you (the human bottleneck), by project, by hour, and by account, longest waits, tokens, and cost.
// Data from GET /api/stats (in ?mock=1, from the same accumulator in shared/daystats.ts running in the browser
// over the simulator). Charts in pure DOM: thin stacked bars, tooltip on hover and focus, equivalent table in each
// card, and legend that toggles each status. When open on today, refreshes every 30 s.
// The model (highlights, scales, labels) is pure and tested in ui/daystats-model.test.ts.
import {
  dayKeyOf,
  daysFromHours,
  queryDay,
  StatsBook,
  StatsTracker,
  systemTimeZone,
  TIMED_STATUSES,
  type DayStatsResponse,
  type StatsDaysResponse,
  type StatsSource,
  type TimedStatus,
} from '../../../shared/daystats';
import { seedDemoHistory } from '../../../shared/demo/daystats';
import type { OfficeStore } from '../net/store';
import type { UiComponent, UiContext } from './context';
import { h, iconButton, setAttr, setHidden, setStyleVar, setText } from './dom';
import {
  accountCards,
  ALL_VISIBLE,
  axisLabel,
  dayLabel,
  daysUrl,
  formatAgentTime,
  highlights,
  hourColumns,
  isEmptyDay,
  roomRows,
  shouldRefresh,
  STATUS_TEXT,
  statsUrl,
  statusTable,
  visibleTotal,
  waitRows,
  type HourColumn,
  type RoomRow,
} from './daystats-model';
import { formatClock } from './format';
import { ICONS } from './icons';
import { accountProvider } from './provider';
import { tr } from '../../../shared/i18n';

const REFRESH_MS = 30_000;
const NOTE =
  tr('Agent time is the sum of all agents: two agents working for 1 hour count as 2 hours. ') +
  tr('“Waiting on you” is the time spent with a hand raised in the office (permission, question or choice). ') +
  tr("Habblaud only counts what happens while it's running.");

/** Where numbers come from: the server or, in ?mock=1, the local accumulator. */
interface DaySource {
  days(tz: string): Promise<StatsDaysResponse>;
  day(day: string, tz: string, source?: StatsSource): Promise<DayStatsResponse>;
}

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { cache: 'no-store' });
  const body = (await res.json().catch(() => null)) as (T & { error?: string }) | null;
  if (!res.ok || !body) throw new Error(body?.error ?? tr('error {0}', [res.status]));
  return body;
}

const httpSource: DaySource = {
  days: (tz) => getJson<StatsDaysResponse>(daysUrl(tz)),
  day: (day, tz, source) => getJson<DayStatsResponse>(statsUrl(day, tz, source)),
};

/**
 * ?mock=1: the same server tracker over simulator snapshots, with fake demo history.
 * Starts counting when page opens (not when panel opens).
 */
class LocalSource implements DaySource {
  private readonly tz = systemTimeZone();
  private readonly book = new StatsBook((t) => dayKeyOf(t, this.tz));
  private readonly tracker = new StatsTracker(this.book, { startedAt: Date.now() });
  private seeded = false;
  private last = 0;

  constructor(store: OfficeStore) {
    store.on('snapshot', (snap) => {
      const now = Date.now();
      if (now - this.last < 1_000) return;
      this.last = now;
      if (!this.seeded) {
        seedDemoHistory(this.book, snap, now, this.tz);
        this.seeded = true;
      }
      this.tracker.observe(snap, now);
    });
  }

  async days(tz: string): Promise<StatsDaysResponse> {
    const today = dayKeyOf(Date.now(), tz);
    const days = new Set([today]);
    for (const d of this.book.list()) for (const k of daysFromHours(d.hoursWithData(), tz)) days.add(k);
    return { tz, today, days: [...days].sort().reverse(), demoAvailable: false };
  }

  async day(day: string, tz: string): Promise<DayStatsResponse> {
    const now = Date.now();
    return { source: 'demo', demoAvailable: false, today: dayKeyOf(now, tz), serverTime: now, stats: queryDay(this.book.list(), day, tz, now) };
  }
}

interface TipRow {
  status?: TimedStatus;
  label: string;
  value: string;
}

type TableKey = 'rooms' | 'hours';

export class DayPanel implements UiComponent {
  readonly el: HTMLDialogElement;
  private readonly source: DaySource;
  private readonly tz = systemTimeZone();
  private days: StatsDaysResponse | null = null;
  private data: DayStatsResponse | null = null;
  private day: string | null = null;
  /** User-selected source (unspecified: server decides; with demo active, demo). */
  private sourcePref: StatsSource | undefined;
  private visible = new Set<TimedStatus>(ALL_VISIBLE);
  private tables = new Set<TableKey>();
  private loading = false;
  private error: string | null = null;
  private seq = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private demoSeen: boolean | undefined;
  private opener: HTMLElement | null = null;

  private select: HTMLSelectElement;
  private seg: HTMLElement;
  private segDemo: HTMLButtonElement;
  private segReal: HTMLButtonElement;
  private badge: HTMLElement;
  private status: HTMLElement;
  private statusText: HTMLElement;
  private retry: HTMLButtonElement;
  private content: HTMLElement;
  private tip: HTMLElement;

  /** `button` = "My day" button in top bar (ui/daystats-launcher.ts), reflecting whether dialog is open. */
  constructor(
    private ctx: UiContext,
    private button: HTMLElement,
  ) {
    this.source = ctx.store.mock ? new LocalSource(ctx.store) : httpSource;

    this.select = h('select', { class: 'ui-day__select', attrs: { 'aria-label': tr('Day') }, on: { change: () => this.pickDay(this.select.value) } });
    this.segDemo = h('button', { class: 'ui-seg__opt', type: 'button', role: 'radio', text: tr('Demo'), on: { click: () => this.pickSource('demo') } });
    this.segReal = h('button', { class: 'ui-seg__opt', type: 'button', role: 'radio', text: tr('Real data'), on: { click: () => this.pickSource('real') } });
    this.seg = h('div', { class: 'ui-seg ui-day__source', role: 'radiogroup', hidden: true, attrs: { 'aria-label': tr('Data shown') } }, this.segDemo, this.segReal);
    this.badge = h('span', { class: 'ui-day__badge', text: tr('demo'), title: tr('Made-up numbers from demo mode'), hidden: true });
    const close = iconButton(ICONS.close, tr('Close (Esc)'), () => this.close(), 'ui-icon-btn--sm');

    this.statusText = h('span', {});
    this.retry = h('button', { class: 'ui-link-btn', type: 'button', text: tr('Try again'), hidden: true, on: { click: () => void this.load(true) } });
    // No aria-live: "updated at…" would change every 30 s; errors are announced separately.
    this.status = h('p', { class: 'ui-day__status' }, this.statusText, this.retry);
    this.content = h('div', { class: 'ui-day__content' });
    this.tip = h('div', { class: 'ui-day__tip', role: 'tooltip', hidden: true, attrs: { 'aria-hidden': 'true' } });

    this.el = h(
      'dialog',
      { class: 'ui-dialog ui-day', attrs: { 'aria-labelledby': 'ui-day-title' } },
      h(
        'div',
        { class: 'ui-dialog__head ui-day__head' },
        h('div', { class: 'ui-day__title' }, h('h2', { text: tr('My day'), attrs: { id: 'ui-day-title' } }), this.badge),
        h('div', { class: 'ui-day__controls' }, this.select, this.seg),
        close,
      ),
      h('div', { class: 'ui-day__body' }, this.status, this.content, h('p', { class: 'ui-day__note', text: NOTE })),
      this.tip,
    );
    // Clicking backdrop closes dialog; keyboard focus stays inside (office shortcuts do not fire underneath).
    this.el.addEventListener('click', (e) => {
      if (e.target === this.el) this.close();
    });
    this.el.addEventListener('keydown', (e) => e.stopPropagation());
    this.el.addEventListener('close', () => this.onClosed());
    this.el.addEventListener('scroll', () => this.hideTip(), true);
  }

  get isOpen(): boolean {
    return this.el.open;
  }

  open(): void {
    if (this.el.open) return;
    this.opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    // Always opens on current day (page may have remained open across midnight).
    this.day = null;
    this.el.showModal();
    this.button.setAttribute('aria-expanded', 'true');
    void this.load(true);
  }

  close(): void {
    if (this.el.open) this.el.close();
  }

  toggle(): void {
    if (this.el.open) this.close();
    else this.open();
  }

  /** Demo enabled or disabled while dialog is open: reloads (default source changes). */
  render(): void {
    const demo = this.ctx.store.snapshot?.meta.demo;
    if (demo === this.demoSeen) return;
    const changed = this.demoSeen !== undefined;
    this.demoSeen = demo;
    if (changed && this.el.open && !this.ctx.store.mock) void this.load(true);
  }

  private onClosed(): void {
    this.seq++;
    this.stopTimer();
    this.hideTip();
    this.button.setAttribute('aria-expanded', 'false');
    if (this.opener?.isConnected) this.opener.focus({ preventScroll: true });
    this.opener = null;
  }

  private pickDay(day: string): void {
    this.day = day;
    // Switching days preserves source: viewing demo stays in demo.
    this.sourcePref ??= this.data?.source;
    void this.load(false);
  }

  private pickSource(src: StatsSource): void {
    if (this.data?.source === src) return;
    this.sourcePref = src;
    const list = src === 'demo' ? this.days?.demoDays : this.days?.days;
    if (this.day && list && !list.includes(this.day)) this.day = null;
    void this.load(false);
  }

  // ---------------------------------------------------------------- data

  private async load(withDays: boolean): Promise<void> {
    const seq = ++this.seq;
    this.stopTimer();
    this.loading = true;
    this.renderStatus();
    try {
      if (withDays || !this.days) {
        const days = await this.source.days(this.tz);
        if (seq !== this.seq) return;
        this.days = days;
        // Demo disabled: reverts to default.
        if (this.sourcePref === 'demo' && !days.demoAvailable) this.sourcePref = undefined;
      }
      const day = this.day ?? this.days.today;
      const res = await this.source.day(day, this.tz, this.sourcePref);
      if (seq !== this.seq) return;
      this.data = res;
      this.day = res.stats.day;
      this.error = null;
      this.renderAll();
    } catch (err) {
      if (seq !== this.seq) return;
      this.error = err instanceof Error ? err.message : String(err);
      this.ctx.announce(tr("Couldn't load the day's stats."));
      // Selector reverts to day currently displayed.
      if (this.data) {
        this.day = this.data.stats.day;
        this.renderControls(this.data);
      }
    } finally {
      if (seq === this.seq) {
        this.loading = false;
        this.renderStatus();
        if (shouldRefresh(this.el.open, this.day ?? '', this.data?.today ?? '')) {
          this.timer = setTimeout(() => void this.load(true), REFRESH_MS);
        }
      }
    }
  }

  private stopTimer(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  // ---------------------------------------------------------------- render

  private renderStatus(): void {
    this.el.classList.toggle('is-loading', this.loading && !!this.data);
    setHidden(this.retry, !this.error);
    if (this.error) setText(this.statusText, tr("Couldn't load the stats ({0}).", [this.error]));
    else if (this.loading && !this.data) setText(this.statusText, tr('Loading…'));
    else if (this.data) {
      const today = this.data.stats.day === this.data.today;
      setText(this.statusText, today ? tr('Updated at {0} · refreshes every 30 s', [formatClock(this.data.serverTime)]) : '');
    }
  }

  private renderAll(): void {
    const res = this.data;
    if (!res) return;
    this.renderControls(res);
    // Rebuilding content must preserve focus for keyboard navigation.
    const focusKey = (document.activeElement as HTMLElement | null)?.closest<HTMLElement>('[data-focus-key]')?.dataset.focusKey;
    this.hideTip();
    this.content.replaceChildren(...this.sections(res));
    if (focusKey) this.content.querySelector<HTMLElement>(`[data-focus-key="${CSS.escape(focusKey)}"]`)?.focus({ preventScroll: true });
  }

  private renderControls(res: DayStatsResponse): void {
    const demo = res.source === 'demo';
    setHidden(this.badge, !demo);
    setHidden(this.seg, !res.demoAvailable);
    setAttr(this.segDemo, 'aria-checked', String(demo));
    setAttr(this.segReal, 'aria-checked', String(!demo));
    const list = (demo ? this.days?.demoDays : this.days?.days) ?? [res.today];
    const days = list.includes(res.stats.day) ? list : [res.stats.day, ...list];
    this.select.replaceChildren(...days.map((d) => h('option', { text: dayLabel(d, res.today), attrs: { value: d, selected: d === res.stats.day } })));
    this.select.value = res.stats.day;
    this.select.disabled = days.length < 2;
  }

  private sections(res: DayStatsResponse): HTMLElement[] {
    const stats = res.stats;
    const clock = (t: number) => formatClock(t, false);
    const hl = highlights(stats, clock, stats.accounts.some((a) => this.isCodexAccount(a.id) && a.counts.tokensIn + a.counts.tokensOut > 0));
    const out: HTMLElement[] = [this.kpis(hl)];
    if (isEmptyDay(stats)) {
      const today = stats.day === res.today;
      out.push(
        h('p', {
          class: 'ui-day__empty',
          text: today
            ? tr('No time recorded today yet. The numbers show up as soon as an agent works with Habblaud open.')
            : tr('Nothing recorded on this day.'),
        }),
      );
      return out;
    }
    out.push(this.legend());
    out.push(this.hoursCard(res));
    out.push(this.roomsCard(roomRows(stats.rooms, this.visible)));
    out.push(this.waitsCard(waitRows(stats.waits, clock), res));
    out.push(this.accountsCard(res));
    return out;
  }

  // Highlights: time waiting on you prominently displayed with longest wait; others in smaller tiles.
  private kpis(hl: ReturnType<typeof highlights>): HTMLElement {
    const swatch = h('span', { class: 'ui-day__swatch is-waiting', attrs: { 'aria-hidden': 'true' } });
    const hero = h(
      'div',
      { class: 'ui-day__hero' },
      h('p', { class: 'ui-day__kpi-label' }, swatch, h('span', { text: tr('Waiting on you') })),
      h('p', { class: 'ui-day__hero-value', text: hl.waiting }),
      h('p', { class: 'ui-day__kpi-sub', text: hl.waits }),
      hl.longest ? h('p', { class: 'ui-day__kpi-sub' }, h('span', { class: 'ui-day__muted', text: tr('Longest wait: ') }), h('strong', { text: hl.longest })) : null,
      hl.wall ? h('p', { class: 'ui-day__kpi-sub', text: hl.wall }) : null,
    );
    const tile = (label: string, value: string, sub: string, title?: string, status?: TimedStatus) =>
      h(
        'div',
        { class: 'ui-day__kpi', title },
        h('p', { class: 'ui-day__kpi-label' }, status ? h('span', { class: `ui-day__swatch is-${status}`, attrs: { 'aria-hidden': 'true' } }) : null, h('span', { text: label })),
        h('p', { class: 'ui-day__kpi-value', text: value }),
        h('p', { class: 'ui-day__kpi-sub', text: sub }),
      );
    return h(
      'section',
      { class: 'ui-day__kpis', attrs: { 'aria-label': tr('Day highlights') } },
      hero,
      tile(tr('Working'), hl.working, tr("sum of all agents' time"), undefined, 'working'),
      tile(tr('Sessions'), hl.sessions, hl.subagents),
      tile(tr('Requests'), hl.prompts, hl.activity),
      tile('Tokens', hl.tokens, hl.tokensDetail),
      tile(tr('Cost'), hl.cost, hl.costHint, hl.costHint),
    );
  }

  // Unified status chart legend: each item toggles status across all charts (scales recalculate).
  private legend(): HTMLElement {
    const items = TIMED_STATUSES.map((s) => {
      const on = this.visible.has(s);
      return h(
        'button',
        {
          class: `ui-day__key${on ? '' : ' is-off'}`,
          type: 'button',
          title: on ? tr('Hide “{0}” from the charts', [STATUS_TEXT[s]]) : tr('Show “{0}” in the charts', [STATUS_TEXT[s]]),
          attrs: { 'aria-pressed': String(on), 'data-focus-key': `key:${s}` },
          on: { click: () => this.toggleStatus(s) },
        },
        h('span', { class: `ui-day__swatch is-${s}`, attrs: { 'aria-hidden': 'true' } }),
        h('span', { text: STATUS_TEXT[s] }),
      );
    });
    return h('div', { class: 'ui-day__legend', role: 'group', attrs: { 'aria-label': tr('Statuses in the charts (click to show or hide)') } }, ...items);
  }

  private toggleStatus(s: TimedStatus): void {
    if (this.visible.has(s)) {
      if (this.visible.size === 1) return; // always leave at least one
      this.visible.delete(s);
    } else this.visible.add(s);
    this.renderAll();
  }

  private card(key: string, title: string, sub: string, table?: TableKey): { el: HTMLElement; body: HTMLElement; showTable: boolean } {
    const showTable = !!table && this.tables.has(table);
    const toggle = table
      ? h('button', {
          class: 'ui-link-btn ui-day__table-btn',
          type: 'button',
          text: showTable ? tr('View chart') : tr('View table'),
          attrs: { 'aria-pressed': String(showTable), 'data-focus-key': `table:${table}` },
          on: {
            click: () => {
              if (this.tables.has(table)) this.tables.delete(table);
              else this.tables.add(table);
              this.renderAll();
            },
          },
        })
      : null;
    const body = h('div', { class: 'ui-day__card-body' });
    const el = h(
      'section',
      { class: `ui-day__card ui-day__card--${key}`, attrs: { 'aria-labelledby': `ui-day-${key}` } },
      h('div', { class: 'ui-day__card-head' }, h('div', {}, h('h3', { text: title, attrs: { id: `ui-day-${key}` } }), h('p', { class: 'ui-day__card-sub', text: sub })), toggle),
      body,
    );
    return { el, body, showTable };
  }

  private table(head: string[], rows: string[][], caption: string): HTMLElement {
    return h(
      'div',
      { class: 'ui-day__table-wrap' },
      h(
        'table',
        { class: 'ui-day__table' },
        h('caption', { class: 'ui-sr', text: caption }),
        h('thead', {}, h('tr', {}, ...head.map((c, i) => h('th', { text: c, attrs: { scope: 'col', class: i ? 'is-num' : undefined } })))),
        h('tbody', {}, ...rows.map((r) => h('tr', {}, ...r.map((c, i) => (i ? h('td', { class: 'is-num', text: c }) : h('th', { text: c, attrs: { scope: 'row' } })))))),
      ),
    );
  }

  // ---------------------------------------------------------------- by hour

  private hoursCard(res: DayStatsResponse): HTMLElement {
    const narrow = this.ctx.isNarrow();
    const { columns, axis } = hourColumns(res.stats.hours, this.visible, res.serverTime, narrow ? 6 : 3);
    const c = this.card('hours', tr('By hour'), tr('Agent time in each hour of the day'), 'hours');
    if (c.showTable) {
      const t = statusTable(columns, (col) => col.range, this.visible);
      c.body.append(this.table([tr('Hour'), ...t.head], t.rows, tr('Agent time by hour')));
      return c.el;
    }
    const grid = h(
      'div',
      { class: 'ui-day__grid', attrs: { 'aria-hidden': 'true' } },
      ...axis.ticks.map((tick) => h('span', { class: 'ui-day__gridline', style: `bottom:${(tick / axis.max) * 100}%` }, h('span', { class: 'ui-day__tick', text: axisLabel(tick) }))),
    );
    const cols = h('div', { class: 'ui-day__cols', role: 'list', attrs: { 'aria-label': tr('Agent time by hour (arrows to navigate)') } });
    let tabbable = columns.findIndex((col) => col.now);
    if (tabbable < 0) tabbable = 0;
    columns.forEach((col, i) => cols.append(this.column(col, i === tabbable)));
    cols.addEventListener('keydown', (e) => this.moveFocus(e, cols));
    const axisX = h(
      'div',
      { class: 'ui-day__xaxis', attrs: { 'aria-hidden': 'true' } },
      ...columns.map((col) => h('span', { class: `ui-day__xlabel${col.now ? ' is-now' : ''}`, text: col.tick || (col.now && !narrow) ? `${col.hour}h` : '' })),
    );
    c.body.append(h('div', { class: 'ui-day__plot' }, grid, cols), axisX);
    return c.el;
  }

  private column(col: HourColumn, tabbable: boolean): HTMLElement {
    const stack = h('span', { class: 'ui-day__stack' }, ...col.segments.map((s) => h('span', { class: `ui-day__seg is-${s.status}`, style: `height:${s.pct}%`, attrs: { 'data-status': s.status } })));
    const el = h(
      'div',
      {
        class: `ui-day__col${col.now ? ' is-now' : ''}`,
        role: 'listitem',
        tabIndex: tabbable ? 0 : -1,
        attrs: { 'aria-label': `${col.label}${col.now ? tr(' (now)') : ''}`, 'data-focus-key': `hour:${col.t}` },
      },
      stack,
    );
    const rows = (): TipRow[] =>
      col.future
        ? []
        : [
            ...TIMED_STATUSES.filter((s) => this.visible.has(s) && col.ms[s] > 0).map((s) => ({ status: s, label: STATUS_TEXT[s], value: formatAgentTime(col.ms[s]) })),
            { label: 'Total', value: formatAgentTime(col.total) },
          ];
    // Tooltip anchors to top of rendered column stack (not chart top).
    this.bindTip(el, () => `${col.range}${col.now ? tr(' · now') : col.future ? tr(' · not yet') : ''}`, rows, () => stack.lastElementChild ?? stack);
    return el;
  }

  /** Arrow keys, Home, and End across columns (only one retains Tab focus). */
  private moveFocus(e: KeyboardEvent, list: HTMLElement): void {
    const items = [...list.children] as HTMLElement[];
    const i = items.indexOf(document.activeElement as HTMLElement);
    if (i < 0) return;
    const next = e.key === 'ArrowRight' ? i + 1 : e.key === 'ArrowLeft' ? i - 1 : e.key === 'Home' ? 0 : e.key === 'End' ? items.length - 1 : -2;
    if (next === -2) return;
    e.preventDefault();
    const target = items[Math.max(0, Math.min(items.length - 1, next))];
    items.forEach((it) => (it.tabIndex = it === target ? 0 : -1));
    target.focus();
  }

  // ---------------------------------------------------------------- by project

  private roomsCard(rows: RoomRow[]): HTMLElement {
    const c = this.card('rooms', tr('By project'), tr('Sorted by time waiting on you'), 'rooms');
    if (!rows.length) {
      c.body.append(h('p', { class: 'ui-day__muted', text: tr('No projects with time on this day.') }));
      return c.el;
    }
    if (c.showTable) {
      const t = statusTable(rows, (r) => r.name, this.visible);
      c.body.append(this.table([tr('Project'), ...t.head], t.rows, tr('Agent time by project')));
      return c.el;
    }
    const list = h('ul', { class: 'ui-day__bars' });
    for (const r of rows) {
      const track = h(
        'span',
        { class: 'ui-day__track' },
        ...r.segments.map((s) => h('span', { class: `ui-day__seg is-${s.status}`, style: `width:${s.pct}%`, attrs: { 'data-status': s.status } })),
      );
      const li = h(
        'li',
        { class: 'ui-day__bar', tabIndex: 0, attrs: { 'aria-label': r.label, 'data-focus-key': `room:${r.id}` } },
        h(
          'span',
          { class: 'ui-day__bar-head' },
          h('span', { class: 'ui-day__bar-name', text: r.name, title: r.id }),
          h('span', { class: 'ui-day__bar-value' }, this.visible.has('waiting') ? h('strong', { text: r.waiting }) : null, h('span', { class: 'ui-day__muted', text: r.totalText })),
        ),
        track,
      );
      const tipRows = (): TipRow[] => [
        ...TIMED_STATUSES.filter((s) => this.visible.has(s) && r.ms[s] > 0).map((s) => ({ status: s, label: STATUS_TEXT[s], value: formatAgentTime(r.ms[s]) })),
        { label: 'Total', value: formatAgentTime(visibleTotal(r.ms, this.visible)) },
      ];
      this.bindTip(li, () => r.name, tipRows);
      list.append(li);
    }
    c.body.append(list);
    return c.el;
  }

  // ---------------------------------------------------------------- longest waits

  private waitsCard(rows: ReturnType<typeof waitRows>, res: DayStatsResponse): HTMLElement {
    const c = this.card('waits', tr('Longest waits'), tr('How long each agent kept a hand raised waiting on you'));
    if (!rows.length) {
      c.body.append(h('p', { class: 'ui-day__muted', text: tr('Nobody waited on you this day.') }));
      return c.el;
    }
    const accounts = new Map(res.stats.accounts.map((a) => [a.id, a]));
    const list = h('ol', { class: 'ui-day__waits' });
    for (const w of rows) {
      const acc = accounts.get(w.account);
      const chip = h('span', { class: 'ui-acc-chip', text: acc?.short ?? '?', title: acc?.name ?? w.account });
      setStyleVar(chip, '--acc', acc?.color ?? '#8b98b3');
      if (this.isCodexAccount(w.account)) chip.dataset.provider = 'codex';
      list.append(
        h(
          'li',
          { class: `ui-day__wait${w.ongoing ? ' is-ongoing' : ''}`, attrs: { 'aria-label': w.label } },
          h('span', { class: 'ui-day__rank', text: `${w.rank}`, attrs: { 'aria-hidden': 'true' } }),
          h(
            'span',
            { class: 'ui-day__wait-main', attrs: { 'aria-hidden': 'true' } },
            h(
              'span',
              { class: 'ui-day__wait-top' },
              h('strong', { class: 'ui-day__wait-dur', text: w.duration }),
              h('span', { class: 'ui-day__wait-bar' }, h('span', { class: 'ui-day__seg is-waiting', style: `width:${w.pct}%` })),
              w.ongoing ? h('span', { class: 'ui-day__now', text: tr('waiting now') }) : null,
            ),
            h(
              'span',
              { class: 'ui-day__wait-who' },
              chip,
              h('span', { class: 'ui-day__wait-name', text: w.agentName }),
              h('span', { class: 'ui-day__muted', text: `${tr('in {0}', [w.roomName])} · ${w.when}${w.reason ? ` · ${w.reason}` : ''}` }),
            ),
          ),
        ),
      );
    }
    c.body.append(list);
    return c.el;
  }

  // ---------------------------------------------------------------- by account

  private accountsCard(res: DayStatsResponse): HTMLElement {
    const cards = accountCards(res.stats.accounts, (id) => this.isCodexAccount(id));
    const c = this.card('accounts', tr('By account'), tr("Each account in its own color, with its share of the day's work time"));
    if (!cards.length) {
      c.body.append(h('p', { class: 'ui-day__muted', text: tr('No accounts with time on this day.') }));
      return c.el;
    }
    const grid = h('div', { class: 'ui-day__accounts' });
    for (const a of cards) {
      const chip = h('span', { class: 'ui-acc-chip ui-acc-chip--md', text: a.short, attrs: { 'aria-hidden': 'true', ...(a.codex ? { 'data-provider': 'codex' } : {}) } });
      setStyleVar(chip, '--acc', a.color);
      const meter = h(
        'span',
        { class: 'ui-day__meter', role: 'img', attrs: { 'aria-label': a.shareText } },
        h('span', { class: 'ui-day__meter-fill', style: `width:${a.share}%` }),
      );
      const stat = (label: string, value: string) => [h('dt', { text: label }), h('dd', { text: value })];
      const card = h(
        'article',
        { class: 'ui-day__account', attrs: { 'aria-label': a.name } },
        h('div', { class: 'ui-day__account-head' }, chip, h('strong', { class: 'ui-day__account-name', text: a.name }), h('span', { class: 'ui-day__muted', text: a.sessions })),
        meter,
        h('p', { class: 'ui-day__kpi-sub', text: a.shareText }),
        h(
          'dl',
          { class: 'ui-day__account-stats' },
          ...stat(tr('Working'), a.working),
          ...stat(tr('Waiting on you'), a.waiting),
          ...stat('Tokens', a.tokens),
          // Codex: does not record cost, tokens only.
          ...(a.cost !== null ? stat(tr('Cost'), a.cost) : [h('dt', { text: tr('Cost') }), h('dd', { text: tr('tokens only'), title: tr("Codex doesn't record cost, only tokens") })]),
        ),
      );
      setStyleVar(card, '--acc', a.color);
      grid.append(card);
    }
    c.body.append(grid);
    return c.el;
  }

  /** Codex account: indicated by snapshot, or by id format for departed accounts (".codex"). */
  private isCodexAccount(id: string): boolean {
    return accountProvider(this.ctx.account(id), id) === 'codex';
  }

  // ---------------------------------------------------------------- tooltip (hover and focus)

  private bindTip(el: HTMLElement, title: () => string, rows: () => TipRow[], anchor: () => Element = () => el): void {
    const show = (hl?: TimedStatus) => this.showTip(anchor(), title(), rows(), hl);
    el.addEventListener('pointerenter', (e) => show(statusOf(e.target)));
    el.addEventListener('pointermove', (e) => show(statusOf(e.target)));
    el.addEventListener('pointerleave', () => this.hideTip());
    el.addEventListener('focus', () => show());
    el.addEventListener('blur', () => this.hideTip());
  }

  private showTip(anchor: Element, title: string, rows: TipRow[], hl?: TimedStatus): void {
    this.tip.replaceChildren(
      h('p', { class: 'ui-day__tip-title', text: title }),
      ...rows.map((r) =>
        h(
          'p',
          { class: `ui-day__tip-row${r.status && r.status === hl ? ' is-hl' : ''}${r.status ? '' : ' is-total'}` },
          h('span', { class: `ui-day__tip-key${r.status ? ` is-${r.status}` : ''}`, attrs: { 'aria-hidden': 'true' } }),
          h('strong', { text: r.value }),
          h('span', { text: r.label }),
        ),
      ),
    );
    this.tip.hidden = false;
    const box = this.el.getBoundingClientRect();
    const a = anchor.getBoundingClientRect();
    const tip = this.tip.getBoundingClientRect();
    const left = Math.min(Math.max(8, a.left - box.left + a.width / 2 - tip.width / 2), box.width - tip.width - 8);
    let top = a.top - box.top - tip.height - 8;
    if (top < 8) top = a.bottom - box.top + 8;
    this.tip.style.left = `${Math.round(left)}px`;
    this.tip.style.top = `${Math.round(top)}px`;
  }

  private hideTip(): void {
    this.tip.hidden = true;
  }
}

function statusOf(target: EventTarget | null): TimedStatus | undefined {
  const s = target instanceof HTMLElement ? target.dataset.status : undefined;
  return s && (TIMED_STATUSES as readonly string[]).includes(s) ? (s as TimedStatus) : undefined;
}
