// Lightweight social Habblaud World in the office (Phase 5):
// - "While you were away": who stopped by the building while the owner was away (visits, likes, and stamps
//   left at the front desk, without identities). Appears in the "Your building" card (Habblaud World window) and, upon connecting,
//   in a floating card in the office corner; closing or "Got it" sends `summary.seen` (POST /api/world/summary/seen).
// - Building code ("HB-4F2K"), to send to a friend, with "Copy".
// - Door knocks: with "Notify when someone knocks on the door" enabled, an alert "Someone knocked on your building's door" (no
//   name) when `meta.world.building.knocks` increases.
// Only on the local computer (same guards as World section) and never during timelapse. Models are pure (tested).
import { intlLocale, tr } from '../../../../shared/i18n';
import type { Notice } from '../../../../shared/types';
import type { AwaySummary } from '../../../../shared/world/protocol';
import { stampIcon, stampLabel } from '../../../../shared/world/social-labels';
import type { WorldBuildingStatus, WorldClient, WorldSource } from '../../net/world';
import type { UiComponent, UiContext } from '../context';
import { copyText, h, prefersReducedMotion, setHidden, setText } from '../dom';
import { worldErrorText } from './world-model';
import './social.css';

// ------------------------------------------------------------------ models (pure)

export interface AwaySummaryView {
  /** "since October 14" (the day the owner saw the last summary). */
  since: string;
  stats: Array<{ key: 'visits' | 'likes' | 'stamps'; icon: string; value: string; label: string }>;
  stamps: Array<{ id: string; icon: string; label: string; count: number }>;
  /** A sentence for screen readers and the notice. */
  sentence: string;
}

/** "2026-10-14" → "October 14" (UTC day, displayed as calendar day). */
export function dayLabel(day: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  if (!m) return '';
  try {
    return new Intl.DateTimeFormat(intlLocale(), { day: 'numeric', month: 'long', timeZone: 'UTC' }).format(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  } catch {
    return `${m[3]}/${m[2]}`;
  }
}

const n = (v: number) => v.toLocaleString(intlLocale());

/** What the card displays for a summary: the three counts, stamps (most received first), and the sentence. */
export function awaySummaryView(s: AwaySummary): AwaySummaryView {
  const stampsTotal = s.stamps.reduce((t, x) => t + x.count, 0);
  const since = dayLabel(s.since);
  const visits = s.visits === 1 ? tr('1 visit') : tr('{0} visits', [n(s.visits)]);
  const likes = s.likes === 1 ? tr('1 like') : tr('{0} likes', [n(s.likes)]);
  const stamps = stampsTotal === 1 ? tr('1 stamp') : tr('{0} stamps', [n(stampsTotal)]);
  return {
    since: since ? tr('since {0}', [since]) : '',
    stats: [
      { key: 'visits', icon: '🚶', value: n(s.visits), label: s.visits === 1 ? tr('visit') : tr('visits') },
      { key: 'likes', icon: '❤️', value: n(s.likes), label: s.likes === 1 ? tr('like') : tr('likes') },
      { key: 'stamps', icon: '📮', value: n(stampsTotal), label: stampsTotal === 1 ? tr('stamp') : tr('stamps') },
    ],
    stamps: [...s.stamps]
      .filter((x) => x.count > 0)
      .sort((a, b) => b.count - a.count)
      .map((x) => ({ id: x.stampId, icon: stampIcon(x.stampId), label: stampLabel(x.stampId), count: x.count })),
    sentence: tr('While you were away: {0}, {1} and {2}.', [visits, likes, stamps]),
  };
}

/** "❤️ 3 today" on topbar chip (null = none: no likes today or building is not active). */
export function likesTodayChip(state: string | null, likes: number | undefined): { text: string; title: string } | null {
  if (state !== 'live' || !likes || likes < 1) return null;
  return { text: tr('❤️ {0} today', [likes]), title: likes === 1 ? tr('Your building got 1 like today.') : tr('Your building got {0} likes today.', [likes]) };
}

/** Key for a summary (same summary does not appear twice in the corner). */
export function summaryKey(s: AwaySummary | undefined): string {
  return s ? `${s.since}|${s.visits}|${s.likes}|${s.stamps.map((x) => `${x.stampId}:${x.count}`).join(',')}` : '';
}

/**
 * New knocks since last check: `last` = what this page has seen (null = nothing seen yet: first read
 * only records without alerting, so an old knock does not become an alert upon opening the page).
 */
export function newKnocks(last: number | null, now: number | undefined): { last: number; fresh: number } {
  const cur = now ?? 0;
  if (last === null) return { last: cur, fresh: 0 };
  // Habblaud restarted (counter rolled back): record again
  if (cur < last) return { last: cur, fresh: 0 };
  return { last: cur, fresh: cur - last };
}

// ------------------------------------------------------------------ DOM: the summary (used in both places)

function summaryBody(v: AwaySummaryView, compact: boolean): HTMLElement {
  const stats = h(
    'ul',
    { class: 'ui-away__stats', attrs: { 'aria-label': v.sentence } },
    ...v.stats.map((s) => h('li', { class: `ui-away__stat is-${s.key}` }, h('span', { class: 'ui-away__icon', text: s.icon, attrs: { 'aria-hidden': 'true' } }), h('b', { text: s.value }), h('span', { text: s.label }))),
  );
  const wall = v.stamps.length
    ? h(
        'ul',
        { class: 'ui-away__stamps', attrs: { 'aria-label': tr('Stamps at the front desk') } },
        ...v.stamps.map((st, i) =>
          h(
            'li',
            { class: 'ui-away__stamp', title: st.label, style: `--i:${i};--r:${((i * 37) % 11) - 5}deg` },
            h('span', { class: 'ui-away__stamp-icon', text: st.icon, attrs: { 'aria-hidden': 'true' } }),
            compact ? null : h('span', { class: 'ui-away__stamp-label', text: st.label }),
            st.count > 1 ? h('span', { class: 'ui-away__stamp-count', text: `×${st.count}` }) : null,
          ),
        ),
      )
    : null;
  return h('div', { class: 'ui-away__body' }, stats, wall);
}

// ------------------------------------------------------------------ inside "Your building"

export interface BuildingSocialHost {
  readonly client: WorldClient | null;
  building(): WorldBuildingStatus | undefined;
  /** Re-reads status (after "Got it"). */
  refresh(): void;
}

/** Building code and "While you were away", in "Your building" card (updated in place). */
export class BuildingSocial {
  readonly el: HTMLElement;
  private readonly codeRow: HTMLElement;
  private readonly code: HTMLElement;
  private readonly copyBtn: HTMLButtonElement;
  private readonly summary: HTMLElement;
  private readonly summaryBody: HTMLElement;
  private readonly since: HTMLElement;
  private readonly seenBtn: HTMLButtonElement;
  private readonly error: HTMLElement;
  private key = '';
  private busy = false;

  constructor(private readonly host: BuildingSocialHost) {
    this.code = h('code', { class: 'ui-away__code' });
    this.copyBtn = h('button', { class: 'ui-btn ui-btn--sm', type: 'button', text: tr('Copy'), on: { click: () => void this.copy() } });
    this.codeRow = h(
      'div',
      { class: 'ui-away__coderow', hidden: true },
      h('span', { class: 'ui-away__codelabel', text: tr('Building code') }),
      this.code,
      this.copyBtn,
      h('span', { class: 'ui-set__hint ui-away__codehint', text: tr('Send it to a friend: in the city, "Go to" takes them straight to your door.') }),
    );
    this.since = h('span', { class: 'ui-away__since' });
    this.summaryBody = h('div');
    this.seenBtn = h('button', { class: 'ui-btn ui-btn--sm ui-btn--primary', type: 'button', text: tr('Got it'), on: { click: () => void this.seen() } });
    this.error = h('p', { class: 'ui-world__error', role: 'alert', hidden: true });
    this.summary = h(
      'section',
      { class: 'ui-away ui-away--inline', hidden: true, attrs: { 'aria-label': tr('While you were away') } },
      h('div', { class: 'ui-away__head' }, h('span', { class: 'ui-away__badge', text: '📬', attrs: { 'aria-hidden': 'true' } }), h('div', { class: 'ui-away__titles' }, h('strong', { class: 'ui-away__title', text: tr('While you were away') }), this.since)),
      this.summaryBody,
      h('div', { class: 'ui-away__actions' }, this.seenBtn),
      this.error,
    );
    this.el = h('div', { class: 'ui-away__wrap' }, this.summary, this.codeRow);
    this.sync();
  }

  sync(): void {
    const b = this.host.building();
    setHidden(this.codeRow, !b?.code);
    setText(this.code, b?.code ?? '');
    const s = b?.summary;
    const key = summaryKey(s);
    if (key !== this.key) {
      this.key = key;
      if (s) {
        const v = awaySummaryView(s);
        setText(this.since, v.since);
        this.summaryBody.replaceChildren(summaryBody(v, false));
      }
      setHidden(this.error, true);
    }
    setHidden(this.summary, !s);
  }

  private async copy(): Promise<void> {
    const code = this.host.building()?.code;
    if (!code) return;
    const ok = await copyText(code);
    setText(this.copyBtn, ok ? tr('Copied') : tr('Copy'));
    setTimeout(() => setText(this.copyBtn, tr('Copy')), 1600);
  }

  private async seen(): Promise<void> {
    const client = this.host.client;
    if (!client || this.busy) return;
    this.busy = true;
    this.seenBtn.disabled = true;
    const r = await client.summarySeen();
    this.busy = false;
    this.seenBtn.disabled = false;
    if (!r.ok) {
      setText(this.error, worldErrorText(r.code, 'summary'));
      setHidden(this.error, false);
      return;
    }
    setHidden(this.summary, true);
    this.host.refresh();
  }
}

// ------------------------------------------------------------------ in office: connect card and knocks

export interface WorldSocialHooks {
  /** World section is active on this page (local computer, guards) and account is approved. */
  active(): boolean;
  /** Quick notice (office toasts). */
  toast(n: Notice): void;
  /** Opens Habblaud World window (where the "Your building" card is). */
  openWorld(): void;
}

/**
 * "While you were away" upon connecting (card in office corner, until "Got it" or close) and notice for
 * each door knock. Reads only meta (likes, knocks, and whether summary exists) and requests status (local) to show summary.
 */
export class WorldSocialNotifier implements UiComponent {
  readonly el: HTMLElement;
  private readonly since: HTMLElement;
  private readonly body: HTMLElement;
  private readonly error: HTMLElement;
  private readonly seenBtn: HTMLButtonElement;
  private knocksSeen: number | null = null;
  /** The summary in the card (or that this page already showed and the user dismissed). */
  private shownKey = '';
  private dismissedKey = '';
  private loading = false;
  private busy = false;

  constructor(
    private readonly ctx: UiContext,
    private readonly src: WorldSource,
    private readonly hooks: WorldSocialHooks,
  ) {
    const titleId = 'ui-away-title';
    this.since = h('span', { class: 'ui-away__since' });
    this.body = h('div');
    this.error = h('p', { class: 'ui-world__error', role: 'alert', hidden: true });
    this.seenBtn = h('button', { class: 'ui-btn ui-btn--sm ui-btn--primary', type: 'button', text: tr('Got it'), on: { click: () => void this.dismiss() } });
    const close = h('button', { class: 'ui-away__close', type: 'button', text: '×', title: tr('Close'), attrs: { 'aria-label': tr('Close') }, on: { click: () => void this.dismiss() } });
    this.el = h(
      'section',
      { class: 'ui-away ui-away--float', hidden: true, role: 'dialog', attrs: { 'aria-labelledby': titleId, 'aria-modal': 'false' } },
      h(
        'div',
        { class: 'ui-away__head' },
        h('span', { class: 'ui-away__badge', text: '📬', attrs: { 'aria-hidden': 'true' } }),
        h('div', { class: 'ui-away__titles' }, h('strong', { class: 'ui-away__title', text: tr('While you were away'), attrs: { id: titleId } }), this.since),
        close,
      ),
      this.body,
      h(
        'div',
        { class: 'ui-away__actions' },
        h('button', { class: 'ui-link-btn', type: 'button', text: tr('See my building'), on: { click: () => this.hooks.openWorld() } }),
        this.seenBtn,
      ),
      this.error,
    );
    this.el.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        void this.dismiss();
      }
    });
  }

  private active(): boolean {
    return this.hooks.active() && this.src.meta()?.state === 'approved' && !this.ctx.store.replaying;
  }

  render(): void {
    if (!this.active()) {
      setHidden(this.el, true);
      return;
    }
    const b = this.src.meta()?.building;
    // knocks: only new ones since this page last checked
    const k = newKnocks(this.knocksSeen, b?.knocks);
    this.knocksSeen = k.last;
    if (k.fresh > 0) {
      const text = k.fresh === 1 ? tr("Someone knocked on your building's door.") : tr("Someone knocked {0} times on your building's door.", [k.fresh]);
      this.hooks.toast({ id: `world-knock-${Date.now()}`, level: 'info', text: `🚪 ${text}`, at: Date.now() });
      this.ctx.announce(text);
    }
    // summary: when meta says there is one, request status (only it brings the counts)
    if (!b?.awaySummary) {
      if (this.shownKey) this.hide();
      return;
    }
    if (!this.shownKey && !this.loading) void this.load();
  }

  private async load(): Promise<void> {
    const client = this.src.client;
    if (!client) return;
    this.loading = true;
    const r = await client.status();
    this.loading = false;
    const s = r.ok ? r.data.building?.summary : undefined;
    const key = summaryKey(s);
    if (!s || !key || key === this.dismissedKey || !this.active()) return;
    this.shownKey = key;
    const v = awaySummaryView(s);
    setText(this.since, v.since);
    this.body.replaceChildren(summaryBody(v, true));
    setHidden(this.error, true);
    this.el.classList.toggle('is-calm', prefersReducedMotion());
    setHidden(this.el, false);
    this.ctx.announce(v.sentence);
  }

  private hide(): void {
    this.shownKey = '';
    setHidden(this.el, true);
  }

  /** "Got it" or close: disappears here and local server notifies world (without connection, as soon as it opens). */
  private async dismiss(): Promise<void> {
    const client = this.src.client;
    if (!client || this.busy) return;
    this.busy = true;
    this.seenBtn.disabled = true;
    const key = this.shownKey;
    const r = await client.summarySeen();
    this.busy = false;
    this.seenBtn.disabled = false;
    if (!r.ok) {
      // failed: card stays, with reason (another attempt dismisses again)
      setText(this.error, worldErrorText(r.code, 'summary'));
      setHidden(this.error, false);
      return;
    }
    this.dismissedKey = key;
    this.hide();
  }
}
