// Floating tooltip for character under cursor: tracks the character frame by frame.
import type { UiComponent, UiContext } from './context';
import { h, setHidden, setText, setVariant } from './dom';
import { formatDuration } from './format';
import { shellStage, shellWaitIn, statusLabel } from './model';
import { providerOf } from './provider';
import {
  createAccountChip,
  createActivityLine,
  createProviderTag,
  createStatusDot,
  updateAccountChip,
  updateActivityLine,
  updateProviderTag,
  updateShellActivityLine,
  updateStatusDot,
} from './widgets';
import { tr } from '../../../shared/i18n';

export class HoverTip implements UiComponent {
  readonly el: HTMLElement;
  private id: string | null = null;
  private raf = 0;
  private name: HTMLElement;
  private chip: HTMLElement;
  private prov: HTMLElement;
  private dot: HTMLElement;
  private status: HTMLElement;
  private activity: HTMLElement;
  private mood: HTMLElement;
  private task: HTMLElement;
  private since: HTMLElement;

  constructor(private ctx: UiContext) {
    this.name = h('strong', { class: 'ui-tip__name' });
    this.chip = createAccountChip('sm');
    this.prov = createProviderTag('ui-prov--xs');
    this.dot = createStatusDot();
    this.status = h('span', { class: 'ui-tip__status' });
    this.activity = createActivityLine();
    this.mood = h('div', { class: 'ui-tip__mood', hidden: true });
    this.task = h('div', { class: 'ui-tip__task', hidden: true });
    this.since = h('span', { class: 'ui-tip__since' });
    this.el = h(
      'div',
      { class: 'ui-tip', attrs: { 'aria-hidden': 'true' } },
      h('div', { class: 'ui-tip__top' }, this.name, this.chip, this.prov),
      this.task,
      h('div', { class: 'ui-tip__line' }, this.dot, this.status, this.since),
      this.activity,
      this.mood,
    );
    ctx.world.onHover((id) => this.setTarget(id));
  }

  private setTarget(id: string | null): void {
    if (id === this.id) return;
    this.id = id;
    this.el.classList.toggle('is-visible', !!id);
    cancelAnimationFrame(this.raf);
    if (id) {
      this.render();
      this.follow();
    }
  }

  /** Repositions every frame as long as someone is under the cursor. */
  private follow = (): void => {
    if (!this.id) return;
    const p = this.ctx.world.screenPositionOf(this.id);
    if (!p) {
      this.el.classList.remove('is-visible');
    } else {
      this.el.classList.add('is-visible');
      const w = this.el.offsetWidth;
      const hgt = this.el.offsetHeight;
      const x = Math.round(Math.min(innerWidth - w - 8, Math.max(8, p.x - w / 2)));
      const below = p.y - hgt - 10 < 72;
      const y = Math.round(below ? p.y + 46 : p.y - hgt - 10);
      this.el.style.transform = `translate3d(${x}px, ${y}px, 0)`;
    }
    this.raf = requestAnimationFrame(this.follow);
  };

  render(): void {
    if (!this.id) return;
    const a = this.ctx.agent(this.id);
    if (!a) {
      this.setTarget(null);
      return;
    }
    setText(this.name, a.name);
    updateAccountChip(this.chip, this.ctx.account(a.account), a.account, a.provider);
    updateProviderTag(this.prov, providerOf(a));
    // Waiting on a shell: what it waits on (with elapsed time) and what it's doing meanwhile.
    const now = this.ctx.now();
    const wait = shellWaitIn(a, this.ctx.store.snapshot?.agents ?? [], now);
    const status = wait ? 'shell' : a.status;
    updateStatusDot(this.dot, status);
    setText(this.status, a.status === 'waiting' && a.waitingFor ? `${statusLabel(a.status)}: ${a.waitingFor}` : `${statusLabel(status)}${a.kind === 'sub' ? ` · ${a.role}` : ''}`);
    setVariant(this.el, 'is-', status);
    // What the session is about (title) and how long in this state (e.g. idle for 12 min).
    const title = a.title?.trim();
    setHidden(this.task, !title);
    if (title) setText(this.task, title);
    const inStatus = now - a.statusSince;
    setText(this.since, a.statusSince && inStatus >= 60_000 ? tr('{0} ago', [formatDuration(inStatus)]) : '');
    if (wait) updateShellActivityLine(this.activity, wait, now);
    else updateActivityLine(this.activity, a.activity);
    setHidden(this.mood, !wait);
    if (wait) {
      const stage = shellStage(now - wait.since);
      setText(this.mood, `${stage.emoji} ${stage.text}`);
    }
  }
}
