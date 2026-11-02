// Antigravity worker drawer, two parts:
// - "Defaults for jobs" (AgyDefaultsPanel, every worker): mode and effort for jobs that do not say, saved at once to
//   ~/.agy_profiles/defaults.json (POST /api/agy/defaults), which agy-ask reads. Claude passes both on its own jobs,
//   so its choice wins. No model choice: workers only run Gemini 3.8 Flash. What a running job really applied shows in
//   the drawer's Model / Effort / Permissions rows (read from the agy log).
// - "Send a job" (AgyPanel, every registered worker): prompt and role go to POST /api/agy/jobs, which
//   runs the account's `agy-ask` on the server with the worker's defaults. The role is remembered per worker in this
//   browser (localStorage 'habblaud:agy-presets'). "Stop" (POST /api/agy/stop) terminates what is running on it.
//   A worker with a terminal session (server/workers; Antigravity or Claude) gets the job in that terminal instead
//   (POST /api/workers/ask, a fresh conversation) and "Stop" cancels its jobs.
// - "Terminal" (WorkerTerminalPanel, a worker whose terminal is open): watch it (watch-only, ui/pty.ts)
//   (pick the conversation: the last job's, your own, or a new one; a running job pauses and the boss is told to ask
//   again later) and release it when done.
import type { AgentInfo, AgentStatus, WorkerJob, WorkerSession } from '../../../shared/types';
import type { UiContext } from './context';
import { h, setHidden, setText } from './dom';
import { segmented } from './settings';
import { officeForWorker } from './offices';
import { askWorker, cancelJobs } from './workers-api';
import { tr } from '../../../shared/i18n';

type Mode = 'plan' | 'default' | 'accept-edits';

const PRESETS_KEY = 'habblaud:agy-presets';
const EFFORTS = ['low', 'medium', 'high'] as const;

interface Preset {
  role: string;
}

function loadPresets(): Record<string, Preset> {
  try {
    const raw = JSON.parse(localStorage.getItem(PRESETS_KEY) ?? '{}') as unknown;
    return raw && typeof raw === 'object' ? (raw as Record<string, Preset>) : {};
  } catch {
    return {};
  }
}

function savePresets(p: Record<string, Preset>): void {
  try {
    localStorage.setItem(PRESETS_KEY, JSON.stringify(p));
  } catch {
    // no localStorage: preferences not remembered
  }
}

export class AgyPanel {
  readonly el: HTMLElement;
  private agentId = '';
  /** Worker id when it has a terminal session (jobs go to /api/workers). */
  private worker = '';
  private busy = false;
  private readonly box: HTMLTextAreaElement;
  private readonly role: HTMLInputElement;
  private readonly sendBtn: HTMLButtonElement;
  private readonly stopBtn: HTMLButtonElement;
  private readonly status: HTMLElement;
  /** Draft per worker (switching drawers preserves typed content). */
  private readonly drafts = new Map<string, string>();
  private presets = loadPresets();

  constructor(
    private ctx: UiContext,
  ) {
    this.box = h('textarea', {
      class: 'ui-msg__input',
      attrs: { id: 'ui-agy-prompt', rows: 3, maxlength: 20000, placeholder: tr('What should this worker do?') },
    });
    this.box.addEventListener('input', () => {
      this.drafts.set(this.agentId, this.box.value);
      this.sync();
    });
    this.role = h('input', {
      class: 'ui-msg__input ui-agy__role',
      attrs: { id: 'ui-agy-role', maxlength: 24, placeholder: tr('role (e.g. qa)'), autocomplete: 'off', 'aria-label': tr("Worker's role in this job") },
    });
    this.role.addEventListener('change', () => this.remember());
    this.sendBtn = h('button', { class: 'ui-btn ui-msg__send', type: 'button', text: tr('Send'), attrs: { 'data-hint': tr('Gives this worker the job written above (agy-ask)') }, on: { click: () => void this.send() } });
    this.stopBtn = h('button', { class: 'ui-btn', type: 'button', text: tr('Stop'), title: tr('Stop the job this worker is doing'), on: { click: () => void this.stop() } });
    this.status = h('p', { class: 'ui-msg__status', role: 'status', hidden: true, attrs: { 'aria-live': 'polite' } });
    this.el = h(
      'div',
      { class: 'ui-msg ui-msg--drawer ui-agy' },
      this.box,
      h('div', { class: 'ui-msg__row ui-agy__row' }, this.role, this.sendBtn, this.stopBtn),
      this.status,
    );
  }

  render(agentId: string, status: AgentStatus, worker?: string): void {
    this.worker = worker ?? '';
    if (agentId !== this.agentId) {
      this.agentId = agentId;
      this.box.value = this.drafts.get(agentId) ?? '';
      setHidden(this.status, true);
      this.restore();
    }
    setHidden(this.stopBtn, status !== 'working');
    this.sync();
  }

  /** Previous role for this worker. */
  private restore(): void {
    this.role.value = this.presets[this.agentId]?.role ?? '';
  }

  private remember(): void {
    if (!this.agentId) return;
    this.presets[this.agentId] = { role: this.role.value.trim() };
    savePresets(this.presets);
  }

  private sync(): void {
    this.sendBtn.disabled = this.busy || !this.box.value.trim();
    this.stopBtn.disabled = this.busy;
  }

  private say(text: string, error = false): void {
    setText(this.status, text);
    this.status.classList.toggle('is-error', error);
    setHidden(this.status, false);
  }

  private async send(): Promise<void> {
    const prompt = this.box.value.trim();
    if (!prompt || this.busy) return;
    this.busy = true;
    this.sync();
    try {
      this.remember();
      if (this.worker) {
        // The worker's "Defaults for jobs" (agy-ask applies them itself on the headless path; the terminal path does not).
        const d = this.ctx.agent(this.agentId)?.agyDefaults;
        await askWorker({ worker: this.worker, prompt, role: this.role.value.trim() || undefined, mode: d?.mode || undefined, effort: d?.effort || undefined, office: officeForWorker(this.ctx.selectedOffice(), this.worker) });
        this.drafts.delete(this.agentId);
        this.box.value = '';
        this.say(tr('Sent to its terminal. It starts a fresh conversation for this job.'));
        return;
      }
      const r = await this.ctx.store.agyRequest('jobs', {
        agentId: this.agentId,
        prompt,
        role: this.role.value.trim() || undefined,
      });
      if (r.error) this.say(r.error, true);
      else {
        this.drafts.delete(this.agentId);
        this.box.value = '';
        this.say(tr('Sent. The worker is heading to the desk.'));
      }
    } catch (err) {
      this.say(this.worker && err instanceof Error ? err.message : tr('No connection to Habblaud.'), true);
    } finally {
      this.busy = false;
      this.sync();
    }
  }

  private async stop(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    this.sync();
    try {
      if (this.worker) {
        const n = await cancelJobs({ worker: this.worker });
        this.say(n ? tr('Stopped.') : tr('Nothing running to stop.'));
        return;
      }
      const r = await this.ctx.store.agyRequest('stop', { agentId: this.agentId });
      this.say(r.error ?? (r.stopped ? tr('Stopped.') : tr('Nothing running to stop.')), !!r.error);
    } catch (err) {
      this.say(this.worker && err instanceof Error ? err.message : tr('No connection to Habblaud.'), true);
    } finally {
      this.busy = false;
      this.sync();
    }
  }
}

/** "Defaults for jobs": mode and effort a worker uses when a job does not say; each change is saved at once. */
export class AgyDefaultsPanel {
  readonly el: HTMLElement;
  private agentId = '';
  private readonly modes: ReturnType<typeof segmented<Mode>>;
  private readonly effort: HTMLSelectElement;
  private readonly status: HTMLElement;

  constructor(private ctx: UiContext) {
    this.modes = segmented<Mode>(
      tr('Mode'),
      [
        ['plan', tr('Read only')],
        ['default', tr('Default')],
        ['accept-edits', tr('Can edit')],
      ],
      (v) => {
        this.modes.set(v);
        void this.save({ mode: v });
      },
    );
    const label = tr('Reasoning effort');
    this.effort = h('select', { class: 'ui-msg__input ui-agy__select', attrs: { id: 'ui-agy-effort', 'aria-label': label, title: label } });
    this.effort.append(h('option', { text: tr('Effort: account default'), attrs: { value: '' } }));
    for (const e of EFFORTS) this.effort.append(h('option', { text: e, attrs: { value: e } }));
    this.effort.addEventListener('change', () => void this.save({ effort: this.effort.value }));
    this.status = h('p', { class: 'ui-msg__status', role: 'status', hidden: true, attrs: { 'aria-live': 'polite' } });
    this.el = h(
      'div',
      { class: 'ui-msg ui-msg--drawer ui-agy' },
      this.modes.row,
      h('div', { class: 'ui-msg__row ui-agy__row' }, this.effort),
      h('p', { class: 'ui-muted ui-small', text: tr('Used by jobs that do not say: jobs sent from here, and agy-ask calls without --mode/--effort. Claude picks its own for each job.') }),
      this.status,
    );
  }

  render(a: AgentInfo): void {
    if (a.id !== this.agentId) {
      this.agentId = a.id;
      setHidden(this.status, true);
    }
    // agy-ask's own default mode is plan.
    this.modes.set((a.agyDefaults?.mode as Mode | undefined) ?? 'plan');
    if (document.activeElement !== this.effort) this.effort.value = a.agyDefaults?.effort ?? '';
  }

  private async save(change: { mode?: string; effort?: string }): Promise<void> {
    const cur = this.ctx.agent(this.agentId)?.agyDefaults ?? {};
    const next = { ...cur, ...change };
    try {
      const r = await this.ctx.store.agyRequest('defaults', { agentId: this.agentId, mode: next.mode || undefined, effort: next.effort || undefined });
      setText(this.status, r.error ?? tr('Saved.'));
      this.status.classList.toggle('is-error', !!r.error);
    } catch {
      setText(this.status, tr('No connection to Habblaud.'));
      this.status.classList.add('is-error');
    }
    setHidden(this.status, false);
  }
}

/** "🖥 Terminal": what a worker is doing, and its terminal to read. Every job is a new conversation: nobody types there. */
export class WorkerTerminalPanel {
  readonly el: HTMLElement;
  private session: WorkerSession | null = null;
  private agentId = '';
  private readonly state: HTMLElement;

  constructor(private ctx: UiContext) {
    this.state = h('p', { class: 'ui-workerterm__state' });
    const watch = h('button', {
      class: 'ui-btn',
      type: 'button',
      text: tr('👁 Watch its terminal'),
      attrs: { 'data-hint': tr('Shows what the worker is doing; its terminal is read-only') },
      on: { click: () => this.open() },
    });
    this.el = h('div', { class: 'ui-workerterm' }, this.state, h('div', { class: 'ui-workerterm__row' }, watch));
  }

  render(agent: AgentInfo, session: WorkerSession, job: WorkerJob | undefined): void {
    this.agentId = agent.id;
    this.session = session;
    setText(this.state, job && (job.status === 'working' || job.status === 'queued') ? tr('⏳ Working on a job: “{0}”', [job.prompt]) : tr('Free: the boss can give it jobs.'));
  }

  private open(): void {
    const s = this.session;
    if (!s) return;
    const pty = this.ctx.store.snapshot?.ptys?.find((p) => p.id === s.ptyId && p.exitedAt === undefined);
    if (pty && this.ctx.terminals?.showPty) this.ctx.terminals.showPty(pty);
    // the character shown here (a worker has one per office; its one terminal follows the office it works for)
    else this.ctx.terminals?.open(this.agentId || s.agentId);
  }
}
