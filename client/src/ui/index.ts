// Habblaud interface (DOM panels overlaying the office canvas).
// Receives OfficeStore (data) and WorldApi (canvas) and mounts: top bar with per-account usage,
// sidebar, details drawer, feed, notices, settings, help, and loading/empty states.
// Incremental DOM: snapshots (up to ~5/s) only mark the UI as "dirty"; everything reconciles once per frame.
import { access, onAccessChange } from '../net/access';
import '@fontsource/pixelify-sans/400.css';
import '@fontsource/pixelify-sans/500.css';
import '@fontsource/pixelify-sans/600.css';
import '@fontsource/pixelify-sans/700.css';
import './styles.css';

import type { OfficeStore } from '../net/store';
import type { Selection, WorldApi } from '../world/api';
import type { PanelName, TerminalRouter, UiComponent, UiContext } from './context';
import { DayLauncher } from './daystats-launcher';
import { RoomRenamer } from './roomrename';
import { h } from './dom';
import { Drawer } from './drawer';
import { FeedPanel } from './feed';
import { HelpDialog } from './help';
import { HistoryPopover } from './history';
import { Deliveries } from './deliveries';
import { HoverTip } from './hovertip';
import { hasRunningShells } from './model';
import { hasCodexPermission } from './provider';
import { Notifier } from './notify';
import { ConnectionBanner, EmptyState, Splash } from './overlays';
import { focusPermission, nextPermissionAgent } from './permission';
import { loadPrefs, safeLocalStorage, savePrefs, worldOptionsFrom, type UiPrefs } from './prefs';
import { SettingsPopover } from './settings';
import { Sidebar } from './sidebar';
import { SoundControl } from './sound';
import { TERMINAL_UNAVAILABLE_HINT, TerminalPanel } from './terminal';
import { PtyPanel } from './pty';
import { TimelapsePlayer } from './timelapse';
import { Toasts } from './toasts';
import { UpdateToaster } from './version';
import { TopBar } from './topbar';
import { UpdateBanner } from './update';
import { WorldPopups } from './world/world-popups';
import { WorldChip } from './world/world-chip';
import { WorldDialog } from './world/world-dialog';
import { WorldSocialNotifier } from './world/away-summary';
import { worldGate } from './world/settings-world';
import { worldSectionMode } from './world/world-model';
import { SceneSwitch, type CitySceneHost } from './world/scene-switch';
import { worldSource } from '../net/world';
import { FreeArea } from './viewport';
import { attachKonami } from './konami';
import { HintOverlay } from './hints';
import { JobBoardDialog } from './job-board';
import { OfficeTabs } from './office-tabs';
import { RulesDialog } from './rules-dialog';
import { OverloadDialog } from './overload';
import { OFFICE_KEY, officeFocus, officeOfSelection, pickOffice, sameFocus, teamOffices, type OfficeFocus } from './offices';
import { tr } from '../../../shared/i18n';

/** Relative time clock ("5s ago"). */
const CLOCK_MS = 5_000;
/** Shell stopwatch clock ("12:31") and Codex request expiry clock, active only when either is present. */
const SHELL_CLOCK_MS = 1_000;
const NARROW_QUERY = '(max-width: 900px)';

function isTypingTarget(t: EventTarget | null): boolean {
  if (!(t instanceof HTMLElement)) return false;
  return t.isContentEditable || t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement || t instanceof HTMLSelectElement;
}

/** WorldApi with one building per office (B adds focusOffice to WorldApi; until then optional here). */
type BuildingsWorld = WorldApi & { focusOffice?(officeId: string): void };

export function createUI(root: HTMLElement, store: OfficeStore, world: WorldApi, city?: CitySceneHost): void {
  const storage = safeLocalStorage();
  let prefs: UiPrefs = loadPrefs(storage);
  let selection: Selection = world.getSelection();
  let skew = 0;
  const narrowMq = typeof matchMedia === 'function' ? matchMedia(NARROW_QUERY) : null;
  const panels: Record<PanelName, boolean> = {
    sidebar: narrowMq?.matches ? false : prefs.sidebarOpen,
    feed: narrowMq?.matches ? false : prefs.feedOpen,
  };

  const live = h('div', { class: 'ui-sr', role: 'status', attrs: { 'aria-live': 'polite' } });

  let topbar: TopBar;
  let sidebar: Sidebar;
  let drawer: Drawer;
  let settings: SettingsPopover;
  let worldDialog: WorldDialog;
  let help: HelpDialog;
  let area: FreeArea;
  let timelapse: TimelapsePlayer;
  /** Active selection originated from the UI (list, feed, notice...), not from a canvas click. */
  let uiSelecting = false;
  /** World button and city navigation (only when app.ts mounts the scene). */
  let scene: SceneSwitch | null = null;
  const inCity = () => !!scene?.inCity;
  /** The office shown (ui/offices.ts); its focus is recomputed only when the snapshot or the choice changes. */
  let officeId: string | null = null;
  try {
    officeId = storage?.getItem(OFFICE_KEY) ?? null;
  } catch {
    // no storage: the first office
  }
  let focusMemo: { snap: unknown; office: string | undefined; focus: OfficeFocus | null } = { snap: undefined, office: undefined, focus: null };
  const showOffice = (id: string) => {
    officeId = id;
    try {
      storage?.setItem(OFFICE_KEY, id);
    } catch {
      // no storage: not remembered
    }
  };

  const ctx: UiContext = {
    store,
    world,
    root,
    get prefs() {
      return prefs;
    },
    updatePrefs(patch) {
      prefs = { ...prefs, ...patch };
      savePrefs(storage, prefs);
      world.setOptions(worldOptionsFrom(prefs));
      invalidate();
    },
    now: () => timelapse?.replayTime ?? Date.now() + skew,
    account: (id) => store.snapshot?.accounts.find((a) => a.id === id),
    agent: (id) => store.agent(id),
    selection: () => selection,
    select(sel, opts) {
      // In the city, the office (drawer, terminal) is hidden: picking an agent or room returns to it. First:
      // the free area only measures the drawer and sidebar without the `is-city` class.
      scene?.leaveFor(sel);
      if (sel && opts?.focus) area.setIntent(sel);
      else area.clearIntent();
      // The drawer counts towards the free area BEFORE focusing: the world centers on the visible portion.
      const prev = selection;
      selection = sel;
      area.selectingFromUi();
      applyLayout({ refocus: false });
      uiSelecting = true;
      try {
        world.select(sel, opts);
      } catch (err) {
        selection = prev;
        applyLayout();
        throw err;
      } finally {
        uiSelecting = false;
      }
    },
    focusSelection() {
      if (selection) ctx.select(selection, { focus: true });
    },
    camera(action) {
      if (inCity() && city) {
        if (action === 'overview') city.recenter();
        else city.zoomBy(action === 'zoomIn' ? 1.25 : 1 / 1.25);
        return;
      }
      area.clearIntent();
      if (action === 'overview') world.overview();
      else world.zoomBy(action === 'zoomIn' ? 1.25 : 1 / 1.25);
    },
    invalidate: () => invalidate(),
    togglePanel(name, open) {
      const next = open ?? !panels[name];
      if (panels[name] === next) return;
      panels[name] = next;
      if (!ctx.isNarrow()) ctx.updatePrefs(name === 'sidebar' ? { sidebarOpen: next } : { feedOpen: next });
      applyLayout();
      invalidate();
    },
    isPanelOpen: (name) => panels[name],
    isNarrow: () => !!narrowMq?.matches,
    announce(text) {
      live.textContent = '';
      requestAnimationFrame(() => (live.textContent = text));
    },
    focusSearch() {
      if (!panels.sidebar) ctx.togglePanel('sidebar', true);
      requestAnimationFrame(() => sidebar.focusSearch());
    },
    openHelp: (section) => help.open(section),
    toggleSettings: () => settings.toggle(topbar.settingsBtn),
    toggleWorld: () => worldDialog.toggle(topbar.worldBtn),
    openAbout: () => settings.showAbout(topbar.settingsBtn),
    toggleTimelapse() {
      // Terminal shows current conversation: incompatible with replaying past days.
      if (!timelapse.isOpen && terminal.isOpen) terminal.close();
      timelapse.toggle();
    },
    isTimelapseOpen: () => timelapse.isOpen,
    selectedOffice: () => pickOffice(teamOffices(store.snapshot?.team), officeId),
    selectOffice(id, opts) {
      showOffice(id);
      // each office is a building of its own: the camera flies to it (not when a character there was picked)
      if (opts?.fly !== false && teamOffices(store.snapshot?.team).length > 1) (world as BuildingsWorld).focusOffice?.(id);
      invalidate();
    },
    officeFocus() {
      const snap = store.snapshot;
      const office = ctx.selectedOffice();
      if (focusMemo.snap === snap && focusMemo.office === office?.id) return focusMemo.focus;
      const focus = officeFocus(snap, office);
      focusMemo = { snap, office: office?.id, focus: sameFocus(focus, focusMemo.focus) ? focusMemo.focus : focus };
      return focusMemo.focus;
    },
  };

  // ---------------------------------------------------------------- components
  const sound = new SoundControl(ctx);
  const notifier = new Notifier(ctx, sound.board);
  topbar = new TopBar(ctx);
  sidebar = new Sidebar(ctx);
  // Interactive terminal (real Claude Code in browser): open, take over, and terminate sessions.
  const pty = new PtyPanel(ctx);
  const terminal = new TerminalPanel(ctx, pty);
  // Session history (terminal): button in the top bar panel group.
  const history = new HistoryPopover(ctx, terminal);
  topbar.panelGroup.prepend(history.button);
  // Agent terminal: interactive if session runs here; otherwise read-only, with "Take over here" to
  // continue in this window (without read-only, interactive shows "in another terminal" warning).
  pty.onShow = () => terminal.close();
  const router: TerminalRouter = {
    get openAgentId() {
      return pty.isOpen ? pty.agentId : terminal.agentId;
    },
    get available() {
      return pty.enabled || (!!store.snapshot?.meta.terminal && !store.replaying);
    },
    interactive: (id) => !!pty.ptyOf(id),
    get interactiveEnabled() {
      return pty.enabled;
    },
    newSession: (cwd, account) => pty.newSession(cwd, account),
    showPty: (info) => pty.openPty(info),
    open(id, opener) {
      const readOnly = !!store.snapshot?.meta.terminal && !store.replaying;
      if (pty.ptyOf(id) || (pty.enabled && !readOnly && ctx.agent(id)?.kind === 'main')) pty.openAgent(id);
      else {
        pty.close();
        terminal.open(id, opener);
      }
    },
    toggle(id, opener) {
      if (router.openAgentId === id) {
        pty.close();
        terminal.close();
      } else router.open(id, opener);
    },
  };
  ctx.terminals = router;
  // Deliveries: completed agent work (first button in group: most used on mobile).
  const deliveries = new Deliveries(ctx, terminal);
  topbar.panelGroup.prepend(deliveries.button);
  // Deep links with ?agent= / ?delivery= (opens agent or delivery on load).
  const openLink = (url: URL) => {
    const agent = url.searchParams.get('agent');
    const delivery = url.searchParams.get('delivery');
    if (!agent && !delivery) return;
    const go = () => {
      if (delivery) void deliveries.openById(delivery);
      else if (agent && ctx.agent(agent)) ctx.select({ type: 'agent', id: agent }, { focus: true });
    };
    if (store.snapshot) go();
    else {
      const off = store.on('snapshot', () => {
        off();
        setTimeout(go, 300);
      });
    }
    if (url.search && location.search === url.search) window.history.replaceState(null, '', location.pathname);
  };
  if (typeof location !== 'undefined') openLink(new URL(location.href));
  drawer = new Drawer(ctx, terminal, pty);
  const feed = new FeedPanel(ctx);
  const toasts = new Toasts(ctx);
  const updateToaster = new UpdateToaster(ctx, (n) => toasts.push(n));
  // Habblaud World (in development): dedicated window (top bar button) and release popups, only when
  // meta.world is enabled. Settings only receives the theme hint in Appearance.
  const hw = worldSource(store);
  worldDialog = new WorldDialog(ctx, hw, topbar.worldBtn);
  settings = new SettingsPopover(ctx, notifier, sound, worldDialog);
  const popups = new WorldPopups(ctx, hw, { openWorld: (screen) => worldDialog.show(screen, topbar.worldBtn), panelOpen: () => settings.isOpen || worldDialog.isOpen });
  // "🏙️ in world" / "⏸ paused" chip in the top bar (approved account; never via mobile port).
  const worldChip = new WorldChip(ctx, hw, () => worldDialog.show('home'), (n) => toasts.push(n));
  topbar.addStatus(worldChip.el);
  // "While you were away" on connect and knock-on-door notices (Phase 5; only on local machine).
  const worldSocial = new WorldSocialNotifier(ctx, hw, {
    active: () => worldSectionMode(hw.meta(), worldGate(ctx, hw)) === 'active',
    toast: (n) => toasts.push(n),
    openWorld: () => worldDialog.show('home'),
  });
  // World button: toggles between office and city (scene comes from app.ts, lazy-loaded).
  if (city) {
    scene = new SceneSwitch(ctx, hw, city, () => {
      const on = inCity();
      root.classList.toggle('is-city', on);
      if (on) {
        if (terminal.isOpen) terminal.close();
        if (pty.isOpen) pty.close();
        if (ctx.isNarrow() && panels.sidebar) ctx.togglePanel('sidebar', false);
      }
      invalidate();
    });
    topbar.addSceneButton(scene.button);
    const sw = scene;
    ctx.visitOwnBuilding = () => {
      if (worldDialog.isOpen) worldDialog.close();
      if (settings.isOpen) settings.hide();
      void sw.visitOwn();
    };
  }
  // Hold Alt: what each button and area on screen does (ui/hints.ts); Help offers it without a keyboard.
  const hints = new HintOverlay(document.body);
  help = new HelpDialog(() => hints.show(true));
  const day = new DayLauncher(ctx, (el) => root.append(el));
  topbar.addPanelButton(day.button);
  // Right click on a room (sidebar list or office): rename.
  const renamer = new RoomRenamer(ctx);
  ctx.renameRoom = (id, at) => renamer.open(id, at);
  world.onRoomContextMenu?.((id, at) => renamer.open(id, at));
  // Job board for Antigravity workers: clicking it in the office opens expanded view.
  const jobBoard = new JobBoardDialog(ctx);
  world.onBoardOpen?.((id) => jobBoard.openJobs(id));
  topbar.addPanelButton(jobBoard.button);
  // The office tabs, above the top bar like a browser's.
  const officeTabs = new OfficeTabs(ctx);
  jobBoard.onDeclareFolder = (id) => officeTabs.editFolder(id);
  officeTabs.onOpenBoard = () => jobBoard.open();
  // 📜 Rules of the office shown (toolbar, R), or of an office from its tab menu, its dialog or its reception board.
  const rules = new RulesDialog(ctx);
  topbar.addPanelButton(rules.button);
  officeTabs.onOpenRules = (id) => rules.open(id);
  officeTabs.dialog.onOpenRules = (id) => rules.open(id);
  world.onRulesOpen?.((id) => rules.open(id));
  // The tab menu's ＋ Boss / ＋ Worker are the sidebar's (their dialog explains what is missing, e.g. no PTY).
  officeTabs.team = {
    open: (kind) => sidebar.dialogs.open(kind),
    blocked: (kind) => (kind === 'workers' && !store.snapshot?.team ? tr('This Habblaud server does not keep a team yet (restart it to get one).') : ''),
  };
  const overload = new OverloadDialog(ctx);
  topbar.addPanelButton(overload.button);
  const empty = new EmptyState(ctx);
  const banner = new ConnectionBanner(ctx);
  const update = new UpdateBanner(store);
  const tip = new HoverTip(ctx);
  const splash = new Splash(ctx);
  timelapse = new TimelapsePlayer(ctx);
  const scrim = h('div', { class: 'ui-scrim', attrs: { 'aria-hidden': 'true' }, on: { click: () => ctx.togglePanel('sidebar', false) } });

  root.classList.add('ui-root');
  root.append(timelapse.vignette, officeTabs.el, topbar.el, sidebar.el, scrim, feed.el, drawer.el, terminal.el, pty.el, timelapse.el, timelapse.badge, toasts.el, banner.el, update.el, empty.el, popups.el, tip.el, settings.el, worldDialog.el, history.el, deliveries.el, help.el, renamer.el, live, splash.el, hints.el);
  area = new FreeArea(world, { root, topbar: topbar.el, sidebar: sidebar.el, drawer: drawer.el, feed: feed.el }, () => ({
    sidebar: panels.sidebar,
    feed: panels.feed,
    drawer: selection !== null && !drawer.floating,
    narrow: ctx.isNarrow(),
  }));
  drawer.onLayoutChange = () => applyLayout();

  const components: UiComponent[] = [topbar, sidebar, drawer, terminal, pty, history, deliveries, feed, toasts, settings, empty, banner, tip, notifier, splash, timelapse, sound, day, updateToaster, worldDialog, popups, worldChip];
  if (scene) components.push(scene);
  root.append(worldSocial.el, jobBoard.el, overload.el, sidebar.dialogEl, officeTabs.dialog.el, officeTabs.menu.el, rules.el);
  components.push(worldSocial, jobBoard, overload, officeTabs, rules);

  // ---------------------------------------------------------------- batched per-frame rendering
  let rafId = 0;
  let hiddenTimer: ReturnType<typeof setTimeout> | null = null;

  function renderAll(): void {
    rafId = 0;
    for (const c of components) {
      try {
        c.render();
      } catch (err) {
        console.error('[ui] failed to render', c.constructor.name, err);
      }
    }
  }

  function invalidate(): void {
    if (document.hidden) {
      // When tab is hidden, browser freezes rAF: only keep title and alerts up to date.
      hiddenTimer ??= setTimeout(() => {
        hiddenTimer = null;
        notifier.render();
        toasts.render();
      }, 500);
      return;
    }
    if (!rafId) rafId = requestAnimationFrame(renderAll);
  }

  /** Applies layout classes and notifies the world of the free area (without waiting for panel transitions). */
  function applyLayout(opts: { refocus?: boolean } = {}): void {
    root.classList.toggle('has-sidebar', panels.sidebar);
    root.classList.toggle('has-feed', panels.feed);
    root.classList.toggle('has-drawer', selection !== null && !drawer.floating);
    root.classList.toggle('is-narrow', ctx.isNarrow());
    area.sync(opts);
  }

  // ---------------------------------------------------------------- events
  store.on('snapshot', (snap) => {
    // In live mode, UI "now" follows the server clock (device clock may be ahead or behind).
    // In timelapse, the player playback time dictates "now" (frozen when paused).
    if (store.connection === 'open' && !store.replaying) skew = snap.serverTime - Date.now();
    invalidate();
  });
  store.on('connection', () => invalidate());
  onAccessChange(() => invalidate());
  world.onSelect((sel) => {
    const prev = selection;
    selection = sel;
    // a character or room of another office's building (canvas click, search hit): show that office
    const other = officeOfSelection(store.snapshot, sel);
    if (other && other !== ctx.selectedOffice()?.id) showOffice(other);
    // Canvas click (or agent departure): drawer waits for double-click window before adjusting camera.
    if (!uiSelecting) area.selectionChangedExternally(prev, sel);
    applyLayout(uiSelecting ? { refocus: false } : {});
    invalidate();
  });
  narrowMq?.addEventListener('change', (e) => {
    if (e.matches) {
      panels.sidebar = false;
      panels.feed = false;
    } else {
      panels.sidebar = prefs.sidebarOpen;
      panels.feed = prefs.feedOpen;
    }
    applyLayout();
    invalidate();
  });
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) invalidate();
  });
  setInterval(() => {
    if (!document.hidden) invalidate();
  }, CLOCK_MS);
  setInterval(() => {
    // Running shells (stopwatch) or pending Codex request (seconds countdown).
    if (!document.hidden && (hasRunningShells(store.snapshot) || hasCodexPermission(store.snapshot))) invalidate();
  }, SHELL_CLOCK_MS);

  addEventListener('keydown', (e) => onKey(e));
  // Easter egg: Konami code triggers party in all rooms (ui/konami.ts).
  const konami = attachKonami(() => {
    if (store.mock) return;
    void fetch('/api/fun/party', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }).catch(() => undefined);
    ctx.announce(tr('🎮 Secret code! Party in every room.'));
  });

  function onKey(e: KeyboardEvent): void {
    if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey) return;
    // In the city, office shortcuts are disabled: Esc closes open card or returns to office.
    if (inCity()) {
      if (e.key === 'Escape') {
        if (help.isOpen || settings.isOpen || worldDialog.isOpen || history.isOpen || document.querySelector('dialog[open], :not(dialog)[aria-modal="true"]')) return;
        e.preventDefault();
        if (!city?.escape()) scene?.close();
      } else if (e.key === '?' && !isTypingTarget(e.target) && !help.isOpen) {
        e.preventDefault();
        help.open();
      }
      return;
    }
    if (e.key === 'Escape') {
      if (help.isOpen || settings.isOpen || worldDialog.isOpen || history.isOpen) return; // dialog/popover handle their own Esc
      // Terminal floats above everything: closes first (its search, then the terminal; drawer stays open).
      if (terminal.isOpen) {
        terminal.escape();
        e.preventDefault();
      } else if (ctx.isNarrow() && panels.sidebar) {
        ctx.togglePanel('sidebar', false);
        e.preventDefault();
      } else if (selection) {
        ctx.select(null);
        e.preventDefault();
      }
      return;
    }
    if (isTypingTarget(e.target) || help.isOpen || worldDialog.isOpen) return;
    switch (e.key) {
      case '/':
        e.preventDefault();
        ctx.focusSearch();
        break;
      case '?':
        e.preventDefault();
        help.open();
        break;
      case 'f':
      case 'F':
        e.preventDefault();
        if (selection?.type === 'agent') drawer.toggleFollow();
        else ctx.announce(tr('Select an agent to follow.'));
        break;
      case 't':
      case 'T':
        e.preventDefault();
        toggleTerminal();
        break;
      case 'l':
      case 'L':
        if (store.mock) break;
        e.preventDefault();
        ctx.toggleTimelapse();
        break;
      case 'p':
      case 'P': {
        // Next permission request or question to answer from office (only navigates to it: never auto-approves).
        e.preventDefault();
        const next = nextPermissionAgent(store.snapshot?.agents ?? [], selection?.type === 'agent' ? selection.id : undefined);
        if (next) focusPermission(ctx, next.id);
        else ctx.announce(tr('No permission requests or questions to answer right now.'));
        break;
      }
      case 'o':
      case 'O':
        e.preventDefault();
        ctx.camera('overview');
        break;
      case 'm':
      case 'M':
        e.preventDefault();
        day.toggle();
        break;
      case 'b':
      case 'B':
        if (konami.midCode()) break;
        e.preventDefault();
        jobBoard.toggle();
        break;
      case 'h':
      case 'H':
        e.preventDefault();
        overload.toggle();
        break;
      case 'r':
      case 'R':
        e.preventDefault();
        rules.toggle();
        break;
      case '[':
        e.preventDefault();
        ctx.togglePanel('sidebar');
        break;
      case ']':
        e.preventDefault();
        ctx.togglePanel('feed');
        break;
    }
  }

  /**
   * T shortcut: opens terminal panel for selected agent (see `router`) or closes open one.
   */
  function toggleTerminal(): void {
    const id = selection?.type === 'agent' ? selection.id : null;
    if (id !== null && pty.enabled && ctx.agent(id)?.kind === 'main') return router.toggle(id);
    if (id === null && pty.isOpen) return pty.close();
    if (terminal.isOpen && (id === null || terminal.agentId === id)) terminal.close();
    else if (id === null) ctx.announce(tr('Select an agent to open the terminal.'));
    else if (!store.snapshot?.meta.terminal || !access().terminal) ctx.announce(`${TERMINAL_UNAVAILABLE_HINT}.`);
    else if (!ctx.agent(id)) ctx.announce(tr('The agent has already left the office.'));
    else terminal.open(id);
  }

  // ---------------------------------------------------------------- init
  world.setOptions(worldOptionsFrom(prefs));
  // the pixel office dims what is outside the office shown (ctx.officeFocus is memoized: cheap every frame)
  world.setOfficeFocus?.(() => ctx.officeFocus());
  applyLayout();
  renderAll();
}
