// Project room state in the world: lifecycle (construction/dismantling) and lighting.
import type { RoomInfo } from '../../../../shared/types';
import type { RoomTheme } from '../../art/api';
import { BUILD_MS, DISMANTLE_MS } from '../constants';
import type { AreaLayout } from '../layout/types';
import { lightLevel } from './behavior';

/**
 * - building: construction animation;
 * - ready: room ready;
 * - dismantling: dismantling animation;
 * - gone: dismantled (will be removed).
 */
export type RoomPhase = 'building' | 'ready' | 'dismantling' | 'gone';

export class RoomState {
  info: RoomInfo;
  /** Seed used to generate the theme and layout (fixed since creation, even if info.seed changes). */
  readonly seed: number;
  /** Building slot chosen by the client (no gaps; see Sim.compact). May differ from info.slot. Absolute: with several
   * buildings, the slot of the street's column (geometry.slotColumn); `local` is the slot inside its own building. */
  slot: number;
  /** The office whose building holds the room (RoomInfo.office; '' = the first building). */
  office = '';
  /** Slot inside its building (= slot for the first building). */
  local: number;
  theme: RoomTheme;
  layout: AreaLayout;
  phase: RoomPhase;
  phaseAt: number;
  listed = true;
  unlistedAt = 0;
  lightOn: boolean;
  lightAt = -1e9;
  /** Character that took charge of the light switch (turn on on arrival / turn off on exit). */
  switchClaim: string | null = null;
  /** When all dismantling conditions became true (0 = they are not). */
  readyToDismantleAt = 0;
  /** Present accounts (for the plaque dots), updated by the world. */
  accounts: string[] = [];
  /** Kanban board items. */
  board: { status: 'pending' | 'in_progress' | 'completed' }[] = [];
  /** Increments when static cache contents change (name, theme). */
  version = 0;
  /**
   * Old address of a moved room: stays in place only until its occupants leave, turn off lights,
   * and it is dismantled. No one belongs to it and it does not appear in the snapshot.
   */
  ghost = false;

  constructor(info: RoomInfo, theme: RoomTheme, layout: AreaLayout, phase: RoomPhase, now: number, lit: boolean, slot: number) {
    this.info = info;
    this.seed = info.seed;
    this.slot = slot;
    this.local = slot;
    this.theme = theme;
    this.layout = layout;
    this.phase = phase;
    this.phaseAt = now;
    this.lightOn = lit;
    if (lit) this.lightAt = now - 10_000;
  }

  get id(): string {
    return this.info.id;
  }

  /** Progress of the current phase animation (0..1). */
  progress(now: number): number {
    if (this.phase === 'building') return Math.min(1, (now - this.phaseAt) / BUILD_MS);
    if (this.phase === 'dismantling') return Math.min(1, (now - this.phaseAt) / DISMANTLE_MS);
    if (this.phase === 'ready') return 1;
    return 0;
  }

  /** Occupies the grid (walkable) and is rendered. */
  get present(): boolean {
    return this.phase === 'building' || this.phase === 'ready' || this.phase === 'dismantling';
  }

  setPhase(phase: RoomPhase, now: number): void {
    this.phase = phase;
    this.phaseAt = now;
  }

  /** Reverts an ongoing dismantling to construction, continuing from the equivalent visual point. */
  rebuild(now: number): void {
    if (this.phase === 'dismantling') {
      const p = this.progress(now);
      this.phase = 'building';
      this.phaseAt = now - (1 - p) * BUILD_MS;
    } else if (this.phase === 'gone') {
      this.setPhase('building', now);
    }
  }

  setLight(on: boolean, now: number): void {
    if (this.lightOn === on) return;
    this.lightOn = on;
    this.lightAt = now;
  }

  light(now: number): number {
    return lightLevel(this.lightOn, now - this.lightAt);
  }
}
