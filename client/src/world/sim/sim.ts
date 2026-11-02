// Office simulation: reconciles server snapshots with world characters and rooms,
// plans behaviors, and runs step queues on every frame.
import { partsKey } from '../../../../shared/appearance';
import { energyOf } from '../../../../shared/energy';
import type { AccountUsage, AgentInfo, JobBoard, OfficeSnapshot, Provider, RoomInfo } from '../../../../shared/types';
import type { ArtModule, Dir, RoomTheme } from '../../art/api';
import type { WorldOptions } from '../api';
import { COL_W, COMPACT_DELAY_MS, DISMANTLE_DELAY_MS, FOOT_DX, FOOT_DY, MISSING_DEBOUNCE_MS, RUN_SPEED, TILE, WALK_SPEED } from '../constants';
import { assembleBuilding, assembleCampus, buildingCols, BUILDING_GAP_COLS, type BuildingLayout, type BuildingPart } from '../layout/building';
import { RECEPTION_ID } from '../layout/core';
import { columnsFor, inRect } from '../layout/geometry';
import { layoutProjectRoom } from '../layout/room';
import type { SpotDef, SpotKind } from '../layout/types';
import { PathFinder } from '../path/astar';
import { BLOCKED, FREE, SEAT } from '../path/grid';
import { PROGRAM_SEED } from '../social/gathering';
import { hasTrait, personaFor, soloWeights } from '../social/persona';
import { Social } from '../social/social';
import { browserStorage, type StorageLike } from '../social/wallet';
import {
  canDismantle,
  chooseSeat,
  idleSitMs,
  isLastInRoom,
  isLongIdle,
  modeFor,
  pickIdleActivity,
  shouldRun,
  type IdleActivity,
  type Mode,
} from './behavior';
import { Character, dirOf, facing } from './character';
import { Elevator } from './elevator';
import { RoomFxState } from './github';
import { RoomState } from './room-state';
import { countShells, latestShellDone, shellLabel, shellStage, shellWaitSince, spinDir, spinPhase, yawnPhase } from './shell';
import { inSpan, SpotRegistry, type TileSpan } from './spots';
import type { Step } from './steps';
import { EXIT_RADIUS, NO_INTENT, stepFree, tileAt, VISITOR_LANYARD, type VisitorIntent } from './visitor';
import { tr } from '../../../../shared/i18n';

/**
 * One-off visual effect requested by simulation from renderer (drained every frame): confetti (completed
 * shell), coins flying from bet loser to winner, and sparkles (mirror).
 */
export type WorldEffect =
  | { kind: 'confetti'; charId: string; at: number }
  | { kind: 'coins'; charId: string; toId: string; at: number }
  | { kind: 'sparkle'; charId: string; at: number };

export { SHELL_DONE_TOOL } from './shell';

/** How long a reception rules poster glows red after a new violation. */
export const RULES_FLASH_MS = 5000;

/** An office's rules poster (its reception): active rules, the newest violation seen, and until when it flashes. */
export interface OfficeRulesBoard {
  rules: number;
  lastViolation: number;
  flashUntil: number;
}

/** How `Sim` runs (fixed at creation). */
export interface SimMode {
  /**
   * Guest visit to a world building (Guest scene): no timestamps come from world (`statusSince` are "now" on entry),
   * so nothing depending on duration (popcorn, spins, cobwebs, yawns, and naps for shell waiting; naps
   * for long idle; bubble timer); plus the visitor and visit lighting.
   */
  visit?: boolean;
}

/** Visit lighting: 'away' (paused) turns off all; 'discreet' turns on empty rooms; 'live' is usual `Sim`. */
export type VisitLight = 'live' | 'discreet' | 'away';
/** Celebration (completed shell) and lament (failed/killed). */
const CHEER_MS = 2_200;
const SULK_MS = 4_000;
const MAX_EFFECTS = 32;
/** Owner of spot reservations for a ghost room (old address during a room move). */
const GHOST_OWNER = '@mudança';

const FALLBACK_THEME: RoomTheme = {
  carpet: '#5b7fa6',
  carpet2: '#4f7093',
  wall: { base: '#e7e3db', trim: '#9b9184', pattern: 'plain' },
  accent: '#3f7fd8',
  deskVariant: 'wood',
  chairVariant: 'black',
};

const LOUNGE_SEATS: SpotKind[] = ['sofa', 'armchair', 'beanbag'];
/** Where characters can sit and use their phone. */
const PHONE_SEATS: SpotKind[] = ['beanbag', 'sofa', 'armchair', 'cafe_seat', 'bench'];
/** Rest seats available during initial load (corridor/restroom benches excluded). */
const INITIAL_LOUNGE_SEATS: SpotKind[] = ['sofa', 'armchair', 'beanbag', 'cafe_seat'];
/** Fraction of eligible idle characters that start away from desk. */
const INITIAL_LOUNGE_SHARE = 0.15;
/** Only characters idle for at least this long may start resting (recently stopped characters return soon). */
const INITIAL_LOUNGE_MIN_IDLE_MS = 90_000;
/** Nobody goes for a stroll during the first seconds after opening page. */
const INITIAL_OUTING_DELAY_MS = 5_000;
const ENTER_MS = 180;

function between(rng: () => number, a: number, b: number): number {
  return a + rng() * (b - a);
}

/** What defines character appearance (changes when character is edited). */
const lookSig = (a: AgentInfo): string => `${a.seed}|${a.look}|${partsKey(a.parts)}`;

/** How far below pointer picked-up character hangs (world px): pointer holds the head. */
const GRAB_LIFT = 14;
/** Drop height (px) of a new session falling from the sky, and gravity (px/s²). */
const FALL_H = 180;
const GRAVITY = 900;

type PokeLine = () => [string, string];
const POKE_BUSY: PokeLine[] = [() => ['⌨️', tr("Not now, I'm in the middle of something!")], () => ['🤓', tr('Almost there...')], () => ['☕', tr('Bring me a coffee?')]];
const POKE_IDLE: PokeLine[] = [() => ['👋', tr('Hi! Got a job for me?')], () => ['😴', tr('Just resting my eyes...')], () => ['🏓', tr('Up for a match?')]];
const POKE_WAITING: PokeLine[] = [() => ['✋', tr('I need you here!')], () => ['🙏', tr('Approve it for me, please?')]];
const POKE_AGY_BUSY: PokeLine[] = [() => ['🛠️', tr('Claude gave me this, delivering soon!')], () => ['📦', tr('Wrapping up the result...')], () => ['🔥', tr('Burning tokens in style.')]];
const POKE_AGY_IDLE: PokeLine[] = [() => ['🙋', tr('Send work my way, boss!')], () => ['🎮', tr('Full quota, empty hands.')], () => ['🧋', tr('Tea break while Claude thinks.')]];

export class Sim {
  readonly chars = new Map<string, Character>();
  readonly rooms = new Map<string, RoomState>();
  readonly spots = new SpotRegistry();
  readonly elevators: Elevator[] = [];
  building: BuildingLayout;
  /** Office ids in order, one building each, side by side ([''] = no offices: one building). */
  offices: string[] = [''];
  /** Office names (the building signs). */
  officeNames = new Map<string, string>();
  /** Each office's rules poster in its reception (offices whose server sends rules). */
  private readonly rulesBoards = new Map<string, OfficeRulesBoard>();
  /** Width (columns) given to each building: it grows with its rooms; only the last building shrinks back. */
  private widths = new Map<string, number>();
  readonly finder: PathFinder;
  /** Increments when building changes (rooms appear/disappear, width). */
  layoutVersion = 0;
  now = 0;
  /** Click counter (picks poke line without random: two consecutive clicks give different lines). */
  private pokes = 0;
  initialized = false;
  /** furnitureId -> until when machine is in use (coffee machine brewing coffee). */
  readonly machineUntil = new Map<string, number>();
  /** Occupied stalls (furnitureId). */
  readonly stallBusy = new Set<string>();
  /** Social life: idle gatherings, personalities, and wallets (social/social.ts). */
  readonly social: Social;
  /** Debugging: agents forced offline and rooms forced to disappear from snapshot. */
  readonly forcedOffline = new Set<string>();
  readonly hiddenRooms = new Set<string>();
  /** Snapshot accounts (id -> color/letter/name) for badges: Codex gets hollow chip and badge. */
  accounts = new Map<string, { short: string; color: string; name: string; provider?: Provider; usage?: AccountUsage }>();
  /** Claude Code workers' characters (Antigravity ones are told by their provider): they get a mug like the boss. */
  private workerAgents = new Set<string>();
  /** Debugging: extra rooms/agents merged on each snapshot (simulated sessions). */
  injected: { rooms: RoomInfo[]; agents: AgentInfo[] } = { rooms: [], agents: [] };
  /** Debugging: fields patched onto real snapshot agents (e.g. forced shells). */
  readonly agentPatches = new Map<string, Partial<AgentInfo>>();
  /** Debug: usage readings overlaid on accounts (debug.setUsage). */
  readonly usagePatches = new Map<string, AccountUsage>();
  /** One-off effects (confetti) for renderer to draw; renderer drains list. */
  readonly effects: WorldEffect[] = [];
  /** Room parties and alarms (GitHub events; sim/github.ts). */
  readonly roomFx = new RoomFxState();
  private lastSnapshot: OfficeSnapshot | null = null;
  /** Since when there has been an empty slot before the last room, per building (absent = none). */
  private gapSince = new Map<string, number>();
  private moveSeq = 0;
  private shrinkPending = false;
  private nextHousekeeping = 0;
  /** Guest visit to a world building (SimMode.visit). */
  readonly visit: boolean;
  /** Visit: my character (outside `chars`: neither snapshot, nor social life, nor reserved spot). */
  visitor: Character | null = null;
  /** Visit: where keyboard directs visitor. */
  visitorIntent: VisitorIntent = { ...NO_INTENT };
  /** Visit: building lighting (applied on every snapshot and every second). */
  visitLight: VisitLight = 'live';

  /** Wallet `storage`: null = memory-only (timelapse does not touch real coins). */
  constructor(
    private readonly art: ArtModule,
    private readonly options: () => WorldOptions,
    storage: StorageLike | null = browserStorage(),
    mode: SimMode = {},
  ) {
    this.visit = !!mode.visit;
    this.social = new Social(this, storage);
    this.building = assembleBuilding(columnsFor([]), [], 0);
    this.finder = new PathFinder(this.building.grid);
    this.spots.setSpots(this.building.spots);
    for (const s of this.spots.ofKind('elevator')) this.elevators.push(new Elevator(this.elevators.length, s.id));
  }

  // =================================================================== snapshot

  applySnapshot(input: OfficeSnapshot, now: number): void {
    let snap = this.injected.rooms.length || this.injected.agents.length ? { ...input, rooms: [...input.rooms, ...this.injected.rooms], agents: [...input.agents, ...this.injected.agents] } : input;
    if (this.agentPatches.size) {
      const patches = this.agentPatches;
      snap = { ...snap, agents: snap.agents.map((a) => (patches.has(a.id) ? { ...a, ...patches.get(a.id) } : a)) };
    }
    this.lastSnapshot = input;
    this.now = now;
    const first = !this.initialized;
    this.initialized = true;
    this.accounts = new Map(snap.accounts.map((a) => [a.id, { short: a.short, color: a.color, name: a.name, ...(a.provider === 'codex' ? { provider: a.provider } : {}), ...(this.usagePatches.has(a.id) || a.usage ? { usage: this.usagePatches.get(a.id) ?? a.usage } : {}) }]));
    this.workerAgents = new Set((snap.team?.sessions ?? []).flatMap((s) => [s.agentId, ...Object.values(s.agentIds ?? {})]));

    // ---- buildings (one per office) and rooms
    let layoutDirty = this.syncOffices(snap);
    this.syncRules(snap, first);
    const listed = new Set<string>();
    // arrival order (server slot): on initial load rooms occupy slots 0, 1, 2... in this order
    for (const r of [...snap.rooms].sort((a, b) => a.slot - b.slot)) {
      if (this.hiddenRooms.has(r.id)) continue;
      listed.add(r.id);
      const rs = this.rooms.get(r.id);
      if (!rs) {
        this.createRoom(r, first, now);
        layoutDirty = true;
        continue;
      }
      const office = this.officeOf(r.office);
      if (office !== rs.office) {
        this.rehomeRoom(rs, office);
        layoutDirty = true;
      }
      if (rs.info.name !== r.name || rs.info.seed !== r.seed) rs.version++;
      this.boardNews(r.id, rs.info.board, r.board);
      rs.info = r;
      if (!rs.listed) {
        rs.listed = true;
        rs.readyToDismantleAt = 0;
        if (rs.phase === 'dismantling') rs.rebuild(now);
      }
    }
    for (const rs of this.rooms.values()) {
      if (!listed.has(rs.id) && rs.listed) {
        rs.listed = false;
        rs.unlistedAt = now;
      }
    }
    if (layoutDirty) this.relayout();
    this.roomFx.sync(snap.rooms, input.serverTime, now);

    // ---- agents
    const seen = new Set<string>();
    const fresh: Character[] = [];
    for (const a of snap.agents) {
      seen.add(a.id);
      const ch = this.chars.get(a.id);
      if (ch) {
        this.updateAgent(ch, a, now);
        this.social.syncAgent(ch, a, now, true);
        continue;
      }
      if (a.status === 'offline' || this.forcedOffline.has(a.id) || this.hiddenRooms.has(a.roomId)) continue;
      // subagent we never saw working and already finished, or whose parent is leaving: do not enter
      if (a.status === 'done') continue;
      if (a.kind === 'sub' && a.parentId) {
        const parent = this.chars.get(a.parentId);
        if (parent && (parent.leaving || parent.gone)) continue;
      }
      const nc = this.spawn(a, first, now);
      if (nc) {
        fresh.push(nc);
        // arrived at office: wallet with initial balance (already completed tasks paid silently)
        this.social.syncAgent(nc, a, now, false);
      }
    }
    for (const ch of this.chars.values()) {
      if (!seen.has(ch.id) && !ch.leaving && ch.missingSince === null) ch.missingSince = now;
    }
    // modes (after all exist, so subagents can find parent)
    for (const ch of fresh) {
      ch.mode = this.modeOf(ch);
      this.refreshShell(ch, now);
    }
    if (first) {
      // working/waiting characters sit first; idle characters after (so no room is left empty)
      const seated = new Set<string>();
      const order = [...fresh].sort((a, b) => Number(a.mode === 'idle') - Number(b.mode === 'idle'));
      for (const ch of order) this.placeInitial(ch, now, seated);
    }
    this.refreshRoomInfo();
    // guest visit: on entry, lighting already matches building state (dark rooms enter dark, without fading)
    if (this.visit) this.applyVisitLight(now, first);
  }

  /** Re-applies last snapshot (debugging). */
  reapply(now: number): void {
    if (this.lastSnapshot) this.applySnapshot(this.lastSnapshot, now);
  }

  private createRoom(r: RoomInfo, first: boolean, now: number): RoomState {
    let theme = FALLBACK_THEME;
    try {
      theme = this.art.roomTheme(r.seed) ?? FALLBACK_THEME;
    } catch {
      theme = FALLBACK_THEME;
    }
    // first free slot in its office's building (server slot only gives arrival order)
    const office = this.officeOf(r.office);
    const local = this.freeSlot(office);
    const slot = this.globalSlot(office, local);
    const layout = layoutProjectRoom({ id: r.id, slot, seed: r.seed }, theme);
    const rs = new RoomState(r, theme, layout, first ? 'ready' : 'building', now, first, slot);
    rs.office = office;
    rs.local = local;
    this.rooms.set(r.id, rs);
    return rs;
  }

  /** Lowest slot of a building without a room (counting those still dismantling). */
  private freeSlot(office: string): number {
    const used = new Set<number>();
    for (const r of this.rooms.values()) if (r.phase !== 'gone' && r.office === office) used.add(r.local);
    let slot = 0;
    while (used.has(slot)) slot++;
    return slot;
  }

  // =================================================================== buildings (one per office)

  /** Buildings follow the offices (team.offices, in order); true when the list changed. */
  private syncOffices(snap: OfficeSnapshot): boolean {
    const list = snap.team?.offices ?? [];
    const ids = list.length ? list.map((o) => o.id) : [''];
    this.officeNames = new Map(list.map((o) => [o.id, o.name]));
    if (ids.length === this.offices.length && ids.every((id, i) => id === this.offices[i])) return false;
    this.offices = ids;
    return true;
  }

  /**
   * The reception rules posters: active rules per office, and a short flash when a violation newer than the last one
   * seen arrives (not on the first snapshot: old violations do not flash).
   */
  private syncRules(snap: OfficeSnapshot, first: boolean): void {
    const seen = new Set<string>();
    for (const o of snap.team?.offices ?? []) {
      if (!o.rules) continue;
      seen.add(o.id);
      const last = o.violations?.[0]?.at ?? 0;
      const prev = this.rulesBoards.get(o.id);
      const fresh = !first && !!prev && last > prev.lastViolation;
      this.rulesBoards.set(o.id, {
        rules: o.rules.items.filter((r) => r.on).length,
        lastViolation: Math.max(last, prev?.lastViolation ?? 0),
        flashUntil: fresh ? this.now + RULES_FLASH_MS : (prev?.flashUntil ?? 0),
      });
    }
    for (const id of [...this.rulesBoards.keys()]) if (!seen.has(id)) this.rulesBoards.delete(id);
  }

  /** The rules poster of an office's reception; undefined = no poster (no rules from the server). */
  officeRules(office: string): OfficeRulesBoard | undefined {
    return this.rulesBoards.get(office);
  }

  /** The building of an office id (absent or unknown = the first one). */
  officeOf(id: string | undefined): string {
    return id !== undefined && this.offices.includes(id) ? id : this.offices[0];
  }

  /** An office's building on the current layout (the first building while it is not built yet). */
  part(office: string): BuildingPart {
    const bs = this.building.buildings;
    return bs.find((b) => b.id === office) ?? bs[0];
  }

  /** Tile columns of a character's (or an office's) building: spots, elevators and drops stay inside it. */
  within(of: Character | string): TileSpan {
    const r = this.part(typeof of === 'string' ? of : of.office).rect;
    return { x0: r.x, x1: r.x + r.w };
  }

  /** First column of an office's building with the widths known so far (a new building: after the others). */
  private col0Of(office: string): number {
    const starts = buildingCols(this.offices.map((id) => this.widths.get(id) ?? columnsFor([])));
    return starts[Math.max(0, this.offices.indexOf(office))];
  }

  /** Absolute slot (the street's column, see geometry.slotColumn) of a slot inside a building. */
  private globalSlot(office: string, local: number): number {
    return local + 2 * this.col0Of(office);
  }

  /** The room now belongs to another building (its office changed or was deleted): it is rebuilt there. */
  private rehomeRoom(room: RoomState, office: string): void {
    room.office = office;
    room.local = -1;
    room.local = this.freeSlot(office);
    room.slot = this.globalSlot(office, room.local);
    room.layout = layoutProjectRoom({ id: room.id, slot: room.slot, seed: room.seed }, room.theme);
    room.setPhase('building', this.now);
    room.version++;
  }

  /** Its office changed (or was deleted): the character reappears in the lobby of the other building. */
  private moveToBuilding(ch: Character, office: string): void {
    this.clearPlan(ch);
    this.spots.releaseAll(ch.id);
    ch.homeSpot = null;
    ch.atSpot = null;
    ch.seated = false;
    ch.sortY = null;
    ch.standTile = null;
    ch.inside = false;
    ch.alpha = 1;
    ch.office = office;
    const t = this.lobbyTile(ch);
    ch.placeAtTile(t.x, t.y);
    ch.setPose('stand');
  }

  /** Its building moved `dc` columns (a building before it grew): the character moves along. */
  private shiftChar(ch: Character, dc: number): void {
    const dt = dc * COL_W;
    const dp = dt * TILE;
    ch.x += dp;
    ch.tx += dt;
    ch.grabX += dp;
    if (ch.enterFrom) ch.enterFrom = { x: ch.enterFrom.x + dp, y: ch.enterFrom.y };
    if (ch.standTile) ch.standTile = { x: ch.standTile.x + dt, y: ch.standTile.y };
    for (const st of ch.step ? [ch.step, ...ch.queue] : ch.queue) {
      if (st.t === 'go') {
        st.tx += dt;
        if (st.fx !== undefined) st.fx += dp;
        st.path = undefined;
      } else if (st.t === 'fall') {
        st.gx += dp;
        st.tx += dt;
      }
    }
    if (ch.gathering) this.social.leave(ch, this.now);
  }

  /** A room the character can use: its own, present, in its building. */
  private homeRoom(ch: Character): RoomState | undefined {
    const room = this.rooms.get(ch.roomId);
    return room && room.present && room.office === ch.office ? room : undefined;
  }

  private updateAgent(ch: Character, a: AgentInfo, now: number): void {
    const prevStatus = ch.info.status;
    const hadShells = !!ch.info.shells?.length;
    const prevLook = lookSig(ch.info);
    const wasBoss = !!ch.info.boss;
    ch.info = a;
    // Appointed boss while the office watches: the crown drops onto its head (render/overlay.ts) with a cheer.
    if (a.boss && !wasBoss) {
      ch.crownedAt = now;
      ch.showBubble('👑', tr("I'm the boss now!"), 3_000, now);
      this.pushEffect({ kind: 'sparkle', charId: ch.id, at: now });
    }
    if (lookSig(a) !== prevLook) {
      try {
        ch.appearance = this.art.appearanceFromSeed(a.seed, { look: a.look, sub: a.kind === 'sub', parts: a.parts });
      } catch {
        // Problematic art: keep existing appearance.
      }
    }
    ch.missingSince = null;
    const office = this.officeOf(a.office);
    if (office !== ch.office && !ch.leaving) this.moveToBuilding(ch, office);
    if (a.roomId !== ch.roomId && !ch.leaving) {
      if (ch.homeSpot) this.spots.release(ch.homeSpot, ch.id);
      ch.homeSpot = null;
      ch.roomId = a.roomId;
      this.interrupt(ch);
    }
    const act = a.activity;
    if (act && act.id !== ch.lastActivityId) {
      const firstSeen = ch.lastActivityId === null;
      ch.lastActivityId = act.id;
      if (!firstSeen) {
        ch.activityChangedAt = now;
        if (act.kind === 'done') ch.setIcon('check', 2600, now);
        if (act.kind === 'error') ch.setIcon('sweat', 2200, now);
        if (act.kind === 'delegate' && ch.info.kind === 'main' && a.status === 'working') this.planDelegate(ch, now);
        // request fulfilled: coins for the job
        if (act.kind === 'done' && ch.info.kind === 'main') this.social.turnDone(ch, now);
      }
    }
    // end of a shell: cheer or sulk (once per notification)
    const sd = latestShellDone(a);
    if (sd && sd.at > ch.shellDoneAt) {
      ch.shellDoneAt = sd.at;
      this.reactShellDone(ch, !sd.error, now);
    }
    // shells change without status changing (e.g. foreground command started/finished)
    if (prevStatus !== a.status || hadShells || !!a.shells?.length || ch.mode === 'shell' || this.forcedOffline.has(ch.id)) this.refreshMode(ch);
    this.refreshShell(ch, now);
  }

  /** Recalculates mode and interrupts plan if changed. */
  /**
   * Character click: replies with contextual line (busy, idle, waiting for you). Flavor only: does not change
   * behavior. Antigravity workers have dedicated lines (and mention rank/level).
   */
  poke(id: string): void {
    const ch = this.chars.get(id);
    if (!ch || ch.leaving) return;
    const info = ch.info;
    const agy = info.provider === 'agy';
    const pool =
      info.status === 'waiting'
        ? POKE_WAITING
        : info.status === 'working' || info.status === 'shell'
          ? agy
            ? POKE_AGY_BUSY
            : POKE_BUSY
          : agy
            ? POKE_AGY_IDLE
            : POKE_IDLE;
    const [icon, line] = pool[(this.pokes = (this.pokes + 1) % 997) % pool.length]();
    const lvl = agy && info.progress && info.status !== 'working' && this.pokes % 3 === 0 ? tr(' (level {0}, {1})', [info.progress.level, info.progress.rank]) : '';
    ch.showBubble(icon, line + lvl, 2800, this.now);
  }

  private refreshMode(ch: Character): void {
    if (ch.leaving) return;
    const mode = this.modeOf(ch);
    if (mode === ch.mode) return;
    const prev = ch.mode;
    ch.mode = mode;
    if (prev === 'idle' && mode !== 'idle') ch.nextOutingAt = 0;
    if (ch.icon === 'zzz') ch.setIcon(null, 0, this.now);
    this.refreshShell(ch, this.now);
    // in a gathering, idle <-> shell waiting changes nothing (stays in gathering)
    if (ch.gathering && (mode === 'idle' || mode === 'shell') && (prev === 'idle' || prev === 'shell')) return;
    // called to work during a gathering: notifies group before leaving
    if (ch.gathering) this.social.calledAway(ch, prev, this.now);
    // ongoing cheer/sulk from completed shell: finishes (short, returns to desk) and planner
    // follows new mode; leaving does not wait
    if (this.now < ch.reactUntil && mode !== 'leave' && mode !== 'deliver') return;
    ch.reactUntil = 0;
    this.interrupt(ch);
  }

  private modeOf(ch: Character): Mode {
    const a = ch.info;
    if (ch.leaving) return 'leave';
    const parent = a.parentId ? this.chars.get(a.parentId) : undefined;
    const parentGone = !!parent && (parent.leaving || parent.gone);
    const missing = ch.missingSince !== null && this.now - ch.missingSince >= MISSING_DEBOUNCE_MS;
    const offline = this.forcedOffline.has(ch.id);
    if (a.kind === 'sub' && a.status === 'done' && !ch.delivered && !offline && !parentGone) return 'deliver';
    const m = modeFor(offline ? 'offline' : a.status, { kind: a.kind, missing, parentGone, shells: a.shells, now: this.now });
    if (m === 'deliver' && ch.delivered) return 'leave';
    return m;
  }

  // =================================================================== shell waiting

  /** Updates start/count/label of shell waiting (on snapshot and when mode changes). */
  private refreshShell(ch: Character, now: number): void {
    if (ch.mode !== 'shell') {
      ch.shellSince = 0;
      ch.shellCount = 0;
      ch.shellStage = null;
      ch.shellEnteredAt = 0;
      return;
    }
    const a = ch.info;
    if (!ch.shellEnteredAt) ch.shellEnteredAt = now;
    // server and browser clocks may drift slightly: never "in the future"
    ch.shellSince = Math.min(now, shellWaitSince(a));
    ch.shellCount = Math.max(1, countShells(a.shells, a.status !== 'shell'));
    const label = shellLabel(a);
    if (label !== ch.shellLabel) {
      ch.shellLabel = label;
      ch.shellTextKey = -1;
    }
    // guest visit: no timestamps come from world, so gag does not escalate (no popcorn, spin, cobweb, or nap)
    ch.shellStage = this.visit ? null : shellStage(now - ch.shellSince);
  }

  /**
   * A shell finished (Activity 'ShellDone'): success -> stands up and celebrates with confetti and ⭐;
   * failure/killed -> rain cloud ('storm') and slumped shoulders. Then follows current status.
   */
  private reactShellDone(ch: Character, ok: boolean, now: number): void {
    if (ch.leaving || ch.mode === 'leave' || ch.mode === 'deliver') return;
    ch.setIcon(ok ? 'star' : 'storm', ok ? CHEER_MS : SULK_MS, now);
    if (ok) this.pushEffect({ kind: 'confetti', charId: ch.id, at: now });
    // only enacts at own desk and stationary; while walking/strolling only icon (and confetti) shows
    const home = this.spots.get(ch.homeSpot);
    if (!home || ch.atSpot !== home.id || ch.step || ch.queue.length || ch.gathering) return;
    if (ok) {
      ch.reactUntil = now + CHEER_MS + 2 * ENTER_MS + 200;
      if (home.seated) ch.queue.push({ t: 'exit' });
      ch.queue.push({ t: 'act', pose: 'stretch', ms: CHEER_MS * 0.55 }, { t: 'act', pose: 'raise_hand', ms: CHEER_MS * 0.45 });
      if (home.seated) ch.queue.push({ t: 'enter', spot: home.id });
    } else {
      // head down, discouraged, without leaving chair
      ch.reactUntil = now + SULK_MS;
      ch.queue.push({ t: 'act', pose: home.seated ? 'sleep' : 'stand', ms: SULK_MS });
    }
  }

  /** Football play on TV right now (for crowd to celebrate together with "GOAL" on screen). */
  footballLance(t: number): { lance: number; progress: number; right: boolean; period: number; goalAt: number } | null {
    try {
      return this.art.footballLance?.(t, PROGRAM_SEED.futebol) ?? null;
    } catch {
      return null;
    }
  }

  /** Requests a visual effect from renderer (confetti, coins, sparkles). */
  pushEffect(e: WorldEffect): void {
    if (this.effects.length >= MAX_EFFECTS) this.effects.shift();
    this.effects.push(e);
  }

  // =================================================================== spawn and placement

  private spawn(a: AgentInfo, first: boolean, now: number): Character | null {
    let appearance;
    try {
      appearance = this.art.appearanceFromSeed(a.seed, { look: a.look, sub: a.kind === 'sub', parts: a.parts });
    } catch {
      return null;
    }
    const ch = new Character(a, appearance);
    ch.office = this.officeOf(a.office);
    ch.lastActivityId = a.activity?.id ?? null;
    ch.shellDoneAt = latestShellDone(a)?.at ?? 0;
    this.chars.set(a.id, ch);
    if (first) return ch;
    if (this.planFall(ch)) return ch;
    // arrival by elevator
    const el = this.pickElevator(ch);
    const spot = this.spots.get(el.spotId)!;
    ch.placeAtTile(spot.tx, spot.ty);
    ch.x = spot.x;
    ch.y = spot.y - 6;
    ch.dir = 'down';
    ch.alpha = 0;
    ch.inside = true;
    ch.arriving = true;
    ch.hiddenUntil = el.reserveAppear(now);
    // subagents spawned together do not exit elevator at the exact same instant
    if (a.kind === 'sub') ch.hiddenUntil += Math.floor(ch.rng() * 600);
    ch.queue.push({ t: 'elevOut', elev: el.index, phase: 0 });
    return ch;
  }

  /**
   * Initial load: all start at natural spot (their own desk), nobody "standing in
   * corridor". Only a minority of truly idle characters (stopped for a while, not napping) appear
   * on a sofa/armchair/beanbag/cafe — never on corridor/restroom bench, and never emptying the room.
   */
  private placeInitial(ch: Character, now: number, roomsSeated: Set<string>): void {
    this.assignHome(ch);
    const home = this.spots.get(ch.homeSpot);
    // first stroll only after a few seconds: initial load shows everyone in place
    ch.nextOutingAt = now + INITIAL_OUTING_DELAY_MS + idleSitMs(ch.rng, this.options().liveliness) * ch.rng();
    const relaxing =
      ch.mode === 'idle' &&
      !!home &&
      roomsSeated.has(ch.roomId) &&
      now - ch.info.statusSince >= INITIAL_LOUNGE_MIN_IDLE_MS &&
      !isLongIdle(ch.info.status, ch.info.statusSince, now) &&
      ch.rng() < INITIAL_LOUNGE_SHARE;
    if (relaxing) {
      const seat = this.randomFree(INITIAL_LOUNGE_SEATS, ch);
      if (seat && this.spots.reserve(seat.id, ch.id)) {
        ch.tempSpots.push(seat.id);
        this.snapTo(ch, seat);
        const held = seat.kind === 'cafe_seat' ? 'coffee' : 'none';
        ch.queue.push({ t: 'act', pose: 'sit', held, ms: between(ch.rng, 4000, 14000) }, { t: 'exit' }, { t: 'do', fn: () => this.releaseTemp(ch) });
        return;
      }
    }
    if (home) {
      this.snapTo(ch, home);
      roomsSeated.add(ch.roomId);
    } else this.placeOverflow(ch);
  }

  /** Without reserved spot: standing inside own room (if it exists) or in lobby. */
  private placeOverflow(ch: Character): void {
    const room = this.homeRoom(ch);
    const t = room ? this.overflowTile(ch, room) : null;
    ch.standTile = t;
    const p = t ?? this.lobbyTile(ch);
    ch.placeAtTile(p.x, p.y);
  }

  private snapTo(ch: Character, s: SpotDef): void {
    ch.tx = s.tx;
    ch.ty = s.ty;
    ch.x = s.x;
    ch.y = s.y;
    ch.dir = s.dir;
    ch.atSpot = s.id;
    ch.seated = !!s.seated;
    ch.sortY = s.sortY ?? null;
  }

  /** Reserves desk (or stool/standing spot) in character's room. */
  private assignHome(ch: Character): void {
    if (ch.homeSpot && this.spots.get(ch.homeSpot) && this.spots.ownerOf(ch.homeSpot) === ch.id) return;
    ch.homeSpot = null;
    const room = this.homeRoom(ch);
    if (!room) return;
    const seat = chooseSeat(room.layout.spots, (id) => this.spots.isFree(id, ch.id), ch.info.kind);
    if (seat && this.spots.reserve(seat.id, ch.id)) ch.homeSpot = seat.id;
  }

  /** The least busy elevator of the character's building. */
  private pickElevator(ch: Character): Elevator {
    const span = this.within(ch);
    const mine = this.elevators.filter((e) => {
      const s = this.spots.get(e.spotId);
      return !!s && inSpan(s, span);
    });
    const list = mine.length ? mine : this.elevators;
    let best = list[0];
    for (const e of list) if (e.load < best.load || (e.load === best.load && ch.rng() < 0.5)) best = e;
    return best;
  }

  // =================================================================== layout

  /**
   * Recalculates the buildings (widths, grid, spots) from present rooms: one per office, side by side in office order.
   * A building grows with its rooms; one before others keeps its width (shrinking would move every building after
   * it), the last one shrinks when nobody is in the strip that disappears. A building that moves takes its rooms and
   * characters along.
   */
  relayout(force = false): void {
    // rooms of an office that is gone: rebuilt in the first building (an old address left behind is dropped)
    for (const [id, r] of this.rooms) {
      if (this.offices.includes(r.office)) continue;
      if (r.ghost) this.rooms.delete(id);
      else this.rehomeRoom(r, this.offices[0]);
    }
    const present = [...this.rooms.values()].filter((r) => r.present);
    const n = this.offices.length;
    const widths: number[] = [];
    let col0 = 0;
    this.shrinkPending = false;
    for (let i = 0; i < n; i++) {
      const id = this.offices[i];
      const need = columnsFor(present.filter((r) => r.office === id).map((r) => r.local));
      const cur = this.widths.get(id);
      let cols = need;
      if (cur !== undefined && need < cur) {
        if (i < n - 1) cols = cur;
        else if (!force) {
          // only shrinks when nobody is in the strip that will disappear
          const limit = (col0 + need) * COL_W * TILE;
          if ([...this.chars.values()].some((c) => !c.gone && c.office === id && c.x >= limit - TILE)) {
            cols = cur;
            this.shrinkPending = true;
          }
        }
      }
      widths.push(cols);
      col0 += cols + BUILDING_GAP_COLS;
    }
    const starts = buildingCols(widths);
    const before = new Map(this.building.buildings.map((b) => [b.id, b.col0]));
    this.offices.forEach((id, i) => {
      const was = before.get(id);
      if (was !== undefined && was !== starts[i]) for (const ch of this.chars.values()) if (ch.office === id) this.shiftChar(ch, starts[i] - was);
    });
    for (const r of this.rooms.values()) {
      const slot = r.local + 2 * starts[Math.max(0, this.offices.indexOf(r.office))];
      if (slot === r.slot) continue;
      r.slot = slot;
      r.layout = layoutProjectRoom({ id: r.id, slot, seed: r.seed }, r.theme);
      r.version++;
    }
    this.widths = new Map(this.offices.map((id, i) => [id, widths[i]]));
    const building = assembleCampus(
      this.offices.map((id, i) => ({ id, cols: widths[i] })),
      present.map((r) => r.layout),
      this.layoutVersion + 1,
    );
    this.building = building;
    this.layoutVersion++;
    this.finder.setGrid(building.grid);
    const lost = this.spots.setSpots(building.spots);
    // a new building brings its own elevators
    for (const sp of this.spots.ofKind('elevator')) if (!this.elevators.some((e) => e.spotId === sp.id)) this.elevators.push(new Elevator(this.elevators.length, sp.id));
    for (const { owner } of lost) {
      const ch = this.chars.get(owner);
      if (!ch) continue;
      if (ch.homeSpot && !this.spots.get(ch.homeSpot)) ch.homeSpot = null;
      ch.tempSpots = ch.tempSpots.filter((s) => this.spots.get(s));
    }
    for (const ch of this.chars.values()) {
      if (ch.atSpot && !this.spots.get(ch.atSpot)) {
        ch.atSpot = null;
        ch.seated = false;
        ch.sortY = null;
      }
      // ongoing paths are recalculated from current tile; destination that ceased to exist (building
      // shrank and removed corridor water cooler, room dismantled) invalidates plan: without this,
      // step would find no path and teleport character outside building
      let stale = false;
      for (const s of ch.step ? [ch.step, ...ch.queue] : ch.queue) {
        if (s.t !== 'go') continue;
        s.path = undefined;
        if (!this.building.grid.nearestWalkable(s.tx, s.ty, 4)) stale = true;
      }
      if (stale) this.interrupt(ch);
      if (!this.building.grid.walkable(ch.tx, ch.ty) && !ch.atSpot && !ch.inside) {
        const n = this.building.grid.nearestWalkable(ch.tx, ch.ty);
        if (n) {
          ch.tx = n.x;
          ch.ty = n.y;
        }
      }
    }
  }

  // =================================================================== per-frame update

  update(dt: number, now: number): void {
    this.now = now;
    for (const e of this.elevators) e.update(dt, now);
    this.updateRooms(now);
    this.social.update(now);
    if (this.roomFx.active.size) this.roomFx.update(this, now);
    for (const ch of this.chars.values()) {
      if (ch.grabbed) {
        // in air: sways slightly beneath pointer, without walking or thinking
        ch.x = ch.grabX + Math.sin(now / 140) * 1.5;
        ch.y = ch.grabY + GRAB_LIFT;
        ch.animT += dt;
        continue;
      }
      if (ch.missingSince !== null && !ch.leaving && now - ch.missingSince >= MISSING_DEBOUNCE_MS) this.refreshMode(ch);
      this.runCharacter(ch, dt, now);
    }
    if (this.visitor) this.runVisitor(this.visitor, dt, now);
    for (const [id, ch] of this.chars) {
      if (ch.gone) {
        this.spots.releaseAll(id);
        this.chars.delete(id);
      }
    }
    if (now >= this.nextHousekeeping) {
      this.nextHousekeeping = now + 1000;
      this.housekeeping(now);
    }
  }

  /** The boss's and the workers' quota as energy; once a second, so a window that renews wakes them on its own. */
  private refreshEnergy(ch: Character, now: number): void {
    const staff = ch.info.kind === 'main' && (!!ch.info.boss || ch.info.provider === 'agy' || this.workerAgents.has(ch.id));
    ch.energy = staff ? energyOf(this.accounts.get(ch.info.account)?.usage, now) : null;
  }

  /** Low-frequency housekeeping (leaving parent, unowned rooms, shrinking building). */
  private housekeeping(now: number): void {
    for (const ch of this.chars.values()) {
      if (ch.info.kind === 'sub' && !ch.leaving) this.refreshMode(ch);
      // foreground command exceeded 10 s (or waiting ended): changes mode without new snapshot
      else if (!ch.leaving && (ch.mode === 'shell' || (ch.info.status === 'working' && ch.info.shells?.length))) this.refreshMode(ch);
      this.refreshEnergy(ch, now);
      // (out of quota has its own 💤, render/overlay.ts; a ghost does not snore)
      if (ch.mode === 'idle' && !ch.energy?.asleep && !ch.info.ghost && this.longIdle(ch, now) && ch.atSpot === ch.homeSpot && ch.pose === 'sleep' && ch.icon !== 'zzz') {
        ch.setIcon('zzz', 1e12, now);
      }
    }
    if (this.shrinkPending) this.relayout();
    this.social.housekeeping(now);
    for (const [id, until] of this.machineUntil) if (until < now) this.machineUntil.delete(id);
    this.refreshRoomInfo();
    if (this.visit) this.applyVisitLight(now);
  }

  private updateRooms(now: number): void {
    let dirty = false;
    for (const room of this.rooms.values()) {
      if (room.phase === 'building' && room.progress(now) >= 1) room.setPhase('ready', now);
      if (room.phase === 'dismantling' && room.progress(now) >= 1) {
        room.setPhase('gone', now);
        dirty = true;
      }
      if (!room.listed && (room.phase === 'ready' || room.phase === 'building')) {
        const occupants = this.occupants(room);
        // safety: empty room with light on and nobody claimed to turn it off
        if (occupants === 0 && room.lightOn && !this.switchClaimValid(room) && now - room.unlistedAt > 2500) room.setLight(false, now);
        const ok = canDismantle({ listed: room.listed, occupants, lightOn: room.lightOn, dark: room.light(now) <= 0.01, unlistedForMs: now - room.unlistedAt }, 0);
        if (!ok) room.readyToDismantleAt = 0;
        else if (!room.readyToDismantleAt) room.readyToDismantleAt = now;
        else if (now - room.readyToDismantleAt >= DISMANTLE_DELAY_MS) room.setPhase('dismantling', now);
      }
    }
    for (const [id, room] of this.rooms) {
      if (room.phase === 'gone') {
        this.rooms.delete(id);
        dirty = true;
      }
    }
    if (dirty) this.relayout();
    this.compact(now);
  }

  // =================================================================== room moves

  /**
   * No gaps between rooms: when a slot becomes free before the last room (a terminal closed and
   * room was dismantled), the furthest room moves into it after COMPACT_DELAY_MS. One room at a
   * time, only ready rooms with open sessions; building shrinks when old address is dismantled.
   */
  private compact(now: number): void {
    for (const office of this.offices) {
      const free = this.freeSlot(office);
      let far: RoomState | null = null;
      for (const r of this.rooms.values()) {
        if (r.office === office && r.local > free && !r.ghost && r.listed && r.phase === 'ready' && (!far || r.local > far.local)) far = r;
      }
      if (!far) {
        this.gapSince.delete(office);
        continue;
      }
      const since = this.gapSince.get(office) ?? now;
      this.gapSince.set(office, since);
      if (now - since < COMPACT_DELAY_MS) continue;
      this.gapSince.delete(office);
      this.moveRoom(far, free, now);
    }
  }

  /**
   * Moves room to another slot: rebuilt there (unlit; first arrival turns on light)
   * and old address becomes a ghost room that waits to empty, turns off light, and is dismantled. Spots
   * keep their ids (everyone keeps their desk, now in new room); whoever is seated or heading to
   * a spot in room uses equivalent spot in ghost room, stands up from there and walks over.
   */
  moveRoom(room: RoomState, local: number, now: number): void {
    const before = room.layout;
    const ghostId = `${room.id}#mudança${++this.moveSeq}`;
    const ghostLayout = layoutProjectRoom({ id: ghostId, slot: room.slot, seed: room.seed }, room.theme);
    const ghost = new RoomState({ ...room.info, id: ghostId, seed: room.seed }, room.theme, ghostLayout, 'ready', now, false, room.slot);
    ghost.office = room.office;
    ghost.local = room.local;
    ghost.ghost = true;
    ghost.listed = false;
    ghost.unlistedAt = now;
    ghost.lightOn = room.lightOn;
    ghost.lightAt = room.lightAt;
    this.rooms.set(ghostId, ghost);
    // layout is deterministic by seed: i-th spot in ghost room is i-th spot in old room
    const alias = new Map<string, string>();
    before.spots.forEach((s, i) => {
      const g = ghostLayout.spots[i];
      if (g && g.kind === s.kind) alias.set(s.id, g.id);
    });

    room.local = local;
    room.slot = this.globalSlot(room.office, local);
    room.layout = layoutProjectRoom({ id: room.id, slot: room.slot, seed: room.seed }, room.theme);
    room.setPhase('building', now);
    room.lightOn = false;
    room.lightAt = -1e9;
    room.switchClaim = null;
    room.readyToDismantleAt = 0;
    room.version++;
    this.relayout();
    // ghost room spots belong to no one (no stroll or gathering will target them)
    for (const s of ghostLayout.spots) this.spots.reserve(s.id, GHOST_OWNER);

    for (const ch of this.chars.values()) {
      if (ch.gone) continue;
      let touched = false;
      if (ch.atSpot && alias.has(ch.atSpot)) {
        ch.atSpot = alias.get(ch.atSpot)!;
        touched = true;
      }
      // heading to a spot, light switch, or corner of old room: plan becomes stale (non-interruptible
      // step finishes at old address: sits in ghost room, flips switch in ghost room)
      for (const step of ch.step ? [ch.step, ...ch.queue] : ch.queue) {
        if (step.t === 'enter' && alias.has(step.spot)) {
          step.spot = alias.get(step.spot)!;
          touched = true;
        } else if (step.t === 'switch' && step.room === room.id) {
          step.room = ghostId;
          touched = true;
        } else if (step.t === 'go' && inRect(before.rect, step.tx, step.ty)) touched = true;
      }
      if (ch.tempSpots.some((id) => alias.has(id))) touched = true;
      if (touched || (ch.roomId === room.id && ch.standTile) || inRect(before.rect, ch.tx, ch.ty)) {
        ch.standTile = null;
        this.interrupt(ch);
      }
    }
  }

  private switchClaimValid(room: RoomState): boolean {
    if (!room.switchClaim) return false;
    const c = this.chars.get(room.switchClaim);
    if (!c || c.gone) {
      room.switchClaim = null;
      return false;
    }
    return true;
  }

  /** Characters associated with the room (not leaving) + anyone physically inside it. */
  occupants(room: RoomState, except?: string): number {
    let n = 0;
    for (const c of this.chars.values()) {
      if (c.gone || c.id === except) continue;
      if ((c.roomId === room.id && !c.leaving) || inRect(room.layout.rect, c.tx, c.ty)) n++;
    }
    return n;
  }

  /** How many are physically inside room rectangle. */
  private physicallyInside(room: RoomState, except?: string): number {
    let n = 0;
    for (const c of this.chars.values()) if (!c.gone && c.id !== except && inRect(room.layout.rect, c.tx, c.ty)) n++;
    return n;
  }

  /** Present accounts and kanban board for each room. */
  private refreshRoomInfo(): void {
    for (const room of this.rooms.values()) {
      const accs = new Set<string>();
      const board: RoomState['board'] = [];
      for (const c of this.chars.values()) {
        if (c.roomId !== room.id || c.leaving) continue;
        accs.add(c.info.account);
        if (c.info.kind === 'main') for (const t of c.info.tasks) if (board.length < 15) board.push({ status: t.status });
      }
      room.accounts = [...accs].sort();
      room.board = board;
    }
  }

  // =================================================================== step execution

  private runCharacter(ch: Character, dt: number, now: number): void {
    // animation
    ch.animT += dt * 1000;
    ch.updateLane(dt);
    if (ch.icon && now >= ch.iconUntil) ch.icon = null;
    // "zzz" only while sleeping: whoever stands up (gathering called, party in room, a stroll) woke up, and icon does
    // not go along. Desk napping for long-idle characters does not change mode, so nothing else would clear it.
    if (ch.icon === 'zzz' && ch.pose !== 'sleep') ch.icon = null;
    if (ch.mode === 'shell' && ch.shellSince && !this.visit) ch.shellStage = shellStage(now - ch.shellSince);
    if (!ch.step) {
      if (ch.replan) {
        ch.replan = false;
        this.clearPlan(ch);
      }
      ch.step = ch.queue.shift() ?? null;
      ch.stepT = 0;
      ch.stepStarted = false;
    }
    if (ch.step) {
      const done = this.runStep(ch, ch.step, dt, now);
      ch.stepT += dt * 1000;
      if (done) {
        ch.step = null;
        if (ch.replan) {
          ch.replan = false;
          this.clearPlan(ch);
        }
      }
      return;
    }
    // empty queue: decide next plan or rest
    if (now >= ch.thinkAt) {
      const planned = this.think(ch, now);
      if (!planned) ch.thinkAt = now + 400;
    }
    if (!ch.step && !ch.queue.length) this.restPose(ch, now);
  }

  private runStep(ch: Character, s: Step, dt: number, now: number): boolean {
    const first = !ch.stepStarted;
    ch.stepStarted = true;
    switch (s.t) {
      case 'go':
        return this.stepGo(ch, s, dt);
      case 'enter': {
        const spot = this.spots.get(s.spot);
        if (!spot) return true;
        if (first) {
          ch.enterFrom = { x: ch.x, y: ch.y };
          if (spot.seated) ch.sortY = spot.sortY ?? null;
        }
        const k = Math.min(1, (ch.stepT + dt * 1000) / ENTER_MS);
        const from = ch.enterFrom ?? { x: ch.x, y: ch.y };
        ch.x = from.x + (spot.x - from.x) * k;
        ch.y = from.y + (spot.y - from.y) * k;
        if (k >= 1) {
          this.snapTo(ch, spot);
          ch.setPose(spot.seated ? 'sit' : 'stand', ch.held);
          return true;
        }
        return false;
      }
      case 'exit': {
        if (!ch.atSpot) return true;
        const spot = this.spots.get(ch.atSpot);
        if (!spot) {
          ch.atSpot = null;
          ch.seated = false;
          ch.sortY = null;
          return true;
        }
        const tx = spot.tx * TILE + FOOT_DX;
        const ty = spot.ty * TILE + FOOT_DY;
        if (first) ch.enterFrom = { x: ch.x, y: ch.y };
        const k = Math.min(1, (ch.stepT + dt * 1000) / ENTER_MS);
        const from = ch.enterFrom ?? { x: ch.x, y: ch.y };
        ch.x = from.x + (tx - from.x) * k;
        ch.y = from.y + (ty - from.y) * k;
        ch.seated = false;
        ch.setPose('stand', ch.held);
        if (k >= 1) {
          ch.atSpot = null;
          ch.sortY = null;
          ch.tx = spot.tx;
          ch.ty = spot.ty;
          return true;
        }
        return false;
      }
      case 'act': {
        if (first) {
          if (s.dir) ch.dir = s.dir;
          if (s.icon) ch.setIcon(s.icon, s.ms, now);
          if (s.machine) this.machineUntil.set(s.machine, now + s.ms);
        }
        ch.setPose(s.pose, s.held ?? 'none');
        return ch.stepT >= s.ms;
      }
      case 'until': {
        if (first && s.dir) ch.dir = s.dir;
        ch.setPose(s.pose ?? (ch.seated ? 'sit' : 'stand'), s.held ?? ch.held);
        if (ch.stepT >= s.maxMs) return true;
        return ch.stepT >= s.minMs && s.cond();
      }
      case 'elevOut':
        return this.stepElevOut(ch, s, dt, now);
      case 'elevIn':
        return this.stepElevIn(ch, s, dt, now);
      case 'stall':
        return this.stepStall(ch, s, dt, now);
      case 'switch':
        return this.stepSwitch(ch, s, now);
      case 'gather':
        return this.social.stepGather(ch, s.g, now);
      case 'do':
        s.fn();
        return true;
      case 'remove':
        ch.gone = true;
        return true;
      case 'fall':
        return this.stepFall(ch, s, dt, now);
    }
  }

  /**
   * A new Claude Code main session (not on page load) drops from the sky onto its desk instead of taking the
   * elevator: hard to miss, like an orchestrator should be. Only into a room that is built and lit: the first one into
   * a new room still takes the elevator and turns the light on.
   */
  private planFall(ch: Character): boolean {
    const a = ch.info;
    if (a.kind !== 'main' || (a.provider ?? 'claude') !== 'claude') return false;
    const room = this.rooms.get(a.roomId);
    if (!room || room.phase !== 'ready' || !room.lightOn || room.office !== ch.office) return false;
    this.assignHome(ch);
    const home = ch.homeSpot ? this.spots.get(ch.homeSpot) : undefined;
    if (!home) return false;
    const gx = home.tx * TILE + FOOT_DX;
    const gy = home.ty * TILE + FOOT_DY;
    ch.placeAtTile(home.tx, home.ty);
    ch.x = gx;
    ch.y = gy - FALL_H;
    ch.dir = 'down';
    ch.arriving = true;
    ch.queue.push({ t: 'fall', gx, gy, tx: home.tx, ty: home.ty, vy: 0, phase: 0 });
    return true;
  }

  private stepFall(ch: Character, s: Extract<Step, { t: 'fall' }>, dt: number, now: number): boolean {
    ch.sortY = Number.MAX_SAFE_INTEGER;
    ch.setPose('raise_hand');
    s.vy += GRAVITY * dt;
    ch.x = s.gx;
    ch.y = Math.min(s.gy, ch.y + s.vy * dt);
    if (ch.y < s.gy) return false;
    ch.sortY = null;
    ch.tx = s.tx;
    ch.ty = s.ty;
    ch.setPose('stand');
    ch.showBubble('💥', tr('Plop! Fresh session, reporting for duty.'), 2_400, now);
    this.pushEffect({ kind: 'sparkle', charId: ch.id, at: now });
    return true;
  }

  private findPath(sx: number, sy: number, gx: number, gy: number, out: number[]): boolean {
    const grid = this.building.grid;
    if (!grid.walkable(gx, gy)) {
      const n = grid.nearestWalkable(gx, gy, 4);
      if (!n) return false;
      gx = n.x;
      gy = n.y;
    }
    if (this.finder.find(sx, sy, gx, gy, out)) return true;
    const s = grid.nearestWalkable(sx, sy, 6);
    if (s && (s.x !== sx || s.y !== sy) && this.finder.find(s.x, s.y, gx, gy, out)) {
      out.unshift(s.x, s.y);
      return true;
    }
    return false;
  }

  private stepGo(ch: Character, s: Extract<Step, { t: 'go' }>, dt: number): boolean {
    if (!s.path) {
      s.path = [];
      s.i = 0;
      if (!this.findPath(ch.tx, ch.ty, s.tx, s.ty, s.path)) {
        // no path (should not happen): teleports to avoid locking up
        ch.placeAtTile(s.tx, s.ty);
        s.path.length = 0;
      }
    }
    const path = s.path;
    let budget = (s.run ? RUN_SPEED : WALK_SPEED) * ch.speedK * dt;
    let moved = false;
    while (budget > 0.0001) {
      let gx: number;
      let gy: number;
      const i = s.i ?? 0;
      if (i < path.length) {
        ch.tx = path[i];
        ch.ty = path[i + 1];
        gx = ch.tx * TILE + FOOT_DX;
        gy = ch.ty * TILE + FOOT_DY;
      } else if (s.fx !== undefined && s.fy !== undefined && !s.fine) {
        gx = s.fx;
        gy = s.fy;
      } else break;
      const dx = gx - ch.x;
      const dy = gy - ch.y;
      const d = Math.hypot(dx, dy);
      if (d > 0.001) ch.dir = dirOf(dx, dy, ch.dir);
      if (d <= budget) {
        ch.x = gx;
        ch.y = gy;
        budget -= d;
        if (i < path.length) s.i = i + 2;
        else s.fine = true;
      } else {
        ch.x += (dx / d) * budget;
        ch.y += (dy / d) * budget;
        budget = 0;
      }
      moved = true;
    }
    const arrived = (s.i ?? 0) >= path.length && (s.fx === undefined || s.fine);
    if (arrived) {
      if (s.dir) ch.dir = s.dir;
      ch.setPose('stand', s.held ?? 'none');
      return true;
    }
    if (moved) ch.setPose(s.run ? 'run' : 'walk', s.held ?? 'none');
    return false;
  }

  private stepElevOut(ch: Character, s: Extract<Step, { t: 'elevOut' }>, dt: number, now: number): boolean {
    const el = this.elevators[s.elev] ?? this.elevators[0];
    const spot = this.spots.get(el.spotId)!;
    ch.dir = 'down';
    if (s.phase === 0) {
      ch.alpha = 0;
      ch.setPose('stand');
      if (now >= ch.hiddenUntil) {
        el.request(ch.id);
        s.phase = 1;
      }
      return false;
    }
    if (s.phase === 1) {
      ch.x = spot.x;
      ch.y = spot.y - 6;
      if (el.door >= 2.5) {
        ch.inside = false;
        ch.alpha = Math.min(1, ch.alpha + dt * 5);
        if (ch.alpha >= 1 && el.isOpen) s.phase = 2;
      }
      return false;
    }
    // exits elevator up to front tile
    const gx = spot.tx * TILE + FOOT_DX;
    const gy = spot.ty * TILE + FOOT_DY;
    const dx = gx - ch.x;
    const dy = gy - ch.y;
    const d = Math.hypot(dx, dy);
    const step = WALK_SPEED * dt;
    ch.alpha = 1;
    if (d <= step) {
      ch.x = gx;
      ch.y = gy;
      ch.tx = spot.tx;
      ch.ty = spot.ty;
      el.release(ch.id, now);
      ch.setPose('stand');
      return true;
    }
    ch.x += (dx / d) * step;
    ch.y += (dy / d) * step;
    ch.setPose('walk');
    return false;
  }

  private stepElevIn(ch: Character, s: Extract<Step, { t: 'elevIn' }>, dt: number, now: number): boolean {
    const el = this.elevators[s.elev] ?? this.elevators[0];
    const spot = this.spots.get(el.spotId)!;
    if (s.phase === 0) {
      ch.dir = 'up';
      ch.setPose('stand');
      el.request(ch.id);
      if (el.isOpen) s.phase = 1;
      return false;
    }
    if (s.phase === 1) {
      const gx = spot.x;
      const gy = spot.y - 6;
      const dx = gx - ch.x;
      const dy = gy - ch.y;
      const d = Math.hypot(dx, dy);
      const step = WALK_SPEED * dt;
      ch.dir = 'up';
      if (d <= step) {
        ch.x = gx;
        ch.y = gy;
        s.phase = 2;
        ch.dir = 'down';
        ch.setPose('stand');
      } else {
        ch.x += (dx / d) * step;
        ch.y += (dy / d) * step;
        ch.setPose('walk');
      }
      return false;
    }
    ch.alpha = Math.max(0, ch.alpha - dt * 3.5);
    if (ch.alpha <= 0) {
      ch.inside = true;
      el.release(ch.id, now);
      return true;
    }
    return false;
  }

  private stepStall(ch: Character, s: Extract<Step, { t: 'stall' }>, dt: number, now: number): boolean {
    const spot = this.spots.get(s.spot);
    if (!spot) return true;
    const furn = spot.furnitureId ?? spot.id;
    const ax = spot.tx * TILE + FOOT_DX;
    const ay = spot.ty * TILE + FOOT_DY;
    if (s.phase === 0) {
      // enters through door (walks up a bit) and disappears
      const dx = spot.x - ch.x;
      const dy = spot.y - ch.y;
      const d = Math.hypot(dx, dy);
      const step = WALK_SPEED * 0.8 * dt;
      ch.dir = 'up';
      ch.setPose('walk');
      if (d > step) {
        ch.x += (dx / d) * step;
        ch.y += (dy / d) * step;
      } else {
        ch.x = spot.x;
        ch.y = spot.y;
      }
      ch.alpha = Math.max(0, ch.alpha - dt * 4);
      if (d <= step && ch.alpha <= 0) {
        ch.inside = true;
        this.stallBusy.add(furn);
        s.phase = 1;
        ch.stallUntil = now + s.ms;
      }
      return false;
    }
    if (s.phase === 1) {
      if (now >= (ch.stallUntil ?? 0)) {
        s.phase = 2;
        this.stallBusy.delete(furn);
        ch.inside = false;
        ch.dir = 'down';
      }
      return false;
    }
    // exits stall
    const dx = ax - ch.x;
    const dy = ay - ch.y;
    const d = Math.hypot(dx, dy);
    const step = WALK_SPEED * 0.8 * dt;
    ch.alpha = Math.min(1, ch.alpha + dt * 4);
    ch.dir = 'down';
    ch.setPose('walk');
    if (d > step) {
      ch.x += (dx / d) * step;
      ch.y += (dy / d) * step;
      return false;
    }
    ch.x = ax;
    ch.y = ay;
    ch.alpha = 1;
    ch.tx = spot.tx;
    ch.ty = spot.ty;
    ch.setPose('stand');
    return true;
  }

  private stepSwitch(ch: Character, s: Extract<Step, { t: 'switch' }>, now: number): boolean {
    const room = this.rooms.get(s.room);
    if (!room) return true;
    const spot = room.layout.spots.find((p) => p.kind === 'switch');
    if (spot) ch.dir = spot.dir;
    if (s.phase === 0) {
      ch.setPose('use');
      if (ch.stepT >= 420) {
        s.phase = 1;
        const stillLast = !s.onlyIfLast || isLastInRoom(room.id, ch.id, this.chars.values());
        if (stillLast && (s.on ? room.present : true)) room.setLight(s.on, now);
      }
      return false;
    }
    ch.setPose('use');
    if (ch.stepT >= 700) {
      ch.setPose('stand');
      return true;
    }
    return false;
  }

  // =================================================================== planning

  // =================================================================== job board (Antigravity workers)

  /**
   * Room board changed (RoomInfo.board): each new task sends the worker to the board to "hear" the order before
   * heading to the desk; new order to boss makes boss write on board. Only what is new since previous snapshot
   * (page load repeats nothing).
   */
  private boardNews(roomId: string, prev: JobBoard | undefined, next: JobBoard | undefined): void {
    if (!next) return;
    const seen = new Set((prev?.items ?? []).map((i) => i.id));
    let slot = 0;
    for (const it of [...next.items].reverse()) if (it.status === 'working' && !seen.has(it.id)) this.attendBoard(roomId, it.agentId, it.text, slot++);
    if (next.order && next.order.at !== prev?.order?.at) this.bossWrite(roomId, next.order.text);
  }

  /** Room board spot (standing spot in front of whiteboard). */
  private boardSpot(roomId: string): SpotDef | undefined {
    return this.spots.ofKind('whiteboard').find((sp) => sp.areaId === roomId);
  }

  /** Free for a short stroll now (not leaving, not arriving, not in non-interruptible step)? */
  private free(ch: Character): boolean {
    return !ch.grabbed && !ch.leaving && !ch.inside && !ch.arriving && !(ch.step && !this.interruptible(ch.step));
  }

  /** Worker walks to board (side by side with others), hears order and then resumes mode (desk). */
  private attendBoard(roomId: string, agentId: string, text: string, slot: number): void {
    const ch = this.chars.get(agentId);
    const spot = this.boardSpot(roomId);
    if (!ch || !spot || ch.roomId !== roomId || !this.free(ch)) return;
    const dx = [0, 1, -1, 2, -2, 3][slot % 6];
    const at = this.building.grid.nearestWalkable(spot.tx + dx, spot.ty + (slot >= 6 ? 1 : 0)) ?? { x: spot.tx, y: spot.ty };
    this.clearPlan(ch);
    const listen = 3_500;
    const steps: Step[] = [];
    this.pushLeave(ch, steps);
    steps.push(
      { t: 'go', tx: at.x, ty: at.y },
      {
        t: 'do',
        fn: () => {
          ch.dir = 'up';
          ch.showBubble('👂', tr('Got it: {0}', [text]), listen, this.now);
        },
      },
      { t: 'act', pose: 'stand', ms: listen },
    );
    ch.queue.push(...steps);
    ch.reactUntil = this.now + 12_000 + listen;
  }

  /** Boss writes order on board: walks up to it if in same room; otherwise, just bubble. */
  private bossWrite(roomId: string, text: string): void {
    const boss = [...this.chars.values()].find((c) => c.info.boss && !c.leaving && !c.gone);
    if (!boss) return;
    const spot = this.boardSpot(roomId);
    if (!spot || boss.roomId !== roomId || !this.free(boss)) {
      boss.showBubble('✍️', tr('On the board: {0}', [text]), 4_000, this.now);
      return;
    }
    const at = this.building.grid.nearestWalkable(spot.tx - 1, spot.ty) ?? { x: spot.tx, y: spot.ty };
    this.clearPlan(boss);
    const steps: Step[] = [];
    this.pushLeave(boss, steps);
    steps.push(
      { t: 'go', tx: at.x, ty: at.y },
      {
        t: 'do',
        fn: () => {
          boss.dir = 'up';
          boss.showBubble('✍️', tr('On the board: {0}', [text]), 3_500, this.now);
        },
      },
      { t: 'act', pose: 'read', held: 'papers', ms: 3_500 },
    );
    boss.queue.push(...steps);
    boss.reactUntil = this.now + 12_000 + 3_500;
  }

  // =================================================================== mouse dragging

  /**
   * Picks up a character (drag with mouse). Only free characters: arriving, leaving, inside a stall, or in
   * non-interruptible step (elevator, door) do not move. Returns whether picked up.
   */
  grab(id: string, wx: number, wy: number): boolean {
    const ch = this.chars.get(id);
    if (!ch || ch.grabbed || ch.leaving || ch.inside || ch.arriving || (ch.step && !this.interruptible(ch.step))) return false;
    this.clearPlan(ch);
    ch.grabbed = true;
    ch.atSpot = null;
    ch.seated = false;
    ch.sortY = Number.MAX_SAFE_INTEGER;
    ch.grabX = wx;
    ch.grabY = wy;
    ch.setPose('raise_hand');
    ch.showBubble('😱', tr('Hey! Put me down!'), 60_000, this.now);
    return true;
  }

  moveGrabbed(id: string, wx: number, wy: number): void {
    const ch = this.chars.get(id);
    if (!ch?.grabbed) return;
    ch.dir = wx < ch.grabX - 0.5 ? 'left' : wx > ch.grabX + 0.5 ? 'right' : ch.dir;
    ch.grabX = wx;
    ch.grabY = wy;
  }

  /**
   * Drops on nearest walkable tile to pointer (can be another room or corridor). Gets a bit dizzy and then
   * walks back to own room (think() leads home).
   */
  dropGrabbed(id: string, wx: number, wy: number): void {
    const ch = this.chars.get(id);
    if (!ch?.grabbed) return;
    ch.grabbed = false;
    ch.sortY = null;
    // (never into another building: dropped on the lawn between two, it lands at the edge of its own)
    const span = this.within(ch);
    const tx = Math.min(span.x1 - 2, Math.max(span.x0 + 1, Math.floor(wx / TILE)));
    const spot = this.building.grid.nearestWalkable(tx, Math.floor(wy / TILE)) ?? { x: ch.tx, y: ch.ty };
    ch.placeAtTile(spot.x, spot.y);
    ch.setPose('stand');
    const dizzy = 2_800;
    ch.reactUntil = this.now + dizzy + 400;
    ch.queue.push(
      { t: 'do', fn: () => ch.showBubble('💫', tr("Whoa... everything's spinning."), dizzy, this.now) },
      { t: 'act', pose: 'stand', ms: dizzy },
    );
    ch.showBubble('💥', tr('Plop!'), 600, this.now);
  }

  /** Interrupts current plan (respecting non-interruptible steps). */
  interrupt(ch: Character): void {
    if (ch.step && !this.interruptible(ch.step)) {
      ch.replan = true;
      if (ch.step.t === 'stall' && ch.step.phase <= 1) ch.stallUntil = Math.min(ch.stallUntil ?? 0, this.now + 2000);
      return;
    }
    this.clearPlan(ch);
  }

  interruptible(s: Step): boolean {
    return s.t === 'go' || s.t === 'act' || s.t === 'until' || s.t === 'gather' || s.t === 'do';
  }

  /** Discards queue (and leaves gathering, if in one). */
  clearPlan(ch: Character): void {
    ch.queue.length = 0;
    ch.step = null;
    ch.thinkAt = 0;
    this.releaseTemp(ch);
    // 'do' step that would release switch was discarded with queue: without this reservation
    // leaks and nobody turns on (or off) room light while this character exists
    const room = this.rooms.get(ch.roomId);
    if (room && room.switchClaim === ch.id) room.switchClaim = null;
    if (ch.gathering) this.social.leave(ch, this.now);
    ch.chatUntil = 0;
  }

  releaseTemp(ch: Character): void {
    for (const id of ch.tempSpots) if (id !== ch.homeSpot) this.spots.release(id, ch.id);
    ch.tempSpots.length = 0;
  }

  reserveTemp(ch: Character, spot: SpotDef): boolean {
    if (!this.spots.reserve(spot.id, ch.id)) return false;
    ch.tempSpots.push(spot.id);
    return true;
  }

  /** Decides next plan. Returns true if something was planned. */
  private think(ch: Character, now: number): boolean {
    if (ch.gone) return false;
    if (ch.mode === 'leave') return this.planLeave(ch, now);
    if (ch.mode === 'deliver') return this.planDeliver(ch, now);
    const room = this.rooms.get(ch.roomId);
    if (!room || !room.present || room.office !== ch.office) return this.planLobby(ch, room && room.office === ch.office ? room : undefined);
    this.assignHome(ch);
    if (!ch.homeSpot) return this.planOverflow(ch, room);
    ch.standTile = null;
    // unlit room: first to arrive turns on light
    if (!room.lightOn && room.phase !== 'dismantling' && !this.switchClaimValid(room)) {
      room.switchClaim = ch.id;
      const sw = room.layout.spots.find((p) => p.kind === 'switch');
      if (sw) {
        const steps: Step[] = [];
        this.pushLeave(ch, steps);
        steps.push(
          { t: 'go', tx: sw.tx, ty: sw.ty, fx: sw.x, fy: sw.y, dir: sw.dir, run: ch.mode === 'wait' },
          { t: 'until', cond: () => room.phase === 'ready', minMs: 0, maxMs: 6000, dir: sw.dir },
          { t: 'switch', room: room.id, on: true, phase: 0 },
          { t: 'do', fn: () => room.switchClaim === ch.id && (room.switchClaim = null) },
        );
        ch.queue.push(...steps);
        return true;
      }
    }
    if (ch.atSpot !== ch.homeSpot) return this.planGoHome(ch, now);
    ch.arriving = false;
    if (ch.mode === 'idle' && !this.longIdle(ch, now)) {
      if (!ch.nextOutingAt) ch.nextOutingAt = now + idleSitMs(ch.rng, this.options().liveliness);
      if (now >= ch.nextOutingAt) {
        if (this.planOuting(ch, now)) return true;
        ch.nextOutingAt = now + idleSitMs(ch.rng, this.options().liveliness);
      }
    }
    // waiting for shell: only leaves desk for a gathering (alone, stays eating popcorn)
    if (ch.mode === 'shell') {
      if (!ch.nextSocialAt) ch.nextSocialAt = now + idleSitMs(ch.rng, this.options().liveliness) * 1.3;
      if (now >= ch.nextSocialAt) {
        ch.nextSocialAt = now + idleSitMs(ch.rng, this.options().liveliness) * 1.3;
        const p = personaFor(ch.info.seed);
        if (this.social.hasCompany(ch, now) && ch.rng() < 0.5 + p.sociability * 0.4 && this.social.tryInitiate(ch, now, true)) return true;
      }
    }
    return false;
  }

  /** Stand up / leave current spot before walking. */
  private pushLeave(ch: Character, steps: Step[]): void {
    if (ch.atSpot) steps.push({ t: 'exit' });
  }

  private planGoHome(ch: Character, now: number, held: 'none' | 'coffee' | 'water' = 'none'): boolean {
    const home = this.spots.get(ch.homeSpot);
    if (!home) return false;
    const steps: Step[] = [];
    this.pushLeave(ch, steps);
    const dist = Math.abs(home.tx - ch.tx) + Math.abs(home.ty - ch.ty);
    // newly arrived characters walk (unless waiting for user); then run if far away
    const run = shouldRun(dist, ch.mode) && (!ch.arriving || ch.mode === 'wait');
    steps.push({ t: 'go', tx: home.tx, ty: home.ty, run, held }, { t: 'enter', spot: home.id });
    if (ch.mode === 'idle') steps.push({ t: 'do', fn: () => (ch.nextOutingAt = this.now + idleSitMs(ch.rng, this.options().liveliness)) });
    void now;
    ch.queue.push(...steps);
    return true;
  }

  /** No room yet (waiting for slot): waits in lobby. */
  private planLobby(ch: Character, room: RoomState | undefined): boolean {
    const t = this.lobbyTile(ch);
    ch.queue.push(
      { t: 'go', tx: t.x, ty: t.y },
      { t: 'until', cond: () => !!room && room.present, minMs: 800, maxMs: 4000, dir: 'down' },
    );
    return true;
  }

  /**
   * Room full (all seats reserved): works standing inside the room in a free corner
   * until a seat frees up. Never wanders around reception.
   */
  private planOverflow(ch: Character, room: RoomState): boolean {
    const stay = ch.standTile && !ch.atSpot && ch.tx === ch.standTile.x && ch.ty === ch.standTile.y && this.overflowFree(ch.tx, ch.ty, ch);
    const t = stay ? ch.standTile : this.overflowTile(ch, room);
    if (!t) return this.planLobby(ch, room);
    ch.standTile = t;
    ch.arriving = false;
    const steps: Step[] = [];
    this.pushLeave(ch, steps);
    const r = room.layout.rect;
    // facing the center of the room (where desks are)
    const dir: Dir = facing(t.x * TILE, t.y * TILE, (r.x + 5) * TILE, (r.y + 6) * TILE);
    if (t.x !== ch.tx || t.y !== ch.ty || ch.atSpot) {
      const dist = Math.abs(t.x - ch.tx) + Math.abs(t.y - ch.ty);
      steps.push({ t: 'go', tx: t.x, ty: t.y, dir, run: shouldRun(dist, ch.mode) });
    }
    // waiting for shell while standing: only hourglass (waiting pose is seated)
    const pose = ch.mode === 'wait' ? 'raise_hand' : ch.mode === 'work' ? 'read' : 'stand';
    const held = ch.mode === 'work' ? 'laptop' : 'none';
    steps.push({ t: 'until', cond: () => this.hasFreeSeat(room, ch), minMs: 1500, maxMs: 12_000, pose, held, dir });
    ch.queue.push(...steps);
    return true;
  }

  private hasFreeSeat(room: RoomState, ch: Character): boolean {
    return !!chooseSeat(room.layout.spots, (id) => this.spots.isFree(id, ch.id), ch.info.kind);
  }

  /** Free tile for someone to stand (no seat, no spot, and no other character). */
  private overflowFree(x: number, y: number, ch: Character, busy = this.busyTiles(ch.id)): boolean {
    const grid = this.building.grid;
    if (grid.get(x, y) !== FREE || busy.has(y * grid.w + x)) return false;
    for (const s of this.spots.all()) if (s.tx === x && s.ty === y) return false;
    return true;
  }

  /** Best free room tile to work standing: against walls/furniture, far from door. */
  private overflowTile(ch: Character, room: RoomState): { x: number; y: number } | null {
    const grid = this.building.grid;
    const r = room.layout.rect;
    const door = room.layout.door;
    const busy = this.busyTiles(ch.id);
    let best: { x: number; y: number } | null = null;
    let bestScore = -Infinity;
    for (let y = r.y + 2; y <= r.y + 10; y++) {
      for (let x = r.x + 1; x <= r.x + 14; x++) {
        if (!this.overflowFree(x, y, ch, busy)) continue;
        if (door && Math.abs(x - (door.x + door.w / 2 - 0.5)) <= 1.5 && Math.abs(y - (door.y + door.h / 2 - 0.5)) <= 2) continue;
        // back to a wall/furniture looks natural; squeezed between furniture or against
        // another person does not
        const solidAt = (dx: number, dy: number) => grid.get(x + dx, y + dy) === BLOCKED;
        let crowd = 0;
        for (const [dx, dy] of [
          [1, 0],
          [-1, 0],
          [0, 1],
          [0, -1],
        ] as const) if (busy.has((y + dy) * grid.w + x + dx)) crowd++;
        const backed = solidAt(0, -1) || solidAt(0, 1) ? 2 : solidAt(1, 0) || solidAt(-1, 0) ? 1 : 0;
        const squeezed = (solidAt(1, 0) && solidAt(-1, 0)) || (solidAt(0, 1) && solidAt(0, -1)) ? 3 : 0;
        const score = backed - squeezed - crowd * 3 - (Math.abs(x - ch.tx) + Math.abs(y - ch.ty)) * 0.05 + ch.rng() * 0.8;
        if (score > bestScore) {
          bestScore = score;
          best = { x, y };
        }
      }
    }
    return best;
  }

  private lobbyTile(ch: Character): { x: number; y: number } {
    const span = this.within(ch);
    const reception = this.building.core.find((a) => a.kind === 'reception' && inSpan({ tx: a.rect.x }, span)) ?? this.building.core.find((a) => a.id === RECEPTION_ID)!;
    const r = reception.rect;
    for (let k = 0; k < 20; k++) {
      const x = r.x + 2 + Math.floor(ch.rng() * 12);
      const y = r.y + 3 + Math.floor(ch.rng() * 7);
      if (this.building.grid.get(x, y) === 1) return { x, y };
    }
    return { x: r.x + 6, y: r.y + 9 };
  }

  private planDelegate(ch: Character, now: number): void {
    if (ch.step || ch.queue.length || ch.atSpot !== ch.homeSpot || !ch.homeSpot) return;
    const room = this.rooms.get(ch.roomId);
    const door = room?.layout.door;
    const dir: Dir = door ? facing(ch.x, ch.y, (door.x + door.w / 2) * TILE, (door.y + door.h / 2) * TILE) : 'down';
    const home = ch.homeSpot;
    ch.queue.push(
      { t: 'exit' },
      {
        // standing, facing door, "explaining" task to arrival ('raise_hand' and ✋ remain
        // reserved for when agent needs the user)
        t: 'until',
        cond: () => ![...this.chars.values()].some((c) => c.info.parentId === ch.id && c.arriving),
        minMs: 2600,
        maxMs: 7500,
        pose: 'talk',
        held: 'none',
        dir,
      },
      { t: 'go', tx: ch.tx, ty: ch.ty },
      { t: 'enter', spot: home },
    );
    ch.setIcon('chat', 2600, now);
  }

  private planLeave(ch: Character, now: number): boolean {
    ch.leaving = true;
    ch.arriving = false;
    this.spots.releaseAll(ch.id);
    ch.homeSpot = null;
    ch.tempSpots.length = 0;
    if (ch.gathering) this.social.leave(ch, now);
    const steps: Step[] = [];
    this.pushLeave(ch, steps);
    const room = this.rooms.get(ch.roomId);
    if (room && room.present && room.office === ch.office && room.lightOn && !this.switchClaimValid(room) && isLastInRoom(room.id, ch.id, this.chars.values())) {
      const sw = room.layout.spots.find((p) => p.kind === 'switch');
      if (sw) {
        room.switchClaim = ch.id;
        steps.push(
          { t: 'go', tx: sw.tx, ty: sw.ty, fx: sw.x, fy: sw.y, dir: sw.dir },
          { t: 'until', cond: () => this.physicallyInside(room, ch.id) === 0, minMs: 250, maxMs: 9000, dir: sw.dir },
          { t: 'switch', room: room.id, on: false, phase: 0, onlyIfLast: true },
          { t: 'do', fn: () => room.switchClaim === ch.id && (room.switchClaim = null) },
        );
      }
    }
    const el = this.pickElevator(ch);
    const es = this.spots.get(el.spotId)!;
    steps.push({ t: 'go', tx: es.tx, ty: es.ty, fx: es.tx * TILE + FOOT_DX + (es.x - (es.tx * TILE + FOOT_DX)) * 0.5, fy: es.ty * TILE + FOOT_DY - 2, dir: 'up' });
    steps.push({ t: 'elevIn', elev: el.index, phase: 0 }, { t: 'remove' });
    ch.queue.push(...steps);
    void now;
    return true;
  }

  private planDeliver(ch: Character, now: number): boolean {
    const parent = ch.info.parentId ? this.chars.get(ch.info.parentId) : undefined;
    if (!parent || parent.leaving || parent.gone) {
      ch.delivered = true;
      ch.mode = 'leave';
      return this.planLeave(ch, now);
    }
    const target = this.besideTile(parent, ch);
    const steps: Step[] = [];
    this.pushLeave(ch, steps);
    const held = ch.rng() < 0.5 ? 'papers' : 'box';
    const title = ch.info.title ?? tr('result');
    steps.push(
      { t: 'go', tx: target.x, ty: target.y, held },
      {
        t: 'do',
        fn: () => {
          ch.dir = facing(ch.x, ch.y, parent.x, parent.y);
          ch.showBubble('📦', tr('Delivering: {0}', [title]), 3000, this.now);
          ch.setIcon('box', 2800, this.now);
          parent.setIcon(parent.rng() < 0.5 ? 'heart' : 'check', 2800, this.now);
        },
      },
      { t: 'act', pose: 'talk', held, ms: 2700 },
      {
        t: 'do',
        fn: () => {
          ch.delivered = true;
          ch.mode = 'leave';
          this.social.delivered(ch, this.now);
        },
      },
    );
    ch.queue.push(...steps);
    return true;
  }

  /** Walkable tile beside someone (avoiding seats and occupied tiles), closest to origin. */
  private besideTile(target: Character, from: Character): { x: number; y: number } {
    const grid = this.building.grid;
    const busy = this.busyTiles(from.id, target.id);
    let best: { x: number; y: number } | null = null;
    let bestD = Infinity;
    for (const [dx, dy] of [
      [-1, 0],
      [1, 0],
      [0, 1],
      [0, -1],
      [-1, 1],
      [1, 1],
      [-1, -1],
      [1, -1],
    ] as const) {
      const x = target.tx + dx;
      const y = target.ty + dy;
      const cell = grid.get(x, y);
      if (cell === 0) continue;
      const d = Math.abs(x - from.tx) + Math.abs(y - from.ty) + (cell === SEAT ? 20 : 0) + (busy.has(y * grid.w + x) ? 40 : 0) + (dx && dy ? 3 : 0);
      if (d < bestD) {
        bestD = d;
        best = { x, y };
      }
    }
    return best ?? grid.nearestWalkable(target.tx, target.ty) ?? { x: target.tx, y: target.ty };
  }

  /** Tiles (index y*w+x) where someone is standing or heading to, except `a` and `b`. */
  busyTiles(a: string, b?: string): Set<number> {
    const w = this.building.grid.w;
    const out = new Set<number>();
    for (const c of this.chars.values()) {
      if (c.gone || c.id === a || c.id === b) continue;
      out.add(c.ty * w + c.tx);
      const go = c.step?.t === 'go' ? c.step : c.queue.find((s): s is Extract<Step, { t: 'go' }> => s.t === 'go');
      if (go) out.add(go.ty * w + go.tx);
      if (c.standTile) out.add(c.standTile.y * w + c.standTile.x);
    }
    return out;
  }

  private randomFree(kinds: SpotKind[], ch: Character): SpotDef | null {
    const cands: SpotDef[] = [];
    for (const k of kinds) for (const s of this.spots.ofKind(k, this.within(ch))) if (this.spots.isFree(s.id, ch.id)) cands.push(s);
    if (!cands.length) return null;
    return cands[Math.floor(ch.rng() * cands.length)];
  }

  private planOuting(ch: Character, now: number): boolean {
    const near = { tx: ch.tx, ty: ch.ty };
    const rng = ch.rng;
    const persona = personaFor(ch.info.seed);
    // idle colleagues: desire for company (tuned by personality) — TV, game, chat, bets...
    if (this.social.hasCompany(ch, now) && rng() < 0.45 + persona.sociability * 0.4 && this.social.tryInitiate(ch, now, false)) return true;
    const avail: Partial<Record<IdleActivity, boolean>> = {
      coffee: !!this.spots.findFree('coffee', { by: ch.id, within: this.within(ch) }),
      water: !!this.spots.findFree('water', { by: ch.id, within: this.within(ch) }),
      bathroom: !!this.spots.findFree('stall', { by: ch.id, within: this.within(ch) }),
      lounge: LOUNGE_SEATS.some((k) => !!this.spots.findFree(k, { by: ch.id, within: this.within(ch) })),
      // games and chats are gatherings (social/): only solo activities here
      pingpong: false,
      talk: false,
      window: !!this.spots.findFree('window', { by: ch.id, within: this.within(ch) }),
      shelf: !!this.spots.findFree('shelf', { by: ch.id, within: this.within(ch) }),
      arcade: !!this.spots.findFree('arcade', { by: ch.id, within: this.within(ch) }),
      snack: !!this.spots.findFree('snack', { by: ch.id, within: this.within(ch) }),
      stretch: true,
      mirror: !!this.social.plan('mirror', 1, ch),
      phone: !!this.randomFree(PHONE_SEATS, ch),
    };
    const what = pickIdleActivity(rng, avail, soloWeights(persona));
    if (!what) return false;
    const steps: Step[] = [];
    const goUse = (s: SpotDef, held: 'none' | 'coffee' = 'none'): void => {
      steps.push({ t: 'go', tx: s.tx, ty: s.ty, fx: s.x, fy: s.y, dir: s.dir, held });
    };
    const release = (s: SpotDef) => steps.push({ t: 'do', fn: () => this.spots.release(s.id, ch.id) });
    let carry: 'none' | 'coffee' | 'water' = 'none';

    switch (what) {
      case 'coffee': {
        const s = this.spots.findFree('coffee', { near, by: ch.id, within: this.within(ch), rng })!;
        if (!this.reserveTemp(ch, s)) return false;
        this.pushLeave(ch, steps);
        goUse(s);
        steps.push({ t: 'act', pose: 'use', ms: 1900, machine: s.furnitureId, icon: 'coffee' }, { t: 'act', pose: 'drink', held: 'coffee', ms: 2600 });
        release(s);
        carry = 'coffee';
        if (rng() < 0.45) {
          const seat = this.spots.findFree('cafe_seat', { by: ch.id, within: this.within(ch), rng, near: { tx: s.tx, ty: s.ty } });
          if (seat && this.reserveTemp(ch, seat)) {
            steps.push(
              { t: 'go', tx: seat.tx, ty: seat.ty, held: 'coffee' },
              { t: 'enter', spot: seat.id },
              { t: 'act', pose: 'sit', held: 'coffee', ms: between(rng, 6000, 15000) },
              { t: 'exit' },
            );
            release(seat);
          }
        }
        break;
      }
      case 'water': {
        const s = this.spots.findFree('water', { near, by: ch.id, within: this.within(ch), rng })!;
        if (!this.reserveTemp(ch, s)) return false;
        this.pushLeave(ch, steps);
        goUse(s);
        steps.push({ t: 'act', pose: 'use', ms: 1000 }, { t: 'act', pose: 'drink', held: 'water', ms: 2500 });
        release(s);
        carry = rng() < 0.4 ? 'water' : 'none';
        break;
      }
      case 'bathroom': {
        const s = this.spots.findFree('stall', { by: ch.id, within: this.within(ch), rng })!;
        if (!this.reserveTemp(ch, s)) return false;
        this.pushLeave(ch, steps);
        steps.push({ t: 'go', tx: s.tx, ty: s.ty }, { t: 'stall', spot: s.id, ms: between(rng, 5000, 12000), phase: 0 });
        release(s);
        const sink = this.spots.findFree('sink', { near: { tx: s.tx, ty: s.ty }, by: ch.id, within: this.within(ch) });
        if (sink && this.reserveTemp(ch, sink)) {
          goUse(sink);
          steps.push({ t: 'act', pose: 'use', ms: 2200 });
          release(sink);
        }
        break;
      }
      case 'lounge': {
        const s = this.randomFree(LOUNGE_SEATS, ch);
        if (!s || !this.reserveTemp(ch, s)) return false;
        this.pushLeave(ch, steps);
        steps.push({ t: 'go', tx: s.tx, ty: s.ty }, { t: 'enter', spot: s.id });
        if (rng() < (hasTrait(persona, 'sonecas') ? 0.7 : 0.25)) steps.push({ t: 'act', pose: 'sit', ms: between(rng, 3000, 6000) }, { t: 'act', pose: 'sleep', ms: between(rng, 8000, 16000), icon: 'zzz' });
        else steps.push({ t: 'act', pose: 'sit', ms: between(rng, 9000, 22000), icon: rng() < 0.3 ? 'music' : undefined });
        steps.push({ t: 'exit' });
        release(s);
        break;
      }
      case 'pingpong':
      case 'talk':
        return this.social.tryInitiate(ch, now, false);
      case 'mirror':
        return this.social.startSolo('mirror', ch, now);
      case 'phone': {
        // sits on beanbag/couch/bench and scrolls on phone
        const s = this.randomFree(PHONE_SEATS, ch);
        if (!s || !this.reserveTemp(ch, s)) return false;
        this.pushLeave(ch, steps);
        steps.push({ t: 'go', tx: s.tx, ty: s.ty }, { t: 'enter', spot: s.id }, { t: 'act', pose: 'read', held: 'phone', ms: between(rng, 8000, 18000) }, { t: 'exit' });
        release(s);
        break;
      }
      case 'window': {
        // look out window or check room kanban board
        const board = rng() < 0.35 ? this.spots.findFree('whiteboard', { by: ch.id, within: this.within(ch), filter: (p) => p.areaId === ch.roomId }) : null;
        const s = board ?? this.spots.findFree('window', { by: ch.id, within: this.within(ch), rng });
        if (!s || !this.reserveTemp(ch, s)) return false;
        this.pushLeave(ch, steps);
        goUse(s);
        steps.push({ t: 'act', pose: board ? 'read' : 'stand', held: board ? 'papers' : 'none', ms: between(rng, 5000, 10000), icon: rng() < 0.3 ? 'idea' : undefined });
        release(s);
        break;
      }
      case 'shelf': {
        const s = this.spots.findFree('shelf', { by: ch.id, within: this.within(ch), rng })!;
        if (!this.reserveTemp(ch, s)) return false;
        this.pushLeave(ch, steps);
        goUse(s);
        steps.push({ t: 'act', pose: 'read', held: 'book', ms: between(rng, 5000, 9000) });
        release(s);
        break;
      }
      case 'arcade': {
        const s = this.spots.findFree('arcade', { by: ch.id, within: this.within(ch), rng })!;
        if (!this.reserveTemp(ch, s)) return false;
        this.pushLeave(ch, steps);
        goUse(s);
        steps.push({ t: 'act', pose: 'use', ms: between(rng, 6000, 12000), icon: rng() < 0.4 ? 'star' : undefined });
        release(s);
        break;
      }
      case 'snack': {
        // snack machine or breakroom fridge
        const s = this.spots.findFree(rng() < 0.6 ? 'snack' : 'fridge', { by: ch.id, within: this.within(ch), rng }) ?? this.spots.findFree('snack', { by: ch.id, within: this.within(ch), rng });
        if (!s || !this.reserveTemp(ch, s)) return false;
        this.pushLeave(ch, steps);
        goUse(s);
        steps.push({ t: 'act', pose: 'use', ms: 1600 }, { t: 'act', pose: 'stand', ms: 900 });
        release(s);
        break;
      }
      case 'stretch': {
        const home = ch.homeSpot;
        if (!home) return false;
        steps.push({ t: 'exit' }, { t: 'act', pose: 'stretch', ms: 2600 }, { t: 'enter', spot: home });
        steps.push({ t: 'do', fn: () => (ch.nextOutingAt = this.now + idleSitMs(ch.rng, this.options().liveliness)) });
        ch.queue.push(...steps);
        return true;
      }
    }
    ch.queue.push(...steps);
    this.pushHome(ch, carry);
    void now;
    return true;
  }

  /** Returns to desk at end of outing. */
  pushHome(ch: Character, held: 'none' | 'coffee' | 'water'): void {
    const home = this.spots.get(ch.homeSpot);
    ch.queue.push({ t: 'do', fn: () => this.releaseTemp(ch) });
    if (!home) return;
    ch.queue.push({ t: 'go', tx: home.tx, ty: home.ty, held }, { t: 'enter', spot: home.id });
    ch.queue.push({ t: 'do', fn: () => (ch.nextOutingAt = this.now + idleSitMs(ch.rng, this.options().liveliness)) });
  }

  /** Rest pose when idle (at desk: typing, waiting for user, sitting, or napping). */
  private restPose(ch: Character, now: number): void {
    const spot = ch.atSpot ? this.spots.get(ch.atSpot) : undefined;
    const atHome = !!spot && ch.atSpot === ch.homeSpot;
    if (!spot) {
      // no seat (full room): works standing with laptop
      if (ch.mode === 'wait') ch.setPose('raise_hand');
      else if (ch.mode === 'work' && ch.standTile) ch.setPose('read', 'laptop');
      else ch.setPose('stand');
      return;
    }
    if (spot.kind === 'stand') {
      ch.dir = spot.dir;
      if (ch.mode === 'work') ch.setPose('read', 'laptop');
      else if (ch.mode === 'wait') ch.setPose('raise_hand');
      else ch.setPose('stand');
      return;
    }
    if (!spot.seated) {
      ch.setPose('stand');
      return;
    }
    ch.dir = spot.dir;
    // sem mesa (banqueta, poltrona, puff): trabalha no notebook
    const laptop = spot.kind === 'stool' || spot.kind === 'nook';
    if (atHome && ch.mode === 'work') ch.setPose('type', laptop ? 'laptop' : 'none');
    else if (atHome && ch.mode === 'wait') ch.setPose('raise_hand');
    else if (atHome && ch.mode === 'shell') this.shellPose(ch, spot, now);
    else if (ch.mode === 'idle' && this.longIdle(ch, now)) ch.setPose('sleep');
    else ch.setPose('sit');
  }

  /**
   * Shell wait pose seated at desk, based on escalation (sim/shell.ts): popcorn, crossed arms
   * with chair spins, yawns under spiderwebs, and finally a nap. Zero-alloc (runs per frame).
   */
  private shellPose(ch: Character, spot: SpotDef, now: number): void {
    // visit: crossed arms watching terminal, always (escalation depends on timestamps absent from world)
    if (this.visit) {
      ch.setPose('wait');
      return;
    }
    const age = now - ch.shellSince;
    switch (ch.shellStage ?? shellStage(age)) {
      case 'popcorn':
        ch.setPose('wait', 'popcorn');
        return;
      case 'restless': {
        // full chair spin (directions in quick sequence), with crossed arms
        ch.dir = spinDir(spinPhase(age, ch.info.seed), spot.dir);
        ch.setPose('wait');
        return;
      }
      case 'cobweb': {
        const yawn = yawnPhase(age, ch.info.seed);
        if (yawn >= 0) {
          // yawn: head drops and a 🥱 escapes
          if (now > ch.chatUntil) {
            ch.chatEmoji = '🥱';
            ch.chatUntil = now + 1300;
          }
          ch.setPose('sleep');
        } else ch.setPose('wait');
        return;
      }
      case 'nap':
        ch.setPose('sleep');
        return;
    }
  }

  // =================================================================== visita

  /** Idle for a long time, out of quota or a ghost (stays at its desk, no strolls)? In visits, never: time is omitted. */
  longIdle(ch: Character, now: number): boolean {
    return !this.visit && (!!ch.energy?.asleep || !!ch.info.ghost || isLongIdle(ch.info.status, ch.info.statusSince, now));
  }

  /** Drawn characters: agents and, during visits, the visitor (last). */
  *people(): IterableIterator<Character> {
    yield* this.chars.values();
    if (this.visitor && !this.visitor.gone) yield this.visitor;
  }

  /** A drawn character by ID (agent or visitor). */
  person(id: string): Character | undefined {
    return this.chars.get(id) ?? (this.visitor?.id === id ? this.visitor : undefined);
  }

  /** Visit: visitor appears in reception elevator and walks into lobby (null removes visitor). */
  setVisitor(info: AgentInfo | null, now: number): Character | null {
    const old = this.visitor;
    if (old) for (const e of this.elevators) e.release(old.id, now);
    this.visitor = null;
    this.visitorIntent = { ...NO_INTENT };
    if (!info) return null;
    let appearance;
    try {
      appearance = { ...this.art.appearanceFromSeed(info.seed, { look: info.look, sub: false, parts: info.parts }), lanyard: VISITOR_LANYARD };
    } catch {
      return null;
    }
    const ch = new Character(info, appearance);
    const el = this.elevators[0];
    const spot = el ? this.spots.get(el.spotId) : undefined;
    if (!el || !spot) return null;
    ch.placeAtTile(spot.tx, spot.ty);
    ch.x = spot.x;
    ch.y = spot.y - 6;
    ch.dir = 'down';
    ch.alpha = 0;
    ch.inside = true;
    ch.arriving = true;
    ch.hiddenUntil = el.reserveAppear(now);
    ch.queue.push({ t: 'elevOut', elev: el.index, phase: 0 });
    this.visitor = ch;
    return ch;
  }

  /** Visitor is in elevator (arriving or leaving): cannot walk or exit again. */
  get visitorBusy(): boolean {
    const v = this.visitor;
    if (!v || v.gone) return true;
    return v.leaving || [v.step, ...v.queue].some((s) => s?.t === 'elevOut' || s?.t === 'elevIn');
  }

  /** Visit: visitor walks to tile (click; cancelled by keyboard). */
  visitorWalkTo(tx: number, ty: number, run = false): boolean {
    const v = this.visitor;
    if (!v || this.visitorBusy) return false;
    v.queue.length = 0;
    v.step = null;
    v.queue.push({ t: 'go', tx, ty, run });
    return true;
  }

  /** Elevator near visitor (within EXIT_RADIUS tiles from front), or null: used to exit building. */
  visitorElevator(): Elevator | null {
    const v = this.visitor;
    if (!v || this.visitorBusy) return null;
    const t = tileAt(v.x, v.y);
    for (const e of this.elevators) {
      const spot = this.spots.get(e.spotId);
      if (spot && Math.hypot(spot.tx - t.x, spot.ty - t.y) <= EXIT_RADIUS) return e;
    }
    return null;
  }

  /** Visit: visitor enters nearest elevator and vanishes; `done` when door closes (scene sends `leave`). */
  visitorExit(done: () => void): boolean {
    const v = this.visitor;
    if (!v || this.visitorBusy) return false;
    const t = tileAt(v.x, v.y);
    let best: { e: Elevator; d: number; tx: number; ty: number } | null = null;
    for (const e of this.elevators) {
      const spot = this.spots.get(e.spotId);
      if (!spot) continue;
      const d = Math.hypot(spot.tx - t.x, spot.ty - t.y);
      if (!best || d < best.d) best = { e, d, tx: spot.tx, ty: spot.ty };
    }
    if (!best) return false;
    v.queue.length = 0;
    v.step = null;
    v.leaving = true;
    this.visitorIntent = { ...NO_INTENT };
    v.queue.push({ t: 'go', tx: best.tx, ty: best.ty }, { t: 'elevIn', elev: best.e.index, phase: 0 }, { t: 'do', fn: done });
    return true;
  }

  /**
   * Visit lights (see VisitLight): away keeps empty rooms dark; discreet keeps ready rooms lit. Live does
   * nothing (first arrival turns on, last departure turns off). `instant`: skips transition (building entry).
   */
  applyVisitLight(now: number, instant = false): void {
    if (!this.visit || this.visitLight === 'live') return;
    const at = instant ? now - 10_000 : now;
    for (const room of this.rooms.values()) {
      if (!room.present || room.ghost) continue;
      if (this.visitLight === 'away') {
        if (room.lightOn && this.occupants(room) === 0 && !this.switchClaimValid(room)) room.setLight(false, at);
      } else if (!room.lightOn && room.phase === 'ready') room.setLight(true, at);
    }
  }

  /** Visit: keyboard free movement (with collision); otherwise, queue step (elevator, click path). */
  private runVisitor(v: Character, dt: number, now: number): void {
    v.animT += dt * 1000;
    if (v.icon && now >= v.iconUntil) v.icon = null;
    const intent = this.visitorIntent;
    const busy = this.visitorBusy;
    if (!busy && (intent.dx || intent.dy)) {
      // keyboard takes priority: discard click path
      v.queue.length = 0;
      v.step = null;
      const r = stepFree(this.building.grid, { x: v.x, y: v.y, dir: v.dir }, intent, (intent.run ? RUN_SPEED : WALK_SPEED) * dt);
      v.x = r.x;
      v.y = r.y;
      v.dir = r.dir;
      const t = tileAt(v.x, v.y);
      v.tx = t.x;
      v.ty = t.y;
      v.setPose(r.moved ? (intent.run ? 'run' : 'walk') : 'stand');
      return;
    }
    if (!v.step) {
      v.step = v.queue.shift() ?? null;
      v.stepT = 0;
      v.stepStarted = false;
    }
    if (v.step) {
      const done = this.runStep(v, v.step, dt, now);
      v.stepT += dt * 1000;
      if (done) v.step = null;
      if (v.arriving && !v.step && !v.queue.length) v.arriving = false;
      return;
    }
    v.setPose('stand');
  }

  // =================================================================== aba oculta

  /** Fast-forwards everything to destinations (used when returning from a background tab). */
  fastForward(now: number): void {
    this.now = now;
    for (const room of this.rooms.values()) {
      if (room.phase === 'building') room.setPhase('ready', now - 10_000);
      if (room.phase === 'dismantling') room.setPhase('gone', now);
      room.lightAt = now - 10_000;
    }
    this.updateRooms(now);
    for (const e of this.elevators) e.reset();
    this.machineUntil.clear();
    this.social.reset(now);
    for (const ch of [...this.chars.values()]) {
      for (let guard = 0; guard < 60 && !ch.gone; guard++) {
        if (!ch.step) ch.step = ch.queue.shift() ?? null;
        if (!ch.step) break;
        this.finishStep(ch, ch.step, now);
        ch.step = null;
      }
      ch.gathering = null;
      if (ch.leaving && !ch.gone) ch.gone = true;
      if (ch.gone) {
        this.spots.releaseAll(ch.id);
        this.chars.delete(ch.id);
        continue;
      }
      ch.alpha = 1;
      ch.inside = false;
      ch.arriving = false;
      ch.hiddenUntil = 0;
      ch.stepT = 0;
      if (ch.mode === 'work' || ch.mode === 'wait' || ch.mode === 'idle' || ch.mode === 'shell') {
        ch.reactUntil = 0;
        this.assignHome(ch);
        const home = this.spots.get(ch.homeSpot);
        if (home) {
          this.snapTo(ch, home);
          ch.standTile = null;
        } else {
          ch.atSpot = null;
          ch.seated = false;
          ch.sortY = null;
          this.placeOverflow(ch);
        }
        this.releaseTemp(ch);
        ch.nextOutingAt = now + idleSitMs(ch.rng, this.options().liveliness);
      }
    }
    for (const room of this.rooms.values()) {
      if (room.present && this.occupants(room) > 0) room.setLight(true, now - 10_000);
      room.switchClaim = null;
    }
    this.stallBusy.clear();
    // visitor finishes action: reaches lobby or enters elevator when exiting (triggering exit)
    const v = this.visitor;
    if (v) {
      for (let guard = 0; guard < 10; guard++) {
        if (!v.step) v.step = v.queue.shift() ?? null;
        if (!v.step) break;
        const s = v.step;
        v.step = null;
        if (s.t === 'elevIn') {
          v.inside = true;
          v.alpha = 0;
        } else this.finishStep(v, s, now);
      }
      if (!v.leaving) {
        v.alpha = 1;
        v.inside = false;
        v.arriving = false;
        v.hiddenUntil = 0;
        v.setPose('stand');
      }
    }
    if (this.visit) this.applyVisitLight(now);
  }

  private finishStep(ch: Character, s: Step, now: number): void {
    switch (s.t) {
      case 'go':
        ch.placeAtTile(s.tx, s.ty);
        if (s.fx !== undefined && s.fy !== undefined) {
          ch.x = s.fx;
          ch.y = s.fy;
        }
        if (s.dir) ch.dir = s.dir;
        break;
      case 'enter': {
        const spot = this.spots.get(s.spot);
        if (spot) this.snapTo(ch, spot);
        break;
      }
      case 'exit':
        if (ch.atSpot) {
          const spot = this.spots.get(ch.atSpot);
          if (spot) ch.placeAtTile(spot.tx, spot.ty);
        }
        ch.atSpot = null;
        ch.seated = false;
        ch.sortY = null;
        break;
      case 'switch': {
        const room = this.rooms.get(s.room);
        if (room && (!s.onlyIfLast || isLastInRoom(room.id, ch.id, this.chars.values()))) room.setLight(s.on, now - 10_000);
        break;
      }
      case 'stall': {
        const spot = this.spots.get(s.spot);
        if (spot) ch.placeAtTile(spot.tx, spot.ty);
        break;
      }
      case 'elevOut': {
        const el = this.elevators[s.elev] ?? this.elevators[0];
        const spot = this.spots.get(el.spotId);
        if (spot) ch.placeAtTile(spot.tx, spot.ty);
        break;
      }
      case 'do':
        s.fn();
        break;
      case 'remove':
      case 'elevIn':
        ch.gone = true;
        break;
      default:
        break;
    }
  }
}
