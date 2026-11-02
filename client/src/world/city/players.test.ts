// Players: interpolation of remote players (lag matching sample cadence: 5/s and 2.5/s jitter-free), local movement
// with collision via isWalkable, speed never exceeding run speed (even diagonally), click pathing, and move rate limiting to 10/s.
import { describe, expect, it } from 'vitest';
import { isWalkable, lotOrigin, spawnPoint } from '../../../../shared/world/city';
import { mulberry32 } from '../../../../shared/hash';
import {
  DIR_TO_PROTO,
  INTERP_MAX_MS,
  INTERP_MIN_MS,
  LocalPlayer,
  MOVE_INTERVAL_MS,
  MoveSender,
  PROTO_TO_DIR,
  RUN_TPS,
  WALK_TPS,
  dirOf,
  interpDelay,
  pathPoints,
  pushSample,
  sampleAt,
  stepDelay,
  stepMove,
  wirePos,
  type Sample,
} from './players';

const s = (t: number, x: number, y: number, moving = true): Sample => ({ t, x, y, dir: 'e', moving });

describe('remote player interpolation', () => {
  it('interpolates between two samples bounding the timestamp', () => {
    const list = [s(0, 0, 0), s(200, 2, 0), s(400, 4, 1)];
    expect(sampleAt(list, 100)).toMatchObject({ x: 1, y: 0, moving: true });
    expect(sampleAt(list, 300)).toMatchObject({ x: 3, y: 0.5 });
    expect(sampleAt(list, 300)!.speed).toBeCloseTo((Math.hypot(2, 1) * 1000) / 200);
  });

  it('before first returns first; after last returns last (and stops when sample becomes stale)', () => {
    const list = [s(100, 1, 1), s(300, 2, 1)];
    expect(sampleAt(list, 0)).toMatchObject({ x: 1, y: 1 });
    expect(sampleAt(list, 350)).toMatchObject({ x: 2, y: 1, moving: true });
    expect(sampleAt(list, 900)).toMatchObject({ x: 2, y: 1, moving: false });
    expect(sampleAt([], 0)).toBeNull();
  });

  it('samples remain sorted by time and capped in count', () => {
    const list: Sample[] = [];
    for (let i = 0; i < 30; i++) pushSample(list, s(i * 10, i, 0));
    expect(list.length).toBe(10);
    pushSample(list, s(5, 99, 0));
    expect(list[list.length - 1]!.t).toBe(290);
  });
});

/**
 * Player walking straight at 3 tiles/s, with samples emitted by server every `cadence(t)` ms and arriving with 50 ms
 * network latency ± `jitter` (deterministic RNG); scene renders at 60 fps like scene.ts (per-player delay smoothly
 * catching up to target). Returns rendered x coordinate for each frame after `warmupMs`.
 */
function walkAndDraw(cadence: (t: number) => number, jitter: number, ms: number, warmupMs = 1500, fixedDelay?: number): Array<{ t: number; x: number; moving: boolean }> {
  const rng = mulberry32(7);
  const samples: Sample[] = [];
  let sentAt = 0;
  let arrives = 50;
  let delay: number | undefined;
  const out: Array<{ t: number; x: number; moving: boolean }> = [];
  const frame = 1000 / 60;
  for (let now = 0; now <= ms; now += frame) {
    while (arrives <= now) {
      pushSample(samples, { t: arrives, x: (sentAt / 1000) * 3, y: 0, dir: 'e', moving: true });
      sentAt += cadence(sentAt);
      arrives = sentAt + 50 + (rng() * 2 - 1) * jitter;
    }
    const target = interpDelay(samples);
    delay = fixedDelay ?? (delay === undefined ? target : stepDelay(delay, target, frame));
    const p = sampleAt(samples, now - delay)!;
    if (now >= warmupMs) out.push({ t: now, x: p.x, moving: p.moving });
  }
  return out;
}

/** Frames where rendering stalled (or moved backwards) while walking. */
const frozen = (xs: Array<{ x: number }>) => xs.filter((p, i) => i > 0 && p.x <= xs[i - 1]!.x).length;

describe('interpolation with server cadence (5/s for nearest 20, 2.5/s for others)', () => {
  it('delay follows largest recent interval with margin, bounded by min and max; stopped does not count', () => {
    const at = (gaps: number[]) => {
      const list: Sample[] = [];
      let t = 0;
      pushSample(list, s(t, 0, 0));
      for (const g of gaps) pushSample(list, s((t += g), 0, 0));
      return interpDelay(list);
    };
    expect(at([])).toBe(INTERP_MIN_MS);
    expect(at([200, 200, 200])).toBe(260);
    expect(at([400, 400])).toBe(460);
    expect(at([200, 430, 200])).toBe(490);
    // 5 s stationary (server sends nothing) and returning to 5/s: pause is not treated as cadence
    expect(at([200, 5_000, 200])).toBe(260);
    expect(at([900, 900])).toBe(INTERP_MAX_MS);
    // delay adjusts smoothly: increasing at half speed; decreasing at one fourth
    expect(stepDelay(260, 460, 100)).toBe(310);
    expect(stepDelay(460, 260, 100)).toBe(435);
    expect(stepDelay(300, 310, 100)).toBe(310);
  });

  it('at 5/s and 2.5/s with ±30 ms network jitter, walking player never stops or moves backwards', () => {
    for (const cadence of [200, 400]) {
      const xs = walkAndDraw(() => cadence, 30, 12_000);
      expect(frozen(xs), `${cadence} ms`).toBe(0);
      expect(xs.every((p) => p.moving), `${cadence} ms`).toBe(true);
    }
  });

  it('with previous fixed 150 ms delay at 2.5/s, rendering stuttered on every sample', () => {
    expect(frozen(walkAndDraw(() => 400, 30, 12_000, 1500, 150))).toBeGreaterThan(50);
    expect(frozen(walkAndDraw(() => 200, 30, 12_000, 1500, 150))).toBeGreaterThan(20);
  });

  it('crossing 20-nearest boundary (5/s → 2.5/s) and back: never moves backwards, and smoothly adapts', () => {
    const cadence = (t: number) => (t >= 4_000 && t < 9_000 ? 400 : 200);
    const xs = walkAndDraw(cadence, 30, 14_000);
    expect(xs.every((p, i) => i === 0 || p.x >= xs[i - 1]!.x)).toBe(true);
    expect(frozen(xs.filter((p) => p.t >= 5_500 && p.t < 9_000))).toBe(0);
    expect(frozen(xs.filter((p) => p.t >= 10_500))).toBe(0);
  });
});

describe('local movement', () => {
  it('does not enter a lot and slides along boundary', () => {
    const o = lotOrigin({ x: 3, y: 0 });
    // on north sidewalk right above lot, moving down and right: only x changes
    const r = stepMove(o.x + 3.5, o.y - 0.2, 0.5, 0.5);
    expect(r.blocked).toBe(true);
    expect(r.x).toBeCloseTo(o.x + 4);
    expect(r.y).toBeLessThan(o.y);
    expect(isWalkable(r.x, r.y, () => true)).toBe(true);
  });

  it('large steps do not penetrate lot', () => {
    const o = lotOrigin({ x: 3, y: 0 });
    const r = stepMove(o.x + 3.5, o.y - 0.5, 0, 30);
    expect(r.y).toBeLessThan(o.y);
  });

  it('walking and running diagonally never exceeds run speed (server allows up to 7.2 tiles/s)', () => {
    const p = new LocalPlayer(spawnPoint().x + 0.5, spawnPoint().y + 0.5);
    const x0 = p.x;
    const y0 = p.y;
    for (let i = 0; i < 10; i++) p.update(0.05, { dx: 1, dy: 1, run: true });
    const d = Math.hypot(p.x - x0, p.y - y0);
    expect(d).toBeLessThanOrEqual(RUN_TPS * 0.5 + 1e-6);
    expect(d).toBeGreaterThan(RUN_TPS * 0.5 * 0.9);
    expect(p.running).toBe(true);
    const q = new LocalPlayer(spawnPoint().x + 0.5, spawnPoint().y + 0.5);
    q.update(1, { dx: -1, dy: 0, run: false });
    // dt is clamped to 0.1 s per frame
    expect(spawnPoint().x + 0.5 - q.x).toBeCloseTo(WALK_TPS * 0.1);
    expect(q.dir).toBe('left');
  });

  it('follows click path to destination and stops; a keypress cancels path', () => {
    const p = new LocalPlayer(21.5, 15.5);
    p.follow([22.5, 15.5, 23.5, 15.5, 23.5, 16.5], false);
    for (let i = 0; i < 30 && p.hasPath; i++) p.update(0.1, { dx: 0, dy: 0, run: false });
    expect(p.x).toBeCloseTo(23.5);
    expect(p.y).toBeCloseTo(16.5);
    expect(p.moving).toBe(false);
    p.follow([30.5, 16.5], false);
    p.update(0.05, { dx: 0, dy: -1, run: false });
    expect(p.hasPath).toBe(false);
  });

  it('server correction (`pos`) applies immediately', () => {
    const p = new LocalPlayer(21.5, 15.5);
    p.follow([30.5, 15.5], true);
    p.correct(10, 10);
    expect([p.x, p.y, p.hasPath]).toEqual([10, 10, false]);
  });

  it('pathPoints: tile centers ending with exact click coordinate', () => {
    expect(pathPoints([1, 0, 1, 1], 10, 20, { x: 11.2, y: 21.8 })).toEqual([11.5, 20.5, 11.2, 21.8]);
    expect(pathPoints([], 0, 0, { x: 1.2, y: 1.3 })).toEqual([1.2, 1.3]);
  });
});

describe('sending move messages', () => {
  it('stopping flush against north or west boundary of lot does not emit position inside it', () => {
    const o = lotOrigin({ x: 3, y: 0 });
    for (const p of [
      { x: o.x - 0.004, y: o.y + 3 },
      { x: o.x + 3, y: o.y - 0.004 },
    ]) {
      expect(isWalkable(p.x, p.y, () => true)).toBe(true);
      const sent: { x: number; y: number }[] = [];
      new MoveSender((msg) => sent.push(msg)).tick(0, { ...p, dir: 'down', moving: false });
      expect(isWalkable(sent[0]!.x, sent[0]!.y, () => true)).toBe(true);
    }
  });

  it('at most one every 100 ms, only on change, and stop message is always sent', () => {
    const sent: { x: number; moving: boolean; dir: string }[] = [];
    const m = new MoveSender((msg) => sent.push(msg));
    expect(m.tick(0, { x: 1, y: 1, dir: 'right', moving: true })).toBe(true);
    expect(m.tick(50, { x: 1.2, y: 1, dir: 'right', moving: true })).toBe(false);
    expect(m.tick(MOVE_INTERVAL_MS, { x: 1.3, y: 1, dir: 'right', moving: true })).toBe(true);
    expect(m.tick(MOVE_INTERVAL_MS * 2, { x: 1.3, y: 1, dir: 'right', moving: true })).toBe(false);
    expect(m.tick(MOVE_INTERVAL_MS * 3, { x: 1.3, y: 1, dir: 'right', moving: false })).toBe(true);
    expect(sent.map((x) => x.moving)).toEqual([true, true, false]);
    expect(sent[0]!.dir).toBe('e');
    // in 1 s of continuous walking, at most 10
    const many: unknown[] = [];
    const m2 = new MoveSender((msg) => many.push(msg));
    for (let t = 0; t < 1000; t += 16) m2.tick(t, { x: t / 100, y: 0, dir: 'down', moving: true });
    expect(many.length).toBeLessThanOrEqual(10);
  });

  it('position in hundredths of a tile (truncated: never shifts tile) and protocol directions', () => {
    const sent: { x: number; y: number }[] = [];
    new MoveSender((msg) => sent.push(msg)).tick(0, { x: 1.23456, y: -7.891, dir: 'up', moving: false });
    expect(sent[0]).toMatchObject({ x: 1.23, y: -7.9 });
    for (const v of [50.996, -0.004, 11.9999, 12, -3.001, 0.29, 57.3]) expect(Math.floor(wirePos(v))).toBe(Math.floor(v));
    for (const d of ['up', 'down', 'left', 'right'] as const) expect(PROTO_TO_DIR[DIR_TO_PROTO[d]]).toBe(d);
    expect(dirOf(0, 0, 'left')).toBe('left');
    expect(dirOf(-1, 0.5, 'down')).toBe('left');
    expect(dirOf(0.2, 1, 'down')).toBe('down');
  });
});

describe('MoveSender after background tab keepAlive (two clocks bug)', () => {
  it('keepAlive does not silence ticks: walking afterwards still sends move', () => {
    // Scene loop used performance.now() (ms since page load); hidden tab keepAlive ran with
    // Date.now() (index.ts) and stored that timestamp, so subsequent ticks saw negative `now - lastAt` and stopped
    // sending: server saw frozen position while character walked on screen (enter/like → too_far until a `pos`
    // called `reset`). Now keepAlive neither receives nor stores timestamps.
    const sent: { x: number; moving: boolean }[] = [];
    const m = new MoveSender((msg) => sent.push(msg));
    const perf = 120_000; // ~2 min page open
    expect(m.tick(perf, { x: 10, y: 10, dir: 'right', moving: false })).toBe(true);
    m.keepAlive({ x: 10, y: 10, dir: 'right' }); // background tab for 30 s
    // tab restored and player walks for 20 s
    let moved = 0;
    for (let t = perf + 30_000; t < perf + 50_000; t += 16) if (m.tick(t, { x: 10 + (t - perf) / 1000, y: 10, dir: 'right', moving: true })) moved++;
    expect(moved).toBeGreaterThan(0);
    expect(sent.at(-1)!.moving).toBe(true);
  });

  it('keepAlive followed by stopped tick at same position does not re-send (no duplicates)', () => {
    const sent: unknown[] = [];
    const m = new MoveSender((msg) => sent.push(msg));
    const perf = 120_000;
    expect(m.tick(perf, { x: 10, y: 10, dir: 'right', moving: false })).toBe(true);
    m.keepAlive({ x: 10, y: 10, dir: 'right' });
    expect(sent).toHaveLength(2);
    // tab restored with player stationary at original position: nothing new to send regardless of elapsed time
    expect(m.tick(perf + 30_000, { x: 10, y: 10, dir: 'right', moving: false })).toBe(false);
    expect(m.tick(perf + 60_000, { x: 10, y: 10, dir: 'right', moving: false })).toBe(false);
    expect(sent).toHaveLength(2);
  });
});
