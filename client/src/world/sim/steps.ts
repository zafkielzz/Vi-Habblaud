// Steps in a character's action queue. Created during planning (never per frame).
import type { Dir, HeldItem, IconName, Pose } from '../../art/api';
import type { Gathering } from '../social/gathering';

export type Step =
  /** Walks (or runs) to tile (tx, ty); then, optionally, to fine position (fx, fy) and faces `dir`. */
  | { t: 'go'; tx: number; ty: number; run?: boolean; fx?: number; fy?: number; dir?: Dir; held?: HeldItem; path?: number[]; i?: number; fine?: boolean }
  /** Snaps into spot (seat or use point). Requires being on the approach tile. */
  | { t: 'enter'; spot: string }
  /** Leaves current spot back to the approach tile (stand up). */
  | { t: 'exit' }
  /** Stays in a pose for an amount of time. */
  | { t: 'act'; pose: Pose; ms: number; held?: HeldItem; dir?: Dir; icon?: IconName; machine?: string; seated?: boolean }
  /** Waits for a condition (or maximum time), in a pose. */
  | { t: 'until'; cond: () => boolean; minMs: number; maxMs: number; pose?: Pose; held?: HeldItem; dir?: Dir }
  /** Spawns inside the elevator and steps out to the front tile. */
  | { t: 'elevOut'; elev: number; phase: number }
  /** Steps into the elevator and disappears. */
  | { t: 'elevIn'; elev: number; phase: number }
  /** Uses the restroom stall: enters, disappears, door closes; then exits. */
  | { t: 'stall'; spot: string; ms: number; phase: number }
  /** Switches room light on/off at switch (must be on the switch spot). */
  | { t: 'switch'; room: string; on: boolean; phase: number; onlyIfLast?: boolean }
  /** Participates in a gathering (TV, game, chat...) until it ends; pose comes from director (social/social.ts). */
  | { t: 'gather'; g: Gathering }
  /** Immediate side effect. */
  | { t: 'do'; fn: () => void }
  /** Drops from the sky onto (gx, gy) (a new Claude Code session): falls, lands with a "Plop!". */
  | { t: 'fall'; gx: number; gy: number; tx: number; ty: number; vy: number; phase: number }
  /** Removes the character from the world. */
  | { t: 'remove' };
