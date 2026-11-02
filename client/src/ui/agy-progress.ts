// Nível, XP e conquistas de um worker do Antigravity na gaveta (AgentInfo.progress, server/sources/agy/progress.ts).
import type { WorkerProgress } from '../../../shared/types';
import { h, setText, setTitle } from './dom';
import { tr } from '../../../shared/i18n';

export class AgyProgressView {
  readonly el: HTMLElement;
  private readonly head: HTMLElement;
  private readonly fill: HTMLElement;
  private readonly xp: HTMLElement;
  private readonly badges: HTMLElement;
  private sig = '';

  constructor() {
    this.head = h('div', { class: 'ui-agyp__head' });
    this.fill = h('div', { class: 'ui-agyp__fill' });
    this.xp = h('div', { class: 'ui-agyp__xp ui-muted' });
    this.badges = h('div', { class: 'ui-agyp__badges' });
    this.el = h('div', { class: 'ui-agyp' }, this.head, h('div', { class: 'ui-agyp__bar', attrs: { 'aria-hidden': 'true' } }, this.fill), this.xp, this.badges);
  }

  render(p: WorkerProgress): void {
    const sig = JSON.stringify(p);
    if (sig === this.sig) return;
    this.sig = sig;
    setText(this.head, tr('Level {0} · {1}', [p.level, p.rank]));
    const span = Math.max(1, p.nextXp - p.levelXp);
    this.fill.style.width = `${Math.round((100 * (p.xp - p.levelXp)) / span)}%`;
    setText(this.xp, tr('{0} / {1} XP · {2} jobs done', [p.xp, p.nextXp, p.jobs]));
    this.badges.replaceChildren(
      ...(p.badges.length
        ? p.badges.map((b) => {
            const chip = h('span', { class: 'ui-agyp__badge', text: `${b.icon} ${b.name}` });
            setTitle(chip, b.desc);
            return chip;
          })
        : [h('span', { class: 'ui-muted', text: tr('No achievements yet.') })]),
    );
  }
}
