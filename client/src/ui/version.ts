// Habblaud version: the number in the topbar, the "New version" badge when GitHub has a newer
// release (checked by the server, server/updates/checker.ts), one-off notice per version, and the "About"
// settings section (check status, "Check now", what's new and how to update).
import type { Notice, OfficeSnapshot, UpdateStatus } from '../../../shared/types';
import type { UiComponent, UiContext } from './context';
import { h, setAttr, setHidden, setText, setTitle, setVariant } from './dom';
import { formatDateTime, relativeTime } from './format';
import { pixelIcon } from './icons';
import { safeLocalStorage } from './prefs';
import { tr } from '../../../shared/i18n';

/** Latest new version already notified in this browser (notice shown once per version). */
export const UPDATE_SEEN_KEY = 'habblaud:update-seen';

export const VERSION_ICONS = {
  up: pixelIcon(['...##...', '..####..', '.######.', '########', '..####..', '..####..', '..####..', '..####..']),
};

/** In-use version and check result, from live snapshot (no real version in timelapse and ?mock=1). */
export function versionInfo(snap: OfficeSnapshot | null | undefined): { version: string; updates?: UpdateStatus } | null {
  const v = snap?.meta.version;
  if (!v || !/^\d+\.\d+\.\d+/.test(v)) return null;
  return { version: v, updates: snap.meta.updates };
}

/** Only GitHub links become clickable links on the page. */
export function safeGithubUrl(url: string | undefined): string | undefined {
  return url && /^https:\/\/github\.com\/[^\s"'<>]+$/.test(url) ? url : undefined;
}

export type UpdateTone = 'new' | 'ok' | 'pending' | 'warn' | 'off';

/** Status line for the "About" section. */
export function updateStatusLine(version: string, s: UpdateStatus | undefined, now: number): { tone: UpdateTone; text: string } {
  if (!s) return { tone: 'off', text: tr("This server doesn't check for new versions.") };
  const checked = s.checkedAt ? ` · verificado ${relativeTime(s.checkedAt, now)}` : '';
  switch (s.state) {
    case 'off':
      return {
        tone: 'off',
        text: s.repo
          ? tr('New version check is off (HABBLAUD_UPDATE_CHECK=0).')
          : tr("New version check is off: package.json doesn't point to a GitHub repository."),
      };
    case 'pending':
      return { tone: 'pending', text: tr('Checking for a new version…') };
    case 'error':
      if (s.available && s.latest) return { tone: 'new', text: tr('New version available: v{0}. The last check failed ({1}).', [s.latest, s.error ?? tr('error')]) };
      return { tone: 'warn', text: tr("Couldn't check right now: {0}{1}.", [s.error ?? tr('unknown error'), s.checkedAt ? tr(' · last checked {0}', [relativeTime(s.checkedAt, now)]) : '']) };
    case 'ok':
      if (s.available && s.latest) return { tone: 'new', text: tr('New version available: v{0}{1}.', [s.latest, s.publishedAt ? tr(', released {0}', [formatDateTime(s.publishedAt)]) : '']) };
      if (!s.latest) return { tone: 'ok', text: tr('No version published on GitHub yet{0}.', [checked]) };
      if (s.latest !== version) return { tone: 'ok', text: tr("You're ahead of the latest published version (v{0}){1}.", [s.latest, checked]) };
      return { tone: 'ok', text: tr("You're on the latest version{0}.", [checked]) };
  }
}

/** Tooltip for the version number in the topbar. */
export function versionChipTitle(version: string, s: UpdateStatus | undefined, now: number): string {
  if (s?.available && s.latest) return tr("New Habblaud version: v{0} (you're on v{1}). Click to see what's new and how to update.", [s.latest, version]);
  return tr('Habblaud v{0}. {1} Click for details.', [version, updateStatusLine(version, s, now).text]);
}

/** Version number in the topbar; becomes "New version" badge when there is a newer release. */
export class VersionChip implements UiComponent {
  readonly el: HTMLButtonElement;
  private text: HTMLElement;

  constructor(
    private ctx: UiContext,
    private settingsBtn: HTMLElement,
  ) {
    const icon = h('span', { class: 'ui-version__icon', attrs: { 'aria-hidden': 'true' } });
    icon.innerHTML = VERSION_ICONS.up;
    this.text = h('span', { class: 'ui-version__text' });
    this.el = h('button', { class: 'ui-version', type: 'button', hidden: true, on: { click: () => ctx.openAbout() } }, icon, this.text);
  }

  render(): void {
    const info = versionInfo(this.ctx.store.liveSnapshot);
    setHidden(this.el, !info);
    const fresh = !!info?.updates?.available && !!info.updates.latest;
    this.settingsBtn.classList.toggle('has-update', fresh);
    const label = fresh ? tr('Settings (new version available)') : tr('Settings');
    setAttr(this.settingsBtn, 'aria-label', label);
    setTitle(this.settingsBtn, label);
    if (!info) return;
    this.el.classList.toggle('is-new', fresh);
    setText(this.text, fresh ? tr('New version') : `v${info.version}`);
    const title = versionChipTitle(info.version, info.updates, this.ctx.now());
    setTitle(this.el, title);
    setAttr(this.el, 'aria-label', title);
  }
}

/** Notifies (once per version, in this browser) when a new version appears. */
export class UpdateToaster implements UiComponent {
  constructor(
    private ctx: UiContext,
    private push: (n: Notice) => void,
  ) {}

  private shown: string | undefined;

  render(): void {
    if (this.ctx.store.connection !== 'open') return;
    const s = versionInfo(this.ctx.store.liveSnapshot)?.updates;
    if (!s?.available || !s.latest || this.shown === s.latest) return;
    this.shown = s.latest;
    const storage = safeLocalStorage();
    try {
      if (storage?.getItem(UPDATE_SEEN_KEY) === s.latest) return;
      storage?.setItem(UPDATE_SEEN_KEY, s.latest);
    } catch {
      // No storage: notifies once per opened page.
    }
    this.push({ id: `update:${s.latest}`, level: 'success', text: tr("New Habblaud version: v{0}. See what's new and how to update in Settings › About.", [s.latest]), at: this.ctx.now() });
  }
}

/** "About" settings section. */
export class AboutGroup {
  readonly el: HTMLElement;
  private name: HTMLElement;
  private status: HTMLElement;
  private checkBtn: HTMLButtonElement;
  private fresh: HTMLElement;
  private notes: HTMLAnchorElement;
  private repo: HTMLAnchorElement;
  private checking = false;
  private failure: string | undefined;

  constructor(private ctx: UiContext) {
    this.name = h('strong', { class: 'ui-about__version' });
    this.checkBtn = h('button', { class: 'ui-btn ui-btn--sm', type: 'button', text: tr('Check now'), on: { click: () => void this.check() } });
    this.status = h('p', { class: 'ui-about__status', role: 'status' });
    this.notes = h('a', { class: 'ui-link-btn', attrs: { target: '_blank', rel: 'noopener noreferrer' } });
    this.fresh = h(
      'div',
      { class: 'ui-about__new', hidden: true },
      this.notes,
      h(
        'p',
        { class: 'ui-set__hint' },
        tr('To update, in the Habblaud folder: '),
        h('code', { class: 'ui-usage-setup__cmd', text: 'git pull' }),
        tr(' and then '),
        h('code', { class: 'ui-usage-setup__cmd', text: 'npm run docker:up' }),
        tr(' (without Docker: '),
        h('code', { class: 'ui-usage-setup__cmd', text: 'npm run build && npm start' }),
        ').',
      ),
    );
    this.repo = h('a', { class: 'ui-link-btn', text: tr('Code on GitHub'), attrs: { target: '_blank', rel: 'noopener noreferrer' } });
    this.el = h(
      'div',
      { class: 'ui-set-group ui-about', attrs: { id: 'ui-about' } },
      h('h3', { text: tr('About'), tabIndex: -1 }),
      h('div', { class: 'ui-about__head' }, h('span', { class: 'ui-about__name' }, 'Habblaud ', this.name), this.checkBtn),
      this.status,
      this.fresh,
      this.repo,
    );
  }

  render(): void {
    const info = versionInfo(this.ctx.store.liveSnapshot);
    setHidden(this.el, !info);
    if (!info) return;
    const s = info.updates;
    setText(this.name, `v${info.version}`);
    const line = this.failure ? { tone: 'warn' as const, text: this.failure } : updateStatusLine(info.version, s, this.ctx.now());
    setText(this.status, this.checking ? tr('Checking GitHub…') : line.text);
    setVariant(this.status, 'is-', this.checking ? 'pending' : line.tone);
    setHidden(this.checkBtn, !s || s.state === 'off');
    this.checkBtn.disabled = this.checking || this.ctx.store.connection !== 'open';

    const fresh = !!s?.available && !!s.latest;
    setHidden(this.fresh, !fresh);
    if (fresh) {
      setText(this.notes, tr('See what changed in v{0}', [s!.latest]));
      const url = safeGithubUrl(s!.url);
      setHidden(this.notes, !url);
      if (url) setAttr(this.notes, 'href', url);
    }
    const repoUrl = s?.repo ? safeGithubUrl(`https://github.com/${s.repo}`) : undefined;
    setHidden(this.repo, !repoUrl);
    if (repoUrl) setAttr(this.repo, 'href', repoUrl);
  }

  /** Scrolls to the section and highlights it briefly (clicking the version number). */
  highlight(): void {
    this.el.scrollIntoView({ block: 'nearest' });
    this.el.classList.remove('is-highlight');
    void this.el.offsetWidth;
    this.el.classList.add('is-highlight');
  }

  private async check(): Promise<void> {
    if (this.checking) return;
    this.checking = true;
    this.failure = undefined;
    this.render();
    try {
      if (!(await this.ctx.store.checkUpdates())) this.failure = tr("Couldn't reach the Habblaud server.");
    } catch {
      this.failure = tr("Couldn't reach the Habblaud server.");
    } finally {
      this.checking = false;
      this.render();
      this.ctx.invalidate();
    }
  }
}
