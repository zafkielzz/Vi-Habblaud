// Gatherings (idle agents' group activities): types and PURE rules — choosing activities by
// personality, bets, rock-paper-scissors, and who wins a match. The script of each gathering (who speaks,
// celebrates, pays) lives in social.ts.
import type { Dir, HeldItem, Pose } from '../../art/api';
import { hasTrait, type Bond, type Persona, type TraitId } from './persona';
import { tr } from '../../../../shared/i18n';

export type GatherKind = 'tv' | 'videogame' | 'arcade' | 'pingpong' | 'kitchen' | 'talk' | 'rps' | 'mirror';
export type Role = 'player' | 'watcher' | 'talker';
export type Program = 'futebol' | 'novela' | 'desenho';
export type Gesture = 'rock' | 'paper' | 'scissors';

/** TV program -> drawScreen('show') seed (art contract: seed % 3). */
export const PROGRAM_SEED: Readonly<Record<Program, number>> = { futebol: 0, novela: 1, desenho: 2 };

export interface KindInfo {
  /** "Watching TV" — for the interface ("Watching TV with Rafaela"). */
  label: string;
  emoji: string;
  /** Minimum participants for the gathering to happen. */
  min: number;
  /** Maximum (players + crowd). */
  max: number;
  /** Solo also allowed (only for idle agents; agents awaiting shell only join in groups). */
  solo?: boolean;
  /** Game with winner (can have bets). */
  match?: boolean;
}

export const KINDS: Readonly<Record<GatherKind, KindInfo>> = {
  tv: { label: tr('Watching TV'), emoji: '📺', min: 2, max: 5 },
  videogame: { label: tr('Playing video games'), emoji: '🎮', min: 2, max: 5, match: true },
  arcade: { label: tr('Arcade showdown'), emoji: '👾', min: 2, max: 2, match: true },
  pingpong: { label: tr('Playing ping-pong'), emoji: '🏓', min: 2, max: 4, match: true },
  kitchen: { label: tr('Kitchen chat'), emoji: '☕', min: 2, max: 4 },
  talk: { label: tr('Chatting'), emoji: '💬', min: 2, max: 2 },
  rps: { label: tr('Rock-paper-scissors'), emoji: '✊', min: 2, max: 4, match: true },
  mirror: { label: tr('Primping at the mirror'), emoji: '💄', min: 1, max: 2, solo: true },
};

export interface Member {
  id: string;
  role: Role;
  /** Spot reserved by the gathering (seat, use point, spectator point) or null (standing on a tile). */
  spot: string | null;
  /** Standing without a spot (spectators in rock-paper-scissors). */
  tile?: { x: number; y: number; dir: Dir };
  arrived: boolean;
  left: boolean;
  /** Joined when gathering was already formed (or forming): no one waits for them to start. */
  late?: boolean;
  /** Base pose while participating. */
  pose: Pose;
  held: HeldItem;
  /** Short action over base pose (cheering, laughing, gesture...). */
  actPose: Pose | null;
  actHeld: HeldItem;
  actUntil: number;
  /** What to carry when returning to desk (kitchen coffee). */
  carry: 'none' | 'coffee' | 'water';
}

export interface Gathering {
  id: number;
  kind: GatherKind;
  host: string;
  members: Member[];
  /** gather: heading to spots; run: in progress; final: celebration/farewell; ended: finished. */
  phase: 'gather' | 'run' | 'final' | 'ended';
  createdAt: number;
  startAt: number;
  /** Scheduled end (activities without scoring). */
  until: number;
  /** Next beat in the script. */
  nextAt: number;
  /** Beat counter (free use per script). */
  step: number;
  seed: number;
  rng: () => number;
  program: Program | null;
  /** Coins at stake (0 = for honor only). */
  bet: number;
  /** Score [player 0, player 1]. */
  score: [number, number];
  gestures: [Gesture, Gesture] | null;
  ties: number;
  rematches: number;
  winner: string | null;
  loser: string | null;
  /** Spots reserved by the gathering (owner `g:<id>`), released when it ends. */
  pool: string[];
  lastLine: string | null;
  lastSpeaker: string | null;
  /** Scheduled lines (e.g. "let's go!" from an invited agent, slightly after the invite). */
  pending: { id: string; at: number; text: string }[];
}

export function ownerTag(g: Pick<Gathering, 'id'>): string {
  return `g:${g.id}`;
}

export function players(g: Gathering): Member[] {
  return g.members.filter((m) => m.role === 'player' && !m.left);
}

export function active(g: Gathering): Member[] {
  return g.members.filter((m) => !m.left);
}

// ---------------------------------------------------------------- activity choice

const BASE: Readonly<Record<GatherKind, number>> = {
  tv: 10,
  videogame: 9,
  arcade: 5,
  pingpong: 9,
  kitchen: 12,
  talk: 8,
  rps: 8,
  mirror: 2,
};

/** How much each trait multiplies the inclination for each gathering. */
const TRAIT_K: Partial<Record<TraitId, Partial<Record<GatherKind, number>>>> = {
  series: { tv: 3 },
  games: { videogame: 3, arcade: 2.5 },
  esporte: { pingpong: 3, tv: 1.3 },
  competicao: { pingpong: 1.8, videogame: 1.8, rps: 1.8, arcade: 1.5 },
  apostas: { rps: 3.5 },
  fofoca: { kitchen: 2.5, talk: 1.8 },
  cafeina: { kitchen: 2.2 },
  piadas: { kitchen: 1.5, talk: 1.5 },
  vaidade: { mirror: 5 },
  timidez: { talk: 0.6, kitchen: 0.7, rps: 0.6, pingpong: 0.7, videogame: 0.8 },
  sonecas: { tv: 1.5, pingpong: 0.6 },
  economia: { rps: 0.4 },
  calma: { talk: 1.3, kitchen: 1.2, rps: 0.5, pingpong: 0.7 },
  leitura: { tv: 0.8 },
};

export function kindWeight(kind: GatherKind, p: Persona): number {
  let w = BASE[kind];
  for (const t of p.traits) w *= TRAIT_K[t]?.[kind] ?? 1;
  return w;
}

/** Weighted draw among available gatherings now (`avail[k]` true). */
export function pickKind(rng: () => number, p: Persona, avail: Partial<Record<GatherKind, boolean>>): GatherKind | null {
  const kinds = (Object.keys(BASE) as GatherKind[]).filter((k) => avail[k]);
  let total = 0;
  for (const k of kinds) total += kindWeight(k, p);
  if (total <= 0) return null;
  let r = rng() * total;
  for (const k of kinds) {
    r -= kindWeight(k, p);
    if (r < 0) return k;
  }
  return kinds[kinds.length - 1] ?? null;
}

/**
 * Score of a colleague as partner in a gathering: affinity with activity, bond (friendship pulls
 * toward any gathering; rivalry toward games), and a bit of randomness.
 */
export function partnerScore(kind: GatherKind, p: Persona, bond: Bond | null, rng: () => number): number {
  let s = kindWeight(kind, p) / BASE[kind] + p.sociability;
  if (bond === 'amizade') s += 1.2;
  if (bond === 'rivalidade') s += KINDS[kind].match ? 1.6 : -0.8;
  return s + rng() * 1.2;
}

/** TV program, based on the taste of whoever turns it on. */
export function pickProgram(rng: () => number, p: Persona): Program {
  if (hasTrait(p, 'esporte') && rng() < 0.7) return 'futebol';
  if (hasTrait(p, 'series') && rng() < 0.6) return 'novela';
  const r = rng();
  return r < 0.4 ? 'futebol' : r < 0.75 ? 'novela' : 'desenho';
}

// ---------------------------------------------------------------- bets and matches

/** Bet ceiling. */
export const MAX_BET = 50;

/**
 * Value at stake (0 = for honor only). Rock-paper-scissors always wagers something when both have coins;
 * in matches, only between rivals or with someone with "apostas" in the gathering.
 */
export function betFor(kind: GatherKind, a: Persona, b: Persona, coinsA: number, coinsB: number, bond: Bond | null, rng: () => number): number {
  const cap = Math.min(coinsA, coinsB, MAX_BET);
  if (cap < 1) return 0;
  let v: number;
  if (kind === 'rps') {
    v = 10;
    if (hasTrait(a, 'apostas') || hasTrait(b, 'apostas')) v = 20;
    if (hasTrait(a, 'competicao')) v += 5;
  } else if (KINDS[kind].match) {
    const keen = bond === 'rivalidade' || hasTrait(a, 'apostas') || hasTrait(b, 'apostas');
    if (!keen && !(hasTrait(a, 'competicao') && rng() < 0.35)) return 0;
    if (keen && rng() < 0.3) return 0;
    v = bond === 'rivalidade' ? 15 : 10;
  } else return 0;
  if (hasTrait(a, 'economia') || hasTrait(b, 'economia')) v = 5;
  return Math.max(1, Math.min(cap, v));
}

/** Rock-paper-scissors winner: 0 tie, 1 first player, 2 second player. */
export function rpsResult(a: Gesture, b: Gesture): 0 | 1 | 2 {
  if (a === b) return 0;
  const beats: Record<Gesture, Gesture> = { rock: 'scissors', scissors: 'paper', paper: 'rock' };
  return beats[a] === b ? 1 : 2;
}

export const GESTURES: readonly Gesture[] = ['rock', 'paper', 'scissors'];

/** Selected gesture (those with "competicao" lean slightly towards rock). */
export function pickGesture(rng: () => number, p: Persona): Gesture {
  if (hasTrait(p, 'competicao') && rng() < 0.2) return 'rock';
  return GESTURES[Math.floor(rng() * 3) % 3];
}

/** Probability of A winning a point/round against B, based on skill (0.15–0.85). */
export function winChance(skillA: number, skillB: number): number {
  return Math.max(0.15, Math.min(0.85, 0.5 + (skillA - skillB) * 0.6));
}

/** Points to win each game. */
export const TARGET: Readonly<Partial<Record<GatherKind, number>>> = { pingpong: 5, videogame: 2, arcade: 1 };

/** Icon for each gesture above head (art contract). */
export const GESTURE_ICON = { rock: 'hand_rock', paper: 'hand_paper', scissors: 'hand_scissors' } as const;
export const GESTURE_EMOJI: Readonly<Record<Gesture, string>> = { rock: '✊', paper: '✋', scissors: '✌️' };
