// The office tabs, a strip above the top bar like a browser's tabs: pick the office shown (remembered in this browser;
// ctx.selectOffice), ＋ after the last tab makes a new one, ⋯ (right end) or a double click on a tab edits it. An office
// is one team in ONE project folder (ui/offices.ts); the sidebar, the Board, the quota and the dimming of the pixel office
// follow it. Shown only when the server keeps offices (team.offices); without them the strip takes no room.
// The office dialog (＋ and ⋯): a name and a folder (recent projects, or a full path typed in); editing also offers
// "Delete this office" (its boss steps down and its running jobs are cancelled; the last office cannot go).
// An office without a folder (carried over from the old team) gets a quiet "📁 Choose its folder" before ⋯.
// A right click (long press, ContextMenu key, Shift+F10) on a tab opens its menu (ui/office-menu.ts).
import type { OfficeInfo } from '../../../shared/types';
import type { UiComponent, UiContext } from './context';
import { copyText, h, iconButton, KeyedList, setAttr, setHidden, setText, setTitle } from './dom';
import { ICONS } from './icons';
import { OfficeMenu, type OfficeMenuEnv } from './office-menu';
import { folderOverlap, folderProblem, normFolder, teamOffices } from './offices';
import { scopeLine } from './rules-model';
import { loadFolders, shortPath, spawnFolders, type FolderOption } from './spawn';
import { folderChoices, folderTaken, folderWhy } from './team-dialogs';
import { createOffice, deleteOffice, renameOffice, setOfficeFolder } from './workers-api';
import { tr } from '../../../shared/i18n';

/** A touch held this long opens the tab's menu (where no contextmenu event comes, e.g. iOS). */
const LONG_PRESS_MS = 550;

/** Longest office name. */
const NAME_MAX = 40;

/** "/home/me/Workspace/Habblaud" -> "Habblaud" (the default name of a new office). */
export function folderName(path: string): string {
  return normFolder(path).split(/[\\/]/).pop() || path;
}

export class OfficeTabs implements UiComponent {
  readonly el: HTMLElement;
  readonly dialog: OfficeDialog;
  readonly menu: OfficeMenu;
  /** Opens the Board (on the office shown); set by ui/index.ts. */
  onOpenBoard?: () => void;
  /** Opens the 📜 Rules dialog of an office; set by ui/index.ts. */
  onOpenRules?: (officeId: string) => void;
  /** The sidebar's ＋ Boss / ＋ Worker (on the office shown), and why each cannot be used now ('' = it can). */
  team?: { open: (kind: 'boss' | 'workers') => void; blocked: (kind: 'boss' | 'workers') => string };
  private readonly tabs: KeyedList<OfficeInfo, HTMLButtonElement>;
  private readonly edit: HTMLButtonElement;
  private readonly add: HTMLButtonElement;
  private readonly noFolder: HTMLButtonElement;

  constructor(private readonly ctx: UiContext) {
    this.dialog = new OfficeDialog(ctx);
    this.menu = new OfficeMenu(() => this.ctx.store.snapshot, () => this.menuEnv());
    const list = h('div', { class: 'ui-offices__tabs', role: 'tablist', attrs: { 'aria-label': tr('Offices') } });
    this.tabs = new KeyedList<OfficeInfo, HTMLButtonElement>(list, {
      animate: false,
      key: (o) => o.id,
      create: (o) => this.createTab(o),
      update: (b, o) => {
        const on = this.ctx.selectedOffice()?.id === o.id;
        setText(b.firstElementChild!, o.name);
        b.classList.toggle('is-on', on);
        b.classList.toggle('is-nofolder', !o.folder);
        const overlap = folderOverlap(this.ctx.store.snapshot?.team?.offices ?? [], o);
        b.classList.toggle('is-overlap', !!overlap);
        setAttr(b, 'aria-selected', String(on));
        b.tabIndex = on ? 0 : -1;
        const warn = overlap ? `\n${tr('⚠ Its folder overlaps the folder of {0}: change one of them.', [overlap.name])}` : '';
        setTitle(b, `${o.folder ? `${o.name} · ${shortPath(o.folder)}` : tr('{0} · no folder yet', [o.name])}${warn}\n${tr('Double-click to edit · right-click for more')}`);
      },
    });
    list.addEventListener('keydown', (e) => this.arrows(e));
    this.edit = h('button', { class: 'ui-icon-btn ui-icon-btn--sm ui-offices__edit', type: 'button', text: '⋯', title: tr('Edit this office'), attrs: { 'aria-label': tr('Edit this office'), 'aria-haspopup': 'dialog' }, on: { click: () => this.dialog.openEdit(this.ctx.selectedOffice()?.id ?? '', this.edit) } });
    this.add = h('button', { class: 'ui-icon-btn ui-icon-btn--sm ui-offices__add', type: 'button', text: '＋', title: tr('New office'), attrs: { 'aria-label': tr('New office'), 'aria-haspopup': 'dialog' }, on: { click: () => this.dialog.openCreate(this.add) } });
    this.noFolder = h('button', { class: 'ui-offices__nofolder', type: 'button', text: tr('📁 Choose its folder'), on: { click: () => this.dialog.openEdit(this.ctx.selectedOffice()?.id ?? '', this.noFolder) } });
    this.el = h(
      'div',
      { class: 'ui-offices', hidden: true, attrs: { 'data-hint': tr('Offices: one team per project folder. Pick the office to show; ＋ makes a new one, ⋯ renames it, changes its folder or deletes it') } },
      list,
      this.add,
      h('span', { class: 'ui-offices__spacer' }),
      this.noFolder,
      this.edit,
    );
  }

  render(): void {
    const team = this.ctx.store.snapshot?.team;
    const offices = team?.offices;
    setHidden(this.el, !offices?.length);
    if (!offices?.length) return;
    this.tabs.sync(offices);
    const office = this.ctx.selectedOffice();
    const locked = !this.editable();
    this.add.disabled = locked;
    this.edit.disabled = locked || !office;
    setHidden(this.noFolder, !office || !!office.folder || locked);
    setTitle(this.noFolder, office ? tr('{0} has no folder yet: its boss works there and its to-do list is that folder\'s HANDOFF file', [office.name]) : '');
    this.dialog.render();
    this.menu.render();
  }

  private createTab(o: OfficeInfo): HTMLButtonElement {
    const b = h(
      'button',
      {
        class: 'ui-offices__tab',
        type: 'button',
        role: 'tab',
        attrs: { 'aria-haspopup': 'menu' },
        on: {
          click: () => {
            if (pressed) pressed = false;
            else this.ctx.selectOffice(o.id);
          },
          dblclick: () => this.editable() && this.dialog.openEdit(o.id, b),
        },
      },
      h('span', { class: 'ui-offices__name' }),
    );
    const openMenu = (at?: { x: number; y: number }) => {
      // A long press may bring both the timer and a contextmenu event: one menu.
      if (this.menu.openFor === o.id && Date.now() - this.menu.openedAt < 800) return;
      this.menu.open(o.id, b, at);
    };
    b.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      // From the keyboard (no pointer): under the tab.
      openMenu(e.button < 0 || (e.clientX === 0 && e.clientY === 0) ? undefined : { x: e.clientX, y: e.clientY });
    });
    b.addEventListener('keydown', (e) => {
      if (e.key !== 'ContextMenu' && !(e.key === 'F10' && e.shiftKey)) return;
      e.preventDefault();
      e.stopPropagation();
      openMenu();
    });
    // Long press with a finger.
    let timer = 0;
    let pressed = false;
    const stop = () => clearTimeout(timer);
    b.addEventListener('pointerdown', (e) => {
      if (e.pointerType !== 'touch') return;
      stop();
      pressed = false;
      timer = window.setTimeout(() => {
        pressed = true;
        openMenu({ x: e.clientX, y: e.clientY });
      }, LONG_PRESS_MS);
    });
    for (const ev of ['pointerup', 'pointercancel', 'pointerleave']) b.addEventListener(ev, stop);
    return b;
  }

  /** What the tab menu's items know and do (ui/office-menu.ts). */
  private menuEnv(): OfficeMenuEnv {
    const snap = this.ctx.store.snapshot;
    const locked = this.ctx.store.mock ? tr('Not in the demo') : snap?.meta.terminal ? '' : tr('This Habblaud does not let the page run commands');
    const office = (id: string) => teamOffices(snap?.team).find((o) => o.id === id);
    const onOffice = (id: string, fn: () => void) => {
      if (this.ctx.selectedOffice()?.id !== id) this.ctx.selectOffice(id);
      fn();
    };
    const team = this.team;
    return {
      snap,
      shownId: this.ctx.selectedOffice()?.id,
      locked,
      ...(team ? { bossBlocked: team.blocked('boss'), workerBlocked: team.blocked('workers') } : {}),
      show: (id) => this.ctx.selectOffice(id),
      rename: (id) => this.dialog.openEdit(id, undefined, 'name'),
      changeFolder: (id) => this.dialog.openEdit(id, undefined, 'folder'),
      copyFolder: (id) => {
        const folder = office(id)?.folder;
        if (folder) void copyText(folder).then((ok) => this.ctx.announce(ok ? tr('Folder path copied.') : tr("Couldn't copy the folder path.")));
      },
      ...(this.onOpenBoard ? { openBoard: (id: string) => onOffice(id, () => this.onOpenBoard!()) } : {}),
      ...(this.onOpenRules ? { openRules: (id: string) => this.onOpenRules!(id) } : {}),
      ...(team ? { addBoss: (id: string) => onOffice(id, () => team.open('boss')), addWorker: (id: string) => onOffice(id, () => team.open('workers')) } : {}),
      create: () => this.dialog.openCreate(),
      remove: (id) => void this.dialog.confirmDelete(id),
    };
  }

  /** Offices can be made and edited (not in the demo, and the server lets the page run commands). */
  private editable(): boolean {
    return !this.ctx.store.mock && !!this.ctx.store.snapshot?.meta.terminal;
  }

  /** The office dialog on an office (its folder), e.g. from the Board's "Choose its folder". */
  editFolder(officeId: string): void {
    this.dialog.openEdit(officeId);
  }

  /** Left/right arrows move between tabs (tablist pattern). */
  private arrows(e: KeyboardEvent): void {
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
    const offices = teamOffices(this.ctx.store.snapshot?.team);
    const i = offices.findIndex((o) => o.id === this.ctx.selectedOffice()?.id);
    if (i < 0 || offices.length < 2) return;
    e.preventDefault();
    e.stopPropagation();
    const next = offices[(i + (e.key === 'ArrowRight' ? 1 : offices.length - 1)) % offices.length];
    this.ctx.selectOffice(next.id);
    requestAnimationFrame(() => this.el.querySelector<HTMLElement>('.ui-offices__tab.is-on')?.focus());
  }
}

/** ＋ New office / ⋯ Edit an office: name, folder, and (editing) delete. */
export class OfficeDialog implements UiComponent {
  readonly el: HTMLDialogElement;
  private readonly titleEl: HTMLElement;
  private readonly intro: HTMLElement;
  private readonly name: HTMLInputElement;
  private readonly other: HTMLInputElement;
  private readonly folderBox: HTMLElement;
  private readonly status: HTMLElement;
  private readonly submit: HTMLButtonElement;
  private readonly remove: HTMLButtonElement;
  /** The rules' scope in one line, with a link to the 📜 Rules dialog (editing an office whose server keeps rules). */
  private readonly scope: HTMLElement;
  private readonly scopeText: HTMLElement;
  /** Opens the 📜 Rules dialog of an office; set by ui/index.ts. */
  onOpenRules?: (officeId: string) => void;
  /** '' = a new office. */
  private officeId = '';
  private folder = '';
  /** The name was typed (a new office otherwise takes its folder's name). */
  private named = false;
  private folders: FolderOption[] = [];
  private busy = false;
  private sig = '';

  constructor(private readonly ctx: UiContext) {
    const close = iconButton(ICONS.close, tr('Close (Esc)'), () => this.close(), 'ui-icon-btn--sm');
    this.titleEl = h('h2', { attrs: { id: 'ui-officedlg-title' } });
    this.intro = h('p', { class: 'ui-teamdlg__intro' });
    this.name = h('input', { class: 'ui-rename__input', type: 'text', attrs: { maxlength: NAME_MAX, placeholder: tr('Office name'), 'aria-label': tr('Office name'), autocomplete: 'off', spellcheck: 'false' } });
    this.name.addEventListener('input', () => {
      this.named = this.name.value.trim() !== '';
      this.refresh();
    });
    this.other = h('input', {
      class: 'ui-rename__input ui-teamdlg__other',
      type: 'text',
      attrs: { placeholder: tr('Other folder (full path)'), 'aria-label': tr('Other folder (full path)'), autocomplete: 'off', spellcheck: 'false' },
    });
    this.other.addEventListener('input', () => {
      this.pick(this.other.value.trim(), true);
    });
    this.folderBox = h('div', { class: 'ui-teamdlg__choices' });
    this.status = h('p', { class: 'ui-teamdlg__status ui-muted', role: 'status' });
    // A real submit button: with two text fields, Enter only submits a form that has one.
    this.submit = h('button', { class: 'ui-btn ui-btn--primary', type: 'submit' });
    this.remove = h('button', { class: 'ui-btn ui-officedlg__delete', type: 'button', text: tr('Delete this office'), on: { click: () => void this.confirmDelete(this.officeId) } });
    this.scopeText = h('span');
    const rulesLink = h('button', {
      class: 'ui-btn ui-btn--sm',
      type: 'button',
      text: tr('📜 Rules…'),
      on: {
        click: () => {
          const id = this.officeId;
          this.close();
          this.onOpenRules?.(id);
        },
      },
    });
    this.scope = h('p', { class: 'ui-officedlg__scope', hidden: true }, this.scopeText, rulesLink);
    const form = h(
      'form',
      {
        class: 'ui-teamdlg__body',
        on: {
          submit: (e: Event) => {
            e.preventDefault();
            void this.save();
          },
        },
      },
      this.intro,
      h('label', { class: 'ui-teamdlg__label', text: tr('Name') }),
      this.name,
      h('p', { class: 'ui-teamdlg__label', text: tr('Project folder') }),
      this.folderBox,
      this.other,
      this.scope,
      this.status,
      h('div', { class: 'ui-teamdlg__actions ui-officedlg__actions' }, this.remove, this.submit),
    );
    this.el = h('dialog', { class: 'ui-dialog ui-teamdlg ui-officedlg', attrs: { 'aria-labelledby': 'ui-officedlg-title' } }, h('div', { class: 'ui-dialog__head' }, this.titleEl, close), form) as HTMLDialogElement;
    this.el.addEventListener('click', (e) => {
      if (e.target === this.el) this.close();
    });
    this.el.addEventListener('keydown', (e) => e.stopPropagation());
  }

  openCreate(opener?: HTMLElement): void {
    this.officeId = '';
    this.folder = '';
    this.named = false;
    this.name.value = '';
    this.show(opener);
  }

  /** `focus`: the field to start in (the tab menu's Rename… / Change folder…). */
  openEdit(officeId: string, opener?: HTMLElement, focus?: 'name' | 'folder'): void {
    const o = teamOffices(this.ctx.store.snapshot?.team).find((x) => x.id === officeId);
    if (!o) return;
    this.officeId = o.id;
    this.folder = o.folder;
    this.named = true;
    this.name.value = o.name;
    this.show(opener);
    if (focus === 'name') this.name.select();
    else if (focus === 'folder') this.focusFolder();
  }

  /** The folder picked in the list, else the full path field. */
  private focusFolder(): void {
    (this.folderBox.querySelector<HTMLElement>('.ui-spawn__folder.is-on') ?? this.other).focus();
  }

  close(): void {
    if (this.el.open) this.el.close();
  }

  render(): void {
    if (!this.el.open) return;
    const offices = this.ctx.store.snapshot?.team?.offices ?? [];
    const sig = JSON.stringify([this.officeId, this.folder, this.busy, this.folders.length, offices.map((o) => [o.id, o.name, o.folder, o.rules?.rev])]);
    if (sig === this.sig) return;
    this.sig = sig;
    const office = offices.find((o) => o.id === this.officeId);
    if (this.officeId && !office) {
      this.close();
      return;
    }
    setText(this.titleEl, office ? tr('Office {0}', [office.name]) : tr('＋ New office'));
    setText(
      this.intro,
      office
        ? tr("Rename the office or change its folder. Its boss works in that folder, and its to-do list is that folder's HANDOFF file.")
        : tr("One team for one project folder: its own boss and to-do list (the folder's HANDOFF file). Workers are shared between offices."),
    );
    setText(this.submit, office ? tr('Save') : tr('＋ Create the office'));
    setHidden(this.remove, !office);
    setHidden(this.scope, !office?.rules || !this.onOpenRules);
    setText(this.scopeText, office?.rules ? tr('Rules: {0}', [scopeLine(office)]) : '');
    if (office?.rules) this.scopeText.title = scopeLine(office);
    this.remove.disabled = this.busy || offices.length <= 1;
    setTitle(this.remove, offices.length <= 1 ? tr('The last office cannot be deleted') : tr('Its boss steps down and its running jobs are cancelled'));
    // The folders: the office's own first, then the recent projects; another office's folder cannot be picked.
    const own: FolderOption[] = office?.folder && !this.folders.some((f) => f.path === office.folder) ? [{ path: office.folder, name: folderName(office.folder), lastAt: 0 }] : [];
    const opts = [...own, ...this.folders];
    if (opts.some((f) => f.path === this.folder)) this.other.value = '';
    else if (this.folder && document.activeElement !== this.other) this.other.value = this.folder;
    const hadFocus = this.folderBox.contains(document.activeElement);
    this.folderBox.replaceChildren(folderChoices(opts, this.folder, (path) => this.pick(path), folderTaken(offices, this.officeId || undefined)));
    // (the recent folders arrive after opening: the focus stays on the list)
    if (hadFocus) this.focusFolder();
    this.refresh();
  }

  /** Enables the button and says what is missing (no re-render of the lists). */
  private refresh(): void {
    const offices = this.ctx.store.snapshot?.team?.offices ?? [];
    const office = offices.find((o) => o.id === this.officeId);
    const problem = folderProblem(offices, this.folder, this.officeId || undefined);
    const name = this.name.value.trim() || (this.folder ? folderName(this.folder) : '');
    if (!this.named && !office) this.name.placeholder = this.folder ? folderName(this.folder) : tr('Office name');
    const unchanged = !!office && name === office.name && normFolder(this.folder) === normFolder(office.folder);
    // (an office carried over without a folder may keep none while renaming)
    const folderOk = !problem || (!!office && !office.folder && problem === 'empty');
    this.submit.disabled = this.busy || !name || !folderOk || unchanged;
    if (!this.busy && this.status.dataset.auto !== 'err') {
      const why = this.folder && problem ? folderWhy(problem) : '';
      setText(this.status, why);
      this.status.dataset.auto = '';
    }
  }

  private show(opener?: HTMLElement): void {
    this.busy = false;
    this.sig = '';
    this.other.value = '';
    setText(this.status, '');
    this.status.dataset.auto = '';
    if (!this.folders.length) this.folders = spawnFolders(this.ctx.store.snapshot).map((path) => ({ path, name: folderName(path), lastAt: 0 }));
    void this.fetchFolders();
    if (!this.el.open) this.el.showModal();
    this.render();
    opener?.blur();
    if (!this.officeId) this.name.focus();
  }

  private pick(path: string, typed = false): void {
    this.folder = path;
    this.status.dataset.auto = '';
    if (typed) {
      // Typing a path: only the radio marks change (the input keeps its focus).
      for (const b of this.folderBox.querySelectorAll<HTMLElement>('.ui-spawn__folder')) {
        const on = b.title === path;
        b.classList.toggle('is-on', on);
        setAttr(b, 'aria-checked', String(on));
      }
      this.refresh();
      return;
    }
    this.sig = '';
    this.render();
  }

  private async fetchFolders(): Promise<void> {
    const list = await loadFolders();
    if (!list.length) return;
    this.folders = list;
    this.sig = '';
    this.render();
  }

  private async save(): Promise<void> {
    if (this.busy || this.submit.disabled) return;
    const offices = this.ctx.store.snapshot?.team?.offices ?? [];
    const office = offices.find((o) => o.id === this.officeId);
    const name = (this.name.value.trim() || folderName(this.folder)).slice(0, NAME_MAX);
    const folder = normFolder(this.folder);
    this.busy = true;
    setText(this.status, tr('Saving…'));
    this.refresh();
    try {
      if (!office) {
        const created = await createOffice(name, folder);
        this.ctx.selectOffice(created.id);
        this.ctx.announce(tr('Office {0} created.', [created.name]));
      } else {
        if (name !== office.name) await renameOffice(office.id, name);
        if (folder && folder !== normFolder(office.folder)) await setOfficeFolder(office.id, folder);
      }
      this.status.dataset.auto = '';
      this.close();
    } catch (err) {
      setText(this.status, tr("Didn't work: {0}", [err instanceof Error ? err.message : String(err)]));
      this.status.dataset.auto = 'err';
    } finally {
      this.busy = false;
      this.sig = '';
      this.render();
    }
  }

  /** Asks, then deletes the office (from the dialog, or the tab menu without it open). */
  async confirmDelete(officeId: string): Promise<void> {
    const office = teamOffices(this.ctx.store.snapshot?.team).find((o) => o.id === officeId);
    if (!office || this.busy) return;
    if (!window.confirm(tr('Delete the office {0}? Its boss steps down and its running jobs are cancelled. The folder and its files stay.', [office.name]))) return;
    this.busy = true;
    try {
      await deleteOffice(office.id);
      this.close();
      this.ctx.announce(tr('Office {0} deleted.', [office.name]));
    } catch (err) {
      const msg = tr("Didn't work: {0}", [err instanceof Error ? err.message : String(err)]);
      if (!this.el.open) window.alert(msg);
      setText(this.status, msg);
      this.status.dataset.auto = 'err';
    } finally {
      this.busy = false;
      this.sig = '';
      this.render();
    }
  }
}
