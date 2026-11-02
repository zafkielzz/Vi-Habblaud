// The Board (toolbar button, shortcut B): one window, two lists and a line of news, no new objects in the office.
// - 👑 The boss's to-do list: the "next steps" of the HANDOFF*.md in the office's folder (RoomInfo.plan, or
//   OfficeInfo.plan while nobody works there; an office without a folder: its boss's). You can tick items, add and
//   remove them; the server edits that file in place (POST /api/board/todo, server/board.ts), so the
//   boss reads the same list. A folder without one gets "Start a to-do list" (it writes the section).
// - 🧑‍🔧 The workers' jobs (RoomInfo.board of the workers room): who does what, and how it went (✓ done). 20 shown,
//   "View more" for the rest (the server keeps 50). Jobs run in a worker's terminal (item.job) can be cancelled;
//   "Cancel all" sits on top (ui/workers-api.ts).
// - 📰 Important news only, by fixed rules (no tokens): failed jobs and quota hits today, and who needs you now.
// The button's number counts the jobs in progress.
// Several offices: the list and the jobs are those of the office shown (the office tabs).
import type { JobBoard, JobBoardItem, NewsItem, OfficeInfo, TeamInfo, WorkerJob } from '../../../shared/types';
import type { UiContext } from './context';
import { bossPlan, boardRoom, hasBoard, importantNews, officeItems, type BoardTab } from './board-model';
import { teamOffices, type TodoList } from './offices';
import { h, iconButton, setHidden, setText } from './dom';
import { formatClock, relativeTime } from './format';
import { postPty } from './ptyapi';
import { ICONS } from './icons';
import { cancelJobs, jobOpen } from './workers-api';
import { tr } from '../../../shared/i18n';

const STATUS_ICON: Record<JobBoardItem['status'], string> = { working: '⏳', done: '✓', failed: '⚠️', cancelled: '🚫' };
/** Jobs shown before "View more". */
export const JOBS_SHOWN = 20;

function byLabel(by: JobBoardItem['by']): string {
  return by === 'boss' ? tr('👑 boss') : by === 'you' ? tr('🙋 you') : tr('⚙️ script');
}

function tokens(n: number): string {
  return n < 1_000 ? String(n) : n < 1_000_000 ? `${(n / 1_000).toFixed(1).replace(/\.0$/, '')}k` : `${(n / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`;
}

export class JobBoardDialog {
  readonly el: HTMLDialogElement;
  private roomId = '';
  private readonly jobList: HTMLElement;
  /** "Cancel all" and "Release" for the workers you drive. */
  private readonly jobTools: HTMLElement;
  private readonly jobStatus: HTMLElement;
  private readonly jobMore: HTMLButtonElement;
  private showAll = false;
  private busy = false;
  private readonly jobEmpty: HTMLElement;
  /** The boss's to-do list: title, items, add box, status line. */
  private readonly todoTitle: HTMLElement;
  private readonly todoList: HTMLElement;
  private readonly todoAdd: HTMLFormElement;
  private readonly todoInput: HTMLInputElement;
  private readonly todoStatus: HTMLElement;
  private readonly todoEmpty: HTMLElement;
  private readonly news: HTMLElement;
  private sig = '';
  /** Toolbar button: shown while there is something on the Board. */
  readonly button: HTMLButtonElement;
  private readonly count: HTMLElement;
  private readonly titleEl: HTMLElement;
  /** Opens the folder dialog of an office without one (ui/office-tabs.ts; set by ui/index.ts). */
  onDeclareFolder?: (officeId: string) => void;

  constructor(private ctx: UiContext) {
    this.count = h('span', { class: 'ui-btn-board__count' });
    this.button = iconButton(ICONS.board, tr('Board (B)'), () => this.toggle(), 'ui-btn-board');
    this.button.setAttribute('aria-haspopup', 'dialog');
    this.button.append(this.count);
    this.button.hidden = true;
    const title = (this.titleEl = h('h2', { attrs: { id: 'ui-board-title' }, text: tr('📋 Board') }));
    const close = iconButton(ICONS.close, tr('Close (Esc)'), () => this.close(), 'ui-icon-btn--sm');

    this.todoTitle = h('div', { class: 'ui-board__label' });
    this.todoList = h('ol', { class: 'ui-board__todo ui-board__checklist' });
    this.todoEmpty = h('div', { class: 'ui-board__empty' });
    this.todoInput = h('input', { class: 'ui-board__add-input', type: 'text', attrs: { placeholder: tr('Add a task…'), maxlength: 300, 'aria-label': tr('New task') } });
    this.todoAdd = h(
      'form',
      {
        class: 'ui-board__add',
        on: {
          submit: (e: Event) => {
            e.preventDefault();
            const text = this.todoInput.value.trim();
            if (text) void this.editTodo({ op: 'add', text }).then((ok) => ok && (this.todoInput.value = ''));
          },
        },
      },
      this.todoInput,
      h('button', { class: 'ui-btn ui-btn--sm', type: 'submit', text: tr('＋ Add') }),
    );
    this.todoStatus = h('p', { class: 'ui-board__meta ui-muted', role: 'status', hidden: true });
    const todoCol = h(
      'section',
      { class: 'ui-board__col', attrs: { 'data-hint': tr("The boss's to-do list: the next steps in the HANDOFF file of its folder. Tick, add or remove: the file is edited, and the boss reads the same list") } },
      h('h3', { class: 'ui-board__col-title', text: tr("👑 The boss's to-do list") }),
      this.todoTitle,
      this.todoList,
      this.todoEmpty,
      this.todoAdd,
      this.todoStatus,
    );

    this.jobList = h('ol', { class: 'ui-board__list' });
    this.jobTools = h('div', { class: 'ui-board__tools', hidden: true });
    this.jobStatus = h('p', { class: 'ui-board__meta ui-muted', role: 'status', hidden: true });
    this.jobEmpty = h('p', { class: 'ui-muted', text: tr('No jobs yet. When the boss (or you) sends one, it shows up here.') });
    this.jobMore = h('button', {
      class: 'ui-btn ui-btn--sm ui-board__more',
      type: 'button',
      on: {
        click: () => {
          this.showAll = !this.showAll;
          this.sig = '';
          this.render();
        },
      },
    });
    const jobsCol = h(
      'section',
      { class: 'ui-board__col', attrs: { 'data-hint': tr('Jobs given to the workers: who does what, and how it went') } },
      h('h3', { class: 'ui-board__col-title', text: tr("🧑‍🔧 The workers' jobs") }),
      this.jobTools,
      this.jobStatus,
      this.jobList,
      this.jobEmpty,
      this.jobMore,
    );
    this.news = h('div', { class: 'ui-board__news', attrs: { 'data-hint': tr('Important news only: failed jobs and quota hits today, and who needs you now') } });
    this.el = h(
      'dialog',
      { class: 'ui-dialog ui-board', attrs: { 'aria-labelledby': 'ui-board-title' } },
      h('div', { class: 'ui-dialog__head' }, title, close),
      h('div', { class: 'ui-board__body' }, h('div', { class: 'ui-board__cols' }, todoCol, jobsCol), this.news),
    ) as HTMLDialogElement;
    this.el.addEventListener('click', (e) => {
      if (e.target === this.el) this.close();
    });
    this.el.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.ctrlKey || e.metaKey || e.altKey || (e.target as HTMLElement).closest('input, textarea')) return;
      if (e.key === 'b' || e.key === 'B') {
        e.preventDefault();
        this.close();
      }
    });
  }

  get isOpen(): boolean {
    return this.el.open;
  }

  /** Opens the Board; `roomId` picks the job board (default: the first one). `_tab` is kept for old callers. */
  open(roomId?: string, _tab?: BoardTab): void {
    this.roomId = roomId ?? boardRoom(this.ctx.store.snapshot)?.id ?? '';
    this.sig = '';
    this.render();
    if (!this.el.open) this.el.showModal();
  }

  /** Clicking the board on the room wall: that room's jobs. */
  openJobs(roomId: string): void {
    this.open(roomId);
  }

  close(): void {
    if (this.el.open) this.el.close();
  }

  toggle(): void {
    if (this.el.open) this.close();
    else this.open();
  }

  /** Redraws with the current snapshot (called every frame while open). */
  render(): void {
    this.renderButton();
    if (!this.el.open && this.sig) return;
    const snap = this.ctx.store.snapshot;
    const room = snap?.rooms.find((r) => r.id === this.roomId) ?? boardRoom(snap);
    const office = this.ctx.selectedOffice();
    const raw = room?.board ?? { items: [] };
    const board: JobBoard = { ...raw, items: officeItems(raw.items, office) };
    const todo = bossPlan(snap, office);
    const now = this.ctx.now();
    const team = snap?.team;
    const news = importantNews(snap, now);
    const sig = JSON.stringify([board, team?.jobs?.map((j) => [j.id, j.status, j.answer, j.error]), this.busy, this.showAll, todo, news, office, Math.floor(now / 10_000)]);
    if (sig === this.sig) return;
    this.sig = sig;
    const many = teamOffices(team).length > 1;
    setText(this.titleEl, many && office ? tr('📋 Board · {0}', [office.name]) : tr('📋 Board'));
    this.renderJobs(board, team, now);
    this.renderTodo(todo, office);
    this.renderNews(news, now);
  }

  private renderJobs(board: JobBoard, team: TeamInfo | undefined, now: number): void {
    this.renderTools(board, team);
    // A terminal job's final answer (or its error), from the team's recent jobs.
    const jobs = new Map((team?.jobs ?? []).map((j) => [j.id, j]));
    const local = !!this.ctx.store.snapshot?.meta.terminal && !this.ctx.store.mock;
    setHidden(this.jobEmpty, board.items.length > 0);
    const shown = this.showAll ? board.items : board.items.slice(0, JOBS_SHOWN);
    setHidden(this.jobMore, board.items.length <= JOBS_SHOWN);
    setText(this.jobMore, this.showAll ? tr('Show less') : tr('View more ({0})', [board.items.length - JOBS_SHOWN]));
    this.jobList.replaceChildren(
      ...shown.map((it) => {
        const meta = [byLabel(it.by), relativeTime(it.at, now), it.tokens ? tr('{0} tokens', [tokens(it.tokens)]) : ''].filter(Boolean).join(' · ');
        return h(
          'li',
          { class: `ui-board__item is-${it.status}` },
          h('span', { class: 'ui-board__status', text: STATUS_ICON[it.status], attrs: { 'aria-label': it.status } }),
          h(
            'div',
            { class: 'ui-board__main' },
            h('div', { class: 'ui-board__who' }, h('strong', { text: it.worker }), it.role ? h('span', { class: 'ui-board__role', text: it.role }) : null),
            h('p', { class: 'ui-board__text', text: it.text }),
            ...this.answer(it.job ? jobs.get(it.job) : undefined),
            h('p', { class: 'ui-board__meta ui-muted', text: meta }),
          ),
          local && it.job && jobOpen(it.status) ? this.jobActions(it) : null,
        );
      }),
    );
  }

  /** "💬 answer" (or "⚠️ error") of a finished terminal job; the full text in the tooltip. */
  private answer(job: WorkerJob | undefined): HTMLElement[] {
    // (a cancelled job's "error" only repeats its 🚫)
    const text = job?.answer ?? (job?.status === 'cancelled' ? undefined : job?.error);
    if (!text) return [];
    return [h('p', { class: `ui-board__answer${job?.answer ? '' : ' is-error'}`, text: `${job?.answer ? '💬' : '⚠️'} ${text}`, title: text })];
  }

  /** A terminal job's button: cancel it. */
  private jobActions(it: JobBoardItem): HTMLElement {
    const box = h('div', { class: 'ui-board__actions' });
    box.append(this.actionButton(tr('Cancel'), tr('Cancels this job; the boss is told'), () => cancelJobs({ job: it.job! }).then(() => tr('Cancelled.'))));
    return box;
  }

  /** Top of the Jobs tab: "Cancel all" while terminal jobs run. */
  private renderTools(board: JobBoard, team: TeamInfo | undefined): void {
    const local = !!this.ctx.store.snapshot?.meta.terminal && !this.ctx.store.mock;
    const office = this.ctx.selectedOffice();
    const many = teamOffices(team).length > 1;
    const queued = officeItems(team?.jobs?.filter((j) => j.status === 'queued') ?? [], office);
    const openJobs = [...new Set([...board.items.filter((it) => it.job && jobOpen(it.status)).map((it) => it.job!), ...queued.map((j) => j.id)])];
    const open = openJobs.length;
    const tools: HTMLElement[] = [];
    if (local) {
      // (several offices: only this office's jobs, one by one)
      const cancel = many ? () => Promise.all(openJobs.map((job) => cancelJobs({ job }))).then((ns) => ns.reduce((a, b) => a + b, 0)) : () => cancelJobs({ all: true });
      if (open) tools.push(this.actionButton(tr('🚫 Cancel all ({0})', [open]), tr('Cancels every job running in the workers\' terminals'), () => cancel().then((n) => tr('Cancelled {0} jobs.', [n]))));
    }
    this.jobTools.replaceChildren(...tools);
    setHidden(this.jobTools, !tools.length);
  }

  private actionButton(text: string, title: string, act: () => Promise<string>): HTMLButtonElement {
    const b = h('button', {
      class: 'ui-btn ui-btn--sm',
      type: 'button',
      text,
      title,
      on: {
        click: () => {
          if (this.busy) return;
          this.busy = true;
          act()
            .then((msg) => this.say(msg))
            .catch((err: unknown) => this.say(tr("Didn't work: {0}", [err instanceof Error ? err.message : String(err)])))
            .finally(() => {
              this.busy = false;
              this.sig = '';
              this.render();
            });
        },
      },
    });
    b.disabled = this.busy;
    return b;
  }

  private say(text: string): void {
    setText(this.jobStatus, text);
    setHidden(this.jobStatus, false);
  }

  /** The boss's to-do list (its folder's HANDOFF file), editable from here when the page runs on this computer. */
  private renderTodo(todo: TodoList | undefined, office: OfficeInfo | undefined): void {
    const local = !this.ctx.store.mock && !!this.ctx.store.snapshot?.meta.terminal;
    const plan = todo?.plan;
    if (plan) {
      const done = plan.items.filter((i) => i.done).length;
      setText(this.todoTitle, tr('📄 {0} · {1} · {2}/{3} done', [plan.file, todo!.name, done, plan.items.length]));
    } else setText(this.todoTitle, todo ? tr('📁 {0}', [todo.name]) : '');
    setHidden(this.todoTitle, !todo);
    this.todoList.replaceChildren(
      ...(plan?.items ?? []).map((it, index) => {
        const box = h('input', { type: 'checkbox', attrs: { 'aria-label': it.text } });
        box.checked = !!it.done;
        box.disabled = !local || this.busy;
        box.addEventListener('change', () => void this.editTodo({ op: 'toggle', index, done: box.checked }));
        const del = h('button', {
          class: 'ui-icon-btn ui-icon-btn--sm ui-board__del',
          type: 'button',
          text: '🗑',
          title: tr('Remove this task from the list'),
          on: { click: () => window.confirm(tr('Remove "{0}" from the to-do list?', [it.text])) && void this.editTodo({ op: 'remove', index }) },
        });
        setHidden(del, !local);
        return h('li', { class: `ui-board__check${it.done ? ' is-done' : ''}` }, h('label', {}, box, h('span', { text: it.text })), del);
      }),
    );
    setHidden(this.todoAdd, !local || !plan);
    this.todoInput.disabled = this.busy;
    const offices = this.ctx.store.snapshot?.team?.offices;
    if (!todo && office && offices && !office.folder) {
      const pick = h('button', { class: 'ui-btn ui-btn--sm', type: 'button', text: tr('📁 Choose its folder'), on: { click: () => this.onDeclareFolder?.(office.id) } });
      pick.disabled = !local || !this.onDeclareFolder;
      this.todoEmpty.replaceChildren(h('p', { class: 'ui-muted', text: tr('{0} has no folder yet: its to-do list is the HANDOFF file of its folder.', [office.name]) }), pick);
    } else if (!todo) {
      this.todoEmpty.replaceChildren(h('p', { class: 'ui-muted', text: tr('No boss yet: appoint one (＋ Boss) and its folder\'s to-do list shows up here.') }));
    } else if (!plan) {
      const start = h('button', {
        class: 'ui-btn ui-btn--sm',
        type: 'button',
        text: tr('＋ Start a to-do list'),
        title: tr('Adds a "{0}" section to the HANDOFF file of {1} (creates HANDOFF.md if there is none)', [tr('Next steps'), todo.name]),
        on: { click: () => void this.editTodo({ op: 'create', heading: tr('Next steps') }) },
      });
      start.disabled = !local || this.busy;
      this.todoEmpty.replaceChildren(h('p', { class: 'ui-muted', text: tr('{0} has no to-do list yet (the next steps of a HANDOFF file).', [todo.name]) }), start);
    } else if (!plan.items.length) {
      this.todoEmpty.replaceChildren(h('p', { class: 'ui-muted', text: tr('The list is empty: add the first task below.') }));
    } else this.todoEmpty.replaceChildren();
    setHidden(this.todoEmpty, !this.todoEmpty.childElementCount);
  }

  /** Sends an edit of the boss's list; the server edits the file and the new list comes back in the snapshot. */
  private async editTodo(edit: Record<string, unknown>): Promise<boolean> {
    const todo = bossPlan(this.ctx.store.snapshot, this.ctx.selectedOffice());
    if (!todo || this.busy) return false;
    this.busy = true;
    try {
      await postPty('/api/board/todo', { ...todo.target, mtime: todo.plan?.mtime, edit });
      setHidden(this.todoStatus, true);
      return true;
    } catch (err) {
      setText(this.todoStatus, tr("Didn't work: {0}", [err instanceof Error ? err.message : String(err)]));
      setHidden(this.todoStatus, false);
      return false;
    } finally {
      this.busy = false;
      this.sig = '';
      this.render();
    }
  }

  /** Important news: failures and quota hits today, and who needs you now (fixed rules, no tokens). */
  private renderNews(news: Array<Pick<NewsItem, 'id' | 'at' | 'icon' | 'text'> & { detail?: string }>, now: number): void {
    setHidden(this.news, !news.length);
    this.news.replaceChildren(
      h('span', { class: 'ui-board__news-title', text: tr('📰 Important') }),
      ...news.map((n) => h('span', { class: 'ui-board__news-item', title: [n.detail, relativeTime(n.at, now)].filter(Boolean).join(' · ') }, h('time', { class: 'ui-muted', text: formatClock(n.at, false) }), ` ${n.icon} ${n.text}`)),
    );
  }

  private renderButton(): void {
    const snap = this.ctx.store.snapshot;
    const office = this.ctx.selectedOffice();
    setHidden(this.button, !hasBoard(snap, office));
    const working = officeItems(boardRoom(snap)?.board?.items ?? [], office).filter((it) => it.status === 'working').length;
    setText(this.count, working ? String(working) : '');
    setHidden(this.count, !working);
    const label = working ? tr('Board (B): {0} jobs in progress', [working]) : tr('Board (B)');
    if (this.button.title !== label) {
      this.button.title = label;
      this.button.setAttribute('aria-label', label);
    }
  }
}
