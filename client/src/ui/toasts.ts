// Quick notices (toasts) in the bottom-right corner of the free area (above the feed, left of the drawer).
import type { Notice, NoticeLevel } from '../../../shared/types';
import { createAvatar } from './avatar';
import type { UiComponent, UiContext } from './context';
import { h, iconButton, prefersReducedMotion, setHidden, setText } from './dom';
import { ICONS } from './icons';
import { focusPermission } from './permission';
import { tr } from '../../../shared/i18n';

const MAX_VISIBLE = 4;
/** Identical notices within this window are merged into one (with counter). */
const DEDUPE_MS = 20_000;
const LIFETIME: Record<NoticeLevel, number> = { info: 5_000, success: 6_000, warn: 9_000, alert: Infinity };

/** A notice from the page itself: `open` replaces "show in the office", `sticky` stays until dismissed. */
export type PageNotice = Notice & { open?: () => void; sticky?: boolean };

interface Toast {
  key: string;
  notice: Notice;
  el: HTMLElement;
  count: HTMLElement;
  /** "Reply" (alerts for agents with a permission request to answer from the office). */
  answer?: HTMLButtonElement;
  repeats: number;
  timer: ReturnType<typeof setTimeout> | null;
  remaining: number;
  startedAt: number;
}

export class Toasts implements UiComponent {
  readonly el: HTMLElement;
  private toasts: Toast[] = [];

  constructor(private ctx: UiContext) {
    this.el = h('div', { class: 'ui-toasts', attrs: { 'aria-live': 'polite', 'aria-relevant': 'additions', 'aria-label': tr('Alerts') } });
    ctx.store.on('notice', (n) => this.push(n));
  }

  push(n: PageNotice): void {
    // Accounts hidden in sidebar filter do not generate notices, except "needs you" (requires action).
    if (n.level !== 'alert' && n.agentId) {
      const acc = this.ctx.agent(n.agentId)?.account;
      if (acc && this.ctx.prefs.hiddenAccounts.includes(acc)) return;
    }
    const key = `${n.level}|${n.agentId ?? ''}|${n.text}`;
    const dup = this.toasts.find((t) => t.key === key && n.at - t.notice.at < DEDUPE_MS);
    if (dup) {
      dup.repeats++;
      dup.notice = n;
      setText(dup.count, `×${dup.repeats}`);
      setHidden(dup.count, false);
      dup.el.classList.remove('is-bump');
      void dup.el.offsetWidth;
      dup.el.classList.add('is-bump');
      this.arm(dup, n.sticky ? Infinity : LIFETIME[n.level]);
      return;
    }
    // A new alert from the same agent replaces the previous one.
    if (n.level === 'alert' && n.agentId) this.toasts.filter((t) => t.notice.level === 'alert' && t.notice.agentId === n.agentId).forEach((t) => this.dismiss(t));

    const toast = this.create(n, key);
    this.toasts.push(toast);
    this.el.prepend(toast.el);
    this.arm(toast, n.sticky ? Infinity : LIFETIME[n.level]);
    while (this.toasts.length > MAX_VISIBLE) {
      const victim = this.toasts.find((t) => t.notice.level !== 'alert') ?? this.toasts[0];
      this.dismiss(victim);
    }
  }

  /** Alerts disappear when the agent stops waiting (or leaves the office). */
  render(): void {
    for (const t of [...this.toasts]) {
      if (t.notice.level !== 'alert' || !t.notice.agentId) continue;
      const a = this.ctx.agent(t.notice.agentId);
      if (!a || a.status !== 'waiting') this.dismiss(t);
      // The request may arrive (via hook) after the notice: shortcut appears when it exists.
      else if (t.answer) setHidden(t.answer, !a.permission);
    }
  }

  private create(n: PageNotice, key: string): Toast {
    const agent = n.agentId ? this.ctx.agent(n.agentId) : undefined;
    const count = h('span', { class: 'ui-toast__count', hidden: true });
    const body = h(
      'button',
      { class: 'ui-toast__body', type: 'button', title: !n.open && (n.agentId || n.roomId) ? tr('Show in the office') : '' },
      agent ? createAvatar(agent, 'xs') : null,
      h('span', { class: 'ui-toast__text', text: n.text }),
      count,
    );
    body.addEventListener('click', () => {
      if (n.open) n.open();
      else if (n.agentId && this.ctx.agent(n.agentId)) this.ctx.select({ type: 'agent', id: n.agentId }, { focus: true });
      else if (n.roomId && this.ctx.store.room(n.roomId)) this.ctx.select({ type: 'room', id: n.roomId }, { focus: true });
    });
    const el = h('div', { class: `ui-toast ui-toast--${n.level}`, role: n.level === 'alert' ? 'alert' : 'status' }, body);
    const toast: Toast = { key, notice: n, el, count, repeats: 1, timer: null, remaining: 0, startedAt: 0 };
    if (n.level === 'alert' && n.agentId) {
      const id = n.agentId;
      toast.answer = h('button', { class: 'ui-toast__answer', type: 'button', text: tr('Reply'), title: tr('Respond from the office (approve, deny, or answer the question)'), hidden: !agent?.permission, on: { click: () => focusPermission(this.ctx, id) } });
      el.append(toast.answer);
    }
    el.append(iconButton(ICONS.close, tr('Dismiss notice'), () => this.dismiss(toast), 'ui-icon-btn--sm ui-toast__close'));
    // Pauses lifetime on mouse hover.
    el.addEventListener('mouseenter', () => this.pause(toast));
    el.addEventListener('mouseleave', () => this.arm(toast, toast.remaining));
    return toast;
  }

  private arm(t: Toast, ms: number): void {
    if (t.timer) clearTimeout(t.timer);
    t.timer = null;
    t.remaining = ms;
    if (!Number.isFinite(ms)) return;
    t.startedAt = Date.now();
    t.timer = setTimeout(() => this.dismiss(t), ms);
  }

  private pause(t: Toast): void {
    if (!t.timer) return;
    clearTimeout(t.timer);
    t.timer = null;
    t.remaining = Math.max(1_500, t.remaining - (Date.now() - t.startedAt));
  }

  private dismiss(t: Toast): void {
    const i = this.toasts.indexOf(t);
    if (i < 0) return;
    this.toasts.splice(i, 1);
    if (t.timer) clearTimeout(t.timer);
    t.el.classList.add('is-leaving');
    const done = () => t.el.remove();
    if (typeof t.el.animate !== 'function' || prefersReducedMotion()) return done();
    const anim = t.el.animate(
      [
        { opacity: 1, transform: 'translateX(0)', height: `${t.el.offsetHeight}px` },
        { opacity: 0, transform: 'translateX(24px)', height: `${t.el.offsetHeight}px`, offset: 0.6 },
        { opacity: 0, transform: 'translateX(24px)', height: '0px', marginBottom: '0px' },
      ],
      { duration: 280, easing: 'cubic-bezier(.4,0,.2,1)', fill: 'forwards' },
    );
    anim.onfinish = done;
  }
}
