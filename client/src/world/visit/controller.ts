// The core of the Visit scene, without DOM (testable): the building interior received from the world
// becomes the Sim office (shared/world/office-from-world.ts) and each `building.patch` is applied immediately,
// checking the building `rev` (gap: ↑ `resync {building}`, at most once every 5 s). The only commands sent
// from here are `leave` and `resync {building}`, via the World scene stream (POST /api/world/cmd): no `move`
// (indoor position is not sent to the world server) and no `view` (viewer would interpret it as "returned to city").
import type { WorldSceneCommand, WorldSceneInside } from '../../../../shared/world/api';
import { applyBuildingPatch, checkBuildingRev, officeFromBuilding } from '../../../../shared/world/office-from-world';
import type { BuildingPatchMessage, WorldBuildingDetail } from '../../../../shared/world/protocol';
import type { OfficeSnapshot } from '../../../../shared/types';
import type { VisitLight } from '../sim/sim';
import { visitLightOf } from './model';

/** Minimum wait between two `resync {building}` commands. */
export const VISIT_RESYNC_GAP_MS = 5_000;

export interface VisitControllerDeps {
  /** Publishes visit office (the `store.pushReplay` of the visit world). */
  push(snap: OfficeSnapshot): void;
  /** Sends commands through World scene stream (only `leave` and `resync {building}` originate here). */
  send(cmds: WorldSceneCommand[]): void;
  now(): number;
  /** Habblaud version (goes into `meta.version` of the visit office). */
  version: string;
  /** Interior changed (banner, panel, lights, theme). */
  changed?(): void;
}

export class VisitController {
  readonly id: string;
  rev: number;
  /** Current interior state (with applied patches). */
  detail: WorldBuildingDetail;
  snapshot: OfficeSnapshot;
  /** `leave` already sent: waiting for `pos` (return to street). */
  leaving = false;
  private resyncAt = -Infinity;

  constructor(
    inside: WorldSceneInside,
    private readonly deps: VisitControllerDeps,
  ) {
    this.id = inside.id;
    this.rev = inside.rev;
    this.detail = structuredClone(inside.detail);
    this.snapshot = officeFromBuilding(this.detail, deps.now(), { version: deps.version });
    deps.push(this.snapshot);
  }

  /** Building lights right now. */
  get light(): VisitLight {
    return visitLightOf(this.detail.building);
  }

  /**
   * Entire interior again (`building` from a `resync`, repeated `enter`, or new stream snapshot):
   * replaces everything, including `rev`, but as a patch (unchanged status keeps characters in place).
   */
  replace(inside: Pick<WorldSceneInside, 'rev' | 'detail'>): void {
    const d = structuredClone(inside.detail);
    const r = applyBuildingPatch(this.snapshot, { rev: inside.rev, floors: d.floors, building: d.building }, this.deps.now());
    this.rev = inside.rev;
    this.detail = d;
    this.resyncAt = -Infinity;
    this.publish(r.snapshot);
  }

  /** A `building.patch`: applies next rev, ignores duplicates or stale, and requests resync on gap. */
  patch(msg: Pick<BuildingPatchMessage, 'rev' | 'floors' | 'visitors' | 'building'>): 'apply' | 'stale' | 'resync' {
    const what = checkBuildingRev(this.rev, msg.rev);
    if (what === 'stale') return what;
    if (what === 'resync') {
      const now = this.deps.now();
      if (now - this.resyncAt >= VISIT_RESYNC_GAP_MS) {
        this.resyncAt = now;
        this.deps.send([{ t: 'resync', building: this.id }]);
      }
      return what;
    }
    // current `building` decides whether agents appear when patch only brings floors
    const r = applyBuildingPatch(this.snapshot, msg, this.deps.now(), this.detail.building);
    this.rev = msg.rev;
    if (msg.floors) this.detail.floors = structuredClone(msg.floors);
    if (msg.building) this.detail.building = structuredClone(msg.building);
    if (typeof msg.visitors === 'number') this.detail.visitors = msg.visitors;
    this.publish(r.snapshot);
    return what;
  }

  /** Leave building: `leave` (once); return to street is the `pos` returned by server. */
  leave(): boolean {
    if (this.leaving) return false;
    this.leaving = true;
    this.deps.send([{ t: 'leave' }]);
    this.deps.changed?.();
    return true;
  }

  private publish(snap: OfficeSnapshot): void {
    if (snap !== this.snapshot) {
      this.snapshot = snap;
      this.deps.push(snap);
    }
    this.deps.changed?.();
  }
}
