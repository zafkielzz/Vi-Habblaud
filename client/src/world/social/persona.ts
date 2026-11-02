// Agent personalities — PURE and deterministic functions (same seed = same person in
// any browser). Each agent has 2 or 3 traits, which affect what they prefer to do when idle,
// who they hang out with, and what they say; pairs of agents can have friendship or rivalry.
import { mulberry32 } from '../../../../shared/hash';
import { IDLE_WEIGHTS, type IdleActivity } from '../sim/behavior';
import { tr } from '../../../../shared/i18n';
import { TRAIT_IDS, traitsClash, type TraitId } from '../../../../shared/world/traits';

// The ids, labels, and clashing pairs live in shared/world/traits.ts (the same as Habblaud
// World player); re-exported here for modules that already imported from this module.
export { TRAIT_IDS, TRAITS, type Trait, type TraitId } from '../../../../shared/world/traits';

/** Catchphrases: each agent has one (appears once in a while in speech lines). */
export const CATCHPHRASES = [
  tr("Let's go!"),
  tr('Off we go!'),
  tr('Done and done!'),
  tr("Today's the day!"),
  tr("Let's go!"),
  tr("Let's code!"),
  tr('It worked!'),
  tr('Come on!'),
  tr('Awesome!'),
  tr('Got your back!'),
  tr('No stress.'),
  tr("It'll work out!"),
] as const;

export interface Persona {
  traits: TraitId[];
  /** 0..1: desire to join gatherings (shyness lowers it; gossip and jokes raise it). */
  sociability: number;
  /** 0..1: luck/skill in games (games and sports raise it). */
  skill: number;
  catchphrase: string;
}

/** 32-bit mix (nearby seeds turn into very different sequences). */
function mix(seed: number): number {
  let h = (seed ^ 0x5bd1e995) >>> 0;
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d);
  h = Math.imul(h ^ (h >>> 12), 0x297a2d39);
  return (h ^ (h >>> 15)) >>> 0;
}

const cache = new Map<number, Persona>();

/** Persona of the agent with this seed (2 or 3 non-conflicting traits). */
export function personaFor(seed: number): Persona {
  const hit = cache.get(seed);
  if (hit) return hit;
  const rng = mulberry32(mix(seed));
  const n = rng() < 0.55 ? 2 : 3;
  const traits: TraitId[] = [];
  for (let guard = 0; traits.length < n && guard < 40; guard++) {
    const t = TRAIT_IDS[Math.floor(rng() * TRAIT_IDS.length) % TRAIT_IDS.length];
    if (traits.includes(t) || traits.some((o) => traitsClash(o, t))) continue;
    traits.push(t);
  }
  let sociability = 0.45 + rng() * 0.3;
  if (traits.includes('timidez')) sociability -= 0.3;
  if (traits.includes('fofoca')) sociability += 0.2;
  if (traits.includes('piadas')) sociability += 0.12;
  let skill = 0.3 + rng() * 0.4;
  if (traits.includes('games')) skill += 0.2;
  if (traits.includes('esporte')) skill += 0.15;
  if (traits.includes('sonecas')) skill -= 0.1;
  const catchphrase = CATCHPHRASES[Math.floor(rng() * CATCHPHRASES.length) % CATCHPHRASES.length];
  const p: Persona = { traits, sociability: clamp01(sociability), skill: clamp01(skill), catchphrase };
  if (cache.size > 500) cache.clear();
  cache.set(seed, p);
  return p;
}

function clamp01(v: number): number {
  return Math.max(0.05, Math.min(0.95, v));
}

export function hasTrait(p: Persona, t: TraitId): boolean {
  return p.traits.includes(t);
}

export type Bond = 'amizade' | 'rivalidade';

/**
 * Bond between two agents (symmetric): ~22% friendship, ~12% rivalry, the rest just colleagues.
 * Competition on both sides leans toward rivalry; gossip/jokes toward friendship.
 */
export function bondBetween(seedA: number, seedB: number): Bond | null {
  if (seedA === seedB) return null;
  const lo = Math.min(seedA >>> 0, seedB >>> 0);
  const hi = Math.max(seedA >>> 0, seedB >>> 0);
  const r = mulberry32(mix(lo ^ Math.imul(hi, 0x9e3779b1)))();
  const a = personaFor(seedA);
  const b = personaFor(seedB);
  const rivalry = 0.12 + (hasTrait(a, 'competicao') && hasTrait(b, 'competicao') ? 0.18 : 0);
  const friendship = 0.22 + ([a, b].some((p) => hasTrait(p, 'fofoca') || hasTrait(p, 'piadas')) ? 0.08 : 0);
  if (r < rivalry) return 'rivalidade';
  if (r < rivalry + friendship) return 'amizade';
  return null;
}

/** How much each trait multiplies the inclination for each solo outing. */
const SOLO_K: Partial<Record<TraitId, Partial<Record<IdleActivity, number>>>> = {
  cafeina: { coffee: 3 },
  vaidade: { mirror: 5, bathroom: 1.3 },
  leitura: { shelf: 3, phone: 1.6, window: 1.2 },
  sonecas: { lounge: 2.5 },
  esporte: { stretch: 2.5, water: 1.5 },
  calma: { window: 2.5, stretch: 1.5 },
  games: { arcade: 3, phone: 1.4 },
  timidez: { window: 1.5, shelf: 1.5, phone: 1.5 },
  fofoca: { coffee: 1.4, phone: 1.4 },
  series: { phone: 1.5, lounge: 1.3 },
  economia: { snack: 0.4, water: 1.6 },
};

/** Weights of solo outings for this personality. */
export function soloWeights(p: Persona): Record<IdleActivity, number> {
  const out = { ...IDLE_WEIGHTS };
  for (const t of p.traits) for (const [k, v] of Object.entries(SOLO_K[t] ?? {})) out[k as IdleActivity] *= v as number;
  return out;
}
