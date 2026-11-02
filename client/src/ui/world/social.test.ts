// Lightweight office social (Phase 5): "While you were away" (counts, stamps, sentence), new knocks
// without re-notifying past events, the chip's "❤️ N today", reading status (blocked, summary, code) and
// FakeWorldApi (dismissed summary, unblocking without connection, knocks with opt-in).
import { describe, expect, it } from 'vitest';
import { FakeWorldApi, FAKE_SUMMARY, parseBuildingMeta, parseWorldStatus } from '../../net/world';
import { awaySummaryView, dayLabel, likesTodayChip, newKnocks, summaryKey } from './away-summary';
import { DEFAULT_VISIBILITY, VISIBILITY_SWITCHES } from './world-model';

describe('While you were away', () => {
  it('the three counts, stamps (most received first), and sentence', () => {
    const v = awaySummaryView({ since: '2026-10-14', visits: 1, likes: 12, stamps: [{ stampId: 'coffee', count: 1 }, { stampId: 'star', count: 3 }] });
    expect(v.stats.map((s) => [s.key, s.value, s.label])).toEqual([
      ['visits', '1', 'visit'],
      ['likes', '12', 'likes'],
      ['stamps', '4', 'stamps'],
    ]);
    expect(v.stamps.map((s) => [s.id, s.icon, s.count])).toEqual([
      ['star', '⭐', 3],
      ['coffee', '☕', 1],
    ]);
    expect(v.sentence).toBe('While you were away: 1 visit, 12 likes and 4 stamps.');
    expect(v.since).toMatch(/^since /);
  });

  it('calendar UTC day (no timezone), and invalid date yields empty string', () => {
    expect(dayLabel('2026-10-14')).toMatch(/14/);
    expect(dayLabel('ontem')).toBe('');
  });

  it('summary key: changes with any count', () => {
    expect(summaryKey(undefined)).toBe('');
    expect(summaryKey(FAKE_SUMMARY)).not.toBe(summaryKey({ ...FAKE_SUMMARY, likes: 13 }));
  });

  it('knocks: first reading only benchmarks; then fresh ones; count reset benchmarks again', () => {
    expect(newKnocks(null, 4)).toEqual({ last: 4, fresh: 0 });
    expect(newKnocks(4, 6)).toEqual({ last: 6, fresh: 2 });
    expect(newKnocks(6, undefined)).toEqual({ last: 0, fresh: 0 });
    expect(newKnocks(0, 1)).toEqual({ last: 1, fresh: 1 });
  });

  it('"❤️ N today" only when building is active with likes', () => {
    expect(likesTodayChip('live', 3)).toEqual({ text: '❤️ 3 today', title: 'Your building got 3 likes today.' });
    expect(likesTodayChip('live', 1)?.title).toBe('Your building got 1 like today.');
    expect(likesTodayChip('live', 0)).toBeNull();
    expect(likesTodayChip('paused', 5)).toBeNull();
  });
});

describe('building status and meta (Phase 5)', () => {
  it('parseWorldStatus: blocked list, summary with news, and formatted code; excludes the rest', () => {
    const st = parseWorldStatus({
      state: 'approved',
      configured: true,
      blocked: [{ id: 'p_1', name: 'Ana', x: 1 }, { id: 3 }],
      building: { connected: true, paused: false, floors: 1, agents: 1, summary: FAKE_SUMMARY, code: 'HB-4F2K', likesToday: 3, knocks: 2 },
    });
    expect(st?.blocked).toEqual([{ id: 'p_1', name: 'Ana' }]);
    expect(st?.building).toMatchObject({ summary: FAKE_SUMMARY, code: 'HB-4F2K', likesToday: 3, knocks: 2 });
    const empty = parseWorldStatus({ state: 'approved', building: { connected: true, summary: { ...FAKE_SUMMARY, visits: 0, likes: 0, stamps: [] }, code: 'xx' } });
    expect(empty?.building).not.toHaveProperty('summary');
    expect(empty?.building).not.toHaveProperty('code');
  });

  it('parseBuildingMeta: daily likes, knocks, and summary boolean flag (never the summary)', () => {
    expect(parseBuildingMeta({ connected: true, likesToday: 0, knocks: 3, awaySummary: true })).toMatchObject({ likesToday: 0, knocks: 3, awaySummary: true });
    expect(parseBuildingMeta({ connected: true, likesToday: -1, knocks: 0, awaySummary: 'sim' })).toEqual({ connected: true, paused: false, floors: 0, agents: 0 });
  });

  it('"Notify on door knock": disabled by default and in switch list', () => {
    expect(DEFAULT_VISIBILITY.knocks).toBe(false);
    expect(VISIBILITY_SWITCHES).toContain('knocks');
  });
});

describe('FakeWorldApi: demo mode social features', () => {
  it('summary until acknowledged; meta only with boolean flag; code and blocked in status', async () => {
    let t = 1_000_000;
    const api = new FakeWorldApi({ state: 'approved', delayMs: 0, now: () => t });
    expect(api.meta().building).toMatchObject({ likesToday: 3, awaySummary: true });
    expect(api.meta().building).not.toHaveProperty('summary');
    const st = await api.status();
    expect(st.ok && st.data.building).toMatchObject({ code: 'HB-4F2K', summary: FAKE_SUMMARY });
    expect(st.ok && st.data.blocked?.length).toBe(2);
    expect((await api.summarySeen()).ok).toBe(true);
    expect(api.meta().building?.awaySummary).toBeUndefined();
    t += 120_000;
    expect(api.meta().building?.likesToday).toBe(5);
  });

  it('unblock: disappears from list; paused (no connection) returns not_connected', async () => {
    const api = new FakeWorldApi({ state: 'approved', delayMs: 0 });
    expect((await api.unblock('p_spam')).ok).toBe(true);
    const st = await api.status();
    expect(st.ok && st.data.blocked?.map((p) => p.id)).toEqual(['p_troll']);
    await api.pause();
    expect(await api.unblock('p_troll')).toMatchObject({ ok: false, code: 'not_connected' });
  });

  it('knocks only with opt-in: first after 8 s, then one every 45 s', async () => {
    let t = 1_000_000;
    const api = new FakeWorldApi({ state: 'approved', delayMs: 0, now: () => t });
    t += 60_000;
    expect(api.meta().building?.knocks).toBeUndefined();
    await api.saveVisibility({ ...DEFAULT_VISIBILITY, knocks: true });
    t += 7_000;
    expect(api.meta().building?.knocks).toBeUndefined();
    t += 2_000;
    expect(api.meta().building?.knocks).toBe(1);
    t += 45_000;
    expect(api.meta().building?.knocks).toBe(2);
  });
});
