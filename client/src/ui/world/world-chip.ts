// Habblaud World chip in the top bar, next to version: "🏙️ in the world" with lit building, "⏸ paused",
// "reconnecting…" when connection dropped, and "⚠️ stopped" when world server halted building. Only with
// `meta.world.building` (approved account; outside world, nothing) and never on mobile via remote port
// (worldChipState). A click opens Habblaud World dialog, with "Your building" card, pause toggle, and stop reason.
// With visitors in building, "👀 N" beside it; first visitor of each connection triggers alert "Someone entered your
// building" (can be turned off in Habblaud World dialog).
// Phase 5: with lit building, "❤️ 3 today" (likes building received today), bouncing when a new one arrives.
import type { Notice } from '../../../../shared/types';
import { tr } from '../../../../shared/i18n';
import type { WorldSource } from '../../net/world';
import type { UiComponent, UiContext } from '../context';
import { h, prefersReducedMotion, setAttr, setHidden, setText, setTitle, setVariant } from '../dom';
import { worldGate } from './settings-world';
import { likesTodayChip } from './away-summary';
import { agentsText, floorsText, nextVisitorAlert, VISITOR_ALERT_START, visitorsText, worldChipState, type WorldChipState } from './world-model';

const ICON: Record<WorldChipState, string> = { live: '🏙️', paused: '⏸', reconnecting: '🏙️', stopped: '⚠️' };

export class WorldChip implements UiComponent {
  readonly el: HTMLButtonElement;
  private readonly icon: HTMLElement;
  private readonly text: HTMLElement;
  private readonly visitors: HTMLElement;
  private alert = VISITOR_ALERT_START;
  private alertSeq = 0;
  private readonly likes: HTMLElement;
  private lastLikes: number | null = null;

  constructor(
    private readonly ctx: UiContext,
    private readonly src: WorldSource,
    open: () => void,
    /** "Someone entered your building" alert (UI toasts). */
    private readonly notify?: (n: Notice) => void,
  ) {
    this.icon = h('span', { class: 'ui-world-chip__icon', attrs: { 'aria-hidden': 'true' } });
    this.text = h('span', { class: 'ui-world-chip__text' });
    this.visitors = h('span', { class: 'ui-world-chip__visitors', hidden: true });
    this.likes = h('span', { class: 'ui-world-chip__likes', hidden: true });
    this.el = h('button', { class: 'ui-world-chip', type: 'button', hidden: true, attrs: { 'aria-haspopup': 'dialog' }, on: { click: open } }, this.icon, this.text, this.visitors, this.likes);
  }

  render(): void {
    const meta = this.src.meta();
    const state = worldChipState(meta, worldGate(this.ctx, this.src));
    // visitors in building: alert for first of each connection (outside world or no account, no count)
    const count = state ? meta?.building?.visitors : undefined;
    const next = nextVisitorAlert(this.alert, count, this.ctx.prefs.worldVisitNotify);
    this.alert = next.state;
    if (next.notify) this.notify?.({ id: `world-visit-${++this.alertSeq}`, level: 'info', text: `👀 ${tr('Someone entered your building in Habblaud World.')}`, at: Date.now() });
    setHidden(this.el, !state);
    setHidden(this.visitors, !count);
    setText(this.visitors, count ? `👀 ${count}` : '');
    if (!state) return;
    const b = meta?.building;
    setVariant(this.el, 'is-', state);
    setText(this.icon, ICON[state]);
    const texts: Record<WorldChipState, [text: string, title: string]> = {
      live: [tr('in the world'), tr('Your building is lit in Habblaud World: {0} and {1}. Click to open Habblaud World.', [floorsText(b?.floors ?? 0), agentsText(b?.agents ?? 0)])],
      paused: [tr('paused'), tr('Paused: your building is dark, but you can walk around the city. Nothing from the office leaves this computer; click to resume.')],
      reconnecting: [tr('reconnecting…'), tr('No connection to Habblaud World right now; Habblaud keeps retrying on its own. Click to see your building.')],
      stopped: [tr('stopped'), tr('Your building stopped uploading to Habblaud World. Click to see why.')],
    };
    const [text, base] = texts[state];
    const title = count ? `${base} ${visitorsText(count)}.` : base;
    setText(this.text, text);
    const likes = likesTodayChip(state, b?.likesToday);
    setHidden(this.likes, !likes);
    setText(this.likes, likes?.text ?? '');
    const full = likes ? `${title} ${likes.title}` : title;
    setTitle(this.el, full);
    setAttr(this.el, 'aria-label', full);
    // new like: heart bounces
    const n = b?.likesToday ?? 0;
    if (likes && this.lastLikes !== null && n > this.lastLikes && !prefersReducedMotion()) {
      this.likes.classList.remove('is-bump');
      void this.likes.offsetWidth;
      this.likes.classList.add('is-bump');
    }
    this.lastLikes = n;
  }
}
