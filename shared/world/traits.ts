// Personality traits: shared between office characters (client/src/world/social/persona.ts, picking
// 2 or 3 per seed) and Habblaud World player (choosing 2 or 3). Ids and clashing pairs come from
// protocol; labels (tr) and player choice validation live here. Pure: no Node or DOM.
//
// Labels are nouns ("Competition", "Vanity"): independent of character gender.
import { tr } from '../i18n';
import { PLAYER_TRAITS, TRAIT_CLASHES, TRAIT_IDS, type TraitId } from './protocol';

export { TRAIT_CLASHES, TRAIT_IDS, type TraitId };

export interface Trait {
  id: TraitId;
  emoji: string;
  label: string;
  /** A sentence explaining office effect (tooltip in UI). */
  desc: string;
}

/** In TRAIT_IDS order (verified by test: personaFor lottery depends on it). */
export const TRAITS: Readonly<Record<TraitId, Trait>> = {
  competicao: { id: 'competicao', emoji: '🏆', label: tr('Competition'), desc: tr('Loves to compete: challenges coworkers at ping-pong, video games and rock-paper-scissors.') },
  apostas: { id: 'apostas', emoji: '🎲', label: tr('Betting'), desc: tr('Takes any bet and bets big at rock-paper-scissors.') },
  games: { id: 'games', emoji: '🎮', label: tr('Games'), desc: tr('Lives on the lounge console and the arcade machines — and usually wins.') },
  series: { id: 'series', emoji: '📺', label: tr('TV & shows'), desc: tr('Never misses a show on the lounge TV (ideally with popcorn).') },
  fofoca: { id: 'fofoca', emoji: '🗣️', label: tr('Gossip'), desc: tr('Strikes up chats in the kitchen and knows everything going on in the rooms.') },
  vaidade: { id: 'vaidade', emoji: '💄', label: tr('Vanity'), desc: tr('Stops by the bathroom mirror to freshen up whenever possible.') },
  cafeina: { id: 'cafeina', emoji: '☕', label: tr('Caffeine'), desc: tr('Runs on coffee: the kitchen coffee maker is a second home.') },
  piadas: { id: 'piadas', emoji: '😂', label: tr('Jokes'), desc: tr('Cracks a joke in every chat and gets the group laughing.') },
  esporte: { id: 'esporte', emoji: '🏓', label: tr('Sports'), desc: tr('Plays ping-pong, stretches and cheers for soccer on TV.') },
  timidez: { id: 'timidez', emoji: '🙈', label: tr('Shyness'), desc: tr('Keeps to themselves: reads, looks out the window and joins fewer groups.') },
  economia: { id: 'economia', emoji: '💰', label: tr('Thrift'), desc: tr('Penny-pincher: bets small and sometimes dodges the bet.') },
  sonecas: { id: 'sonecas', emoji: '😴', label: tr('Naps'), desc: tr('Any couch or beanbag becomes a bed.') },
  calma: { id: 'calma', emoji: '🧘', label: tr('Calm'), desc: tr('Zen: stretches, the window and quiet chats.') },
  leitura: { id: 'leitura', emoji: '📚', label: tr('Reading'), desc: tr('Always has a book from the shelf (or a phone) in hand.') },
};

export function isTraitId(v: unknown): v is TraitId {
  return typeof v === 'string' && (TRAIT_IDS as readonly string[]).includes(v);
}

/** Two traits clash and cannot coexist on same person (TRAIT_CLASHES, bidirectional). */
export function traitsClash(a: TraitId, b: TraitId): boolean {
  return TRAIT_CLASHES.some(([x, y]) => (x === a && y === b) || (x === b && y === a));
}

/**
 * Traits chosen by player: 2 or 3 known ids, without duplicates or clashing pairs. Returns list (in
 * received order) or null.
 */
export function parsePlayerTraits(raw: unknown): TraitId[] | null {
  if (!Array.isArray(raw) || raw.length < PLAYER_TRAITS.min || raw.length > PLAYER_TRAITS.max) return null;
  const out: TraitId[] = [];
  for (const t of raw) {
    if (!isTraitId(t) || out.includes(t) || out.some((o) => traitsClash(o, t))) return null;
    out.push(t);
  }
  return out;
}
