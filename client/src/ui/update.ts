// New version notice: when the server starts serving another client build (e.g. after an
// `npm run docker:up`), this page is outdated — it does not know new states and features.
// Shows the notice and reloads on its own in a few seconds (can be postponed).
import type { OfficeStore } from '../net/store';
import { h, setHidden, setText } from './dom';
import { tr } from '../../../shared/i18n';

const RELOAD_IN_S = 5;

export class UpdateBanner {
  readonly el: HTMLElement;
  private text: HTMLElement;
  private timer: ReturnType<typeof setInterval> | null = null;
  private left = RELOAD_IN_S;

  constructor(store: OfficeStore, private reload: () => void = () => location.reload()) {
    this.text = h('span');
    const now = h('button', { class: 'ui-btn ui-btn--sm', type: 'button', text: tr('Reload now'), on: { click: () => this.reload() } });
    const later = h('button', { class: 'ui-btn ui-btn--sm', type: 'button', text: tr('Later'), on: { click: () => this.postpone() } });
    this.el = h(
      'div',
      { class: 'ui-banner ui-banner--update', role: 'status', hidden: true },
      h('span', { class: 'ui-banner__dot', attrs: { 'aria-hidden': 'true' } }),
      h('span', { class: 'ui-banner__text' }, this.text),
      now,
      later,
    );
    store.on('update', () => this.start());
  }

  private start(): void {
    setHidden(this.el, false);
    this.tick();
    this.timer = setInterval(() => this.tick(), 1_000);
  }

  private tick(): void {
    if (this.left <= 0) {
      this.stop();
      this.reload();
      return;
    }
    setText(this.text, tr('Habblaud has been updated. Reloading in {0} s…', [this.left]));
    this.left--;
  }

  private postpone(): void {
    this.stop();
    setText(this.text, tr('Habblaud has been updated. Reload the page whenever you like.'));
  }

  private stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
