import { describe, expect, it, vi } from 'vitest';
import type { AgentInfo, OfficeSnapshot } from '../../../shared/types';
import { OfficeStore } from '../net/store';
import { createWorld } from './index';
import { animScale, rebaseSnapshot } from './playback';

describe('timelapse in world', () => {
  it('animation factor: ~square root of speed, between 1 and 16 (0 = paused)', () => {
    expect(animScale(60)).toBe(6);
    expect(animScale(180)).toBe(10);
    expect(animScale(600)).toBe(16);
    expect(animScale(1)).toBe(1);
    expect(animScale(5000)).toBe(16);
    expect(animScale(0)).toBe(0);
    expect(animScale(Number.NaN)).toBe(0);
  });

  it('shifts to world clock only what is compared against "now"', () => {
    const agent = {
      id: 'a',
      statusSince: 1_000,
      startedAt: 500,
      activity: { id: 'x', kind: 'read', icon: '📖', text: 't', at: 900 },
      recent: [],
      shells: [{ id: 'j', label: 'Build', startedAt: 800, background: true, kind: 'shell' }],
    } as unknown as AgentInfo;
    const snap = { rev: 1, serverTime: 2_000, rooms: [], agents: [agent], accounts: [], meta: { demo: false, sources: [], startedAt: 0, version: 't' } } as OfficeSnapshot;
    const out = rebaseSnapshot(snap, 10_000);
    expect(out.serverTime).toBe(12_000);
    expect(out.agents[0].statusSince).toBe(11_000);
    expect(out.agents[0].shells![0].startedAt).toBe(10_800);
    // Activities and original snapshot remain untouched.
    expect(out.agents[0].activity!.at).toBe(900);
    expect(out.agents[0].startedAt).toBe(500);
    expect(agent.statusSince).toBe(1_000);
    expect(agent.shells![0].startedAt).toBe(800);
    expect(rebaseSnapshot(snap, 0)).toBe(snap);
  });
});

describe('world teardown', () => {
  it('destroy() removes font listener on repeated mount and unmount', () => {
    const fonts = new EventTarget();
    const added = vi.spyOn(fonts, 'addEventListener');
    const removed = vi.spyOn(fonts, 'removeEventListener');
    vi.stubGlobal('document', Object.assign(new EventTarget(), { fonts }));
    vi.stubGlobal('window', new EventTarget());
    vi.stubGlobal('requestAnimationFrame', vi.fn(() => 1));
    vi.stubGlobal('cancelAnimationFrame', vi.fn());
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 404 })));
    const canvas = Object.assign(new EventTarget(), {
      clientWidth: 800,
      clientHeight: 600,
      width: 800,
      height: 600,
      style: {},
      getContext: () => ({}),
    }) as unknown as HTMLCanvasElement;
    const store = new OfficeStore();
    const worlds: ReturnType<typeof createWorld>[] = [];
    try {
      for (let i = 0; i < 3; i++) {
        const world = createWorld(canvas, store);
        worlds.push(world);
        expect(added).toHaveBeenCalledTimes(i + 1);
        world.destroy();
        expect(removed.mock.calls.map(([type, cb]) => [type, cb])).toEqual(added.mock.calls.map(([type, cb]) => [type, cb]));
      }
    } finally {
      worlds.forEach((world) => world.destroy());
      store.disconnect();
      vi.unstubAllGlobals();
    }
  });
});
