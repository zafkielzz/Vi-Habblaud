// Habblaud World city scene: connects stream (net/world-stream.ts: local server or demo-mode mock city),
// state, local player, camera, renderer, input, cards, and minimap. Mounted by app.ts when the World
// button opens the scene; stream exists only while scene is on screen (opens on show, closes on hide).
// Lightweight social features (Phase 5: like, greetings, knock on door, profile, "Go to", plaza, and facades) live in
// social.ts, wired via minimal hooks (messages, snapshot, frame, renderer, cards, and keys).
// Local character enters street only with server-validated position (`pos` from snapshot or message): no
// `move` originates from a guessed position. When away (`afk`), character stays still; stopped on a bench, sits down.
// Visit (Phase 4): within ENTER_RADIUS tiles of a building door, "Enter (E)" sends `enter`; incoming `building`
// opens Visit scene (world/visit/) on top, with city paused (no rendering, keyboard, or `move`) and stream
// kept open; subsequent `pos` represents returning to street, at the door. Rejections (`notice`) become on-screen toasts.
// Returning to city on same page (resume.ts): camera and zoom preserved from close, previous city stays on screen until
// new snapshot, and initial `pos` matching the last keeps everything as-is (different position: direct, no animation).
import * as artModule from '../../art';
import type { ArtModule } from '../../art/api';
import { TILE } from '../../art/api';
import { tr } from '../../../../shared/i18n';
import { blockAt, chunkOf, lotDoor } from '../../../../shared/world/city';
import type { WorldSceneInside } from '../../../../shared/world/api';
import type { AwaySummary } from '../../../../shared/world/protocol';
import { parseAwaySummary } from '../../../../shared/world/scene';
import type { WorldStream, WorldStreamEvent } from '../../net/world-stream';
import type { WorldOptions } from '../api';
import { Camera } from '../camera';
import { PathFinder } from '../path/astar';
import { h } from '../../ui/dom';
import { worldErrorText } from '../../ui/world/world-model';
import { CityCards } from './cards';
import { CityInput } from './input';
import { buildWalkGrid, nearestDoor, nearestWalkableTile, walkRectFor, walkable } from './layout';
import { Minimap } from './minimap';
import { noticeText, type NoticePlace } from './notice';
import { createVisitScene, type VisitScene } from '../visit';
import { LocalPlayer, MoveSender, pathPoints } from './players';
import { CityRenderer } from './scene';
import { resumePlacement, type CityResume } from './resume';
import { CitySocial } from './social';
import { CityState, type CityEffect } from './state';

const art: ArtModule = artModule;

/** Minimum city zoom: ~200 lots on a 1400 × 900 screen. */
export const CITY_MIN_ZOOM = 0.28;
/** Extra zoom levels below 1 (office camera only has device pixel integers). */
const LOW_LEVELS = [0.375, 0.5, 0.75];
/** Background tab repeats position every interval (ms). */
const KEEPALIVE_MS = 30_000;
/**
 * "Enter (E)" within this distance (tiles) from door front (`lotDoor(lot).front`), same calculation as world server
 * (which adds 1 tile leeway). TODO: use `ENTER_RADIUS`/`doorDistance` from shared/world/city.ts once server publishes
 * it (file is hashed on server).
 */
export const ENTER_RADIUS = 2;
/** Notice arriving within this window after `enter` is door response (closed, full, too far...). */
const DOOR_NOTICE_MS = 5_000;

class CityCamera extends Camera {
  override levels(): number[] {
    const set = new Set(super.levels());
    for (const z of LOW_LEVELS) if (z >= this.minZoom - 1e-6) set.add(z);
    set.add(this.minZoom);
    return [...set].sort((a, b) => a - b);
  }
}

export interface CitySceneOptions {
  canvas: HTMLCanvasElement;
  /** Where cards, minimap, tooltips, and toasts attach (#ui, with UI styles). */
  uiRoot: HTMLElement;
  /** Opens stream (net/world-stream.ts: local server or mock). Called each time scene appears. */
  openStream: () => WorldStream;
  /** Office options (day/night, names). */
  options: () => WorldOptions;
  /** Margin covered by top bar (CSS px). */
  topInset: () => number;
  /** Habblaud version (visiting office carries in `meta.version`). */
  version?: () => string;
}

export interface CityScene {
  readonly visible: boolean;
  show(): void;
  hide(): void;
  zoomBy(factor: number): void;
  /** Camera back on player. */
  recenter(): void;
  /** Camera stationary at a point (tiles), without following player until they walk (screenshots, debugging). */
  lookAt(x: number, y: number, zoom?: number): void;
  /** Esc: closes open card (true) or nothing to close (false). */
  escape(): boolean;
  destroy(): void;
  /** Performance metrics (debugging and benchmark script). */
  perf(): { frames: number; drawAvgMs: number; drawP95Ms: number; drawMaxMs: number; fps: number; buildings: number; zoom: number };
  /** Resets metrics (to measure steady state only, excluding sprite-generation frame). */
  perfReset(): void;
  readonly camera: Camera;
  readonly state: CityState;
  /** Local player (debugging and browser tests). */
  me(): { x: number; y: number; moving: boolean; seated: boolean } | null;
  /** Screen point (canvas CSS px) for a tile position. */
  toScreen(x: number, y: number): { x: number; y: number };
  /** Enters building (`enter`): from door (within ENTER_RADIUS tiles) or, if mine, from anywhere. */
  enter(buildingId: string): void;
  /** "See what others see": enters own building as soon as city is ready. */
  visitOwn(): void;
  /** Visit scene currently open (null on street). */
  visit(): VisitScene | null;
  /** Door front of a city building (tiles), or null (debugging and screenshots). */
  doorOf(buildingId: string): { x: number; y: number } | null;
  /** Walks to (x, y) tiles via A*, like clicking on ground (debugging and screenshots). */
  walkTo(x: number, y: number): boolean;
}

export function createCityScene(o: CitySceneOptions): CityScene {
  const camera = new CityCamera();
  camera.minZoom = CITY_MIN_ZOOM;
  camera.bounds = { x: -1e7, y: -1e7, w: 2e7, h: 2e7 };
  let state = new CityState();
  let renderer = new CityRenderer(o.canvas, art, camera, state);
  let stream: WorldStream | null = null;
  let me: LocalPlayer | null = null;
  let sender: MoveSender | null = null;
  let following = true;
  let visible = false;
  let raf = 0;
  let lastTs = 0;
  let mouse: { x: number; y: number } | null = null;
  let keepAlive: ReturnType<typeof setInterval> | null = null;
  /** Chunk I am in (when changing, chunks outside 3×3 leave state). */
  let myChunk = '';
  /** Inside a building: Visit scene (city remains paused underneath, stream open). */
  let visit: VisitScene | null = null;
  /** On hide: camera, zoom, and previous position, to resume city identically (resume.ts). */
  let resume: CityResume | null = null;
  /** Reopened with character on street: previous city stays on screen, paused, until new stream snapshot. */
  let resuming = false;
  /** Return snapshot arrived without `pos`: first `pos` decides (same place or straight to new one). */
  let resumeAwaitingPos = false;
  /** Latest "While you were away" from stream (stamps go to reception board of own building). */
  let awaySummary: AwaySummary | undefined;
  /** Latest sent `enter` (notices arriving shortly after come from door). */
  let entering: { id: string; at: number } | null = null;
  /** "See what others see" requested before city was ready. */
  let pendingOwn = false;
  const finder = new PathFinder(buildWalkGrid({ x: 0, y: 0, w: 4, h: 4 }).grid);
  const frameMs: number[] = [];
  const rafGaps: number[] = [];

  // ------------------------------------------------------------------ DOM: cards, minimap, tips, toasts

  let social: CitySocial | null = null;
  const cards = new CityCards({
    showBuilding: (id) => focusBuilding(id),
    topInset: () => o.topInset(),
    enter: (id) => enter(id),
    extras: (kind, id) => social?.cardExtras(kind, id) ?? null,
  });
  const minimap = new Minimap((tile) => {
    following = false;
    const z = camera.zoom;
    const c = camera.centerFor(tile.x * TILE, tile.y * TILE, z);
    camera.animateTo(c.x, c.y, z, Date.now(), 380);
  });
  const toast = h('div', { class: 'ui-city-toast', role: 'status', attrs: { 'aria-live': 'polite' }, hidden: true });
  const loading = h('div', { class: 'ui-city-loading', text: tr('Entering the city…') });
  const help = h(
    'div',
    { class: 'ui-city-help', attrs: { 'aria-hidden': 'true' } },
    h('span', {}, h('kbd', { text: 'WASD' }), ' ', tr('walk')),
    h('span', {}, h('kbd', { text: 'Shift' }), ' ', tr('run')),
    h('span', {}, h('kbd', { text: tr('click') }), ' ', tr('go there')),
    h('span', {}, h('kbd', { text: 'E' }), ' ', tr('enter')),
    h('span', {}, h('kbd', { text: 'Esc' }), ' ', tr('office')),
  );
  const layer = h('div', { class: 'ui-city', hidden: true }, cards.el, minimap.el, help, toast, loading);
  o.uiRoot.append(layer);
  social = new CitySocial({
    state: () => state,
    renderer: () => renderer,
    camera,
    canvas: o.canvas,
    send: (cmds) => stream?.send(cmds),
    me: () => (me ? { x: me.x, y: me.y } : null),
    cards,
    toast: (text) => showToast(text),
    active: () => visible,
    teleported: () => {
      // teleport: camera snaps along (without panning across city) and surrounding chunks update
      if (!me) return;
      following = true;
      camera.stop();
      const c = camera.centerFor(me.x * TILE, me.y * TILE - 12, camera.zoom);
      camera.x = c.x;
      camera.y = c.y;
      myChunk = '';
    },
    replay: (msg) => {
      const eff = state.apply(msg, performance.now());
      if (eff) onEffect(eff);
    },
    testFireworks: () => (stream as { celebrate?: () => void } | null)?.celebrate?.(),
  });
  layer.append(social.el);
  help.append(...social.helpItems());
  let toastTimer: ReturnType<typeof setTimeout> | null = null;
  const showToast = (text: string) => {
    toast.textContent = text;
    toast.hidden = false;
    toast.classList.remove('is-in');
    void toast.offsetWidth;
    toast.classList.add('is-in');
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (toast.hidden = true), 2600);
  };

  // ------------------------------------------------------------------ size

  const resize = () => {
    const dpr = Math.max(1, Math.min(3, window.devicePixelRatio || 1));
    const w = o.canvas.clientWidth || window.innerWidth;
    const hh = o.canvas.clientHeight || window.innerHeight;
    const pw = Math.floor(w * dpr);
    const ph = Math.floor(hh * dpr);
    if (o.canvas.width !== pw || o.canvas.height !== ph) {
      o.canvas.width = pw;
      o.canvas.height = ph;
    }
    camera.setView(w, hh, dpr);
    camera.insets = { top: o.topInset(), right: 0, bottom: 0, left: 0 };
  };

  // ------------------------------------------------------------------ local player

  /** Places local character on street at server-validated position (without it, waits for `pos`). */
  const placeMe = () => {
    const self = state.me;
    let p = state.startPos;
    if (!self || me || !p) return;
    state.startPos = null;
    if (!walkable(p.x, p.y)) {
      const t = nearestWalkableTile(p.x, p.y);
      if (t) p = { x: t.x + 0.5, y: t.y + 0.5 };
    }
    me = new LocalPlayer(p.x, p.y);
    sender = new MoveSender((m) => stream?.send([m]));
    following = true;
    const z = camera.zoom;
    const c = camera.centerFor(me.x * TILE, me.y * TILE - 12, z);
    camera.stop();
    camera.x = c.x;
    camera.y = c.y;
    loading.hidden = true;
  };

  /** Camera directly on local player (no animation), with current zoom. */
  const snapCamera = () => {
    if (!me) return;
    following = true;
    const c = camera.centerFor(me.x * TILE, me.y * TILE - 12, camera.zoom);
    camera.stop();
    camera.x = c.x;
    camera.y = c.y;
  };

  /** First snapshot after reopening scene: `pos` equal to last leaves everything as-is. */
  const resumeFromSnapshot = () => {
    resuming = false;
    const pos = state.startPos;
    if (!pos) {
      // `pos` arrives later (local server didn't have it yet): it decides
      resumeAwaitingPos = true;
      return;
    }
    const how = resumePlacement(resume, pos);
    resume = null;
    if (how === 'keep') {
      // neither character nor camera changes
      state.startPos = null;
      sender?.reset();
      return;
    }
    // different place (or nothing saved): placeMe puts character directly there, camera following at same zoom
    me = null;
    sender = null;
  };

  /** A* path from current position to (x, y) tiles. */
  const walkTo = (x: number, y: number, run: boolean): boolean => {
    if (!me) return false;
    let goal = { x, y };
    if (!walkable(x, y)) {
      const t = nearestWalkableTile(x, y, 6);
      if (!t) return false;
      goal = { x: t.x + 0.5, y: t.y + 0.5 };
    }
    const win = buildWalkGrid(walkRectFor(me, goal));
    finder.setGrid(win.grid);
    const sx = Math.floor(me.x) - win.ox;
    const sy = Math.floor(me.y) - win.oy;
    const gx = Math.floor(goal.x) - win.ox;
    const gy = Math.floor(goal.y) - win.oy;
    const cells: number[] = [];
    if (!finder.find(sx, sy, gx, gy, cells)) return false;
    me.follow(pathPoints(cells, win.ox, win.oy, goal), run);
    following = true;
    return true;
  };

  const focusBuilding = (id: string) => {
    const b = state.buildings.get(id);
    if (!b) return;
    following = false;
    const d = lotDoor(b.lot);
    const z = Math.max(camera.zoom, 1.5);
    const c = camera.centerFor(d.front.x * TILE, d.front.y * TILE - 60, z);
    camera.animateTo(c.x, c.y, z, Date.now(), 420);
  };

  const onEffect = (eff: CityEffect) => {
    switch (eff.type) {
      case 'building':
        startVisit(eff.inside);
        break;
      case 'building.patch':
        visit?.patch(eff.msg);
        break;
      case 'pos':
        // inside a building, `pos` is sidewalk in front of door: back on street
        if (visit) endVisit();
        if (me && resumeAwaitingPos) {
          // back in city, first `pos`: same place changes nothing; different, character and camera snap directly
          resumeAwaitingPos = false;
          const how = resumePlacement(resume, eff);
          resume = null;
          if (how !== 'keep') {
            me.correct(eff.x, eff.y);
            snapCamera();
          }
          sender?.reset();
        } else if (me) {
          me.correct(eff.x, eff.y);
          sender?.reset();
        } else {
          // spawn (server decides where, on first `view`)
          state.startPos = { x: eff.x, y: eff.y };
          placeMe();
          enterOwnIfPending();
        }
        break;
      case 'afk':
        // Away: stays still where it is (walking autonomously to a bench would send `move` and postpone leaving street).
        // Stopped on a bench, scene draws character seated, like others.
        break;
      case 'profile':
        if (cards.kind === 'player' && cards.id === eff.player.id) {
          const rp = state.players.get(eff.player.id);
          const info = rp ? rp.info : eff.player;
          cards.showPlayer(info, info.buildingId ? state.buildings.get(info.buildingId) : undefined, null);
        }
        break;
      case 'notice': {
        const place: NoticePlace = visit ? 'inside' : entering && Date.now() - entering.at < DOOR_NOTICE_MS ? 'door' : 'street';
        if (place === 'door') entering = null;
        const text = noticeText(eff.text, place);
        if (text) showToast(text);
        break;
      }
    }
  };

  // ------------------------------------------------------------------ visit (Phase 4)

  const enter = (id: string) => {
    if (visit || !stream || !me) {
      if (!me && id === state.myBuildingId) pendingOwn = true;
      return;
    }
    entering = { id, at: Date.now() };
    stream.send([{ t: 'enter', buildingId: id }]);
  };

  /** "See what others see" requested while city is still opening: enters once on street (with `pos`). */
  const enterOwnIfPending = () => {
    if (!pendingOwn || !me || !state.connected || !state.myBuildingId) return;
    pendingOwn = false;
    enter(state.myBuildingId);
  };

  /** `building` arrived: Visit scene opens (or, already inside same building, replaces full interior). */
  const startVisit = (inside: WorldSceneInside) => {
    entering = null;
    if (visit && visit.id === inside.id) {
      visit.replace(inside);
      return;
    }
    if (visit) endVisit();
    const self = state.me;
    if (!self || !visible) return;
    cards.hide();
    input.clearKeys();
    cancelAnimationFrame(raf);
    o.canvas.hidden = true;
    layer.classList.add('is-visiting');
    const s = stream;
    visit = createVisitScene({
      uiRoot: o.uiRoot,
      after: o.canvas,
      inside,
      me: self,
      mine: inside.id === state.myBuildingId,
      options: () => o.options(),
      version: o.version?.() ?? '',
      topInset: () => o.topInset(),
      send: (cmds) => s?.send(cmds),
      toast: (text) => showToast(text),
      summaryStamps: () => awaySummary?.stamps ?? [],
      // no response to `leave`: restarts city (local server sends `view`, which world treats as return)
      stuck: () => {
        endVisit();
        stream?.send([{ t: 'view' }]);
      },
    });
  };

  /** Back on street: Visit scene exits and city resumes rendering, camera centered on player. */
  const endVisit = () => {
    if (!visit) return;
    const v = visit;
    visit = null;
    v.destroy();
    layer.classList.remove('is-visiting');
    if (!visible) return;
    o.canvas.hidden = false;
    lastTs = 0;
    cancelAnimationFrame(raf);
    raf = requestAnimationFrame(loop);
    following = true;
  };

  // ------------------------------------------------------------------ stream

  const offline = () => tr('No connection to Habblaud World right now; Habblaud tries again on its own.');

  const onStream = (ev: WorldStreamEvent) => {
    switch (ev.type) {
      case 'snapshot': {
        state.applySnapshot(ev.snapshot, performance.now());
        social?.snapshot(ev.snapshot);
        awaySummary = ev.snapshot.summary;
        if (resuming) resumeFromSnapshot();
        placeMe();
        if (me) myChunk = '';
        // new stream during visit stays inside; without interior, back on street
        if (state.inside) startVisit(state.inside);
        else if (visit) endVisit();
        enterOwnIfPending();
        // without connection to world server, nothing downloads: show this instead of "Entering the city…"
        loading.textContent = state.connected ? tr('Entering the city…') : offline();
        loading.hidden = state.connected && !!me;
        return;
      }
      case 'message': {
        // inside a building, visit handles like and stamp notices first
        if (visit?.message(ev.msg)) return;
        // social sees message before state (previous value) and handles notices for its own commands
        if (social?.message(ev.msg, performance.now())) return;
        if (ev.msg.t === 'away.summary') awaySummary = parseAwaySummary(ev.msg) ?? awaySummary;
        const eff = state.apply(ev.msg, performance.now());
        if (eff) onEffect(eff);
        return;
      }
      case 'status':
        // SSE to local server dropped: browser reconnects and new snapshot replaces everything
        if (ev.status === 'retrying') {
          loading.textContent = offline();
          loading.hidden = false;
        }
        return;
      case 'error':
        // command rejected by local server; without world connection, notice stays until return snapshot
        if (ev.code === 'not_connected') {
          loading.textContent = offline();
          loading.hidden = false;
        } else if (ev.code !== 'no_stream') showToast(worldErrorText(ev.code, 'scene'));
        return;
    }
  };

  const openStream = () => {
    // back on same page with character on street: previous city stays on screen until snapshot (no flicker)
    resuming = !!(resume?.me && me);
    resumeAwaitingPos = false;
    if (!resuming) {
      resume = null;
      state = new CityState();
      renderer = new CityRenderer(o.canvas, art, camera, state);
      renderer.fx = social;
      me = null;
      sender = null;
      loading.textContent = tr('Entering the city…');
      loading.hidden = false;
    }
    social?.reset();
    myChunk = '';
    cards.hide();
    const s = o.openStream();
    stream = s;
    s.on((ev) => {
      if (stream !== s) return;
      try {
        onStream(ev);
      } catch (err) {
        console.error('[city] stream event ignored', err);
      }
    });
  };

  const closeStream = () => {
    stream?.close();
    stream = null;
  };

  // ------------------------------------------------------------------ hit-test

  type Hit = { type: 'building'; id: string } | { type: 'player'; id: string } | null;

  const pick = (sx: number, sy: number): Hit => {
    const w = camera.screenToWorld(sx, sy);
    const slack = Math.max(1, 3 / camera.zoom);
    for (let i = renderer.charsDrawn.length - 1; i >= 0; i--) {
      const c = renderer.charsDrawn[i]!;
      if (!c.visible || c.me) continue;
      if (w.x >= c.bx - slack && w.x <= c.bx + c.bw + slack && w.y >= c.by - slack && w.y <= c.by + c.bh + slack) return { type: 'player', id: c.id };
    }
    let best: Hit = null;
    let bestDepth = -Infinity;
    for (const v of renderer.buildingsDrawn) {
      if (w.x < v.x || w.x > v.x + 192 || w.y < v.y || w.y > v.y + v.m.height) continue;
      if (v.depth > bestDepth) {
        bestDepth = v.depth;
        best = { type: 'building', id: v.b.id };
      }
    }
    return best;
  };

  let hovered: Hit = null;

  const onClick = (sx: number, sy: number, mods: { shift: boolean }) => {
    const hit = pick(sx, sy);
    const at = screenPoint(sx, sy);
    if (hit?.type === 'player') {
      const rp = state.players.get(hit.id);
      if (!rp) return;
      cards.showPlayer(rp.info, rp.info.buildingId ? state.buildings.get(rp.info.buildingId) : undefined, at);
      stream?.send([{ t: 'profile', playerId: hit.id }]);
      return;
    }
    if (hit?.type === 'building') {
      const b = state.buildings.get(hit.id);
      if (!b) return;
      cards.showBuilding(b, state.myBuildingId, at, true);
      const d = lotDoor(b.lot).front;
      walkTo(d.x, d.y + (lotDoor(b.lot).side === 's' ? 0.3 : -0.3), mods.shift);
      return;
    }
    cards.hide();
    const w = camera.screenToWorld(sx, sy);
    walkTo(w.x / TILE, w.y / TILE, mods.shift);
  };

  const screenPoint = (sx: number, sy: number) => {
    const r = o.canvas.getBoundingClientRect();
    return { x: r.left + sx, y: r.top + sy };
  };

  const updateHover = () => {
    if (!mouse) {
      if (hovered && cards.kind === 'building' && !cards.pinned) cards.hide();
      hovered = null;
      o.canvas.style.cursor = '';
      return;
    }
    const hit = pick(mouse.x, mouse.y);
    hovered = hit;
    o.canvas.style.cursor = hit ? 'pointer' : 'crosshair';
    if (hit?.type === 'building') {
      const b = state.buildings.get(hit.id);
      if (b && (!cards.pinned || cards.id === b.id)) cards.showBuilding(b, state.myBuildingId, screenPoint(mouse.x, mouse.y), false);
    } else if (cards.kind === 'building' && !cards.pinned) cards.hide();
  };

  const input = new CityInput(o.canvas, camera, {
    // inside a building, keyboard belongs to Visit scene
    active: () => visible && !visit,
    hover: (sx, sy, inside) => {
      mouse = inside ? { x: sx, y: sy } : null;
    },
    click: onClick,
    interact: () => {
      following = false;
      camera.stop();
    },
    zoomStep: (steps, sx = camera.viewW / 2, sy = camera.viewH / 2) => camera.zoomAt(camera.stepZoom(steps), sx, sy, Date.now(), true),
    use: () => {
      if (!me) return;
      const d = nearestDoor(me.x, me.y, (lot) => !!state.buildingAt(lot), ENTER_RADIUS);
      const b = d ? state.buildingAt(d.lot) : undefined;
      if (!b) {
        showToast(tr("Get close to a building's door and press E."));
        return;
      }
      enter(b.id);
    },
    recenter: () => recenter(),
    moved: () => {
      following = true;
    },
  });

  const recenter = () => {
    if (visit) return visit.world.overview();
    following = true;
    if (!me) return;
    const c = camera.centerFor(me.x * TILE, me.y * TILE - 12, camera.zoom);
    camera.animateTo(c.x, c.y, camera.zoom, Date.now(), 360);
  };

  // ------------------------------------------------------------------ loop

  const loop = (ts: number) => {
    raf = requestAnimationFrame(loop);
    const gap = lastTs ? ts - lastTs : 16.7;
    const dt = lastTs ? Math.min(0.1, Math.max(0, gap / 1000)) : 1 / 60;
    lastTs = ts;
    rafGaps.push(gap);
    if (rafGaps.length > 240) rafGaps.shift();
    const now = performance.now();
    try {
      const dpr = Math.max(1, Math.min(3, window.devicePixelRatio || 1));
      if (o.canvas.clientWidth !== camera.viewW || o.canvas.clientHeight !== camera.viewH || dpr !== camera.dpr) resize();
      const self = state.me;
      if (me && self && !resuming) {
        me.update(dt, input.intent());
        sender?.tick(now, me);
        // server does not notify when unsubscribing: on chunk change, buildings outside 3×3 leave
        const c = chunkOf(blockAt(me.x, me.y));
        const key = `${c.x},${c.y}`;
        if (key !== myChunk) {
          myChunk = key;
          state.keepAround(me.x, me.y);
        }
      }
      social?.frame(now, dt);
      const target = following && me ? camera.centerFor(me.x * TILE, me.y * TILE - 12, camera.zoom) : null;
      camera.update(Date.now(), target, dt);
      const door = me ? nearestDoor(me.x, me.y, (lot) => !!state.buildingAt(lot), ENTER_RADIUS) : null;
      renderer.frame(now, dt, o.options(), me && self ? { player: me, self } : null, {
        building: hovered?.type === 'building' ? hovered.id : cards.kind === 'building' ? cards.id : null,
        player: hovered?.type === 'player' ? hovered.id : cards.kind === 'player' ? cards.id : null,
        door: door ? door.front : null,
        me: me ? { x: me.x, y: me.y } : null,
      });
      frameMs.push(renderer.lastFrameMs);
      if (frameMs.length > 240) frameMs.shift();
      updateHover();
      // building card tracks changes (likes, state); disappears if building is gone
      if (cards.kind === 'building' && cards.id && !state.buildings.has(cards.id)) cards.hide();
      if (cards.kind === 'player' && cards.id && !state.players.has(cards.id)) cards.hide();
      if (me) {
        const tl = camera.screenToWorld(0, 0);
        const br = camera.screenToWorld(camera.viewW, camera.viewH);
        minimap.draw(state.minimap, state.minimapVersion, me, { x: tl.x / TILE, y: tl.y / TILE, w: (br.x - tl.x) / TILE, h: (br.y - tl.y) / TILE });
      }
    } catch (err) {
      console.error('[city] frame error', err);
    }
  };

  const onVisibility = () => {
    lastTs = 0;
    input.clearKeys();
    // back on tab: next tick resends position, even if something was stuck while hidden
    if (!document.hidden) sender?.reset();
  };

  // ------------------------------------------------------------------ API

  const scene: CityScene = {
    get visible() {
      return visible;
    },
    show() {
      if (visible) return;
      visible = true;
      o.canvas.hidden = false;
      layer.hidden = false;
      resize();
      if (resume) {
        // camera and zoom preserved from when scene closed (resume.ts)
        camera.stop();
        camera.zoom = resume.zoom;
        camera.x = resume.camX;
        camera.y = resume.camY;
        following = resume.following;
      } else if (!camera.animating) camera.zoom = camera.viewW < 600 ? 1.5 : 2;
      openStream();
      lastTs = 0;
      raf = requestAnimationFrame(loop);
      window.addEventListener('resize', resize);
      document.addEventListener('visibilitychange', onVisibility);
      keepAlive = setInterval(() => {
        // inside a building, no steps are sent (server ignores them inside, time does not count toward afk)
        if (document.hidden && me && sender && !visit) sender.keepAlive(me);
      }, KEEPALIVE_MS);
    },
    hide() {
      if (!visible) return;
      // city closed: visit closes too (stream closes and local server sends `view.off`)
      if (visit) endVisit();
      pendingOwn = false;
      // to resume identically: camera, zoom, and where I was
      resume = { camX: camera.x, camY: camera.y, zoom: camera.zoom, following, me: me ? { x: me.x, y: me.y } : null };
      visible = false;
      cancelAnimationFrame(raf);
      o.canvas.hidden = true;
      layer.hidden = true;
      cards.hide();
      social?.hide();
      input.clearKeys();
      closeStream();
      window.removeEventListener('resize', resize);
      document.removeEventListener('visibilitychange', onVisibility);
      if (keepAlive) clearInterval(keepAlive);
      keepAlive = null;
    },
    zoomBy(factor) {
      if (!Number.isFinite(factor) || factor <= 0 || factor === 1) return;
      if (visit) return visit.world.zoomBy(factor);
      camera.zoomAt(camera.stepZoom(factor > 1 ? 1 : -1), camera.viewW / 2, camera.viewH / 2, Date.now(), true);
    },
    recenter,
    lookAt(x, y, zoom = camera.zoom) {
      following = false;
      camera.stop();
      camera.zoom = Math.max(CITY_MIN_ZOOM, Math.min(6, zoom));
      const c = camera.centerFor(x * TILE, y * TILE, camera.zoom);
      camera.x = c.x;
      camera.y = c.y;
    },
    escape() {
      // inside a building, Esc belongs to visit (closes card or leaves)
      if (visit) return visit.escape();
      if (social?.escape()) return true;
      if (cards.open) {
        cards.hide();
        return true;
      }
      return false;
    },
    destroy() {
      scene.hide();
      input.destroy();
      social?.destroy();
      layer.remove();
    },
    perf() {
      const sorted = [...frameMs].sort((a, b) => a - b);
      const avg = frameMs.reduce((s, v) => s + v, 0) / Math.max(1, frameMs.length);
      const p95 = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))] ?? 0;
      const gapAvg = rafGaps.reduce((s, v) => s + v, 0) / Math.max(1, rafGaps.length);
      return { frames: frameMs.length, drawAvgMs: avg, drawP95Ms: p95, drawMaxMs: sorted[sorted.length - 1] ?? 0, fps: gapAvg ? 1000 / gapAvg : 0, buildings: renderer.buildingsDrawn.length, zoom: camera.zoom };
    },
    camera,
    get state() {
      return state;
    },
    perfReset() {
      frameMs.length = 0;
      rafGaps.length = 0;
    },
    me: () => (me ? { x: me.x, y: me.y, moving: me.moving, seated: !me.moving && renderer.onBench(me.x, me.y) } : null),
    toScreen: (x, y) => camera.worldToScreen(x * TILE, y * TILE),
    enter: (id) => enter(id),
    visitOwn() {
      const id = state.myBuildingId;
      if (me && stream && id && state.connected) enter(id);
      else pendingOwn = true;
    },
    visit: () => visit,
    walkTo: (x, y) => walkTo(x, y, false),
    doorOf(id) {
      const b = state.buildings.get(id);
      return b ? { ...lotDoor(b.lot).front } : null;
    },
  };
  return scene;
}
