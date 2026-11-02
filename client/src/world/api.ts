// CONTRACT of the world (office canvas) consumed by UI (client/src/ui/**).
// Implementation: client/src/world/index.ts -> createWorld().
// Rule: changes here must be ADDITIVE.

export type Selection = { type: 'agent'; id: string } | { type: 'room'; id: string } | null;

export interface WorldOptions {
  /** Show labels with character names. */
  showNames: boolean;
  /** Activity speech bubbles: all, important only (needs you, selected, recent changes), or none. */
  bubbles: 'all' | 'important' | 'none';
  /** Frequency of strolls around the office when agents are idle. */
  liveliness: 'calm' | 'normal' | 'lively';
  /** Camera follows selected agent. */
  followSelected: boolean;
  /** Day/night cycle based on local time (windows, lighting). */
  dayNight: boolean;
  /** (Optional, additive) Day/night cycle: auto, always day, or always night. Takes precedence over `dayNight`. */
  daylight?: DaylightMode;
  /** Visual theme: auto (follows calendar; see seasonalThemeFor), none, Christmas, or Halloween. */
  theme?: OfficeTheme;
}

/** Theme rendered by renderer: original office ('none') or a seasonal one. */
export type SeasonalTheme = 'none' | 'christmas' | 'halloween';
export type OfficeTheme = 'auto' | SeasonalTheme;

/**
 * Theme rendered on a given date (local time). In auto mode: Halloween from October 1 to 31, Christmas from
 * November 1 to December 26, and original office the rest of the year.
 */
export function seasonalThemeFor(theme: OfficeTheme | undefined, date: Date): SeasonalTheme {
  if (theme && theme !== 'auto') return theme;
  const month = date.getMonth();
  if (month === 9) return 'halloween';
  if (month === 10 || (month === 11 && date.getDate() <= 26)) return 'christmas';
  return 'none';
}

/** Day/night cycle: follows local time, or fixed to day or night. */
export type DaylightMode = 'auto' | 'day' | 'night';

/** Ambient sounds suggested by the world (UI decides whether and how to play them). */
export type SoundCueKind = 'keys' | 'elevator' | 'pingpong' | 'table' | 'arcade';

export interface SoundCue {
  kind: SoundCueKind;
  /** 0..1: proximity (zoom, off-screen...). */
  gain: number;
  /** -1 (left) .. 1 (right): screen position. */
  pan: number;
  /** Keyboard: keystroke count in burst. */
  count?: number;
}

export interface WorldApi {
  /** Selects (or clears) an agent/room. `focus` moves camera to target. */
  select(sel: Selection, opts?: { focus?: boolean }): void;
  getSelection(): Selection;
  /** Fired when selection changes (via canvas click or select()). */
  onSelect(cb: (sel: Selection) => void): () => void;
  /** Agent hovered under cursor (for UI tooltips). */
  onHover(cb: (agentId: string | null) => void): () => void;
  focusAgent(id: string, opts?: { follow?: boolean }): void;
  focusRoom(id: string): void;
  /** Frames the entire building. */
  overview(): void;
  zoomBy(factor: number): void;
  getOptions(): WorldOptions;
  setOptions(o: Partial<WorldOptions>): void;
  /** Screen position (CSS px, relative to viewport) just above character head, or null if not visible. */
  screenPositionOf(agentId: string): { x: number; y: number } | null;
  /**
   * (Optional, additive) Screen area covered by UI panels, in CSS px. World frames
   * (overview) and centers (focusAgent/focusRoom/follow) within free area.
   */
  setViewInsets?(insets: Partial<ViewInsets>): void;
  /**
   * (Optional, additive) Social life of an agent present in the office: personality, coin
   * wallet, friendships/rivalries with those present now, and active gathering. null if not present.
   */
  social?(agentId: string): AgentSocial | null;
  /** (Optional, additive) Right click on an office room: room id and click position (window px). */
  onRoomContextMenu?(cb: (roomId: string, at: { x: number; y: number }) => void): () => void;
  /** (Optional, additive) Click on room task board (Antigravity workers): room id. */
  onBoardOpen?(cb: (roomId: string) => void): () => void;
  /** (Optional, additive) Click on the office rules poster of a building's reception: the office id. */
  onRulesOpen?(cb: (officeId: string) => void): () => void;
  /** (Optional, additive) Social events (matches and bets) for the feed. */
  onSocialEvent?(cb: (e: SocialEvent) => void): () => void;
  /**
   * (Optional, additive) Timelapse: with `p`, world renders reproduced day (clock and
   * animation scale from `p`); `null` returns to live. Each call restarts world from scratch (nobody walks to
   * desk: everyone spawns in place), so call on enter, on seeking, and on exit; next store snapshot is
   * applied as initial state.
   */
  setPlayback?(p: WorldPlayback | null): void;
  /**
   * (Optional, additive) Office shown on the page: the world dims (gently) the rooms and characters outside
   * `source()`, called every frame (return the same object while nothing changed); null source or result = no dimming.
   */
  setOfficeFocus?(source: (() => WorldFocus | null) | null): void;
  /**
   * (Optional, additive) One building per office, side by side: the camera flies to this office's building (zoomed
   * to fit it). Unknown id or a single building: nothing happens.
   */
  focusOffice?(officeId: string): void;
  /** (Optional, additive) Ambient sounds: typing by visible workers, elevator, wheels. */
  onSound?(cb: (cue: SoundCue) => void): () => void;
  /**
   * (Optional, additive) Office off-screen (city scene is open): halts rendering and camera keyboard;
   * on return, simulation fast-forwards elapsed time (like background tab).
   */
  setSuspended?(suspended: boolean): void;
  destroy(): void;
}

/** Rooms (RoomInfo.id) and characters (AgentInfo.id) of the office shown; the rest is dimmed. */
export interface WorldFocus {
  roomIds: ReadonlySet<string>;
  agentIds: ReadonlySet<string>;
  /**
   * The office shown (OfficeInfo.id): with several buildings, every other building is dimmed whole (rooms, core,
   * corridor, characters) and roomIds/agentIds are not used. Absent = dim by roomIds/agentIds.
   */
  office?: string;
}

/** Timelapse clocks (see world/playback.ts). */
export interface WorldPlayback {
  /** Reproduced instant (epoch ms): sky time, lighting, and wall clock. */
  clock(): number;
  /** Animation scale factor (1 = real time; 0 = paused). */
  scale(): number;
}

export interface AgentSocial {
  traits: { emoji: string; label: string; desc: string }[];
  /** Catchphrase ("All done!"). */
  catchphrase: string;
  /** Coin balance (🪙). */
  coins: number;
  /** Total earned from work (initial balance + tasks + requests + deliveries). */
  earned: number;
  wins: number;
  losses: number;
  /** Present coworkers with friendship or rivalry; `record` = [wins, losses] against them. */
  bonds: { id: string; name: string; kind: 'amizade' | 'rivalidade'; record: [number, number] | null }[];
  /** Current gathering activity ("📺 Watching soccer on TV with Rafaela"), or null. */
  doing: string | null;
  /** Statement: most recent transactions first. */
  ledger: { at: number; delta: number; icon: string; text: string }[];
}

/** Resolved match/bet (becomes a feed row). */
export interface SocialEvent {
  id: string;
  at: number;
  icon: string;
  /** Protagonist (the winner). */
  agentId: string;
  /** Text without protagonist name: "won 🪙10 from Caio in rock-paper-scissors". */
  text: string;
  /** Where it took place ("Lounge", "Kitchen"...). */
  place: string;
}

/** Viewport margins covered by UI (CSS px). */
export interface ViewInsets {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

export const DEFAULT_WORLD_OPTIONS: WorldOptions = {
  showNames: true,
  bubbles: 'important',
  liveliness: 'normal',
  followSelected: false,
  dayNight: true,
  theme: 'auto',
};
