// "Sounds" settings group: master switch, master volume, and categories.
import { SOUND_CATEGORIES, type SoundCategory, type SoundKind } from '../audio/scheduler';
import type { UiContext } from './context';
import { h, setAttr, setText } from './dom';
import type { SoundControl } from './sound';
import { tr } from '../../../shared/i18n';

const CATEGORY_UI: Readonly<Record<SoundCategory, { label: string; hint: string; sample: SoundKind }>> = {
  alerts: { label: tr('Alerts'), hint: tr('A bell when someone needs you; a click when a task finishes.'), sample: 'chime' },
  keys: { label: tr('Keyboard'), hint: tr('Soft typing from whoever is working in the rooms in view.'), sample: 'keys' },
  elevator: { label: tr('Elevator'), hint: tr('"Ding" when someone arrives or leaves.'), sample: 'elevator' },
  social: { label: tr('Hangouts'), hint: tr('Ping-pong and arcade games in the lounge.'), sample: 'pingpong' },
};

export class SoundSettingsGroup {
  readonly el: HTMLElement;
  private master: HTMLButtonElement;
  private volume: HTMLInputElement;
  private volumeOut: HTMLElement;
  private chips = new Map<SoundCategory, HTMLButtonElement>();
  private details: HTMLElement;

  constructor(
    private ctx: UiContext,
    private sound: SoundControl,
  ) {
    const id = 'ui-snd-master';
    this.master = h('button', { class: 'ui-switch', type: 'button', role: 'switch', attrs: { 'aria-checked': 'false', 'aria-labelledby': id } }, h('span', { class: 'ui-switch__knob' }));
    this.master.addEventListener('click', () => {
      const on = !ctx.prefs.sound;
      ctx.updatePrefs({ sound: on });
      if (on) this.sound.preview('pop');
    });

    this.volume = h('input', { class: 'ui-snd__range', type: 'range', attrs: { min: 0, max: 100, step: 5, 'aria-label': tr('Sound volume') } });
    this.volume.addEventListener('input', () => {
      ctx.updatePrefs({ sounds: { ...ctx.prefs.sounds, volume: Number(this.volume.value) / 100 } });
      setText(this.volumeOut, `${this.volume.value}%`);
    });
    // preview on release (not on every drag step)
    this.volume.addEventListener('change', () => this.sound.preview('pop'));
    this.volumeOut = h('span', { class: 'ui-snd__value', attrs: { 'aria-hidden': 'true' } });

    const chipRow = h('div', { class: 'ui-snd__chips', role: 'group', attrs: { 'aria-label': tr('Sound categories') } });
    for (const cat of SOUND_CATEGORIES) {
      const ui = CATEGORY_UI[cat];
      const b = h('button', { class: 'ui-snd__chip', type: 'button', text: ui.label, title: ui.hint, attrs: { 'aria-pressed': 'true' } });
      b.addEventListener('click', () => {
        const on = !ctx.prefs.sounds[cat];
        ctx.updatePrefs({ sounds: { ...ctx.prefs.sounds, [cat]: on } });
        if (on) this.sound.preview(ui.sample);
      });
      this.chips.set(cat, b);
      chipRow.append(b);
    }

    this.details = h(
      'div',
      { class: 'ui-snd__details' },
      h('div', { class: 'ui-set ui-snd__vol' }, h('span', { class: 'ui-set__label', text: tr('Volume') }), this.volume, this.volumeOut),
      h('div', { class: 'ui-set ui-set--stack' }, h('span', { class: 'ui-set__label', text: tr('Play') }), chipRow, h('span', { class: 'ui-set__hint', text: tr('Alerts: bell and click · Keyboard: typing in the rooms in view · Elevator: arrivals and departures · Groups: ping-pong and arcade.') })),
    );

    this.el = h(
      'div',
      { class: 'ui-set-group ui-snd' },
      h('h3', { text: tr('Sounds') }),
      h(
        'div',
        { class: 'ui-set' },
        h(
          'div',
          { class: 'ui-set__text' },
          h('span', { class: 'ui-set__label', text: tr('Office sounds'), attrs: { id } }),
          h('span', { class: 'ui-set__hint', text: tr('Synthesized in the browser, and quiet. With the tab hidden, only the "needs you" bell.') }),
        ),
        this.master,
      ),
      this.details,
    );
  }

  render(): void {
    const p = this.ctx.prefs;
    setAttr(this.master, 'aria-checked', String(p.sound));
    const pct = String(Math.round(p.sounds.volume * 100));
    if (document.activeElement !== this.volume && this.volume.value !== pct) this.volume.value = pct;
    setText(this.volumeOut, `${this.volume.value}%`);
    this.volume.disabled = !p.sound;
    for (const [cat, b] of this.chips) {
      setAttr(b, 'aria-pressed', String(p.sounds[cat]));
      b.disabled = !p.sound;
    }
    this.details.classList.toggle('is-off', !p.sound);
  }
}
