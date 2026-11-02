// Text of each world server notice in the scene (`notice {level, text}`): `text` is a NOTICE_IDS id from
// protocol, translated here (server never sends sentences). Some ids differ depending on location:
// on street, awaiting response to `enter` (at door), or inside a building (kicked out).
import { tr } from '../../../../shared/i18n';
import type { NoticeId } from '../../../../shared/world/protocol';

/** Where notice arrived: on street, shortly after `enter` (at door), or inside a building. */
export type NoticePlace = 'street' | 'door' | 'inside';

/**
 * Text of a `notice` (`text` is a protocol NOTICE_IDS id, translated here; unknown id becomes a generic
 * notice). null = nothing to show (ids only relevant for debugging). A new protocol id without a `case` here
 * fails compilation.
 */
export function noticeText(raw: NoticeId | (string & {}), place: NoticePlace = 'street'): string | null {
  const id = raw as NoticeId;
  switch (id) {
    case 'ignored':
    case 'invalid':
    case 'view_required':
      return null;
    case 'rate_limited':
      return tr('Slow down: the world asked for a pause between actions.');
    case 'not_found':
      if (place === 'door') return tr("This building isn't in the world right now.");
      if (place === 'inside') return tr("The building left the world: you're back on the street.");
      return tr("That person isn't nearby anymore.");
    case 'street_left':
      return tr('You stood still for a long time and left the street: walk to come back.');
    case 'chunk_full':
      return tr('The area is full: only the closest players show up.');
    case 'afk':
      return tr('You stood still for a while.');
    case 'server_restart':
      return tr('Habblaud World is restarting: the connection drops and comes back on its own.');
    case 'left':
      return tr('Your account left the world: the building comes back with "Back to the world", in Settings.');
    case 'too_far':
      return tr('Get closer to the door to go in.');
    case 'closed':
      return place === 'inside' ? tr("The building closed to visitors: you're back on the street.") : tr('This building is closed to visitors.');
    case 'blocked':
      return place === 'inside' ? tr("You can't stay in this building anymore: you're back on the street.") : tr("You can't enter this building.");
    case 'full':
      return tr('The building is full (20 visitors). Try again in a bit.');
    // Phase 5 (lightweight social). Confirmations (reported, blocked_ok, stamped) were almost always shown immediately
    // by social (city/social.ts and visit-social.ts suppress them here); if arriving late, they become this notice.
    case 'daily_limit':
      return tr('Daily limit reached: more tomorrow.');
    case 'already_done':
      return tr('You already did that today.');
    case 'reported':
      return tr('Report sent. Thanks: the moderators will take a look.');
    case 'blocked_ok':
      return tr('Blocked: you no longer see each other.');
    case 'stamped':
      return tr('Stamp left at the front desk.');
    default:
      void (id satisfies never);
      return tr('Notice from Habblaud World.');
  }
}
