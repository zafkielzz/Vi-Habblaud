// SCREEN SPACE pass (crisp text at device resolution): name labels with
// account, activity bubbles, room names, sign texts and selection highlight.
//
// Organization: everything that floats (signs, pills, bubbles, labels) competes for screen space.
// Items are POSITIONED in descending priority order (later arrivals dodge, collapse
// to icon only, or are dropped) and DRAWN in ascending order (most important on top).
import { TILE } from '../../art/api';
import type { WorldOptions } from '../api';
import type { Camera } from '../camera';
import { COL_W, CORRIDOR_Y, SOUTH_Y } from '../constants';
import type { Character } from '../sim/character';
import { shellAgeKey, shellBubbleAlpha, shellBubbleText, STORM_LIFT, unitHash } from '../sim/shell';
import type { Sim } from '../sim/sim';
import { buildAnim } from './anim';
import { drawFxBanner } from './github-fx';
import type { HeadInfo, Renderer } from './renderer';
import type { AgentGhost, JobBoard, Provider } from '../../../../shared/types';
import { jobBoardParts } from './job-board';
import { rulesBoardHead } from './rules-board';

/** Minimum job board height on screen (CSS px) to render text on it. */
const JOB_BOARD_MIN_PX = 40;
/** Minimum rules poster width on screen (CSS px) to write its header. */
const RULES_BOARD_MIN_PX = 44;
import { tr } from '../../../../shared/i18n';
import { CHAR_FADE } from './office-dim';
import { coreBase, isArea, RECEPTION_ID } from '../layout/core';
import { sessionLoad, type LoadThresholds } from '../../../../shared/overload';
import { modelSpec } from '../../../../shared/model-spec';
import { formatDuration } from '../../../../shared/activity';

// Pixelify Sans has an almost closed capital "C" (reads "Oopa" instead of "Copa") in any
// canvas weight/size; world text uses the system font, always readable.
const UI_FONT = 'ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", sans-serif';
const LABEL_FONT = `600 10.5px ${UI_FONT}`;
const BUBBLE_FONT = `500 11.5px ${UI_FONT}`;
const SAY_FONT = `500 10.5px ${UI_FONT}`;
const FLOAT_FONT = `800 12px ${UI_FONT}`;
const CHIP_FONT = `700 8px ${UI_FONT}`;
const BADGE_FONT = `700 8px ${UI_FONT}`;
/** Model and effort after the name ("Opus 5.5 · high"): smaller and dimmer than the name. */
const SPEC_FONT = `500 8.5px ${UI_FONT}`;
const ROOM_FONT = `700 12px ${UI_FONT}`;
const CORE_FONT = `600 11px ${UI_FONT}`;
const CORE_FONT_SMALL = `600 9.5px ${UI_FONT}`;
/** Building sign (one building per office): the office name, and a hint under it while the building is empty. */
const BUILDING_FONT = `700 13px ${UI_FONT}`;
const BUILDING_HINT_FONT = `500 10.5px ${UI_FONT}`;
const signFont = (size: number) => `700 ${size}px ${UI_FONT}`;

/** Maximum bubble width (alert bubble is wider: the reason is actionable info). */
export const BUBBLE_MAX_W = 220;
export const ALERT_MAX_W = 340;
const BUBBLE_H = 20;
const LABEL_H = 15;
const RECENT_MS = 4000;
/** Minimum sign height on screen (CSS px) to render name on it. */
const SIGN_MIN_PX = 14;
/** Below this zoom (overview), activity bubbles are rationed. */
export const OVERVIEW_ZOOM = 1.8;
/** Below this zoom (whole building on a small screen), only alerts/deliveries, as an icon. */
export const TINY_ZOOM = 0.6;
/** In overview: activity bubbles with text per area (room, core, corridor stretch) and in total. */
const OVERVIEW_PER_ROOM = 1;
const OVERVIEW_TOTAL = 4;

const CORE_NAMES: Record<string, string> = {
  'core:recepcao': tr('Reception'),
  'core:banheiros': tr('Restrooms'),
  'core:copa': tr('Kitchen'),
  'core:lounge': tr('Lounge'),
};

/** 'shell' = waiting for shell: dark terminal bubble with green text. 'say' = banter bubble (chat, cheering, bets). */
type Tone = 'info' | 'alert' | 'deliver' | 'shell' | 'say';
/** Maximum width for banter speech bubble (smaller than activity bubble). */
export const SAY_MAX_W = 170;
const SAY_H = 17;
/** Shell wait bubble icon. */
export const SHELL_BUBBLE_ICON = '⏳';

interface Bubble {
  type: 'bubble';
  ch: Character;
  head: HeadInfo;
  icon: string;
  text: string;
  tone: Tone;
  prio: number;
  alpha: number;
  /** Icon only (no text): overview, collisions and small screens. */
  chip: boolean;
  /** Extra lift (CSS px) when character label is above the head. */
  extraLift: number;
  /** Recency order (newer activity first when rationing). */
  changedAt: number;
  // geometry resolved during placement
  x: number;
  y: number;
  w: number;
  h: number;
  /** Text already truncated to fit width. */
  fitted: string;
  /** Shifted up a step to dodge: tail extends down to head. */
  lifted: boolean;
}

interface Label {
  type: 'label';
  ch: Character;
  head: HeadInfo;
  prio: number;
  /** Label above head (whoever sits facing camera behind a desk). */
  above: boolean;
  compact: boolean;
  x: number;
  y: number;
  w: number;
  h: number;
}

type Item = Bubble | Label;

/** Relative luminance of a hex color (0..1). */
/** Background of hollow chip for Codex accounts (same as panels). */
const CODEX_CHIP_BG = '#161b26';
/** "CODEX" badge for labels: subtle (clear glass), neutral color. */
/** Tool text badge on label (Claude Code does not have one: it is the default). */
const TOOL_BADGE: Partial<Record<Provider, string>> = { codex: 'CODEX', agy: 'AGY' };

/** Label badge: "BOSS" for workers' boss, otherwise tool badge. */
function badgeOf(info: { provider?: Provider; boss?: boolean }): string | undefined {
  return info.boss ? 'BOSS' : TOOL_BADGE[info.provider ?? 'claude'];
}

/** How long the crown takes to drop onto a newly appointed boss (Character.crownedAt). */
const CROWN_DROP_MS = 1_200;

/** Ease out with a bounce (0..1 -> 0..1): the crown lands and hops twice. */
function bounceOut(k: number): number {
  const n = 7.5625;
  const d = 2.75;
  if (k < 1 / d) return n * k * k;
  if (k < 2 / d) return n * (k -= 1.5 / d) * k + 0.75;
  if (k < 2.5 / d) return n * (k -= 2.25 / d) * k + 0.9375;
  return n * (k -= 2.625 / d) * k + 0.984375;
}

/** Stepped octagon (square with cut corners, like a rounded pixel). */
function steppedRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, s: number): void {
  ctx.beginPath();
  ctx.moveTo(x + s, y);
  ctx.lineTo(x + w - s, y);
  ctx.lineTo(x + w, y + s);
  ctx.lineTo(x + w, y + h - s);
  ctx.lineTo(x + w - s, y + h);
  ctx.lineTo(x + s, y + h);
  ctx.lineTo(x, y + h - s);
  ctx.lineTo(x, y + s);
  ctx.closePath();
}

/**
 * Account dot (room signs and pills): solid for Claude Code; hollow (ring in account color) for Codex,
 * like the panel chip.
 */
function accountDot(ctx: CanvasRenderingContext2D, x: number, y: number, r: number, acc: { color: string; provider?: string }): void {
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  if (acc.provider === 'codex') {
    ctx.fillStyle = CODEX_CHIP_BG;
    ctx.fill();
    ctx.lineWidth = Math.max(1.2, r * 0.55);
    ctx.strokeStyle = acc.color;
    ctx.beginPath();
    ctx.arc(x, y, r - ctx.lineWidth / 2, 0, Math.PI * 2);
    ctx.stroke();
    return;
  }
  ctx.fillStyle = acc.color;
  ctx.fill();
}

function luminance(hex: string): number {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex);
  if (!m) return 0.5;
  const n = parseInt(m[1], 16);
  return (0.2126 * ((n >> 16) & 255) + 0.7152 * ((n >> 8) & 255) + 0.0722 * (n & 255)) / 255;
}

/** Height (world px) occupied by overhead icons: bubbles and labels rise to avoid covering them. */
export function headIconLift(ch: Pick<Character, 'mode' | 'icon'> & Partial<Pick<Character, 'energy'>>): number {
  if (ch.icon === 'storm') return 13 + STORM_LIFT;
  return ch.mode === 'wait' || ch.mode === 'shell' || ch.icon || outOfQuota(ch) ? 13 : 0;
}

/** Fast asleep because its quota ran out (shared/energy.ts): only with nothing to do, a job or a question keeps it up. */
export function outOfQuota(ch: Pick<Character, 'mode'> & Partial<Pick<Character, 'energy'>>): boolean {
  return ch.mode === 'idle' && !!ch.energy?.asleep;
}

/** Hover text of a hung worker (AgentInfo.ghost). */
export function ghostText(g: AgentGhost, now: number): string {
  const silence = formatDuration(Math.max(60_000, Math.floor((now - g.since) / 60_000) * 60_000));
  return g.reason === 'no-job' ? tr('Alive with no job, silent for {0}', [silence]) : tr('No progress for {0}', [silence]);
}

/** Hover text of a character out of quota. */
export function quotaSleepText(resetsAt: number | undefined, now: number): string {
  return resetsAt && resetsAt > now ? tr('Out of quota, back in {0}', [formatDuration(resetsAt - now)]) : tr('Out of quota');
}

/** Waiting bubble text: reason only (yellow and ✋ already convey "needs you"). */
export function waitBubbleText(waitingFor: string | undefined): string {
  const why = (waitingFor ?? '').trim().replace(/^needs you:?\s*/i, '');
  return why ? why.charAt(0).toUpperCase() + why.slice(1) : tr('Answer in terminal');
}

/**
 * Activity bubble rationing in overview: keeps text for the `perRoom` most
 * recent in each room (up to `total` on screen); others become icon only. Returns indices
 * (in input list) that keep text. Pure (testable).
 */
export function rationBubbles(items: readonly { room: string; prio: number; changedAt: number }[], perRoom: number, total: number): Set<number> {
  const order = items.map((_, i) => i).sort((a, b) => items[b].prio - items[a].prio || items[b].changedAt - items[a].changedAt);
  const keep = new Set<number>();
  const byRoom = new Map<string, number>();
  for (const i of order) {
    if (keep.size >= total) break;
    const n = byRoom.get(items[i].room) ?? 0;
    if (n >= perRoom) continue;
    byRoom.set(items[i].room, n + 1);
    keep.add(i);
  }
  return keep;
}

export class Overlay {
  private widths = new Map<string, number>();
  private fitted = new Map<string, string>();
  private placed: number[] = [];
  private items: Item[] = [];
  /** Objects reused across frames (no allocation on hot path). */
  private bubblePool: Bubble[] = [];
  private labelPool: Label[] = [];
  private nb = 0;
  private nl = 0;
  private rationIn: { room: string; prio: number; changedAt: number }[] = [];
  private rationIdx: Bubble[] = [];
  /** World -> screen transform (CSS px) for current frame. */
  private k = 1;
  private ox = 0;
  private oy = 0;
  private zoom = 1;
  /** "Boss overloaded" thresholds (Settings). */
  private thresholds: LoadThresholds | undefined;

  constructor(
    private readonly ctx: CanvasRenderingContext2D,
    private readonly sim: Sim,
    private readonly renderer: Renderer,
    private readonly camera: Camera,
  ) {}

  /** Discards cached measurements (e.g. after a font has loaded). */
  resetCaches(): void {
    this.widths.clear();
    this.fitted.clear();
  }

  private measure(font: string, text: string): number {
    const key = `${font}|${text}`;
    let w = this.widths.get(key);
    if (w === undefined) {
      if (this.widths.size > 4000) this.widths.clear();
      this.ctx.font = font;
      w = this.ctx.measureText(text).width;
      this.widths.set(key, w);
    }
    return w;
  }

  /** Truncates text with ellipsis to fit in `maxW` px. */
  private fit(font: string, text: string, maxW: number): string {
    const key = `${font}|${maxW}|${text}`;
    const hit = this.fitted.get(key);
    if (hit !== undefined) return hit;
    if (this.fitted.size > 2000) this.fitted.clear();
    let out = text;
    if (this.measure(font, text) > maxW) {
      let lo = 0;
      let hi = text.length;
      while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (this.measure(font, `${text.slice(0, mid).trimEnd()}…`) <= maxW) lo = mid;
        else hi = mid - 1;
      }
      out = lo > 0 ? `${text.slice(0, lo).trimEnd()}…` : '';
    }
    this.fitted.set(key, out);
    return out;
  }

  /** Screen x/y (CSS px) of a world point, via frame transform. */
  private sx(wx: number): number {
    return wx * this.k + this.ox;
  }

  private sy(wy: number): number {
    return wy * this.k + this.oy;
  }

  private overlaps(x: number, y: number, w: number, h: number): boolean {
    const p = this.placed;
    for (let i = 0; i < p.length; i += 4) {
      if (x < p[i] + p[i + 2] && x + w > p[i] && y < p[i + 1] + p[i + 3] && y + h > p[i + 1]) return true;
    }
    return false;
  }

  private place(x: number, y: number, w: number, h: number): void {
    this.placed.push(x, y, w, h);
  }

  draw(now: number, opts: WorldOptions, sel: { agent: string | null; room: string | null; hover: string | null }): void {
    const { ctx, camera } = this;
    const dpr = camera.dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.textBaseline = 'middle';
    this.thresholds = opts.overload;
    this.placed.length = 0;
    const t = camera.transform();
    this.k = t.scale / dpr;
    this.ox = t.ox / dpr;
    this.oy = t.oy / dpr;
    this.nb = 0;
    this.nl = 0;
    const zoom = (this.zoom = camera.zoom);
    const vw = camera.viewW;
    const vh = camera.viewH;

    // ---- room selection
    if (sel.room) {
      const room = this.sim.rooms.get(sel.room);
      if (room && room.present) {
        const r = room.layout.rect;
        const ax = this.sx(r.x * TILE);
        const ay = this.sy(r.y * TILE);
        const bx = this.sx((r.x + r.w) * TILE);
        const by = this.sy((r.y + r.h) * TILE);
        ctx.save();
        ctx.strokeStyle = room.theme.accent;
        ctx.lineWidth = 2.5;
        ctx.globalAlpha = 0.85 + Math.sin(now / 300) * 0.15;
        ctx.beginPath();
        ctx.roundRect(ax - 2, ay - 2, bx - ax + 4, by - ay + 4, 6);
        ctx.stroke();
        ctx.restore();
      }
    }

    // signs and pills first: they are fixed and large; bubbles and labels dodge them
    this.drawRoomTexts(now, zoom);
    this.drawBuildingSigns();
    this.drawFxBanners(now, zoom);

    // ---- collect bubbles and labels for visible characters
    const items = this.items;
    items.length = 0;
    const heads = this.renderer.heads;
    const showAll = opts.showNames && zoom >= 0.99;
    for (const ch of this.sim.people()) {
      const head = heads.get(ch.id);
      if (!head || !head.visible) continue;
      const hx = this.sx(head.x);
      const hy = this.sy(head.y);
      if (hx < -120 || hx > vw + 120 || hy < -60 || hy > vh + 80) continue;
      const selected = sel.agent === ch.id;
      const hovered = sel.hover === ch.id;
      // visitor (Visitor scene) always with name and badge
      const visitor = ch === this.sim.visitor;
      const labeled = selected || hovered || ch.mode === 'wait' || showAll || visitor;
      const above = labeled && this.labelAbove(ch);
      const b = this.bubbleFor(ch, head, now, opts, selected, hovered);
      if (b) {
        b.extraLift = above ? LABEL_H + 3 : 0;
        items.push(b);
      }
      if (labeled) {
        const prio = selected ? 100 : hovered ? 95 : visitor ? 92 : ch.mode === 'wait' ? 90 : ch.info.kind === 'main' ? 50 : 40;
        let l = this.labelPool[this.nl];
        if (!l) this.labelPool[this.nl] = l = { type: 'label', ch, head, prio, above, compact: false, x: 0, y: 0, w: 0, h: 0 };
        else {
          l.ch = ch;
          l.head = head;
          l.prio = prio;
          l.above = above;
        }
        l.compact = zoom < 2.5 && !selected && !hovered;
        this.nl++;
        items.push(l);
      }
    }

    this.ration(zoom);

    // ---- position (descending priority) and draw (ascending: most important on top)
    items.sort((a, b) => b.prio - a.prio || (a.type === b.type ? a.head.feetY - b.head.feetY : a.type === 'bubble' ? -1 : 1));
    let n = 0;
    for (const it of items) {
      const ok = it.type === 'bubble' ? this.placeBubble(it) : this.placeLabel(it);
      if (ok) items[n++] = it;
    }
    items.length = n;
    for (let i = items.length - 1; i >= 0; i--) {
      const it = items[i];
      // characters outside the office shown: their name and bubble fade with them
      const fade = it.ch === this.sim.visitor ? 1 : 1 - CHAR_FADE * this.renderer.dim.charLevel(it.ch.id);
      if (it.type === 'bubble') {
        const alpha = it.alpha;
        it.alpha *= fade;
        this.drawBubble(it, now);
        it.alpha = alpha;
      } else {
        ctx.globalAlpha = fade;
        this.drawLabel(it, sel);
        ctx.globalAlpha = 1;
      }
    }
    this.drawChats(now);
    this.drawFloaters(now);
    this.drawQuotaSleep();
    ctx.textBaseline = 'alphabetic';
  }

  /** Whoever sits facing camera behind a desk: feet label would cover colleague's screen. */
  private labelAbove(ch: Character): boolean {
    if (!ch.seated || ch.dir !== 'down' || !ch.atSpot) return false;
    const spot = this.sim.spots.get(ch.atSpot);
    return !!spot && spot.kind === 'desk';
  }

  /** Rationing by zoom: overview with few texts; tiny screens with critical icons only. */
  private ration(zoom: number): void {
    const items = this.items;
    if (zoom < TINY_ZOOM) {
      let n = 0;
      for (const it of items) {
        if (it.type === 'bubble') {
          // common activity and banter disappear; alert, delivery, shell wait and selected become icon only
          if ((it.tone === 'info' && it.prio < 75) || it.tone === 'say') continue;
          it.chip = true;
        }
        items[n++] = it;
      }
      items.length = n;
      return;
    }
    if (zoom >= OVERVIEW_ZOOM) return;
    const rin = this.rationIn;
    const idx = this.rationIdx;
    rin.length = 0;
    idx.length = 0;
    for (const it of items) {
      if (it.type !== 'bubble' || (it.tone !== 'info' && it.tone !== 'shell' && it.tone !== 'say') || it.prio >= 75) continue;
      // by PHYSICAL area (where the character currently is), which is what clutters the screen
      const ch = it.ch;
      rin.push({ room: `${Math.floor(ch.tx / COL_W)}:${ch.ty < CORRIDOR_Y ? 'n' : ch.ty < SOUTH_Y ? 'c' : 's'}`, prio: it.prio, changedAt: it.changedAt });
      idx.push(it);
    }
    if (!idx.length) return;
    const keep = rationBubbles(rin, OVERVIEW_PER_ROOM, OVERVIEW_TOTAL);
    for (let i = 0; i < idx.length; i++) if (!keep.has(i)) idx[i].chip = true;
  }

  // =================================================================== rooms

  private drawRoomTexts(now: number, zoom: number): void {
    const { camera } = this;
    const vw = camera.viewW;
    const vh = camera.viewH;
    // column width on screen: pills must not overlap neighboring column
    const colW = COL_W * TILE * zoom;
    for (const vis of this.renderer.areas.values()) {
      const room = vis.room;
      const r = vis.layout.rect;
      const anim = room ? buildAnim(room.phase, room.progress(now)) : null;
      // sign text when large enough to read; otherwise, floating name
      const rect = this.renderer.signRect(vis);
      const text = room ? room.info.name : isArea(vis.id, RECEPTION_ID) ? this.receptionText(vis.layout.rect.x) : null;
      const readable = !!rect && rect.h * zoom >= SIGN_MIN_PX;
      if (readable && rect && text && (!anim || anim.sign >= 1)) {
        const ax = this.sx(rect.x);
        const ay = this.sy(rect.y);
        const w = rect.w * zoom;
        const h = rect.h * zoom;
        if (ax + w > 0 && ax < vw && ay + h > 0 && ay < vh) {
          this.drawSignText(text, ax, ay, w, h, this.renderer.signIsDark(vis), room?.accounts ?? []);
          this.place(ax, ay, w, h);
        }
      }
      // Antigravity workers' job board: text when readable
      const jb = room?.info.board ? this.renderer.jobBoardRect(vis) : null;
      if (jb && room?.info.board && (!anim || anim.sign >= 1)) this.drawJobBoardText(jb, room.info.board, zoom);
      // the office rules poster in a reception
      const rb = room ? null : this.renderer.rulesBoard(vis.id);
      if (rb) this.drawRulesBoardText(rb.rect, rb.board.rules, zoom);
      if (room ? readable : zoom >= 1.4) continue;
      const cx = this.sx((r.x + r.w / 2) * TILE);
      const cy = this.sy(r.y * TILE + 6);
      if (cx < -200 || cx > vw + 200 || cy < -40 || cy > vh + 40) continue;
      if (room) {
        // old address from a room move: name is already on the new room
        if (!room.present || room.ghost || (anim && anim.walls < 0.6)) continue;
        this.drawRoomPill(room.info.name, cx, cy, colW - 8, room.accounts, this.countIn(room.id), room.theme.accent, room.lightOn);
      } else if (CORE_NAMES[coreBase(vis.id)]) {
        this.drawCorePill(CORE_NAMES[coreBase(vis.id)], cx, cy, colW - 8);
      }
    }
  }

  /** Job board text (header with latest order and one row per job), only when zoomed enough to read. */
  private drawJobBoardText(jb: { x: number; y: number; w: number; h: number }, board: JobBoard, zoom: number): void {
    if (jb.h * zoom < JOB_BOARD_MIN_PX) return;
    const { ctx } = this;
    const x = this.sx(jb.x);
    const y = this.sy(jb.y);
    if (x > this.camera.viewW || y > this.camera.viewH || x + jb.w * zoom < 0 || y + jb.h * zoom < 0) return;
    const parts = jobBoardParts(jb);
    ctx.save();
    const fit = (font: string, text: string, max: number) => {
      if (this.measure(font, text) <= max) return text;
      let t = text;
      while (t.length > 1 && this.measure(font, `${t}…`) > max) t = t.slice(0, -1);
      return `${t}…`;
    };
    ctx.textBaseline = 'middle';
    const hf = `600 ${Math.max(6, Math.round(parts.head.h * zoom * 0.62))}px ${UI_FONT}`;
    ctx.font = hf;
    ctx.fillStyle = '#ffffff';
    const head = board.order ? tr('📋 Order: {0}', [board.order.text.replace(/\s+/g, ' ')]) : tr('📋 Job board');
    ctx.fillText(fit(hf, head, parts.head.w * zoom - 6), this.sx(parts.head.x) + 3, this.sy(parts.head.y + parts.head.h / 2));
    const rf = `${Math.max(6, Math.round(parts.rows[0].h * zoom * 0.6))}px ${UI_FONT}`;
    ctx.font = rf;
    ctx.fillStyle = '#2a2f3d';
    board.items.slice(0, parts.rows.length).forEach((it, i) => {
      const row = parts.rows[i];
      const text = [it.worker, it.role, it.text].filter(Boolean).join(' · ');
      const tx = this.sx(row.x + 5);
      ctx.fillText(fit(rf, text, row.w * zoom - 6 * zoom), tx, this.sy(row.y + row.h / 2));
    });
    ctx.restore();
    this.place(x, y, jb.w * zoom, jb.h * zoom);
  }

  /** The rules poster's header ("📜 Rules · 3"), only when zoomed enough to read. */
  private drawRulesBoardText(r: { x: number; y: number; w: number; h: number }, rules: number, zoom: number): void {
    const head = rulesBoardHead(r);
    if (head.h * zoom < 8 || r.w * zoom < RULES_BOARD_MIN_PX) return;
    const x = this.sx(head.x);
    const y = this.sy(head.y);
    if (x > this.camera.viewW || y > this.camera.viewH || x + head.w * zoom < 0 || y + head.h * zoom < 0) return;
    const { ctx } = this;
    ctx.save();
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'center';
    let size = Math.max(6, Math.round(head.h * zoom * 0.7));
    const text = tr('📜 Rules · {0}', [rules]);
    let font = `600 ${size}px ${UI_FONT}`;
    while (size > 6 && this.measure(font, text) > head.w * zoom - 4) font = `600 ${--size}px ${UI_FONT}`;
    ctx.font = font;
    ctx.fillStyle = '#fff6df';
    ctx.fillText(text, x + (head.w * zoom) / 2, y + (head.h * zoom) / 2);
    ctx.restore();
  }

  /** Overhead icon height, including the "!" bubble over whoever saw CI fail (render/github-fx.ts). */
  private iconLift(ch: Character): number {
    const lift = headIconLift(ch);
    return this.sim.roomFx.active.size && this.sim.roomFx.alarmOwner(ch.id, this.sim.now) ? Math.max(lift, 13) : lift;
  }

  /** Party/alarm banner (GitHub events) at top of floor for each active room. */
  private drawFxBanners(now: number, zoom: number): void {
    const fxs = this.sim.roomFx.active;
    if (!fxs.size) return;
    const { camera } = this;
    for (const fx of fxs.values()) {
      const room = this.sim.rooms.get(fx.roomId);
      if (!room || !room.present || now >= fx.end) continue;
      const r = room.layout.rect;
      const cx = this.sx((r.x + r.w / 2) * TILE);
      const top = this.sy((r.y + 2) * TILE) + 4;
      if (cx < -200 || cx > camera.viewW + 200 || top < -40 || top > camera.viewH + 40) continue;
      const b = drawFxBanner(this.ctx, fx, cx, top, r.w * TILE * zoom - 12, now, (f, t, w) => this.fit(f, t, w), (f, t) => this.measure(f, t));
      if (b) this.place(b.x, b.y, b.w, b.h);
    }
  }

  private countIn(roomId: string): number {
    let n = 0;
    for (const c of this.sim.chars.values()) if (c.roomId === roomId && !c.leaving) n++;
    return n;
  }

  private drawSignText(text: string, x: number, y: number, w: number, h: number, dark: boolean, accounts: string[]): void {
    const { ctx } = this;
    // shrink font down to 7px; below that, truncate with ellipsis
    let size = Math.min(18, Math.max(7, Math.floor(h * 0.72)));
    let font = signFont(size);
    while (size > 7 && this.measure(font, text) > w - 4) {
      size--;
      font = signFont(size);
    }
    const t = this.fit(font, text, w - 4);
    ctx.font = font;
    ctx.textAlign = 'center';
    const cx = Math.round(x + w / 2);
    const cy = Math.round(y + h / 2) + 0.5;
    ctx.fillStyle = dark ? 'rgba(0,0,0,0.35)' : 'rgba(255,255,255,0.45)';
    ctx.fillText(t, cx, cy + 1);
    ctx.fillStyle = dark ? '#f5f1e6' : '#26303e';
    ctx.fillText(t, cx, cy);
    ctx.textAlign = 'left';
    // present accounts: dots in account color, at the corner of the sign
    const r = Math.max(2.5, Math.min(4, h * 0.22));
    let dx = x + w + r + 3;
    for (const id of accounts) {
      const acc = this.sim.accounts.get(id);
      if (!acc) continue;
      accountDot(ctx, dx, y + h / 2, r, acc);
      ctx.beginPath();
      ctx.arc(dx, y + h / 2, r, 0, Math.PI * 2);
      ctx.lineWidth = 1;
      ctx.strokeStyle = 'rgba(20,24,36,0.65)';
      ctx.stroke();
      dx += r * 2 + 2;
    }
  }

  private drawRoomPill(name: string, cx: number, cy: number, maxW: number, accounts: string[], count: number, accent: string, lit: boolean): void {
    const { ctx } = this;
    let dots = accounts.filter((a) => this.sim.accounts.has(a));
    let countText = count > 0 ? String(count) : '';
    let cw = countText ? this.measure(LABEL_FONT, countText) + 14 : 0;
    // name truncated to fit column width; with little room, name takes priority over
    // count and dots; without room for even 3 letters, compact pill (count only)
    let text = this.fit(ROOM_FONT, name, Math.min(180, maxW - (18 + dots.length * 10 + cw)));
    if (text.length < Math.min(7, name.length)) {
      const alone = this.fit(ROOM_FONT, name, maxW - 18);
      if (alone.length >= 4) {
        text = alone;
        dots = [];
        countText = '';
        cw = 0;
      }
    }
    const extras = 18 + dots.length * 10 + cw;
    // Only becomes compact pill when the name had to be truncated (short names like "app" fit completely).
    const compact = text !== name && text.length < 4;
    const tw = compact ? 0 : this.measure(ROOM_FONT, text);
    const w = Math.round(compact ? Math.max(12, 10 + cw + dots.length * 10) : tw + extras);
    const h = 22;
    const x = Math.round(cx - w / 2);
    const y = Math.round(cy - h - 4);
    ctx.save();
    ctx.globalAlpha = lit ? 1 : 0.8;
    ctx.fillStyle = 'rgba(16,20,32,0.28)';
    ctx.beginPath();
    ctx.roundRect(x, y + 2, w, h, 7);
    ctx.fill();
    ctx.fillStyle = 'rgba(22,27,40,0.9)';
    ctx.beginPath();
    ctx.roundRect(x, y, w, h, 7);
    ctx.fill();
    ctx.fillStyle = accent;
    ctx.beginPath();
    ctx.roundRect(x, y, 4, h, [7, 0, 0, 7]);
    ctx.fill();
    let dx = x + 10;
    if (!compact) {
      ctx.font = ROOM_FONT;
      ctx.fillStyle = '#f3f5fa';
      ctx.fillText(text, x + 10, y + h / 2 + 1);
      dx = x + 10 + tw + 8;
    }
    for (const id of dots) {
      accountDot(ctx, dx + 3, y + h / 2, 3.5, this.sim.accounts.get(id)!);
      dx += 10;
    }
    if (countText) {
      ctx.fillStyle = 'rgba(255,255,255,0.14)';
      ctx.beginPath();
      ctx.roundRect(dx + 2, y + 4, cw - 4, h - 8, 5);
      ctx.fill();
      ctx.font = LABEL_FONT;
      ctx.fillStyle = '#dfe5f2';
      ctx.fillText(countText, dx + 7, y + h / 2 + 0.5);
    }
    ctx.restore();
    this.place(x, y, w, h);
  }

  /** The reception sign: "Habblaud" with one building; the office's name with one building per office. */
  private receptionText(tx: number): string {
    const b = this.sim.building.buildings;
    if (b.length < 2) return 'Habblaud';
    const id = this.renderer.officeAt(tx);
    return this.sim.officeNames.get(id) ?? id;
  }

  /**
   * One building per office: a sign over each building (the office's name; "＋ Boss / ＋ Worker" under it while
   * nobody works there). Nothing with a single building. A building outside the office shown is faded like it.
   */
  private drawBuildingSigns(): void {
    const buildings = this.sim.building.buildings;
    if (buildings.length < 2) return;
    const { ctx } = this;
    const busy = new Set<string>();
    for (const ch of this.sim.people()) if (!ch.gone && !ch.leaving) busy.add(ch.office);
    const focus = this.renderer.dim.focus?.office;
    for (const b of buildings) {
      const name = this.sim.officeNames.get(b.id) ?? b.id;
      if (!name) continue;
      const cx = this.sx((b.rect.x + b.rect.w / 2) * TILE);
      // above the room and core name pills along the north wall
      const cy = this.sy(0) - 26;
      const maxW = Math.max(80, b.rect.w * TILE * this.camera.zoom - 16);
      if (cx < -maxW || cx > this.camera.viewW + maxW || cy < -60 || cy > this.camera.viewH + 60) continue;
      const hint = busy.has(b.id) ? '' : tr('Empty: ＋ Boss / ＋ Worker');
      const title = this.fit(BUILDING_FONT, name, Math.min(maxW, 320) - 20);
      const sub = hint ? this.fit(BUILDING_HINT_FONT, hint, Math.min(maxW, 320) - 20) : '';
      const w = Math.round(Math.max(this.measure(BUILDING_FONT, title), sub ? this.measure(BUILDING_HINT_FONT, sub) : 0) + 20);
      const h = sub ? 36 : 22;
      const x = Math.round(cx - w / 2);
      const y = Math.round(cy - h);
      ctx.save();
      ctx.globalAlpha = focus !== undefined && focus !== b.id ? 0.55 : 1;
      ctx.fillStyle = 'rgba(22,27,40,0.72)';
      ctx.beginPath();
      ctx.roundRect(x, y, w, h, 7);
      ctx.fill();
      ctx.textAlign = 'center';
      ctx.font = BUILDING_FONT;
      ctx.fillStyle = '#f1f4fa';
      ctx.fillText(title, cx, y + 12);
      if (sub) {
        ctx.font = BUILDING_HINT_FONT;
        ctx.fillStyle = '#a9b3c7';
        ctx.fillText(sub, cx, y + 27);
      }
      ctx.restore();
      this.place(x, y, w, h);
    }
  }

  private drawCorePill(name: string, cx: number, cy: number, maxW: number): void {
    const { ctx } = this;
    // slightly smaller font before truncating name
    const font = this.measure(CORE_FONT, name) <= maxW - 14 ? CORE_FONT : CORE_FONT_SMALL;
    const text = this.fit(font, name, maxW - 14);
    if (text.length < 3) return;
    const tw = this.measure(font, text);
    const w = Math.round(tw + 14);
    const h = 18;
    const x = Math.round(cx - w / 2);
    const y = Math.round(cy - h - 4);
    ctx.fillStyle = 'rgba(22,27,40,0.62)';
    ctx.beginPath();
    ctx.roundRect(x, y, w, h, 6);
    ctx.fill();
    ctx.font = font;
    ctx.fillStyle = '#e8ecf5';
    ctx.fillText(text, x + 7, y + h / 2 + 1);
    this.place(x, y, w, h);
  }

  // =================================================================== bubbles

  private takeBubble(ch: Character, head: HeadInfo, icon: string, text: string, tone: Tone, prio: number, alpha: number, changedAt: number): Bubble {
    let b = this.bubblePool[this.nb];
    if (!b) {
      b = { type: 'bubble', ch, head, icon, text, tone, prio, alpha, chip: false, extraLift: 0, changedAt, x: 0, y: 0, w: 0, h: 0, fitted: '', lifted: false };
      this.bubblePool[this.nb] = b;
    } else {
      b.ch = ch;
      b.head = head;
      b.icon = icon;
      b.text = text;
      b.tone = tone;
      b.prio = prio;
      b.alpha = alpha;
      b.chip = false;
      b.extraLift = 0;
      b.changedAt = changedAt;
      b.lifted = false;
    }
    this.nb++;
    return b;
  }

  private bubbleFor(ch: Character, head: HeadInfo, now: number, opts: WorldOptions, selected: boolean, hovered: boolean): Bubble | null {
    if (opts.bubbles === 'none') return null;
    if (ch.mode === 'wait') return this.takeBubble(ch, head, '✋', this.sim.visit ? tr('Waiting for the owner') : waitBubbleText(ch.info.waitingFor), 'alert', 100, 1, now);
    if (ch.bubbleText && now < ch.bubbleUntil) {
      const a = Math.min(1, (now - ch.bubbleAt) / 150, (ch.bubbleUntil - now) / 400);
      return this.takeBubble(ch, head, ch.bubbleIcon, ch.bubbleText, 'deliver', 90, a, ch.bubbleAt);
    }
    // banter speech (invite, chat, cheering, bet): short and on top of recent activity
    if (ch.sayText && now < ch.sayUntil && !ch.leaving) {
      const a = Math.min(1, (now - ch.sayAt) / 120, (ch.sayUntil - now) / 300);
      return this.takeBubble(ch, head, sayIcon(ch.sayText), ch.sayText, 'say', 55, a, ch.sayAt);
    }
    if (ch.info.ghost && selected) return this.takeBubble(ch, head, '👻', ghostText(ch.info.ghost, now), 'info', 80, 1, ch.activityChangedAt);
    if (outOfQuota(ch) && selected) return this.takeBubble(ch, head, '💤', quotaSleepText(ch.energy?.resetsAt, now), 'info', 80, 1, ch.activityChangedAt);
    const act = ch.info.activity;
    if (ch.mode === 'shell' && ch.shellSince > 0 && !ch.leaving) {
      const sb = this.shellBubble(ch, head, now, opts, selected, hovered);
      if (sb) return sb;
    }
    if (!act || ch.leaving) return null;
    const age = now - ch.activityChangedAt;
    if (selected) return this.takeBubble(ch, head, act.icon, act.text, 'info', 80, 1, ch.activityChangedAt);
    if (hovered) return this.takeBubble(ch, head, act.icon, act.text, 'info', 75, 1, ch.activityChangedAt);
    if (opts.bubbles === 'all' && ch.mode === 'work') return this.takeBubble(ch, head, act.icon, act.text, 'info', age < RECENT_MS ? 50 : 30, 1, ch.activityChangedAt);
    if (age < RECENT_MS && ch.activityChangedAt > 0) {
      const a = Math.min(1, age / 150, (RECENT_MS - age) / 500);
      return this.takeBubble(ch, head, act.icon, act.text, 'info', 50, a, ch.activityChangedAt);
    }
    return null;
  }

  /**
   * Bubble "⏳ <label> · <time>" for agents waiting for shell. Mode 'all': always; 'important': when entering
   * the state and then for 4 s every ~30 s; selected/hover: always. Fresh activity (e.g. one
   * of the shells finishing) takes precedence while recent.
   */
  private shellBubble(ch: Character, head: HeadInfo, now: number, opts: WorldOptions, selected: boolean, hovered: boolean): Bubble | null {
    const recent = now - ch.activityChangedAt < RECENT_MS && ch.activityChangedAt > ch.shellEnteredAt + 500;
    if (recent && !selected && !hovered) return null;
    const text = this.shellText(ch, now);
    if (selected) return this.takeBubble(ch, head, SHELL_BUBBLE_ICON, text, 'shell', 80, 1, ch.shellEnteredAt);
    if (hovered) return this.takeBubble(ch, head, SHELL_BUBBLE_ICON, text, 'shell', 75, 1, ch.shellEnteredAt);
    if (opts.bubbles === 'all') return this.takeBubble(ch, head, SHELL_BUBBLE_ICON, text, 'shell', 45, 1, ch.shellEnteredAt);
    // each character at their own pace (room bubbles do not blink in sync)
    const a = shellBubbleAlpha(now - ch.shellEnteredAt, unitHash(ch.info.seed, 0, 3) * 9000);
    return a > 0.01 ? this.takeBubble(ch, head, SHELL_BUBBLE_ICON, text, 'shell', 50, a, ch.shellEnteredAt) : null;
  }

  /** Shell bubble text, rebuilt only when displayed time changes (not every frame). */
  private shellText(ch: Character, now: number): string {
    // visit: label only, no timer (no time data from world)
    if (this.sim.visit) return ch.shellLabel;
    const age = now - ch.shellSince;
    const key = shellAgeKey(age);
    if (key !== ch.shellTextKey || !ch.shellText) {
      ch.shellTextKey = key;
      ch.shellText = shellBubbleText(ch.shellLabel, age);
    }
    return ch.shellText;
  }

  /** Calculates bubble rectangle (full or icon only) at base position above head. */
  private layoutBubble(b: Bubble): void {
    const { camera } = this;
    // above head icon (when present), which is drawn in world space
    const lift = Math.max(1, this.iconLift(b.ch)) * this.zoom + b.extraLift;
    const headX = this.sx(b.head.x);
    const headY = this.sy(b.head.y);
    const say = b.tone === 'say';
    const iconW = b.icon && !say ? this.measure(BUBBLE_FONT, b.icon) + 4 : 0;
    if (b.chip || !b.text) {
      b.fitted = '';
      b.w = Math.round(Math.max(20, (say ? this.measure(BUBBLE_FONT, b.icon) + 4 : iconW) + 10));
    } else if (say) {
      b.fitted = this.fit(SAY_FONT, b.text, SAY_MAX_W - 14);
      b.w = Math.round(Math.min(SAY_MAX_W, this.measure(SAY_FONT, b.fitted) + 14));
    } else {
      const maxW = b.tone === 'alert' ? ALERT_MAX_W : BUBBLE_MAX_W;
      b.fitted = this.fit(BUBBLE_FONT, b.text, maxW - 16 - iconW);
      b.w = Math.round(Math.min(maxW, this.measure(BUBBLE_FONT, b.fitted) + iconW + 14));
    }
    b.h = say && !b.chip ? SAY_H : BUBBLE_H;
    b.x = Math.max(4, Math.min(camera.viewW - b.w - 4, Math.round(headX - b.w / 2)));
    b.y = Math.round(headY - lift - b.h - 6);
  }

  /** Positions bubble without overlapping existing screen items. Returns false if it should hide. */
  private placeBubble(b: Bubble): boolean {
    this.layoutBubble(b);
    if (!this.overlaps(b.x, b.y, b.w, b.h)) {
      this.place(b.x, b.y, b.w, b.h);
      return true;
    }
    if (b.tone === 'alert') {
      // alert never disappears: steps up one level (long tail down to head) or stays on top
      const up = b.y - b.h - 6;
      if (!this.overlaps(b.x, up, b.w, b.h)) {
        b.y = up;
        b.lifted = true;
      }
      this.place(b.x, b.y, b.w, b.h);
      return true;
    }
    if (!b.chip) {
      // does not fit with text: try icon only, in the same spot
      b.chip = true;
      this.layoutBubble(b);
      if (!this.overlaps(b.x, b.y, b.w, b.h)) {
        this.place(b.x, b.y, b.w, b.h);
        return true;
      }
    }
    return false;
  }

  private drawBubble(b: Bubble, now: number): void {
    const { ctx } = this;
    const { x, y, w, h } = b;
    const headX = this.sx(b.head.x);
    const tone = b.tone;
    const bg = tone === 'alert' ? '#ffcf4a' : tone === 'deliver' ? '#e2f0ff' : tone === 'shell' ? '#1d2433' : tone === 'say' ? '#ffffff' : '#fffdf8';
    const border = tone === 'alert' ? '#c58f10' : tone === 'deliver' ? '#7aa7d9' : tone === 'shell' ? '#4b5d7e' : tone === 'say' ? 'rgba(40,48,66,0.38)' : 'rgba(40,48,66,0.22)';
    const fg = tone === 'alert' ? '#3b2a00' : tone === 'deliver' ? '#17324f' : tone === 'shell' ? '#b9f6b4' : tone === 'say' ? '#1d2330' : '#232a36';
    const pulse = tone === 'alert' ? 1 + Math.sin(now / 160) * 0.035 : 1;
    ctx.save();
    ctx.globalAlpha = b.alpha;
    if (b.lifted) {
      // connector down to normal tail position (bubble moved up to dodge another)
      const tx = Math.max(x + 8, Math.min(x + w - 8, Math.round(headX)));
      ctx.strokeStyle = border;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(tx + 0.5, y + h);
      ctx.lineTo(tx + 0.5, y + 2 * h + 11);
      ctx.stroke();
    }
    if (pulse !== 1) {
      ctx.translate(headX, y + h);
      ctx.scale(pulse, pulse);
      ctx.translate(-headX, -(y + h));
    }
    const tailX = Math.max(x + 8, Math.min(x + w - 8, Math.round(headX)));
    // shadow
    ctx.fillStyle = 'rgba(16,20,32,0.22)';
    ctx.beginPath();
    ctx.roundRect(x, y + 2, w, h, 7);
    ctx.fill();
    // body + tail
    ctx.fillStyle = bg;
    ctx.strokeStyle = border;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.roundRect(x + 0.5, y + 0.5, w - 1, h - 1, 7);
    ctx.fill();
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(tailX - 4.5, y + h - 1);
    ctx.lineTo(tailX, y + h + 5);
    ctx.lineTo(tailX + 4.5, y + h - 1);
    ctx.closePath();
    ctx.fill();
    ctx.beginPath();
    ctx.moveTo(tailX - 4.5, y + h - 0.5);
    ctx.lineTo(tailX, y + h + 5);
    ctx.lineTo(tailX + 4.5, y + h - 0.5);
    ctx.stroke();
    ctx.fillStyle = bg;
    ctx.fillRect(tailX - 4, y + h - 2, 8, 2);
    // content
    ctx.font = tone === 'say' && !b.chip ? SAY_FONT : BUBBLE_FONT;
    ctx.fillStyle = fg;
    if (tone === 'say' && !b.chip && b.fitted) {
      ctx.textAlign = 'center';
      ctx.fillText(b.fitted, x + w / 2, y + h / 2 + 1);
      ctx.textAlign = 'left';
    } else if (b.chip || !b.fitted) {
      ctx.textAlign = 'center';
      ctx.fillText(b.icon || '…', x + w / 2, y + h / 2 + 1);
      ctx.textAlign = 'left';
    } else {
      let tx = x + 7;
      if (b.icon) {
        ctx.fillText(b.icon, tx, y + h / 2 + 1);
        tx += this.measure(BUBBLE_FONT, b.icon) + 4;
      }
      ctx.fillText(b.fitted, tx, y + h / 2 + 1);
    }
    ctx.restore();
  }

  /**
   * 💤 over whoever ran out of quota: steady, centered on the head, drifting slowly. The session-overload one sits beside
   * the head and takes turns with 😵 (drawLabel), and the long-idle nap has the pixel "zzz" icon.
   */
  private drawQuotaSleep(): void {
    if (this.zoom < TINY_ZOOM) return;
    const { ctx } = this;
    const scale = Math.max(1, this.zoom / 2);
    for (const ch of this.sim.chars.values()) {
      if (!outOfQuota(ch) || ch.pose !== 'sleep' || ch.leaving) continue;
      const head = this.renderer.heads.get(ch.id);
      if (!head || !head.visible) continue;
      ctx.globalAlpha = 1 - CHAR_FADE * this.renderer.dim.charLevel(ch.id);
      ctx.font = `${Math.round(10 * scale)}px sans-serif`;
      ctx.textAlign = 'center';
      // (above the crown)
      ctx.fillText('💤', this.sx(head.x), this.sy(head.y) - ((ch.info.boss ? 15 : 7) + Math.sin(this.sim.now / 900)) * scale);
    }
    ctx.globalAlpha = 1;
    ctx.textAlign = 'left';
  }

  /** Mini-bubbles for conversations (emoji only). */
  private drawChats(now: number): void {
    const { ctx } = this;
    for (const ch of this.sim.chars.values()) {
      if (!ch.chatEmoji || now > ch.chatUntil) continue;
      const head = this.renderer.heads.get(ch.id);
      if (!head || !head.visible) continue;
      const px = this.sx(head.x);
      const py = this.sy(head.y);
      const k = Math.min(1, (ch.chatUntil - now) / 300, 1 - (ch.chatUntil - now - 1000) / 200);
      const r = 12;
      const side = ch.dir === 'left' ? -1 : 1;
      const x = Math.round(px + side * 12);
      const y = Math.round(py - 16 - (1 - Math.min(1, k)) * 4);
      ctx.save();
      ctx.globalAlpha = Math.max(0, Math.min(1, k));
      ctx.fillStyle = 'rgba(16,20,32,0.2)';
      ctx.beginPath();
      ctx.arc(x, y + 1.5, r, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#ffffff';
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.moveTo(x - side * 4, y + r - 2);
      ctx.lineTo(x - side * 9, y + r + 4);
      ctx.lineTo(x - side * 1, y + r - 1);
      ctx.fill();
      ctx.font = `14px ${UI_FONT}`;
      ctx.textAlign = 'center';
      ctx.fillText(ch.chatEmoji, x, y + 1);
      ctx.textAlign = 'left';
      ctx.restore();
    }
  }

  /** "+🪙10" floating up and fading over winner (or "−🪙10" over loser). */
  private drawFloaters(now: number): void {
    const fl = this.sim.social.floaters;
    if (!fl.length || this.zoom < TINY_ZOOM) return;
    const { ctx } = this;
    ctx.save();
    ctx.font = FLOAT_FONT;
    ctx.textAlign = 'center';
    ctx.lineJoin = 'round';
    for (const f of fl) {
      const head = this.renderer.heads.get(f.charId);
      if (!head || !head.visible || now < f.at) continue;
      const t = Math.min(1, (now - f.at) / (f.until - f.at));
      // beside head (banter bubble stays on top), floating up
      const x = Math.round(this.sx(head.x) + 10 * this.zoom + 12);
      const y = Math.round(this.sy(head.y) + 4 * this.zoom - t * 24);
      ctx.globalAlpha = t < 0.12 ? t / 0.12 : Math.max(0, 1 - Math.max(0, t - 0.6) / 0.4);
      ctx.lineWidth = 3;
      ctx.strokeStyle = 'rgba(20,24,36,0.85)';
      ctx.strokeText(f.text, x, y);
      ctx.fillStyle = f.color;
      ctx.fillText(f.text, x, y);
    }
    ctx.restore();
  }

  // =================================================================== labels

  /** Label part widths. Tool badge ("CODEX", "AGY"; like "SUB") only appears outside compact mode. */
  private labelWidth(l: Label): { nameW: number; chipW: number; badgeW: number; toolW: number; specW: number } {
    const ch = l.ch;
    const acc = this.sim.accounts.get(ch.info.account);
    const nameW = this.measure(LABEL_FONT, ch.info.name);
    const chipW = acc ? 13 : 0;
    const visitor = ch === this.sim.visitor;
    const badgeW = visitor ? this.measure(BADGE_FONT, visitorBadge()) + 7 : ch.info.kind === 'sub' && !l.compact ? this.measure(BADGE_FONT, 'SUB') + 7 : 0;
    const tool = badgeOf(ch.info);
    const toolW = tool && !l.compact ? this.measure(BADGE_FONT, tool) + 7 : 0;
    const spec = l.compact ? '' : modelSpec(ch.info);
    const specW = spec ? this.measure(SPEC_FONT, spec) + 2 : 0;
    return { nameW, chipW, badgeW, toolW, specW };
  }

  /** Positions label: at feet (or above head); if colliding, tries the other side. */
  private placeLabel(l: Label): boolean {
    const { nameW, chipW, badgeW, toolW, specW } = this.labelWidth(l);
    const w = Math.round(nameW + 10 + chipW + (badgeW ? badgeW + 3 : 0) + (toolW ? toolW + 3 : 0) + (specW ? specW + 3 : 0));
    const h = LABEL_H;
    const x = Math.round(this.sx(l.head.x) - w / 2);
    const below = Math.round(this.sy(l.head.feetY) + 3);
    const iconLift = this.iconLift(l.ch) * this.zoom;
    const over = Math.round(this.sy(l.head.y) - iconLift - h - 3);
    const first = l.above ? over : below;
    const second = l.above ? below : over;
    l.w = w;
    l.h = h;
    l.x = x;
    if (!this.overlaps(x, first, w, h)) l.y = first;
    else if (!this.overlaps(x, second, w, h)) l.y = second;
    else if (l.prio >= 90) l.y = first;
    else return false;
    this.place(l.x, l.y, w, h);
    return true;
  }

  private drawLabel(l: Label, sel: { agent: string | null; hover: string | null }): void {
    const { ctx } = this;
    const ch = l.ch;
    const acc = this.sim.accounts.get(ch.info.account);
    const sub = ch.info.kind === 'sub';
    const codex = ch.info.provider === 'codex' || acc?.provider === 'codex';
    const { nameW, chipW, badgeW, toolW, specW } = this.labelWidth(l);
    const { x, y, w, h } = l;
    const selected = sel.agent === ch.id;
    ctx.fillStyle = selected ? 'rgba(18,96,140,0.95)' : ch.mode === 'wait' ? 'rgba(120,78,0,0.92)' : 'rgba(22,26,38,0.82)';
    ctx.beginPath();
    ctx.roundRect(x, y, w, h, 7.5);
    ctx.fill();
    let cx = x + 4;
    if (acc && codex) {
      // Codex: hollow chip with stepped corners (dark background, border and letter in account color), as in panels.
      steppedRect(ctx, cx, y + h / 2 - 5, 10, 10, 2);
      ctx.fillStyle = CODEX_CHIP_BG;
      ctx.fill();
      ctx.lineWidth = 1.5;
      ctx.strokeStyle = acc.color;
      steppedRect(ctx, cx + 0.75, y + h / 2 - 4.25, 8.5, 8.5, 1.6);
      ctx.stroke();
      ctx.font = CHIP_FONT;
      ctx.textAlign = 'center';
      ctx.fillStyle = acc.color;
      ctx.fillText(acc.short.slice(0, 1), cx + 5, y + h / 2 + 0.5);
      ctx.textAlign = 'left';
      cx += chipW;
    } else if (acc) {
      ctx.beginPath();
      ctx.arc(cx + 5, y + h / 2, 5, 0, Math.PI * 2);
      ctx.fillStyle = acc.color;
      ctx.fill();
      ctx.font = CHIP_FONT;
      ctx.textAlign = 'center';
      ctx.fillStyle = luminance(acc.color) > 0.62 ? '#1d2330' : '#ffffff';
      ctx.fillText(acc.short.slice(0, 1), cx + 5, y + h / 2 + 0.5);
      ctx.textAlign = 'left';
      cx += chipW;
    }
    ctx.font = LABEL_FONT;
    ctx.fillStyle = '#f5f7fb';
    ctx.fillText(ch.info.name, cx + 1, y + h / 2 + 0.5);
    cx += nameW + 4;
    if (badgeW) {
      ctx.fillStyle = ch.appearance.lanyard ?? '#f2b33d';
      ctx.beginPath();
      ctx.roundRect(cx, y + 3, badgeW, h - 6, 4);
      ctx.fill();
      ctx.font = BADGE_FONT;
      ctx.fillStyle = '#2a2000';
      ctx.fillText(ch === this.sim.visitor ? visitorBadge() : 'SUB', cx + 3.5, y + h / 2 + 0.5);
      cx += badgeW + 3;
    } else if (sub) {
      // compact badge: dot in lanyard color
      ctx.fillStyle = ch.appearance.lanyard ?? '#f2b33d';
      ctx.beginPath();
      ctx.arc(x + w - 3, y + 3, 2.5, 0, Math.PI * 2);
      ctx.fill();
    }
    if (toolW) {
      const boss = !!ch.info.boss;
      ctx.fillStyle = boss ? '#f2b33d' : 'rgba(255,255,255,0.16)';
      ctx.beginPath();
      ctx.roundRect(cx, y + 3, toolW, h - 6, 3);
      ctx.fill();
      ctx.font = BADGE_FONT;
      ctx.fillStyle = boss ? '#2a1d00' : '#e8ecf5';
      ctx.fillText(badgeOf(ch.info) ?? '', cx + 3.5, y + h / 2 + 0.5);
      cx += toolW + 3;
    }
    if (specW) {
      ctx.font = SPEC_FONT;
      ctx.fillStyle = 'rgba(232,236,245,0.62)';
      ctx.fillText(modelSpec(ch.info), cx + 1, y + h / 2 + 0.5);
    }
    // The boss (the appointed orchestrator) wears a crown; just appointed, it drops onto the head, big, and bounces.
    const crownT = this.sim.now - ch.crownedAt;
    const crowning = ch.info.boss && ch.crownedAt > 0 && crownT < CROWN_DROP_MS;
    if (ch.info.boss && (!l.compact || crowning)) {
      const k = crowning ? crownT / CROWN_DROP_MS : 1;
      const lift = (1 - bounceOut(k)) * 90 * Math.max(1, this.zoom / 2);
      const size = 12 * Math.max(1, this.zoom / 2) * (crowning ? 2 - k : 1);
      ctx.font = `${Math.round(size)}px sans-serif`;
      ctx.textAlign = 'center';
      ctx.fillText('👑', this.sx(l.head.x), this.sy(l.head.y) - 1 - lift);
      ctx.textAlign = 'left';
    }
    // A Claude Code session with a long context or compacted (shared/overload.ts): a drop of sweat when tired,
    // 😵 and 💤 taking turns when overloaded. Only on main sessions, nothing in the compact label, and nothing beside the
    // other sleep (out of quota, drawQuotaSleep).
    if (ch.info.kind === 'main' && (ch.info.provider ?? 'claude') === 'claude' && !l.compact && !outOfQuota(ch)) {
      const level = sessionLoad(ch.info, this.thresholds).level;
      if (level !== 'ok') {
        const icon = level === 'tired' ? '💦' : Math.floor(this.sim.now / 1_500) % 2 ? '💤' : '😵';
        ctx.font = `${Math.round(10 * Math.max(1, this.zoom / 2))}px sans-serif`;
        ctx.textAlign = 'left';
        ctx.fillText(icon, this.sx(l.head.x) + 5 * Math.max(1, this.zoom / 2), this.sy(l.head.y) - 2);
      }
    }
  }
}

/** Chat icon when collapsed to chip only (overview): first emoji of phrase, or 💬. */
export function sayIcon(text: string): string {
  const m = /\p{Extended_Pictographic}(?:\uFE0F)?/u.exec(text);
  return m ? m[0] : '💬';
}

/** Visitor label badge (Visitor scene), in place of "SUB". */
export function visitorBadge(): string {
  return tr('visitor').toLocaleUpperCase();
}
