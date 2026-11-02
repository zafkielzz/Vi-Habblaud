// Buttons at the top of the terminal window: "Take over here" (session open in another terminal: ends it there and
// continues the same conversation here, interactive) and "End". Both require a second click.
// Only for real main agents (demo agents have no process) and with interactive terminal enabled; an Antigravity
// worker gets "End" only while its interactive agy runs here.
import type { AgentInfo } from '../../../shared/types';
import type { UiContext } from './context';
import { h, setHidden, setText, setTitle } from './dom';
import type { PtyControl } from './pty';
import { providerOf } from './provider';
import { ptyControllable } from './ptyapi';
import { tr } from '../../../shared/i18n';

const CONFIRM_MS = 4000;

type Kind = 'stop' | 'takeover';

export class TermActions {
  readonly el: HTMLElement;
  private agent: AgentInfo | null = null;
  private takeBtn: HTMLButtonElement;
  private stopBtn: HTMLButtonElement;
  private msg: HTMLElement;
  private confirm: Kind | null = null;
  private confirmTimer: ReturnType<typeof setTimeout> | null = null;
  private busy = false;

  constructor(
    private ctx: UiContext,
    private pty: PtyControl,
    /** Show "Take over here" (session open in another terminal). */
    public withTakeover: boolean,
    /** End this agent (default: via API; in interactive mode, closes the pty). */
    private onStop?: (agent: AgentInfo) => Promise<void>,
  ) {
    this.takeBtn = h('button', { class: 'ui-btn ui-btn--sm ui-btn--accent', type: 'button', on: { click: () => this.run('takeover') } });
    setTitle(this.takeBtn, tr("Ends the session in the terminal where it's running and continues the same conversation here, where you can type"));
    this.stopBtn = h('button', { class: 'ui-btn ui-btn--sm ui-btn--danger', type: 'button', on: { click: () => this.run('stop') } });
    setTitle(this.stopBtn, tr('Ends this Claude Code session (the conversation is saved)'));
    this.msg = h('span', { class: 'ui-termact__msg', role: 'status', hidden: true });
    this.el = h('span', { class: 'ui-termact', hidden: true }, this.msg, this.takeBtn, this.stopBtn);
  }

  /** `agent` = agent present in the window (null = history session, left or none). */
  render(agent: AgentInfo | null): void {
    if (agent?.id !== this.agent?.id) {
      this.resetConfirm();
      this.showMsg('');
    }
    this.agent = agent;
    const agyTerm = !!agent && providerOf(agent) === 'agy' && !!this.pty.ptyOf(agent.id);
    const usable = (ptyControllable(agent) || agyTerm) && this.pty.enabled;
    setHidden(this.el, !usable);
    if (!usable) return;
    setHidden(this.takeBtn, !this.withTakeover || agyTerm);
    setTitle(this.stopBtn, agyTerm ? tr('Closes this agy terminal') : tr('Ends this Claude Code session (the conversation is saved)'));
    setText(this.takeBtn, this.confirm === 'takeover' ? tr('Confirm?') : tr('Take over here'));
    setText(this.stopBtn, this.confirm === 'stop' ? tr('Confirm?') : tr('End'));
    this.takeBtn.classList.toggle('is-confirm', this.confirm === 'takeover');
    this.stopBtn.classList.toggle('is-confirm', this.confirm === 'stop');
    this.takeBtn.disabled = this.busy;
    this.stopBtn.disabled = this.busy;
  }

  private run(kind: Kind): void {
    const a = this.agent;
    if (!a || this.busy) return;
    if (this.confirm !== kind) {
      this.resetConfirm();
      this.confirm = kind;
      this.confirmTimer = setTimeout(() => {
        this.resetConfirm();
        this.ctx.invalidate();
      }, CONFIRM_MS);
      this.ctx.invalidate();
      return;
    }
    this.resetConfirm();
    this.busy = true;
    this.showMsg(kind === 'stop' ? tr('Ending…') : tr('Taking over…'));
    this.ctx.invalidate();
    const job = kind === 'stop' ? (this.onStop ? this.onStop(a) : this.pty.stop(a.id)) : this.pty.takeover(a.id);
    job
      .then(() => this.showMsg(''))
      .catch((err: Error) => this.showMsg(tr("Didn't work: {0}", [err.message]), true))
      .finally(() => {
        this.busy = false;
        this.ctx.invalidate();
      });
  }

  private showMsg(text: string, error = false): void {
    setText(this.msg, text);
    setHidden(this.msg, !text);
    setTitle(this.msg, text);
    this.msg.classList.toggle('is-error', error);
  }

  private resetConfirm(): void {
    if (this.confirmTimer) clearTimeout(this.confirmTimer);
    this.confirmTimer = null;
    this.confirm = null;
  }
}
