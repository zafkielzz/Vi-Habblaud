// Spot registry with reservations (1 occupant per spot) and search for free alternatives.
import type { SpotDef, SpotKind } from '../layout/types';

export class SpotRegistry {
  private spots = new Map<string, SpotDef>();
  private owners = new Map<string, string>();
  private byKind = new Map<SpotKind, SpotDef[]>();
  private byGroup = new Map<string, SpotDef[]>();

  /** Replaces the set of spots while preserving reservations for those that still exist. Returns lost reservations. */
  setSpots(spots: Iterable<SpotDef>): { spotId: string; owner: string }[] {
    this.spots.clear();
    this.byKind.clear();
    this.byGroup.clear();
    for (const s of spots) {
      this.spots.set(s.id, s);
      let list = this.byKind.get(s.kind);
      if (!list) this.byKind.set(s.kind, (list = []));
      list.push(s);
      if (s.group) {
        let g = this.byGroup.get(s.group);
        if (!g) this.byGroup.set(s.group, (g = []));
        g.push(s);
      }
    }
    const lost: { spotId: string; owner: string }[] = [];
    for (const [spotId, owner] of this.owners) {
      if (!this.spots.has(spotId)) {
        lost.push({ spotId, owner });
        this.owners.delete(spotId);
      }
    }
    return lost;
  }

  get(id: string | null | undefined): SpotDef | undefined {
    return id ? this.spots.get(id) : undefined;
  }

  all(): IterableIterator<SpotDef> {
    return this.spots.values();
  }

  /** Spots of a kind; `within` = only those of one building (its tile columns, see Sim.within). */
  ofKind(kind: SpotKind, within?: TileSpan): readonly SpotDef[] {
    const list = this.byKind.get(kind) ?? [];
    return within ? list.filter((s) => inSpan(s, within)) : list;
  }

  group(group: string): readonly SpotDef[] {
    return this.byGroup.get(group) ?? [];
  }

  ownerOf(id: string): string | undefined {
    return this.owners.get(id);
  }

  isFree(id: string, by?: string): boolean {
    const o = this.owners.get(id);
    return o === undefined || o === by;
  }

  reserve(id: string, by: string): boolean {
    if (!this.spots.has(id) || !this.isFree(id, by)) return false;
    this.owners.set(id, by);
    return true;
  }

  release(id: string | null | undefined, by: string): void {
    if (id && this.owners.get(id) === by) this.owners.delete(id);
  }

  releaseAll(by: string): void {
    for (const [id, o] of this.owners) if (o === by) this.owners.delete(id);
  }

  /** Spots reserved by someone. */
  reservedBy(by: string): string[] {
    const out: string[] = [];
    for (const [id, o] of this.owners) if (o === by) out.push(id);
    return out;
  }

  /**
   * Free spot of a given kind, closest to `near` (Manhattan distance in tiles), optionally
   * filtered. With `rng`, picks randomly among the 3 closest to vary destinations.
   */
  findFree(kind: SpotKind, opts: { near?: { tx: number; ty: number }; filter?: (s: SpotDef) => boolean; by?: string; rng?: () => number; within?: TileSpan } = {}): SpotDef | null {
    const list = this.byKind.get(kind);
    if (!list) return null;
    const cands: { s: SpotDef; d: number }[] = [];
    for (const s of list) {
      if (opts.within && !inSpan(s, opts.within)) continue;
      if (!this.isFree(s.id, opts.by)) continue;
      if (opts.filter && !opts.filter(s)) continue;
      const d = opts.near ? Math.abs(s.tx - opts.near.tx) + Math.abs(s.ty - opts.near.ty) : 0;
      cands.push({ s, d });
    }
    if (!cands.length) return null;
    cands.sort((a, b) => a.d - b.d);
    if (opts.rng) return cands[Math.floor(opts.rng() * Math.min(3, cands.length))].s;
    return cands[0].s;
  }

  /** Fully free group (pair) of a given kind: returns the spots in the group. */
  findFreeGroup(kind: SpotKind, opts: { rng?: () => number; filter?: (g: readonly SpotDef[]) => boolean; within?: TileSpan } = {}): readonly SpotDef[] | null {
    const groups: (readonly SpotDef[])[] = [];
    const seen = new Set<string>();
    for (const s of this.byKind.get(kind) ?? []) {
      if (!s.group || seen.has(s.group)) continue;
      if (opts.within && !inSpan(s, opts.within)) continue;
      seen.add(s.group);
      const g = this.group(s.group);
      if (g.length < 2 || !g.every((x) => this.isFree(x.id))) continue;
      if (opts.filter && !opts.filter(g)) continue;
      groups.push(g);
    }
    if (!groups.length) return null;
    return groups[Math.floor((opts.rng ?? Math.random)() * groups.length)];
  }
}

/** Tile columns [x0, x1) of one building (several offices = several buildings in one world). */
export interface TileSpan {
  x0: number;
  x1: number;
}

export function inSpan(s: { tx: number }, span: TileSpan): boolean {
  return s.tx >= span.x0 && s.tx < span.x1;
}
