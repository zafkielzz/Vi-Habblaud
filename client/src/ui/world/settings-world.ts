// Habblaud World modal content (world-dialog.ts, dedicated top bar button): account (signup with terms acceptance and
// privacy summary, email code, login, forgot password), waitlist, character (agent drawer appearance editor plus name,
// traits, and intro phrase), "Your building" card with Pause/Resume and "See what was sent" (building.ts), building
// visibility, devices, and sign out. Also theme tip in Settings › Appearance when the choice goes to the building.
// Phase 6: "Account and data" (inactivity notice, "Download my data", and "Delete account" in three steps: what is
// removed and when, confirmation, and email code), world maintenance notice, and deleted account notice. Talks to local
// /api/world/* routes (net/world.ts); pure rules reside in world-model.ts.
//
// The dialog calls render() on every dirty frame: the inner content is only rebuilt when the screen changes (otherwise
// typed input and focus would be lost); status is fetched when opening the dialog, after each action, and when snapshot
// meta.world changes, never inside render.
import { intlLocale, tr } from '../../../../shared/i18n';
import type { Appearance } from '../../art/api';
import { access } from '../../net/access';
import {
  buildingFromMeta,
  FAKE_CODE,
  type WorldClient,
  type WorldDevice,
  type WorldErrorCode,
  type WorldResult,
  type WorldSource,
  type WorldStatus,
  type WorldThemeChoice,
  type WorldVisibility,
} from '../../net/world';
import { BuildingCard, SentDialog } from './building';
import { buildBlocked } from './blocked';
import { TRAITS, TRAIT_IDS, type TraitId } from '../../../../shared/world/traits';
import { AppearanceFields } from '../appearance-fields';
import { createAvatar } from '../avatar';
import type { UiContext } from '../context';
import { h, setAttr, setHidden, setText, setVariant } from '../dom';
import { formatDateTime, relativeTime } from '../format';
import { segmented, switchRow } from '../settings';
import { INTRO_IDS, introLabel, isIntroId, type IntroId } from '../../../../shared/world/intro';
import { parsePlayerName } from '../../../../shared/world/names-rules';
import { PLAYER_NAME_LIMITS } from '../../../../shared/world/protocol';
import {
  APPEAL_EMAIL,
  characterProblem,
  codeLooksValid,
  DEFAULT_VISIBILITY,
  draftAppearance,
  emailLooksValid,
  EXPORT_FILENAME,
  fullParts,
  initialWorldUi,
  nameProblemText,
  normalizeCode,
  normalizeEmail,
  notifyInactivityOn,
  passwordProblem,
  passwordProblemText,
  themeGoesToWorld,
  traitBlock,
  toggleTrait,
  VISIBILITY_SWITCHES,
  worldErrorText,
  worldReduce,
  worldSectionMode,
  type VisibilitySwitch,
  type WorldAction,
  type WorldFlash,
  type WorldGate,
  type WorldScreen,
  type WorldSectionMode,
  type WorldUi,
  type WorldUiEvent,
} from './world-model';
import { extLink, WORLD_PRIVACY_URL, WORLD_TERMS_URL } from './links';

export { extLink, WORLD_PRIVACY_URL, WORLD_TERMS_URL } from './links';

/** After resending the code, the button waits this long (the server also limits: 3 per hour). */
const RESEND_COOLDOWN_MS = 30_000;

// ------------------------------------------------------------------ DOM snippets

/**
 * Translated phrase with elements in the middle: {0}, {1}... placeholders in `text` (already passed through tr(),
 * without arguments) become nodes from `nodes`. This lets the translation decide where the link fits into the phrase.
 */
export function rich(text: string, nodes: readonly Node[]): (Node | string)[] {
  return text.split(/(\{\d+\})/).map((part) => {
    const m = /^\{(\d+)\}$/.exec(part);
    return m && nodes[Number(m[1])] ? nodes[Number(m[1])] : part;
  });
}

function para(cls: string, ...children: (Node | string)[]): HTMLParagraphElement {
  return h('p', { class: cls }, ...children);
}

function backButton(onClick: () => void): HTMLButtonElement {
  return h('button', { class: 'ui-link-btn ui-world__back', type: 'button', text: tr('← Back'), on: { click: onClick } });
}

function screenHead(title: string, onBack: () => void): HTMLElement {
  return h('div', { class: 'ui-world__head' }, backButton(onBack), h('h4', { class: 'ui-world__title', text: title }));
}

interface FieldRefs {
  label: HTMLElement;
  input: HTMLInputElement;
}

let fieldSeq = 0;

function field(labelText: string, input: HTMLInputElement, hint?: string): FieldRefs {
  const id = `ui-world-f${++fieldSeq}`;
  input.id = id;
  const hintEl = hint ? h('span', { class: 'ui-set__hint', text: hint, attrs: { id: `${id}-hint` } }) : null;
  if (hintEl) setAttr(input, 'aria-describedby', hintEl.id);
  const label = h('div', { class: 'ui-world__field' }, h('label', { class: 'ui-world__label', text: labelText, attrs: { for: id } }), input, hintEl);
  return { label, input };
}

function textInput(type: string, autocomplete: string, extra: Record<string, string | number | boolean> = {}): HTMLInputElement {
  return h('input', { class: 'ui-world__input', type, attrs: { autocomplete, spellcheck: 'false', autocapitalize: 'off', ...extra } });
}

/** Password with "Show password" (long passwords are the rule: people want to check what they typed). */
function passwordField(labelText: string, autocomplete: 'new-password' | 'current-password', hint?: string): FieldRefs {
  const input = textInput('password', autocomplete, { maxlength: 256 });
  const f = field(labelText, input, hint);
  const toggle = h('button', { class: 'ui-link-btn ui-world__peek', type: 'button', text: tr('Show password') });
  toggle.addEventListener('click', () => {
    const show = input.type === 'password';
    input.type = show ? 'text' : 'password';
    setText(toggle, show ? tr('Hide password') : tr('Show password'));
    setAttr(toggle, 'aria-pressed', String(show));
  });
  setAttr(toggle, 'aria-pressed', 'false');
  f.label.append(toggle);
  return f;
}

function emailField(): FieldRefs {
  return field(tr('Email'), textInput('email', 'email', { inputmode: 'email', maxlength: 254 }));
}

function codeField(): FieldRefs {
  const input = textInput('text', 'one-time-code', { inputmode: 'numeric', maxlength: 9, placeholder: '000000' });
  input.classList.add('ui-world__code');
  input.addEventListener('input', () => {
    const v = normalizeCode(input.value);
    if (v !== input.value && /^\d*$/.test(v)) input.value = v;
  });
  return field(tr('6-digit code'), input);
}

/** Screen form: primary button with "sending" state and the error line. */
class Form {
  readonly el: HTMLFormElement;
  readonly error: HTMLElement;
  readonly submit: HTMLButtonElement;
  private readonly label: string;

  constructor(submitText: string, onSubmit: () => void, private readonly busyText: string) {
    this.label = submitText;
    this.submit = h('button', { class: 'ui-btn ui-btn--primary', type: 'submit', text: submitText });
    this.error = h('p', { class: 'ui-world__error', role: 'alert', hidden: true });
    this.el = h('form', { class: 'ui-world__form', attrs: { novalidate: true } });
    this.el.addEventListener('submit', (ev) => {
      ev.preventDefault();
      if (!this.submit.disabled) onSubmit();
    });
  }

  setBusy(on: boolean): void {
    this.submit.disabled = on;
    setAttr(this.submit, 'aria-busy', on ? 'true' : null);
    setText(this.submit, on ? this.busyText : this.label);
  }

  setError(text: string | null, focus?: HTMLElement): void {
    setText(this.error, text ?? '');
    setHidden(this.error, !text);
    if (text) focus?.focus();
  }
}

function toMillis(v: number | string | undefined): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string') {
    const t = Date.parse(v);
    return Number.isFinite(t) ? t : null;
  }
  return null;
}

/** "Dispositivo 2" arrives in Portuguese from the server: converted here to the UI language text. */
export function deviceLabel(label: string): string {
  const m = /^Dispositivo (\d+)$/.exec(label);
  return m ? tr('Device {0}', [m[1]]) : label;
}

/** Country name in the UI language ("BR" → "Brazil"). */
function countryName(code: string): string {
  try {
    return new Intl.DisplayNames([intlLocale()], { type: 'region' }).of(code.toUpperCase()) ?? code;
  } catch {
    return code;
  }
}

function randomSeed(): number {
  return crypto.getRandomValues(new Uint32Array(1))[0];
}

function flashText(f: WorldFlash): string {
  switch (f) {
    case 'code_sent':
      return '';
    case 'code_resent':
      return tr('We sent another code.');
    case 'password_changed':
      return tr('Password changed. Sign in with the new password.');
    case 'signed_out':
      return tr('You signed out of Habblaud World on this computer.');
    case 'character_saved':
      return tr('Character saved.');
    case 'device_revoked':
      return tr('Device revoked.');
  }
}

function visibilityText(key: VisibilitySwitch): { label: string; hint: string } {
  switch (key) {
    case 'closed':
      return { label: tr('Closed to visitors'), hint: tr('People can see the building from outside, but nobody can come in.') };
    case 'hideCountry':
      return { label: tr('Hide country'), hint: tr("A neutral flag shows instead of your country's flag (taken from the connection's IP).") };
    case 'tokensVisible':
      return { label: tr('Show token usage'), hint: tr('Daily and weekly total for the whole building, only in ranges (up to 100k, 1 million…). Never the cost.') };
    case 'leaderboard':
      return { label: tr('Join the leaderboard'), hint: tr("Your building can show up on the city's token leaderboards.") };
    case 'compactions':
      return { label: tr('Show compactions'), hint: tr("When an agent compacts its context, the room's trash can fills up. Only the fact is sent, nothing of the content.") };
    case 'knocks':
      return { label: tr('Let me know when someone knocks'), hint: tr("Whoever is at your building's door can knock; the notice shows up here in Habblaud, without the name of who knocked.") };
  }
}

/** Section gates on this page (mobile, local address, terminal lock, demo mode). */
export function worldGate(ctx: UiContext, src: WorldSource): WorldGate {
  const a = access();
  return { remote: a.remote, local: a.local, terminal: !!ctx.store.liveSnapshot?.meta.terminal, fake: src.fake };
}

/** Mounted view: the element and, if needed, what to update without rebuilding (text, button state). */
interface View {
  el: HTMLElement;
  sync?(): void;
}

// ------------------------------------------------------------------ section

export class WorldSettingsGroup {
  readonly el: HTMLElement;
  /** Account state ("No account", "On the waitlist", "Approved") in the dialog header. */
  readonly chip: HTMLElement;
  private readonly flashEl: HTMLElement;
  private readonly body: HTMLElement;
  private ui: WorldUi = initialWorldUi();
  private mode: WorldSectionMode = 'hidden';
  private status: WorldStatus | null = null;
  /** Incremented when status actually changes: screens showing account data rebuild. */
  private statusRev = 0;
  private statusSig = '';
  private statusError: WorldErrorCode | null = null;
  private loading = false;
  private stale = true;
  private statusReq = 0;
  private metaState: string | undefined;
  private wasOpen = false;
  private builtKey = '';
  private view: View | null = null;
  /** Incremented on each mounted view: response to a request made from another screen won't affect current. */
  private epoch = 0;
  private lastFlash: WorldFlash | null = null;
  private resendUntil = 0;
  /** Last `meta.world.building`: when it changes (new upload, pause), status is refetched with section open. */
  private metaBuildingSig = '';
  private readonly sent: SentDialog;
  /** Note in Appearance › Office theme (only when choice also applies to the building). */
  readonly themeNote: HTMLElement;
  private readonly themeError: HTMLElement;
  private themeLinked = false;
  private themeReq = 0;
  /** A theme PUT in flight (status arriving in-between won't override theme). */
  private themeInflight = 0;
  /** When the last theme choice was made here (status requested earlier won't revert it). */
  private themePickedAt = 0;
  /** Logical clock of theme choices and status requests (which came first). */
  private themeClock = 0;

  constructor(
    private readonly ctx: UiContext,
    private readonly src: WorldSource,
  ) {
    this.chip = h('span', { class: 'ui-world__chip' });
    this.flashEl = h('p', { class: 'ui-world__flash', role: 'status', hidden: true });
    this.body = h('div', { class: 'ui-world__body' });
    this.sent = new SentDialog(() => this.client, () => this.ctx.now());
    this.el = h('div', { class: 'ui-world', hidden: true, attrs: { id: 'ui-world' } }, this.flashEl, this.body, this.sent.el);
    this.themeError = h('span', { class: 'ui-world__error', role: 'alert', hidden: true });
    this.themeNote = h('span', { class: 'ui-set__hint ui-world-theme', hidden: true }, h('span', { text: tr('The theme also applies to your building in Habblaud World.') }), this.themeError);
    src.onChange?.(() => {
      this.stale = true;
      ctx.invalidate();
    });
  }

  private get client(): WorldClient | null {
    return this.src.client;
  }

  /** On each dialog render, open or not (cheap: only rebuilds inner content when screen changes). */
  render(open: boolean): void {
    const meta = this.src.meta();
    const gate = worldGate(this.ctx, this.src);
    this.mode = worldSectionMode(meta, gate);
    setHidden(this.el, this.mode === 'hidden');
    this.themeLinked = themeGoesToWorld(meta, gate);
    setHidden(this.themeNote, !this.themeLinked);
    if (this.mode === 'active' && meta) {
      if (meta.state !== this.metaState) {
        this.metaState = meta.state;
        this.stale = true;
        // Before first status, screen follows the snapshot.
        if (!this.status) this.ui = worldReduce(this.ui, { type: 'server', state: meta.state });
      }
      const buildingSig = JSON.stringify(meta.building ?? null);
      if (buildingSig !== this.metaBuildingSig) {
        this.metaBuildingSig = buildingSig;
        this.stale = true;
      }
      if (open && !this.wasOpen) this.stale = true;
      if (open && this.stale && !this.loading) void this.refresh();
    }
    this.wasOpen = open;
    this.paint();
  }

  /** Navigates to a screen (launch popups request registration or character; top chip requests building). */
  show(screen?: WorldScreen): void {
    if (screen) this.ui = worldReduce(this.ui, { type: 'go', screen });
    this.ctx.invalidate();
  }

  /**
   * Appearance › Office theme choice also applies to the building (PUT /api/world/theme) when World is enabled
   * and account is approved. If it fails, theme note shows the error (office switches theme anyway).
   */
  async onThemePicked(theme: WorldThemeChoice): Promise<void> {
    const client = this.client;
    this.themePickedAt = ++this.themeClock;
    if (!this.themeLinked || !client) return;
    const req = ++this.themeReq;
    this.themeInflight++;
    const r = await client.setTheme(theme).finally(() => this.themeInflight--);
    if (req !== this.themeReq) return;
    setText(this.themeError, r.ok ? '' : ` ${tr("Couldn't send the theme to the building: {0}", [worldErrorText(r.code, 'theme')])}`);
    setHidden(this.themeError, r.ok);
  }

  /**
   * Office and building themes stay in sync (status returns the building theme, stored in world.json): a choice saved
   * on this computer (`theme` present) also applies to this page's office; without saved choice (automatic, default),
   * this page's choice goes to the building. Neither applies with an in-flight theme PUT or status requested before
   * the last local choice.
   */
  private syncTheme(st: WorldStatus, askedAt: number): void {
    if (!this.themeLinked || st.state !== 'approved' || this.themeInflight > 0 || askedAt < this.themePickedAt) return;
    const pref = this.ctx.prefs.theme;
    if (st.theme && st.theme !== pref) this.ctx.updatePrefs({ theme: st.theme });
    else if (!st.theme && pref !== 'auto') void this.onThemePicked(pref);
  }

  /** Scrolls back to the top of scrollable dialog body (for each new screen, its beginning matters most). */
  private scrollToTop(): void {
    const host = this.el.parentElement;
    if (host) host.scrollTop = 0;
  }

  private dispatch(e: WorldUiEvent): void {
    this.ui = worldReduce(this.ui, e);
    this.ctx.invalidate();
  }

  private go(screen: WorldScreen): void {
    this.dispatch({ type: 'go', screen });
  }

  private async refresh(force = false): Promise<void> {
    const client = this.client;
    if (!client) return;
    const req = ++this.statusReq;
    const askedAt = this.themeClock;
    this.loading = true;
    this.stale = false;
    const r = await client.status(force);
    if (req !== this.statusReq) return;
    this.loading = false;
    if (r.ok) {
      this.status = r.data;
      this.syncTheme(r.data, askedAt);
      // Building changes with each upload: card updates itself (BuildingCard.sync), without rebuilding screen.
      const { building: _building, ...rest } = r.data;
      const sig = JSON.stringify(rest);
      if (sig !== this.statusSig) {
        this.statusSig = sig;
        this.statusRev++;
      }
      this.statusError = null;
      this.ui = worldReduce(this.ui, { type: 'server', state: r.data.state });
    } else {
      this.statusError = r.code;
    }
    this.ctx.invalidate();
  }

  /**
   * Runs a screen action: disables button, shows translated error. Returns result, or null if screen changed
   * in the meantime (response is no longer valid for the visible screen).
   */
  private async run<T>(form: Form, action: WorldAction, call: (c: WorldClient) => Promise<WorldResult<T>>, focus?: HTMLElement): Promise<WorldResult<T> | null> {
    const client = this.client;
    if (!client) return null;
    const epoch = this.epoch;
    form.setBusy(true);
    form.setError(null);
    const r = await call(client);
    if (epoch !== this.epoch) return null;
    form.setBusy(false);
    if (!r.ok) form.setError(worldErrorText(r.code, action), focus);
    return r;
  }

  // ---------------------------------------------------------------- mounting

  private viewKey(): string {
    if (this.mode !== 'active') return this.mode;
    const signedIn = this.ui.server === 'waiting' || this.ui.server === 'approved';
    if (signedIn && !this.status) return this.statusError ? `error:${this.statusError}` : 'loading';
    return `screen:${this.ui.screen}`;
  }

  private paint(): void {
    const key = this.viewKey();
    if (key !== this.builtKey) {
      this.builtKey = key;
      this.epoch++;
      this.view = this.build();
      this.body.replaceChildren(this.view.el);
      this.scrollToTop();
    } else {
      this.view?.sync?.();
    }
    setText(this.chip, this.chipText());
    setVariant(this.chip, 'is-', this.mode === 'active' ? (this.ui.server ?? 'loading') : this.mode);
    const flash = this.ui.flash ? flashText(this.ui.flash) : '';
    setText(this.flashEl, flash);
    setHidden(this.flashEl, !flash);
    if (this.ui.flash !== this.lastFlash) {
      this.lastFlash = this.ui.flash;
      if (flash) this.ctx.announce(flash);
    }
  }

  private chipText(): string {
    if (this.mode === 'local_only') return tr('Computer only');
    switch (this.ui.server) {
      case 'logged_out':
        return tr('No account');
      case 'waiting':
        return tr('On the waitlist');
      case 'approved':
        return tr('Approved');
      default:
        return '';
    }
  }

  private build(): View {
    if (this.mode === 'local_only') return { el: para('ui-set__hint', tr('The Habblaud World account can only be managed on the computer itself, with Habblaud on local access (bind 127.0.0.1) and opened via http://localhost.')) };
    if (this.mode !== 'active') return { el: h('div') };
    const key = this.builtKey;
    if (key === 'loading') return { el: para('ui-set__hint', tr('Loading…')) };
    if (key.startsWith('error:')) return this.buildStatusError();
    switch (this.ui.screen) {
      case 'welcome':
        return this.buildWelcome();
      case 'register':
        return this.buildRegister();
      case 'login':
        return this.buildLogin();
      case 'verify':
        return this.buildVerify();
      case 'forgot':
        return this.buildForgot();
      case 'reset':
        return this.buildReset();
      case 'home':
        return this.buildHome();
      case 'character':
        return this.buildCharacter();
      case 'visibility':
        return this.buildVisibility();
      case 'devices':
        return this.buildDevices();
      case 'account':
        return this.buildAccount();
      case 'blocked':
        return this.buildBlocked();
    }
  }

  private buildStatusError(): View {
    const retry = h('button', { class: 'ui-btn ui-btn--sm', type: 'button', text: tr('Try again'), on: { click: () => void this.refresh() } });
    return {
      el: h('div', { class: 'ui-world__stack' }, para('ui-world__error', worldErrorText(this.statusError ?? 'unknown', 'status')), h('div', { class: 'ui-world__actions' }, retry)),
    };
  }

  /** Privacy sentence for card and welcome screen (plan 2.1), with link to the list. */
  private privacyLine(): HTMLElement {
    return para(
      'ui-world__privacy',
      tr('Nothing about your work leaves your computer: only the theme, how many floors, and whether each character is busy or idle.'),
      ' ',
      extLink(tr('See the list'), WORLD_PRIVACY_URL),
    );
  }

  private buildWelcome(): View {
    const create = h('button', { class: 'ui-btn ui-btn--primary', type: 'button', text: tr('Create account'), on: { click: () => this.go('register') } });
    const login = h('button', { class: 'ui-btn', type: 'button', text: tr('I already have an account'), on: { click: () => this.go('login') } });
    // Account was just deleted (here or on another computer): notice remains until signed in again.
    const deleted = this.status?.lastError === 'account_deleted' ? para('ui-world__notice', worldErrorText('account_deleted', 'status')) : null;
    return {
      el: h(
        'div',
        { class: 'ui-world__stack' },
        deleted,
        para('ui-world__lead', tr("Take your office to a pixel-art city: a building of your own, lit up while your agents work, and a character to stroll around and visit other people's buildings.")),
        this.privacyLine(),
        para('ui-set__hint', tr('Access opens gradually: new accounts join a waitlist.')),
        h('div', { class: 'ui-world__actions' }, create, login),
      ),
    };
  }

  /** Summary of plan section 3 (what leaves and what never leaves), on terms acceptance screen. */
  private privacySummary(): HTMLElement {
    return h(
      'section',
      { class: 'ui-world__summary', attrs: { 'aria-label': tr('What leaves your computer') } },
      h('h4', { class: 'ui-world__summary-title', text: tr('What leaves your computer') }),
      para(
        'ui-world__official',
        tr('People visiting the world see, live, how many projects and agents you are running and what each character is doing (working, waiting, idle). Nobody sees which projects they are, what the agents are doing, or who you are: only the nickname and the avatar you chose.'),
      ),
      h(
        'ul',
        { class: 'ui-world__list' },
        h('li', {}, h('strong', { text: tr('Sent:') }), ' ', tr("the office theme; one floor per open room, with a random code that changes every day; for each agent, whether it's a main agent or a subagent, its tool, status, appearance, a name drawn at random and the range of tasks completed that day; the building's tokens rounded into ranges (can be turned off); if you turn it on, the fact that an agent compacted its context; the Habblaud version and build commit, with the modified-copy flag; and the interface language, only for emails.")),
        h('li', {}, h('strong', { text: tr('Never sent:') }), ' ', tr("project paths and names, session titles, commands, messages, code, cost, your Claude account, your email and the computer's name.")),
      ),
      para('ui-world__key', tr('From the data that is sent, nobody can tell who you are or what you work on.')),
      para('ui-set__hint', tr("Agents work without you: a lit building doesn't mean you're at the computer. If you prefer, use discreet mode or close the building to visitors.")),
      extLink(tr('See the full list'), WORLD_PRIVACY_URL),
    );
  }

  private buildRegister(): View {
    const email = emailField();
    email.input.value = this.ui.email;
    // Player name (nickname) is chosen at registration: stays reserved for the account on the waitlist and becomes
    // the character's name. Checked here using the same character rules; world server decides (and says if already
    // in use).
    const name = field(
      tr('Player name'),
      textInput('text', 'nickname', { maxlength: PLAYER_NAME_LIMITS.max * 2 }),
      tr("3 to 20 characters; it's your character's name and stays reserved for you, even on the waitlist. Unique in the world."),
    );
    name.input.value = this.ui.name;
    const password = passwordField(tr('Password'), 'new-password', tr('At least 12 characters. A long phrase beats symbols; passwords that have leaked are rejected.'));
    const accept = h('input', { class: 'ui-world__checkbox', type: 'checkbox' });
    const form = new Form(tr('Create account'), () => void submit(), tr('Creating account…'));
    const submit = async () => {
      const mail = normalizeEmail(email.input.value);
      if (!emailLooksValid(mail)) return form.setError(tr('Enter a valid email.'), email.input);
      const parsed = parsePlayerName(name.input.value);
      if (!parsed.ok) return form.setError(nameProblemText(parsed.problem), name.input);
      const problem = passwordProblem(password.input.value, mail);
      if (problem) return form.setError(passwordProblemText(problem), password.input);
      if (!accept.checked) return form.setError(tr('To create the account, accept the Terms of Use and the Privacy Policy.'), accept);
      const r = await this.run(form, 'register', (c) => c.register({ email: mail, password: password.input.value.normalize('NFC'), name: parsed.name, locale: 'en' }), email.input);
      if (!r) return;
      if (r.ok) return this.dispatch({ type: 'code_sent', email: mail, name: parsed.name });
      // Name errors go to the name field (`run` already showed generic error text for the code).
      if (r.code === 'name_taken') form.setError(tr('That name is already taken. Pick another one.'), name.input);
      else if (r.code === 'name_invalid' || r.code === 'name_blocked') form.setError(worldErrorText(r.code, 'register'), name.input);
    };
    form.el.append(
      email.label,
      name.label,
      password.label,
      this.privacySummary(),
      para('ui-world__truth', tr('World only works if the buildings are real. Sending made-up data breaks the terms and gets the account banned.')),
      h(
        'label',
        { class: 'ui-world__accept' },
        accept,
        h('span', {}, ...rich(tr('I have read and accept the {0} and the {1} of Habblaud World.'), [extLink(tr('Terms of Use'), WORLD_TERMS_URL), extLink(tr('Privacy Policy'), WORLD_PRIVACY_URL)])),
      ),
      form.error,
      h('div', { class: 'ui-world__actions' }, form.submit, h('button', { class: 'ui-btn', type: 'button', text: tr('I already have an account'), on: { click: () => this.go('login') } })),
    );
    return { el: h('div', { class: 'ui-world__stack' }, screenHead(tr('Create account'), () => this.go('welcome')), form.el) };
  }

  private buildLogin(): View {
    const email = emailField();
    email.input.value = this.ui.email;
    const password = passwordField(tr('Password'), 'current-password');
    const form = new Form(tr('Sign in'), () => void submit(), tr('Signing in…'));
    const submit = async () => {
      const mail = normalizeEmail(email.input.value);
      if (!emailLooksValid(mail)) return form.setError(tr('Enter a valid email.'), email.input);
      if (!password.input.value) return form.setError(tr('Enter your password.'), password.input);
      const r = await this.run(form, 'login', (c) => c.login({ email: mail, password: password.input.value.normalize('NFC') }), password.input);
      if (!r) return;
      if (r.ok) {
        this.dispatch({ type: 'signed_in' });
        return void this.refresh();
      }
      // Server resent the code: proceeds to email verification.
      if (r.code === 'email_not_verified') this.dispatch({ type: 'code_sent', email: mail });
    };
    const forgot = h('button', {
      class: 'ui-link-btn',
      type: 'button',
      text: tr('Forgot password'),
      on: {
        click: () => {
          this.ui = { ...this.ui, email: normalizeEmail(email.input.value) };
          this.go('forgot');
        },
      },
    });
    form.el.append(email.label, password.label, form.error, h('div', { class: 'ui-world__actions' }, form.submit, forgot));
    return {
      el: h(
        'div',
        { class: 'ui-world__stack' },
        screenHead(tr('Sign in to your account'), () => this.go('welcome')),
        form.el,
        para('ui-set__hint', tr("Don't have an account yet?"), ' ', h('button', { class: 'ui-link-btn', type: 'button', text: tr('Create account'), on: { click: () => this.go('register') } })),
      ),
    };
  }

  /** "Demo: the code is 123456" (only with FakeWorldApi). */
  private demoCodeHint(): HTMLElement | null {
    return this.src.fake ? para('ui-world__demo', tr('Demo: the code is {0}.', [FAKE_CODE])) : null;
  }

  /** "Resend code" button, which waits briefly after use. */
  private resendButton(form: Form, send: (c: WorldClient) => Promise<WorldResult>): { el: HTMLButtonElement; sync(): void } {
    const btn = h('button', { class: 'ui-btn', type: 'button', text: tr('Resend code') });
    const sync = () => {
      btn.disabled = Date.now() < this.resendUntil;
    };
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      const epoch = this.epoch;
      form.setError(null);
      const client = this.client;
      if (!client) return;
      const r = await send(client);
      if (epoch !== this.epoch) return;
      if (r.ok) {
        this.resendUntil = Date.now() + RESEND_COOLDOWN_MS;
        setTimeout(() => this.ctx.invalidate(), RESEND_COOLDOWN_MS + 50);
        this.dispatch({ type: 'flash', flash: 'code_resent' });
      } else form.setError(worldErrorText(r.code, 'resend'));
      sync();
    });
    sync();
    return { el: btn, sync };
  }

  private buildVerify(): View {
    const email = this.ui.email;
    const code = codeField();
    const form = new Form(tr('Confirm email'), () => void submit(), tr('Checking…'));
    const submit = async () => {
      if (!codeLooksValid(code.input.value)) return form.setError(tr('Enter the 6 digits of the code.'), code.input);
      const r = await this.run(form, 'verify', (c) => c.verify({ email, code: normalizeCode(code.input.value) }), code.input);
      if (!r?.ok) return;
      this.dispatch({ type: 'signed_in' });
      void this.refresh();
    };
    const resend = this.resendButton(form, (c) => c.resend({ email }));
    form.el.append(code.label, form.error, h('div', { class: 'ui-world__actions' }, form.submit, resend.el));
    return {
      el: h(
        'div',
        { class: 'ui-world__stack' },
        screenHead(tr('Confirm your email'), () => this.go('welcome')),
        para('ui-world__lead', ...rich(tr("We sent a 6-digit code to {0}. It's valid for 10 minutes."), [h('strong', { class: 'ui-world__email', text: email })])),
        para('ui-set__hint', tr("Didn't get it? Check your spam folder or ask for another one. If this email already had an account, the message says so: just sign in with your password.")),
        this.demoCodeHint(),
        form.el,
        h('button', { class: 'ui-link-btn', type: 'button', text: tr('Use another email'), on: { click: () => this.go('register') } }),
      ),
      sync: resend.sync,
    };
  }

  private buildForgot(): View {
    const email = emailField();
    email.input.value = this.ui.email;
    const form = new Form(tr('Send code'), () => void submit(), tr('Sending…'));
    const submit = async () => {
      const mail = normalizeEmail(email.input.value);
      if (!emailLooksValid(mail)) return form.setError(tr('Enter a valid email.'), email.input);
      const r = await this.run(form, 'forgot', (c) => c.forgotPassword({ email: mail }), email.input);
      if (r?.ok) this.dispatch({ type: 'reset_code_sent', email: mail });
    };
    form.el.append(email.label, form.error, h('div', { class: 'ui-world__actions' }, form.submit));
    return {
      el: h(
        'div',
        { class: 'ui-world__stack' },
        screenHead(tr('Forgot password'), () => this.go('login')),
        para('ui-set__hint', tr("Enter the account's email. If it is registered, you'll get a code to create a new password.")),
        form.el,
      ),
    };
  }

  private buildReset(): View {
    const email = this.ui.email;
    const code = codeField();
    const password = passwordField(tr('New password'), 'new-password', tr('At least 12 characters. A long phrase beats symbols; passwords that have leaked are rejected.'));
    const form = new Form(tr('Change password'), () => void submit(), tr('Changing…'));
    const submit = async () => {
      if (!codeLooksValid(code.input.value)) return form.setError(tr('Enter the 6 digits of the code.'), code.input);
      const problem = passwordProblem(password.input.value, email);
      if (problem) return form.setError(passwordProblemText(problem), password.input);
      const r = await this.run(form, 'reset', (c) => c.resetPassword({ email, code: normalizeCode(code.input.value), password: password.input.value.normalize('NFC') }), code.input);
      if (!r?.ok) return;
      this.dispatch({ type: 'password_changed' });
      void this.refresh();
    };
    const resend = this.resendButton(form, (c) => c.forgotPassword({ email }));
    form.el.append(code.label, password.label, para('ui-set__hint', tr('Changing the password signs out every device on the account.')), form.error, h('div', { class: 'ui-world__actions' }, form.submit, resend.el));
    return {
      el: h(
        'div',
        { class: 'ui-world__stack' },
        screenHead(tr('New password'), () => this.go('login')),
        para('ui-world__lead', ...rich(tr('If {0} has an account, a 6-digit code is on its way. Enter the code and the new password.'), [h('strong', { class: 'ui-world__email', text: email })])),
        this.demoCodeHint(),
        form.el,
      ),
      sync: resend.sync,
    };
  }

  // ---------------------------------------------------------------- with account

  private buildHome(): View {
    const wrap = h('div', { class: 'ui-world__stack' });
    const card = new BuildingCard({
      client: this.client,
      building: () => this.status?.building ?? buildingFromMeta(this.src.meta()?.building),
      hasPlayer: () => !!this.status?.player,
      refresh: () => void this.refresh(),
      openSent: (opener) => void this.sent.open(opener),
      now: () => this.ctx.now(),
      visitOwn: () => {
        const go = this.ctx.visitOwnBuilding;
        return go && this.src.meta()?.scene?.available === true ? () => go() : null;
      },
      accountId: () => this.status?.account?.id,
      maintenance: () => this.status?.lastError === 'maintenance',
    });
    // "Notify me when someone visits" (alert for first visitor of each connection; ui/world/world-chip.ts)
    const notify = switchRow(tr('Notify me when someone visits'), tr('A notice when the first visitor enters your building. You only see how many are inside, never who.'), () =>
      this.ctx.updatePrefs({ worldVisitNotify: !this.ctx.prefs.worldVisitNotify }),
    );
    let rev = -1;
    const sync = () => {
      if (rev !== this.statusRev) {
        rev = this.statusRev;
        wrap.replaceChildren(...this.homeContent(card, notify.row));
      }
      card.sync();
      setAttr(notify.btn, 'aria-checked', String(this.ctx.prefs.worldVisitNotify));
    };
    sync();
    return { el: wrap, sync };
  }

  private homeContent(card: BuildingCard, notifyRow: HTMLElement): Node[] {
    const s = this.status;
    const approved = this.ui.server === 'approved';
    const out: Node[] = [];
    out.push(
      para(
        'ui-world__notice',
        approved ? tr('Access granted!') : tr("You're on the waitlist. We're opening access gradually and will let you know by email when it's your turn."),
      ),
    );
    // World under maintenance (503 `maintenance`): building retries on its own, with backoff.
    // With "Your building" card, it displays the notice (instead of "Reconnecting"); without it
    // (waitlist), dedicated notice is shown.
    const maintenance = s?.lastError === 'maintenance';
    if (maintenance && !approved) out.push(para('ui-world__maint', worldErrorText('maintenance', 'status')));
    // Approved: "Your building" card (connection, counts, pause, what was sent). On waitlist, empty lot.
    if (approved) out.push(card.el);
    else
      out.push(
        h(
          'div',
          { class: 'ui-world__lot' },
          h('span', { class: 'ui-world__lot-art', attrs: { 'aria-hidden': 'true' } }),
          h('span', { class: 'ui-world__lot-text', text: tr('Your building will show up here') }),
        ),
      );

    const player = s?.player;
    if (player?.mustRename) {
      out.push(para('ui-world__warn', tr('Choose a new name: the moderators changed your player name. The new name applies right away, without waiting 30 days.')));
    }
    if (player) {
      const traits = h('span', { class: 'ui-world__traits' }, ...player.traits.filter((t) => TRAITS[t]).map((t) => h('span', { class: 'ui-world__trait', text: `${TRAITS[t].emoji} ${TRAITS[t].label}` })));
      const country = player.country ? countryName(player.country) : player.visibility.hideCountry ? tr('country hidden') : '';
      out.push(
        h(
          'div',
          { class: 'ui-world__player' },
          createAvatar({ seed: 0, look: player.look, kind: 'main', parts: player.parts }, 'lg'),
          h(
            'div',
            { class: 'ui-world__player-text' },
            h('strong', { class: 'ui-world__player-name', text: player.name }),
            h('span', { class: 'ui-world__player-intro', text: `“${introLabel(player.intro)}”` }),
            traits,
            country ? h('span', { class: 'ui-set__hint', text: country }) : null,
          ),
        ),
        h(
          'div',
          { class: 'ui-world__actions' },
          player.mustRename
            ? h('button', { class: 'ui-btn ui-btn--primary', type: 'button', text: tr('Choose new name'), on: { click: () => this.go('character') } })
            : h('button', { class: 'ui-btn', type: 'button', text: tr('Edit character'), on: { click: () => this.go('character') } }),
        ),
      );
    } else {
      // Player name chosen at registration, reserved while character does not exist.
      const reserved = s?.account?.reservedName;
      if (reserved) out.push(para('ui-world__reserved', ...rich(tr('Your player name: {0} (reserved)'), [h('strong', { class: 'ui-world__player-name', text: reserved })])));
      out.push(
        para('ui-set__hint', approved ? tr('Create your character to enter the world.') : tr('While you wait, you can already create your character.')),
        h('div', { class: 'ui-world__actions' }, h('button', { class: 'ui-btn ui-btn--primary', type: 'button', text: tr('Create my character'), attrs: { 'data-world': 'create-character' }, on: { click: () => this.go('character') } })),
      );
    }

    const nav = h('div', { class: 'ui-world__nav' });
    if (player) {
      const v = player.visibility;
      const summary = [v.mode === 'discreet' ? tr('Discreet') : tr('Live'), v.closed ? tr('closed to visitors') : null].filter(Boolean).join(' · ');
      nav.append(this.navRow(tr('Building visibility'), summary, () => this.go('visibility')));
    }
    const devices = s?.devices?.length;
    nav.append(this.navRow(tr('Devices'), devices ? tr('{0} of 3', [devices]) : '', () => this.go('devices')));
    if (player && approved) nav.append(this.navRow(tr('Blocked'), s?.blocked?.length ? String(s.blocked.length) : '', () => this.go('blocked')));
    nav.append(this.navRow(tr('Account and data'), '', () => this.go('account')));
    out.push(nav);
    if (approved && player) out.push(notifyRow);

    if (s?.lastError && !maintenance) out.push(para('ui-world__warn', tr('Last problem with the world: {0}', [worldErrorText(s.lastError, 'status')])));

    out.push(this.signOutRow());
    if (s?.account) out.push(para('ui-set__hint ui-world__email', tr('Account: {0}', [s.account.emailMasked])));
    out.push(h('p', { class: 'ui-world__links' }, extLink(tr('Terms of Use'), WORLD_TERMS_URL), extLink(tr('Privacy Policy'), WORLD_PRIVACY_URL)));
    return out;
  }

  private navRow(label: string, value: string, onClick: () => void): HTMLButtonElement {
    return h(
      'button',
      { class: 'ui-world__navrow', type: 'button', on: { click: onClick } },
      h('span', { class: 'ui-set__label', text: label }),
      h('span', { class: 'ui-world__navval', text: value }),
      h('span', { class: 'ui-world__chev', text: '›', attrs: { 'aria-hidden': 'true' } }),
    );
  }

  /** "Sign out" in two clicks (second click confirms). */
  private signOutRow(): HTMLElement {
    let confirming = false;
    const btn = h('button', { class: 'ui-btn', type: 'button', text: tr('Sign out') });
    const hint = h('span', { class: 'ui-set__hint', text: tr('This computer stops joining the world; your account and character stay.') });
    const error = h('p', { class: 'ui-world__error', role: 'alert', hidden: true });
    btn.addEventListener('click', async () => {
      if (!confirming) {
        confirming = true;
        setText(btn, tr('Confirm: sign out'));
        btn.classList.add('is-danger');
        return;
      }
      const client = this.client;
      if (!client) return;
      btn.disabled = true;
      setAttr(btn, 'aria-busy', 'true');
      const epoch = this.epoch;
      const r = await client.logout();
      if (epoch !== this.epoch) return;
      btn.disabled = false;
      setAttr(btn, 'aria-busy', null);
      if (!r.ok) {
        setText(error, worldErrorText(r.code, 'logout'));
        setHidden(error, false);
        return;
      }
      this.dispatch({ type: 'flash', flash: 'signed_out' });
      void this.refresh();
    });
    return h('div', { class: 'ui-world__signout' }, h('div', { class: 'ui-set' }, h('div', { class: 'ui-set__text' }, hint), btn), error);
  }

  private buildCharacter(): View {
    const player = this.status?.player;
    let look: 'f' | 'm' = player?.look ?? (randomSeed() % 2 ? 'm' : 'f');
    let traits: TraitId[] = player ? player.traits.filter((t): t is TraitId => (TRAIT_IDS as readonly string[]).includes(t)) : [];
    const fields = new AppearanceFields();
    fields.set(player ? draftAppearance(look, player.parts) : draftAppearance(look, undefined, randomSeed()));

    const name = h('input', { class: 'ui-char__name', type: 'text', attrs: { maxlength: PLAYER_NAME_LIMITS.max * 2, autocomplete: 'nickname', spellcheck: 'false', 'aria-describedby': 'ui-world-name-hint' } });
    // Name forcibly changed by moderation ("???"): field starts empty and receives focus.
    const rename = player?.mustRename === true;
    // Creating with name reserved at registration: field shows reserved name and is read-only (request sent without
    // `name`; world server uses reservation). Legacy account without reservation chooses name here, as before.
    const reserved = !player ? this.status?.account?.reservedName : undefined;
    name.value = rename ? '' : (player?.name ?? reserved ?? '');
    if (reserved) {
      name.readOnly = true;
      name.classList.add('is-fixed');
    }
    if (rename) requestAnimationFrame(() => name.isConnected && name.focus());
    const roll = h('button', {
      class: 'ui-btn ui-btn--sm',
      type: 'button',
      text: tr('Randomize'),
      title: tr('Randomize another look (undoes the pieces you chose)'),
      on: { click: () => fields.set(draftAppearance(look, undefined, randomSeed())) },
    });

    const lookSeg = segmented<'f' | 'm'>(
      tr('Visual hint'),
      [
        ['f', tr('Feminine')],
        ['m', tr('Masculine')],
      ],
      (v) => {
        look = v;
        lookSeg.set(v);
        const a = fields.value;
        if (a) fields.set({ ...a, look: v } satisfies Appearance);
      },
    );
    lookSeg.set(look);
    lookSeg.row.append(h('span', { class: 'ui-set__hint', text: tr('Changes face details and the random pick of hair and clothes; you can change everything in the pieces below.') }));

    // Traits: 2 or 3; those clashing with chosen ones (and all, once 3 are chosen) become disabled.
    const count = h('span', { class: 'ui-world__count' });
    const chips = new Map<TraitId, HTMLButtonElement>();
    const syncTraits = () => {
      setText(count, tr('{0} of 3', [traits.length]));
      for (const [t, b] of chips) {
        const on = traits.includes(t);
        const block = traitBlock(traits, t);
        setAttr(b, 'aria-pressed', String(on));
        setAttr(b, 'aria-disabled', block ? 'true' : null);
        b.title = block ? (block.reason === 'full' ? tr("That's 3 traits already: unselect one to swap.") : tr("Doesn't go with {0}.", [TRAITS[block.with].label])) : TRAITS[t].desc;
      }
    };
    for (const t of TRAIT_IDS) {
      const info = TRAITS[t];
      const b = h('button', { class: 'ui-world__trait-opt', type: 'button', text: `${info.emoji} ${info.label}` });
      b.addEventListener('click', () => {
        if (b.getAttribute('aria-disabled') === 'true') return;
        traits = toggleTrait(traits, t);
        syncTraits();
      });
      chips.set(t, b);
    }
    syncTraits();

    const intro = h('select', { class: 'ui-world__select', attrs: { 'aria-label': tr('Intro phrase') } });
    intro.append(h('option', { text: tr('Pick a phrase…'), attrs: { value: '' } }));
    for (const id of INTRO_IDS) intro.append(h('option', { text: introLabel(id), attrs: { value: id } }));
    intro.value = player?.intro ?? '';

    const form = new Form(tr('Save character'), () => void submit(), tr('Saving…'));
    const traitsBox = h('div', { class: 'ui-world__traitopts', role: 'group', attrs: { 'aria-label': tr('Personality') } }, ...chips.values());
    const submit = async () => {
      const a = fields.value;
      if (!a) return;
      const chosen = isIntroId(intro.value) ? (intro.value as IntroId) : null;
      const problem = characterProblem({ name: reserved ?? name.value, traits, intro: chosen });
      if (problem?.field === 'name') return form.setError(nameProblemText(problem.problem), name);
      if (problem?.field === 'traits') return form.setError(tr('Pick 2 or 3 personality traits.'), chips.get(TRAIT_IDS[0]));
      if (problem || !chosen) return form.setError(tr('Pick an intro phrase.'), intro);
      const parsed = parsePlayerName(name.value);
      const body = { ...(reserved ? {} : { name: parsed.ok ? parsed.name : name.value }), look, parts: fullParts(a), traits: [...traits], intro: chosen };
      const r = await this.run(form, 'character', (c) => c.saveCharacter(body), name);
      if (!r?.ok) return;
      this.dispatch({ type: 'go', screen: 'home' });
      this.dispatch({ type: 'flash', flash: 'character_saved' });
      void this.refresh();
    };
    form.el.append(
      rename ? para('ui-world__warn', tr('Choose a new name')) : '',
      h(
        'div',
        { class: 'ui-char__top' },
        fields.preview,
        h('div', { class: 'ui-char__head' }, h('label', { class: 'ui-char__label' }, h('span', { text: tr('Player name') }), name), roll),
      ),
      reserved
        ? para('ui-set__hint', h('span', { attrs: { id: 'ui-world-name-hint' } }, tr('Chosen at sign-up. You can change it later, once every 30 days.')))
        : para(
            'ui-set__hint',
            h('span', { attrs: { id: 'ui-world-name-hint' } }, tr("3 to 20 characters: letters from a single alphabet, numbers, space, _ - and . It's your name in the world and can't match anyone else's.")),
            rename ? ` ${tr('This time the new name applies right away, without waiting 30 days.')}` : player ? ` ${tr('It can be changed once every 30 days.')}` : '',
          ),
      lookSeg.row,
      fields.groups,
      h(
        'fieldset',
        { class: 'ui-char__group ui-world__traitset' },
        h('legend', {}, tr('Personality'), ' ', count),
        para('ui-set__hint', tr("Pick 2 or 3 traits. The ones that don't go with those already picked are dimmed.")),
        traitsBox,
      ),
      h('label', { class: 'ui-world__field' }, h('span', { class: 'ui-world__label', text: tr('Intro phrase') }), intro, h('span', { class: 'ui-set__hint', text: tr("Shows on your profile, translated for whoever reads it. Besides your name, there's no free text in the world.") })),
      form.error,
      h('div', { class: 'ui-world__actions' }, form.submit, h('button', { class: 'ui-btn', type: 'button', text: tr('Cancel'), on: { click: () => this.go('home') } })),
    );
    return { el: h('div', { class: 'ui-world__stack ui-world__character' }, screenHead(player ? tr('Edit character') : tr('Create character'), () => this.go('home')), form.el) };
  }

  private buildVisibility(): View {
    const player = this.status?.player;
    if (!player) return { el: h('div', { class: 'ui-world__stack' }, screenHead(tr('Building visibility'), () => this.go('home')), para('ui-set__hint', tr('Available after you create your character.'))) };
    let vis: WorldVisibility = { ...DEFAULT_VISIBILITY, ...player.visibility };
    let saving = false;
    const error = h('p', { class: 'ui-world__error', role: 'alert', hidden: true });
    const switches = new Map<VisibilitySwitch, HTMLButtonElement>();
    const save = async (next: WorldVisibility) => {
      const client = this.client;
      if (saving || !client) return;
      const prev = vis;
      vis = next;
      saving = true;
      setHidden(error, true);
      sync();
      const epoch = this.epoch;
      const r = await client.saveVisibility(next);
      if (epoch !== this.epoch) return;
      saving = false;
      if (!r.ok) {
        vis = prev;
        setText(error, worldErrorText(r.code, 'visibility'));
        setHidden(error, false);
      } else void this.refresh();
      sync();
    };
    const mode = segmented<WorldVisibility['mode']>(
      tr('Building mode'),
      [
        ['live', tr('Live')],
        ['discreet', tr('Discreet')],
      ],
      (v) => void save({ ...vis, mode: v }),
    );
    mode.row.append(h('span', { class: 'ui-set__hint', text: tr('Live: floors, counters and what each character is doing, in real time. Discreet: only lit or dark and the number of floors.') }));
    const rows = VISIBILITY_SWITCHES.map((key) => {
      const t = visibilityText(key);
      const r = switchRow(t.label, t.hint, () => void save({ ...vis, [key]: !vis[key] }));
      switches.set(key, r.btn);
      return r.row;
    });
    const country = h('p', { class: 'ui-set__hint' });
    const sync = () => {
      mode.set(vis.mode);
      for (const [key, btn] of switches) {
        setAttr(btn, 'aria-checked', String(vis[key]));
        btn.disabled = saving;
      }
      const code = this.status?.player?.country;
      setText(country, vis.hideCountry ? tr('Country: hidden (a neutral flag shows).') : code ? tr('Country seen on the last connection: {0}.', [countryName(code)]) : tr('Country: shows after the first connection to the world.'));
    };
    sync();
    return {
      el: h(
        'div',
        { class: 'ui-world__stack' },
        screenHead(tr('Building visibility'), () => this.go('home')),
        mode.row,
        ...rows,
        country,
        error,
        para('ui-set__hint', tr('Changes apply right away.')),
      ),
    };
  }

  /** Phase 5: blocked accounts, with Unblock (blocked.ts). List is refetched from /v1/me on open. */
  private buildBlocked(): View {
    const epoch = this.epoch;
    return buildBlocked(screenHead(tr('Blocked'), () => this.go('home')), {
      client: this.client,
      list: () => this.status?.blocked,
      refresh: () => this.refresh(true),
      current: () => epoch === this.epoch,
      announce: (t) => this.ctx.announce(t),
    });
  }

  private buildDevices(): View {
    const list = h('ul', { class: 'ui-world__devices' });
    const note = h('p', { class: 'ui-set__hint', text: tr('Loading…') });
    const error = h('p', { class: 'ui-world__error', role: 'alert', hidden: true });
    let devices: WorldDevice[] | null = this.status?.devices ?? null;
    const draw = () => {
      setHidden(note, !!devices);
      if (!devices) return;
      list.replaceChildren(...devices.map((d) => this.deviceRow(d, error, (id) => {
        devices = (devices ?? []).filter((x) => x.id !== id);
        draw();
      })));
    };
    const load = async () => {
      const client = this.client;
      if (!client) return;
      const epoch = this.epoch;
      const r = await client.devices();
      if (epoch !== this.epoch) return;
      if (r.ok) {
        devices = r.data;
        setHidden(error, true);
      } else if (!devices) {
        setText(error, worldErrorText(r.code, 'devices'));
        setHidden(error, false);
        setHidden(note, true);
      }
      draw();
    };
    draw();
    void load();
    return {
      el: h(
        'div',
        { class: 'ui-world__stack' },
        screenHead(tr('Devices'), () => this.go('home')),
        para('ui-set__hint', tr('Up to 3 per account. Revoking signs the device out right away; to come back, it signs in again with the password.')),
        note,
        list,
        error,
      ),
    };
  }

  private deviceRow(d: WorldDevice, error: HTMLElement, onRevoked: (id: string) => void): HTMLElement {
    const now = Date.now();
    const created = toMillis(d.createdAt);
    const seen = toMillis(d.lastSeenAt);
    const meta = [created ? tr('signed in on {0}', [formatDateTime(created)]) : null, !d.current && seen ? tr('last seen {0}', [relativeTime(seen, now)]) : null].filter(Boolean).join(' · ');
    const head = h('span', { class: 'ui-world__device-name' }, deviceLabel(d.label), d.current ? h('span', { class: 'ui-world__tag', text: tr('this computer') }) : null);
    const text = h('div', { class: 'ui-set__text' }, head, meta ? h('span', { class: 'ui-set__hint', text: meta }) : null);
    if (d.current) return h('li', { class: 'ui-set ui-world__device' }, text);
    let confirming = false;
    const btn = h('button', { class: 'ui-btn ui-btn--sm', type: 'button', text: tr('Revoke'), attrs: { 'aria-label': tr('Revoke {0}', [deviceLabel(d.label)]) } });
    btn.addEventListener('click', async () => {
      if (!confirming) {
        confirming = true;
        setText(btn, tr('Confirm'));
        btn.classList.add('is-danger');
        return;
      }
      const client = this.client;
      if (!client) return;
      btn.disabled = true;
      setAttr(btn, 'aria-busy', 'true');
      const epoch = this.epoch;
      const r = await client.revokeDevice(d.id);
      if (epoch !== this.epoch) return;
      btn.disabled = false;
      setAttr(btn, 'aria-busy', null);
      if (!r.ok) {
        setText(error, worldErrorText(r.code, 'revoke'));
        setHidden(error, false);
        return;
      }
      onRevoked(d.id);
      this.dispatch({ type: 'flash', flash: 'device_revoked' });
      void this.refresh();
    });
    return h('li', { class: 'ui-set ui-world__device' }, text, btn);
  }

  // ---------------------------------------------------------------- account and data (Phase 6)

  /**
   * "Account and data": inactivity warning (with character: goes into visibility), "Download my data" (account JSON,
   * once per day), and "Delete account" in three steps. View mounted once: refetched status mid-way won't erase
   * entered code; `sync` only updates the switch.
   */
  private buildAccount(): View {
    const inactivity = this.inactivitySection();
    const exportBox = this.exportSection();
    const deletion = this.deletionSection();
    return {
      el: h(
        'div',
        { class: 'ui-world__stack' },
        screenHead(tr('Account and data'), () => this.go('home')),
        inactivity.el,
        exportBox,
        deletion,
        para('ui-set__hint', tr('Questions or requests about your data: {0}.', [APPEAL_EMAIL])),
      ),
      sync: inactivity.sync,
    };
  }

  /** Switch for email warning before building is removed for inactivity. */
  private inactivitySection(): { el: HTMLElement; sync(): void } {
    let pending: boolean | null = null;
    const error = h('p', { class: 'ui-world__error', role: 'alert', hidden: true });
    const sw = switchRow(
      tr('E-mail me before my building is removed for inactivity'),
      tr('With no word from this Habblaud for 7 days, the building disappears from the map and, 30 days later, is removed. The e-mail arrives 3 days before the removal.'),
      () => void toggle(),
    );
    const noPlayer = para('ui-set__hint', tr('The inactivity warning becomes available after you create the character.'));
    const sync = () => {
      const player = this.status?.player;
      setHidden(sw.row, !player);
      setHidden(noPlayer, !!player);
      setAttr(sw.btn, 'aria-checked', String(pending ?? notifyInactivityOn(player?.visibility)));
      sw.btn.disabled = pending !== null;
    };
    const toggle = async () => {
      const client = this.client;
      const player = this.status?.player;
      if (!client || !player || pending !== null) return;
      const next = !notifyInactivityOn(player.visibility);
      pending = next;
      setHidden(error, true);
      sync();
      const epoch = this.epoch;
      const r = await client.saveVisibility({ ...DEFAULT_VISIBILITY, ...player.visibility, notifyInactivity: next });
      if (epoch !== this.epoch) return;
      pending = null;
      if (!r.ok) {
        setText(error, worldErrorText(r.code, 'inactivity'));
        setHidden(error, false);
      } else {
        // Until status arrives, switch reflects what was saved.
        const p = this.status?.player;
        if (p) p.visibility = { ...p.visibility, notifyInactivity: next };
        void this.refresh();
      }
      sync();
    };
    sync();
    return { el: h('section', { class: 'ui-world__acct' }, h('h4', { class: 'ui-world__acct-title', text: tr('Alerts') }), sw.row, noPlayer, error), sync };
  }

  /** "Download my data": requests JSON from local server and saves as habblaud-world-dados.json. */
  private exportSection(): HTMLElement {
    const btn = h('button', { class: 'ui-btn', type: 'button', text: tr('Download my data') });
    const note = h('p', { class: 'ui-set__hint', role: 'status', hidden: true });
    const error = h('p', { class: 'ui-world__error', role: 'alert', hidden: true });
    btn.addEventListener('click', async () => {
      const client = this.client;
      if (!client || btn.disabled) return;
      btn.disabled = true;
      setAttr(btn, 'aria-busy', 'true');
      setHidden(error, true);
      setHidden(note, true);
      const epoch = this.epoch;
      const r = await client.exportData();
      if (epoch !== this.epoch) return;
      btn.disabled = false;
      setAttr(btn, 'aria-busy', null);
      if (!r.ok) {
        setText(error, worldErrorText(r.code, 'export'));
        setHidden(error, false);
        return;
      }
      saveFile(this.el, r.data, EXPORT_FILENAME);
      setText(note, tr('Done: the file {0} went to your downloads folder.', [EXPORT_FILENAME]));
      setHidden(note, false);
    });
    return h(
      'section',
      { class: 'ui-world__acct' },
      h('h4', { class: 'ui-world__acct-title', text: tr('Your data') }),
      para(
        'ui-set__hint',
        tr('A JSON file with what Habblaud World keeps about your account: e-mail, dates, character, visibility, devices, building, likes given, blocks and reports you made. You can download it once a day.'),
      ),
      h('div', { class: 'ui-world__actions' }, btn),
      note,
      error,
    );
  }

  /** "Delete account" in three steps: what is removed and when; confirmation (sends code); email code. */
  private deletionSection(): HTMLElement {
    const box = h('div', { class: 'ui-world__stack' });
    const email = () => this.status?.account?.emailMasked ?? '';
    const explain = () => {
      const next = h('button', { class: 'ui-btn', type: 'button', text: tr('Delete account…'), on: { click: () => show(confirm()) } });
      return [
        para('ui-set__hint', tr('Deleting the account takes you out of Habblaud World:')),
        h(
          'ul',
          { class: 'ui-world__list' },
          h('li', {}, h('strong', { text: tr('Right away:') }), ' ', tr('the building and the profile disappear from the world, and this computer signs out of the account.')),
          h('li', {}, h('strong', { text: tr('Within 7 days:') }), ' ', tr('the account, the character, the likes given and received, the blocks, the reports you made and the devices are deleted from the database.')),
          h('li', {}, h('strong', { text: tr('Within 30 days:') }), ' ', tr('they also disappear from the backups.')),
        ),
        para('ui-set__hint', tr('If you want to keep a copy, download your data first.')),
        h('div', { class: 'ui-world__actions' }, next),
      ];
    };
    const confirm = () => {
      const form = new Form(tr('Send the code'), () => void send(), tr('Sending…'));
      form.submit.classList.add('is-danger');
      const send = async () => {
        const r = await this.run(form, 'delete', (c) => c.requestAccountDeletion());
        if (r?.ok) show(code());
      };
      form.el.append(
        para('ui-world__warn', tr('Are you sure? The building and the profile leave the world as soon as you enter the code.')),
        para('ui-set__hint', ...rich(tr("To confirm, we send a 6-digit code to the account's e-mail ({0})."), [h('strong', { class: 'ui-world__email', text: email() })])),
        form.error,
        h('div', { class: 'ui-world__actions' }, form.submit, h('button', { class: 'ui-btn', type: 'button', text: tr('Cancel'), on: { click: () => show(explain()) } })),
      );
      return [form.el];
    };
    const code = () => {
      const field = codeField();
      const form = new Form(tr('Delete the account'), () => void submit(), tr('Deleting…'));
      form.submit.classList.add('is-danger');
      const submit = async () => {
        if (!codeLooksValid(field.input.value)) return form.setError(tr('Enter the 6 digits of the code.'), field.input);
        const r = await this.run(form, 'delete', (c) => c.confirmAccountDeletion({ code: normalizeCode(field.input.value) }), field.input);
        if (!r?.ok) return;
        this.ctx.announce(worldErrorText('account_deleted', 'status'));
        void this.refresh();
      };
      const resend = this.resendButton(form, (c) => c.requestAccountDeletion());
      form.el.append(
        para('ui-world__lead', ...rich(tr('We sent a 6-digit code to {0}. Enter the code to delete the account.'), [h('strong', { class: 'ui-world__email', text: email() })])),
        this.demoCodeHint() ?? '',
        field.label,
        form.error,
        h('div', { class: 'ui-world__actions' }, form.submit, resend.el, h('button', { class: 'ui-btn', type: 'button', text: tr('Cancel'), on: { click: () => show(explain()) } })),
      );
      requestAnimationFrame(() => field.input.isConnected && field.input.focus());
      return [form.el];
    };
    const show = (nodes: (Node | string)[]) => box.replaceChildren(...nodes);
    show(explain());
    return h('section', { class: 'ui-world__acct ui-world__acct--danger' }, h('h4', { class: 'ui-world__acct-title', text: tr('Delete account') }), box);
  }
}

/** Saves text as a file (temporary link stays inside section so nothing outside receives the click). */
function saveFile(host: HTMLElement, text: string, filename: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
  const a = h('a', { hidden: true, attrs: { href: url, download: filename } });
  host.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}
