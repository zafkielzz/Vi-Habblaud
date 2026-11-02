// Character state: position, pose, animation, step queue, and visual markers.
import type { AgentInfo } from '../../../../shared/types';
import type { Energy } from '../../../../shared/energy';
import type { Appearance, Dir, HeldItem, IconName, Pose } from '../../art/api';
import { mulberry32 } from '../../../../shared/hash';
import { FOOT_DX, FOOT_DY, TILE } from '../constants';
import type { Mode } from './behavior';
import type { Gathering } from '../social/gathering';
import type { ShellStage } from './shell';
import type { Step } from './steps';

export class Character {
  readonly id: string;
  info: AgentInfo;
  appearance: Appearance;
  readonly rng: () => number;

  // position (world px; feet) and logical tile (always walkable when stationary)
  x = 0;
  y = 0;
  tx = 0;
  ty = 0;
  dir: Dir = 'down';
  pose: Pose = 'stand';
  held: HeldItem = 'none';
  seated = false;
  alpha = 1;
  visible = true;
  /** Forced depth (seats). null = uses y. */
  sortY: number | null = null;
  /** Time (ms) in current pose, to select animation frame. */
  animT = 0;

  // behavior
  mode: Mode = 'idle';
  queue: Step[] = [];
  step: Step | null = null;
  stepT = 0;
  stepStarted = false;
  /** Replan as soon as the current (non-interruptible) step finishes. */
  replan = false;
  /** Desk/stool/work spot (reserved as long as the character exists). */
  homeSpot: string | null = null;
  /** Spot where currently located (seat/machine), besides home. */
  atSpot: string | null = null;
  /** Temporary spots reserved during a stroll. */
  tempSpots: string[] = [];
  roomId: string;
  /** The office whose building it is in (AgentInfo.office; '' = the first building). */
  office = '';
  leaving = false;
  gone = false;
  arriving = false;
  missingSince: number | null = null;
  /** Next stroll for the idle character (epoch ms). */
  nextOutingAt = 0;
  /** Gathering in which it participates (or on the way to it). */
  gathering: Gathering | null = null;
  /** Waiting for a shell: next attempt to join a gathering (epoch ms; 0 = schedule). */
  nextSocialAt = 0;
  /** Renders only after this instant (elevator queue). */
  hiddenUntil = 0;
  /** Hidden (inside stall or closed elevator). */
  inside = false;
  /** Next time the planner can run (avoids unnecessary replanning every frame). */
  thinkAt = 0;
  /** Subagent has already delivered results to parent. */
  delivered = false;
  /** End of stall usage (epoch ms). */
  stallUntil = 0;
  /** Origin of snapping to/leaving a seat (short interpolation). */
  enterFrom: { x: number; y: number } | null = null;
  /** Crowded room: tile where working while standing (no reserved spot). */
  standTile: { x: number; y: number } | null = null;
  /** Own walking pace (±8%), so characters leaving together do not walk in perfect lockstep. */
  readonly speedK: number;
  /** Lateral lane offset (px) when walking: two characters on the same path do not overlap. */
  readonly lane: number;
  /** Current visual offset (px), smoothed toward the lane while walking. */
  offX = 0;
  offY = 0;

  // markers
  icon: IconName | null = null;
  iconUntil = 0;
  iconAt = 0;
  bubbleText: string | null = null;
  bubbleIcon = '';
  bubbleAt = 0;
  bubbleUntil = 0;
  /** Mini speech bubble (emoji). */
  chatEmoji = '';
  chatUntil = 0;
  /** Short speech (small bubble with text) in gatherings: invites, chat, cheering, bets. */
  sayText = '';
  sayAt = 0;
  sayUntil = 0;
  lastActivityId: string | null = null;
  activityChangedAt = 0;

  // shell waiting ('shell' mode; rules in sim/shell.ts)
  /** Start (epoch ms) of current wait: oldest shell. 0 = not waiting. */
  shellSince = 0;
  /** Number of shells waiting for (the "×N" on the hourglass). */
  shellCount = 0;
  shellLabel = '';
  /** Gag stage (recalculated every frame from wait duration). */
  shellStage: ShellStage | null = null;
  /** When entered 'shell' mode (world clock): bubble rhythm in 'important' mode. */
  shellEnteredAt = 0;
  /** Cached bubble text: rebuilt only when displayed time changes (no new string per frame). */
  shellText = '';
  shellTextKey = -1;
  /**
   * Reaction to shell completion (cheer/lament) ongoing until this instant: a mode
   * change will not interrupt it (the queue finishes back at desk and planner follows current status).
   */
  reactUntil = 0;
  /** Picked up by mouse (Sim.grab): floats stationary following pointer, without running queue. */
  grabbed = false;
  /** When the crown last landed on this character (boss appointed while the office watched): the crown drops in. */
  crownedAt = 0;
  /** Boss or worker: its account's quota as energy (shared/energy.ts); null for anyone else or without a reading. */
  energy: Energy | null = null;
  /** Where the pointer is (world px) while picked up. */
  grabX = 0;
  grabY = 0;
  /** `at` of last handled 'ShellDone' Activity (those before arrival do not celebrate). */
  shellDoneAt = 0;
  /** Render: next popcorn popping from the bucket (epoch ms). */
  popcornAt = 0;

  constructor(info: AgentInfo, appearance: Appearance) {
    this.id = info.id;
    this.info = info;
    this.appearance = appearance;
    this.roomId = info.roomId;
    this.rng = mulberry32((info.seed ^ 0x9e3779b9) >>> 0);
    // derived from another generator so as not to alter the behavior random sequence
    const r = mulberry32((info.seed ^ 0x51ed27a3) >>> 0);
    this.speedK = 0.92 + r() * 0.16;
    this.lane = Math.round((r() * 2 - 1) * 3.5);
  }

  /** Eases visual offset toward lane (walking) or toward center (stationary). */
  updateLane(dt: number): void {
    const walking = this.pose === 'walk' || this.pose === 'run';
    const horiz = this.dir === 'left' || this.dir === 'right';
    const tx = walking && !horiz ? this.lane : 0;
    const ty = walking && horiz ? this.lane * 0.6 : 0;
    const k = Math.min(1, dt * 5);
    this.offX += (tx - this.offX) * k;
    this.offY += (ty - this.offY) * k;
    if (Math.abs(this.offX) < 0.05) this.offX = 0;
    if (Math.abs(this.offY) < 0.05) this.offY = 0;
  }

  /** Places feet at the standard point of a tile. */
  placeAtTile(tx: number, ty: number): void {
    this.tx = tx;
    this.ty = ty;
    this.x = tx * TILE + FOOT_DX;
    this.y = ty * TILE + FOOT_DY;
  }

  setPose(pose: Pose, held: HeldItem = 'none'): void {
    if (this.pose !== pose) {
      this.pose = pose;
      this.animT = 0;
    }
    this.held = held;
  }

  setIcon(icon: IconName | null, ms: number, now: number): void {
    this.icon = icon;
    this.iconAt = now;
    this.iconUntil = icon ? now + ms : 0;
  }

  showBubble(icon: string, text: string, ms: number, now: number): void {
    this.bubbleIcon = icon;
    this.bubbleText = text;
    this.bubbleAt = now;
    this.bubbleUntil = now + ms;
  }

  depth(): number {
    return this.sortY ?? this.y;
  }
}

/** Dominant direction of a displacement. */
export function dirOf(dx: number, dy: number, fallback: Dir): Dir {
  if (Math.abs(dx) < 0.01 && Math.abs(dy) < 0.01) return fallback;
  if (Math.abs(dx) >= Math.abs(dy)) return dx > 0 ? 'right' : 'left';
  return dy > 0 ? 'down' : 'up';
}

/** Direction of A facing B. */
export function facing(ax: number, ay: number, bx: number, by: number): Dir {
  return dirOf(bx - ax, by - ay, 'down');
}
