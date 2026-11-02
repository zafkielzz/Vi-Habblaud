import { describe, expect, it } from 'vitest';
import { DemoSimulator } from '../../../shared/demo/simulator';
import {
  compactSnapshot,
  diffFrames,
  keyframeOf,
  type TimelineAgent,
  type TimelineFrame,
  type TimelineKeyframe,
  type TimelineRecord,
} from '../../../shared/timeline';
import { TimelineReplay } from './timeline';

const T0 = new Date(2026, 9, 7, 9, 0).getTime();
const MIN = 60_000;

function ag(id: string, extra: Partial<TimelineAgent> = {}): TimelineAgent {
  return { id, kind: 'main', roomId: '/p/loja', name: id, look: 'f', role: 'Main agent', account: '.claude', status: 'working', statusSince: T0, startedAt: T0, seed: 1, ...extra };
}

const key = (at: number, agents: TimelineAgent[], extra: Partial<TimelineKeyframe> = {}): TimelineKeyframe => ({
  t: 'k',
  at,
  v: 1,
  every: 5 * MIN,
  rooms: [{ id: '/p/loja', name: 'loja', path: '/p/loja', slot: 0, seed: 1, createdAt: T0 }],
  agents,
  accounts: [],
  ...extra,
});

const act = (text: string, at: number) => ({ kind: 'read' as const, icon: '📖', text, at });

/** A short day: Ana works, reads two files, waits on you, completes; server stops and resumes. */
function day(): TimelineRecord[] {
  return [
    key(T0, [ag('ana', { activity: act('Reading a.ts', T0) })], { boot: true }),
    { t: 'd', at: T0 + 1 * MIN, agents: [['ana', { activity: act('Reading b.ts', T0 + MIN) }]] },
    { t: 'd', at: T0 + 2 * MIN, agents: [['bia', ag('bia', { kind: 'sub', parentId: 'ana', statusSince: T0 + 2 * MIN })]] },
    { t: 'd', at: T0 + 3 * MIN, agents: [['ana', { status: 'waiting', waitingFor: 'reply', statusSince: T0 + 3 * MIN }], ['bia', null]] },
    { t: 'd', at: T0 + 4 * MIN, agents: [['ana', { status: 'idle', waitingFor: null, statusSince: T0 + 4 * MIN, activity: { kind: 'done', icon: '✅', text: 'Done', at: T0 + 4 * MIN } }]] },
    key(T0 + 5 * MIN, [ag('ana', { status: 'idle', statusSince: T0 + 4 * MIN, activity: { kind: 'done', icon: '✅', text: 'Done', at: T0 + 4 * MIN } })]),
    { t: 'end', at: T0 + 6 * MIN },
    key(T0 + 30 * MIN, [ag('caio', { statusSince: T0 + 30 * MIN })], { boot: true }),
  ];
}

const view = { includeDemo: true };
const at = (r: TimelineReplay, t: number) => {
  r.moveTo(t);
  return r.snapshot(t, view);
};

describe('timelapse reconstruction', () => {
  it('state at time t, forward and backward', () => {
    const r = new TimelineReplay('2026-10-07', day());
    expect(r.from).toBe(T0);
    expect(r.to).toBe(T0 + 30 * MIN);
    expect(at(r, T0 - 1).agents).toEqual([]);
    expect(at(r, T0 + 30_000).agents.map((a) => `${a.id}:${a.status}:${a.activity?.text}`)).toEqual(['ana:working:Reading a.ts']);
    expect(at(r, T0 + 2.5 * MIN).agents.map((a) => a.id)).toEqual(['ana', 'bia']);
    const s3 = at(r, T0 + 3.2 * MIN);
    expect(s3.agents.map((a) => a.id)).toEqual(['ana']);
    expect(s3.agents[0]).toMatchObject({ status: 'waiting', waitingFor: 'reply' });
    const s4 = at(r, T0 + 4.5 * MIN);
    expect(s4.agents[0]).toMatchObject({ status: 'idle' });
    expect(s4.agents[0].waitingFor).toBeUndefined();
    // Activities seen since keyframe become recent (world uses it to react to shell completions).
    expect(s4.agents[0].recent.map((a) => a.text)).toEqual(['Reading a.ts', 'Reading b.ts', 'Done']);
    // Backward: nothing "from the future".
    const back = at(r, T0 + 1.5 * MIN);
    expect(back.agents[0]).toMatchObject({ status: 'working', activity: { text: 'Reading b.ts' } });
    expect(back.agents[0].recent.map((a) => a.text)).toEqual(['Reading a.ts', 'Reading b.ts']);
    // Server-like snapshot: replay timestamp, no terminal, increasing rev.
    expect(back.serverTime).toBe(T0 + 1.5 * MIN);
    expect(back.meta.terminal).toBe(false);
    expect(at(r, T0 + 1.6 * MIN).rev).toBeGreaterThan(back.rev);
  });

  it('no data after marked end and during long silence; resumes on next keyframe', () => {
    const r = new TimelineReplay('2026-10-07', day());
    expect(at(r, T0 + 5.5 * MIN).agents).toHaveLength(1);
    r.moveTo(T0 + 6.5 * MIN);
    expect(r.isOff(T0 + 6.5 * MIN)).toBe(true);
    expect(r.snapshot(T0 + 6.5 * MIN, view).agents).toEqual([]);
    expect(at(r, T0 + 30 * MIN).agents.map((a) => a.id)).toEqual(['caio']);

    // Server stopped without marked end: after ~1.5 keyframes of silence, "no data".
    const noEnd = day().filter((x) => x.t !== 'end');
    const r2 = new TimelineReplay('2026-10-07', noEnd);
    r2.moveTo(T0 + 12 * MIN);
    expect(r2.isOff(T0 + 12 * MIN)).toBe(false);
    r2.moveTo(T0 + 14 * MIN);
    expect(r2.isOff(T0 + 14 * MIN)).toBe(true);
  });

  it('filters demo mode agents', () => {
    const recs: TimelineRecord[] = [
      key(T0, [ag('ana'), ag('demo:x', { demo: true, roomId: 'demo:/p/app' })], {
        rooms: [
          { id: '/p/loja', name: 'loja', path: '/p/loja', slot: 0, seed: 1, createdAt: T0 },
          { id: 'demo:/p/app', name: 'app', path: '/p/app', slot: 1, seed: 2, createdAt: T0, demo: true },
        ],
        accounts: [
          { id: '.claude', short: 'C', name: 'Account C', color: '#fff', sessions: 1, usageStatus: 'ok' },
          { id: 'demo:.claude', short: 'X', name: 'Demo X', color: '#fff', sessions: 1, usageStatus: 'ok', demo: true },
        ],
      }),
    ];
    const r = new TimelineReplay('2026-10-07', recs);
    expect([r.hasReal, r.hasDemo]).toEqual([true, true]);
    r.moveTo(T0);
    const all = r.snapshot(T0, { includeDemo: true });
    expect(all.agents).toHaveLength(2);
    expect(all.meta.demo).toBe(true);
    const real = r.snapshot(T0, { includeDemo: false });
    expect(real.agents.map((a) => a.id)).toEqual(['ana']);
    expect(real.rooms.map((x) => x.id)).toEqual(['/p/loja']);
    expect(real.accounts.map((x) => x.id)).toEqual(['.claude']);
    expect(real.meta.demo).toBe(false);
  });

  it('per-minute chart and peak moments', () => {
    const r = new TimelineReplay('2026-10-07', day());
    const b = r.buckets(view);
    expect(b[0]).toMatchObject({ at: T0, present: 1, working: 1 });
    expect(b[2]).toMatchObject({ present: 2, working: 2 });
    expect(b[3]).toMatchObject({ waiting: 1 });
    expect(b[10]).toMatchObject({ present: 0 }); // server stopped
    expect(b[30]).toMatchObject({ present: 1, working: 1 });
    expect(r.peaks(view)).toEqual([
      { at: T0 + 2 * MIN, working: 2, present: 2 },
      { at: T0 + 30 * MIN, working: 1, present: 1 },
    ]);
  });

  it('matches simulator: reconstructed snapshot matches recorded one (in any query order)', () => {
    // Records in memory like server (keyframe every 5 min, delta every ~1 s on changes).
    const sim = new DemoSimulator({ seed: 3, speed: 2, sessions: 4 }, T0);
    const recs: TimelineRecord[] = [];
    const truth: { at: number; frame: TimelineFrame }[] = [];
    let written: TimelineFrame | null = null;
    let lastKey = -Infinity;
    for (let now = T0; now <= T0 + 40 * MIN; now += 1_000) {
      sim.tick(now);
      const frame = compactSnapshot(sim.snapshot(now));
      if (now - lastKey >= 5 * MIN || !written) {
        recs.push(keyframeOf(frame, now, 5 * MIN));
        lastKey = now;
      } else {
        const d = diffFrames(written, frame);
        if (!d) continue;
        recs.push(JSON.parse(JSON.stringify({ t: 'd', at: now, ...d })));
      }
      written = frame;
      truth.push({ at: now, frame });
    }
    const r = new TimelineReplay('2026-10-07', recs);
    const sequential = new TimelineReplay('2026-10-07', recs);
    const rng = (() => {
      let s = 7;
      return () => ((s = (s * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
    })();
    const ids = (f: TimelineFrame) => [...f.agents.values()].map((a) => `${a.id}|${a.status}|${a.activity?.text ?? ''}|${a.shells?.length ?? 0}`).sort();
    for (let i = 0; i < 80; i++) {
      const t = T0 + Math.floor(rng() * 40 * MIN);
      r.moveTo(t);
      const got = r.snapshot(t, view).agents.map((a) => `${a.id}|${a.status}|${a.activity?.text ?? ''}|${a.shells?.length ?? 0}`).sort();
      const exp = truth.filter((x) => x.at <= t).at(-1)!;
      expect(got, `t=${t - T0}`).toEqual(ids(exp.frame));
    }
    for (let t = T0; t <= T0 + 40 * MIN; t += 7_000) {
      sequential.moveTo(t);
      const got = sequential.snapshot(t, view).agents.map((a) => `${a.id}|${a.status}|${a.activity?.text ?? ''}|${a.shells?.length ?? 0}`).sort();
      expect(got).toEqual(ids(truth.filter((x) => x.at <= t).at(-1)!.frame));
    }
  });
});
