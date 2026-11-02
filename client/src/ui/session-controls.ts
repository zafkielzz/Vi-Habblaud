// "Model and effort" in a Claude Code session's drawer: model and effort selects and a "Plan mode" button. Each change
// goes to POST /api/messages as a `command` for the habblaud-mensagens plugin: `/plan` runs as if typed; model and
// effort are put on that session's own requests only (not `/model` / `/effort`, which would also change the default
// for new sessions). The selects show what the session really uses (model and effort of its last answer,
// permission mode from the transcript), so a change shows here once the session applied it. Claude Code has no
// command to leave plan mode: approving the plan does (the permission card, when habblaud-permissoes is installed).
import { SESSION_EFFORTS, SESSION_MODELS } from '../../../shared/messages';
import { prettyModel } from '../../../shared/model-spec';
import type { AgentInfo, SessionCommand } from '../../../shared/types';
import type { UiContext } from './context';
import { h, setHidden, setText } from './dom';
import { tr } from '../../../shared/i18n';

/** Drawer value of a model id: its alias ("claude-opus-5-5" -> "opus"), or '' when it is none of the choices. */
export function modelAlias(model: string | undefined): string {
  const family = model ? prettyModel(model).split(' ')[0].toLowerCase() : '';
  return (SESSION_MODELS as readonly string[]).includes(family) ? family : '';
}

export class SessionControls {
  readonly el: HTMLElement;
  private agentId = '';
  private busy = false;
  private readonly model: HTMLSelectElement;
  private readonly effort: HTMLSelectElement;
  private readonly planBtn: HTMLButtonElement;
  private readonly status: HTMLElement;

  constructor(private ctx: UiContext) {
    const select = (id: string, label: string) => h('select', { class: 'ui-msg__input ui-agy__select', attrs: { id, 'aria-label': label, title: label } });
    this.model = select('ui-session-model', tr('Model'));
    this.model.append(h('option', { text: '—', attrs: { value: '', disabled: true } }));
    for (const m of SESSION_MODELS) this.model.append(h('option', { text: m === 'default' ? tr('Default model') : m.charAt(0).toUpperCase() + m.slice(1), attrs: { value: m } }));
    this.model.addEventListener('change', () => void this.send({ name: 'model', args: this.model.value }));
    this.effort = select('ui-session-effort', tr('Reasoning effort'));
    this.effort.append(h('option', { text: '—', attrs: { value: '', disabled: true } }));
    for (const e of SESSION_EFFORTS) this.effort.append(h('option', { text: e, attrs: { value: e } }));
    this.effort.addEventListener('change', () => void this.send({ name: 'effort', args: this.effort.value }));
    this.planBtn = h('button', { class: 'ui-btn', type: 'button', text: tr('Plan mode'), attrs: { 'data-hint': tr('Switches this session to plan mode: it plans first and asks you before changing anything') }, on: { click: () => void this.send({ name: 'plan', args: '' }) } });
    this.status = h('p', { class: 'ui-msg__status', role: 'status', hidden: true, attrs: { 'aria-live': 'polite' } });
    this.el = h('div', { class: 'ui-msg ui-msg--drawer ui-agy' }, h('div', { class: 'ui-msg__row ui-agy__row' }, this.model, this.effort), h('div', { class: 'ui-msg__row ui-agy__row' }, this.planBtn), this.status);
  }

  render(a: AgentInfo): void {
    if (a.id !== this.agentId) {
      this.agentId = a.id;
      setHidden(this.status, true);
    }
    if (document.activeElement !== this.model) this.model.value = modelAlias(a.model);
    if (document.activeElement !== this.effort) this.effort.value = a.effort && (SESSION_EFFORTS as readonly string[]).includes(a.effort) ? a.effort : '';
    const plan = a.permissionMode === 'plan';
    this.planBtn.disabled = this.busy || plan;
    setText(this.planBtn, plan ? tr('In plan mode') : tr('Plan mode'));
    this.planBtn.title = plan ? tr('Claude Code leaves plan mode when you approve the plan') : tr('Switch this session to plan mode (/plan)');
  }

  private async send(command: SessionCommand): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      const r = await this.ctx.store.sendCommand(this.agentId, command);
      const typed = `/${command.name}${command.args ? ` ${command.args}` : ''}`;
      setText(this.status, 'error' in r ? r.error : tr('Sent {0}: it applies from the next answer.', [typed]));
      this.status.classList.toggle('is-error', 'error' in r);
    } catch {
      setText(this.status, tr('No connection to Habblaud.'));
      this.status.classList.add('is-error');
    } finally {
      this.busy = false;
      setHidden(this.status, false);
    }
  }
}
