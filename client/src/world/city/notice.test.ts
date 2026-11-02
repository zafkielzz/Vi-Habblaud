// World notices in scene: each id in NOTICE_IDS has its text (or null if debug-only), and an
// unknown id falls back to generic. Door notices (Phase 4) indicate context: at door or booted outside.
import { describe, expect, it } from 'vitest';
import { NOTICE_IDS } from '../../../../shared/world/protocol';
import { noticeText } from './notice';

describe('noticeText', () => {
  it('each protocol id has custom text or none; unknown id gets generic', () => {
    const generic = noticeText('id_novo');
    expect(generic).toBeTruthy();
    const texts = NOTICE_IDS.map((id) => noticeText(id));
    // No text: `ignored`, `invalid`, and `view_required` (debug only).
    expect(texts.filter((t) => t === null)).toHaveLength(3);
    const shown = texts.filter((t): t is string => t !== null);
    expect(new Set([...shown, generic]).size).toBe(shown.length + 1);
  });

  it('door notices (Phase 4): not_found mentions building at door and inside; closed and blocked indicate return to street', () => {
    expect(noticeText('not_found')).not.toBe(noticeText('not_found', 'door'));
    expect(noticeText('not_found', 'door')).not.toBe(noticeText('not_found', 'inside'));
    for (const id of ['too_far', 'closed', 'blocked', 'full'] as const) expect(noticeText(id, 'door'), id).toBeTruthy();
    expect(noticeText('closed', 'inside')).not.toBe(noticeText('closed', 'door'));
    expect(noticeText('blocked', 'inside')).not.toBe(noticeText('blocked', 'door'));
  });
});
