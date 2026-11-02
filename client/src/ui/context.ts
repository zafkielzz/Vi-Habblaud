// Shared context across UI components.
import type { AccountInfo, AgentInfo, OfficeInfo, PtyInfo } from '../../../shared/types';
import type { OfficeStore } from '../net/store';
import type { Selection, WorldApi } from '../world/api';
import type { UiPrefs } from './prefs';

export interface UiComponent {
  /** Called at most once per frame when something changes (snapshot, selection, clock...). */
  render(): void;
}

export type PanelName = 'sidebar' | 'feed';

/**
 * Single terminal window per agent: interactive when session runs inside Habblaud (pty); otherwise
 * read-only (with "Take over from here" to switch to interactive). Mounted in ui/index.ts.
 */
export interface TerminalRouter {
  /** Agent with open terminal (either variant), or null. */
  readonly openAgentId: string | null;
  open(agentId: string, opener?: HTMLElement | null): void;
  toggle(agentId: string, opener?: HTMLElement | null): void;
  /** Terminal for this agent would be interactive. */
  interactive(agentId: string): boolean;
  /** A terminal can be opened now (local access, outside timelapse). */
  readonly available: boolean;
  /** Interactive terminal enabled (launch new sessions, take over, terminate). */
  readonly interactiveEnabled: boolean;
  /** New Claude Code session in directory, launched in interactive terminal (its pty: agent id to come). */
  newSession(cwd: string, account?: string): Promise<PtyInfo | undefined>;
  /** Shows a terminal the server just opened (e.g. a sign-in terminal from the accounts dialog). */
  showPty?(info: PtyInfo): void;
}

export type HelpSection = 'usage' | 'codex';

export interface UiContext {
  readonly store: OfficeStore;
  /** Terminal router (defined after panels exist). */
  terminals?: TerminalRouter;
  readonly world: WorldApi;
  readonly root: HTMLElement;
  readonly prefs: Readonly<UiPrefs>;
  updatePrefs(patch: Partial<UiPrefs>): void;
  /** Server clock (adjusts for drift between local and server clocks). */
  now(): number;
  account(id: string): AccountInfo | undefined;
  agent(id: string): AgentInfo | undefined;
  selection(): Selection;
  /**
   * Selects in the world (UI syncs via onSelect). With `focus`, camera pans to target within
   * free area (outside panels) and focus is recalculated when panels open/close, until user moves camera.
   */
  select(sel: Selection, opts?: { focus?: boolean }): void;
  /** Centers camera on current selection again (Center button). */
  focusSelection(): void;
  /** Camera commands from UI buttons/shortcuts (cancel sticky focus). */
  camera(action: 'overview' | 'zoomIn' | 'zoomOut'): void;
  /** Schedules render on next frame. */
  invalidate(): void;
  /** Opens/closes a panel (without argument: toggles). */
  togglePanel(name: PanelName, open?: boolean): void;
  isPanelOpen(name: PanelName): boolean;
  /** Narrow viewport: panels become overlay drawers. */
  isNarrow(): boolean;
  /** Announces text to screen readers. */
  announce(text: string): void;
  focusSearch(): void;
  /** Opens help; with `section`, scrolls to it (e.g. "usage" = Accounts and usage). */
  openHelp(section?: HelpSection): void;
  toggleSettings(): void;
  /** Opens/closes Habblaud World modal (top bar button; ui/world/world-dialog.ts). */
  toggleWorld(): void;
  /** Opens room rename input near point (window px); right-click on room (ui/roomrename.ts). */
  renameRoom?(roomId: string, at: { x: number; y: number }): void;
  /**
   * (Optional) "See as others see": opens Habblaud World city and enters own building (Visit scene). Only
   * exists with World scene mounted (app.ts).
   */
  visitOwnBuilding?(): void;
  /** Opens settings on "About" section (running version and update status). */
  openAbout(): void;
  /** Opens/closes day timelapse (ui/timelapse.ts). */
  toggleTimelapse(): void;
  isTimelapseOpen(): boolean;
  /** The office shown (the office tabs above the top bar, ui/office-tabs.ts); undefined = no team (demo, older server). */
  selectedOffice(): OfficeInfo | undefined;
  /** Shows another office (remembered in this browser); the camera flies to its building unless `fly: false`. */
  selectOffice(id: string, opts?: { fly?: boolean }): void;
  /**
   * Rooms and characters of the office shown; the pixel office dims the rest. null = nothing to dim (a single office,
   * or none). The same object while nothing changed (cheap to call every frame).
   */
  officeFocus(): { roomIds: ReadonlySet<string>; agentIds: ReadonlySet<string>; office?: string } | null;
}
