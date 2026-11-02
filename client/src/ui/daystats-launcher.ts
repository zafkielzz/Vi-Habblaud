// "My day" top bar button. The panel (ui/daystats.ts, with charts and shared accumulator) lives in a
// separate bundle chunk and is only fetched on first open; in ?mock=1 it loads immediately so the
// local accumulator counts from page open.
import type { UiComponent, UiContext } from './context';
import type { DayPanel } from './daystats';
import { iconButton } from './dom';
import { tr } from '../../../shared/i18n';

/** Pixel-art chart bars (matching style of other top bar icons). */
const DAY_ICON =
  '<svg class="ui-px-icon" width="20" height="20" viewBox="0 0 10 10" shape-rendering="crispEdges" aria-hidden="true" focusable="false">' +
  '<path fill="currentColor" d="M0 9h10v1H0zM1 5h2v4H1zM4 2h2v7H4zM7 4h2v5H7z"/></svg>';

export class DayLauncher implements UiComponent {
  readonly button: HTMLButtonElement;
  private panel: DayPanel | null = null;
  private loading: Promise<DayPanel> | null = null;

  /** `mount` attaches panel dialog to interface once instantiated. */
  constructor(
    private readonly ctx: UiContext,
    private readonly mount: (el: HTMLElement) => void,
  ) {
    this.button = iconButton(DAY_ICON, tr('My day: where the time went (M)'), () => this.toggle());
    this.button.setAttribute('aria-haspopup', 'dialog');
    if (ctx.store.mock) void this.load();
  }

  toggle(): void {
    if (this.panel) this.panel.toggle();
    else
      void this.load()
        .then((p) => p.open())
        .catch(() => this.ctx.announce(tr("Couldn't open the My day panel.")));
  }

  render(): void {
    this.panel?.render();
  }

  private load(): Promise<DayPanel> {
    this.loading ??= import('./daystats').then((m) => {
      const panel = new m.DayPanel(this.ctx, this.button);
      this.mount(panel.el);
      this.panel = panel;
      return panel;
    });
    // Failed (network drop during download): next attempt retries.
    this.loading.catch(() => (this.loading = null));
    return this.loading;
  }
}
